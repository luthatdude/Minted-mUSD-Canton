/**
 * Unit tests for relay/signer.ts
 * Tests DER-to-RSV conversion, signature validation, and sorting.
 */

import { ethers } from "ethers";
import {
  formatKMSSignature,
  validateSignature,
  sortSignaturesBySignerAddress,
} from "../signer";

// ──────────────────────────────────────────────
// Helpers: generate a real signature we can round-trip
// ──────────────────────────────────────────────

function generateTestSignature() {
  const wallet = ethers.Wallet.createRandom();
  const messageHash = ethers.keccak256(ethers.toUtf8Bytes("test message"));

  // Sign and get RSV components
  const sig = wallet.signingKey.sign(messageHash);
  return { wallet, messageHash, sig };
}

/**
 * Build a minimal valid DER-encoded ECDSA signature from r and s hex strings.
 * This mimics what AWS KMS returns.
 */
function buildDerFromRSV(rHex: string, sHex: string): Buffer {
  // Remove 0x prefix if present
  rHex = rHex.replace("0x", "");
  sHex = sHex.replace("0x", "");

  // Convert to buffers
  let rBuf = Buffer.from(rHex, "hex");
  let sBuf = Buffer.from(sHex, "hex");

  // DER requires positive integers — add leading 0x00 if high bit is set
  if (rBuf[0] & 0x80) rBuf = Buffer.concat([Buffer.from([0x00]), rBuf]);
  if (sBuf[0] & 0x80) sBuf = Buffer.concat([Buffer.from([0x00]), sBuf]);

  // Build DER: 0x30 <len> 0x02 <rLen> <r> 0x02 <sLen> <s>
  const body = Buffer.concat([
    Buffer.from([0x02, rBuf.length]),
    rBuf,
    Buffer.from([0x02, sBuf.length]),
    sBuf,
  ]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

// ═══════════════════════════════════════════════
// formatKMSSignature
// ═══════════════════════════════════════════════

describe("formatKMSSignature", () => {
  it("should convert a valid DER signature to RSV format", () => {
    const { wallet, messageHash, sig } = generateTestSignature();
    const derSig = buildDerFromRSV(sig.r, sig.s);

    const rsv = formatKMSSignature(derSig, messageHash, wallet.address);

    expect(rsv).toMatch(/^0x[0-9a-f]{130}$/);
    // Recovered address should match
    const recovered = ethers.recoverAddress(messageHash, rsv);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it("should reject a Buffer that is too short", () => {
    expect(() =>
      formatKMSSignature(Buffer.from([0x30, 0x01]), "0xabc", "0xdef")
    ).toThrow("INVALID_DER");
  });

  it("should reject non-Buffer input", () => {
    expect(() =>
      formatKMSSignature("notabuffer" as any, "0xabc", "0xdef")
    ).toThrow("INVALID_INPUT");
  });

  it("should reject missing 0x prefix on messageHash", () => {
    expect(() =>
      formatKMSSignature(Buffer.alloc(70), "abc", "0xdef")
    ).toThrow("INVALID_INPUT: messageHash must be 0x prefixed");
  });

  it("should reject missing 0x prefix on publicKey", () => {
    expect(() =>
      formatKMSSignature(Buffer.alloc(70), "0xabc", "def")
    ).toThrow("INVALID_INPUT: publicKey must be 0x prefixed");
  });

  it("should reject DER with wrong sequence tag", () => {
    const bad = Buffer.alloc(70, 0);
    bad[0] = 0x31; // wrong tag
    expect(() => formatKMSSignature(bad, "0xabc", "0xdef")).toThrow(
      "INVALID_DER: Missing sequence tag"
    );
  });

  it("should reject DER where length exceeds buffer", () => {
    const bad = Buffer.from([0x30, 0xff, 0x02, 0x01, 0x00, 0x02, 0x01, 0x00]);
    expect(() => formatKMSSignature(bad, "0xabc", "0xdef")).toThrow(
      "INVALID_DER"
    );
  });

  it("should normalize high-S to low-S (EIP-2)", () => {
    const { wallet, messageHash, sig } = generateTestSignature();
    const SECP256K1_N = BigInt(
      "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"
    );

    // Force high-S
    let sBig = BigInt(sig.s);
    if (sBig <= SECP256K1_N / 2n) {
      sBig = SECP256K1_N - sBig;
    }
    const highS = "0x" + sBig.toString(16).padStart(64, "0");
    const derSig = buildDerFromRSV(sig.r, highS);

    const rsv = formatKMSSignature(derSig, messageHash, wallet.address);

    // The returned S should be in the low half
    const returnedS = BigInt("0x" + rsv.slice(66, 130));
    expect(returnedS <= SECP256K1_N / 2n).toBe(true);
  });
});

// ═══════════════════════════════════════════════
// validateSignature
// ═══════════════════════════════════════════════

describe("validateSignature", () => {
  it("should return true for a valid signature", () => {
    const wallet = ethers.Wallet.createRandom();
    const hash = ethers.keccak256(ethers.toUtf8Bytes("hello"));
    const sig = wallet.signingKey.sign(hash);
    const rsvSig = sig.serialized;

    expect(validateSignature(rsvSig, hash, wallet.address)).toBe(true);
  });

  it("should return false for a wrong signer", () => {
    const wallet = ethers.Wallet.createRandom();
    const other = ethers.Wallet.createRandom();
    const hash = ethers.keccak256(ethers.toUtf8Bytes("hello"));
    const sig = wallet.signingKey.sign(hash).serialized;

    expect(validateSignature(sig, hash, other.address)).toBe(false);
  });

  it("should return false for a corrupted signature", () => {
    expect(validateSignature("0x" + "00".repeat(65), "0x" + "ab".repeat(32), "0x" + "cd".repeat(20))).toBe(
      false
    );
  });
});

// ═══════════════════════════════════════════════
// sortSignaturesBySignerAddress
// ═══════════════════════════════════════════════

describe("sortSignaturesBySignerAddress", () => {
  it("should sort signatures by ascending signer address", () => {
    const wallets = [
      ethers.Wallet.createRandom(),
      ethers.Wallet.createRandom(),
      ethers.Wallet.createRandom(),
    ];
    const hash = ethers.keccak256(ethers.toUtf8Bytes("sort test"));

    const sigs = wallets.map((w) => w.signingKey.sign(hash).serialized);

    const sorted = sortSignaturesBySignerAddress(sigs, hash);

    // Recover addresses and verify they are sorted
    const recoveredAddrs = sorted.map((s) =>
      ethers.recoverAddress(hash, s).toLowerCase()
    );

    for (let i = 1; i < recoveredAddrs.length; i++) {
      expect(recoveredAddrs[i] >= recoveredAddrs[i - 1]).toBe(true);
    }
  });

  it("should handle a single signature", () => {
    const wallet = ethers.Wallet.createRandom();
    const hash = ethers.keccak256(ethers.toUtf8Bytes("single"));
    const sig = wallet.signingKey.sign(hash).serialized;

    const sorted = sortSignaturesBySignerAddress([sig], hash);
    expect(sorted).toHaveLength(1);
    expect(sorted[0]).toBe(sig);
  });

  it("should handle empty array", () => {
    const hash = ethers.keccak256(ethers.toUtf8Bytes("empty"));
    const sorted = sortSignaturesBySignerAddress([], hash);
    expect(sorted).toHaveLength(0);
  });
});
