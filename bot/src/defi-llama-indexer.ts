/**
 * DeFi Llama Indexer
 *
 * Indexes yield data from DeFi Llama's API for use by the yield scanner
 * and yield API services. Provides caching and rate-limit-aware fetching.
 *
 * NOTE: Primary DeFi Llama integration is in yield-api.ts (fetchAndProcess).
 * This module is reserved for advanced indexing features:
 *   - Historical APY tracking
 *   - Protocol-level aggregation
 *   - TVL trend analysis
 *
 * TODO: Implement advanced indexing when needed.
 */

export interface IndexedPool {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number;
  indexedAt: Date;
}

/**
 * Placeholder indexer class.
 * See yield-api.ts for the active DeFi Llama integration.
 */
export class DefiLlamaIndexer {
  async index(): Promise<IndexedPool[]> {
    console.warn("[DefiLlamaIndexer] Stub — see yield-api.ts for active integration");
    return [];
  }
}
