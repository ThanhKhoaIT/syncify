import { SyncContext, SyncResult } from '../types.js';
import { logger, createProgressBar } from '../logger.js';
import { Notes } from '../notes.js';

interface FileNode {
  __typename: string;
  alt: string | null;
  // Only GenericFile and Video expose a stable `filename` — used to match
  // against Dev (idempotency) and to pin the destination name on create, so
  // a shopify://files/<...>/<filename> theme setting reference (which
  // resolves by filename, not by ID) keeps working after the file re-syncs.
  // MediaImage/Model3d have no equivalent field, so they stay non-idempotent.
  filename?: string;
  url?: string;
  image?: { url: string };
  sources?: { url: string }[];
}

const FILES_QUERY = `#graphql
  query Files($cursor: String) {
    files(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        __typename
        ... on GenericFile { alt url filename }
        ... on MediaImage { alt image { url } }
        ... on Video { alt sources { url } filename }
        ... on Model3d { alt sources { url } }
      }
    }
  }
`;

// Only fetches enough to build the filename set (see FileNode.filename).
const DEV_FILES_QUERY = `#graphql
  query DevFiles($cursor: String) {
    files(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        __typename
        ... on GenericFile { filename }
        ... on Video { filename }
      }
    }
  }
`;

// NOTE: verify FileCreateInput's exact shape (incl. the `filename` field
// used to pin the destination name below) via schema introspection for the
// pinned apiVersion before the first live run.
const FILE_CREATE = `#graphql
  mutation FileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files { id fileStatus }
      userErrors { field message }
    }
  }
`;

function sourceUrl(node: FileNode): string | undefined {
  return node.url ?? node.image?.url ?? node.sources?.[0]?.url;
}

function contentType(typename: string): string {
  switch (typename) {
    case 'MediaImage':
      return 'IMAGE';
    case 'Video':
      return 'VIDEO';
    case 'Model3d':
      return 'MODEL_3D';
    default:
      return 'FILE';
  }
}

export async function syncFiles(ctx: SyncContext): Promise<SyncResult> {
  const notes = new Notes('files');
  notes.push(
    'GenericFile/Video files are matched to Dev by filename — a file already present under the same name is skipped rather than duplicated, and new uploads are pinned to that exact filename so a shopify://files/.../<filename> theme setting reference keeps resolving. MediaImage/Model3d have no stable filename field to match on, so those still duplicate on every run.'
  );

  const nodes: FileNode[] = [];
  let cursor: string | null = null;
  do {
    const data: any = await ctx.prod.query(FILES_QUERY, { cursor });
    nodes.push(...data.files.nodes);
    cursor = data.files.pageInfo.hasNextPage ? data.files.pageInfo.endCursor : null;
  } while (cursor);

  const withUrls = nodes.filter((n) => sourceUrl(n));
  const skipped = nodes.length - withUrls.length;
  if (skipped > 0) {
    notes.push(`Skipped ${skipped} file(s) with no resolvable source URL (still processing on Production).`);
  }

  logger.step(`Found ${withUrls.length} files on ${ctx.config.prodStore} (${skipped} skipped).`);

  if (!ctx.live) {
    return { resource: 'files', planned: withUrls.length, applied: 0, skipped, noteCount: notes.length };
  }

  const existingDevFilenames = new Set<string>();
  let devCursor: string | null = null;
  do {
    const data: any = await ctx.dev.query(DEV_FILES_QUERY, { cursor: devCursor });
    for (const node of data.files.nodes) {
      if (node.filename) existingDevFilenames.add(node.filename.normalize('NFC'));
    }
    devCursor = data.files.pageInfo.hasNextPage ? data.files.pageInfo.endCursor : null;
  } while (devCursor);

  const toUpload = withUrls.filter((n) => !n.filename || !existingDevFilenames.has(n.filename.normalize('NFC')));
  let applied = withUrls.length - toUpload.length;
  if (applied > 0) {
    notes.push(`${applied} file(s) already exist on Dev under a matching filename — skipped re-upload.`);
  }

  // fileCreate accepts up to 250 files per call (confirmed against Shopify's
  // docs) — batched well under that ceiling to keep a single bad file from
  // blocking too large a batch and to keep error attribution reasonably
  // scoped.
  const BATCH_SIZE = 50;
  const bar = createProgressBar(toUpload.length, 'files');
  for (let i = 0; i < toUpload.length; i += BATCH_SIZE) {
    const batch = toUpload.slice(i, i + BATCH_SIZE);
    const result: any = await ctx.dev.mutate(FILE_CREATE, {
      files: batch.map((node) => ({
        alt: node.alt ?? undefined,
        contentType: contentType(node.__typename),
        originalSource: sourceUrl(node),
        filename: node.filename ?? undefined,
      })),
    });
    applied += result.fileCreate.files?.length ?? 0;
    if (result.fileCreate.userErrors?.length) {
      notes.push(`Files batch starting at ${i}: ${JSON.stringify(result.fileCreate.userErrors)}`);
    }
    bar.tick(batch.length);
  }
  bar.done();

  return { resource: 'files', planned: withUrls.length, applied, skipped, noteCount: notes.length };
}
