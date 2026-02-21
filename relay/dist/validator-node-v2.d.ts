/**
 * Minted Protocol - Canton Validator Node V2
 *
 * KEY CHANGE: Validators query Canton Network's actual tokenized asset ledger,
 * NOT manually-updated DAML contracts.
 *
 * Flow:
 *   1. Watch for AttestationRequest contracts on Canton
 *   2. Query Canton Network API for actual tokenized asset values
 *   3. Verify attestation payload matches Canton's state
 *   4. Sign with AWS KMS if valid
 *   5. Submit ValidatorSignature to Canton
 *
 * This allows Canton to choose which assets back mUSD.
 */
interface ValidatorConfig {
    cantonLedgerHost: string;
    cantonLedgerPort: number;
    cantonLedgerToken: string;
    validatorParty: string;
    cantonAssetApiUrl: string;
    cantonAssetApiKey: string;
    awsRegion: string;
    kmsKeyId: string;
    kmsRotationKeyId: string;
    kmsKeyRotationEnabled: boolean;
    ethereumAddress: string;
    rotationEthereumAddress: string;
    bridgeContractAddress: string;
    pollIntervalMs: number;
    minCollateralRatioBps: number;
    allowedTemplates: string[];
}
interface CantonAsset {
    assetId: string;
    category: "Equity" | "FixedIncome" | "RealEstate" | "Commodities" | "CashEquivalent";
    issuerName: string;
    currentValue: bigint;
    lastUpdated: string;
}
interface CantonAssetSnapshot {
    snapshotId: string;
    timestamp: string;
    assets: CantonAsset[];
    totalValue: bigint;
    stateHash: string;
}
declare class CantonAssetClient {
    private apiUrl;
    private apiKey;
    constructor(apiUrl: string, apiKey: string);
    /**
     * Fetch current snapshot of all tokenized assets from Canton Network
     * INFRA-H-06: All external API calls use HTTPS with certificate validation
     * enforced by enforceTLSSecurity() at process level
     */
    getAssetSnapshot(): Promise<CantonAssetSnapshot>;
    /**
     * Fetch specific assets by ID
     */
    getAssetsByIds(assetIds: string[]): Promise<CantonAsset[]>;
    /**
     * Verify a state hash matches Canton's current state
     */
    verifyStateHash(stateHash: string): Promise<boolean>;
}
declare class ValidatorNode {
    private config;
    private canton;
    private cantonAssetClient;
    private kmsClient;
    private signedAttestations;
    private readonly MAX_SIGNED_CACHE;
    private isRunning;
    private signingTimestamps;
    private readonly MAX_SIGNS_PER_WINDOW;
    private readonly SIGNING_WINDOW_MS;
    private lastSignedTotalValue;
    private readonly MAX_VALUE_JUMP_BPS;
    private activeKmsKeyId;
    private activeEthAddress;
    private rotationInProgress;
    constructor(config: ValidatorConfig);
    /**
     * Switch to rotation key for zero-downtime key rotation
     *
     * Key rotation flow:
     *   1. Generate new KMS key, get its ETH address
     *   2. Grant VALIDATOR_ROLE to new address on BLEBridgeV9 (via timelock)
     *   3. Set KMS_ROTATION_KEY_ID + ROTATION_ETH_ADDRESS + KMS_KEY_ROTATION_ENABLED=true
     *   4. Call activateRotationKey() — starts signing with new key
     *   5. Verify signatures working, then revoke old key's VALIDATOR_ROLE
     *   6. Promote: move rotation key to primary config, clear rotation fields
     */
    activateRotationKey(): Promise<void>;
    /**
     * Get current active key status
     */
    getKeyStatus(): {
        activeKeyId: string;
        activeEthAddress: string;
        rotationAvailable: boolean;
    };
    start(): Promise<void>;
    stop(): void;
    private pollForAttestations;
    /**
     * CRITICAL: Verify attestation payload against Canton Network's actual asset state
     */
    private verifyAgainstCanton;
    private signAttestation;
    private buildMessageHash;
    private signWithKMS;
    /**
     * Sign with a specific KMS key
     * Used for both normal signing and rotation key testing
     */
    private signWithKMSKey;
    private sleep;
}
export { ValidatorNode, ValidatorConfig, CantonAssetClient };
//# sourceMappingURL=validator-node-v2.d.ts.map