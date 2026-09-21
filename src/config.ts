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
  // Prepended to every product title when writing to Dev, so synced
  // products are unmistakable from real Dev-created ones at a glance. Set
  // to "" to disable.
  productTitlePrefix: string;
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

type Role = 'PROD' | 'DEV';

// Shopify stopped allowing new legacy custom apps (static, permanent Admin
// API tokens) as of 2026-01-01. Existing legacy apps keep working — hence
// SHOPIFY_*_TOKEN is still supported directly — but a new app created via
// the Dev Dashboard only gives a Client ID + secret, which must be
// exchanged for a short-lived (24h) token via the client credentials grant.
// See README.md "Getting the Production/Dev token" for both paths.
async function exchangeClientCredentials(store: string, clientId: string, clientSecret: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`https://${store}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString(),
    });
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : '';
    throw new Error(`Client credentials exchange for ${store} failed${cause}. Check the store domain and Client ID/secret are correct.`);
  }

  if (!res.ok) {
    throw new Error(`Client credentials exchange for ${store} failed: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!json.access_token) {
    throw new Error(`Client credentials exchange for ${store} returned no access_token: ${json.error_description ?? json.error ?? 'unknown error'}`);
  }
  return json.access_token;
}

async function resolveToken(role: Role, store: string): Promise<string> {
  const staticToken = process.env[`SHOPIFY_${role}_TOKEN`];
  if (staticToken) return staticToken;

  const clientId = process.env[`SHOPIFY_${role}_CLIENT_ID`];
  const clientSecret = process.env[`SHOPIFY_${role}_CLIENT_SECRET`];
  if (clientId && clientSecret) {
    return exchangeClientCredentials(store, clientId, clientSecret);
  }

  throw new Error(
    `Missing credentials for ${role}: set either SHOPIFY_${role}_TOKEN, or both SHOPIFY_${role}_CLIENT_ID and SHOPIFY_${role}_CLIENT_SECRET in .env. Copy .env.example and fill in values.`
  );
}

export async function resolveConfig(): Promise<ResolvedConfig> {
  const rc = loadRc();

  if (rc.from.store === rc.to.store) {
    throw new Error('.syncifyrc.json: "from.store" and "to.store" must not be the same store.');
  }
  if (!rc.guard.allowedDestinations.includes(rc.to.store)) {
    throw new Error(`"to.store" (${rc.to.store}) is not in guard.allowedDestinations. Refusing to run.`);
  }

  const [prodToken, devToken] = await Promise.all([resolveToken('PROD', rc.from.store), resolveToken('DEV', rc.to.store)]);

  // Guard layer: distinct tokens are the last line of defense if everything
  // else (dotfile, flags) somehow points both roles at the same store.
  if (prodToken === devToken) {
    throw new Error(
      'The resolved Production and Dev Admin API tokens are identical — refusing to run. Check SHOPIFY_PROD_*/SHOPIFY_DEV_* in .env.'
    );
  }

  return {
    ...rc,
    // Backward-compatible default for .syncifyrc.json files written before
    // this field existed.
    productTitlePrefix: rc.productTitlePrefix ?? '[DEV] ',
    prodStore: rc.from.store,
    prodToken,
    devStore: rc.to.store,
    devToken,
  };
}
