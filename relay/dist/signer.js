"use strict";
/**
 * AWS KMS DER-to-RSV Signature Utility
 * Addresses: T-01 (DER buffer overflow), T-02 (Input validation)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.sortSignaturesBySignerAddress = exports.validateSignature = exports.formatKMSSignature = void 0;
const ethers_1 = require("ethers");
// secp256k1 curve order
const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
// DER format constants
const DER_SEQUENCE_TAG = 0x30;
const DER_INTEGER_TAG = 0x02;
/**
 * Validates and parses a DER-encoded ECDSA signature from AWS KMS
 * and converts it to Ethereum's RSV format.
 *
 * @param derSig - DER-encoded signature buffer from AWS KMS
 * @param messageHash - The hash of the message that was signed (0x prefixed hex string)
 * @param publicKey - The expected signer's Ethereum address (0x prefixed)
 * @returns The signature in RSV format (0x prefixed, 65 bytes)
 * @throws Error if signature parsing fails or recovery fails
 */
function formatKMSSignature(derSig, messageHash, publicKey) {
    // Input validation
    if (!derSig || !Buffer.isBuffer(derSig)) {
        throw new Error("INVALID_INPUT: derSig must be a Buffer");
    }
    if (!messageHash || typeof messageHash !== "string") {
        throw new Error("INVALID_INPUT: messageHash must be a string");
    }
    if (!publicKey || typeof publicKey !== "string") {
        throw new Error("INVALID_INPUT: publicKey must be a string");
    }
    if (!messageHash.startsWith("0x")) {
        throw new Error("INVALID_INPUT: messageHash must be 0x prefixed");
    }
    if (!publicKey.startsWith("0x")) {
        throw new Error("INVALID_INPUT: publicKey must be 0x prefixed");
    }
    // Validate minimum DER length
    // Minimum DER signature: 30 + len + 02 + rLen + r + 02 + sLen + s
    // Minimum is around 8 bytes for structure + at least 1 byte each for r and s
    if (derSig.length < 8) {
        throw new Error("INVALID_DER: Signature too short");
    }
    // Validate DER structure
    if (derSig[0] !== DER_SEQUENCE_TAG) {
        throw new Error("INVALID_DER: Missing sequence tag");
    }
    // Handle multi-byte DER length encoding and validate trailing bytes
    let totalLength;
    let headerOffset;
    if (derSig[1] & 0x80) {
        const numLenBytes = derSig[1] & 0x7f;
        if (numLenBytes > 2 || 2 + numLenBytes > derSig.length) {
            throw new Error("INVALID_DER: Unsupported length encoding");
        }
        totalLength = 0;
        for (let i = 0; i < numLenBytes; i++) {
            totalLength = (totalLength << 8) | derSig[2 + i];
        }
        headerOffset = 2 + numLenBytes;
    }
    else {
        totalLength = derSig[1];
        headerOffset = 2;
    }
    if (headerOffset + totalLength > derSig.length) {
        throw new Error("INVALID_DER: Length exceeds buffer");
    }
    // Reject signatures with unexpected trailing bytes
    if (headerOffset + totalLength < derSig.length) {
        throw new Error("INVALID_DER: Trailing bytes after DER sequence");
    }
    // Parse R component
    if (derSig[headerOffset] !== DER_INTEGER_TAG) {
        throw new Error("INVALID_DER: Missing R integer tag");
    }
    const rLen = derSig[headerOffset + 1];
    // Validate R/S length bounds (max 33 bytes for secp256k1)
    if (rLen > 33) {
        throw new Error("INVALID_DER: R component too long");
    }
    // Bounds check for R
    if (headerOffset + 2 + rLen > derSig.length) {
        throw new Error("INVALID_DER: R length exceeds buffer");
    }
    const rStart = headerOffset + 2;
    const r = derSig.subarray(rStart, rStart + rLen);
    // Parse S component
    const sTagIndex = rStart + rLen;
    if (sTagIndex >= derSig.length) {
        throw new Error("INVALID_DER: Missing S component");
    }
    if (derSig[sTagIndex] !== DER_INTEGER_TAG) {
        throw new Error("INVALID_DER: Missing S integer tag");
    }
    const sLenIndex = sTagIndex + 1;
    if (sLenIndex >= derSig.length) {
        throw new Error("INVALID_DER: Missing S length");
    }
    const sLen = derSig[sLenIndex];
    const sStartIndex = sLenIndex + 1;
    // Validate R/S length bounds (max 33 bytes for secp256k1)
    if (sLen > 33) {
        throw new Error("INVALID_DER: S component too long");
    }
    // Bounds check for S
    if (sStartIndex + sLen > derSig.length) {
        throw new Error("INVALID_DER: S length exceeds buffer");
    }
    const s = derSig.subarray(sStartIndex, sStartIndex + sLen);
    // Convert R to 32-byte hex (handle leading zeros in DER)
    let rHex = ethers_1.ethers.hexlify(r).replace("0x", "");
    // Remove leading zero if present (DER adds it for positive numbers with high bit set)
    if (rHex.length > 64 && rHex.startsWith("00")) {
        rHex = rHex.slice(2);
    }
    rHex = rHex.padStart(64, "0");
    if (rHex.length !== 64) {
        throw new Error("INVALID_DER: R component invalid length after normalization");
    }
    // Convert S to 32-byte hex
    let sHex = ethers_1.ethers.hexlify(s).replace("0x", "");
    if (sHex.length > 64 && sHex.startsWith("00")) {
        sHex = sHex.slice(2);
    }
    sHex = sHex.padStart(64, "0");
    if (sHex.length !== 64) {
        throw new Error("INVALID_DER: S component invalid length after normalization");
    }
    // Normalize S to lower half of curve (EIP-2)
    let sBig = BigInt("0x" + sHex);
    if (sBig > SECP256K1_N / 2n) {
        sBig = SECP256K1_N - sBig;
        sHex = sBig.toString(16).padStart(64, "0");
    }
    // Try both recovery IDs to find the correct one
    // Use recoverAddress instead of verifyMessage because messageHash
    // is already the EIP-191 prefixed hash. verifyMessage would hash it again.
    const normalizedPublicKey = publicKey.toLowerCase();
    // Track valid recovery IDs and reject if both work (malleability)
    let validRecoveryId = null;
    let validSig = null;
    for (const v of [27, 28]) {
        const sig = `0x${rHex}${sHex}${v.toString(16)}`;
        try {
            // recoverAddress expects the digest directly, not bytes
            const recovered = ethers_1.ethers
                .recoverAddress(messageHash, sig)
                .toLowerCase();
            if (recovered === normalizedPublicKey) {
                // Enforce signature uniqueness - only one recovery ID should work
                if (validRecoveryId !== null) {
                    throw new Error("SIGNATURE_MALLEABILITY: Both recovery IDs valid - possible attack");
                }
                validRecoveryId = v;
                validSig = sig;
            }
        }
        catch (e) {
            // Rethrow malleability errors
            if (e.message?.includes("SIGNATURE_MALLEABILITY")) {
                throw e;
            }
            // Try next recovery ID for other errors
            continue;
        }
    }
    if (validSig !== null) {
        return validSig;
    }
    throw new Error("RECOVERY_ID_FAILED: Could not recover correct public key");
}
exports.formatKMSSignature = formatKMSSignature;
/**
 * Validates that a signature matches the expected signer
 *
 * @param signature - RSV signature (0x prefixed)
 * @param messageHash - Message hash that was signed
 * @param expectedSigner - Expected signer address
 * @returns true if signature is valid for the expected signer
 */
function validateSignature(signature, messageHash, expectedSigner) {
    try {
        // Use recoverAddress instead of verifyMessage to avoid double EIP-191 prefix.
        // The messageHash is already a hash — verifyMessage would hash it again with EIP-191 prefix.
        const recovered = ethers_1.ethers.recoverAddress(messageHash, signature);
        return recovered.toLowerCase() === expectedSigner.toLowerCase();
    }
    catch {
        return false;
    }
}
exports.validateSignature = validateSignature;
/**
 * Sorts signatures by recovered signer address for smart contract verification
 *
 * @param signatures - Array of RSV signatures
 * @param messageHash - Message hash that was signed
 * @returns Signatures sorted by recovered signer address (ascending)
 */
function sortSignaturesBySignerAddress(signatures, messageHash) {
    const signerPairs = signatures.map((sig) => {
        // Use recoverAddress instead of verifyMessage (consistent with formatKMSSignature)
        const signer = ethers_1.ethers.recoverAddress(messageHash, sig);
        return { signature: sig, signer: signer.toLowerCase() };
    });
    signerPairs.sort((a, b) => {
        if (a.signer < b.signer)
            return -1;
        if (a.signer > b.signer)
            return 1;
        return 0;
    });
    return signerPairs.map((pair) => pair.signature);
}
exports.sortSignaturesBySignerAddress = sortSignaturesBySignerAddress;
//# sourceMappingURL=signer.js.map