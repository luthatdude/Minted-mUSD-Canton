/**
 * Shared utilities for Minted Protocol services
 * Extracted common code to reduce duplication
 */

import * as fs from "fs";

// ============================================================
//  INFRA-H-01 / INFRA-H-02 / INFRA-H-06: TLS Security Enforcement
// ============================================================

/**
 * Enforce TLS certificate validation at process level.
 * This MUST be called before any network I/O.
 * Prevents accidental `NODE_TLS_REJECT_UNAUTHORIZED=0` in production.
 *
 * INFRA-H-06: Also installs a process-level guard that re-checks
 * the env var periodically, preventing runtime tampering.
 */
export function enforceTLSSecurity(): void {
  if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") {
    // Force-enable TLS certificate validation in production
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
      console.error("[SECURITY] NODE_TLS_REJECT_UNAUTHORIZED=0 is FORBIDDEN in production. Overriding to 1.");
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
    }
    // INFRA-H-06: Define a getter that prevents runtime tampering with this env var
    const originalValue = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    Object.defineProperty(process.env, "NODE_TLS_REJECT_UNAUTHORIZED", {
      get: () => originalValue || "1",
      set: (val: string) => {
        if (val === "0") {
          console.error("[SECURITY] Attempt to disable TLS cert validation blocked at runtime.");
          return;
        }
      },
      configurable: false,
    });
  }
}

/**
 * Validate that a URL uses HTTPS in production environments.
 * Throws if HTTP is used outside development.
 */
export function requireHTTPS(url: string, label: string): void {
  if (!url) return;
  if (url.startsWith("https://") || url.startsWith("wss://")) return;
  if (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") return;
  throw new Error(`SECURITY: ${label} must use HTTPS in production. Got: ${url.substring(0, 40)}...`);
}

// Initialize TLS enforcement on module load
enforceTLSSecurity();

// secp256k1 curve order - private keys must be in range [1, n-1]
const SECP256K1_N = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"
);

/**
 * Read Docker secrets from /run/secrets/ with env var fallback.
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
 * Validate that a private key is in the valid secp256k1 range.
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
 * Read and validate a private key from Docker secret or env var.
 * Throws if the key is not in the valid secp256k1 range.
 *
 * FIX H-07: After validation, attempts to zero out the env var source
 * to reduce the window where the key is readable in memory.
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

  // FIX H-07: Clear the env var after reading to reduce memory exposure window.
  // The key is still held by the caller's variable, but at least the env source
  // is scrubbed. For full protection, use AWS KMS (see kms-ethereum-signer.ts).
  if (process.env[envVar] && process.env.NODE_ENV !== "test") {
    process.env[envVar] = "0".repeat(64);
  }
  
  return key;
}
