import {
  Liquidation as LiquidationEv,
  BadDebtRecorded as BadDebtRecordedEv,
  BadDebtSocialized as BadDebtSocializedEv,
} from "../generated/LiquidationEngine/LiquidationEngine";
import { LiquidationEvent, BadDebtEvent } from "../generated/schema";
import { generateEventId, getOrCreateProtocolStats } from "./helpers";

export function handleLiquidation(event: LiquidationEv): void {
  let id = generateEventId(
    event.transaction.hash.toHexString(),
    event.logIndex.toString()
  );
  let entity = new LiquidationEvent(id);
  entity.borrower = event.params.borrower;
  entity.liquidator = event.params.liquidator;
  entity.repayAmount = event.params.debtRepaid;
  entity.seizeAmount = event.params.collateralSeized;
  entity.collateralToken = event.params.collateralToken;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();

  let stats = getOrCreateProtocolStats();
  stats.totalLiquidations = stats.totalLiquidations + 1;
  stats.lastUpdatedBlock = event.block.number;
  stats.save();
}

export function handleBadDebtRecorded(event: BadDebtRecordedEv): void {
  let id = generateEventId(
    event.transaction.hash.toHexString(),
    event.logIndex.toString()
  );
  let entity = new BadDebtEvent(id);
  entity.borrower = event.params.borrower;
  entity.amount = event.params.amount;
  entity.totalBadDebt = event.params.totalBadDebtAfter;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();

  let stats = getOrCreateProtocolStats();
  stats.totalBadDebt = event.params.totalBadDebtAfter;
  stats.lastUpdatedBlock = event.block.number;
  stats.save();
}

export function handleBadDebtSocialized(event: BadDebtSocializedEv): void {
  let id = generateEventId(
    event.transaction.hash.toHexString(),
    event.logIndex.toString()
  );
  let entity = new BadDebtEvent(id);
  entity.borrower = event.params.borrower;
  entity.amount = event.params.amount;
  entity.totalBadDebt = event.params.totalBadDebtAfter;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();

  let stats = getOrCreateProtocolStats();
  stats.totalBadDebt = event.params.totalBadDebtAfter;
  stats.lastUpdatedBlock = event.block.number;
  stats.save();
}
