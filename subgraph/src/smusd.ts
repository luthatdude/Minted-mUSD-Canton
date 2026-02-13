import {
  YieldDistributed as YieldDistributedEv,
  CantonSharesSynced as CantonSharesSyncedEv,
  InterestReceived as InterestReceivedEv,
} from "../generated/SMUSD/SMUSD";
import { InterestReceived, CantonShareSync } from "../generated/schema";
import { generateEventId, getOrCreateProtocolStats } from "./helpers";

export function handleYieldDistributed(event: YieldDistributedEv): void {
  // YieldDistributed is informational — captured via InterestReceived entity
  // for a unified interest tracking view
  let id = generateEventId(
    event.transaction.hash.toHexString(),
    event.logIndex.toString()
  );
  let entity = new InterestReceived(id);
  entity.amount = event.params.amount;
  entity.newTotalAssets = event.params.amount; // yield distributed = amount
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

export function handleCantonSharesSynced(event: CantonSharesSyncedEv): void {
  let id = generateEventId(
    event.transaction.hash.toHexString(),
    event.logIndex.toString()
  );
  let entity = new CantonShareSync(id);
  entity.oldShares = event.params.epoch; // epoch used as context
  entity.newShares = event.params.cantonShares;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();

  let stats = getOrCreateProtocolStats();
  stats.totalSMUSDShares = event.params.cantonShares;
  stats.lastUpdatedBlock = event.block.number;
  stats.save();
}

export function handleInterestReceived(event: InterestReceivedEv): void {
  let id = generateEventId(
    event.transaction.hash.toHexString(),
    event.logIndex.toString()
  );
  let entity = new InterestReceived(id);
  entity.amount = event.params.amount;
  entity.newTotalAssets = event.params.totalReceived;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}
