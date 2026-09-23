import { SyncContext, SyncResult } from '../types.js';
import { logger, createProgressBar } from '../logger.js';
import { Notes } from '../notes.js';

// Field types whose value holds a GID pointing at another resource. Some of
// these (product/collection/page/variant) are resolved below by matching
// the referenced record's handle (or handle+SKU) on Dev, since those
// resources already sync before "metaobjects" runs (see RESOURCE_ORDER in
// commands/sync.ts). The rest can't be resolved yet and are dropped:
// metaobject_reference/mixed_reference would need the referencing field
// *definition* to declare a target Dev-side definition ID, which requires
// creating definitions in dependency order plus an update path for
// existing ones (not implemented — see DEFINITION_DROP_TYPES below);
// file_reference can't be matched at all since files have no stable
// cross-store handle (see sync/files.ts).
const RESOLVABLE_REFERENCE_KINDS: Record<string, 'product' | 'collection' | 'page' | 'variant'> = {
  product_reference: 'product',
  'list.product_reference': 'product',
  collection_reference: 'collection',
  'list.collection_reference': 'collection',
  page_reference: 'page',
  'list.page_reference': 'page',
  variant_reference: 'variant',
  'list.variant_reference': 'variant',
};

// Field *definitions* that stay dropped from the Dev metaobject definition
// itself — not just the entry values — because Shopify has no way to
// represent them without unresolved cross-store/cross-definition info.
const DEFINITION_DROP_TYPES = new Set([
  'metaobject_reference',
  'list.metaobject_reference',
  'mixed_reference',
  'list.mixed_reference',
  'file_reference',
  'list.file_reference',
]);

type ResolvedNode =
  | { kind: 'product'; handle: string }
  | { kind: 'collection'; handle: string }
  | { kind: 'page'; handle: string }
  | { kind: 'variant'; productHandle: string; sku: string | null };

interface FieldDefinition {
  key: string;
  name: string;
  type: { name: string };
  required: boolean;
}

interface Definition {
  type: string;
  name: string;
  fieldDefinitions: FieldDefinition[];
}

interface FieldValue {
  key: string;
  type: string;
  value: string | null;
}

interface Entry {
  handle: string;
  type: string;
  fields: FieldValue[];
}

// list.* field values are JSON-encoded arrays of GIDs; singular reference
// fields hold one GID directly.
function parseReferenceValue(type: string, value: string): string[] {
  if (!type.startsWith('list.')) return [value];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildReferenceValue(type: string, ids: string[]): string {
  return type.startsWith('list.') ? JSON.stringify(ids) : ids[0];
}

const DEFINITIONS_QUERY = `#graphql
  query MetaobjectDefinitions($cursor: String) {
    metaobjectDefinitions(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        type
        name
        fieldDefinitions {
          key
          name
          required
          type { name }
        }
      }
    }
  }
`;

const DEV_DEFINITIONS_QUERY = `#graphql
  query DevMetaobjectDefinitions($cursor: String) {
    metaobjectDefinitions(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id type }
    }
  }
`;

// NOTE: verify MetaobjectDefinitionCreateInput/UpdateInput shapes via schema
// introspection for the pinned apiVersion before the first live run.
const DEFINITION_CREATE = `#graphql
  mutation MetaobjectDefinitionCreate($definition: MetaobjectDefinitionCreateInput!) {
    metaobjectDefinitionCreate(definition: $definition) {
      metaobjectDefinition { id type }
      userErrors { field message }
    }
  }
`;

// Resolves whatever Production GIDs a reference field holds — the inline
// fragments cover every type RESOLVABLE_REFERENCE_KINDS supports; a GID for
// anything else (e.g. a file, or a metaobject) simply comes back without a
// matching fragment and is treated as unresolved.
const RESOLVE_REFERENCES_QUERY = `#graphql
  query ResolveReferences($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on Product { handle }
      ... on Collection { handle }
      ... on Page { handle }
      ... on ProductVariant { sku product { handle } }
    }
  }
`;

const DEV_PRODUCTS_WITH_VARIANTS_QUERY = `#graphql
  query DevProductsWithVariants($cursor: String) {
    products(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        variants(first: 100) { nodes { id sku } }
      }
    }
  }
`;

const DEV_COLLECTIONS_HANDLE_QUERY = `#graphql
  query DevCollectionsHandles($cursor: String) {
    collections(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id handle }
    }
  }
`;

const DEV_PAGES_HANDLE_QUERY = `#graphql
  query DevPagesHandles($cursor: String) {
    pages(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id handle }
    }
  }
`;

const ENTRIES_QUERY = `#graphql
  query MetaobjectEntries($type: String!, $cursor: String) {
    metaobjects(type: $type, first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        handle
        type
        fields { key type value }
      }
    }
  }
`;

// metaobjectUpsert matches by handle+type, so re-running sync is idempotent.
// NOTE: verify MetaobjectUpsertInput's exact shape via schema introspection
// for the pinned apiVersion before the first live run.
const ENTRY_UPSERT = `#graphql
  mutation MetaobjectUpsert($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
      metaobject { id handle }
      userErrors { field message }
    }
  }
`;

export async function syncMetaobjects(ctx: SyncContext): Promise<SyncResult> {
  const notes = new Notes('metaobjects');
  notes.push(
    'product_reference/collection_reference/page_reference/variant_reference fields are resolved to the matching Dev-side record (matched by handle, or handle+SKU for variants) instead of being dropped; a reference whose target hasn\'t synced to Dev (or no longer exists) is still dropped and logged. metaobject_reference/mixed_reference/file_reference fields are dropped from both definitions and entries — the first two would need the field definition itself to declare a target Dev-side metaobject definition, which requires creating definitions in dependency order plus an update path for existing ones (not implemented); file_reference can\'t be matched at all since files have no stable cross-store handle. A definition left with zero fields after dropping those is skipped entirely.'
  );

  const definitions: Definition[] = [];
  let cursor: string | null = null;
  do {
    const data: any = await ctx.prod.query(DEFINITIONS_QUERY, { cursor });
    definitions.push(...data.metaobjectDefinitions.nodes);
    cursor = data.metaobjectDefinitions.pageInfo.hasNextPage ? data.metaobjectDefinitions.pageInfo.endCursor : null;
  } while (cursor);

  logger.step(`Found ${definitions.length} metaobject definitions on ${ctx.config.prodStore}.`);

  const entries: Entry[] = [];
  for (const def of definitions) {
    let entryCursor: string | null = null;
    do {
      const data: any = await ctx.prod.query(ENTRIES_QUERY, { type: def.type, cursor: entryCursor });
      entries.push(...data.metaobjects.nodes);
      entryCursor = data.metaobjects.pageInfo.hasNextPage ? data.metaobjects.pageInfo.endCursor : null;
    } while (entryCursor);
  }

  logger.step(`Found ${entries.length} metaobject entries on ${ctx.config.prodStore}.`);

  const planned = definitions.length + entries.length;

  if (!ctx.live) {
    notes.push(`Dry-run: ${definitions.length} definitions and ${entries.length} entries would be upserted.`);
    return { resource: 'metaobjects', planned, applied: 0, skipped: 0, noteCount: notes.length };
  }

  // Definitions must exist on dev before entries referencing their type can
  // be created. No update path here yet — only missing definitions are
  // created; changes to an existing definition's fields are not synced.
  const existingTypes = new Set<string>();
  let devCursor: string | null = null;
  do {
    const data: any = await ctx.dev.query(DEV_DEFINITIONS_QUERY, { cursor: devCursor });
    for (const d of data.metaobjectDefinitions.nodes) existingTypes.add(d.type);
    devCursor = data.metaobjectDefinitions.pageInfo.hasNextPage ? data.metaobjectDefinitions.pageInfo.endCursor : null;
  } while (devCursor);

  let applied = 0;
  const bar = createProgressBar(planned, 'metaobjects');
  for (const def of definitions) {
    if (existingTypes.has(def.type)) {
      applied += 1;
      bar.tick();
      continue;
    }

    // metaobject_reference/mixed_reference field definitions need a
    // validation pointing at the referenced type's Dev-side definition ID,
    // which requires that type to already exist on Dev — a dependency we
    // don't resolve across definitions. file_reference has no cross-store
    // identity to match on at all. Rather than fail the whole definition
    // (and every entry under it) over one field, drop just these from the
    // definition. product/collection/page/variant reference fields are
    // kept — their values get resolved at the entry level below.
    const keptFieldDefs = def.fieldDefinitions.filter((f) => !DEFINITION_DROP_TYPES.has(f.type.name));
    const droppedFieldCount = def.fieldDefinitions.length - keptFieldDefs.length;

    if (keptFieldDefs.length === 0) {
      notes.push(`Definition "${def.type}": all ${def.fieldDefinitions.length} field(s) are unresolvable reference types — skipped entirely, nothing left to define.`);
      bar.tick();
      continue;
    }

    const result: any = await ctx.dev.mutate(DEFINITION_CREATE, {
      definition: {
        type: def.type,
        name: def.name,
        fieldDefinitions: keptFieldDefs.map((f) => ({
          key: f.key,
          name: f.name,
          required: f.required,
          type: f.type.name,
        })),
      },
    });
    if (result.metaobjectDefinitionCreate.userErrors?.length) {
      notes.push(`Definition "${def.type}": ${JSON.stringify(result.metaobjectDefinitionCreate.userErrors)}`);
      bar.tick();
      continue;
    }

    applied += 1;
    existingTypes.add(def.type);
    if (droppedFieldCount > 0) {
      notes.push(`Definition "${def.type}": dropped ${droppedFieldCount} metaobject_reference/mixed_reference/file_reference field(s) — not implemented.`);
    }
    bar.tick();
  }

  // Gather every GID referenced by a resolvable field across all entries,
  // then resolve them against Production in bulk (nodes() accepts up to 250
  // ids/call) rather than one query per field.
  const referenceGids = new Set<string>();
  for (const entry of entries) {
    for (const field of entry.fields) {
      const kind = RESOLVABLE_REFERENCE_KINDS[field.type];
      if (!kind || field.value === null) continue;
      for (const gid of parseReferenceValue(field.type, field.value)) referenceGids.add(gid);
    }
  }

  const prodNodeInfo = new Map<string, ResolvedNode>();
  const gidList = [...referenceGids];
  for (let i = 0; i < gidList.length; i += 250) {
    const chunk = gidList.slice(i, i + 250);
    const data: any = await ctx.prod.query(RESOLVE_REFERENCES_QUERY, { ids: chunk });
    chunk.forEach((gid, idx) => {
      const node = data.nodes[idx];
      if (!node) return;
      switch (node.__typename) {
        case 'Product':
          prodNodeInfo.set(gid, { kind: 'product', handle: node.handle });
          break;
        case 'Collection':
          prodNodeInfo.set(gid, { kind: 'collection', handle: node.handle });
          break;
        case 'Page':
          prodNodeInfo.set(gid, { kind: 'page', handle: node.handle });
          break;
        case 'ProductVariant':
          prodNodeInfo.set(gid, { kind: 'variant', productHandle: node.product.handle, sku: node.sku });
          break;
        default:
          break; // unsupported target type (e.g. a file) — left unresolved
      }
    });
  }

  const neededKinds = new Set([...prodNodeInfo.values()].map((n) => n.kind));

  const devProductByHandle = new Map<string, string>();
  const devVariantByHandleSku = new Map<string, string>();
  if (neededKinds.has('product') || neededKinds.has('variant')) {
    let productCursor: string | null = null;
    do {
      const data: any = await ctx.dev.query(DEV_PRODUCTS_WITH_VARIANTS_QUERY, { cursor: productCursor });
      for (const p of data.products.nodes) {
        const handle = p.handle.normalize('NFC');
        devProductByHandle.set(handle, p.id);
        for (const v of p.variants.nodes) {
          if (v.sku) devVariantByHandleSku.set(`${handle}::${v.sku}`, v.id);
        }
      }
      productCursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
    } while (productCursor);
  }

  const devCollectionByHandle = new Map<string, string>();
  if (neededKinds.has('collection')) {
    let collectionCursor: string | null = null;
    do {
      const data: any = await ctx.dev.query(DEV_COLLECTIONS_HANDLE_QUERY, { cursor: collectionCursor });
      for (const c of data.collections.nodes) devCollectionByHandle.set(c.handle.normalize('NFC'), c.id);
      collectionCursor = data.collections.pageInfo.hasNextPage ? data.collections.pageInfo.endCursor : null;
    } while (collectionCursor);
  }

  const devPageByHandle = new Map<string, string>();
  if (neededKinds.has('page')) {
    let pageCursor: string | null = null;
    do {
      const data: any = await ctx.dev.query(DEV_PAGES_HANDLE_QUERY, { cursor: pageCursor });
      for (const p of data.pages.nodes) devPageByHandle.set(p.handle.normalize('NFC'), p.id);
      pageCursor = data.pages.pageInfo.hasNextPage ? data.pages.pageInfo.endCursor : null;
    } while (pageCursor);
  }

  function resolveDevId(gid: string): string | null {
    const node = prodNodeInfo.get(gid);
    if (!node) return null;
    switch (node.kind) {
      case 'product':
        return devProductByHandle.get(node.handle.normalize('NFC')) ?? null;
      case 'collection':
        return devCollectionByHandle.get(node.handle.normalize('NFC')) ?? null;
      case 'page':
        return devPageByHandle.get(node.handle.normalize('NFC')) ?? null;
      case 'variant':
        return node.sku ? devVariantByHandleSku.get(`${node.productHandle.normalize('NFC')}::${node.sku}`) ?? null : null;
    }
  }

  for (const entry of entries) {
    const fields: { key: string; value: string }[] = [];
    let emptyCount = 0;
    let unsupportedCount = 0;
    let unresolvedCount = 0;

    for (const field of entry.fields) {
      const kind = RESOLVABLE_REFERENCE_KINDS[field.type];
      if (field.value === null) {
        emptyCount += 1;
      } else if (DEFINITION_DROP_TYPES.has(field.type)) {
        unsupportedCount += 1;
      } else if (kind) {
        const gids = parseReferenceValue(field.type, field.value);
        const resolvedIds = gids.map(resolveDevId).filter((id): id is string => id !== null);
        unresolvedCount += gids.length - resolvedIds.length;
        if (resolvedIds.length > 0) {
          fields.push({ key: field.key, value: buildReferenceValue(field.type, resolvedIds) });
        }
      } else {
        fields.push({ key: field.key, value: field.value });
      }
    }

    const droppedParts: string[] = [];
    if (unsupportedCount > 0) droppedParts.push(`${unsupportedCount} unsupported reference field(s)`);
    if (unresolvedCount > 0) droppedParts.push(`${unresolvedCount} unresolved reference(s) (target not found on Dev)`);
    if (emptyCount > 0) droppedParts.push(`${emptyCount} empty field(s)`);
    if (droppedParts.length > 0) {
      notes.push(`Entry "${entry.type}/${entry.handle}": skipped ${droppedParts.join(', ')}.`);
    }

    const result: any = await ctx.dev.mutate(ENTRY_UPSERT, {
      handle: { type: entry.type, handle: entry.handle },
      metaobject: { fields },
    });
    if (result.metaobjectUpsert.userErrors?.length) {
      notes.push(`Entry "${entry.type}/${entry.handle}": ${JSON.stringify(result.metaobjectUpsert.userErrors)}`);
    } else {
      applied += 1;
    }
    bar.tick();
  }
  bar.done();

  return { resource: 'metaobjects', planned, applied, skipped: planned - applied, noteCount: notes.length };
}
