import { ShopifyClient } from './client.js';
import { Notes } from './notes.js';

// `name` is deprecated on Publication but still populated — there's no
// documented non-deprecated way to get a human-readable channel name, so
// it's the only practical way to find "Online Store" among a shop's
// publications.
const PUBLICATIONS_QUERY = `#graphql
  query Publications {
    publications(first: 25) {
      nodes { id name }
    }
  }
`;

// NOTE: verify PublicationInput's exact shape via schema introspection for
// the pinned apiVersion before the first live run.
const PUBLISH_MUTATION = `#graphql
  mutation Publish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }
`;

// Creating/updating a product, collection, page, etc. via the Admin API
// never publishes it to any sales channel on its own — a synced record has
// zero channels and won't show up on the Dev storefront until explicitly
// published, regardless of its own status/isPublished field. Shared across
// sync modules so the "Online Store" publication lookup only happens once
// per module run rather than being reimplemented per resource.
export class OnlineStorePublisher {
  private publicationId: string | undefined;

  constructor(
    private readonly dev: ShopifyClient,
    private readonly notes: Notes,
    private readonly resourceLabel: string
  ) {}

  // Call once, before the per-item loop.
  async init(): Promise<void> {
    const data: any = await this.dev.query(PUBLICATIONS_QUERY);
    this.publicationId = data.publications.nodes.find((p: { name: string }) => p.name === 'Online Store')?.id;
    this.notes.push(
      this.publicationId
        ? `${this.resourceLabel} are published to the "Online Store" sales channel on Dev after upsert — the create/update mutation alone never publishes to any channel.`
        : `No "Online Store" publication found on Dev — ${this.resourceLabel.toLowerCase()} are NOT being published to any sales channel and will not appear on the Dev storefront until published manually.`
    );
  }

  // Safe to call unconditionally, new or updated — publishing an
  // already-published resource is a no-op, not an error. No-ops silently if
  // init() found no "Online Store" publication (already logged once by init).
  async publish(id: string, label: string): Promise<void> {
    if (!this.publicationId) return;
    const result: any = await this.dev.mutate(PUBLISH_MUTATION, { id, input: [{ publicationId: this.publicationId }] });
    if (result.publishablePublish.userErrors?.length) {
      this.notes.push(`${label} publish: ${JSON.stringify(result.publishablePublish.userErrors)}`);
    }
  }
}
