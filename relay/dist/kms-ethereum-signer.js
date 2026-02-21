"use strict";
/**
 * AWS KMS-based Ethereum Transaction Signer
 *
 * Replaces raw private key loading for Ethereum transaction signing.
 * The private key NEVER enters Node.js memory — all signing is performed
 * inside the KMS HSM boundary.
 *
 * Usage:
 *   const signer = await KMSEthereumSigner.create(kmsKeyId, region, provider);
 *   const tx = await signer.sendTransaction({ to, value, data });
 *
 * Architecture:
 *   - Uses AWS KMS asymmetric key (ECC_SECG_P256K1 / secp256k1)
 *   - Signs raw transaction digests via KMS Sign API
 *   - Converts DER-encoded KMS signatures to Ethereum RSV format
 *   - Derives Ethereum address from KMS public key (no private key needed)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createEthereumSigner = exports.KMSEthereumSigner = void 0;
const client_kms_1 = require("@aws-sdk/client-kms");
const ethers_1 = require("ethers");
const signer_1 = require("./signer");
class KMSEthereumSigner extends ethers_1.ethers.AbstractSigner {
    kmsClient;
    kmsKeyId;
    region;
    _address = "";
    provider;
    constructor(kmsKeyId, region, provider) {
        super(provider);
        this.kmsKeyId = kmsKeyId;
        this.region = region;
        this.provider = provider;
        this.kmsClient = new client_kms_1.KMSClient({ region });
    }
    /**
     * Factory method — derives Ethereum address from KMS public key
     */
    static async create(kmsKeyId, region, provider) {
        const signer = new KMSEthereumSigner(kmsKeyId, region, provider);
        await signer._deriveAddress();
        return signer;
    }
    /**
     * Derive Ethereum address from KMS public key
     */
    async _deriveAddress() {
        const command = new client_kms_1.GetPublicKeyCommand({ KeyId: this.kmsKeyId });
        const response = await this.kmsClient.send(command);
        if (!response.PublicKey) {
            throw new Error("KMS returned no public key");
        }
        // KMS returns DER-encoded SubjectPublicKeyInfo
        // Parse to extract the raw 65-byte uncompressed public key
        const derKey = Buffer.from(response.PublicKey);
        // SubjectPublicKeyInfo for secp256k1: last 65 bytes are the uncompressed point
        // Format: 0x04 || x (32 bytes) || y (32 bytes)
        const uncompressedKey = derKey.slice(-65);
        if (uncompressedKey[0] !== 0x04) {
            throw new Error("Expected uncompressed public key (0x04 prefix)");
        }
        // Ethereum address = last 20 bytes of keccak256(public_key_without_04_prefix)
        const publicKeyBytes = uncompressedKey.slice(1); // Remove 0x04 prefix
        const hash = ethers_1.ethers.keccak256(new Uint8Array(publicKeyBytes));
        this._address = ethers_1.ethers.getAddress("0x" + hash.slice(-40));
        console.log(`[KMSSigner] Derived Ethereum address: ${this._address}`);
    }
    async getAddress() {
        return this._address;
    }
    connect(provider) {
        // HIGH-01 FIX: Preserve AWS region on provider reconnect (was hardcoded to "")
        return new KMSEthereumSigner(this.kmsKeyId, this.region, provider);
    }
    /**
     * Sign a message digest using KMS
     */
    async signMessage(message) {
        const messageBytes = typeof message === "string"
            ? ethers_1.ethers.toUtf8Bytes(message)
            : message;
        const hash = ethers_1.ethers.hashMessage(messageBytes);
        return this._signDigest(hash);
    }
    /**
     * Sign a typed data hash using KMS
     */
    async signTypedData(domain, types, value) {
        const hash = ethers_1.ethers.TypedDataEncoder.hash(domain, types, value);
        return this._signDigest(hash);
    }
    /**
     * Sign a transaction using KMS
     */
    async signTransaction(tx) {
        const resolvedTx = await this.populateTransaction(tx);
        const unsignedTx = ethers_1.ethers.Transaction.from(resolvedTx);
        const txHash = unsignedTx.unsignedHash;
        const signature = await this._signDigest(txHash);
        const sig = ethers_1.ethers.Signature.from(signature);
        unsignedTx.signature = sig;
        return unsignedTx.serialized;
    }
    /**
     * Core signing — sends digest to KMS, converts DER→RSV
     */
    async _signDigest(digest) {
        const digestBytes = new Uint8Array(Buffer.from(digest.slice(2), "hex"));
        const command = new client_kms_1.SignCommand({
            KeyId: this.kmsKeyId,
            Message: digestBytes,
            MessageType: "DIGEST",
            SigningAlgorithm: "ECDSA_SHA_256",
        });
        const response = await this.kmsClient.send(command);
        if (!response.Signature) {
            throw new Error("KMS returned no signature");
        }
        const derSignature = Buffer.from(response.Signature);
        // Convert DER to RSV format using existing signer utility
        // This handles S-value normalization (EIP-2) and recovery ID computation
        return (0, signer_1.formatKMSSignature)(derSignature, digest, this._address);
    }
}
exports.KMSEthereumSigner = KMSEthereumSigner;
/**
 * Create an Ethereum signer — uses KMS if kmsKeyId is configured,
 * falls back to raw private key (development only).
 *
 * In production, require KMS to prevent private key exposure in memory.
 */
async function createEthereumSigner(config, provider) {
    // Prefer KMS signing (no private key in memory)
    if (config.kmsKeyId) {
        console.log("[Signer] Using AWS KMS for Ethereum transaction signing (key never in memory)");
        return KMSEthereumSigner.create(config.kmsKeyId, config.awsRegion || "us-east-1", provider);
    }
    // TS-M-02: In production, KMS is REQUIRED — raw private key signing is forbidden
    if (process.env.NODE_ENV === "production") {
        throw new Error("SECURITY: KMS key is required in production — raw private key signing is not allowed. " +
            "Set RELAYER_KMS_KEY_ID to use AWS KMS instead (H-07).");
    }
    // Fallback to raw key — development/staging only
    if (!config.privateKey) {
        throw new Error("Either KMS_KEY_ID or private key must be configured");
    }
    const wallet = new ethers_1.ethers.Wallet(config.privateKey, provider);
    // Zero out the private key string from config after wallet creation
    // This reduces the window where the key is readable in memory
    if (config.privateKey) {
        // Overwrite the string reference (doesn't guarantee V8 GC, but reduces exposure)
        config.privateKey = "0".repeat(64);
    }
    return wallet;
}
exports.createEthereumSigner = createEthereumSigner;
//# sourceMappingURL=kms-ethereum-signer.js.map