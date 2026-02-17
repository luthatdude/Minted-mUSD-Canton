import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import {
  CallScheduled,
  CallExecuted,
  Cancelled,
  MinDelayChange,
  RoleGranted,
  RoleRevoked,
} from "../../generated/MintedTimelockController/MintedTimelockController";
import {
  TimelockOperation,
  TimelockDelayChange,
  RoleChange,
} from "../../generated/schema";

export function handleCallScheduled(event: CallScheduled): void {
  let id =
    event.params.id.toHexString() +
    "-" +
    event.params.index.toString() +
    "-scheduled";
  let entity = new TimelockOperation(id);
  entity.operationId = event.params.id;
  entity.index = event.params.index;
  entity.target = event.params.target;
  entity.value = event.params.value;
  entity.data = event.params.data;
  entity.predecessor = event.params.predecessor;
  entity.delay = event.params.delay;
  entity.status = "scheduled";
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

export function handleCallExecuted(event: CallExecuted): void {
  let id =
    event.params.id.toHexString() +
    "-" +
    event.params.index.toString() +
    "-executed";
  let entity = new TimelockOperation(id);
  entity.operationId = event.params.id;
  entity.index = event.params.index;
  entity.target = event.params.target;
  entity.value = event.params.value;
  entity.data = event.params.data;
  entity.predecessor = Bytes.empty();
  entity.delay = BigInt.zero();
  entity.status = "executed";
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

export function handleCancelled(event: Cancelled): void {
  let id = event.params.id.toHexString() + "-cancelled";
  let entity = new TimelockOperation(id);
  entity.operationId = event.params.id;
  entity.index = BigInt.zero();
  entity.target = Bytes.empty() as Bytes;
  entity.value = BigInt.zero();
  entity.data = Bytes.empty();
  entity.predecessor = Bytes.empty();
  entity.delay = BigInt.zero();
  entity.status = "cancelled";
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

export function handleMinDelayChange(event: MinDelayChange): void {
  let id = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let entity = new TimelockDelayChange(id);
  entity.oldDuration = event.params.oldDuration;
  entity.newDuration = event.params.newDuration;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

export function handleRoleGranted(event: RoleGranted): void {
  let id = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let entity = new RoleChange(id);
  entity.role = event.params.role;
  entity.account = event.params.account;
  entity.sender = event.params.sender;
  entity.granted = true;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

export function handleRoleRevoked(event: RoleRevoked): void {
  let id = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let entity = new RoleChange(id);
  entity.role = event.params.role;
  entity.account = event.params.account;
  entity.sender = event.params.sender;
  entity.granted = false;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}
