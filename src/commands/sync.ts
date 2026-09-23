import prompts from 'prompts';
import { ShopifyClient } from '../client.js';
import { resolveConfig } from '../config.js';
import { assertSafeToWrite } from '../guard.js';
import { assertRequiredScopes } from '../scopes.js';
import { logger } from '../logger.js';
import { SyncContext, SyncResult } from '../types.js';
import { syncProducts } from '../sync/products.js';
import { syncTheme } from '../sync/theme.js';
import { syncMetafields } from '../sync/metafields.js';
import { syncMetaobjects } from '../sync/metaobjects.js';
import { syncContent } from '../sync/content.js';
import { syncDiscounts } from '../sync/discounts.js';
import { syncFiles } from '../sync/files.js';
import { syncMenus } from '../sync/menus.js';
import { syncArticles } from '../sync/articles.js';
import { syncCollections } from '../sync/collections.js';

export interface SyncFlags {
  resources?: string;
  live?: boolean;
  yes?: boolean;
}

const RUNNERS: Record<string, (ctx: SyncContext) => Promise<SyncResult>> = {
  products: syncProducts,
  theme: syncTheme,
  metafields: syncMetafields,
  metaobjects: syncMetaobjects,
  content: syncContent,
  discounts: syncDiscounts,
  files: syncFiles,
  menus: syncMenus,
  articles: syncArticles,
  collections: syncCollections,
};

// Always applied regardless of how the user lists/selects resources —
// menus resolves Product/Collection/Page/Blog references by looking them
// up on Dev by handle, so it must run after the resources that create
// those records there; collections resolves manual membership the same
// way via products. theme is a soft preference (page metafields feed
// dynamic-source sections) rather than a hard dependency. Must contain
// exactly the same keys as RUNNERS.
const RESOURCE_ORDER = [
  'products',
  'collections',
  'content',
  'articles',
  'metafields',
  'metaobjects',
  'discounts',
  'files',
  'theme',
  'menus',
];

const RESOURCE_LABELS: Record<string, string> = {
  products: '📦 Products',
  theme: '🎨 Theme',
  metafields: '🏷️  Metafields',
  metaobjects: '🧩 Metaobjects',
  content: '📄 Pages',
  discounts: '🎟️  Discounts',
  files: '🖼️  Files',
  menus: '🧭 Menus',
  articles: '📰 Articles & Blogs',
  collections: '🗂️  Collections',
};

export async function runSync(flags: SyncFlags): Promise<void> {
  const config = await resolveConfig();
  let resources = flags.resources ? flags.resources.split(',').map((r) => r.trim()) : config.resources;
  const live = flags.live ?? false;
  const yes = flags.yes ?? false;

  const unknown = resources.filter((r) => !RUNNERS[r]);
  if (unknown.length > 0) {
    throw new Error(`Unknown resource(s): ${unknown.join(', ')}. Valid: ${Object.keys(RUNNERS).join(', ')}`);
  }

  resources = RESOURCE_ORDER.filter((r) => resources.includes(r));

  const prod = new ShopifyClient({ store: config.prodStore, token: config.prodToken, role: 'prod' });
  const dev = new ShopifyClient({ store: config.devStore, token: config.devToken, role: 'dev' });

  logger.info(
    `Sync plan: ${resources.join(', ')} | ${config.prodStore} -> ${config.devStore} | mode: ${live ? 'LIVE' : 'DRY-RUN'}`
  );

  if (live) {
    await assertSafeToWrite(dev, config, { yes });

    if (!yes) {
      const { selected } = await prompts({
        type: 'multiselect',
        name: 'selected',
        message: 'Resources to sync',
        instructions: 'space: toggle · a: all · enter: confirm\n',
        choices: resources.map((r) => ({ title: r, value: r, selected: true })),
        min: 1,
      });

      if (!selected || selected.length === 0) {
        throw new Error('No resources selected — aborting. No writes were made.');
      }

      resources = RESOURCE_ORDER.filter((r) => selected.includes(r));
      logger.info(`Syncing: ${resources.join(', ')}`);
    }
  }

  logger.step('\nChecking Admin API scopes for the selected resources...');
  await assertRequiredScopes(prod, dev, resources);
  logger.success('Scope check passed — both tokens have the permissions these resources need.');

  const ctx: SyncContext = { prod, dev, config, live };
  const results: SyncResult[] = [];

  async function runOne(resource: string): Promise<void> {
    const label = RESOURCE_LABELS[resource] ?? resource;
    logger.step(`\n${label}`);
    const result = await RUNNERS[resource](ctx);
    results.push(result);
    const summary = live
      ? `✅ ${label}: ${result.applied} synced${result.skipped > 0 ? `, ${result.skipped} skipped` : ''} (${result.planned} total)`
      : `📝 ${label}: ${result.planned} would sync (dry-run)`;
    logger.info(summary);
    if (result.noteCount > 0) {
      // Each note was already written to syncify.log as it happened (see
      // src/notes.ts) — this is just reporting the count, not re-writing.
      logger.info(`  (${result.noteCount} note(s) written to syncify.log)`);
    }
  }

  for (const resource of resources) {
    await runOne(resource);
  }

  logger.success(
    live ? '\nSync complete.' : '\nDry-run complete — no writes were made. Re-run with --live to apply.'
  );
}
