// ═══════════════════════════════════════════════════════════════
// LeverageVault — Leverage Open & Close Event Handlers
// ═══════════════════════════════════════════════════════════════

import { PositionOpened, PositionClosed } from "../generated/LeverageVault/LeverageVault";
import { Activity } from "../generated/schema";
import {
  getOrCreateProtocolStats,
  getOrCreateUser,
  toWadDecimal,
} from "./helpers";

export function handleLeverageOpened(event: PositionOpened): void {
  let user = getOrCreateUser(event.params.user, event.block.timestamp, event.block.number);
  let amount = toWadDecimal(event.params.collateralAmount);
  user.save();

  // Activity
  let activityId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let activity = new Activity(activityId);
  activity.user = user.id;
  activity.type = "LEVERAGE_OPEN";
  activity.amount = amount;
  activity.asset = "COLLATERAL";
  activity.collateralToken = event.params.collateralToken.toHexString();
  activity.txHash = event.transaction.hash;
  activity.blockNumber = event.block.number;
  activity.timestamp = event.block.timestamp;
  activity.save();

  let stats = getOrCreateProtocolStats();
  stats.lastUpdatedBlock = event.block.number;
  stats.lastUpdatedTimestamp = event.block.timestamp;
  stats.save();
}

export function handleLeverageClosed(event: PositionClosed): void {
  let user = getOrCreateUser(event.params.user, event.block.timestamp, event.block.number);
  let amount = toWadDecimal(event.params.collateralReturned);
  user.save();

  // Activity
  let activityId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let activity = new Activity(activityId);
  activity.user = user.id;
  activity.type = "LEVERAGE_CLOSE";
  activity.amount = amount;
  activity.asset = "COLLATERAL";
  activity.txHash = event.transaction.hash;
  activity.blockNumber = event.block.number;
  activity.timestamp = event.block.timestamp;
  activity.save();

  let stats = getOrCreateProtocolStats();
  stats.lastUpdatedBlock = event.block.number;
  stats.lastUpdatedTimestamp = event.block.timestamp;
  stats.save();
}
