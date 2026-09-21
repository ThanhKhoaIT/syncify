import { SyncContext, SyncResult } from '../types.js';
import { logger, createProgressBar } from '../logger.js';

// Item types whose value depends on a resourceId GID pointing at a specific
// Production record. Those GIDs don't resolve to the same records on Dev,
// so items of these types (and their whole subtree) are skipped rather than
// silently linked to the wrong thing or left broken.
const RESOURCE_TYPES = new Set([
  'PRODUCT',
  'COLLECTION',
  'COLLECTIONS',
  'PAGE',
  'BLOG',
  'ARTICLE',
  'METAOBJECT',
  'SHOP_POLICY',
  'CUSTOMER_ACCOUNT_PAGE',
]);

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

function filterItems(items: MenuItemNode[], stats: { skipped: number }): FilteredItem[] {
  const result: FilteredItem[] = [];
  for (const item of items) {
    if (RESOURCE_TYPES.has(item.type)) {
      stats.skipped += 1 + countAll(item.items);
      continue;
    }
    result.push({ title: item.title, type: item.type, url: item.url, items: filterItems(item.items, stats) });
  }
  return result;
}

export async function syncMenus(ctx: SyncContext): Promise<SyncResult> {
  const notes: string[] = [
    'Menu items linking to a specific resource (product, collection, page, blog, article, metaobject, shop policy) are skipped, along with their sub-items — the GIDs they hold on Production do not resolve to the same records on Dev. Only URL-based items (HTTP links, Frontpage, Search, Catalog) sync.',
  ];

  const menus: Menu[] = [];
  let cursor: string | null = null;
  do {
    const data: any = await ctx.prod.query(MENUS_QUERY, { cursor });
    menus.push(...data.menus.nodes);
    cursor = data.menus.pageInfo.hasNextPage ? data.menus.pageInfo.endCursor : null;
  } while (cursor);

  const stats = { skipped: 0 };
  const filtered = menus.map((m) => ({ handle: m.handle, title: m.title, items: filterItems(m.items, stats) }));

  logger.step(`Fetched ${menus.length} menus from ${ctx.config.prodStore} (${stats.skipped} item(s) skipped).`);

  if (!ctx.live) {
    return {
      resource: 'menus',
      planned: filtered.length,
      applied: 0,
      skipped: stats.skipped,
      notes: [...notes, `Dry-run: ${filtered.length} menus would be upserted.`],
    };
  }

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
