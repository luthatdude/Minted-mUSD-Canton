// ═══════════════════════════════════════════════════════════════
// DirectMintV2 — Mint & Redeem Event Handlers
// ═══════════════════════════════════════════════════════════════

import { BigDecimal } from "@graphprotocol/graph-ts";
import { Minted, Redeemed } from "../generated/DirectMintV2/DirectMintV2";
import { Activity } from "../generated/schema";
import {
  getOrCreateProtocolStats,
  getOrCreateUser,
  getOrCreateDailySnapshot,
  getOrCreateHourlySnapshot,
  toUsdcDecimal,
  toWadDecimal,
  ONE_BI,
} from "./helpers";

export function handleMinted(event: Minted): void {
  let user = getOrCreateUser(event.params.user, event.block.timestamp, event.block.number);
  let amount = toUsdcDecimal(event.params.usdcAmount);

  user.totalMinted = user.totalMinted.plus(amount);
  user.save();

  // Activity
  let activityId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let activity = new Activity(activityId);
  activity.user = user.id;
  activity.type = "MINT";
  activity.amount = amount;
  activity.asset = "USDC";
  activity.txHash = event.transaction.hash;
  activity.blockNumber = event.block.number;
  activity.timestamp = event.block.timestamp;
  activity.save();

  // Protocol stats
  let stats = getOrCreateProtocolStats();
  stats.totalMints = stats.totalMints.plus(ONE_BI);
  stats.lastUpdatedBlock = event.block.number;
  stats.lastUpdatedTimestamp = event.block.timestamp;
  stats.save();

  // Daily snapshot
  let daily = getOrCreateDailySnapshot(event.block.timestamp);
  daily.mintVolume = daily.mintVolume.plus(amount);
  daily.save();

  // Hourly snapshot
  let hourly = getOrCreateHourlySnapshot(event.block.timestamp);
  hourly.mintVolume = hourly.mintVolume.plus(amount);
  hourly.save();
}

export function handleRedeemed(event: Redeemed): void {
  let user = getOrCreateUser(event.params.user, event.block.timestamp, event.block.number);
  let amount = toWadDecimal(event.params.musdAmount);

  user.totalRedeemed = user.totalRedeemed.plus(amount);
  user.save();

  // Activity
  let activityId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let activity = new Activity(activityId);
  activity.user = user.id;
  activity.type = "REDEEM";
  activity.amount = amount;
  activity.asset = "mUSD";
  activity.txHash = event.transaction.hash;
  activity.blockNumber = event.block.number;
  activity.timestamp = event.block.timestamp;
  activity.save();

  // Protocol stats
  let stats = getOrCreateProtocolStats();
  stats.totalRedeems = stats.totalRedeems.plus(ONE_BI);
  stats.lastUpdatedBlock = event.block.number;
  stats.lastUpdatedTimestamp = event.block.timestamp;
  stats.save();

  // Daily snapshot
  let daily = getOrCreateDailySnapshot(event.block.timestamp);
  daily.redeemVolume = daily.redeemVolume.plus(amount);
  daily.save();

  // Hourly snapshot
  let hourly = getOrCreateHourlySnapshot(event.block.timestamp);
  hourly.redeemVolume = hourly.redeemVolume.plus(amount);
  hourly.save();
}
