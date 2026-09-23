import { ShopifyClient } from './client.js';

// Scope "subject" per resource — expanded to read_<subject> (Production)
// and write_<subject> (Dev). Single source of truth, shared by the runtime
// scope check below and `syncify init-apps`' generated app configs — kept
// in sync with the scope lists in README.md "Getting the Production/Dev
// token" too, but update this map first and let the others follow it.
export const RESOURCE_SCOPES: Record<string, string[]> = {
  products: ['products'],
  theme: [], // shells out to the `shopify` CLI, which uses its own auth — not the Admin API token
  // Metafield *definitions* now span Product/ProductVariant/Collection
  // (products) and Page/Article/Blog (online_store_pages) owner types (see
  // sync/metafields.ts); Shop-owner metafields/definitions need no
  // dedicated scope.
  metafields: ['products', 'online_store_pages'],
  metaobjects: ['metaobjects', 'metaobject_definitions'],
  content: ['online_store_pages'],
  discounts: ['discounts'],
  files: ['files'],
  menus: ['online_store_navigation'],
  articles: ['online_store_pages'],
  collections: ['products'],
};

// Every distinct scope subject across all resources, regardless of which
// ones are selected for a given sync run — used to generate an app config
// that covers everything syncify might ever need.
export const ALL_SCOPE_SUBJECTS = [...new Set(Object.values(RESOURCE_SCOPES).flat())].sort();

const CURRENT_APP_SCOPES_QUERY = `#graphql
  query CurrentAppScopes {
    currentAppInstallation {
      accessScopes { handle }
    }
  }
`;

interface CurrentAppScopesResponse {
  currentAppInstallation: { accessScopes: { handle: string }[] };
}

async function fetchGrantedScopes(client: ShopifyClient): Promise<Set<string>> {
  const data = await client.query<CurrentAppScopesResponse>(CURRENT_APP_SCOPES_QUERY);
  return new Set(data.currentAppInstallation.accessScopes.map((s) => s.handle));
}

/**
 * Pre-flight check, run before any resource sync starts: confirms both
 * tokens actually have the scopes the selected resources need, rather than
 * discovering a permission gap mid-run after some resources already
 * completed. Not skippable by --yes — this is a configuration problem, not
 * a destination-safety confirmation.
 */
export async function assertRequiredScopes(prod: ShopifyClient, dev: ShopifyClient, resources: string[]): Promise<void> {
  const subjects = [...new Set(resources.flatMap((r) => RESOURCE_SCOPES[r] ?? []))];
  if (subjects.length === 0) return;

  const [prodScopes, devScopes] = await Promise.all([fetchGrantedScopes(prod), fetchGrantedScopes(dev)]);

  const missingProd = subjects.filter((s) => !prodScopes.has(`read_${s}`)).map((s) => `read_${s}`);
  const missingDev = subjects.filter((s) => !devScopes.has(`write_${s}`)).map((s) => `write_${s}`);

  if (missingProd.length === 0 && missingDev.length === 0) return;

  const lines = [
    missingProd.length > 0 ? `Production token is missing: ${missingProd.join(', ')}` : null,
    missingDev.length > 0 ? `Dev token is missing: ${missingDev.join(', ')}` : null,
  ].filter((l): l is string => l !== null);

  throw new Error(
    `Missing required Admin API scope(s) for the selected resources — aborting before any writes. ${lines.join(' ')} ` +
      'See README.md "Getting the Production/Dev token" to add the missing scopes.'
  );
}
