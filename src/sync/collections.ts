import { SyncContext, SyncResult } from '../types.js';
import { logger, createProgressBar } from '../logger.js';
import { Notes } from '../notes.js';

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

const DEV_COLLECTION_PRODUCTS_QUERY = `#graphql
  query DevCollectionProducts($id: ID!, $cursor: String) {
    collection(id: $id) {
      products(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id handle }
      }
    }
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

const COLLECTION_REMOVE_PRODUCTS = `#graphql
  mutation CollectionRemoveProducts($id: ID!, $productIds: [ID!]!) {
    collectionRemoveProducts(id: $id, productIds: $productIds) {
      job { id }
      userErrors { field message }
    }
  }
`;

export async function syncCollections(ctx: SyncContext): Promise<SyncResult> {
  const notes = new Notes('collections');
  notes.push(
    'Manual (non-rule-based) collection membership is reconciled on every sync — products added or removed on Production propagate to Dev, matched by product handle (a stable identifier, unlike media). Removal happens via an async Shopify job, so it may not be reflected immediately after the run finishes. Automated (rule-based) collections resolve membership from their rules automatically on Dev, no separate step needed.'
  );

  const collections: Collection[] = [];
  let cursor: string | null = null;
  do {
    const data: any = await ctx.prod.query(COLLECTIONS_QUERY, { cursor });
    collections.push(...data.collections.nodes);
    cursor = data.collections.pageInfo.hasNextPage ? data.collections.pageInfo.endCursor : null;
  } while (cursor);

  logger.step(`Found ${collections.length} collections on ${ctx.config.prodStore}.`);

  if (!ctx.live) {
    notes.push(`Dry-run: ${collections.length} collections would be upserted.`);
    return { resource: 'collections', planned: collections.length, applied: 0, skipped: 0, noteCount: notes.length };
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

    // Manual collection membership — reconciled on every sync (add/remove
    // diffed by product handle) rather than only on first creation.
    if (!collection.ruleSet) {
      const devCollectionId = payload.collection.id;
      const prodHandles = new Set(collection.products.nodes.map((p) => p.handle.normalize('NFC')));

      const devMembers = new Map<string, string>();
      if (existingId) {
        let memberCursor: string | null = null;
        do {
          const data: any = await ctx.dev.query(DEV_COLLECTION_PRODUCTS_QUERY, { id: devCollectionId, cursor: memberCursor });
          for (const p of data.collection.products.nodes) devMembers.set(p.handle.normalize('NFC'), p.id);
          memberCursor = data.collection.products.pageInfo.hasNextPage ? data.collection.products.pageInfo.endCursor : null;
        } while (memberCursor);
      }

      const toAddHandles = [...prodHandles].filter((h) => !devMembers.has(h));
      const toRemoveIds = [...devMembers.entries()].filter(([h]) => !prodHandles.has(h)).map(([, id]) => id);

      const toAddIds: string[] = [];
      for (const productHandle of toAddHandles) {
        const productResult: any = await ctx.dev.query(PRODUCT_BY_HANDLE, { handle: productHandle });
        const devProductId = productResult.productByHandle?.id;
        if (devProductId) {
          toAddIds.push(devProductId);
        } else {
          notes.push(`Collection "${handle}": product "${productHandle}" not found on Dev — skipped from membership.`);
        }
      }

      if (toAddIds.length > 0) {
        const addResult: any = await ctx.dev.mutate(COLLECTION_ADD_PRODUCTS, { id: devCollectionId, productIds: toAddIds });
        if (addResult.collectionAddProducts.userErrors?.length) {
          notes.push(`Collection "${handle}" membership add: ${JSON.stringify(addResult.collectionAddProducts.userErrors)}`);
        }
      }
      if (toRemoveIds.length > 0) {
        const removeResult: any = await ctx.dev.mutate(COLLECTION_REMOVE_PRODUCTS, { id: devCollectionId, productIds: toRemoveIds });
        if (removeResult.collectionRemoveProducts.userErrors?.length) {
          notes.push(`Collection "${handle}" membership remove: ${JSON.stringify(removeResult.collectionRemoveProducts.userErrors)}`);
        }
      }
    }

    bar.tick();
  }
  bar.done();

  return { resource: 'collections', planned: collections.length, applied, skipped: collections.length - applied, noteCount: notes.length };
}
