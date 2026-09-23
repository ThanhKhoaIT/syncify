import { ShopifyClient } from './client.js';

interface FieldInput {
  namespace: string;
  key: string;
  type: string;
  value: string;
}

interface QueuedMetafield extends FieldInput {
  ownerId: string;
  ownerLabel: string;
}

const METAFIELDS_SET_MUTATION = `#graphql
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key }
      userErrors { field message }
    }
  }
`;

const BATCH_SIZE = 25;

// metafieldsSet's 25-item limit is per call, not per owner — each array
// entry carries its own ownerId, so metafields from many different owners
// (products, pages, ...) can share one call. Most owners have far fewer
// than 25 metafields each, so batching across owners cuts total API calls
// roughly proportional to how sparse metafields are, instead of one call
// per owner regardless of how few fields it has.
export class MetafieldBatcher {
  private queue: QueuedMetafield[] = [];
  private notes: string[] = [];

  constructor(private readonly dev: ShopifyClient) {}

  // Queues an owner's metafields; call flushIfFull() after each owner so
  // the queue never grows past one batch beyond BATCH_SIZE.
  add(ownerId: string, ownerLabel: string, fields: FieldInput[]): void {
    for (const f of fields) {
      this.queue.push({ ownerId, ownerLabel, ...f });
    }
  }

  async flushIfFull(): Promise<void> {
    while (this.queue.length >= BATCH_SIZE) {
      await this.flushBatch(this.queue.splice(0, BATCH_SIZE));
    }
  }

  async flushAll(): Promise<void> {
    while (this.queue.length > 0) {
      await this.flushBatch(this.queue.splice(0, BATCH_SIZE));
    }
  }

  private async flushBatch(batch: QueuedMetafield[]): Promise<void> {
    const result: any = await this.dev.mutate(METAFIELDS_SET_MUTATION, {
      metafields: batch.map(({ ownerId, namespace, key, type, value }) => ({ ownerId, namespace, key, type, value })),
    });
    if (result.metafieldsSet.userErrors?.length) {
      const owners = [...new Set(batch.map((b) => b.ownerLabel))];
      this.notes.push(`Metafields batch (owners: ${owners.join(', ')}): ${JSON.stringify(result.metafieldsSet.userErrors)}`);
    }
  }

  // Returns and clears accumulated error notes — call after flushAll().
  drainNotes(): string[] {
    const drained = this.notes;
    this.notes = [];
    return drained;
  }
}
