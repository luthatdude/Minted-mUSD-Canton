/**
 * Minted Protocol - Canton to Ethereum Relay Service
 *
 * Watches Canton for finalized attestations and submits them to BLEBridgeV9 on Ethereum.
 *
 * Flow:
 *   1. Subscribe to Canton ledger via gRPC
 *   2. Watch for FinalizeAttestation exercises
 *   3. Fetch associated ValidatorSignature contracts
 *   4. Format signatures for Ethereum (RSV format)
 *   5. Submit to BLEBridgeV9.processAttestation()
 *   6. Track bridged attestations to prevent duplicates
 */
interface RelayConfig {
    cantonHost: string;
    cantonPort: number;
    cantonToken: string;
    cantonParty: string;
    ethereumRpcUrl: string;
    bridgeContractAddress: string;
    treasuryAddress: string;
    relayerPrivateKey: string;
    validatorAddresses: Record<string, string>;
    pollIntervalMs: number;
    maxRetries: number;
    confirmations: number;
    triggerAutoDeploy: boolean;
}
declare class RelayService {
    private config;
    private ledger;
    private provider;
    private wallet;
    private bridgeContract;
    private processedAttestations;
    private readonly MAX_PROCESSED_CACHE;
    private isRunning;
    constructor(config: RelayConfig);
    /**
     * Start the relay service
     */
    start(): Promise<void>;
    /**
     * FIX B-C03: Validate that all configured validator addresses have VALIDATOR_ROLE on-chain
     * This prevents signature forgery via config injection attacks
     */
    private validateValidatorAddresses;
    /**
     * Stop the relay service
     */
    stop(): void;
    /**
     * Load attestation IDs that have already been processed on-chain
     */
    private loadProcessedAttestations;
    private static readonly MAX_BATCH_SIZE;
    /**
     * Poll Canton for finalized attestations ready to bridge
     * FIX M-06: Added pagination to prevent memory exhaustion on large backlogs.
     * Processes up to MAX_BATCH_SIZE attestations per cycle, prioritizing by nonce.
     */
    private pollForAttestations;
    /**
     * Fetch ValidatorSignature contracts for an attestation
     */
    private fetchValidatorSignatures;
    /**
     * Submit attestation to Ethereum
     */
    private bridgeAttestation;
    /**
     * Build the message hash that validators signed
     */
    private buildMessageHash;
    /**
     * Format validator signatures for Ethereum
     * FIX IC-08: Pre-verify signatures using ecrecover before submitting to chain
     */
    private formatSignatures;
    /**
     * Sleep helper
     */
    private sleep;
    /**
     * Trigger Treasury auto-deploy to yield strategies after bridge-in
     */
    private triggerYieldDeploy;
}
export { RelayService, RelayConfig };
//# sourceMappingURL=relay-service.d.ts.map