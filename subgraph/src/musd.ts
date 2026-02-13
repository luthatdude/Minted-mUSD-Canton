import {
  Mint as MintEv,
  Burn as BurnEv,
  SupplyCapUpdated as SupplyCapUpdatedEv,
  BlacklistUpdated as BlacklistUpdatedEv,
} from "../generated/MUSD/MUSD";
import { MintEvent, BurnEvent, SupplyCapChange, BlacklistEvent } from "../generated/schema";
import { generateEventId, getOrCreateProtocolStats } from "./helpers";

export function handleMint(event: MintEv): void {
  let id = generateEventId(
    event.transaction.hash.toHexString(),
    event.logIndex.toString()
  );
  let entity = new MintEvent(id);
  entity.to = event.params.to;
  entity.amount = event.params.amount;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();

  let stats = getOrCreateProtocolStats();
  stats.totalMUSDSupply = stats.totalMUSDSupply.plus(event.params.amount);
  stats.lastUpdatedBlock = event.block.number;
  stats.save();
}

export function handleBurn(event: BurnEv): void {
  let id = generateEventId(
    event.transaction.hash.toHexString(),
    event.logIndex.toString()
  );
  let entity = new BurnEvent(id);
  entity.from = event.params.from;
  entity.amount = event.params.amount;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();

  let stats = getOrCreateProtocolStats();
  stats.totalMUSDSupply = stats.totalMUSDSupply.minus(event.params.amount);
  stats.lastUpdatedBlock = event.block.number;
  stats.save();
}

export function handleSupplyCapUpdated(event: SupplyCapUpdatedEv): void {
  let id = generateEventId(
    event.transaction.hash.toHexString(),
    event.logIndex.toString()
  );
  let entity = new SupplyCapChange(id);
  entity.oldCap = event.params.oldCap;
  entity.newCap = event.params.newCap;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

export function handleBlacklistUpdated(event: BlacklistUpdatedEv): void {
  let id = generateEventId(
    event.transaction.hash.toHexString(),
    event.logIndex.toString()
  );
  let entity = new BlacklistEvent(id);
  entity.account = event.params.account;
  entity.isBlacklisted = event.params.status;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}
