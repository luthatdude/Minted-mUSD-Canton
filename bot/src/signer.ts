/**
 * Bot Ethereum Signer Factory — KMS-backed signing for production
 *
 * Provides createBotSigner() which uses AWS KMS in production and
 * falls back to raw private keys in development/test only.
 *
 * This is a self-contained port of the relay's KMSEthereumSigner so
 * the bot package can be deployed independently without cross-importing
 * from relay/.
 *
 * TS-H-01 FIX: Replaces the broken createSigner() stub that threw
 * "KMS AbstractSigner integration is not yet implemented".
 */

import { ethers } from "ethers";
import * as fs from "fs";

// ─── secp256k1 curve order for key validation ────────────────
const SECP256K1_N = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"
);

// ─── Secret / key helpers ────────────────────────────────────

export function readSecret(name: string, envVar: string): string {
  const secretPath = `/run/secrets/${name}`;
  try {
    if (fs.existsSync(secretPath)) {
      return fs.readFileSync(secretPath, "utf-8").trim();
    }
  } catch {
    /* fall through to env var */
  }
  return process.env[envVar] || "";
}

export function readAndValidatePrivateKey(secretName: string, envVar: string): string {
  const key = readSecret(secretName, envVar);
  if (!key) return "";
  const normalized = key.startsWith("0x") ? key.slice(2) : key;
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`SECURITY: ${envVar} is not a valid private key (expected 64 hex chars)`);
  }
  const keyValue = BigInt("0x" + normalized);
  if (keyValue === 0n || keyValue >= SECP256K1_N) {
    throw new Error(`SECURITY: ${envVar} is out of valid secp256k1 range [1, n-1]`);
  }
  // Scrub env var after reading
  if (process.env[envVar] && process.env.NODE_ENV !== "test") {
    process.env[envVar] = "0".repeat(64);
  }
  return key;
}

// ─── AWS KMS Ethereum Signer ─────────────────────────────────

/**
 * Full AWS KMS AbstractSigner implementation.
 * Private key NEVER enters Node.js memory — all signing is performed
 * inside the KMS HSM boundary.
 */
class KMSEthereumSigner extends ethers.AbstractSigner {
  private kmsClient: any; // KMSClient (lazy-imported)
  private kmsKeyId: string;
  private region: string;
  private _address: string = "";
  provider: ethers.Provider;

  private constructor(kmsKeyId: string, region: string, provider: ethers.Provider) {
    super(provider);
    this.kmsKeyId = kmsKeyId;
    this.region = region;
    this.provider = provider;
  }

  static async create(
    kmsKeyId: string,
    region: string,
    provider: ethers.Provider
  ): Promise<KMSEthereumSigner> {
    const signer = new KMSEthereumSigner(kmsKeyId, region, provider);
    // Dynamic import: @aws-sdk/client-kms only required when KMS is actually used
    const { KMSClient, GetPublicKeyCommand } = await import("@aws-sdk/client-kms");
    signer.kmsClient = new KMSClient({ region });
    // Derive Ethereum address from KMS public key
    const resp = await signer.kmsClient.send(new GetPublicKeyCommand({ KeyId: kmsKeyId }));
    if (!resp.PublicKey) throw new Error("KMS returned no public key");
    const derKey = Buffer.from(resp.PublicKey);
    const uncompressedKey = derKey.slice(-65);
    if (uncompressedKey[0] !== 0x04) {
      throw new Error("Expected uncompressed public key (0x04 prefix)");
    }
    const publicKeyBytes = uncompressedKey.slice(1);
    const hash = ethers.keccak256(new Uint8Array(publicKeyBytes));
    signer._address = ethers.getAddress("0x" + hash.slice(-40));
    console.log(`[KMS] Bot signer address: ${signer._address}`);
    return signer;
  }

  async getAddress(): Promise<string> {
    return this._address;
  }

  connect(provider: ethers.Provider): KMSEthereumSigner {
    const copy = new KMSEthereumSigner(this.kmsKeyId, this.region, provider);
    copy.kmsClient = this.kmsClient;
    copy._address = this._address;
    return copy;
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    const messageBytes = typeof message === "string" ? ethers.toUtf8Bytes(message) : message;
    const hash = ethers.hashMessage(messageBytes);
    return this._signDigest(hash);
  }

  async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, ethers.TypedDataField[]>,
    value: Record<string, any>
  ): Promise<string> {
    const hash = ethers.TypedDataEncoder.hash(domain, types, value);
    return this._signDigest(hash);
  }

  async signTransaction(tx: ethers.TransactionRequest): Promise<string> {
    const resolvedTx = await this.populateTransaction(tx);
    const unsignedTx = ethers.Transaction.from(resolvedTx);
    const txHash = unsignedTx.unsignedHash;
    const signature = await this._signDigest(txHash);
    const sig = ethers.Signature.from(signature);
    unsignedTx.signature = sig;
    return unsignedTx.serialized;
  }

  /**
   * Core signing — sends digest to KMS, converts DER→Ethereum RSV format.
   */
  private async _signDigest(digest: string): Promise<string> {
    const { SignCommand } = await import("@aws-sdk/client-kms");
    const digestBytes = new Uint8Array(Buffer.from(digest.slice(2), "hex"));

    const response = await this.kmsClient.send(
      new SignCommand({
        KeyId: this.kmsKeyId,
        Message: digestBytes,
        MessageType: "DIGEST",
        SigningAlgorithm: "ECDSA_SHA_256",
      })
    );

    if (!response.Signature) throw new Error("KMS returned no signature");

    const derSignature = Buffer.from(response.Signature);
    return this._derToRSV(derSignature, digest);
  }

  /**
   * Convert DER-encoded ECDSA signature to Ethereum RSV format.
   * Handles S-value normalization (EIP-2) and recovery ID computation.
   */
  private _derToRSV(der: Buffer, digest: string): string {
    // Parse DER: 0x30 <len> 0x02 <rLen> <r> 0x02 <sLen> <s>
    let offset = 2; // skip 0x30 + total length
    if (der[offset] !== 0x02) throw new Error("Invalid DER: expected 0x02 for R");
    offset++;
    const rLen = der[offset++];
    let r = der.slice(offset, offset + rLen);
    offset += rLen;
    if (der[offset] !== 0x02) throw new Error("Invalid DER: expected 0x02 for S");
    offset++;
    const sLen = der[offset++];
    let s = der.slice(offset, offset + sLen);

    // Strip leading zero padding from DER encoding
    if (r.length === 33 && r[0] === 0) r = r.slice(1);
    if (s.length === 33 && s[0] === 0) s = s.slice(1);

    // Pad to 32 bytes
    const rHex = r.toString("hex").padStart(64, "0");
    let sBigInt = BigInt("0x" + s.toString("hex"));

    // EIP-2: S must be in lower half of curve order
    const halfN = SECP256K1_N / 2n;
    if (sBigInt > halfN) {
      sBigInt = SECP256K1_N - sBigInt;
    }
    const sHex = sBigInt.toString(16).padStart(64, "0");

    // Try both recovery IDs (27, 28) to find the correct one
    for (const v of [27, 28]) {
      const sigHex = `0x${rHex}${sHex}${v.toString(16).padStart(2, "0")}`;
      try {
        const recovered = ethers.recoverAddress(digest, sigHex);
        if (recovered.toLowerCase() === this._address.toLowerCase()) {
          return sigHex;
        }
      } catch {
        continue;
      }
    }
    throw new Error("Failed to determine recovery ID for KMS signature");
  }
}

// ─── Public factory function ─────────────────────────────────

/**
 * Create an Ethereum signer for bot services.
 *
 * - If KMS_KEY_ID is set → uses AWS KMS (private key never in memory)
 * - If NODE_ENV=production and no KMS → throws (raw keys forbidden)
 * - Otherwise → falls back to raw private key (dev/test only)
 *
 * @param provider  JSON-RPC provider to attach signer to
 * @param secretName  Docker secret name (e.g. "bot_private_key")
 * @param envVar  Environment variable fallback (e.g. "PRIVATE_KEY")
 * @param kmsKeyIdEnv  Override KMS key ID env var (default: "KMS_KEY_ID")
 */
export async function createBotSigner(
  provider: ethers.Provider,
  secretName: string,
  envVar: string,
  kmsKeyIdEnv: string = "KMS_KEY_ID",
): Promise<ethers.Signer> {
  const kmsKeyId = process.env[kmsKeyIdEnv] || readSecret("kms_key_id", kmsKeyIdEnv);

  if (kmsKeyId) {
    console.log(`[Signer] Using AWS KMS for ${envVar} (key never in memory)`);
    return KMSEthereumSigner.create(
      kmsKeyId,
      process.env.AWS_REGION || "us-east-1",
      provider,
    );
  }

  // In production, KMS is REQUIRED
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `SECURITY: KMS is required in production for ${envVar}. ` +
      `Set ${kmsKeyIdEnv} and AWS_REGION environment variables. ` +
      `Raw private key signing is forbidden — keys persist in V8 heap memory.`
    );
  }

  // Development fallback — raw private key
  const key = readAndValidatePrivateKey(secretName, envVar);
  if (!key) {
    throw new Error(`FATAL: Neither ${kmsKeyIdEnv} nor ${envVar} is configured`);
  }

  console.warn(
    `[SECURITY] Using raw private key for ${envVar} — acceptable in ${process.env.NODE_ENV || "development"} only`,
  );

  return new ethers.Wallet(key, provider);
}
