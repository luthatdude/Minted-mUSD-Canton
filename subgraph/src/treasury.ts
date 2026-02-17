import { BigInt } from "@graphprotocol/graph-ts";
import {
  Deposited,
  Withdrawn,
  StrategyAdded,
  StrategyRemoved,
  StrategyUpdated,
  Rebalanced,
  EmergencyWithdraw,
} from "../generated/TreasuryV2/TreasuryV2";
import {
  TreasuryDeposit,
  TreasuryWithdrawal,
  StrategyChange,
  TreasuryRebalance,
} from "../generated/schema";

export function handleTreasuryDeposited(event: Deposited): void {
  let id =
    event.transaction.hash.toHexString() +
    "-" +
    event.logIndex.toString();
  let entity = new TreasuryDeposit(id);
  entity.from = event.params.from;
  entity.amount = event.params.amount;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

export function handleTreasuryWithdrawn(event: Withdrawn): void {
  let id =
    event.transaction.hash.toHexString() +
    "-" +
    event.logIndex.toString();
  let entity = new TreasuryWithdrawal(id);
  entity.to = event.params.to;
  entity.amount = event.params.amount;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

export function handleStrategyAdded(event: StrategyAdded): void {
  let id =
    event.transaction.hash.toHexString() +
    "-" +
    event.logIndex.toString();
  let entity = new StrategyChange(id);
  entity.strategy = event.params.strategy;
  entity.action = "added";
  entity.targetBps = event.params.targetBps;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

export function handleStrategyRemoved(event: StrategyRemoved): void {
  let id =
    event.transaction.hash.toHexString() +
    "-" +
    event.logIndex.toString();
  let entity = new StrategyChange(id);
  entity.strategy = event.params.strategy;
  entity.action = "removed";
  entity.targetBps = null;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

export function handleStrategyUpdated(event: StrategyUpdated): void {
  let id =
    event.transaction.hash.toHexString() +
    "-" +
    event.logIndex.toString();
  let entity = new StrategyChange(id);
  entity.strategy = event.params.strategy;
  entity.action = "updated";
  entity.targetBps = event.params.newTargetBps;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

export function handleRebalanced(event: Rebalanced): void {
  let id =
    event.transaction.hash.toHexString() +
    "-" +
    event.logIndex.toString();
  let entity = new TreasuryRebalance(id);
  entity.totalValue = event.params.totalValue;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

export function handleEmergencyWithdraw(event: EmergencyWithdraw): void {
  let id =
    event.transaction.hash.toHexString() +
    "-" +
    event.logIndex.toString();
  let entity = new TreasuryWithdrawal(id);
  entity.to = event.transaction.from;
  entity.amount = event.params.amount;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}
