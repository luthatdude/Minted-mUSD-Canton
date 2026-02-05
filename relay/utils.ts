/**
 * Shared utilities for Minted Protocol services
 * FIX T-M01: Extracted common code to reduce duplication
 */

import * as fs from "fs";

// secp256k1 curve order - private keys must be in range [1, n-1]
const SECP256K1_N = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"
);

/**
 * FIX I-C01/T-C01: Read Docker secrets from /run/secrets/ with env var fallback.
 * Uses synchronous reads since this is called during module initialization.
 * For production, consider moving to async initialization if /run/secrets/
 * is on a network mount.
 */
export function readSecret(name: string, envVar: string): string {
  const secretPath = `/run/secrets/${name}`;
  try {
    if (fs.existsSync(secretPath)) {
      return fs.readFileSync(secretPath, "utf-8").trim();
    }
  } catch {
    // Fall through to env var
  }
  return process.env[envVar] || "";
}

/**
 * FIX B-H07: Validate that a private key is in the valid secp256k1 range.
 * Private keys must be in range [1, n-1] where n is the curve order.
 * Keys outside this range will produce invalid signatures.
 * 
 * @param privateKey - Hex-encoded private key (with or without 0x prefix)
 * @returns true if valid, false otherwise
 */
export function isValidSecp256k1PrivateKey(privateKey: string): boolean {
  // Normalize: remove 0x prefix if present
  const normalized = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
  
  // Must be exactly 64 hex characters (32 bytes)
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    return false;
  }
  
  // Convert to BigInt and check range [1, n-1]
  const keyValue = BigInt("0x" + normalized);
  
  // Key must be >= 1 and < n
  if (keyValue === 0n) {
    return false; // Zero is not a valid private key
  }
  if (keyValue >= SECP256K1_N) {
    return false; // Key >= curve order is invalid
  }
  
  return true;
}

/**
 * FIX B-H07: Read and validate a private key from Docker secret or env var.
 * Throws if the key is not in the valid secp256k1 range.
 */
export function readAndValidatePrivateKey(secretName: string, envVar: string): string {
  const key = readSecret(secretName, envVar);
  
  if (!key) {
    return ""; // Let caller handle missing key
  }
  
  if (!isValidSecp256k1PrivateKey(key)) {
    throw new Error(
      `SECURITY: ${envVar} is not a valid secp256k1 private key. ` +
      `Key must be 32 bytes (64 hex chars) in range [1, curve order-1]`
    );
  }
  
  return key;
}
