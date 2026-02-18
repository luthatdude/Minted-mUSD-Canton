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
    ethereumAddress: string;
    bridgeContractAddress: string;
    pollIntervalMs: number;
    minCollateralRatioBps: number;
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
    private ledger;
    private cantonClient;
    private kmsClient;
    private signedAttestations;
    private readonly MAX_SIGNED_CACHE;
    private isRunning;
    constructor(config: ValidatorConfig);
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
    private sleep;
}
export { ValidatorNode, ValidatorConfig, CantonAssetClient };
//# sourceMappingURL=validator-node-v2.d.ts.map