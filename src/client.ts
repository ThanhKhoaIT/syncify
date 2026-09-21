export type StoreRole = 'prod' | 'dev';

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

  private async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
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
      const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : '';
      throw new Error(
        `Network request to ${this.store} (${this.endpoint}) failed${cause}. Check the store domain is correct and reachable — this is not a Shopify API error.`,
        { cause: err }
      );
    }

    if (!res.ok) {
      throw new Error(`Shopify API request to ${this.store} failed: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as { data?: T; errors?: unknown[] };

    if (json.errors && json.errors.length > 0) {
      throw new Error(`GraphQL errors from ${this.store}: ${JSON.stringify(json.errors)}`);
    }

    return json.data as T;
  }
}
