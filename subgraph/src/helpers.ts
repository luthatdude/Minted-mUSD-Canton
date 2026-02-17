import { BigInt } from "@graphprotocol/graph-ts";
import { ProtocolStats } from "../generated/schema";

const PROTOCOL_STATS_ID = "protocol-stats";

export function getOrCreateProtocolStats(): ProtocolStats {
  let stats = ProtocolStats.load(PROTOCOL_STATS_ID);
  if (stats == null) {
    stats = new ProtocolStats(PROTOCOL_STATS_ID);
    stats.totalMUSDSupply = BigInt.zero();
    stats.totalSMUSDShares = BigInt.zero();
    stats.totalBorrows = BigInt.zero();
    stats.totalBadDebt = BigInt.zero();
    stats.totalLiquidations = 0;
    stats.totalAttestations = 0;
    stats.lastAttestationTimestamp = BigInt.zero();
    stats.lastUpdatedBlock = BigInt.zero();
    stats.save();
  }
  return stats;
}

export function generateEventId(txHash: string, logIndex: string): string {
  return txHash + "-" + logIndex;
}
