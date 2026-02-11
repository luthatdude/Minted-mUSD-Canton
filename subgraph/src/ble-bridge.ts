// ═══════════════════════════════════════════════════════════════
// BLEBridgeV9 — Bridge In & Out Event Handlers
// ═══════════════════════════════════════════════════════════════

import { BigInt } from "@graphprotocol/graph-ts";
import { Attested, BridgedOut } from "../generated/BLEBridgeV9/BLEBridgeV9";
import { Activity, BridgeTransfer } from "../generated/schema";
import {
  getOrCreateProtocolStats,
  getOrCreateUser,
  getOrCreateDailySnapshot,
  toWadDecimal,
  ONE_BI,
  ZERO_BI,
} from "./helpers";

export function handleBridgeIn(event: Attested): void {
  let user = getOrCreateUser(event.params.recipient, event.block.timestamp, event.block.number);
  let amount = toWadDecimal(event.params.amount);
  user.save();

  // Bridge transfer record
  let transferId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let transfer = new BridgeTransfer(transferId);
  transfer.sender = event.params.recipient; // On bridge-in, sender is the recipient on source chain
  transfer.recipient = event.params.recipient;
  transfer.amount = amount;
  transfer.sourceChain = event.params.sourceChain;
  transfer.destChain = BigInt.fromI32(11155111); // Sepolia
  transfer.nonce = ZERO_BI;
  transfer.attestationTime = event.block.timestamp;
  transfer.status = "completed";
  transfer.txHash = event.transaction.hash;
  transfer.blockNumber = event.block.number;
  transfer.timestamp = event.block.timestamp;
  transfer.save();

  // Activity
  let activity = new Activity(transferId);
  activity.user = user.id;
  activity.type = "BRIDGE_IN";
  activity.amount = amount;
  activity.asset = "mUSD";
  activity.chainId = event.params.sourceChain;
  activity.txHash = event.transaction.hash;
  activity.blockNumber = event.block.number;
  activity.timestamp = event.block.timestamp;
  activity.save();

  // Protocol stats
  let stats = getOrCreateProtocolStats();
  stats.totalBridgeTransfers = stats.totalBridgeTransfers.plus(ONE_BI);
  stats.lastUpdatedBlock = event.block.number;
  stats.lastUpdatedTimestamp = event.block.timestamp;
  stats.save();

  let daily = getOrCreateDailySnapshot(event.block.timestamp);
  daily.bridgeVolume = daily.bridgeVolume.plus(amount);
  daily.save();
}

export function handleBridgeOut(event: BridgedOut): void {
  let user = getOrCreateUser(event.params.sender, event.block.timestamp, event.block.number);
  let amount = toWadDecimal(event.params.amount);
  user.save();

  // Bridge transfer record
  let transferId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let transfer = new BridgeTransfer(transferId);
  transfer.sender = event.params.sender;
  transfer.recipient = event.params.sender;
  transfer.amount = amount;
  transfer.sourceChain = BigInt.fromI32(11155111);
  transfer.destChain = BigInt.fromI32(event.params.destChainId);
  transfer.nonce = ZERO_BI;
  transfer.status = "pending";
  transfer.txHash = event.transaction.hash;
  transfer.blockNumber = event.block.number;
  transfer.timestamp = event.block.timestamp;
  transfer.save();

  // Activity
  let activity = new Activity(transferId);
  activity.user = user.id;
  activity.type = "BRIDGE_OUT";
  activity.amount = amount;
  activity.asset = "mUSD";
  activity.chainId = BigInt.fromI32(event.params.destChainId);
  activity.txHash = event.transaction.hash;
  activity.blockNumber = event.block.number;
  activity.timestamp = event.block.timestamp;
  activity.save();

  // Protocol stats
  let stats = getOrCreateProtocolStats();
  stats.totalBridgeTransfers = stats.totalBridgeTransfers.plus(ONE_BI);
  stats.lastUpdatedBlock = event.block.number;
  stats.lastUpdatedTimestamp = event.block.timestamp;
  stats.save();

  let daily = getOrCreateDailySnapshot(event.block.timestamp);
  daily.bridgeVolume = daily.bridgeVolume.plus(amount);
  daily.save();
}
