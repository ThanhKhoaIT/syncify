#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { runInit } from './commands/init.js';
import { runConfigGet, runConfigList, runConfigSet } from './commands/config.js';
import { runSync } from './commands/sync.js';
import { logger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8')) as { version: string };

const program = new Command();

program
  .name('syncify')
  .description('Sync a Shopify Production store to a Dev store, with strict destination guards.')
  .version(pkg.version);

program
  .command('init')
  .description('Create .syncifyrc.json and scaffold .env for this project')
  .option('--from <domain>', 'Production store domain')
  .option('--to <domain>', 'Dev store domain')
  .option(
    '--resources <list>',
    'Comma-separated resources (products,theme,metafields,metaobjects,content,discounts,files,menus)'
  )
  .action(async (opts) => {
    await runInit(opts);
  });

const config = program.command('config').description('Read/write .syncifyrc.json');

config
  .command('list')
  .description('Print current config')
  .action(() => runConfigList());

config
  .command('get <key>')
  .description('Get a config value (dot path, e.g. resources)')
  .action((key: string) => runConfigGet(key));

config
  .command('set <key> <value>')
  .description('Set a config value (dot path; comma-separate list values)')
  .action((key: string, value: string) => runConfigSet(key, value));

program
  .command('sync')
  .description('Sync configured resources from Production to Dev (dry-run unless --live)')
  .option('--resources <list>', 'Comma-separated resources to sync (overrides .syncifyrc.json)')
  .option('--live', 'Actually write changes (default is dry-run)')
  .option('--yes', 'Skip the interactive confirmation prompt (the destination plan-check guard still always runs)')
  .action(async (opts) => {
    await runSync(opts);
  });

program.parseAsync(process.argv).catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
