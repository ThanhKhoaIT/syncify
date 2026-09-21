import { SyncContext, SyncResult } from '../types.js';
import { logger, createProgressBar } from '../logger.js';

const DISCOUNTS_QUERY = `#graphql
  query CodeDiscounts($cursor: String) {
    codeDiscountNodes(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        codeDiscount {
          __typename
          ... on DiscountCodeBasic {
            title
            codes(first: 1) { nodes { code } }
            startsAt
            endsAt
            appliesOncePerCustomer
            customerGets {
              value {
                __typename
                ... on DiscountPercentage { percentage }
                ... on DiscountAmount { amount { amount currencyCode } }
              }
            }
          }
        }
      }
    }
  }
`;

// NOTE: verify DiscountCodeBasicInput's exact shape via schema introspection
// for the pinned apiVersion before the first live run.
const DISCOUNT_CREATE = `#graphql
  mutation DiscountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode { id }
      userErrors { field message }
    }
  }
`;

export async function syncDiscounts(ctx: SyncContext): Promise<SyncResult> {
  const notes: string[] = [
    'Only basic percentage/fixed-amount discount codes are synced (BXGY, free shipping, and automatic discounts are skipped).',
    'This sync is NOT idempotent yet: re-running will attempt to recreate codes and fail on duplicates — treat re-runs as needing manual cleanup on the dev store first.',
  ];
  const supported: any[] = [];
  let skipped = 0;
  let cursor: string | null = null;

  do {
    const data: any = await ctx.prod.query(DISCOUNTS_QUERY, { cursor });
    for (const node of data.codeDiscountNodes.nodes) {
      if (node.codeDiscount.__typename === 'DiscountCodeBasic') {
        supported.push(node.codeDiscount);
      } else {
        skipped += 1;
      }
    }
    cursor = data.codeDiscountNodes.pageInfo.hasNextPage ? data.codeDiscountNodes.pageInfo.endCursor : null;
  } while (cursor);

  logger.step(`Found ${supported.length} discount codes on ${ctx.config.prodStore} (${skipped} skipped).`);

  if (!ctx.live) {
    return { resource: 'discounts', planned: supported.length, applied: 0, skipped, notes };
  }

  let applied = 0;
  const bar = createProgressBar(supported.length, 'discounts');
  for (const discount of supported) {
    const value = discount.customerGets.value;
    const customerGetsValue =
      value.__typename === 'DiscountPercentage'
        ? { percentage: value.percentage }
        : { discountAmount: { amount: value.amount.amount, appliesOnEachItem: false } };

    const result: any = await ctx.dev.mutate(DISCOUNT_CREATE, {
      basicCodeDiscount: {
        title: discount.title,
        code: discount.codes.nodes[0]?.code,
        startsAt: discount.startsAt,
        endsAt: discount.endsAt,
        appliesOncePerCustomer: discount.appliesOncePerCustomer,
        customerSelection: { all: true },
        customerGets: { value: customerGetsValue, items: { all: true } },
      },
    });

    if (result.discountCodeBasicCreate.userErrors?.length) {
      notes.push(`Discount "${discount.title}": ${JSON.stringify(result.discountCodeBasicCreate.userErrors)}`);
    } else {
      applied += 1;
    }
    bar.tick();
  }
  bar.done();

  return { resource: 'discounts', planned: supported.length, applied, skipped, notes };
}
