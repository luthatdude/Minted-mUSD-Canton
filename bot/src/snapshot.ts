/**
 * Minted Protocol - State Snapshot
 *
 * Captures and serialises protocol state for off-chain analysis, dashboards,
 * and historical tracking. Produces JSON snapshots of key protocol metrics.
 */

export interface ProtocolSnapshot {
  timestamp: number;
  blockNumber: number;
  tvl: {
    totalValueUsd: string;
    treasuryUsd: string;
    strategiesUsd: string;
  };
  supply: {
    musdTotalSupply: string;
    musdSupplyCap: string;
    smusdTotalShares: string;
    globalSharePrice: string;
  };
  borrowing: {
    totalBorrows: string;
    utilisationRateBps: number;
    interestRateBps: number;
    protocolReserves: string;
    badDebt: string;
  };
  strategies: Array<{
    name: string;
    address: string;
    deployed: string;
    apyBps: number;
  }>;
}

/**
 * Create an empty snapshot with zero values.
 * Used as a template for snapshot collection.
 */
export function createEmptySnapshot(blockNumber: number): ProtocolSnapshot {
  return {
    timestamp: Date.now(),
    blockNumber,
    tvl: {
      totalValueUsd: "0",
      treasuryUsd: "0",
      strategiesUsd: "0",
    },
    supply: {
      musdTotalSupply: "0",
      musdSupplyCap: "0",
      smusdTotalShares: "0",
      globalSharePrice: "0",
    },
    borrowing: {
      totalBorrows: "0",
      utilisationRateBps: 0,
      interestRateBps: 0,
      protocolReserves: "0",
      badDebt: "0",
    },
    strategies: [],
  };
}

/**
 * SnapshotCollector gathers protocol state from on-chain contracts.
 * Currently a stub — full implementation requires contract ABIs and provider.
 */
export class SnapshotCollector {
  async collect(_blockNumber: number): Promise<ProtocolSnapshot> {
    // TODO: Read from Treasury, MUSD, SMUSD, BorrowModule contracts
    console.warn("[Snapshot] Stub — returning empty snapshot");
    return createEmptySnapshot(_blockNumber);
  }
}
