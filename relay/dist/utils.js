"use strict";
/**
 * Shared utilities for Minted Protocol services
 * FIX T-M01: Extracted common code to reduce duplication
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
exports.readAndValidatePrivateKey = exports.isValidSecp256k1PrivateKey = exports.readSecret = void 0;
const fs = __importStar(require("fs"));
// secp256k1 curve order - private keys must be in range [1, n-1]
const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
/**
 * FIX I-C01/T-C01: Read Docker secrets from /run/secrets/ with env var fallback.
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
 * FIX B-H07: Validate that a private key is in the valid secp256k1 range.
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
 * FIX B-H07: Read and validate a private key from Docker secret or env var.
 * Throws if the key is not in the valid secp256k1 range.
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
    return key;
}
exports.readAndValidatePrivateKey = readAndValidatePrivateKey;
//# sourceMappingURL=utils.js.map