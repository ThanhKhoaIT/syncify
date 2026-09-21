import { ShopifyClient } from './client.js';
import { ResolvedConfig } from './config.js';

export interface SyncContext {
  prod: ShopifyClient;
  dev: ShopifyClient;
  config: ResolvedConfig;
  live: boolean;
}

export interface SyncResult {
  resource: string;
  planned: number;
  applied: number;
  skipped: number;
  notes: string[];
}
