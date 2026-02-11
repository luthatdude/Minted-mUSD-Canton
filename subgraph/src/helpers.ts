// ═══════════════════════════════════════════════════════════════
// Minted Protocol — Subgraph Helpers
// ═══════════════════════════════════════════════════════════════
// Shared utility functions for all event mappings.
// ═══════════════════════════════════════════════════════════════

import { BigDecimal, BigInt, Address, Bytes } from "@graphprotocol/graph-ts";
import {
  ProtocolStats,
  User,
  DailySnapshot,
  HourlySnapshot,
} from "../generated/schema";

// ─── Constants ──────────────────────────────────────────────────
export const ZERO_BI = BigInt.fromI32(0);
export const ONE_BI = BigInt.fromI32(1);
export const ZERO_BD = BigDecimal.fromString("0");
export const WAD = BigDecimal.fromString("1000000000000000000"); // 1e18
export const USDC_DECIMALS = BigDecimal.fromString("1000000"); // 1e6
export const PROTOCOL_ID = "protocol";
export const SECONDS_PER_DAY = 86400;
export const SECONDS_PER_HOUR = 3600;

// ─── Conversion ─────────────────────────────────────────────────
export function toWadDecimal(value: BigInt): BigDecimal {
  return value.toBigDecimal().div(WAD);
}

export function toUsdcDecimal(value: BigInt): BigDecimal {
  return value.toBigDecimal().div(USDC_DECIMALS);
}

// ─── Entity Loaders ─────────────────────────────────────────────

export function getOrCreateProtocolStats(): ProtocolStats {
  let stats = ProtocolStats.load(PROTOCOL_ID);
  if (stats == null) {
    stats = new ProtocolStats(PROTOCOL_ID);
    stats.totalUsers = ZERO_BI;
    stats.totalMints = ZERO_BI;
    stats.totalRedeems = ZERO_BI;
    stats.totalBorrows = ZERO_BI;
    stats.totalRepays = ZERO_BI;
    stats.totalLiquidations = ZERO_BI;
    stats.totalBridgeTransfers = ZERO_BI;
    stats.musdTotalSupply = ZERO_BD;
    stats.smusdTotalAssets = ZERO_BD;
    stats.lastUpdatedBlock = ZERO_BI;
    stats.lastUpdatedTimestamp = ZERO_BI;
  }
  return stats;
}

export function getOrCreateUser(address: Address, timestamp: BigInt, blockNumber: BigInt): User {
  let id = address.toHexString();
  let user = User.load(id);
  if (user == null) {
    user = new User(id);
    user.firstInteractionBlock = blockNumber;
    user.firstInteractionTimestamp = timestamp;
    user.totalMinted = ZERO_BD;
    user.totalRedeemed = ZERO_BD;
    user.totalBorrowed = ZERO_BD;
    user.totalRepaid = ZERO_BD;
    user.totalStaked = ZERO_BD;
    user.totalUnstaked = ZERO_BD;
    user.txCount = ZERO_BI;
    user.lastActiveTimestamp = timestamp;

    // Increment global user count
    let stats = getOrCreateProtocolStats();
    stats.totalUsers = stats.totalUsers.plus(ONE_BI);
    stats.save();
  }
  user.txCount = user.txCount.plus(ONE_BI);
  user.lastActiveTimestamp = timestamp;
  return user;
}

export function getOrCreateDailySnapshot(timestamp: BigInt): DailySnapshot {
  let dayId = timestamp.toI32() / SECONDS_PER_DAY;
  let id = dayId.toString();
  let snapshot = DailySnapshot.load(id);
  if (snapshot == null) {
    snapshot = new DailySnapshot(id);
    snapshot.date = BigInt.fromI32(dayId * SECONDS_PER_DAY);
    snapshot.musdSupply = ZERO_BD;
    snapshot.smusdTotalAssets = ZERO_BD;
    snapshot.smusdSharePrice = ZERO_BD;
    snapshot.totalBorrows = ZERO_BD;
    snapshot.totalCollateralValue = ZERO_BD;
    snapshot.mintVolume = ZERO_BD;
    snapshot.redeemVolume = ZERO_BD;
    snapshot.borrowVolume = ZERO_BD;
    snapshot.repayVolume = ZERO_BD;
    snapshot.bridgeVolume = ZERO_BD;
    snapshot.uniqueUsers = ZERO_BI;
    snapshot.txCount = ZERO_BI;
  }
  snapshot.txCount = snapshot.txCount.plus(ONE_BI);
  return snapshot;
}

export function getOrCreateHourlySnapshot(timestamp: BigInt): HourlySnapshot {
  let hourId = timestamp.toI32() / SECONDS_PER_HOUR;
  let id = hourId.toString();
  let snapshot = HourlySnapshot.load(id);
  if (snapshot == null) {
    snapshot = new HourlySnapshot(id);
    snapshot.timestamp = BigInt.fromI32(hourId * SECONDS_PER_HOUR);
    snapshot.musdSupply = ZERO_BD;
    snapshot.smusdSharePrice = ZERO_BD;
    snapshot.mintVolume = ZERO_BD;
    snapshot.redeemVolume = ZERO_BD;
  }
  return snapshot;
}
