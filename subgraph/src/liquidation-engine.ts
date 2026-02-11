// ═══════════════════════════════════════════════════════════════
// LiquidationEngine — Liquidation Event Handlers
// ═══════════════════════════════════════════════════════════════

import { Liquidated } from "../generated/LiquidationEngine/LiquidationEngine";
import { Activity } from "../generated/schema";
import {
  getOrCreateProtocolStats,
  getOrCreateUser,
  getOrCreateDailySnapshot,
  toWadDecimal,
  ONE_BI,
} from "./helpers";

export function handleLiquidated(event: Liquidated): void {
  // Track both the borrower (liquidated) and the liquidator
  let borrower = getOrCreateUser(event.params.borrower, event.block.timestamp, event.block.number);
  let liquidator = getOrCreateUser(event.params.liquidator, event.block.timestamp, event.block.number);
  let debtRepaid = toWadDecimal(event.params.debtRepaid);

  borrower.save();
  liquidator.save();

  // Activity for the borrower
  let activityId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let activity = new Activity(activityId);
  activity.user = borrower.id;
  activity.type = "LIQUIDATION";
  activity.amount = debtRepaid;
  activity.asset = "mUSD";
  activity.collateralToken = event.params.collateralToken.toHexString();
  activity.txHash = event.transaction.hash;
  activity.blockNumber = event.block.number;
  activity.timestamp = event.block.timestamp;
  activity.save();

  // Protocol stats
  let stats = getOrCreateProtocolStats();
  stats.totalLiquidations = stats.totalLiquidations.plus(ONE_BI);
  stats.lastUpdatedBlock = event.block.number;
  stats.lastUpdatedTimestamp = event.block.timestamp;
  stats.save();

  let daily = getOrCreateDailySnapshot(event.block.timestamp);
  daily.save();
}
