export type StoreRole = 'prod' | 'dev';

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export interface ShopifyClientOptions {
  store: string;
  token: string;
  role: StoreRole;
  apiVersion?: string;
}

export class ShopifyClient {
  readonly store: string;
  readonly role: StoreRole;
  private readonly token: string;
  private readonly apiVersion: string;

  constructor(opts: ShopifyClientOptions) {
    this.store = opts.store;
    this.token = opts.token;
    this.role = opts.role;
    this.apiVersion = opts.apiVersion ?? '2026-07';
  }

  private get endpoint(): string {
    return `https://${this.store}/admin/api/${this.apiVersion}/graphql.json`;
  }

  async query<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
    return this.request<T>(query, variables);
  }

  // Code-level guard mirroring the token-scope guard: the "prod" role can
  // never issue a mutation, regardless of what a caller passes in.
  async mutate<T = unknown>(mutation: string, variables?: Record<string, unknown>): Promise<T> {
    if (this.role === 'prod') {
      throw new Error(
        `Refusing to run a mutation against the "${this.role}" store (${this.store}). Production is read-only by design.`
      );
    }
    return this.request<T>(mutation, variables);
  }

  // Shopify signals rate limiting two ways: an HTTP 429 (with a
  // Retry-After header, in seconds), or — more commonly for GraphQL's
  // cost-based leaky bucket — a 200 OK carrying a THROTTLED error in the
  // body. Both are retried with exponential backoff; nothing else is
  // (a real GraphQL/network error shouldn't silently retry and hide a bug).
  private async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': this.token,
          },
          body: JSON.stringify({ query, variables }),
        });
      } catch (err) {
        // A raw fetch() failure (headers timeout, connection reset, DNS
        // blip) — not a Shopify API response at all. Retried the same as
        // 429/THROTTLED below, since these are usually transient, before
        // giving up and surfacing the "check the domain" message.
        if (attempt >= MAX_RETRIES) {
          const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : '';
          throw new Error(
            `Network request to ${this.store} (${this.endpoint}) failed${cause} after ${MAX_RETRIES} retries. Check the store domain is correct and reachable — this is not a Shopify API error.`,
            { cause: err }
          );
        }
        await sleep(BASE_DELAY_MS * 2 ** attempt);
        continue;
      }

      if (res.status === 429) {
        if (attempt >= MAX_RETRIES) {
          throw new Error(`Shopify API request to ${this.store} was rate-limited (HTTP 429) ${MAX_RETRIES} times in a row — giving up.`);
        }
        const retryAfter = res.headers.get('Retry-After');
        await sleep(retryAfter ? Number(retryAfter) * 1000 : BASE_DELAY_MS * 2 ** attempt);
        continue;
      }

      if (!res.ok) {
        throw new Error(`Shopify API request to ${this.store} failed: ${res.status} ${res.statusText}`);
      }

      const json = (await res.json()) as { data?: T; errors?: Array<{ extensions?: { code?: string } }> };

      if (json.errors?.some((e) => e.extensions?.code === 'THROTTLED')) {
        if (attempt >= MAX_RETRIES) {
          throw new Error(`Shopify API request to ${this.store} was rate-limited (THROTTLED) ${MAX_RETRIES} times in a row — giving up.`);
        }
        await sleep(BASE_DELAY_MS * 2 ** attempt);
        continue;
      }

      if (json.errors && json.errors.length > 0) {
        throw new Error(`GraphQL errors from ${this.store}: ${JSON.stringify(json.errors)}`);
      }

      return json.data as T;
    }
  }
}
