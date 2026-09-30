import { ShopifyClient } from './client.js';
import { ResolvedConfig } from './config.js';

export interface SyncContext {
  prod: ShopifyClient;
  dev: ShopifyClient;
  config: ResolvedConfig;
  live: boolean;
  // From `sync --since`: when set, date-filterable modules only read
  // Production records with updated_at >= this (see src/since.ts).
  since?: Date;
}

export interface SyncResult {
  resource: string;
  planned: number;
  applied: number;
  skipped: number;
  // Notes are written to syncify.log immediately as they happen (see
  // src/notes.ts), not carried back in-memory — this is just the count for
  // the end-of-resource console summary line.
  noteCount: number;
}
