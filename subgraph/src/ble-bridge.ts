import {
  AttestationReceived as AttestationReceivedEv,
  EmergencyCapReduction as EmergencyCapReductionEv,
  SupplyCapUpdated as SupplyCapUpdatedEv,
  AttestationInvalidated as AttestationInvalidatedEv,
} from "../generated/BLEBridgeV9/BLEBridgeV9";
import { Attestation, EmergencyCapReduction } from "../generated/schema";
import { generateEventId, getOrCreateProtocolStats } from "./helpers";

export function handleAttestationReceived(event: AttestationReceivedEv): void {
  let id = generateEventId(
    event.transaction.hash.toHexString(),
    event.logIndex.toString()
  );
  let entity = new Attestation(id);
  entity.attestationId = event.params.id;
  entity.cantonAssets = event.params.cantonAssets;
  entity.newSupplyCap = event.params.newSupplyCap;
  entity.nonce = event.params.nonce;
  entity.attestationTimestamp = event.params.timestamp;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();

  let stats = getOrCreateProtocolStats();
  stats.totalAttestations = stats.totalAttestations + 1;
  stats.lastAttestationTimestamp = event.block.timestamp;
  stats.lastUpdatedBlock = event.block.number;
  stats.save();
}

export function handleEmergencyCapReduction(
  event: EmergencyCapReductionEv
): void {
  let id = generateEventId(
    event.transaction.hash.toHexString(),
    event.logIndex.toString()
  );
  let entity = new EmergencyCapReduction(id);
  entity.oldCap = event.params.oldCap;
  entity.newCap = event.params.newCap;
  entity.reason = event.params.reason;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

export function handleBridgeSupplyCapUpdated(
  event: SupplyCapUpdatedEv
): void {
  // Bridge-specific SupplyCapUpdated has 3 params (old, new, attestedAssets)
  // Tracked for correlation with MUSD supply cap changes
  let stats = getOrCreateProtocolStats();
  stats.lastUpdatedBlock = event.block.number;
  stats.save();
}

export function handleAttestationInvalidated(
  event: AttestationInvalidatedEv
): void {
  // Log invalidation as an emergency cap reduction with "invalidated" reason
  let id = generateEventId(
    event.transaction.hash.toHexString(),
    event.logIndex.toString()
  );
  let entity = new EmergencyCapReduction(id);
  entity.oldCap = event.block.number; // context: block where invalidation occurred
  entity.newCap = event.block.number;
  entity.reason = "Attestation invalidated: " + event.params.reason;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}
