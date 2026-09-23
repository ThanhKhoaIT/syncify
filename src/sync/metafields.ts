import { SyncContext, SyncResult } from '../types.js';
import { logger, createProgressBar } from '../logger.js';
import { Notes } from '../notes.js';

interface Metafield {
  namespace: string;
  key: string;
  type: string;
  value: string;
}

interface Validation {
  name: string;
  value: string;
}

interface MetafieldDefinition {
  namespace: string;
  key: string;
  name: string;
  description: string | null;
  ownerType: string;
  type: { name: string };
  validations: Validation[];
}

// Owner types covered for metafield *definitions* — matches the resources
// syncify already touches (products/variants/collections/pages/articles/
// blogs/shop). A definition existing on Dev is what lets a theme's "Dynamic
// source" binding (e.g. `product.metafields.<namespace>.<key>.value`)
// resolve at push time — namespace+key is portable across stores, but the
// theme editor's dynamic-source validation checks the registered
// *definition*, not just whether some record happens to carry a value under
// that namespace/key.
const OWNER_TYPES = ['PRODUCT', 'PRODUCTVARIANT', 'COLLECTION', 'PAGE', 'ARTICLE', 'BLOG', 'SHOP'];

// metaobject_reference/mixed_reference definitions need a validation
// pointing at the referenced metaobject definition's Dev-side ID, which
// requires that definition to already exist on Dev — the same
// dependency-ordering problem noted in sync/metaobjects.ts, not resolved
// here either. Every other type's validations (e.g. rating's scale_min/max,
// file_reference's file_type) are plain values, portable as-is.
const UNRESOLVABLE_DEFINITION_TYPES = new Set(['metaobject_reference', 'list.metaobject_reference', 'mixed_reference', 'list.mixed_reference']);

const DEFINITIONS_QUERY = `#graphql
  query MetafieldDefinitions($ownerType: MetafieldOwnerType!, $cursor: String) {
    metafieldDefinitions(ownerType: $ownerType, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        namespace
        key
        name
        description
        ownerType
        type { name }
        validations { name value }
      }
    }
  }
`;

const DEV_DEFINITIONS_QUERY = `#graphql
  query DevMetafieldDefinitions($ownerType: MetafieldOwnerType!, $cursor: String) {
    metafieldDefinitions(ownerType: $ownerType, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { namespace key }
    }
  }
`;

// NOTE: verify MetafieldDefinitionInput's exact shape via schema
// introspection for the pinned apiVersion before the first live run. No
// update path here yet — only missing definitions are created; changes to
// an existing definition's fields on Production aren't propagated (same
// limitation already documented for metaobject definitions).
const DEFINITION_CREATE = `#graphql
  mutation MetafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id namespace key }
      userErrors { field message }
    }
  }
`;

const SHOP_METAFIELDS_QUERY = `#graphql
  query ShopMetafields($cursor: String) {
    shop {
      metafields(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { namespace key type value }
      }
    }
  }
`;

const SHOP_ID_QUERY = `#graphql
  query ShopId {
    shop { id }
  }
`;

const METAFIELDS_SET_MUTATION = `#graphql
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key }
      userErrors { field message }
    }
  }
`;

async function fetchAllDefinitions(ctx: SyncContext): Promise<MetafieldDefinition[]> {
  const definitions: MetafieldDefinition[] = [];
  for (const ownerType of OWNER_TYPES) {
    let cursor: string | null = null;
    do {
      const data: any = await ctx.prod.query(DEFINITIONS_QUERY, { ownerType, cursor });
      definitions.push(...data.metafieldDefinitions.nodes);
      cursor = data.metafieldDefinitions.pageInfo.hasNextPage ? data.metafieldDefinitions.pageInfo.endCursor : null;
    } while (cursor);
  }
  return definitions;
}

async function fetchExistingDevKeys(ctx: SyncContext): Promise<Set<string>> {
  const existing = new Set<string>();
  for (const ownerType of OWNER_TYPES) {
    let cursor: string | null = null;
    do {
      const data: any = await ctx.dev.query(DEV_DEFINITIONS_QUERY, { ownerType, cursor });
      for (const d of data.metafieldDefinitions.nodes) {
        existing.add(`${ownerType}::${d.namespace}::${d.key}`);
      }
      cursor = data.metafieldDefinitions.pageInfo.hasNextPage ? data.metafieldDefinitions.pageInfo.endCursor : null;
    } while (cursor);
  }
  return existing;
}

async function syncDefinitions(ctx: SyncContext, notes: Notes): Promise<{ planned: number; applied: number }> {
  const definitions = await fetchAllDefinitions(ctx);
  logger.step(`Found ${definitions.length} metafield definitions on ${ctx.config.prodStore}.`);

  if (!ctx.live) {
    return { planned: definitions.length, applied: 0 };
  }

  const existing = await fetchExistingDevKeys(ctx);

  let applied = 0;
  const bar = createProgressBar(definitions.length, 'metafield definitions');
  for (const def of definitions) {
    const key = `${def.ownerType}::${def.namespace}::${def.key}`;
    if (existing.has(key)) {
      applied += 1;
      bar.tick();
      continue;
    }

    if (UNRESOLVABLE_DEFINITION_TYPES.has(def.type.name)) {
      notes.push(
        `Definition "${def.ownerType}/${def.namespace}.${def.key}": skipped — type "${def.type.name}" needs a validation pointing at a Dev-side metaobject definition ID, which resolving across definitions isn't implemented.`
      );
      bar.tick();
      continue;
    }

    // metafieldDefinitionCreate can hard-fail with a top-level GraphQL
    // ACCESS_DENIED error (client.ts throws on that, not a userErrors
    // array) when the namespace is owned by a different app, or was
    // created with a restricted access level — no scope grant can fix
    // that, it's a deliberate per-namespace isolation boundary, not a
    // permission gap. Caught per-definition so one inaccessible namespace
    // doesn't abort every remaining definition and the shop metafield
    // values sync that follows.
    try {
      const result: any = await ctx.dev.mutate(DEFINITION_CREATE, {
        definition: {
          namespace: def.namespace,
          key: def.key,
          name: def.name,
          description: def.description ?? undefined,
          type: def.type.name,
          ownerType: def.ownerType,
          validations: def.validations.map((v) => ({ name: v.name, value: v.value })),
        },
      });
      if (result.metafieldDefinitionCreate.userErrors?.length) {
        notes.push(`Definition "${def.ownerType}/${def.namespace}.${def.key}": ${JSON.stringify(result.metafieldDefinitionCreate.userErrors)}`);
        bar.tick();
        continue;
      }

      applied += 1;
      existing.add(key);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notes.push(`Definition "${def.ownerType}/${def.namespace}.${def.key}": failed — ${message}`);
    }
    bar.tick();
  }
  bar.done();

  return { planned: definitions.length, applied };
}

export async function syncMetafields(ctx: SyncContext): Promise<SyncResult> {
  const notes = new Notes('metafields');
  notes.push(
    `Metafield *definitions* are synced (create-only, no update path) for owner types: ${OWNER_TYPES.join(', ')} — this is what lets a theme's "Dynamic source" binding (e.g. product.metafields.<namespace>.<key>.value) resolve on Dev without needing to be skipped. metaobject_reference/mixed_reference definitions are skipped (see metaobjects.ts for why). Metafield *values*: shop-level values sync here; product-level values sync as part of the "products" resource (see sync/products.ts). Variant-level metafield values are not yet implemented, even though PRODUCTVARIANT definitions now sync.`
  );

  const definitionResult = await syncDefinitions(ctx, notes);

  const all: Metafield[] = [];
  let cursor: string | null = null;

  do {
    const data: any = await ctx.prod.query(SHOP_METAFIELDS_QUERY, { cursor });
    all.push(...data.shop.metafields.nodes);
    cursor = data.shop.metafields.pageInfo.hasNextPage ? data.shop.metafields.pageInfo.endCursor : null;
  } while (cursor);

  logger.step(`Found ${all.length} shop metafields on ${ctx.config.prodStore}.`);

  const planned = definitionResult.planned + all.length;

  if (!ctx.live) {
    return { resource: 'metafields', planned, applied: 0, skipped: 0, noteCount: notes.length };
  }

  const devShop: any = await ctx.dev.query(SHOP_ID_QUERY);
  const ownerId = devShop.shop.id;
  const input = all.map((mf) => ({ ownerId, namespace: mf.namespace, key: mf.key, type: mf.type, value: mf.value }));

  let valuesApplied = 0;
  const bar = createProgressBar(input.length, 'metafields');
  // metafieldsSet accepts at most 25 per call.
  for (let i = 0; i < input.length; i += 25) {
    const batch = input.slice(i, i + 25);
    const result: any = await ctx.dev.mutate(METAFIELDS_SET_MUTATION, { metafields: batch });
    if (result.metafieldsSet.userErrors?.length) {
      notes.push(`Errors in batch starting at ${i}: ${JSON.stringify(result.metafieldsSet.userErrors)}`);
    }
    valuesApplied += result.metafieldsSet.metafields.length;
    bar.tick(batch.length);
  }
  bar.done();

  const applied = definitionResult.applied + valuesApplied;
  return { resource: 'metafields', planned, applied, skipped: planned - applied, noteCount: notes.length };
}
