import { SyncContext, SyncResult } from '../types.js';
import { logger, createProgressBar } from '../logger.js';

// Resource-linked types we CAN resolve cross-store: look up the referenced
// record's handle on Production, then find the matching record by that same
// handle on Dev.
const RESOLVABLE_TYPES = new Set(['PRODUCT', 'COLLECTION', 'PAGE', 'BLOG']);

// Everything else that carries a resourceId has no reliable way to resolve
// to the right Dev record (no single handle, or no cross-store equivalent
// at all), so these — and their whole subtree — are always skipped.
const UNRESOLVABLE_RESOURCE_TYPES = new Set([
  'COLLECTIONS',
  'ARTICLE',
  'METAOBJECT',
  'SHOP_POLICY',
  'CUSTOMER_ACCOUNT_PAGE',
]);

const TYPENAME_TO_MENU_ITEM_TYPE: Record<string, string> = {
  Product: 'PRODUCT',
  Collection: 'COLLECTION',
  Page: 'PAGE',
  Blog: 'BLOG',
};

interface MenuItemNode {
  title: string;
  type: string;
  url: string | null;
  resourceId: string | null;
  items: MenuItemNode[];
}

interface Menu {
  handle: string;
  title: string;
  items: MenuItemNode[];
}

interface FilteredItem {
  title: string;
  type: string;
  url: string | null;
  resourceId: string | null;
  items: FilteredItem[];
}

// Menu items nest up to 3 levels deep (Shopify's own limit), hand-written
// since GraphQL query fragments can't recurse.
const MENU_ITEM_FIELDS = `
  title
  type
  url
  resourceId
`;

const MENUS_QUERY = `#graphql
  query Menus($cursor: String) {
    menus(first: 20, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        handle
        title
        items {
          ${MENU_ITEM_FIELDS}
          items {
            ${MENU_ITEM_FIELDS}
            items {
              ${MENU_ITEM_FIELDS}
            }
          }
        }
      }
    }
  }
`;

const DEV_MENUS_QUERY = `#graphql
  query DevMenus($cursor: String) {
    menus(first: 20, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id handle }
    }
  }
`;

// Batch-resolves resourceIds to handles in one call rather than one query
// per item — a link reused across menus is only ever looked up once.
const RESOLVE_HANDLES_QUERY = `#graphql
  query ResolveHandles($ids: [ID!]!) {
    nodes(ids: $ids) {
      id
      __typename
      ... on Product { handle }
      ... on Collection { handle }
      ... on Page { handle }
      ... on Blog { handle }
    }
  }
`;

const PRODUCT_BY_HANDLE = `#graphql
  query ProductByHandle($handle: String!) {
    productByHandle(handle: $handle) { id }
  }
`;

const COLLECTION_BY_HANDLE = `#graphql
  query CollectionByHandle($handle: String!) {
    collectionByHandle(handle: $handle) { id }
  }
`;

const PAGE_BY_HANDLE = `#graphql
  query PageByHandle($query: String!) {
    pages(first: 1, query: $query) { nodes { id } }
  }
`;

const BLOG_BY_HANDLE = `#graphql
  query BlogByHandle($query: String!) {
    blogs(first: 1, query: $query) { nodes { id } }
  }
`;

// NOTE: verify MenuItemCreateInput/MenuItemUpdateInput's exact shape via
// schema introspection for the pinned apiVersion before the first live run.
const MENU_CREATE = `#graphql
  mutation MenuCreate($handle: String!, $title: String!, $items: [MenuItemCreateInput!]!) {
    menuCreate(handle: $handle, title: $title, items: $items) {
      menu { id handle }
      userErrors { field message }
    }
  }
`;

const MENU_UPDATE = `#graphql
  mutation MenuUpdate($id: ID!, $title: String!, $items: [MenuItemUpdateInput!]!) {
    menuUpdate(id: $id, title: $title, items: $items) {
      menu { id handle }
      userErrors { field message }
    }
  }
`;

function countAll(items: MenuItemNode[]): number {
  return items.reduce((sum, i) => sum + 1 + countAll(i.items), 0);
}

// Pass 1 (both dry-run and live): drop items whose type has no reliable
// cross-store equivalent at all. Resolvable-type items pass through
// unchanged (still carrying their Production resourceId).
function dropUnresolvable(items: MenuItemNode[], stats: { skipped: number }): MenuItemNode[] {
  const result: MenuItemNode[] = [];
  for (const item of items) {
    if (UNRESOLVABLE_RESOURCE_TYPES.has(item.type)) {
      stats.skipped += 1 + countAll(item.items);
      continue;
    }
    result.push({ ...item, items: dropUnresolvable(item.items, stats) });
  }
  return result;
}

function collectResourceIds(items: MenuItemNode[], ids: Set<string>): void {
  for (const item of items) {
    if (RESOLVABLE_TYPES.has(item.type) && item.resourceId) ids.add(item.resourceId);
    collectResourceIds(item.items, ids);
  }
}

// Pass 2 (live only): items still carrying a resolvable type get their
// Production resourceId swapped for the matching Dev record's id, found via
// the `resolved` map. Anything that couldn't be resolved (handle lookup
// failed on Production, or no matching record exists on Dev) is skipped
// along with its subtree here.
function resolveAndFilter(items: MenuItemNode[], resolved: Map<string, string>, stats: { skipped: number }): FilteredItem[] {
  const result: FilteredItem[] = [];
  for (const item of items) {
    if (RESOLVABLE_TYPES.has(item.type)) {
      const devId = item.resourceId ? resolved.get(item.resourceId) : undefined;
      if (!devId) {
        stats.skipped += 1 + countAll(item.items);
        continue;
      }
      result.push({ title: item.title, type: item.type, url: null, resourceId: devId, items: resolveAndFilter(item.items, resolved, stats) });
      continue;
    }
    result.push({ title: item.title, type: item.type, url: item.url, resourceId: null, items: resolveAndFilter(item.items, resolved, stats) });
  }
  return result;
}

async function resolveDevId(ctx: SyncContext, type: string, handle: string): Promise<string | null> {
  switch (type) {
    case 'PRODUCT': {
      const data: any = await ctx.dev.query(PRODUCT_BY_HANDLE, { handle });
      return data.productByHandle?.id ?? null;
    }
    case 'COLLECTION': {
      const data: any = await ctx.dev.query(COLLECTION_BY_HANDLE, { handle });
      return data.collectionByHandle?.id ?? null;
    }
    case 'PAGE': {
      const data: any = await ctx.dev.query(PAGE_BY_HANDLE, { query: `handle:${handle}` });
      return data.pages.nodes[0]?.id ?? null;
    }
    case 'BLOG': {
      const data: any = await ctx.dev.query(BLOG_BY_HANDLE, { query: `handle:${handle}` });
      return data.blogs.nodes[0]?.id ?? null;
    }
    default:
      return null;
  }
}

export async function syncMenus(ctx: SyncContext): Promise<SyncResult> {
  const notes: string[] = [
    'Product/Collection/Page/Blog menu items are resolved by handle to the matching Dev record on a --live run. Items linking to an article, metaobject, shop policy, customer account page, or "all collections" are skipped along with their sub-items — no reliable cross-store equivalent to resolve to.',
  ];

  const menus: Menu[] = [];
  let cursor: string | null = null;
  do {
    const data: any = await ctx.prod.query(MENUS_QUERY, { cursor });
    menus.push(...data.menus.nodes);
    cursor = data.menus.pageInfo.hasNextPage ? data.menus.pageInfo.endCursor : null;
  } while (cursor);

  const stats = { skipped: 0 };
  const pruned = menus.map((m) => ({ handle: m.handle, title: m.title, items: dropUnresolvable(m.items, stats) }));

  logger.step(`Fetched ${menus.length} menus from ${ctx.config.prodStore}.`);

  if (!ctx.live) {
    return {
      resource: 'menus',
      planned: pruned.length,
      applied: 0,
      skipped: stats.skipped,
      notes: [
        ...notes,
        `Dry-run: ${pruned.length} menus would be upserted. Product/Collection/Page/Blog links aren't verified against Dev until --live.`,
      ],
    };
  }

  const resourceIds = new Set<string>();
  for (const menu of pruned) collectResourceIds(menu.items, resourceIds);

  const resolved = new Map<string, string>();
  if (resourceIds.size > 0) {
    const handleData: any = await ctx.prod.query(RESOLVE_HANDLES_QUERY, { ids: Array.from(resourceIds) });
    for (const node of handleData.nodes) {
      if (!node?.handle) continue;
      const type = TYPENAME_TO_MENU_ITEM_TYPE[node.__typename];
      if (!type) continue;
      const devId = await resolveDevId(ctx, type, node.handle);
      if (devId) {
        resolved.set(node.id, devId);
      } else {
        notes.push(`No matching ${type.toLowerCase()} with handle "${node.handle}" found on Dev — skipping menu item(s) that link to it.`);
      }
    }
  }

  const filtered = pruned.map((m) => ({ handle: m.handle, title: m.title, items: resolveAndFilter(m.items, resolved, stats) }));

  const existing = new Map<string, string>();
  let devCursor: string | null = null;
  do {
    const data: any = await ctx.dev.query(DEV_MENUS_QUERY, { cursor: devCursor });
    for (const m of data.menus.nodes) existing.set(m.handle, m.id);
    devCursor = data.menus.pageInfo.hasNextPage ? data.menus.pageInfo.endCursor : null;
  } while (devCursor);

  let applied = 0;
  const bar = createProgressBar(filtered.length, 'menus');
  for (const menu of filtered) {
    const existingId = existing.get(menu.handle);

    const result: any = existingId
      ? await ctx.dev.mutate(MENU_UPDATE, { id: existingId, title: menu.title, items: menu.items })
      : await ctx.dev.mutate(MENU_CREATE, { handle: menu.handle, title: menu.title, items: menu.items });

    const payload = existingId ? result.menuUpdate : result.menuCreate;
    if (payload.userErrors?.length) {
      notes.push(`Menu "${menu.handle}": ${JSON.stringify(payload.userErrors)}`);
    } else {
      applied += 1;
    }
    bar.tick();
  }
  bar.done();

  return { resource: 'menus', planned: filtered.length, applied, skipped: stats.skipped, notes };
}
