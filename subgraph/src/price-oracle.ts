import { BigInt } from "@graphprotocol/graph-ts";
import {
  FeedUpdated,
  FeedRemoved,
  CircuitBreakerTriggered,
  CircuitBreakerAutoRecovered,
  KeeperRecovery,
} from "../generated/PriceOracle/PriceOracle";
import {
  FeedUpdate,
  CircuitBreakerEvent,
  CircuitBreakerRecovery,
} from "../generated/schema";

export function handleFeedUpdated(event: FeedUpdated): void {
  let id =
    event.transaction.hash.toHexString() +
    "-" +
    event.logIndex.toString();
  let entity = new FeedUpdate(id);
  entity.token = event.params.token;
  entity.feed = event.params.feed;
  entity.stalePeriod = event.params.stalePeriod;
  entity.tokenDecimals = event.params.tokenDecimals;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

export function handleFeedRemoved(event: FeedRemoved): void {
  let id =
    event.transaction.hash.toHexString() +
    "-" +
    event.logIndex.toString();
  let entity = new FeedUpdate(id);
  entity.token = event.params.token;
  entity.feed = event.params.token; // placeholder — feed was removed
  entity.stalePeriod = BigInt.zero();
  entity.tokenDecimals = 0;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

export function handleCircuitBreakerTriggered(
  event: CircuitBreakerTriggered
): void {
  let id =
    event.transaction.hash.toHexString() +
    "-" +
    event.logIndex.toString();
  let entity = new CircuitBreakerEvent(id);
  entity.token = event.params.token;
  entity.oldPrice = event.params.oldPrice;
  entity.newPrice = event.params.newPrice;
  entity.deviationBps = event.params.deviationBps;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

export function handleCircuitBreakerAutoRecovered(
  event: CircuitBreakerAutoRecovered
): void {
  let id =
    event.transaction.hash.toHexString() +
    "-" +
    event.logIndex.toString();
  let entity = new CircuitBreakerRecovery(id);
  entity.token = event.params.token;
  entity.newPrice = event.params.newPrice;
  entity.keeper = null;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

export function handleKeeperRecovery(event: KeeperRecovery): void {
  let id =
    event.transaction.hash.toHexString() +
    "-" +
    event.logIndex.toString();
  let entity = new CircuitBreakerRecovery(id);
  entity.token = event.params.token;
  entity.newPrice = event.params.newPrice;
  entity.keeper = event.params.keeper;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}
