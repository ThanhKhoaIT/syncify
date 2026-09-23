import { SyncContext, SyncResult } from '../types.js';
import { logger, createProgressBar } from '../logger.js';
import { Notes } from '../notes.js';

interface Metafield {
  namespace: string;
  key: string;
  type: string;
  value: string;
}

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

export async function syncMetafields(ctx: SyncContext): Promise<SyncResult> {
  const notes = new Notes('metafields');
  notes.push(
    'This module handles shop-level metafields only. Product metafields sync as part of the "products" resource (see sync/products.ts). Variant-level metafields are not yet implemented.'
  );
  const all: Metafield[] = [];
  let cursor: string | null = null;

  do {
    const data: any = await ctx.prod.query(SHOP_METAFIELDS_QUERY, { cursor });
    all.push(...data.shop.metafields.nodes);
    cursor = data.shop.metafields.pageInfo.hasNextPage ? data.shop.metafields.pageInfo.endCursor : null;
  } while (cursor);

  logger.step(`Found ${all.length} shop metafields on ${ctx.config.prodStore}.`);

  if (!ctx.live) {
    return { resource: 'metafields', planned: all.length, applied: 0, skipped: 0, noteCount: notes.length };
  }

  const devShop: any = await ctx.dev.query(SHOP_ID_QUERY);
  const ownerId = devShop.shop.id;
  const input = all.map((mf) => ({ ownerId, namespace: mf.namespace, key: mf.key, type: mf.type, value: mf.value }));

  let applied = 0;
  const bar = createProgressBar(input.length, 'metafields');
  // metafieldsSet accepts at most 25 per call.
  for (let i = 0; i < input.length; i += 25) {
    const batch = input.slice(i, i + 25);
    const result: any = await ctx.dev.mutate(METAFIELDS_SET_MUTATION, { metafields: batch });
    if (result.metafieldsSet.userErrors?.length) {
      notes.push(`Errors in batch starting at ${i}: ${JSON.stringify(result.metafieldsSet.userErrors)}`);
    }
    applied += result.metafieldsSet.metafields.length;
    bar.tick(batch.length);
  }
  bar.done();

  return { resource: 'metafields', planned: all.length, applied, skipped: all.length - applied, noteCount: notes.length };
}
