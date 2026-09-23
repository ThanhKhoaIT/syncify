import { SyncContext, SyncResult } from '../types.js';
import { logger, createProgressBar } from '../logger.js';
import { Notes } from '../notes.js';

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
  value: string | null;
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
  const notes = new Notes('metaobjects');
  notes.push(
    'Reference-type fields (metaobject_reference, product_reference, file_reference, etc.) are dropped from both definitions and entries — the GIDs they hold on Production do not resolve to the same records on Dev, and resolving them across metaobject definitions (e.g. a "panel" type referencing a "layer" type) isn\'t implemented. A definition with only reference fields is skipped entirely; a definition with a mix keeps its scalar fields.'
  );

  const definitions: Definition[] = [];
  let cursor: string | null = null;
  do {
    const data: any = await ctx.prod.query(DEFINITIONS_QUERY, { cursor });
    definitions.push(...data.metaobjectDefinitions.nodes);
    cursor = data.metaobjectDefinitions.pageInfo.hasNextPage ? data.metaobjectDefinitions.pageInfo.endCursor : null;
  } while (cursor);

  logger.step(`Found ${definitions.length} metaobject definitions on ${ctx.config.prodStore}.`);

  const entries: Entry[] = [];
  for (const def of definitions) {
    let entryCursor: string | null = null;
    do {
      const data: any = await ctx.prod.query(ENTRIES_QUERY, { type: def.type, cursor: entryCursor });
      entries.push(...data.metaobjects.nodes);
      entryCursor = data.metaobjects.pageInfo.hasNextPage ? data.metaobjects.pageInfo.endCursor : null;
    } while (entryCursor);
  }

  logger.step(`Found ${entries.length} metaobject entries on ${ctx.config.prodStore}.`);

  const planned = definitions.length + entries.length;

  if (!ctx.live) {
    notes.push(`Dry-run: ${definitions.length} definitions and ${entries.length} entries would be upserted.`);
    return { resource: 'metaobjects', planned, applied: 0, skipped: 0, noteCount: notes.length };
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

    // Reference-type field definitions need a validation pointing at the
    // referenced type's Dev-side definition ID, which requires that type to
    // already exist on Dev — a dependency we don't resolve across
    // definitions. Rather than fail the whole definition (and every entry
    // under it) over one field, drop reference-type fields from the
    // definition itself, same as reference-type field *values* are already
    // dropped at the entry level.
    const scalarFieldDefs = def.fieldDefinitions.filter((f) => !REFERENCE_FIELD_TYPES.has(f.type.name));
    const droppedFieldCount = def.fieldDefinitions.length - scalarFieldDefs.length;

    if (scalarFieldDefs.length === 0) {
      notes.push(`Definition "${def.type}": all ${def.fieldDefinitions.length} field(s) are reference types — skipped entirely, nothing left to define.`);
      bar.tick();
      continue;
    }

    const result: any = await ctx.dev.mutate(DEFINITION_CREATE, {
      definition: {
        type: def.type,
        name: def.name,
        fieldDefinitions: scalarFieldDefs.map((f) => ({
          key: f.key,
          name: f.name,
          required: f.required,
          type: f.type.name,
        })),
      },
    });
    if (result.metaobjectDefinitionCreate.userErrors?.length) {
      notes.push(`Definition "${def.type}": ${JSON.stringify(result.metaobjectDefinitionCreate.userErrors)}`);
      bar.tick();
      continue;
    }

    applied += 1;
    existingTypes.add(def.type);
    if (droppedFieldCount > 0) {
      notes.push(`Definition "${def.type}": dropped ${droppedFieldCount} reference-type field(s) — resolving cross-store references between metaobject definitions isn't implemented.`);
    }
    bar.tick();
  }

  for (const entry of entries) {
    // Fields left empty on this entry come back with value: null — the
    // mutation rejects a null value outright, so drop those along with
    // reference-type fields rather than send them.
    const scalarFields = entry.fields.filter((f) => !REFERENCE_FIELD_TYPES.has(f.type) && f.value !== null);
    const skippedFieldCount = entry.fields.length - scalarFields.length;
    if (skippedFieldCount > 0) {
      notes.push(`Entry "${entry.type}/${entry.handle}": skipped ${skippedFieldCount} reference/empty field(s).`);
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

  return { resource: 'metaobjects', planned, applied, skipped: planned - applied, noteCount: notes.length };
}
