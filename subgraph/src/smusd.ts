// ═══════════════════════════════════════════════════════════════
// SMUSD — Stake & Unstake Event Handlers
// ═══════════════════════════════════════════════════════════════

import { Deposit, Withdraw, YieldDistributed } from "../generated/SMUSD/SMUSD";
import { Activity } from "../generated/schema";
import {
  getOrCreateProtocolStats,
  getOrCreateUser,
  getOrCreateDailySnapshot,
  toWadDecimal,
  ONE_BI,
} from "./helpers";

export function handleStake(event: Deposit): void {
  let user = getOrCreateUser(event.params.owner, event.block.timestamp, event.block.number);
  let amount = toWadDecimal(event.params.assets);

  user.totalStaked = user.totalStaked.plus(amount);
  user.save();

  // Activity
  let activityId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let activity = new Activity(activityId);
  activity.user = user.id;
  activity.type = "STAKE";
  activity.amount = amount;
  activity.asset = "mUSD";
  activity.txHash = event.transaction.hash;
  activity.blockNumber = event.block.number;
  activity.timestamp = event.block.timestamp;
  activity.save();

  // Protocol stats
  let stats = getOrCreateProtocolStats();
  stats.lastUpdatedBlock = event.block.number;
  stats.lastUpdatedTimestamp = event.block.timestamp;
  stats.save();
}

export function handleUnstake(event: Withdraw): void {
  let user = getOrCreateUser(event.params.owner, event.block.timestamp, event.block.number);
  let amount = toWadDecimal(event.params.assets);

  user.totalUnstaked = user.totalUnstaked.plus(amount);
  user.save();

  // Activity
  let activityId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let activity = new Activity(activityId);
  activity.user = user.id;
  activity.type = "UNSTAKE";
  activity.amount = amount;
  activity.asset = "mUSD";
  activity.txHash = event.transaction.hash;
  activity.blockNumber = event.block.number;
  activity.timestamp = event.block.timestamp;
  activity.save();
}

export function handleYieldDistributed(event: YieldDistributed): void {
  let stats = getOrCreateProtocolStats();
  stats.smusdTotalAssets = toWadDecimal(event.params.totalAssets);
  stats.lastUpdatedBlock = event.block.number;
  stats.lastUpdatedTimestamp = event.block.timestamp;
  stats.save();

  let daily = getOrCreateDailySnapshot(event.block.timestamp);
  daily.smusdTotalAssets = toWadDecimal(event.params.totalAssets);
  daily.save();
}
