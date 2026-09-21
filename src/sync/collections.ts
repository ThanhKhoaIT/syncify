import { SyncContext, SyncResult } from '../types.js';
import { logger, createProgressBar } from '../logger.js';

interface RuleSetRule {
  column: string;
  relation: string;
  condition: string;
}

interface RuleSet {
  appliedDisjunctively: boolean;
  rules: RuleSetRule[];
}

interface CollectionImage {
  url: string;
  altText: string | null;
}

interface Collection {
  handle: string;
  title: string;
  descriptionHtml: string;
  templateSuffix: string | null;
  sortOrder: string;
  image: CollectionImage | null;
  ruleSet: RuleSet | null;
  products: { nodes: { handle: string }[] };
}

const COLLECTIONS_QUERY = `#graphql
  query Collections($cursor: String) {
    collections(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        handle
        title
        descriptionHtml
        templateSuffix
        sortOrder
        image { url altText }
        ruleSet {
          appliedDisjunctively
          rules { column relation condition }
        }
        products(first: 250) {
          nodes { handle }
        }
      }
    }
  }
`;

const DEV_COLLECTIONS_QUERY = `#graphql
  query DevCollections($cursor: String) {
    collections(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id handle }
    }
  }
`;

const PRODUCT_BY_HANDLE = `#graphql
  query ProductByHandle($handle: String!) {
    productByHandle(handle: $handle) { id }
  }
`;

// NOTE: ruleSet and collectionAddProducts are both marked deprecated by
// Shopify in favor of a newer sources/inclusion API whose exact nested
// shape isn't fully documented publicly — verify against schema
// introspection for the pinned apiVersion before the first live run. Both
// deprecated fields remain functional as of writing, and were chosen over
// guessing at the undocumented replacement shape.
const COLLECTION_CREATE = `#graphql
  mutation CollectionCreate($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection { id handle }
      userErrors { field message }
    }
  }
`;

const COLLECTION_UPDATE = `#graphql
  mutation CollectionUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection { id handle }
      userErrors { field message }
    }
  }
`;

const COLLECTION_ADD_PRODUCTS = `#graphql
  mutation CollectionAddProducts($id: ID!, $productIds: [ID!]!) {
    collectionAddProducts(id: $id, productIds: $productIds) {
      collection { id }
      userErrors { field message }
    }
  }
`;

export async function syncCollections(ctx: SyncContext): Promise<SyncResult> {
  const notes: string[] = [
    'Manual (non-rule-based) collection membership only syncs the first time a collection is created on Dev — re-running does not update membership on an already-existing collection, to avoid duplicate-add errors. Automated (rule-based) collections resolve membership from their rules automatically on Dev, no separate step needed.',
  ];

  const collections: Collection[] = [];
  let cursor: string | null = null;
  do {
    const data: any = await ctx.prod.query(COLLECTIONS_QUERY, { cursor });
    collections.push(...data.collections.nodes);
    cursor = data.collections.pageInfo.hasNextPage ? data.collections.pageInfo.endCursor : null;
  } while (cursor);

  logger.step(`Found ${collections.length} collections on ${ctx.config.prodStore}.`);

  if (!ctx.live) {
    return {
      resource: 'collections',
      planned: collections.length,
      applied: 0,
      skipped: 0,
      notes: [...notes, `Dry-run: ${collections.length} collections would be upserted.`],
    };
  }

  const existing = new Map<string, string>();
  let devCursor: string | null = null;
  do {
    const data: any = await ctx.dev.query(DEV_COLLECTIONS_QUERY, { cursor: devCursor });
    for (const c of data.collections.nodes) existing.set(c.handle.normalize('NFC'), c.id);
    devCursor = data.collections.pageInfo.hasNextPage ? data.collections.pageInfo.endCursor : null;
  } while (devCursor);

  let applied = 0;
  const bar = createProgressBar(collections.length, 'collections');

  for (const collection of collections) {
    const handle = collection.handle.normalize('NFC');
    const existingId = existing.get(handle);

    const input: any = {
      handle,
      title: collection.title,
      descriptionHtml: collection.descriptionHtml,
      templateSuffix: collection.templateSuffix,
      sortOrder: collection.sortOrder,
    };
    if (collection.image) {
      input.image = { src: collection.image.url, altText: collection.image.altText ?? undefined };
    }
    if (collection.ruleSet) {
      input.ruleSet = {
        appliedDisjunctively: collection.ruleSet.appliedDisjunctively,
        rules: collection.ruleSet.rules.map((r) => ({ column: r.column, relation: r.relation, condition: r.condition })),
      };
    }
    if (existingId) {
      input.id = existingId;
    }

    const result: any = existingId
      ? await ctx.dev.mutate(COLLECTION_UPDATE, { input })
      : await ctx.dev.mutate(COLLECTION_CREATE, { input });

    const payload = existingId ? result.collectionUpdate : result.collectionCreate;
    if (payload.userErrors?.length) {
      notes.push(`Collection "${handle}": ${JSON.stringify(payload.userErrors)}`);
      bar.tick();
      continue;
    }
    applied += 1;

    // Manual collection membership — only on first creation (see note above).
    if (!existingId && !collection.ruleSet) {
      const devCollectionId = payload.collection.id;
      const productIds: string[] = [];
      for (const p of collection.products.nodes) {
        const productHandle = p.handle.normalize('NFC');
        const productResult: any = await ctx.dev.query(PRODUCT_BY_HANDLE, { handle: productHandle });
        const devProductId = productResult.productByHandle?.id;
        if (devProductId) {
          productIds.push(devProductId);
        } else {
          notes.push(`Collection "${handle}": product "${productHandle}" not found on Dev — skipped from membership.`);
        }
      }
      if (productIds.length > 0) {
        const addResult: any = await ctx.dev.mutate(COLLECTION_ADD_PRODUCTS, { id: devCollectionId, productIds });
        if (addResult.collectionAddProducts.userErrors?.length) {
          notes.push(`Collection "${handle}" membership: ${JSON.stringify(addResult.collectionAddProducts.userErrors)}`);
        }
      }
    }

    bar.tick();
  }
  bar.done();

  return { resource: 'collections', planned: collections.length, applied, skipped: collections.length - applied, notes };
}
