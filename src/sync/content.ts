import { SyncContext, SyncResult } from '../types.js';
import { logger, createProgressBar } from '../logger.js';
import { MetafieldBatcher } from '../metafieldBatcher.js';

interface Metafield {
  namespace: string;
  key: string;
  type: string;
  value: string;
}

interface Page {
  handle: string;
  title: string;
  body: string;
  isPublished: boolean;
  templateSuffix: string | null;
  metafields: { nodes: Metafield[] };
}

const PAGES_QUERY = `#graphql
  query Pages($cursor: String) {
    pages(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        handle
        title
        body
        isPublished
        templateSuffix
        metafields(first: 250) {
          nodes { namespace key type value }
        }
      }
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
    "A page's assigned template (templateSuffix, e.g. \"contact\" for page.contact.json) is synced, but the template/section files themselves are theme files, not part of the Page resource — sync the \"theme\" resource too, or the page will reference a template that doesn't exist on Dev and fall back to the default.",
  ];
  const pages: Page[] = [];
  let cursor: string | null = null;

  do {
    const data: any = await ctx.prod.query(PAGES_QUERY, { cursor });
    pages.push(...data.pages.nodes);
    cursor = data.pages.pageInfo.hasNextPage ? data.pages.pageInfo.endCursor : null;
  } while (cursor);

  logger.step(`Found ${pages.length} pages on ${ctx.config.prodStore}.`);

  if (!ctx.live) {
    return { resource: 'content', planned: pages.length, applied: 0, skipped: 0, notes };
  }

  // Build handle -> id map of existing dev pages so re-running sync updates
  // instead of erroring on a duplicate handle. Handles are normalized (NFC)
  // before comparing — a handle with accented characters (e.g. Vietnamese)
  // can come back from the API as either precomposed or decomposed Unicode,
  // and those aren't === equal in JS even though they're the same handle.
  const existing = new Map<string, string>();
  let devCursor: string | null = null;
  do {
    const data: any = await ctx.dev.query(DEV_PAGES_QUERY, { cursor: devCursor });
    for (const p of data.pages.nodes) existing.set(p.handle.normalize('NFC'), p.id);
    devCursor = data.pages.pageInfo.hasNextPage ? data.pages.pageInfo.endCursor : null;
  } while (devCursor);

  let applied = 0;
  const metafieldBatcher = new MetafieldBatcher(ctx.dev);
  const bar = createProgressBar(pages.length, 'content');
  for (const page of pages) {
    const existingId = existing.get(page.handle.normalize('NFC'));
    const input = {
      title: page.title,
      handle: page.handle,
      body: page.body,
      isPublished: page.isPublished,
      templateSuffix: page.templateSuffix,
    };

    const result: any = existingId
      ? await ctx.dev.mutate(PAGE_UPDATE, { id: existingId, page: input })
      : await ctx.dev.mutate(PAGE_CREATE, { page: input });

    const payload = existingId ? result.pageUpdate : result.pageCreate;
    if (payload.userErrors?.length) {
      notes.push(`Page "${page.handle}": ${JSON.stringify(payload.userErrors)}`);
      bar.tick();
      continue;
    }
    applied += 1;

    const devPageId = payload.page.id;
    metafieldBatcher.add(devPageId, page.handle, page.metafields.nodes);
    await metafieldBatcher.flushIfFull();
    bar.tick();
  }
  bar.done();

  await metafieldBatcher.flushAll();
  notes.push(...metafieldBatcher.drainNotes());

  return { resource: 'content', planned: pages.length, applied, skipped: pages.length - applied, notes };
}
