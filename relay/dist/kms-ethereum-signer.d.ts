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
import { ethers } from "ethers";
export declare class KMSEthereumSigner extends ethers.AbstractSigner {
    private kmsClient;
    private kmsKeyId;
    private region;
    private _address;
    provider: ethers.Provider;
    private constructor();
    /**
     * Factory method — derives Ethereum address from KMS public key
     */
    static create(kmsKeyId: string, region: string, provider: ethers.Provider): Promise<KMSEthereumSigner>;
    /**
     * Derive Ethereum address from KMS public key
     */
    private _deriveAddress;
    getAddress(): Promise<string>;
    connect(provider: ethers.Provider): KMSEthereumSigner;
    /**
     * Sign a message digest using KMS
     */
    signMessage(message: string | Uint8Array): Promise<string>;
    /**
     * Sign a typed data hash using KMS
     */
    signTypedData(domain: ethers.TypedDataDomain, types: Record<string, ethers.TypedDataField[]>, value: Record<string, any>): Promise<string>;
    /**
     * Sign a transaction using KMS
     */
    signTransaction(tx: ethers.TransactionRequest): Promise<string>;
    /**
     * Core signing — sends digest to KMS, converts DER→RSV
     */
    private _signDigest;
}
/**
 * Create an Ethereum signer — uses KMS if kmsKeyId is configured,
 * falls back to raw private key (development only).
 *
 * In production, require KMS to prevent private key exposure in memory.
 */
export declare function createEthereumSigner(config: {
    kmsKeyId?: string;
    awsRegion?: string;
    privateKey?: string;
}, provider: ethers.Provider): Promise<ethers.Signer>;
//# sourceMappingURL=kms-ethereum-signer.d.ts.map