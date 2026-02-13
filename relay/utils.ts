/**
 * Shared utilities for Minted Protocol services
 * Extracted common code to reduce duplication
 */

import * as fs from "fs";
import { ethers } from "ethers";

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
    }
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";

    // Periodically verify TLS enforcement hasn't been tampered with at runtime.
    // Node.js 22+ forbids accessor descriptors on process.env (ERR_INVALID_OBJECT_DEFINE_PROPERTY),
    // so we use an interval-based watchdog instead of Object.defineProperty.
    const TLS_WATCHDOG_INTERVAL_MS = 5000;
    setInterval(() => {
      if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
        console.error("[SECURITY] Attempt to disable TLS cert validation blocked at runtime.");
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
      }
    }, TLS_WATCHDOG_INTERVAL_MS).unref(); // unref() so the timer doesn't keep the process alive
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

/**
 * Sanitize a URL for safe logging by masking API keys in the path/query.
 * Strips everything after the host portion to prevent leaking credentials
 * embedded in RPC endpoint URLs (e.g., https://eth-mainnet.g.alchemy.com/v2/SECRET).
 */
export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/***`;
  } catch {
    // If URL parsing fails, truncate to first 40 chars
    return url.substring(0, 40) + "...";
  }
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
 * After validation, attempts to zero out the env var source
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

  // Clear the env var after reading to reduce memory exposure window.
  // The key is still held by the caller's variable, but at least the env source
  // is scrubbed. For full protection, use AWS KMS (see kms-ethereum-signer.ts).
  if (process.env[envVar] && process.env.NODE_ENV !== "test") {
    process.env[envVar] = "0".repeat(64);
  }
  
  return key;
}

// ============================================================
//  KMS Signer Factory
// ============================================================

/**
 * Create an ethers Signer, preferring AWS KMS when configured.
 *
 * When KMS_KEY_ID is set in the environment, the function attempts to
 * build a KMS-backed signer via @aws-sdk/client-kms (must be installed).
 * If KMS is not configured, falls back to a local ethers.Wallet using
 * the provided raw private key — but logs a security warning in production.
 *
 * @param provider  JSON-RPC provider to attach the signer to
 * @param secretName  Docker-secret name for the private key
 * @param envVar  Environment variable name for the private key fallback
 * @returns An ethers.Signer connected to the provider
 */
export async function createSigner(
  provider: ethers.JsonRpcProvider,
  secretName: string,
  envVar: string,
): Promise<ethers.Signer> {
  const kmsKeyId = process.env.KMS_KEY_ID;

  if (kmsKeyId) {
    // Dynamic import so @aws-sdk/client-kms is only required when KMS is used
    try {
      const { KMSClient, SignCommand, GetPublicKeyCommand } = await import("@aws-sdk/client-kms");
      const kmsClient = new KMSClient({ region: process.env.AWS_REGION || "us-east-1" });

      // Retrieve the public key to derive the Ethereum address
      const pubKeyResp = await kmsClient.send(
        new GetPublicKeyCommand({ KeyId: kmsKeyId }),
      );
      if (!pubKeyResp.PublicKey) throw new Error("KMS returned empty public key");

      // The raw public key is a DER-encoded SubjectPublicKeyInfo.
      // ethers.computeAddress expects an uncompressed 65-byte key (04 || x || y).
      const derBytes = Buffer.from(pubKeyResp.PublicKey);
      // The last 64 bytes of the DER structure are the x,y coordinates
      const uncompressedKey = Buffer.concat([Buffer.from([0x04]), derBytes.subarray(-64)]);
      const address = ethers.computeAddress("0x" + uncompressedKey.toString("hex"));

      console.log(`[KMS] Signer initialised — address ${address}`);

      // Do NOT load raw private key when KMS is configured.
      // Previously the code loaded the raw key into a Wallet even with KMS present,
      // completely defeating the purpose of KMS (key stays in heap memory).
      // Return a VoidSigner for now — full KMS AbstractSigner integration is required
      // before production write operations will work without a raw key.
      console.warn("[KMS] Using VoidSigner — full KMS AbstractSigner required for write ops");
      return new ethers.VoidSigner(address, provider);
    } catch (err) {
      console.error(`[KMS] Failed to initialise KMS signer: ${(err as Error).message}`);
      console.error("[KMS] Falling back to raw private key");
    }
  }

  // Fallback: raw private key
  const key = readAndValidatePrivateKey(secretName, envVar);
  if (!key) {
    throw new Error(`FATAL: Neither KMS_KEY_ID nor ${envVar} is configured`);
  }

  // In production, raw private keys must not be used.
  // JS strings are immutable — the key persists in V8 heap memory until GC,
  // making it extractable via memory dumps (/proc/pid/mem, core dumps, heap snapshots).
  // KMS keeps the private key inside the HSM boundary and never exposes it to the process.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `SECURITY: Raw private key usage is FORBIDDEN in production. ` +
      `Configure KMS_KEY_ID for HSM-backed signing. ` +
      `See kms-ethereum-signer.ts for setup instructions.`
    );
  }

  console.warn(
    `[SECURITY] Using raw private key for signer — acceptable in ${process.env.NODE_ENV || "development"} only`,
  );

  return new ethers.Wallet(key, provider);
}
