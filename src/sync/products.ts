import { SyncContext, SyncResult } from '../types.js';
import { logger } from '../logger.js';

interface Variant {
  sku: string | null;
  price: string;
  compareAtPrice: string | null;
  inventoryPolicy: string;
  selectedOptions: { name: string; value: string }[];
}

interface Product {
  handle: string;
  title: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  tags: string[];
  status: string;
  options: { name: string; values: string[] }[];
  variants: { nodes: Variant[] };
}

const PRODUCTS_QUERY = `#graphql
  query Products($cursor: String) {
    products(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        handle
        title
        descriptionHtml
        vendor
        productType
        tags
        status
        options { name values }
        variants(first: 100) {
          nodes {
            sku
            price
            compareAtPrice
            inventoryPolicy
            selectedOptions { name value }
          }
        }
      }
    }
  }
`;

// productSet upserts by handle, so re-running sync is idempotent.
// NOTE: verify ProductSetInput's exact shape via schema introspection for the
// pinned apiVersion (see src/client.ts) before the first live run — Shopify
// has revised this input across versions.
const PRODUCT_SET_MUTATION = `#graphql
  mutation ProductSet($input: ProductSetInput!) {
    productSet(input: $input, synchronous: true) {
      product { id handle }
      userErrors { field message }
    }
  }
`;

export async function syncProducts(ctx: SyncContext): Promise<SyncResult> {
  const notes: string[] = [
    'Inventory levels are not synced (would require mapping locations between stores) — variants sync without stock quantities.',
  ];
  const products: Product[] = [];
  let cursor: string | null = null;

  do {
    const data: any = await ctx.prod.query(PRODUCTS_QUERY, { cursor });
    products.push(...data.products.nodes);
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);

  logger.step(`Fetched ${products.length} products from ${ctx.config.prodStore}.`);

  if (!ctx.live) {
    return {
      resource: 'products',
      planned: products.length,
      applied: 0,
      skipped: 0,
      notes: [...notes, `Dry-run: ${products.length} products would be upserted via productSet.`],
    };
  }

  let applied = 0;
  for (const product of products) {
    const input = {
      handle: product.handle,
      title: product.title,
      descriptionHtml: product.descriptionHtml,
      vendor: product.vendor,
      productType: product.productType,
      tags: product.tags,
      status: product.status,
      productOptions: product.options.map((o) => ({
        name: o.name,
        values: o.values.map((v) => ({ name: v })),
      })),
      variants: product.variants.nodes.map((v) => ({
        sku: v.sku,
        price: v.price,
        compareAtPrice: v.compareAtPrice,
        inventoryPolicy: v.inventoryPolicy,
        optionValues: v.selectedOptions.map((so) => ({ optionName: so.name, name: so.value })),
      })),
    };

    const result: any = await ctx.dev.mutate(PRODUCT_SET_MUTATION, { input });
    if (result.productSet.userErrors?.length) {
      notes.push(`Product "${product.handle}": ${JSON.stringify(result.productSet.userErrors)}`);
    } else {
      applied += 1;
    }
  }

  return { resource: 'products', planned: products.length, applied, skipped: products.length - applied, notes };
}
