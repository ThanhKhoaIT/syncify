import { SyncContext, SyncResult } from '../types.js';
import { logger, createProgressBar } from '../logger.js';

interface Page {
  handle: string;
  title: string;
  body: string;
  isPublished: boolean;
}

const PAGES_QUERY = `#graphql
  query Pages($cursor: String) {
    pages(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { handle title body isPublished }
    }
  }
`;

const DEV_PAGES_QUERY = `#graphql
  query DevPages($cursor: String) {
    pages(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id handle }
    }
  }
`;

const PAGE_CREATE = `#graphql
  mutation PageCreate($page: PageCreateInput!) {
    pageCreate(page: $page) {
      page { id handle }
      userErrors { field message }
    }
  }
`;

const PAGE_UPDATE = `#graphql
  mutation PageUpdate($id: ID!, $page: PageUpdateInput!) {
    pageUpdate(id: $id, page: $page) {
      page { id handle }
      userErrors { field message }
    }
  }
`;

export async function syncContent(ctx: SyncContext): Promise<SyncResult> {
  const notes: string[] = [
    'Only Online Store pages are synced in this version. Blogs/articles and navigation menus are not yet implemented — track as follow-up work.',
  ];
  const pages: Page[] = [];
  let cursor: string | null = null;

  do {
    const data: any = await ctx.prod.query(PAGES_QUERY, { cursor });
    pages.push(...data.pages.nodes);
    cursor = data.pages.pageInfo.hasNextPage ? data.pages.pageInfo.endCursor : null;
  } while (cursor);

  logger.step(`Fetched ${pages.length} pages from ${ctx.config.prodStore}.`);

  if (!ctx.live) {
    return { resource: 'content', planned: pages.length, applied: 0, skipped: 0, notes };
  }

  // Build handle -> id map of existing dev pages so re-running sync updates
  // instead of erroring on a duplicate handle.
  const existing = new Map<string, string>();
  let devCursor: string | null = null;
  do {
    const data: any = await ctx.dev.query(DEV_PAGES_QUERY, { cursor: devCursor });
    for (const p of data.pages.nodes) existing.set(p.handle, p.id);
    devCursor = data.pages.pageInfo.hasNextPage ? data.pages.pageInfo.endCursor : null;
  } while (devCursor);

  let applied = 0;
  const bar = createProgressBar(pages.length, 'content');
  for (const page of pages) {
    const existingId = existing.get(page.handle);
    const input = { title: page.title, handle: page.handle, body: page.body, isPublished: page.isPublished };

    const result: any = existingId
      ? await ctx.dev.mutate(PAGE_UPDATE, { id: existingId, page: input })
      : await ctx.dev.mutate(PAGE_CREATE, { page: input });

    const payload = existingId ? result.pageUpdate : result.pageCreate;
    if (payload.userErrors?.length) {
      notes.push(`Page "${page.handle}": ${JSON.stringify(payload.userErrors)}`);
    } else {
      applied += 1;
    }
    bar.tick();
  }
  bar.done();

  return { resource: 'content', planned: pages.length, applied, skipped: pages.length - applied, notes };
}
