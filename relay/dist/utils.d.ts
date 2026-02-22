/**
 * Shared utilities for Minted Protocol services
 * Extracted common code to reduce duplication
 */
import { ethers } from "ethers";
/**
 * Enforce TLS certificate validation at process level.
 * This MUST be called before any network I/O.
 * Prevents accidental `NODE_TLS_REJECT_UNAUTHORIZED=0` in production.
 *
 * INFRA-H-06: Also installs a process-level guard that re-checks
 * the env var periodically, preventing runtime tampering.
 */
export declare function enforceTLSSecurity(): void;
/**
 * Validate that a URL uses HTTPS in production environments.
 * Throws if HTTP is used outside development.
 */
export declare function requireHTTPS(url: string, label: string): void;
/**
 * Sanitize a URL for safe logging by masking API keys in the path/query.
 * Strips everything after the host portion to prevent leaking credentials
 * embedded in RPC endpoint URLs (e.g., https://eth-mainnet.g.alchemy.com/v2/SECRET).
 */
export declare function sanitizeUrl(url: string): string;
/**
 * Read Docker secrets from /run/secrets/ with env var fallback.
 * Uses synchronous reads since this is called during module initialization.
 * For production, consider moving to async initialization if /run/secrets/
 * is on a network mount.
 */
export declare function readSecret(name: string, envVar: string): string;
/**
 * Validate that a private key is in the valid secp256k1 range.
 * Private keys must be in range [1, n-1] where n is the curve order.
 * Keys outside this range will produce invalid signatures.
 *
 * @param privateKey - Hex-encoded private key (with or without 0x prefix)
 * @returns true if valid, false otherwise
 */
export declare function isValidSecp256k1PrivateKey(privateKey: string): boolean;
/**
 * Read and validate a private key from Docker secret or env var.
 * Throws if the key is not in the valid secp256k1 range.
 *
 * After validation, attempts to zero out the env var source
 * to reduce the window where the key is readable in memory.
 */
export declare function readAndValidatePrivateKey(secretName: string, envVar: string): string;
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
export declare function createSigner(provider: ethers.JsonRpcProvider, secretName: string, envVar: string): Promise<ethers.Signer>;
/**
 * TS-C-01 FIX: Defense-in-depth guard for production deployments.
 *
 * Scans for .env files in the application directory that contain
 * plaintext private keys. In production, secrets MUST be mounted
 * via Docker secrets (/run/secrets/) or injected by K8s ExternalSecrets.
 *
 * This guard:
 *   - FATAL in production: refuses to start if .env files with keys exist
 *   - WARNING in staging: logs a security warning
 *   - No-op in development: .env files are expected for local dev
 */
export declare function rejectDotenvPrivateKeys(appDir: string): void;
/**
 * Validate that a string is a well-formed Canton party identifier.
 *
 * Rejects:
 *   - Empty strings
 *   - Strings exceeding 512 characters
 *   - Strings with control characters, spaces, or special chars
 *   - Strings that don't match the Canton party ID format
 *
 * @param partyId - The Canton party ID string to validate
 * @returns true if valid
 */
export declare function isValidCantonPartyId(partyId: string): boolean;
/**
 * Validate and sanitize a Canton party ID string from an untrusted source
 * (e.g., Ethereum event args). Throws a descriptive error on invalid input.
 *
 * @param partyId - The raw party ID string
 * @param context - Description of where this came from (for error messages)
 * @returns The validated party ID (unchanged if valid)
 * @throws Error if the party ID is malformed
 */
export declare function validateCantonPartyId(partyId: string, context: string): string;
//# sourceMappingURL=utils.d.ts.map