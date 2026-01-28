/**
 * AWS KMS DER-to-RSV Signature Utility - Fixed Version
 * Fixes: T-01 (DER buffer overflow), T-02 (Input validation)
 */

import { ethers } from "ethers";

// secp256k1 curve order
const SECP256K1_N = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"
);

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
export function formatKMSSignature(
  derSig: Buffer,
  messageHash: string,
  publicKey: string
): string {
  // FIX T-02: Input validation
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

  // FIX T-01: Validate minimum DER length
  // Minimum DER signature: 30 + len + 02 + rLen + r + 02 + sLen + s
  // Minimum is around 8 bytes for structure + at least 1 byte each for r and s
  if (derSig.length < 8) {
    throw new Error("INVALID_DER: Signature too short");
  }

  // FIX T-01: Validate DER structure
  if (derSig[0] !== DER_SEQUENCE_TAG) {
    throw new Error("INVALID_DER: Missing sequence tag");
  }

  const totalLength = derSig[1];
  if (totalLength + 2 > derSig.length) {
    throw new Error("INVALID_DER: Length exceeds buffer");
  }

  // Parse R component
  if (derSig[2] !== DER_INTEGER_TAG) {
    throw new Error("INVALID_DER: Missing R integer tag");
  }

  const rLen = derSig[3];

  // FIX T-01: Bounds check for R
  if (4 + rLen > derSig.length) {
    throw new Error("INVALID_DER: R length exceeds buffer");
  }

  const r = derSig.subarray(4, 4 + rLen);

  // Parse S component
  const sTagIndex = 4 + rLen;
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

  // FIX T-01: Bounds check for S
  if (sStartIndex + sLen > derSig.length) {
    throw new Error("INVALID_DER: S length exceeds buffer");
  }

  const s = derSig.subarray(sStartIndex, sStartIndex + sLen);

  // Convert R to 32-byte hex (handle leading zeros in DER)
  let rHex = ethers.hexlify(r).replace("0x", "");
  // Remove leading zero if present (DER adds it for positive numbers with high bit set)
  if (rHex.length > 64 && rHex.startsWith("00")) {
    rHex = rHex.slice(2);
  }
  rHex = rHex.padStart(64, "0");

  if (rHex.length !== 64) {
    throw new Error("INVALID_DER: R component invalid length after normalization");
  }

  // Convert S to 32-byte hex
  let sHex = ethers.hexlify(s).replace("0x", "");
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
  const normalizedPublicKey = publicKey.toLowerCase();

  for (const v of [27, 28]) {
    const sig = `0x${rHex}${sHex}${v.toString(16)}`;
    try {
      const recovered = ethers
        .verifyMessage(ethers.getBytes(messageHash), sig)
        .toLowerCase();

      if (recovered === normalizedPublicKey) {
        return sig;
      }
    } catch {
      // Try next recovery ID
      continue;
    }
  }

  throw new Error("RECOVERY_ID_FAILED: Could not recover correct public key");
}

/**
 * Validates that a signature matches the expected signer
 *
 * @param signature - RSV signature (0x prefixed)
 * @param messageHash - Message hash that was signed
 * @param expectedSigner - Expected signer address
 * @returns true if signature is valid for the expected signer
 */
export function validateSignature(
  signature: string,
  messageHash: string,
  expectedSigner: string
): boolean {
  try {
    const recovered = ethers.verifyMessage(
      ethers.getBytes(messageHash),
      signature
    );
    return recovered.toLowerCase() === expectedSigner.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Sorts signatures by recovered signer address for smart contract verification
 *
 * @param signatures - Array of RSV signatures
 * @param messageHash - Message hash that was signed
 * @returns Signatures sorted by recovered signer address (ascending)
 */
export function sortSignaturesBySignerAddress(
  signatures: string[],
  messageHash: string
): string[] {
  const signerPairs = signatures.map((sig) => {
    const signer = ethers.verifyMessage(ethers.getBytes(messageHash), sig);
    return { signature: sig, signer: signer.toLowerCase() };
  });

  signerPairs.sort((a, b) => {
    if (a.signer < b.signer) return -1;
    if (a.signer > b.signer) return 1;
    return 0;
  });

  return signerPairs.map((pair) => pair.signature);
}
