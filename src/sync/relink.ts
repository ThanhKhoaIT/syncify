import { SyncContext, SyncResult } from '../types.js';
import { logger, createProgressBar } from '../logger.js';
import { Notes } from '../notes.js';
import { MetafieldBatcher } from '../metafieldBatcher.js';
import { adminAccessInput } from './metafields.js';

// Fills in everything the other modules drop because it holds a GID that
// only means something on Production: metaobject_reference /
// mixed_reference / file_reference fields on metaobject definitions and
// entries, metafield definitions of those types, and metafield values of
// any reference type on shop/products/collections/pages. Runs after
// "metaobjects" and "files" (see RESOURCE_ORDER) so the records these
// point at already exist on Dev; each Production GID is translated to the
// matching Dev record by a stable key (see ProdNode) instead of copied.

// Field types whose Dev definition was dropped by metaobjects.ts, and
// whose entry values this module sets.
const RELINK_FIELD_TYPES = new Set([
  'metaobject_reference',
  'list.metaobject_reference',
  'mixed_reference',
  'list.mixed_reference',
  'file_reference',
  'list.file_reference',
]);

// Metafield definitions skipped by metafields.ts (file_reference ones were
// already created there — their validations carry no GIDs).
const RELINK_METAFIELD_DEFINITION_TYPES = new Set(['metaobject_reference', 'list.metaobject_reference', 'mixed_reference', 'list.mixed_reference']);

// Every metafield value type that holds GIDs — products.ts/content.ts/
// metafields.ts copy these verbatim, so on Dev they either failed or point
// at Production records. Re-set here with translated IDs.
function isReferenceType(type: string): boolean {
  return type.endsWith('_reference') && !type.includes('product_taxonomy');
}

const OWNER_TYPES = ['PRODUCT', 'PRODUCTVARIANT', 'COLLECTION', 'PAGE', 'ARTICLE', 'BLOG', 'SHOP'];

type ProdNode =
  | { kind: 'metaobject'; type: string; handle: string }
  | { kind: 'product' | 'collection' | 'page'; handle: string }
  | { kind: 'variant'; productHandle: string; sku: string | null }
  | { kind: 'video'; filename: string; url: string | null; alt: string | null }
  | { kind: 'image' | 'file'; basename: string; url: string; alt: string | null };

interface Validation {
  name: string;
  value: string;
}

interface FieldDefinition {
  key: string;
  name: string;
  description: string | null;
  type: { name: string };
  validations: Validation[];
}

interface Entry {
  type: string;
  handle: string;
  fields: { key: string; type: string; value: string }[];
  status: string | null;
}

interface Metafield {
  namespace: string;
  key: string;
  type: string;
  value: string;
}

const PROD_DEFINITIONS_QUERY = `#graphql
  query RelinkProdDefinitions($cursor: String) {
    metaobjectDefinitions(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        type
        displayNameKey
        capabilities { publishable { enabled } }
        fieldDefinitions { key name description type { name } validations { name value } }
      }
    }
  }
`;

const DEV_DEFINITIONS_QUERY = `#graphql
  query RelinkDevDefinitions($cursor: String) {
    metaobjectDefinitions(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id type displayNameKey capabilities { publishable { enabled } } fieldDefinitions { key } }
    }
  }
`;

const DEFINITION_UPDATE = `#graphql
  mutation RelinkDefinitionUpdate($id: ID!, $definition: MetaobjectDefinitionUpdateInput!) {
    metaobjectDefinitionUpdate(id: $id, definition: $definition) {
      metaobjectDefinition { id }
      userErrors { field message }
    }
  }
`;

const PROD_METAFIELD_DEFINITIONS_QUERY = `#graphql
  query RelinkProdMetafieldDefinitions($ownerType: MetafieldOwnerType!, $cursor: String) {
    metafieldDefinitions(ownerType: $ownerType, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        namespace key name description ownerType
        type { name }
        validations { name value }
        access { admin customerAccount storefront }
      }
    }
  }
`;

const DEV_METAFIELD_DEFINITIONS_QUERY = `#graphql
  query RelinkDevMetafieldDefinitions($ownerType: MetafieldOwnerType!, $cursor: String) {
    metafieldDefinitions(ownerType: $ownerType, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { namespace key }
    }
  }
`;

const METAFIELD_DEFINITION_CREATE = `#graphql
  mutation RelinkMetafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id }
      userErrors { field message }
    }
  }
`;

const PROD_ENTRIES_QUERY = `#graphql
  query RelinkProdEntries($type: String!, $cursor: String) {
    metaobjects(type: $type, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { handle fields { key type value } capabilities { publishable { status } } }
    }
  }
`;

const DEV_ENTRIES_QUERY = `#graphql
  query RelinkDevEntries($type: String!, $cursor: String) {
    metaobjects(type: $type, first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id handle }
    }
  }
`;

// Matches by type+handle, so re-running is idempotent.
const ENTRY_UPSERT = `#graphql
  mutation RelinkEntryUpsert($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
      metaobject { id }
      userErrors { field message }
    }
  }
`;

const PROD_NODES_QUERY = `#graphql
  query RelinkProdNodes($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on Metaobject { type handle }
      ... on Product { handle }
      ... on Collection { handle }
      ... on Page { handle }
      ... on ProductVariant { sku product { handle } }
      ... on MediaImage { alt image { url } }
      ... on GenericFile { alt url }
      ... on Video { alt filename originalSource { url } }
    }
  }
`;

const PROD_VIDEOS_QUERY = `#graphql
  query RelinkProdVideos($cursor: String) {
    files(first: 250, after: $cursor, query: "media_type:VIDEO") {
      pageInfo { hasNextPage endCursor }
      nodes { id }
    }
  }
`;

const DEV_FILES_QUERY = `#graphql
  query RelinkDevFiles($cursor: String) {
    files(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        __typename
        id
        ... on MediaImage { image { url } }
        ... on GenericFile { url }
        ... on Video { filename }
      }
    }
  }
`;

const FILE_CREATE = `#graphql
  mutation RelinkFileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files { id }
      userErrors { field message }
    }
  }
`;

const HANDLES_QUERIES = {
  product: `#graphql
    query RelinkDevProducts($cursor: String) {
      items: products(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id handle variants(first: 100) { nodes { id sku } } }
      }
    }
  `,
  collection: `#graphql
    query RelinkDevCollections($cursor: String) {
      items: collections(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id handle }
      }
    }
  `,
  page: `#graphql
    query RelinkDevPages($cursor: String) {
      items: pages(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id handle }
      }
    }
  `,
};

// Owners whose reference-typed metafield values get re-set. Matched to Dev
// by handle; shop has a single owner.
const PROD_OWNER_QUERIES = {
  product: `#graphql
    query RelinkProdProducts($cursor: String) {
      items: products(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { handle metafields(first: 250) { nodes { namespace key type value } } }
      }
    }
  `,
  collection: `#graphql
    query RelinkProdCollections($cursor: String) {
      items: collections(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { handle metafields(first: 250) { nodes { namespace key type value } } }
      }
    }
  `,
  page: `#graphql
    query RelinkProdPages($cursor: String) {
      items: pages(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { handle metafields(first: 250) { nodes { namespace key type value } } }
      }
    }
  `,
};

const PROD_SHOP_METAFIELDS_QUERY = `#graphql
  query RelinkProdShopMetafields($cursor: String) {
    shop {
      metafields(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { namespace key type value }
      }
    }
  }
`;

const DEV_SHOP_ID_QUERY = `#graphql
  query RelinkDevShopId { shop { id } }
`;

async function paginate<T>(fetch: (cursor: string | null) => Promise<any>, pick: (data: any) => { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string } }): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  do {
    const conn = pick(await fetch(cursor));
    out.push(...conn.nodes);
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

function parseIds(type: string, value: string): string[] {
  if (!type.startsWith('list.')) return [value];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// File URLs carry no stable ID across stores; the basename is the closest
// thing. Shopify appends "_<uuid>" when a basename is already taken, so
// that suffix is stripped on both sides before comparing.
// ponytail: basename match, two distinct Production files sharing a basename collapse into one Dev file; key on alt+size if that ever bites.
export function fileBasename(url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  return name.replace(/_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\.[^.]+$)/i, '').normalize('NFC');
}

// Translates Production GIDs to Dev GIDs. Everything is loaded up front
// from the set of GIDs actually referenced, so each Dev collection is
// paged through at most once per run.
class IdTranslator {
  private prodNodes = new Map<string, ProdNode>();
  private devMetaobjects = new Map<string, string>(); // "type::handle" -> id
  private devHandles = { product: new Map<string, string>(), collection: new Map<string, string>(), page: new Map<string, string>() };
  private devVariants = new Map<string, string>(); // "productHandle::sku" -> id
  private devFiles = new Map<string, string>(); // "video::filename" | "file::basename" -> id
  devDefinitions = new Map<string, string>(); // type -> id
  prodDefinitionTypes = new Map<string, string>(); // prod definition id -> type

  constructor(private readonly ctx: SyncContext, private readonly notes: Notes) {}

  async load(gids: Set<string>): Promise<void> {
    const list = [...gids].filter((g) => !this.prodNodes.has(g));
    for (let i = 0; i < list.length; i += 250) {
      const chunk = list.slice(i, i + 250);
      const data: any = await this.ctx.prod.query(PROD_NODES_QUERY, { ids: chunk });
      chunk.forEach((gid, idx) => {
        const n = data.nodes[idx];
        const node = n && toProdNode(n);
        if (node) this.prodNodes.set(gid, node);
      });
    }

    const kinds = new Set([...this.prodNodes.values()].map((n) => n.kind));
    const metaobjectTypes = new Set([...this.prodNodes.values()].flatMap((n) => (n.kind === 'metaobject' ? [n.type] : [])));
    for (const type of metaobjectTypes) {
      if ([...this.devMetaobjects.keys()].some((k) => k.startsWith(`${type}::`))) continue;
      const nodes = await paginate<{ id: string; handle: string }>(
        (cursor) => this.ctx.dev.query(DEV_ENTRIES_QUERY, { type, cursor }),
        (d) => d.metaobjects
      );
      for (const n of nodes) this.devMetaobjects.set(`${type}::${n.handle}`, n.id);
    }

    for (const kind of ['product', 'collection', 'page'] as const) {
      const needed = kind === 'product' ? kinds.has('product') || kinds.has('variant') : kinds.has(kind);
      if (!needed || this.devHandles[kind].size > 0) continue;
      const nodes = await paginate<any>((cursor) => this.ctx.dev.query(HANDLES_QUERIES[kind], { cursor }), (d) => d.items);
      for (const n of nodes) {
        const handle = n.handle.normalize('NFC');
        this.devHandles[kind].set(handle, n.id);
        for (const v of n.variants?.nodes ?? []) if (v.sku) this.devVariants.set(`${handle}::${v.sku}`, v.id);
      }
    }

    if (kinds.has('video') || kinds.has('image') || kinds.has('file')) await this.ensureFiles();
  }

  // Files referenced by a field but absent on Dev are uploaded here from
  // Production's CDN URL, so relink doesn't depend on the "files" resource
  // having run (and doesn't re-duplicate everything the way it would).
  private async ensureFiles(): Promise<void> {
    if (this.devFiles.size === 0) {
      const nodes = await paginate<any>((cursor) => this.ctx.dev.query(DEV_FILES_QUERY, { cursor }), (d) => d.files);
      for (const n of nodes) {
        if (n.__typename === 'Video' && n.filename) this.devFiles.set(`video::${n.filename.normalize('NFC')}`, n.id);
        const url = n.image?.url ?? n.url;
        if (url) this.devFiles.set(`file::${fileBasename(url)}`, n.id);
      }
    }

    const missing = new Map<string, ProdNode>();
    for (const node of this.prodNodes.values()) {
      const key = fileKey(node);
      if (key && !this.devFiles.has(key) && !missing.has(key)) missing.set(key, node);
    }
    const uploads = [...missing.entries()].filter(([, n]) => (n.kind === 'video' ? n.url : (n as any).url));
    if (uploads.length < missing.size) {
      this.notes.push(`${missing.size - uploads.length} referenced file(s) have no source URL on Production yet (still processing) — their references stay unresolved.`);
    }

    // fileCreate rejects a video's external URL ("Invalid video url") —
    // videos must go through a staged upload first. One bad file fails its
    // whole fileCreate batch, so videos are also created one at a time.
    let uploaded = 0;
    for (const [key, n] of uploads.filter(([, n]) => n.kind === 'video')) {
      const video = n as Extract<ProdNode, { kind: 'video' }>;
      try {
        const resourceUrl = await stagedUpload(this.ctx, video.url!, video.filename);
        const result: any = await this.ctx.dev.mutate(FILE_CREATE, {
          files: [{ originalSource: resourceUrl, alt: video.alt ?? undefined, contentType: 'VIDEO', filename: video.filename }],
        });
        if (result.fileCreate.userErrors?.length) {
          this.notes.push(`Video "${video.filename}": ${JSON.stringify(result.fileCreate.userErrors)}`);
          continue;
        }
        this.devFiles.set(key, result.fileCreate.files[0].id);
        uploaded += 1;
      } catch (err) {
        this.notes.push(`Video "${video.filename}": upload failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const others = uploads.filter(([, n]) => n.kind !== 'video');
    for (let i = 0; i < others.length; i += 50) {
      const batch = others.slice(i, i + 50);
      const result: any = await this.ctx.dev.mutate(FILE_CREATE, {
        files: batch.map(([, n]) => ({
          originalSource: (n as any).url,
          alt: (n as any).alt ?? undefined,
          contentType: n.kind === 'image' ? 'IMAGE' : 'FILE',
        })),
      });
      if (result.fileCreate.userErrors?.length) {
        this.notes.push(`File upload batch starting at ${i}: ${JSON.stringify(result.fileCreate.userErrors)}`);
        continue;
      }
      // fileCreate returns files in input order.
      (result.fileCreate.files as { id: string }[]).forEach((f, idx) => this.devFiles.set(batch[idx][0], f.id));
      uploaded += batch.length;
    }
    if (uploads.length > 0) this.notes.push(`Uploaded ${uploaded} of ${uploads.length} file(s) missing on Dev.`);
  }

  nodeOf(gid: string): ProdNode | undefined {
    return this.prodNodes.get(gid);
  }

  registerMetaobject(type: string, handle: string, id: string): void {
    this.devMetaobjects.set(`${type}::${handle}`, id);
  }

  resolve(gid: string): string | null {
    const node = this.prodNodes.get(gid);
    if (!node) return null;
    switch (node.kind) {
      case 'metaobject':
        return this.devMetaobjects.get(`${node.type}::${node.handle}`) ?? null;
      case 'product':
      case 'collection':
      case 'page':
        return this.devHandles[node.kind].get(node.handle.normalize('NFC')) ?? null;
      case 'variant':
        return node.sku ? this.devVariants.get(`${node.productHandle.normalize('NFC')}::${node.sku}`) ?? null : null;
      default:
        return this.devFiles.get(fileKey(node)!) ?? null;
    }
  }

  // Returns the translated value, or null when nothing in it resolved.
  translate(type: string, value: string): { value: string | null; unresolved: number } {
    const ids = parseIds(type, value);
    const resolved = ids.map((g) => this.resolve(g)).filter((g): g is string => g !== null);
    const unresolved = ids.length - resolved.length;
    if (resolved.length === 0) return { value: null, unresolved };
    return { value: type.startsWith('list.') ? JSON.stringify(resolved) : resolved[0], unresolved };
  }

  // metaobject_definition_id(s) validations name Production definition IDs.
  translateValidations(validations: Validation[]): Validation[] | null {
    const out: Validation[] = [];
    for (const v of validations) {
      if (v.name === 'metaobject_definition_id') {
        const id = this.devDefinitions.get(this.prodDefinitionTypes.get(v.value) ?? '');
        if (!id) return null;
        out.push({ name: v.name, value: id });
      } else if (v.name === 'metaobject_definition_ids') {
        const ids = (JSON.parse(v.value) as string[]).map((p) => this.devDefinitions.get(this.prodDefinitionTypes.get(p) ?? ''));
        if (ids.some((id) => !id)) return null;
        out.push({ name: v.name, value: JSON.stringify(ids) });
      } else {
        out.push(v);
      }
    }
    return out;
  }
}

const STAGED_UPLOADS_CREATE = `#graphql
  mutation RelinkStagedUploads($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }
`;

const VIDEO_MIME: Record<string, string> = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v' };

// Downloads a Production file and stages it on Dev; returns the
// resourceUrl fileCreate accepts as originalSource.
// ponytail: whole video buffered in memory, stream it if videos grow past a few hundred MB.
async function stagedUpload(ctx: SyncContext, sourceUrl: string, filename: string): Promise<string> {
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`download ${res.status} ${res.statusText}`);
  const body = await res.blob();
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const mimeType = VIDEO_MIME[ext] ?? (body.type || 'video/mp4');

  const staged: any = await ctx.dev.mutate(STAGED_UPLOADS_CREATE, {
    input: [{ resource: 'VIDEO', filename, mimeType, fileSize: String(body.size), httpMethod: 'POST' }],
  });
  if (staged.stagedUploadsCreate.userErrors?.length) throw new Error(JSON.stringify(staged.stagedUploadsCreate.userErrors));
  const target = staged.stagedUploadsCreate.stagedTargets[0];

  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append('file', body, filename);
  const upload = await fetch(target.url, { method: 'POST', body: form });
  if (!upload.ok) throw new Error(`staged upload ${upload.status} ${upload.statusText}`);
  return target.resourceUrl;
}

function toProdNode(n: any): ProdNode | null {
  switch (n.__typename) {
    case 'Metaobject':
      return { kind: 'metaobject', type: n.type, handle: n.handle };
    case 'Product':
      return { kind: 'product', handle: n.handle };
    case 'Collection':
      return { kind: 'collection', handle: n.handle };
    case 'Page':
      return { kind: 'page', handle: n.handle };
    case 'ProductVariant':
      return { kind: 'variant', productHandle: n.product.handle, sku: n.sku };
    case 'Video':
      return { kind: 'video', filename: n.filename, url: n.originalSource?.url ?? null, alt: n.alt };
    case 'MediaImage':
      return n.image?.url ? { kind: 'image', basename: fileBasename(n.image.url), url: n.image.url, alt: n.alt } : null;
    case 'GenericFile':
      return n.url ? { kind: 'file', basename: fileBasename(n.url), url: n.url, alt: n.alt } : null;
    default:
      return null;
  }
}

function fileKey(node: ProdNode): string | null {
  if (node.kind === 'video') return `video::${node.filename.normalize('NFC')}`;
  if (node.kind === 'image' || node.kind === 'file') return `file::${node.basename}`;
  return null;
}

export async function syncRelink(ctx: SyncContext): Promise<SyncResult> {
  const notes = new Notes('relink');
  notes.push(
    'Re-links cross-store references: adds metaobject_reference/mixed_reference/file_reference fields to existing Dev metaobject definitions (as optional fields — a required field can\'t be added to a definition that already has entries), enables the publishable capability and display-name field entries depend on, creates the metaobject/mixed reference metafield definitions metafields.ts skips, upserts every metaobject entry whole (in dependency order, so an entry is created after the entries it references), and sets reference metafield values with Production GIDs translated to Dev (metaobjects by type+handle, products/collections/pages by handle, variants by handle+SKU, videos by filename, other files by URL basename). Referenced files missing on Dev are uploaded from Production\'s CDN.'
  );

  const translator = new IdTranslator(ctx, notes);

  const prodDefs = await paginate<{ id: string; type: string; displayNameKey: string | null; capabilities: { publishable: { enabled: boolean } }; fieldDefinitions: FieldDefinition[] }>(
    (cursor) => ctx.prod.query(PROD_DEFINITIONS_QUERY, { cursor }),
    (d) => d.metaobjectDefinitions
  );
  for (const d of prodDefs) translator.prodDefinitionTypes.set(d.id, d.type);

  const relinkDefs = prodDefs.filter((d) => d.fieldDefinitions.some((f) => RELINK_FIELD_TYPES.has(f.type.name)));

  const prodMetafieldDefs: any[] = [];
  for (const ownerType of OWNER_TYPES) {
    const nodes = await paginate<any>((cursor) => ctx.prod.query(PROD_METAFIELD_DEFINITIONS_QUERY, { ownerType, cursor }), (d) => d.metafieldDefinitions);
    prodMetafieldDefs.push(...nodes.filter((d) => RELINK_METAFIELD_DEFINITION_TYPES.has(d.type.name)));
  }

  // Every entry, with every field: metaobjects.ts can't create an entry
  // whose definition requires a reference field it drops, so entries are
  // (re)upserted here whole, with references translated.
  const entries: Entry[] = [];
  for (const def of prodDefs) {
    const nodes = await paginate<any>((cursor) => ctx.prod.query(PROD_ENTRIES_QUERY, { type: def.type, cursor }), (d) => d.metaobjects);
    for (const e of nodes) {
      entries.push({
        type: def.type,
        handle: e.handle,
        fields: e.fields.filter((f: any) => f.value !== null),
        status: e.capabilities?.publishable?.status ?? null,
      });
    }
  }

  // Metafield values of any reference type, per owner.
  const ownerValues: { kind: 'shop' | 'product' | 'collection' | 'page'; handle: string; metafields: Metafield[] }[] = [];
  const shopMetafields = await paginate<Metafield>((cursor) => ctx.prod.query(PROD_SHOP_METAFIELDS_QUERY, { cursor }), (d) => d.shop.metafields);
  ownerValues.push({ kind: 'shop', handle: 'shop', metafields: shopMetafields.filter((m) => isReferenceType(m.type)) });
  for (const kind of ['product', 'collection', 'page'] as const) {
    const owners = await paginate<any>((cursor) => ctx.prod.query(PROD_OWNER_QUERIES[kind], { cursor }), (d) => d.items);
    for (const o of owners) {
      const metafields = (o.metafields.nodes as Metafield[]).filter((m) => isReferenceType(m.type));
      if (metafields.length > 0) ownerValues.push({ kind, handle: o.handle, metafields });
    }
  }
  const metafieldCount = ownerValues.reduce((n, o) => n + o.metafields.length, 0);

  const missingFieldCount = relinkDefs.reduce((n, d) => n + d.fieldDefinitions.filter((f) => RELINK_FIELD_TYPES.has(f.type.name)).length, 0);
  logger.step(
    `Found ${missingFieldCount} reference field definition(s) across ${relinkDefs.length} metaobject definitions, ${prodMetafieldDefs.length} metaobject-reference metafield definitions, ${entries.length} entries and ${metafieldCount} metafield values to re-link.`
  );

  const planned = prodDefs.length + prodMetafieldDefs.length + entries.length + metafieldCount;
  if (!ctx.live) {
    notes.push(`Dry-run: ${planned} item(s) would be re-linked.`);
    return { resource: 'relink', planned, applied: 0, skipped: 0, noteCount: notes.length };
  }

  const devDefs = await paginate<{ id: string; type: string; displayNameKey: string | null; capabilities: { publishable: { enabled: boolean } }; fieldDefinitions: { key: string }[] }>(
    (cursor) => ctx.dev.query(DEV_DEFINITIONS_QUERY, { cursor }),
    (d) => d.metaobjectDefinitions
  );
  for (const d of devDefs) translator.devDefinitions.set(d.type, d.id);
  const devDefByType = new Map(devDefs.map((d) => [d.type, d]));
  const devFieldKeys = new Map(devDefs.map((d) => [d.type, new Set(d.fieldDefinitions.map((f) => f.key))]));
  const devPublishable = new Set(devDefs.filter((d) => d.capabilities.publishable.enabled).map((d) => d.type));

  let applied = 0;
  const bar = createProgressBar(planned, 'relink');

  // 1. Metaobject definitions: missing reference fields, plus the
  // publishable capability and display-name field, which entries depend on
  // (an entry sent with a status is rejected if publishable is off; one
  // whose display-name field is empty is rejected outright).
  for (const def of prodDefs) {
    const devDef = devDefByType.get(def.type);
    if (!devDef) {
      notes.push(`Definition "${def.type}": not on Dev — run the "metaobjects" resource first.`);
      bar.tick();
      continue;
    }
    const existing = devFieldKeys.get(def.type)!;
    const creates = [];
    for (const f of def.fieldDefinitions) {
      if (existing.has(f.key)) continue;
      const validations = translator.translateValidations(f.validations);
      if (!validations) {
        notes.push(`Definition "${def.type}" field "${f.key}": target metaobject definition not on Dev — skipped.`);
        continue;
      }
      creates.push({ create: { key: f.key, name: f.name, description: f.description ?? undefined, type: f.type.name, required: false, validations } });
    }
    const update: any = {};
    if (creates.length > 0) update.fieldDefinitions = creates;
    if (def.capabilities.publishable.enabled && !devPublishable.has(def.type)) update.capabilities = { publishable: { enabled: true } };
    const keysAfter = new Set([...existing, ...creates.map((c) => c.create.key)]);
    if (def.displayNameKey && def.displayNameKey !== devDef.displayNameKey && keysAfter.has(def.displayNameKey)) update.displayNameKey = def.displayNameKey;

    if (Object.keys(update).length > 0) {
      const result: any = await ctx.dev.mutate(DEFINITION_UPDATE, { id: devDef.id, definition: update });
      if (result.metaobjectDefinitionUpdate.userErrors?.length) {
        notes.push(`Definition "${def.type}": ${JSON.stringify(result.metaobjectDefinitionUpdate.userErrors)}`);
        bar.tick();
        continue;
      }
      for (const c of creates) existing.add(c.create.key);
      if (update.capabilities) devPublishable.add(def.type);
    }
    applied += 1;
    bar.tick();
  }

  // 2. Metaobject/mixed reference metafield definitions.
  const devMetafieldKeys = new Set<string>();
  for (const ownerType of OWNER_TYPES) {
    const nodes = await paginate<any>((cursor) => ctx.dev.query(DEV_METAFIELD_DEFINITIONS_QUERY, { ownerType, cursor }), (d) => d.metafieldDefinitions);
    for (const d of nodes) devMetafieldKeys.add(`${ownerType}::${d.namespace}::${d.key}`);
  }
  for (const def of prodMetafieldDefs) {
    const label = `${def.ownerType}/${def.namespace}.${def.key}`;
    if (devMetafieldKeys.has(`${def.ownerType}::${def.namespace}::${def.key}`)) {
      applied += 1;
      bar.tick();
      continue;
    }
    const validations = translator.translateValidations(def.validations);
    if (!validations) {
      notes.push(`Metafield definition "${label}": target metaobject definition not on Dev — skipped.`);
      bar.tick();
      continue;
    }
    // Same ACCESS_DENIED-throws-not-userErrors case as metafields.ts.
    try {
      const result: any = await ctx.dev.mutate(METAFIELD_DEFINITION_CREATE, {
        definition: {
          namespace: def.namespace,
          key: def.key,
          name: def.name,
          description: def.description ?? undefined,
          type: def.type.name,
          ownerType: def.ownerType,
          validations,
          access: { admin: adminAccessInput(def.access.admin), customerAccount: def.access.customerAccount, storefront: def.access.storefront ?? undefined },
        },
      });
      if (result.metafieldDefinitionCreate.userErrors?.length) {
        notes.push(`Metafield definition "${label}": ${JSON.stringify(result.metafieldDefinitionCreate.userErrors)}`);
      } else {
        applied += 1;
      }
    } catch (err) {
      notes.push(`Metafield definition "${label}": failed — ${err instanceof Error ? err.message : String(err)}`);
    }
    bar.tick();
  }

  // Load every GID referenced by an entry or metafield value in one go.
  const gids = new Set<string>();
  for (const e of entries) for (const f of e.fields) if (isReferenceType(f.type)) for (const g of parseIds(f.type, f.value)) gids.add(g);
  for (const o of ownerValues) for (const m of o.metafields) for (const g of parseIds(m.type, m.value)) gids.add(g);
  // Theme settings reference videos by filename (shopify://files/videos/…),
  // not through any field, so every Production video is carried over.
  const prodVideos = await paginate<{ id: string }>((cursor) => ctx.prod.query(PROD_VIDEOS_QUERY, { cursor }), (d) => d.files);
  for (const v of prodVideos) gids.add(v.id);
  await translator.load(gids);

  // 3. Entries, in dependency order: an entry referencing another entry
  // that isn't on Dev yet waits for a later pass. When a pass makes no
  // progress (a reference cycle, or a target that will never exist), the
  // rest go anyway with those references dropped — re-running relink then
  // fills a cycle in, since both sides exist by then.
  const entryKey = (type: string, handle: string) => `${type}::${handle}`;
  let pending = entries;
  let forced = false;
  while (pending.length > 0) {
    const waiting = new Set(pending.map((e) => entryKey(e.type, e.handle)));
    const next: Entry[] = [];
    let progress = 0;
    for (const e of pending) {
      const self = entryKey(e.type, e.handle);
      const blocked =
        !forced &&
        e.fields.some(
          (f) =>
            isReferenceType(f.type) &&
            parseIds(f.type, f.value).some((g) => {
              const n = translator.nodeOf(g);
              return n?.kind === 'metaobject' && translator.resolve(g) === null && entryKey(n.type, n.handle) !== self && waiting.has(entryKey(n.type, n.handle));
            })
        );
      if (blocked) {
        next.push(e);
        continue;
      }

      const devKeys = devFieldKeys.get(e.type);
      if (!devKeys) {
        notes.push(`Entry "${e.type}/${e.handle}": definition not on Dev — skipped.`);
        bar.tick();
        continue;
      }
      let unresolved = 0;
      const missingKeys: string[] = [];
      const fields: { key: string; value: string }[] = [];
      for (const f of e.fields) {
        if (!devKeys.has(f.key)) {
          missingKeys.push(f.key);
          continue;
        }
        if (!isReferenceType(f.type)) {
          fields.push({ key: f.key, value: f.value });
          continue;
        }
        const t = translator.translate(f.type, f.value);
        unresolved += t.unresolved;
        if (t.value !== null) fields.push({ key: f.key, value: t.value });
      }
      if (missingKeys.length > 0) notes.push(`Entry "${e.type}/${e.handle}": field(s) ${missingKeys.join(', ')} not on the Dev definition — dropped.`);
      if (unresolved > 0) notes.push(`Entry "${e.type}/${e.handle}": ${unresolved} reference(s) had no Dev counterpart — dropped.`);

      const metaobject: any = { fields };
      if (e.status && devPublishable.has(e.type)) metaobject.capabilities = { publishable: { status: e.status } };
      const result: any = await ctx.dev.mutate(ENTRY_UPSERT, { handle: { type: e.type, handle: e.handle }, metaobject });
      if (result.metaobjectUpsert.userErrors?.length) {
        notes.push(`Entry "${e.type}/${e.handle}": ${JSON.stringify(result.metaobjectUpsert.userErrors)}`);
      } else {
        translator.registerMetaobject(e.type, e.handle, result.metaobjectUpsert.metaobject.id);
        applied += 1;
        progress += 1;
      }
      bar.tick();
    }
    if (next.length > 0 && progress === 0) {
      notes.push(`${next.length} entr(ies) wait on each other (reference cycle or missing target) — upserting them with those references dropped; re-run relink to fill cycles in.`);
      forced = true;
    }
    pending = next;
  }

  // 4. Reference-typed metafield values on shop/products/collections/pages.
  const devShop: any = await ctx.dev.query(DEV_SHOP_ID_QUERY);
  const ownerMaps = { product: new Map<string, string>(), collection: new Map<string, string>(), page: new Map<string, string>() };
  for (const kind of ['product', 'collection', 'page'] as const) {
    if (!ownerValues.some((o) => o.kind === kind)) continue;
    const nodes = await paginate<any>((cursor) => ctx.dev.query(HANDLES_QUERIES[kind], { cursor }), (d) => d.items);
    for (const n of nodes) ownerMaps[kind].set(n.handle.normalize('NFC'), n.id);
  }
  const batcher = new MetafieldBatcher(ctx.dev, notes);
  for (const o of ownerValues) {
    const ownerId = o.kind === 'shop' ? devShop.shop.id : ownerMaps[o.kind].get(o.handle.normalize('NFC'));
    if (!ownerId) {
      notes.push(`${o.kind} "${o.handle}": not on Dev — ${o.metafields.length} reference metafield(s) skipped.`);
      bar.tick(o.metafields.length);
      continue;
    }
    const fields: Metafield[] = [];
    for (const m of o.metafields) {
      const t = translator.translate(m.type, m.value);
      if (t.unresolved > 0) notes.push(`Metafield "${m.namespace}.${m.key}" on ${o.kind} "${o.handle}": ${t.unresolved} reference(s) had no Dev counterpart — dropped.`);
      if (t.value !== null) fields.push({ ...m, value: t.value });
    }
    batcher.add(ownerId, `${o.kind} ${o.handle}`, fields);
    await batcher.flushIfFull();
    applied += fields.length;
    bar.tick(o.metafields.length);
  }
  await batcher.flushAll();
  bar.done();

  return { resource: 'relink', planned, applied, skipped: planned - applied, noteCount: notes.length };
}
