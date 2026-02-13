// Subgraph helpers — shared utilities for event handler mappings
// FIX H-06: Populated stub file (was 0-byte)

import { BigInt, BigDecimal, Address, Bytes } from "@graphprotocol/graph-ts";

export const ZERO_BI = BigInt.fromI32(0);
export const ONE_BI = BigInt.fromI32(1);
export const ZERO_BD = BigDecimal.fromString("0");
export const ONE_BD = BigDecimal.fromString("1");
export const BI_18 = BigInt.fromI32(18);
export const BI_6 = BigInt.fromI32(6);

/**
 * Convert a raw token amount to a BigDecimal with the given decimals.
 */
export function toDecimal(amount: BigInt, decimals: i32): BigDecimal {
  let scale = BigInt.fromI32(10).pow(u8(decimals));
  return amount.toBigDecimal().div(scale.toBigDecimal());
}

/**
 * Convert USDC (6 decimals) to mUSD (18 decimals) representation.
 */
export function usdcToMusd(usdcAmount: BigInt): BigInt {
  return usdcAmount.times(BigInt.fromI32(10).pow(12));
}

/**
 * Create a unique event ID from transaction hash and log index.
 */
export function createEventId(txHash: Bytes, logIndex: BigInt): string {
  return txHash.toHexString().concat("-").concat(logIndex.toString());
}

/**
 * Load or create a protocol-level singleton entity ID.
 */
export const PROTOCOL_ID = "minted-musd-v1";
