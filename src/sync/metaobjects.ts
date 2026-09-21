import { SyncContext, SyncResult } from '../types.js';
import { logger, createProgressBar } from '../logger.js';

// Field types whose value holds a GID pointing at another resource, which
// won't exist (or will point at the wrong record) on the dev store. Synced
// scalar-only; these are skipped and logged instead of silently corrupting
// data on dev.
const REFERENCE_FIELD_TYPES = new Set([
  'metaobject_reference',
  'list.metaobject_reference',
  'mixed_reference',
  'list.mixed_reference',
  'product_reference',
  'list.product_reference',
  'variant_reference',
  'list.variant_reference',
  'collection_reference',
  'list.collection_reference',
  'page_reference',
  'list.page_reference',
  'file_reference',
  'list.file_reference',
]);

interface FieldDefinition {
  key: string;
  name: string;
  type: { name: string };
  required: boolean;
}

interface Definition {
  type: string;
  name: string;
  fieldDefinitions: FieldDefinition[];
}

interface FieldValue {
  key: string;
  type: string;
  value: string;
}

interface Entry {
  handle: string;
  type: string;
  fields: FieldValue[];
}

const DEFINITIONS_QUERY = `#graphql
  query MetaobjectDefinitions($cursor: String) {
    metaobjectDefinitions(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        type
        name
        fieldDefinitions {
          key
          name
          required
          type { name }
        }
      }
    }
  }
`;

const DEV_DEFINITIONS_QUERY = `#graphql
  query DevMetaobjectDefinitions($cursor: String) {
    metaobjectDefinitions(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id type }
    }
  }
`;

// NOTE: verify MetaobjectDefinitionCreateInput/UpdateInput shapes via schema
// introspection for the pinned apiVersion before the first live run.
const DEFINITION_CREATE = `#graphql
  mutation MetaobjectDefinitionCreate($definition: MetaobjectDefinitionCreateInput!) {
    metaobjectDefinitionCreate(definition: $definition) {
      metaobjectDefinition { id type }
      userErrors { field message }
    }
  }
`;

const ENTRIES_QUERY = `#graphql
  query MetaobjectEntries($type: String!, $cursor: String) {
    metaobjects(type: $type, first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        handle
        type
        fields { key type value }
      }
    }
  }
`;

// metaobjectUpsert matches by handle+type, so re-running sync is idempotent.
// NOTE: verify MetaobjectUpsertInput's exact shape via schema introspection
// for the pinned apiVersion before the first live run.
const ENTRY_UPSERT = `#graphql
  mutation MetaobjectUpsert($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
      metaobject { id handle }
      userErrors { field message }
    }
  }
`;

export async function syncMetaobjects(ctx: SyncContext): Promise<SyncResult> {
  const notes: string[] = [
    'Reference-type fields (metaobject_reference, product_reference, file_reference, etc.) are skipped — the GIDs they hold on Production do not resolve to the same records on Dev. Only scalar fields sync.',
  ];

  const definitions: Definition[] = [];
  let cursor: string | null = null;
  do {
    const data: any = await ctx.prod.query(DEFINITIONS_QUERY, { cursor });
    definitions.push(...data.metaobjectDefinitions.nodes);
    cursor = data.metaobjectDefinitions.pageInfo.hasNextPage ? data.metaobjectDefinitions.pageInfo.endCursor : null;
  } while (cursor);

  logger.step(`Fetched ${definitions.length} metaobject definitions from ${ctx.config.prodStore}.`);

  const entries: Entry[] = [];
  for (const def of definitions) {
    let entryCursor: string | null = null;
    do {
      const data: any = await ctx.prod.query(ENTRIES_QUERY, { type: def.type, cursor: entryCursor });
      entries.push(...data.metaobjects.nodes);
      entryCursor = data.metaobjects.pageInfo.hasNextPage ? data.metaobjects.pageInfo.endCursor : null;
    } while (entryCursor);
  }

  logger.step(`Fetched ${entries.length} metaobject entries from ${ctx.config.prodStore}.`);

  const planned = definitions.length + entries.length;

  if (!ctx.live) {
    return {
      resource: 'metaobjects',
      planned,
      applied: 0,
      skipped: 0,
      notes: [...notes, `Dry-run: ${definitions.length} definitions and ${entries.length} entries would be upserted.`],
    };
  }

  // Definitions must exist on dev before entries referencing their type can
  // be created. No update path here yet — only missing definitions are
  // created; changes to an existing definition's fields are not synced.
  const existingTypes = new Set<string>();
  let devCursor: string | null = null;
  do {
    const data: any = await ctx.dev.query(DEV_DEFINITIONS_QUERY, { cursor: devCursor });
    for (const d of data.metaobjectDefinitions.nodes) existingTypes.add(d.type);
    devCursor = data.metaobjectDefinitions.pageInfo.hasNextPage ? data.metaobjectDefinitions.pageInfo.endCursor : null;
  } while (devCursor);

  let applied = 0;
  const bar = createProgressBar(planned, 'metaobjects');
  for (const def of definitions) {
    if (existingTypes.has(def.type)) {
      applied += 1;
      bar.tick();
      continue;
    }
    const result: any = await ctx.dev.mutate(DEFINITION_CREATE, {
      definition: {
        type: def.type,
        name: def.name,
        fieldDefinitions: def.fieldDefinitions.map((f) => ({
          key: f.key,
          name: f.name,
          required: f.required,
          type: f.type.name,
        })),
      },
    });
    if (result.metaobjectDefinitionCreate.userErrors?.length) {
      notes.push(`Definition "${def.type}": ${JSON.stringify(result.metaobjectDefinitionCreate.userErrors)}`);
    } else {
      applied += 1;
    }
    bar.tick();
  }

  for (const entry of entries) {
    const scalarFields = entry.fields.filter((f) => !REFERENCE_FIELD_TYPES.has(f.type));
    const skippedFieldCount = entry.fields.length - scalarFields.length;
    if (skippedFieldCount > 0) {
      notes.push(`Entry "${entry.type}/${entry.handle}": skipped ${skippedFieldCount} reference field(s).`);
    }

    const result: any = await ctx.dev.mutate(ENTRY_UPSERT, {
      handle: { type: entry.type, handle: entry.handle },
      metaobject: {
        fields: scalarFields.map((f) => ({ key: f.key, value: f.value })),
      },
    });
    if (result.metaobjectUpsert.userErrors?.length) {
      notes.push(`Entry "${entry.type}/${entry.handle}": ${JSON.stringify(result.metaobjectUpsert.userErrors)}`);
    } else {
      applied += 1;
    }
    bar.tick();
  }
  bar.done();

  return { resource: 'metaobjects', planned, applied, skipped: planned - applied, notes };
}
