// ═══════════════════════════════════════════════════════════════
// CollateralVault — Deposit & Withdraw Event Handlers
// ═══════════════════════════════════════════════════════════════

import { Deposited, Withdrawn } from "../generated/CollateralVault/CollateralVault";
import { Activity, CollateralPosition } from "../generated/schema";
import {
  getOrCreateProtocolStats,
  getOrCreateUser,
  toWadDecimal,
  ZERO_BD,
  ZERO_BI,
} from "./helpers";

export function handleCollateralDeposited(event: Deposited): void {
  let user = getOrCreateUser(event.params.user, event.block.timestamp, event.block.number);
  let amount = toWadDecimal(event.params.amount);

  // Collateral position
  let positionId = event.params.user.toHexString() + "-" + event.params.token.toHexString();
  let position = CollateralPosition.load(positionId);
  if (position == null) {
    position = new CollateralPosition(positionId);
    position.user = user.id;
    position.token = event.params.token;
    position.tokenSymbol = "COLLATERAL";
    position.amount = ZERO_BD;
    position.lastUpdatedBlock = ZERO_BI;
    position.lastUpdatedTimestamp = ZERO_BI;
  }
  position.amount = position.amount.plus(amount);
  position.lastUpdatedBlock = event.block.number;
  position.lastUpdatedTimestamp = event.block.timestamp;
  position.save();

  user.save();

  // Activity
  let activityId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let activity = new Activity(activityId);
  activity.user = user.id;
  activity.type = "DEPOSIT_COLLATERAL";
  activity.amount = amount;
  activity.asset = "COLLATERAL";
  activity.collateralToken = event.params.token.toHexString();
  activity.txHash = event.transaction.hash;
  activity.blockNumber = event.block.number;
  activity.timestamp = event.block.timestamp;
  activity.save();

  let stats = getOrCreateProtocolStats();
  stats.lastUpdatedBlock = event.block.number;
  stats.lastUpdatedTimestamp = event.block.timestamp;
  stats.save();
}

export function handleCollateralWithdrawn(event: Withdrawn): void {
  let user = getOrCreateUser(event.params.user, event.block.timestamp, event.block.number);
  let amount = toWadDecimal(event.params.amount);

  // Collateral position
  let positionId = event.params.user.toHexString() + "-" + event.params.token.toHexString();
  let position = CollateralPosition.load(positionId);
  if (position != null) {
    position.amount = position.amount.minus(amount);
    position.lastUpdatedBlock = event.block.number;
    position.lastUpdatedTimestamp = event.block.timestamp;
    position.save();
  }

  user.save();

  // Activity
  let activityId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let activity = new Activity(activityId);
  activity.user = user.id;
  activity.type = "WITHDRAW_COLLATERAL";
  activity.amount = amount;
  activity.asset = "COLLATERAL";
  activity.collateralToken = event.params.token.toHexString();
  activity.txHash = event.transaction.hash;
  activity.blockNumber = event.block.number;
  activity.timestamp = event.block.timestamp;
  activity.save();

  let stats = getOrCreateProtocolStats();
  stats.lastUpdatedBlock = event.block.number;
  stats.lastUpdatedTimestamp = event.block.timestamp;
  stats.save();
}
