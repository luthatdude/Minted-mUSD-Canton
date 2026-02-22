"use strict";
/**
 * Shared utilities for Minted Protocol services
 * Extracted common code to reduce duplication
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateCantonPartyId = exports.isValidCantonPartyId = exports.rejectDotenvPrivateKeys = exports.createSigner = exports.readAndValidatePrivateKey = exports.isValidSecp256k1PrivateKey = exports.readSecret = exports.sanitizeUrl = exports.requireHTTPS = exports.enforceTLSSecurity = void 0;
const fs = __importStar(require("fs"));
const ethers_1 = require("ethers");
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
function enforceTLSSecurity() {
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
exports.enforceTLSSecurity = enforceTLSSecurity;
/**
 * Validate that a URL uses HTTPS in production environments.
 * Throws if HTTP is used outside development.
 */
function requireHTTPS(url, label) {
    if (!url)
        return;
    if (url.startsWith("https://") || url.startsWith("wss://"))
        return;
    if (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test")
        return;
    throw new Error(`SECURITY: ${label} must use HTTPS in production. Got: ${url.substring(0, 40)}...`);
}
exports.requireHTTPS = requireHTTPS;
/**
 * Sanitize a URL for safe logging by masking API keys in the path/query.
 * Strips everything after the host portion to prevent leaking credentials
 * embedded in RPC endpoint URLs (e.g., https://eth-mainnet.g.alchemy.com/v2/SECRET).
 */
function sanitizeUrl(url) {
    try {
        const parsed = new URL(url);
        return `${parsed.protocol}//${parsed.host}/***`;
    }
    catch {
        // If URL parsing fails, truncate to first 40 chars
        return url.substring(0, 40) + "...";
    }
}
exports.sanitizeUrl = sanitizeUrl;
// Initialize TLS enforcement on module load
enforceTLSSecurity();
// secp256k1 curve order - private keys must be in range [1, n-1]
const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
/**
 * Read Docker secrets from /run/secrets/ with env var fallback.
 * Uses synchronous reads since this is called during module initialization.
 * For production, consider moving to async initialization if /run/secrets/
 * is on a network mount.
 */
function readSecret(name, envVar) {
    const secretPath = `/run/secrets/${name}`;
    try {
        if (fs.existsSync(secretPath)) {
            return fs.readFileSync(secretPath, "utf-8").trim();
        }
    }
    catch {
        // Fall through to env var
    }
    return process.env[envVar] || "";
}
exports.readSecret = readSecret;
/**
 * Validate that a private key is in the valid secp256k1 range.
 * Private keys must be in range [1, n-1] where n is the curve order.
 * Keys outside this range will produce invalid signatures.
 *
 * @param privateKey - Hex-encoded private key (with or without 0x prefix)
 * @returns true if valid, false otherwise
 */
function isValidSecp256k1PrivateKey(privateKey) {
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
exports.isValidSecp256k1PrivateKey = isValidSecp256k1PrivateKey;
/**
 * Read and validate a private key from Docker secret or env var.
 * Throws if the key is not in the valid secp256k1 range.
 *
 * After validation, attempts to zero out the env var source
 * to reduce the window where the key is readable in memory.
 */
function readAndValidatePrivateKey(secretName, envVar) {
    const key = readSecret(secretName, envVar);
    if (!key) {
        return ""; // Let caller handle missing key
    }
    if (!isValidSecp256k1PrivateKey(key)) {
        throw new Error(`SECURITY: ${envVar} is not a valid secp256k1 private key. ` +
            `Key must be 32 bytes (64 hex chars) in range [1, curve order-1]`);
    }
    // Clear the env var after reading to reduce memory exposure window.
    // The key is still held by the caller's variable, but at least the env source
    // is scrubbed. For full protection, use AWS KMS (see kms-ethereum-signer.ts).
    if (process.env[envVar] && process.env.NODE_ENV !== "test") {
        process.env[envVar] = "0".repeat(64);
    }
    return key;
}
exports.readAndValidatePrivateKey = readAndValidatePrivateKey;
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
async function createSigner(provider, secretName, envVar) {
    const kmsKeyId = process.env.KMS_KEY_ID;
    if (kmsKeyId) {
        // TS-H-01 FIX: Delegate to the fully functional KMSEthereumSigner
        // instead of the broken stub that threw "not yet implemented".
        try {
            const { createEthereumSigner } = await Promise.resolve().then(() => __importStar(require("./kms-ethereum-signer")));
            console.log(`[KMS] Initialising KMS signer via kms-ethereum-signer.ts...`);
            return await createEthereumSigner({ kmsKeyId, awsRegion: process.env.AWS_REGION || "us-east-1" }, provider);
        }
        catch (err) {
            console.error(`[KMS] Failed to initialise KMS signer: ${err.message}`);
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
        throw new Error(`SECURITY: Raw private key usage is FORBIDDEN in production. ` +
            `Configure KMS_KEY_ID for HSM-backed signing. ` +
            `See kms-ethereum-signer.ts for setup instructions.`);
    }
    console.warn(`[SECURITY] Using raw private key for signer — acceptable in ${process.env.NODE_ENV || "development"} only`);
    return new ethers_1.ethers.Wallet(key, provider);
}
exports.createSigner = createSigner;
// ============================================================
//  TS-C-01 FIX: Production .env File Guard
// ============================================================
const PRIVATE_KEY_PATTERNS = [
    /PRIVATE_KEY\s*=\s*[0-9a-fA-F]{64}/, // Raw hex private key
    /PRIVATE_KEY\s*=\s*0x[0-9a-fA-F]{64}/, // 0x-prefixed private key
    /SECRET_KEY\s*=\s*[0-9a-fA-F]{32,}/, // Any secret key
];
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
function rejectDotenvPrivateKeys(appDir) {
    if (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") {
        return; // .env files are expected in development
    }
    const envFiles = [".env", ".env.production", ".env.local"];
    for (const envFile of envFiles) {
        const envPath = `${appDir}/${envFile}`;
        try {
            if (!fs.existsSync(envPath))
                continue;
            const content = fs.readFileSync(envPath, "utf-8");
            for (const pattern of PRIVATE_KEY_PATTERNS) {
                if (pattern.test(content)) {
                    const msg = `[SECURITY] TS-C-01: Found plaintext private key in ${envFile}. ` +
                        `This is FORBIDDEN in production. Secrets must be provided via ` +
                        `Docker secrets (/run/secrets/) or AWS KMS. ` +
                        `Remove the .env file or strip all secret values from it.`;
                    if (process.env.NODE_ENV === "production") {
                        throw new Error(msg);
                    }
                    // Staging: warn but don't block
                    console.error(`⚠️  ${msg}`);
                }
            }
        }
        catch (err) {
            if (err.message?.includes("TS-C-01"))
                throw err;
            // Can't read file — skip (e.g., permission denied on read-only rootfs)
        }
    }
}
exports.rejectDotenvPrivateKeys = rejectDotenvPrivateKeys;
// ============================================================
//  TS-M-01 FIX: Canton Party ID Validation
// ============================================================
/**
 * Canton party ID format:
 *   - Legacy:  "partyName::fingerprint"  where fingerprint is a hex string
 *   - Modern (Canton 3.x):  "partyName::1220<hex>"  (multihash prefix)
 *   - Simple (dev/test):  "alice", "bob" (no :: separator, alphanumeric)
 *
 * Valid characters:
 *   - Display name: alphanumeric, hyphens, underscores, dots (1-255 chars)
 *   - Fingerprint: hex digits (after :: separator)
 *
 * Max length: 512 characters (Canton Network limit)
 */
const CANTON_PARTY_ID_REGEX = /^[a-zA-Z0-9._-]{1,255}(::[0-9a-fA-F]{8,128})?$/;
const MAX_CANTON_PARTY_ID_LENGTH = 512;
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
function isValidCantonPartyId(partyId) {
    if (!partyId || typeof partyId !== "string")
        return false;
    if (partyId.length > MAX_CANTON_PARTY_ID_LENGTH)
        return false;
    // Reject control characters, whitespace, and null bytes
    if (/[\x00-\x1f\x7f\s]/.test(partyId))
        return false;
    return CANTON_PARTY_ID_REGEX.test(partyId);
}
exports.isValidCantonPartyId = isValidCantonPartyId;
/**
 * Validate and sanitize a Canton party ID string from an untrusted source
 * (e.g., Ethereum event args). Throws a descriptive error on invalid input.
 *
 * @param partyId - The raw party ID string
 * @param context - Description of where this came from (for error messages)
 * @returns The validated party ID (unchanged if valid)
 * @throws Error if the party ID is malformed
 */
function validateCantonPartyId(partyId, context) {
    if (!isValidCantonPartyId(partyId)) {
        throw new Error(`TS-M-01: Invalid Canton party ID in ${context}: ` +
            `"${partyId.slice(0, 80)}${partyId.length > 80 ? "..." : ""}". ` +
            `Expected format: "displayName" or "displayName::hexFingerprint" ` +
            `(max ${MAX_CANTON_PARTY_ID_LENGTH} chars, alphanumeric/.-_ only).`);
    }
    return partyId;
}
exports.validateCantonPartyId = validateCantonPartyId;
//# sourceMappingURL=utils.js.map