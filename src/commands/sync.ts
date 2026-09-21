import prompts from 'prompts';
import { ShopifyClient } from '../client.js';
import { resolveConfig } from '../config.js';
import { assertSafeToWrite } from '../guard.js';
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
};

export async function runSync(flags: SyncFlags): Promise<void> {
  const config = resolveConfig();
  let resources = flags.resources ? flags.resources.split(',').map((r) => r.trim()) : config.resources;
  const live = flags.live ?? false;
  const yes = flags.yes ?? false;

  const unknown = resources.filter((r) => !RUNNERS[r]);
  if (unknown.length > 0) {
    throw new Error(`Unknown resource(s): ${unknown.join(', ')}. Valid: ${Object.keys(RUNNERS).join(', ')}`);
  }

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

      resources = selected;
      logger.info(`Syncing: ${resources.join(', ')}`);
    }
  }

  const ctx: SyncContext = { prod, dev, config, live };
  const results: SyncResult[] = [];

  for (const resource of resources) {
    logger.step(`\n=== ${resource} ===`);
    const result = await RUNNERS[resource](ctx);
    results.push(result);
    logger.info(`${resource}: planned=${result.planned} applied=${result.applied} skipped=${result.skipped}`);
    if (result.notes.length > 0) {
      result.notes.forEach((n) => logger.file(`${resource}: ${n}`));
      logger.info(`  (${result.notes.length} note(s) written to syncify.log)`);
    }
  }

  logger.success(
    live ? '\nSync complete.' : '\nDry-run complete — no writes were made. Re-run with --live to apply.'
  );
}
