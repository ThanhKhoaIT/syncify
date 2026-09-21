import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import 'dotenv/config';

export interface GuardConfig {
  allowedDestinations: string[];
  allowedDevPlanNames: string[];
}

export interface SyncifyRc {
  from: { store: string };
  to: { store: string };
  resources: string[];
  themeSync: 'cli' | 'api';
  guard: GuardConfig;
}

export interface ResolvedConfig extends SyncifyRc {
  prodStore: string;
  prodToken: string;
  devStore: string;
  devToken: string;
}

const RC_PATH = resolve(process.cwd(), '.syncifyrc.json');

export function rcExists(): boolean {
  return existsSync(RC_PATH);
}

export function loadRc(): SyncifyRc {
  if (!rcExists()) {
    throw new Error(`No .syncifyrc.json found in ${process.cwd()}. Run "syncify init" first.`);
  }
  return JSON.parse(readFileSync(RC_PATH, 'utf-8')) as SyncifyRc;
}

export function saveRc(rc: SyncifyRc): void {
  writeFileSync(RC_PATH, JSON.stringify(rc, null, 2) + '\n', 'utf-8');
}

interface EnvTokens {
  prodToken: string;
  devToken: string;
}

function loadEnvTokens(): EnvTokens {
  const prodToken = process.env.SHOPIFY_PROD_TOKEN;
  const devToken = process.env.SHOPIFY_DEV_TOKEN;

  const missing = (
    [
      ['SHOPIFY_PROD_TOKEN', prodToken],
      ['SHOPIFY_DEV_TOKEN', devToken],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}. Copy .env.example to .env and fill in values.`);
  }

  // Guard layer: distinct tokens are the last line of defense if everything
  // else (dotfile, flags) somehow points both roles at the same store.
  if (prodToken === devToken) {
    throw new Error('SHOPIFY_PROD_TOKEN and SHOPIFY_DEV_TOKEN must not be identical — refusing to run.');
  }

  return { prodToken: prodToken!, devToken: devToken! };
}

export function resolveConfig(): ResolvedConfig {
  const rc = loadRc();
  const env = loadEnvTokens();

  if (rc.from.store === rc.to.store) {
    throw new Error('.syncifyrc.json: "from.store" and "to.store" must not be the same store.');
  }
  if (!rc.guard.allowedDestinations.includes(rc.to.store)) {
    throw new Error(`"to.store" (${rc.to.store}) is not in guard.allowedDestinations. Refusing to run.`);
  }

  return {
    ...rc,
    prodStore: rc.from.store,
    prodToken: env.prodToken,
    devStore: rc.to.store,
    devToken: env.devToken,
  };
}
