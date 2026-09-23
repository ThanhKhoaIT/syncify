import { SyncContext, SyncResult } from '../types.js';
import { logger, createProgressBar } from '../logger.js';

interface Variant {
  sku: string | null;
  price: string;
  compareAtPrice: string | null;
  inventoryPolicy: string;
  selectedOptions: { name: string; value: string }[];
}

interface Metafield {
  namespace: string;
  key: string;
  type: string;
  value: string;
}

interface MediaImageNode {
  __typename: string;
  alt: string | null;
  image?: { url: string };
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
  metafields: { nodes: Metafield[] };
  media: { nodes: MediaImageNode[] };
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
        metafields(first: 250) {
          nodes { namespace key type value }
        }
        media(first: 50) {
          nodes {
            __typename
            alt
            ... on MediaImage { image { url } }
          }
        }
      }
    }
  }
`;

// Product-level metafields, upserted right after productSet returns the dev
// product's id. Uses metafieldsSet (25 per call), same as shop metafields.
const METAFIELDS_SET_MUTATION = `#graphql
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key }
      userErrors { field message }
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
      product {
        id
        handle
        media(first: 50) { nodes { id } }
      }
      userErrors { field message }
    }
  }
`;

// Media has no stable cross-store handle to diff against (same limitation
// as the "files" resource), so an update reconciles by deleting Dev's
// current media for the product and re-attaching Production's current set
// fresh — the only way to keep it accurate on every run rather than only
// the first time. Tradeoff: any image added directly on Dev (not synced
// from Production) is wiped on the next sync.
const PRODUCT_DELETE_MEDIA = `#graphql
  mutation ProductDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
    productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
      deletedMediaIds
      mediaUserErrors { field message }
    }
  }
`;

const PRODUCT_CREATE_MEDIA = `#graphql
  mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media { id }
      mediaUserErrors { field message }
    }
  }
`;

export async function syncProducts(ctx: SyncContext): Promise<SyncResult> {
  const notes: string[] = [
    'Inventory levels are not synced (would require mapping locations between stores) — variants sync without stock quantities.',
    ctx.config.productTitlePrefix
      ? `Product titles are prefixed with "${ctx.config.productTitlePrefix}" on Dev (productTitlePrefix in .syncifyrc.json — set to "" to disable).`
      : 'productTitlePrefix is empty — product titles sync unprefixed.',
    'Product images are reconciled on every sync — Dev\'s current media is deleted and Production\'s current images re-attached fresh, so image changes on Production always propagate. Any image added directly on Dev (not from Production) is wiped on the next sync. Video/3D model media is not synced, only images.',
  ];
  const products: Product[] = [];
  let cursor: string | null = null;

  do {
    const data: any = await ctx.prod.query(PRODUCTS_QUERY, { cursor });
    products.push(...data.products.nodes);
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);

  logger.step(`Found ${products.length} products on ${ctx.config.prodStore}.`);

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
  const bar = createProgressBar(products.length, 'products');
  for (const product of products) {
    const input = {
      handle: product.handle,
      title: `${ctx.config.productTitlePrefix}${product.title}`,
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
      bar.tick();
      continue;
    }
    applied += 1;

    const devProductId = result.productSet.product.id;
    const metafields = product.metafields.nodes;
    for (let i = 0; i < metafields.length; i += 25) {
      const batch = metafields.slice(i, i + 25).map((mf) => ({
        ownerId: devProductId,
        namespace: mf.namespace,
        key: mf.key,
        type: mf.type,
        value: mf.value,
      }));
      const mfResult: any = await ctx.dev.mutate(METAFIELDS_SET_MUTATION, { metafields: batch });
      if (mfResult.metafieldsSet.userErrors?.length) {
        notes.push(`Product "${product.handle}" metafields: ${JSON.stringify(mfResult.metafieldsSet.userErrors)}`);
      }
    }

    const existingMediaIds: string[] = result.productSet.product.media.nodes.map((m: { id: string }) => m.id);
    const images = product.media.nodes.filter((m) => m.__typename === 'MediaImage' && m.image?.url);

    if (existingMediaIds.length > 0) {
      const deleteResult: any = await ctx.dev.mutate(PRODUCT_DELETE_MEDIA, { productId: devProductId, mediaIds: existingMediaIds });
      if (deleteResult.productDeleteMedia.mediaUserErrors?.length) {
        notes.push(`Product "${product.handle}" media delete: ${JSON.stringify(deleteResult.productDeleteMedia.mediaUserErrors)}`);
      }
    }

    if (images.length > 0) {
      const mediaResult: any = await ctx.dev.mutate(PRODUCT_CREATE_MEDIA, {
        productId: devProductId,
        media: images.map((m) => ({ originalSource: m.image!.url, mediaContentType: 'IMAGE', alt: m.alt ?? undefined })),
      });
      if (mediaResult.productCreateMedia.mediaUserErrors?.length) {
        notes.push(`Product "${product.handle}" media: ${JSON.stringify(mediaResult.productCreateMedia.mediaUserErrors)}`);
      }
    }
    bar.tick();
  }
  bar.done();

  return { resource: 'products', planned: products.length, applied, skipped: products.length - applied, notes };
}
