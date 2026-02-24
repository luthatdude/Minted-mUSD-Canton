/**
 * Minted Protocol - Bidirectional Canton-Ethereum Relay Service
 *
 * Direction 1 (Canton → Ethereum):
 *   1. Poll Canton for finalized AttestationRequest contracts
 *   2. Verify sufficient ECDSA signatures collected
 *   3. Submit to BLEBridgeV9.processAttestation() on Ethereum
 *
 * Direction 2 (Ethereum → Canton):
 *   1. Watch for BridgeToCantonRequested events on BLEBridgeV9
 *   2. Create BridgeInRequest contract on Canton
 *   3. Exercise Bridge_ReceiveFromEthereum on BridgeService
 */
import { RecipientEthAddressMap, RecipientPartyAliasMap } from "./recipient-routing";
interface RelayConfig {
    cantonHost: string;
    cantonPort: number;
    cantonToken: string;
    cantonParty: string;
    ethereumRpcUrl: string;
    bridgeContractAddress: string;
    treasuryAddress: string;
    metaVault3Address: string;
    musdTokenAddress: string;
    /** @deprecated SEC-GATE-01: Use relayerKmsKeyId instead. Raw keys forbidden on mainnet. */
    relayerPrivateKey: string;
    /** AWS KMS key ARN for Ethereum transaction signing (key never in memory) */
    relayerKmsKeyId: string;
    /** AWS region for KMS */
    awsRegion: string;
    validatorAddresses: Record<string, string>;
    recipientPartyAliases: RecipientPartyAliasMap;
    redemptionRecipientAddresses: RecipientEthAddressMap;
    pollIntervalMs: number;
    maxRetries: number;
    confirmations: number;
    triggerAutoDeploy: boolean;
    autoAcceptMusdTransferProposals: boolean;
    fallbackRpcUrls: string[];
    yieldDistributorAddress: string;
    ethPoolYieldDistributorAddress: string;
    cantonGovernanceParty: string;
    stateFilePath: string;
    replayLookbackBlocks: number;
    maxRedemptionEthPayoutWei: bigint;
    autoGrantBridgeRoleForRedemptions: boolean;
    bootstrapLedgerContracts: boolean;
    cantonRegulatorParty: string;
    cantonDirectMintServiceName: string;
    cantonUsdcIssuer: string;
    cantonUsdcxIssuer: string;
    cantonMpaHash: string;
    cantonMpaUri: string;
}
declare class RelayService {
    private config;
    private canton;
    private provider;
    private wallet;
    private bridgeContract;
    private musdTokenContract;
    private processedAttestations;
    private readonly MAX_PROCESSED_CACHE;
    private isRunning;
    private processedBridgeOuts;
    private lastScannedBlock;
    private yieldDistributorContract;
    private processedYieldEpochs;
    private lastYieldScannedBlock;
    private ethPoolYieldDistributorContract;
    private processedETHPoolYieldEpochs;
    private lastETHPoolYieldScannedBlock;
    private processedRedemptionRequests;
    private cip56TransferFactoryCid;
    private cip56FactoryLastChecked;
    private static readonly CIP56_FACTORY_REFRESH_MS;
    private static readonly ATTESTATION_TTL_SECONDS;
    private static readonly MAX_TIMESTAMP_DRIFT_SECONDS;
    private fallbackProviders;
    private activeProviderIndex;
    private consecutiveFailures;
    private readonly MAX_CONSECUTIVE_FAILURES;
    private static readonly DIRECTION_NAMES;
    private static readonly MAX_DIRECTION_FAILURES;
    private static readonly DEGRADED_POLL_INTERVAL;
    private static readonly FAILED_POLL_INTERVAL;
    private static readonly ORPHAN_RECOVERY_INTERVAL;
    private directionHealth;
    private pollCycleCount;
    private rateLimiter;
    private anomalyDetector;
    private submittedNonces;
    private inFlightAttestations;
    private lastVaultRoleWarningAt;
    private lastRedemptionBacklogLogAt;
    private lastRedemptionBacklogSize;
    private lastRedemptionFulfillmentWarningAt;
    private redemptionSettlementMarkerSupported;
    private warnedRedemptionMarkerUnavailable;
    private static readonly DIAGNOSTIC_LOG_INTERVAL_MS;
    constructor(config: RelayConfig);
    private cantonBaseUrl;
    private createCantonClientForParty;
    /**
     * Ensure required bootstrap contracts exist on Canton.
     * Safe to call every startup; creation is query-first and idempotent.
     */
    private ensureLedgerContracts;
    private ensureComplianceRegistry;
    private ensureDirectMintService;
    /**
     * Initialize Ethereum signer (KMS or raw key)
     * Must be called before start()
     */
    initSigner(): Promise<void>;
    /**
     * Shape of the persisted relay state file.
     * Stores processed IDs and last scanned block numbers
     * so the relay can survive restarts without re-processing events.
     */
    private static readonly STATE_VERSION;
    /**
     * Load persisted state from disk on startup.
     * Merges with in-memory state (chain-scanned data takes priority).
     */
    private loadPersistedState;
    /**
     * Persist current relay state to disk.
     * Called after each successful epoch/attestation processing.
     * Uses atomic write (write to temp file, then rename) to prevent corruption.
     */
    private persistState;
    /**
     * Start the relay service
     */
    start(): Promise<void>;
    /**
     * Validate that all configured validator addresses have VALIDATOR_ROLE on-chain
     * This prevents signature forgery via config injection attacks
     */
    private validateValidatorAddresses;
    /**
     * Switch to the next fallback RPC provider on consecutive failures.
     * Re-initializes the signer against the new provider so all subsequent
     * contract calls go through the healthy endpoint.
     */
    private switchToFallbackProvider;
    /**
     * Stop the relay service
     */
    stop(): void;
    /** Sync in-memory relay state into exported Prometheus gauges. */
    private updateMetricsSnapshot;
    private shouldPollDirection;
    private isPermanentDirectionError;
    private recordDirectionFailure;
    private recordDirectionSuccess;
    /**
     * Check if a transaction is allowed under rate limits.
     * Returns true if allowed, false if rate-limited.
     */
    private checkRateLimit;
    /**
     * Record a successful transaction submission for rate limiting
     */
    private recordTxSubmission;
    /**
     * Check for anomalies and auto-pause the bridge if thresholds are exceeded.
     * Called before each attestation submission.
     *
     * Anomaly triggers:
     *   1. Supply cap change > maxCapChangePct% in a single attestation
     *   2. Too many consecutive tx reverts (possible attack or contract issue)
     */
    private checkForAnomalies;
    /**
     * Record a transaction revert and check consecutive revert threshold
     */
    private recordRevert;
    /**
     * Reset consecutive revert counter on successful transaction
     */
    private recordSuccess;
    /**
     * Trigger emergency pause on the bridge contract.
     * Requires the relay signer to hold EMERGENCY_ROLE.
     */
    private triggerEmergencyPause;
    /**
     * Check if a nonce has already been submitted by this relay instance.
     * Complements the on-chain `currentNonce + 1` check with in-flight dedup.
     */
    private checkNonceReplay;
    /**
     * Mark a nonce and attestation as submitted (in-flight)
     */
    private markNonceSubmitted;
    /**
     * Clear only the in-flight marker after a successful confirmation.
     * Keep nonce in submittedNonces to avoid duplicate same-process submissions.
     */
    private clearInFlightAttestation;
    /**
     * Roll back nonce and attestation in-flight markers when submission fails.
     * This allows safe retries after local/provider/tx failure paths.
     */
    private unmarkNonceSubmitted;
    /**
     * Redact sensitive data from log output.
     * Masks private keys, API keys, and bearer tokens.
     */
    private static redact;
    /**
     * Load attestation IDs that have already been processed on-chain
     */
    private loadProcessedAttestations;
    private static readonly MAX_BATCH_SIZE;
    /**
     * Poll Canton for finalized attestations ready to bridge
     * Added pagination to prevent memory exhaustion on large backlogs.
     * Processes up to MAX_BATCH_SIZE attestations per cycle, prioritizing by nonce.
     */
    private pollForAttestations;
    /**
     * Load bridge-out request IDs that have already been relayed to Canton
     */
    private buildBridgeInRequestDedupKey;
    private parseBridgeInRequestDedupKeyFromPayload;
    private buildBridgeInRequestDedupIndex;
    private buildBridgeInRequestCandidateKeys;
    private loadProcessedBridgeOuts;
    /**
     * Watch Ethereum for BridgeToCantonRequested events and relay to Canton.
     *
     * For each new event:
     *   1. Verify the event hasn't been processed yet
     *   2. Wait for sufficient confirmations
     *   3. Create a BridgeInRequest contract on Canton
     *   4. Exercise Bridge_ReceiveFromEthereum on BridgeService (if attestation exists)
     */
    private watchEthereumBridgeOut;
    /**
     * Complete a pending BridgeInRequest and mint CantonMUSD for the user.
     *
     * Steps:
     *   1. Find the pending BridgeInRequest contract by nonce
     *   2. Exercise BridgeIn_Complete to mark it as "completed"
     *   3. Create a CantonMUSD token owned by the user (or operator if fallback)
     *
     * @param nonce       Bridge nonce to complete
     * @param amountStr   mUSD amount as a string (e.g., "50.0")
     * @param userParty   Canton party to own the minted CantonMUSD
     */
    private refreshCip56FactoryCid;
    private completeBridgeInAndMintMusd;
    /**
     * Process any pending BridgeInRequests that haven't been completed yet.
     * Called on startup to catch up on any missed completions.
     */
    private processPendingBridgeInRequests;
    private resolveRecipientFromEthereumNonce;
    private recoverOrphanedMusd;
    /**
     * Load already-processed yield epochs from chain to prevent replay on restart.
     */
    private loadProcessedYieldBridgeIns;
    /**
     * Watch for CantonYieldBridged events from YieldDistributor and credit
     * Canton staking pool via ReceiveYield.
     *
     * Flow:
     *   1. Scan for new CantonYieldBridged events (YieldDistributor → BLEBridge → burn)
     *   2. Create CantonMUSD on Canton (operator-owned, yield amount)
     *   3. Query CantonStakingService to get its contractId
     *   4. Exercise ReceiveYield with the minted CantonMUSD → pool grows → share price ↑
     */
    private processYieldBridgeIn;
    /**
     * Exercise ReceiveYield on CantonStakingService to credit the staking pool.
     */
    private creditCantonStakingPool;
    /**
     * Load already-processed ETH Pool yield epochs from chain to prevent replay on restart.
     */
    private loadProcessedETHPoolYieldBridgeIns;
    /**
     * Watch for ETHPoolYieldBridged events from ETHPoolYieldDistributor and credit
     * Canton ETH Pool via ETHPool_ReceiveYield.
     *
     * Flow:
     *   1. Scan for new ETHPoolYieldBridged events (distributor mints mUSD → bridge burns)
     *   2. Create CantonMUSD on Canton (operator-owned, yield amount)
     *   3. Query CantonETHPoolService to get its contractId
     *   4. Exercise ETHPool_ReceiveYield with the minted CantonMUSD → pooledUsdc ↑ → share price ↑
     */
    private processETHPoolYieldBridgeIn;
    /**
     * Exercise ETHPool_ReceiveYield on CantonETHPoolService to credit the ETH Pool.
     * This increments pooledUsdc, which raises the ETH Pool share price.
     */
    private creditCantonETHPool;
    /**
     * Extract the created contract ID from a v2 submit-and-wait response.
     * Returns null if the response format doesn't contain a recognizable contractId.
     */
    private extractCreatedContractId;
    /**
     * Resolve Treasury asset address across contract versions.
     * TreasuryV2 exposes `asset()`; older deployments may still expose `usdc()`.
     */
    private resolveTreasuryAssetAddress;
    /**
     * Log pending RedemptionRequest backlog to make settlement progress explicit.
     */
    private logPendingRedemptionBacklog;
    /**
     * Parse DAML Numeric 18 values into wei-like bigint units.
     */
    private parseDamlNumeric18;
    /**
     * Load previously settled redemption IDs from on-ledger settlement markers.
     * This protects against replay after relay state-file loss.
     */
    private loadProcessedRedemptionsFromLedgerMarkers;
    /**
     * Persist Ethereum payout as an on-ledger marker for durable idempotency.
     * Returns true when marker is written, false when unavailable/failing.
     */
    private writeRedemptionSettlementMarker;
    /**
     * Resolve Ethereum recipient for a Canton user party.
     * Supports exact party ID and party-hint mappings.
     */
    private resolveRedemptionRecipientEthAddress;
    /**
     * Ensure relay wallet can mint mUSD for redemption payouts.
     * If configured and possible, self-grants BRIDGE_ROLE.
     */
    private ensureBridgeRoleForRedemptionPayouts;
    private getMusdCapState;
    private decodeMusdMintError;
    /**
     * Settle pending RedemptionRequests by minting mUSD on Ethereum.
     * Requests remain pending on Canton; idempotency is enforced by local persistence.
     */
    private processPendingRedemptions;
    /**
     * Auto-process Canton BridgeOutRequests.
     *
     * When a user mints mUSD on Canton (via USDC/USDCx), a BridgeOutRequest is created.
     * This is a treasury-backing flow (Canton deposit backing moved to Ethereum treasury),
     * not a direct end-user withdrawal payout.
     * The method polls Canton for pending requests and processes them:
     *
     *   1. Check if USDC backing is available in relayer wallet
     *      (from xReserve/Circle CCTP redemption — operator redeems USDCx off-chain)
     *   2. Route USDC based on source:
     *      - "ethpool" → depositToStrategy(MetaVault #3) — targeted Fluid allocation
     *      - "directmint" → deposit() — general auto-allocation across strategies
     *   3. Mark BridgeOutRequest as "bridged" on Canton
     */
    private processCantonBridgeOuts;
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
     * Includes entropy in hash to match BLEBridgeV9 verification
     * Includes cantonStateHash to match on-chain signature verification
     */
    private buildMessageHash;
    /**
     * Format validator signatures for Ethereum
     * Pre-verify signatures using ecrecover before submitting to chain
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