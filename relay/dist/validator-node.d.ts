/**
 * Minted Protocol - Canton Validator Node
 *
 * Watches for AttestationRequest contracts and signs them using AWS KMS.
 *
 * Flow:
 *   1. Subscribe to Canton ledger
 *   2. Watch for new AttestationRequest contracts
 *   3. Verify collateral requirements
 *   4. Sign with AWS KMS
 *   5. Submit ValidatorSignature to Canton
 */
interface ValidatorConfig {
    cantonHost: string;
    cantonPort: number;
    cantonToken: string;
    validatorParty: string;
    awsRegion: string;
    kmsKeyId: string;
    ethereumAddress: string;
    pollIntervalMs: number;
    minCollateralRatioBps: number;
}
declare class ValidatorNode {
    private config;
    private ledger;
    private kmsClient;
    private signedAttestations;
    private readonly MAX_SIGNED_CACHE;
    private isRunning;
    private ethereumProvider;
    private verifiedBridgeCodeHash;
    constructor(config: ValidatorConfig);
    /**
     * Start the validator node
     */
    start(): Promise<void>;
    /**
     * Stop the validator node
     */
    stop(): void;
    /**
     * FIX B-C06: Verify bridge contract exists and has expected code
     * This prevents signing attestations for malicious/wrong contracts
     */
    private verifyBridgeContract;
    /**
     * Poll for attestation requests that need signing
     * FIX B-H05: Added query timeout to prevent indefinite hangs
     */
    private pollForAttestations;
    /**
     * Verify the attestation has sufficient collateral backing
     */
    private verifyCollateral;
    /**
     * Sign attestation and submit to Canton
     */
    private signAttestation;
    /**
     * Build the message hash for signing
     */
    private buildMessageHash;
    /**
     * Sign a message hash using AWS KMS
     */
    private signWithKMS;
    /**
     * Convert DER-encoded signature to RSV format
     * Uses the logic from signer.ts
     */
    private derToRsv;
    /**
     * Sleep helper
     */
    private sleep;
}
export { ValidatorNode, ValidatorConfig };
//# sourceMappingURL=validator-node.d.ts.map