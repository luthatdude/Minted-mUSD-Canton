// ═══════════════════════════════════════════════════════════════
// BorrowModule — Borrow & Repay Event Handlers
// ═══════════════════════════════════════════════════════════════

import { Borrowed, Repaid } from "../generated/BorrowModule/BorrowModule";
import { Activity, BorrowPosition } from "../generated/schema";
import {
  getOrCreateProtocolStats,
  getOrCreateUser,
  getOrCreateDailySnapshot,
  toWadDecimal,
  ONE_BI,
  ZERO_BD,
  ZERO_BI,
} from "./helpers";

export function handleBorrowed(event: Borrowed): void {
  let user = getOrCreateUser(event.params.user, event.block.timestamp, event.block.number);
  let amount = toWadDecimal(event.params.amount);

  user.totalBorrowed = user.totalBorrowed.plus(amount);
  user.save();

  // Borrow position
  let positionId = event.params.user.toHexString();
  let position = BorrowPosition.load(positionId);
  if (position == null) {
    position = new BorrowPosition(positionId);
    position.user = user.id;
    position.principal = ZERO_BD;
    position.lastUpdatedBlock = ZERO_BI;
    position.lastUpdatedTimestamp = ZERO_BI;
  }
  position.principal = position.principal.plus(amount);
  position.lastUpdatedBlock = event.block.number;
  position.lastUpdatedTimestamp = event.block.timestamp;
  position.save();

  // Activity
  let activityId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let activity = new Activity(activityId);
  activity.user = user.id;
  activity.type = "BORROW";
  activity.amount = amount;
  activity.asset = "mUSD";
  activity.txHash = event.transaction.hash;
  activity.blockNumber = event.block.number;
  activity.timestamp = event.block.timestamp;
  activity.save();

  // Protocol stats
  let stats = getOrCreateProtocolStats();
  stats.totalBorrows = stats.totalBorrows.plus(ONE_BI);
  stats.lastUpdatedBlock = event.block.number;
  stats.lastUpdatedTimestamp = event.block.timestamp;
  stats.save();

  // Daily snapshot
  let daily = getOrCreateDailySnapshot(event.block.timestamp);
  daily.borrowVolume = daily.borrowVolume.plus(amount);
  daily.save();
}

export function handleRepaid(event: Repaid): void {
  let user = getOrCreateUser(event.params.user, event.block.timestamp, event.block.number);
  let amount = toWadDecimal(event.params.amount);

  user.totalRepaid = user.totalRepaid.plus(amount);
  user.save();

  // Borrow position
  let positionId = event.params.user.toHexString();
  let position = BorrowPosition.load(positionId);
  if (position != null) {
    position.principal = position.principal.minus(amount);
    position.lastUpdatedBlock = event.block.number;
    position.lastUpdatedTimestamp = event.block.timestamp;
    position.save();
  }

  // Activity
  let activityId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let activity = new Activity(activityId);
  activity.user = user.id;
  activity.type = "REPAY";
  activity.amount = amount;
  activity.asset = "mUSD";
  activity.txHash = event.transaction.hash;
  activity.blockNumber = event.block.number;
  activity.timestamp = event.block.timestamp;
  activity.save();

  // Protocol stats
  let stats = getOrCreateProtocolStats();
  stats.totalRepays = stats.totalRepays.plus(ONE_BI);
  stats.lastUpdatedBlock = event.block.number;
  stats.lastUpdatedTimestamp = event.block.timestamp;
  stats.save();

  let daily = getOrCreateDailySnapshot(event.block.timestamp);
  daily.repayVolume = daily.repayVolume.plus(amount);
  daily.save();
}
