/**
 * Shared utilities for Minted Protocol services
 * FIX T-M01: Extracted common code to reduce duplication
 */
/**
 * FIX I-C01/T-C01: Read Docker secrets from /run/secrets/ with env var fallback.
 * Uses synchronous reads since this is called during module initialization.
 * For production, consider moving to async initialization if /run/secrets/
 * is on a network mount.
 */
export declare function readSecret(name: string, envVar: string): string;
/**
 * FIX B-H07: Validate that a private key is in the valid secp256k1 range.
 * Private keys must be in range [1, n-1] where n is the curve order.
 * Keys outside this range will produce invalid signatures.
 *
 * @param privateKey - Hex-encoded private key (with or without 0x prefix)
 * @returns true if valid, false otherwise
 */
export declare function isValidSecp256k1PrivateKey(privateKey: string): boolean;
/**
 * FIX B-H07: Read and validate a private key from Docker secret or env var.
 * Throws if the key is not in the valid secp256k1 range.
 */
export declare function readAndValidatePrivateKey(secretName: string, envVar: string): string;
//# sourceMappingURL=utils.d.ts.map