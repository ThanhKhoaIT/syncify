import { SyncContext, SyncResult } from '../types.js';
import { logger, createProgressBar } from '../logger.js';

interface FileNode {
  __typename: string;
  alt: string | null;
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
        ... on GenericFile { alt url }
        ... on MediaImage { alt image { url } }
        ... on Video { alt sources { url } }
        ... on Model3d { alt sources { url } }
      }
    }
  }
`;

// NOTE: verify FileCreateInput's exact shape via schema introspection for the
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
  const notes: string[] = [
    'Files have no stable handle to match on, so this sync is NOT idempotent — re-running will create duplicate files on Dev.',
  ];

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
    return { resource: 'files', planned: withUrls.length, applied: 0, skipped, notes };
  }

  let applied = 0;
  const bar = createProgressBar(withUrls.length, 'files');
  for (const node of withUrls) {
    const result: any = await ctx.dev.mutate(FILE_CREATE, {
      files: [{ alt: node.alt ?? undefined, contentType: contentType(node.__typename), originalSource: sourceUrl(node) }],
    });
    if (result.fileCreate.userErrors?.length) {
      notes.push(`File "${sourceUrl(node)}": ${JSON.stringify(result.fileCreate.userErrors)}`);
    } else {
      applied += 1;
    }
    bar.tick();
  }
  bar.done();

  return { resource: 'files', planned: withUrls.length, applied, skipped, notes };
}
