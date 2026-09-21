import { existsSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import prompts from 'prompts';
import { rcExists, saveRc, SyncifyRc } from '../config.js';
import { logger } from '../logger.js';

export interface InitFlags {
  from?: string;
  to?: string;
  resources?: string;
}

const ALL_RESOURCES = ['products', 'theme', 'metafields', 'metaobjects', 'content', 'discounts', 'files'];

export async function runInit(flags: InitFlags): Promise<void> {
  if (rcExists()) {
    const { overwrite } = await prompts({
      type: 'confirm',
      name: 'overwrite',
      message: '.syncifyrc.json already exists. Overwrite?',
      initial: false,
    });
    if (!overwrite) {
      logger.warn('Aborted — existing .syncifyrc.json left untouched.');
      return;
    }
  }

  let from = flags.from;
  let to = flags.to;
  let resources = flags.resources?.split(',').map((r) => r.trim());

  if (!from || !to || !resources || resources.length === 0) {
    const answers = await prompts([
      {
        type: from ? null : 'text',
        name: 'from',
        message: 'Production store domain (e.g. my-shop.myshopify.com):',
        validate: (v: string) => (v.endsWith('.myshopify.com') ? true : 'Must end with .myshopify.com'),
      },
      {
        type: to ? null : 'text',
        name: 'to',
        message: 'Dev store domain (e.g. my-shop-dev.myshopify.com):',
        validate: (v: string) => (v.endsWith('.myshopify.com') ? true : 'Must end with .myshopify.com'),
      },
      {
        type: resources ? null : 'multiselect',
        name: 'resources',
        message: 'Resources to sync by default:',
        choices: ALL_RESOURCES.map((r) => ({ title: r, value: r, selected: true })),
      },
    ]);

    from = from ?? answers.from;
    to = to ?? answers.to;
    resources = resources ?? answers.resources;
  }

  if (!from || !to || !resources || resources.length === 0) {
    logger.error('Init cancelled — missing required answers.');
    return;
  }

  if (from === to) {
    throw new Error('Production and Dev store domains must not be the same.');
  }

  const rc: SyncifyRc = {
    from: { store: from },
    to: { store: to },
    resources,
    themeSync: 'cli',
    guard: {
      allowedDestinations: [to],
      allowedDevPlanNames: ['Developer Preview', 'Basic App Development', 'Partner test store', 'Development', 'Trial'],
    },
  };

  saveRc(rc);
  logger.success(`Wrote .syncifyrc.json (from: ${from} -> to: ${to}, resources: ${resources.join(', ')})`);

  const envPath = resolve(process.cwd(), '.env');
  const envExamplePath = resolve(process.cwd(), '.env.example');
  if (!existsSync(envPath) && existsSync(envExamplePath)) {
    copyFileSync(envExamplePath, envPath);
    logger.warn('Created .env from .env.example — fill in SHOPIFY_*_TOKEN values before running "syncify sync".');
  }

  logger.info('Next: edit .env with your Admin API tokens, then run "syncify sync" (dry-run by default).');
}
