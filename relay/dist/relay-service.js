"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RelayService = void 0;
// Load environment variables BEFORE any config initialization
const path = __importStar(require("path"));
// TS-C-01 FIX: NEVER load dotenv in production.
// Production secrets are mounted at /run/secrets/ by Docker/K8s and read via readSecret().
// Loading .env files in production risks exposing plaintext private keys on disk,
// in container image layers, CI logs, and backup archives.
if (process.env.NODE_ENV !== "production") {
    try {
        // Dynamic require so dotenv is not imported at all in production bundles
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const dotenv = require("dotenv");
        dotenv.config({ path: path.resolve(__dirname, ".env.development") });
        console.log("[Config] Loaded .env.development (non-production mode)");
    }
    catch {
        // dotenv not installed — env vars must be set externally
    }
}
const ethers_1 = require("ethers");
const canton_client_1 = require("./canton-client");
const signer_1 = require("./signer");
const daml_schema_validator_1 = require("./daml-schema-validator");
// Use shared readSecret utility
// Use readAndValidatePrivateKey for secp256k1 range validation
// INFRA-H-06: Import enforceTLSSecurity for explicit TLS cert validation
const utils_1 = require("./utils");
const recipient_routing_1 = require("./recipient-routing");
// KMS-based Ethereum transaction signer (key never enters Node.js memory)
const kms_ethereum_signer_1 = require("./kms-ethereum-signer");
// Cryptographic entropy for attestation ID unpredictability
const crypto = __importStar(require("crypto"));
// MEDIUM-02: File-based state persistence for replay protection
const fs = __importStar(require("fs"));
const metrics_1 = require("./metrics");
// INFRA-H-06: Ensure TLS certificate validation is enforced at process level
(0, utils_1.enforceTLSSecurity)();
// TS-C-01: Block startup if .env files on disk contain plaintext private keys in production
(0, utils_1.rejectDotenvPrivateKeys)(__dirname);
const DEFAULT_CONFIG = {
    cantonHost: process.env.CANTON_HOST || "localhost",
    // Added explicit radix 10 to all parseInt calls
    cantonPort: parseInt(process.env.CANTON_PORT || "7575", 10),
    // Read sensitive values from Docker secrets, fallback to env vars
    cantonToken: (0, utils_1.readSecret)("canton_token", "CANTON_TOKEN"),
    cantonParty: process.env.CANTON_PARTY || "",
    // INFRA-H-01 / INFRA-H-03: No insecure fallback — require explicit RPC URL in production
    // Read from Docker secret first (contains API keys), fallback to env var
    ethereumRpcUrl: (() => {
        const url = (0, utils_1.readSecret)("ethereum_rpc_url", "ETHEREUM_RPC_URL");
        if (!url)
            throw new Error("ETHEREUM_RPC_URL is required");
        if (!url.startsWith("https://") && process.env.NODE_ENV !== "development") {
            throw new Error("ETHEREUM_RPC_URL must use HTTPS in production");
        }
        return url;
    })(),
    bridgeContractAddress: process.env.BRIDGE_CONTRACT_ADDRESS || "",
    treasuryAddress: process.env.TREASURY_ADDRESS || "",
    metaVault3Address: process.env.META_VAULT3_ADDRESS || "", // Fluid T2/T4 strategy
    musdTokenAddress: (() => {
        const raw = process.env.MUSD_TOKEN_ADDRESS || (0, utils_1.readSecret)("musd_token_address", "") || "";
        if (!raw)
            throw new Error("MUSD_TOKEN_ADDRESS is required");
        if (!ethers_1.ethers.isAddress(raw))
            throw new Error(`Invalid MUSD_TOKEN_ADDRESS: ${raw}`);
        return ethers_1.ethers.getAddress(raw);
    })(),
    // SEC-GATE-01: Validate private key is in valid secp256k1 range
    // @deprecated — migrate to RELAYER_KMS_KEY_ID for production
    relayerPrivateKey: (() => {
        const kmsId = (0, utils_1.readSecret)("relayer_kms_key_id", "RELAYER_KMS_KEY_ID");
        const rawKey = (0, utils_1.readAndValidatePrivateKey)("relayer_private_key", "RELAYER_PRIVATE_KEY");
        if (rawKey && !kmsId) {
            console.warn("⚠️  DEPRECATED: RELAYER_PRIVATE_KEY is deprecated. " +
                "Migrate to RELAYER_KMS_KEY_ID for HSM-backed signing. " +
                "Raw private keys will be rejected in a future release.");
        }
        return rawKey;
    })(),
    // KMS key for Ethereum transaction signing (key never in memory)
    relayerKmsKeyId: (0, utils_1.readSecret)("relayer_kms_key_id", "RELAYER_KMS_KEY_ID"),
    awsRegion: process.env.AWS_REGION || "us-east-1",
    // Map DAML Party → Ethereum address
    // Load from JSON config file or environment
    // Format: {"validator1::122abc": "0x71C7...", "validator2::456def": "0x82D8..."}
    // Limit JSON size to 10KB to prevent memory exhaustion attacks
    validatorAddresses: (() => {
        const raw = process.env.VALIDATOR_ADDRESSES || (0, utils_1.readSecret)("validator_addresses", "") || "{}";
        const MAX_JSON_SIZE = 10 * 1024; // 10KB
        if (raw.length > MAX_JSON_SIZE) {
            throw new Error(`VALIDATOR_ADDRESSES exceeds ${MAX_JSON_SIZE} byte limit - possible injection attack`);
        }
        return JSON.parse(raw);
    })(),
    recipientPartyAliases: (() => {
        const raw = process.env.CANTON_RECIPIENT_PARTY_ALIASES ||
            (0, utils_1.readSecret)("canton_recipient_party_aliases", "") ||
            "";
        return (0, recipient_routing_1.parseRecipientPartyAliases)(raw, "CANTON_RECIPIENT_PARTY_ALIASES");
    })(),
    redemptionRecipientAddresses: (() => {
        const raw = process.env.CANTON_REDEMPTION_ETH_RECIPIENTS ||
            (0, utils_1.readSecret)("canton_redemption_eth_recipients", "") ||
            "";
        return (0, recipient_routing_1.parseRecipientEthAddresses)(raw, "CANTON_REDEMPTION_ETH_RECIPIENTS");
    })(),
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "5000", 10),
    maxRetries: parseInt(process.env.MAX_RETRIES || "3", 10),
    confirmations: parseInt(process.env.CONFIRMATIONS || "2", 10),
    triggerAutoDeploy: process.env.TRIGGER_AUTO_DEPLOY !== "false", // Default enabled
    autoAcceptMusdTransferProposals: (() => {
        if (process.env.AUTO_ACCEPT_MUSD_TRANSFER_PROPOSALS) {
            return process.env.AUTO_ACCEPT_MUSD_TRANSFER_PROPOSALS === "true";
        }
        // Safe default: enabled in development for local testing UX, disabled in production.
        return process.env.NODE_ENV !== "production";
    })(),
    // Fallback RPC URLs for relay redundancy
    fallbackRpcUrls: (process.env.FALLBACK_RPC_URLS || "")
        .split(",")
        .filter(Boolean)
        .map(url => url.trim()),
    // Direction 4: YieldDistributor address (optional — yield bridge-in disabled if empty)
    yieldDistributorAddress: process.env.YIELD_DISTRIBUTOR_ADDRESS || "",
    // Direction 4b: ETHPoolYieldDistributor address (optional — ETH Pool yield bridge-in)
    // LOW-04: Validate checksum address on load
    ethPoolYieldDistributorAddress: process.env.ETH_POOL_YIELD_DISTRIBUTOR_ADDRESS
        ? ethers_1.ethers.getAddress(process.env.ETH_POOL_YIELD_DISTRIBUTOR_ADDRESS)
        : "",
    // Canton governance party for ReceiveYield exercise (defaults to operator party)
    cantonGovernanceParty: process.env.CANTON_GOVERNANCE_PARTY || process.env.CANTON_PARTY || "",
    // MEDIUM-02: File path for persisting relay state (processed epochs, scanned blocks)
    stateFilePath: process.env.RELAY_STATE_FILE || path.resolve(__dirname, "relay-state.json"),
    // MEDIUM-02: Lookback window for on-chain replay scan (default 200,000 blocks ≈ 28 days on Ethereum)
    replayLookbackBlocks: parseInt(process.env.RELAY_LOOKBACK_BLOCKS || "200000", 10),
    maxRedemptionEthPayoutWei: (() => {
        const raw = process.env.MAX_REDEMPTION_ETH_PAYOUT_MUSD || "50000";
        try {
            return ethers_1.ethers.parseUnits(raw, 18);
        }
        catch {
            throw new Error(`Invalid MAX_REDEMPTION_ETH_PAYOUT_MUSD: ${raw}`);
        }
    })(),
    autoGrantBridgeRoleForRedemptions: (() => {
        if (process.env.AUTO_GRANT_BRIDGE_ROLE_FOR_REDEMPTIONS) {
            return process.env.AUTO_GRANT_BRIDGE_ROLE_FOR_REDEMPTIONS === "true";
        }
        return process.env.NODE_ENV !== "production";
    })(),
};
// ============================================================
//                     BLEBridgeV9 ABI (partial)
// ============================================================
const BRIDGE_ABI = [
    {
        "inputs": [
            {
                "components": [
                    { "name": "id", "type": "bytes32" },
                    { "name": "cantonAssets", "type": "uint256" },
                    { "name": "nonce", "type": "uint256" },
                    { "name": "timestamp", "type": "uint256" },
                    { "name": "entropy", "type": "bytes32" },
                    { "name": "cantonStateHash", "type": "bytes32" }
                ],
                "name": "att",
                "type": "tuple"
            },
            { "name": "signatures", "type": "bytes[]" }
        ],
        "name": "processAttestation",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "currentNonce",
        "outputs": [{ "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "minSignatures",
        "outputs": [{ "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [{ "name": "", "type": "bytes32" }],
        "name": "usedAttestationIds",
        "outputs": [{ "type": "bool" }],
        "stateMutability": "view",
        "type": "function"
    },
    // ABI for hasRole to validate validator addresses on-chain
    {
        "inputs": [
            { "name": "role", "type": "bytes32" },
            { "name": "account", "type": "address" }
        ],
        "name": "hasRole",
        "outputs": [{ "type": "bool" }],
        "stateMutability": "view",
        "type": "function"
    },
    // Event: AttestationReceived (for loading processed attestation history)
    // CX-M-02: Must match BLEBridgeV9.sol exactly — param order, types, and names
    {
        "anonymous": false,
        "inputs": [
            { "indexed": true, "name": "id", "type": "bytes32" },
            { "indexed": false, "name": "cantonAssets", "type": "uint256" },
            { "indexed": false, "name": "newSupplyCap", "type": "uint256" },
            { "indexed": false, "name": "nonce", "type": "uint256" },
            { "indexed": false, "name": "timestamp", "type": "uint256" }
        ],
        "name": "AttestationReceived",
        "type": "event"
    },
    // Event: BridgeToCantonRequested (ETH → Canton bridge-out)
    {
        "anonymous": false,
        "inputs": [
            { "indexed": true, "name": "requestId", "type": "bytes32" },
            { "indexed": true, "name": "sender", "type": "address" },
            { "indexed": false, "name": "amount", "type": "uint256" },
            { "indexed": false, "name": "nonce", "type": "uint256" },
            { "indexed": false, "name": "cantonRecipient", "type": "string" },
            { "indexed": false, "name": "timestamp", "type": "uint256" }
        ],
        "name": "BridgeToCantonRequested",
        "type": "event"
    },
    // View: bridgeOutNonce
    {
        "inputs": [],
        "name": "bridgeOutNonce",
        "outputs": [{ "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    },
    // H-2: Pause guardian support
    {
        "inputs": [],
        "name": "paused",
        "outputs": [{ "type": "bool" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "pause",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    // H-2: Read attested assets for anomaly detection
    {
        "inputs": [],
        "name": "attestedCantonAssets",
        "outputs": [{ "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "getCurrentSupplyCap",
        "outputs": [{ "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    }
];
// ── Direction 4: YieldDistributor ABI (CantonYieldBridged event) ──────
const YIELD_DISTRIBUTOR_ABI = [
    {
        "anonymous": false,
        "inputs": [
            { "indexed": true, "name": "epoch", "type": "uint256" },
            { "indexed": false, "name": "musdAmount", "type": "uint256" },
            { "indexed": false, "name": "cantonRecipient", "type": "string" }
        ],
        "name": "CantonYieldBridged",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            { "indexed": true, "name": "epoch", "type": "uint256" },
            { "indexed": false, "name": "yieldUsdc", "type": "uint256" },
            { "indexed": false, "name": "musdMinted", "type": "uint256" },
            { "indexed": false, "name": "ethMusd", "type": "uint256" },
            { "indexed": false, "name": "cantonMusd", "type": "uint256" },
            { "indexed": false, "name": "ethSharesBps", "type": "uint256" },
            { "indexed": false, "name": "cantonSharesBps", "type": "uint256" }
        ],
        "name": "YieldDistributed",
        "type": "event"
    },
    {
        "inputs": [],
        "name": "distributionCount",
        "outputs": [{ "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    }
];
// ETH Pool yield distributor — MetaVault #3 yield → Canton ETH Pool
const ETH_POOL_YIELD_DISTRIBUTOR_ABI = [
    {
        "anonymous": false,
        "inputs": [
            { "indexed": true, "name": "epoch", "type": "uint256" },
            { "indexed": false, "name": "yieldUsdc", "type": "uint256" },
            { "indexed": false, "name": "musdBridged", "type": "uint256" },
            { "indexed": false, "name": "ethPoolRecipient", "type": "string" }
        ],
        "name": "ETHPoolYieldBridged",
        "type": "event"
    },
    {
        "inputs": [],
        "name": "distributionCount",
        "outputs": [{ "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    }
];
// ============================================================
//                     RELAY SERVICE
// ============================================================
class RelayService {
    config;
    canton;
    provider;
    wallet; // Abstract signer (KMS or raw)
    bridgeContract;
    musdTokenContract;
    // Bounded cache with eviction
    processedAttestations = new Set();
    MAX_PROCESSED_CACHE = 10000;
    isRunning = false;
    // ETH → Canton: Track processed bridge-out request IDs
    processedBridgeOuts = new Set();
    // Last Ethereum block scanned for BridgeToCantonRequested events
    lastScannedBlock = 0;
    // Direction 4: Yield bridge-in tracking
    yieldDistributorContract = null;
    processedYieldEpochs = new Set();
    lastYieldScannedBlock = 0;
    // Direction 4b: ETH Pool yield bridge-in tracking
    ethPoolYieldDistributorContract = null;
    processedETHPoolYieldEpochs = new Set();
    lastETHPoolYieldScannedBlock = 0;
    // Canton redemption -> Ethereum payout tracking (idempotency across restarts)
    processedRedemptionRequests = new Set();
    // BRIDGE-M-05: Named constant for the expiry-to-timestamp offset.
    // The DAML attestation carries an `expiresAt` timestamp (when the attestation becomes invalid).
    // The Solidity contract expects a `timestamp` representing when the attestation was *created*.
    // We derive the creation timestamp by subtracting this offset from the expiry time.
    // This must match the attestation TTL configured in the BridgeService / aggregator.
    static ATTESTATION_TTL_SECONDS = 3600; // 1 hour
    // BRIDGE-M-05: Maximum allowed age/future drift for derived timestamps (24 hours)
    static MAX_TIMESTAMP_DRIFT_SECONDS = 86400;
    // Fallback RPC providers for relay redundancy
    fallbackProviders = [];
    activeProviderIndex = 0;
    consecutiveFailures = 0;
    MAX_CONSECUTIVE_FAILURES = 3;
    // ── H-1: Rate limiting ──────────────────────────────────────────────
    // Per-block and per-minute caps to prevent relay DoS / spam
    rateLimiter = {
        // Per-minute cap
        txThisMinute: 0,
        minuteWindowStart: Date.now(),
        maxTxPerMinute: parseInt(process.env.RATE_LIMIT_TX_PER_MINUTE || "10", 10),
        // Per-block cap (prevent submitting multiple attestations in the same block)
        lastSubmittedBlock: 0,
        txThisBlock: 0,
        maxTxPerBlock: parseInt(process.env.RATE_LIMIT_TX_PER_BLOCK || "1", 10),
        // Hourly cap (defense-in-depth)
        txThisHour: 0,
        hourWindowStart: Date.now(),
        maxTxPerHour: parseInt(process.env.RATE_LIMIT_TX_PER_HOUR || "60", 10),
    };
    // ── H-2: Pause guardian — anomaly detection thresholds ──────────────
    anomalyDetector = {
        // Supply cap change threshold: auto-pause if single attestation changes cap by > X%
        maxCapChangePct: parseInt(process.env.PAUSE_CAP_CHANGE_PCT || "20", 10),
        // Consecutive revert threshold: auto-pause if N consecutive tx reverts
        consecutiveReverts: 0,
        maxConsecutiveReverts: parseInt(process.env.PAUSE_MAX_REVERTS || "5", 10),
        // Track last known supply cap for anomaly comparison
        lastKnownSupplyCap: 0n,
        // Whether we've triggered a pause (prevent repeated pause attempts)
        pauseTriggered: false,
    };
    // ── H-3: Nonce replay tracking (relay-side dedup) ───────────────────
    // Track nonces we've submitted to prevent relay-level replay
    submittedNonces = new Set();
    // Track attestation IDs submitted (distinct from on-chain check — catches in-flight dupes)
    inFlightAttestations = new Set();
    // Direction 3 diagnostics throttling
    lastVaultRoleWarningAt = 0;
    lastRedemptionBacklogLogAt = 0;
    lastRedemptionBacklogSize = -1;
    lastRedemptionFulfillmentWarningAt = 0;
    redemptionSettlementMarkerSupported = null;
    warnedRedemptionMarkerUnavailable = false;
    static DIAGNOSTIC_LOG_INTERVAL_MS = 60000;
    constructor(config) {
        this.config = config;
        // Default to TLS for Canton ledger connections (opt-out instead of opt-in)
        // Reject cleartext HTTP in production
        if (process.env.CANTON_USE_TLS === "false" && process.env.NODE_ENV === "production") {
            throw new Error("SECURITY: CANTON_USE_TLS=false is FORBIDDEN in production. " +
                "Canton ledger connections must use TLS. Remove CANTON_USE_TLS or set to 'true'.");
        }
        const protocol = process.env.CANTON_USE_TLS === "false" ? "http" : "https";
        this.canton = new canton_client_1.CantonClient({
            baseUrl: `${protocol}://${config.cantonHost}:${config.cantonPort}`,
            token: config.cantonToken,
            userId: process.env.CANTON_USER_ID || "administrator",
            actAs: config.cantonParty,
            timeoutMs: 30000,
            defaultPackageId: process.env.CANTON_PACKAGE_ID || "",
        });
        // Initialize Ethereum connection
        this.provider = new ethers_1.ethers.JsonRpcProvider(config.ethereumRpcUrl);
        // Initialize fallback RPC providers
        if (config.fallbackRpcUrls && config.fallbackRpcUrls.length > 0) {
            for (const url of config.fallbackRpcUrls) {
                this.fallbackProviders.push(new ethers_1.ethers.JsonRpcProvider(url));
            }
            console.log(`[Relay] ${this.fallbackProviders.length} fallback RPC providers configured`);
        }
        // Wallet initialized asynchronously via initSigner()
        // to support KMS-based signing (key never enters Node.js memory)
        console.log(`[Relay] Initialized`);
        console.log(`[Relay] Canton: ${config.cantonHost}:${config.cantonPort}`);
        // Sanitize RPC URL in logs to prevent API key leakage
        console.log(`[Relay] Ethereum: ${(0, utils_1.sanitizeUrl)(config.ethereumRpcUrl)}`);
        console.log(`[Relay] Bridge: ${config.bridgeContractAddress}`);
        if (Object.keys(config.recipientPartyAliases).length > 0) {
            console.log(`[Relay] Recipient alias mappings loaded: ${Object.keys(config.recipientPartyAliases).length}`);
        }
        if (Object.keys(config.redemptionRecipientAddresses).length > 0) {
            console.log(`[Relay] Redemption recipient mappings loaded: ${Object.keys(config.redemptionRecipientAddresses).length}`);
        }
        if (config.autoAcceptMusdTransferProposals) {
            console.log("[Relay] Auto-accept of CantonMUSD transfer proposals is ENABLED");
        }
    }
    /**
     * Initialize Ethereum signer (KMS or raw key)
     * Must be called before start()
     */
    async initSigner() {
        this.wallet = await (0, kms_ethereum_signer_1.createEthereumSigner)({
            kmsKeyId: this.config.relayerKmsKeyId,
            awsRegion: this.config.awsRegion,
            privateKey: this.config.relayerPrivateKey,
        }, this.provider);
        this.bridgeContract = new ethers_1.ethers.Contract(this.config.bridgeContractAddress, BRIDGE_ABI, this.wallet);
        this.musdTokenContract = new ethers_1.ethers.Contract(this.config.musdTokenAddress, [
            "function mint(address to, uint256 amount) external",
            "function hasRole(bytes32 role, address account) external view returns (bool)",
            "function grantRole(bytes32 role, address account) external",
        ], this.wallet);
        // Direction 4: YieldDistributor contract (read-only, for event scanning)
        if (this.config.yieldDistributorAddress) {
            this.yieldDistributorContract = new ethers_1.ethers.Contract(this.config.yieldDistributorAddress, YIELD_DISTRIBUTOR_ABI, this.provider // read-only — no signing needed for event queries
            );
        }
        const address = await this.wallet.getAddress();
        console.log(`[Relay] Relayer: ${address}`);
        console.log(`[Relay] Redemption payout token (mUSD): ${this.config.musdTokenAddress}`);
        if (this.config.yieldDistributorAddress) {
            console.log(`[Relay] YieldDistributor: ${this.config.yieldDistributorAddress}`);
        }
        // Direction 4b: ETHPoolYieldDistributor contract (read-only, for event scanning)
        if (this.config.ethPoolYieldDistributorAddress) {
            this.ethPoolYieldDistributorContract = new ethers_1.ethers.Contract(this.config.ethPoolYieldDistributorAddress, ETH_POOL_YIELD_DISTRIBUTOR_ABI, this.provider);
            console.log(`[Relay] ETHPoolYieldDistributor: ${this.config.ethPoolYieldDistributorAddress}`);
        }
    }
    // ============================================================
    //  MEDIUM-02: File-Based State Persistence for Replay Protection
    // ============================================================
    /**
     * Shape of the persisted relay state file.
     * Stores processed epoch/attestation IDs and last scanned block numbers
     * so the relay can survive restarts without re-processing events.
     */
    static STATE_VERSION = 1;
    /**
     * Load persisted state from disk on startup.
     * Merges with in-memory state (chain-scanned data takes priority).
     */
    loadPersistedState() {
        const filePath = this.config.stateFilePath;
        if (!filePath)
            return;
        try {
            if (!fs.existsSync(filePath)) {
                console.log(`[Relay] No persisted state file found at ${filePath} — starting fresh`);
                return;
            }
            const raw = fs.readFileSync(filePath, "utf-8");
            // Guard against corrupted / oversized state files (max 5MB)
            if (raw.length > 5 * 1024 * 1024) {
                console.warn(`[Relay] State file exceeds 5MB — ignoring corrupted state`);
                return;
            }
            const state = JSON.parse(raw);
            // Version check for future migration
            if (state.version !== RelayService.STATE_VERSION) {
                console.warn(`[Relay] State file version ${state.version} does not match expected ${RelayService.STATE_VERSION} — ignoring`);
                return;
            }
            // Restore processed attestation IDs
            if (Array.isArray(state.processedAttestations)) {
                for (const id of state.processedAttestations) {
                    this.processedAttestations.add(id);
                }
            }
            // Restore processed yield epochs
            if (Array.isArray(state.processedYieldEpochs)) {
                for (const epoch of state.processedYieldEpochs) {
                    this.processedYieldEpochs.add(epoch);
                }
            }
            // Restore processed ETH Pool yield epochs
            if (Array.isArray(state.processedETHPoolYieldEpochs)) {
                for (const epoch of state.processedETHPoolYieldEpochs) {
                    this.processedETHPoolYieldEpochs.add(epoch);
                }
            }
            // Restore locally-settled redemption request IDs
            if (Array.isArray(state.processedRedemptionRequests)) {
                for (const cid of state.processedRedemptionRequests) {
                    this.processedRedemptionRequests.add(cid);
                }
            }
            // Restore last scanned blocks (use persisted value if ahead of default 0)
            if (typeof state.lastScannedBlock === "number" && state.lastScannedBlock > this.lastScannedBlock) {
                this.lastScannedBlock = state.lastScannedBlock;
            }
            if (typeof state.lastYieldScannedBlock === "number" && state.lastYieldScannedBlock > this.lastYieldScannedBlock) {
                this.lastYieldScannedBlock = state.lastYieldScannedBlock;
            }
            if (typeof state.lastETHPoolYieldScannedBlock === "number" && state.lastETHPoolYieldScannedBlock > this.lastETHPoolYieldScannedBlock) {
                this.lastETHPoolYieldScannedBlock = state.lastETHPoolYieldScannedBlock;
            }
            console.log(`[Relay] Loaded persisted state: ` +
                `${state.processedAttestations?.length || 0} attestations, ` +
                `${state.processedYieldEpochs?.length || 0} yield epochs, ` +
                `${state.processedETHPoolYieldEpochs?.length || 0} ETH Pool yield epochs, ` +
                `${state.processedRedemptionRequests?.length || 0} redemptions, ` +
                `lastScanned=${state.lastScannedBlock || 0}, ` +
                `lastYieldScanned=${state.lastYieldScannedBlock || 0}, ` +
                `lastETHPoolYieldScanned=${state.lastETHPoolYieldScannedBlock || 0}`);
        }
        catch (error) {
            console.warn(`[Relay] Failed to load persisted state: ${error.message} — starting fresh`);
        }
    }
    /**
     * Persist current relay state to disk.
     * Called after each successful epoch/attestation processing.
     * Uses atomic write (write to temp file, then rename) to prevent corruption.
     */
    persistState() {
        const filePath = this.config.stateFilePath;
        if (!filePath)
            return;
        try {
            const state = {
                version: RelayService.STATE_VERSION,
                timestamp: new Date().toISOString(),
                processedAttestations: Array.from(this.processedAttestations),
                processedYieldEpochs: Array.from(this.processedYieldEpochs),
                processedETHPoolYieldEpochs: Array.from(this.processedETHPoolYieldEpochs),
                processedRedemptionRequests: Array.from(this.processedRedemptionRequests),
                lastScannedBlock: this.lastScannedBlock,
                lastYieldScannedBlock: this.lastYieldScannedBlock,
                lastETHPoolYieldScannedBlock: this.lastETHPoolYieldScannedBlock,
            };
            const json = JSON.stringify(state, null, 2);
            // Atomic write: write to temp file, then rename (prevents partial writes on crash)
            const tmpPath = filePath + ".tmp";
            fs.writeFileSync(tmpPath, json, "utf-8");
            fs.renameSync(tmpPath, filePath);
        }
        catch (error) {
            // Non-fatal: state persistence failure should not stop the relay
            console.error(`[Relay] Failed to persist state: ${error.message}`);
        }
    }
    /**
     * Start the relay service
     */
    async start() {
        console.log("[Relay] Starting...");
        // Initialize signer (KMS or raw key)
        await this.initSigner();
        // Validate validator addresses against on-chain roles before starting
        await this.validateValidatorAddresses();
        this.isRunning = true;
        // MEDIUM-02: Load persisted state from disk BEFORE chain scanning.
        // Persisted state provides a baseline; chain scanning then adds any
        // events that occurred after the last state save.
        this.loadPersistedState();
        // Load already-processed attestations from chain
        await this.loadProcessedAttestations();
        // Load already-processed bridge-out requests from chain
        await this.loadProcessedBridgeOuts();
        // Load already-processed yield bridge-in epochs from chain
        await this.loadProcessedYieldBridgeIns();
        // Load already-processed ETH Pool yield bridge-in epochs from chain
        await this.loadProcessedETHPoolYieldBridgeIns();
        // Process any pending BridgeInRequests from previous runs (complete + mint mUSD)
        await this.processPendingBridgeInRequests();
        // Load on-ledger redemption settlement markers (if available) for durable idempotency.
        await this.loadProcessedRedemptionsFromLedgerMarkers();
        // Main loop — bidirectional
        while (this.isRunning) {
            try {
                // Direction 1: Canton → Ethereum (attestation relay)
                await this.pollForAttestations();
                // Direction 2: Ethereum → Canton (bridge-out watcher)
                await this.watchEthereumBridgeOut();
                // Direction 2b: Canton redemption requests (settle to Ethereum mUSD)
                await this.processPendingRedemptions();
                // Direction 3: Canton → Ethereum (auto-process bridge-out backing)
                await this.processCantonBridgeOuts();
                // Direction 4: Ethereum → Canton (yield bridge-in — credit Canton pools)
                await this.processYieldBridgeIn();
                // Direction 4b: Ethereum → Canton (ETH Pool yield — credit Canton ETH Pool)
                await this.processETHPoolYieldBridgeIn();
                // Reset failure counter on success
                this.consecutiveFailures = 0;
                this.updateMetricsSnapshot();
            }
            catch (error) {
                console.error("[Relay] Poll error:", error);
                // Failover to backup RPC on consecutive failures
                this.consecutiveFailures++;
                this.updateMetricsSnapshot();
                if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
                    console.warn(`[Relay] ${this.consecutiveFailures} consecutive failures — attempting provider failover`);
                    await this.switchToFallbackProvider();
                }
            }
            await this.sleep(this.config.pollIntervalMs);
        }
    }
    /**
     * Validate that all configured validator addresses have VALIDATOR_ROLE on-chain
     * This prevents signature forgery via config injection attacks
     */
    async validateValidatorAddresses() {
        const VALIDATOR_ROLE = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes("VALIDATOR_ROLE"));
        const validatorEntries = Object.entries(this.config.validatorAddresses);
        if (validatorEntries.length === 0) {
            throw new Error("SECURITY: No validator addresses configured - cannot verify signatures");
        }
        console.log(`[Relay] Validating ${validatorEntries.length} validator addresses against on-chain roles...`);
        for (const [partyId, address] of validatorEntries) {
            try {
                const hasRole = await this.bridgeContract.hasRole(VALIDATOR_ROLE, address);
                if (!hasRole) {
                    throw new Error(`SECURITY: Validator ${partyId} (${address}) does NOT have VALIDATOR_ROLE on-chain - possible config injection attack`);
                }
                console.log(`[Relay] ✓ Validator ${partyId} (${address}) verified on-chain`);
            }
            catch (error) {
                if (error.message?.includes("SECURITY:")) {
                    throw error;
                }
                throw new Error(`Failed to verify validator ${partyId}: ${error.message}`);
            }
        }
        console.log(`[Relay] All ${validatorEntries.length} validator addresses verified on-chain`);
    }
    /**
     * Switch to the next fallback RPC provider on consecutive failures.
     * Re-initializes the signer against the new provider so all subsequent
     * contract calls go through the healthy endpoint.
     */
    async switchToFallbackProvider() {
        if (this.fallbackProviders.length === 0) {
            console.warn("[Relay] No fallback RPC providers configured — cannot failover");
            return false;
        }
        const nextIndex = (this.activeProviderIndex + 1) % (this.fallbackProviders.length + 1);
        // Index 0 = primary, 1..N = fallback providers
        if (nextIndex === 0) {
            console.log("[Relay] Cycling back to primary RPC provider");
            this.provider = new ethers_1.ethers.JsonRpcProvider(this.config.ethereumRpcUrl);
        }
        else {
            const fallbackUrl = this.config.fallbackRpcUrls[nextIndex - 1];
            // Sanitize fallback URL to prevent API key leakage in logs
            console.log(`[Relay] Switching to fallback RPC provider #${nextIndex}: ${(0, utils_1.sanitizeUrl)(fallbackUrl)}`);
            this.provider = this.fallbackProviders[nextIndex - 1];
        }
        this.activeProviderIndex = nextIndex;
        this.consecutiveFailures = 0;
        this.updateMetricsSnapshot();
        // Re-initialise signer + contract against the new provider
        try {
            await this.initSigner();
            console.log("[Relay] Signer re-initialised on new provider");
            return true;
        }
        catch (err) {
            console.error(`[Relay] Failed to re-init signer on fallback: ${err.message}`);
            return false;
        }
    }
    /**
     * Stop the relay service
     */
    stop() {
        console.log("[Relay] Stopping...");
        this.isRunning = false;
    }
    /** Sync in-memory relay state into exported Prometheus gauges. */
    updateMetricsSnapshot() {
        metrics_1.lastScannedBlock.set(this.lastScannedBlock);
        metrics_1.consecutiveFailures.set(this.consecutiveFailures);
        metrics_1.activeProviderIndex.set(this.activeProviderIndex);
        metrics_1.inFlightAttestations.set(this.inFlightAttestations.size);
        metrics_1.rateLimiterTxPerMinute.set(this.rateLimiter.txThisMinute);
        metrics_1.rateLimiterTxPerHour.set(this.rateLimiter.txThisHour);
        metrics_1.anomalyPauseTriggered.set(this.anomalyDetector.pauseTriggered ? 1 : 0);
        metrics_1.anomalyConsecutiveReverts.set(this.anomalyDetector.consecutiveReverts);
    }
    // ============================================================
    //  H-1: RATE LIMITING
    // ============================================================
    /**
     * Check if a transaction is allowed under rate limits.
     * Returns true if allowed, false if rate-limited.
     */
    async checkRateLimit() {
        const now = Date.now();
        const rl = this.rateLimiter;
        // Reset minute window
        if (now - rl.minuteWindowStart > 60000) {
            rl.txThisMinute = 0;
            rl.minuteWindowStart = now;
            metrics_1.rateLimiterTxPerMinute.set(0);
        }
        // Reset hour window
        if (now - rl.hourWindowStart > 3600000) {
            rl.txThisHour = 0;
            rl.hourWindowStart = now;
            metrics_1.rateLimiterTxPerHour.set(0);
        }
        // Check per-minute cap
        if (rl.txThisMinute >= rl.maxTxPerMinute) {
            console.warn(`[RateLimit] Per-minute cap reached (${rl.maxTxPerMinute}/min). Skipping.`);
            metrics_1.validatorRateLimitHitsTotal.inc();
            this.updateMetricsSnapshot();
            return false;
        }
        // Check per-hour cap
        if (rl.txThisHour >= rl.maxTxPerHour) {
            console.warn(`[RateLimit] Per-hour cap reached (${rl.maxTxPerHour}/hr). Skipping.`);
            metrics_1.validatorRateLimitHitsTotal.inc();
            this.updateMetricsSnapshot();
            return false;
        }
        // Check per-block cap
        try {
            const currentBlock = await this.provider.getBlockNumber();
            if (currentBlock === rl.lastSubmittedBlock) {
                if (rl.txThisBlock >= rl.maxTxPerBlock) {
                    console.warn(`[RateLimit] Per-block cap reached (${rl.maxTxPerBlock}/block). Waiting for next block.`);
                    metrics_1.validatorRateLimitHitsTotal.inc();
                    this.updateMetricsSnapshot();
                    return false;
                }
            }
            else {
                rl.lastSubmittedBlock = currentBlock;
                rl.txThisBlock = 0;
            }
        }
        catch {
            // If block number check fails, still allow (don't block on RPC hiccup)
        }
        return true;
    }
    /**
     * Record a successful transaction submission for rate limiting
     */
    recordTxSubmission() {
        this.rateLimiter.txThisMinute++;
        this.rateLimiter.txThisHour++;
        this.rateLimiter.txThisBlock++;
        this.updateMetricsSnapshot();
    }
    // ============================================================
    //  H-2: PAUSE GUARDIAN — Anomaly Detection
    // ============================================================
    /**
     * Check for anomalies and auto-pause the bridge if thresholds are exceeded.
     * Called before each attestation submission.
     *
     * Anomaly triggers:
     *   1. Supply cap change > maxCapChangePct% in a single attestation
     *   2. Too many consecutive tx reverts (possible attack or contract issue)
     */
    async checkForAnomalies(proposedCantonAssets) {
        if (this.anomalyDetector.pauseTriggered) {
            console.error("[PauseGuardian] Bridge already paused by relay. Waiting for manual review.");
            return false; // Block all submissions
        }
        // Check supply cap change magnitude
        try {
            if (this.anomalyDetector.lastKnownSupplyCap === 0n) {
                // First attestation — initialize baseline
                const currentCap = await this.bridgeContract.getCurrentSupplyCap();
                this.anomalyDetector.lastKnownSupplyCap = BigInt(currentCap);
            }
            const currentCap = this.anomalyDetector.lastKnownSupplyCap;
            if (currentCap > 0n) {
                // Rough estimate of new cap: proposedAssets * 10000 / collateralRatio
                // We don't know exact ratio here, so compare asset change instead
                const lastAssets = await this.bridgeContract.attestedCantonAssets();
                const lastAssetsBn = BigInt(lastAssets);
                if (lastAssetsBn > 0n) {
                    const changeBps = lastAssetsBn > proposedCantonAssets
                        ? ((lastAssetsBn - proposedCantonAssets) * 10000n) / lastAssetsBn
                        : ((proposedCantonAssets - lastAssetsBn) * 10000n) / lastAssetsBn;
                    const thresholdBps = BigInt(this.anomalyDetector.maxCapChangePct * 100);
                    if (changeBps > thresholdBps) {
                        console.error(`[PauseGuardian] ANOMALY: Canton assets change ${Number(changeBps) / 100}% exceeds ` +
                            `${this.anomalyDetector.maxCapChangePct}% threshold. Auto-pausing bridge.`);
                        await this.triggerEmergencyPause(`Anomalous asset change: ${Number(changeBps) / 100}% (threshold: ${this.anomalyDetector.maxCapChangePct}%)`);
                        return false;
                    }
                }
            }
        }
        catch (err) {
            // Don't block on anomaly check failure — log and continue
            console.warn(`[PauseGuardian] Anomaly check failed (non-blocking): ${err.message}`);
        }
        return true;
    }
    /**
     * Record a transaction revert and check consecutive revert threshold
     */
    async recordRevert() {
        this.anomalyDetector.consecutiveReverts++;
        metrics_1.anomalyConsecutiveReverts.set(this.anomalyDetector.consecutiveReverts);
        if (this.anomalyDetector.consecutiveReverts >= this.anomalyDetector.maxConsecutiveReverts) {
            console.error(`[PauseGuardian] ${this.anomalyDetector.consecutiveReverts} consecutive reverts — auto-pausing bridge.`);
            await this.triggerEmergencyPause(`${this.anomalyDetector.consecutiveReverts} consecutive transaction reverts`);
        }
        this.updateMetricsSnapshot();
    }
    /**
     * Reset consecutive revert counter on successful transaction
     */
    recordSuccess() {
        this.anomalyDetector.consecutiveReverts = 0;
        metrics_1.anomalyConsecutiveReverts.set(0);
        this.updateMetricsSnapshot();
    }
    /**
     * Trigger emergency pause on the bridge contract.
     * Requires the relay signer to hold EMERGENCY_ROLE.
     */
    async triggerEmergencyPause(reason) {
        if (this.anomalyDetector.pauseTriggered)
            return;
        this.anomalyDetector.pauseTriggered = true;
        metrics_1.anomalyPauseTriggered.set(1);
        this.updateMetricsSnapshot();
        console.error(`[PauseGuardian] ⚠️  EMERGENCY PAUSE TRIGGERED: ${reason}`);
        try {
            // Check if already paused
            const PAUSE_ABI = [
                { inputs: [], name: "paused", outputs: [{ type: "bool" }], stateMutability: "view", type: "function" },
                { inputs: [], name: "pause", outputs: [], stateMutability: "nonpayable", type: "function" },
            ];
            const pausable = new ethers_1.ethers.Contract(this.config.bridgeContractAddress, PAUSE_ABI, this.wallet);
            const isPaused = await pausable.paused();
            if (isPaused) {
                console.warn("[PauseGuardian] Bridge is already paused.");
                return;
            }
            const tx = await pausable.pause();
            console.error(`[PauseGuardian] Pause tx: ${tx.hash}`);
            await tx.wait(1);
            console.error(`[PauseGuardian] ✓ Bridge paused successfully. Manual review required.`);
        }
        catch (err) {
            console.error(`[PauseGuardian] FAILED to pause bridge: ${err.message}`);
            console.error(`[PauseGuardian] The relay signer may not hold EMERGENCY_ROLE. Stopping relay as fallback.`);
            this.isRunning = false;
        }
    }
    // ============================================================
    //  H-3: NONCE REPLAY CHECK (relay-side dedup)
    // ============================================================
    /**
     * Check if a nonce has already been submitted by this relay instance.
     * Complements the on-chain `currentNonce + 1` check with in-flight dedup.
     */
    checkNonceReplay(nonce, attestationId) {
        if (this.submittedNonces.has(nonce)) {
            console.warn(`[NonceGuard] Nonce ${nonce} already submitted by this relay. Skipping duplicate.`);
            metrics_1.bridgeValidationFailuresTotal.labels("nonce_replay").inc();
            return false;
        }
        if (this.inFlightAttestations.has(attestationId)) {
            console.warn(`[NonceGuard] Attestation ${attestationId} already in-flight. Skipping duplicate.`);
            metrics_1.bridgeValidationFailuresTotal.labels("attestation_in_flight").inc();
            return false;
        }
        return true;
    }
    /**
     * Mark a nonce and attestation as submitted (in-flight)
     */
    markNonceSubmitted(nonce, attestationId) {
        this.submittedNonces.add(nonce);
        this.inFlightAttestations.add(attestationId);
        metrics_1.inFlightAttestations.set(this.inFlightAttestations.size);
        // Evict old nonces if set grows too large
        if (this.submittedNonces.size > 1000) {
            const toEvict = Array.from(this.submittedNonces).slice(0, 100);
            toEvict.forEach(n => this.submittedNonces.delete(n));
        }
        if (this.inFlightAttestations.size > 1000) {
            const toEvict = Array.from(this.inFlightAttestations).slice(0, 100);
            toEvict.forEach(id => this.inFlightAttestations.delete(id));
        }
        this.updateMetricsSnapshot();
    }
    /**
     * Clear only the in-flight marker after a successful confirmation.
     * Keep nonce in submittedNonces to avoid duplicate same-process submissions.
     */
    clearInFlightAttestation(attestationId) {
        this.inFlightAttestations.delete(attestationId);
        metrics_1.inFlightAttestations.set(this.inFlightAttestations.size);
        this.updateMetricsSnapshot();
    }
    /**
     * Roll back nonce and attestation in-flight markers when submission fails.
     * This allows safe retries after local/provider/tx failure paths.
     */
    unmarkNonceSubmitted(nonce, attestationId) {
        this.submittedNonces.delete(nonce);
        this.inFlightAttestations.delete(attestationId);
        metrics_1.inFlightAttestations.set(this.inFlightAttestations.size);
        this.updateMetricsSnapshot();
    }
    // ============================================================
    //  M-3: LOG REDACTION
    // ============================================================
    /**
     * Redact sensitive data from log output.
     * Masks private keys, API keys, and bearer tokens.
     */
    static redact(msg) {
        return msg
            // Private keys (64 hex chars)
            .replace(/\b(0x)?[0-9a-fA-F]{64}\b/g, "[REDACTED_KEY]")
            // Bearer tokens
            .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
            // Alchemy/Infura API keys in URLs
            .replace(/(\/v2\/|\/v3\/)[a-zA-Z0-9_-]{20,}/g, "$1[REDACTED_API_KEY]");
    }
    /**
     * Load attestation IDs that have already been processed on-chain
     */
    async loadProcessedAttestations() {
        console.log("[Relay] Loading processed attestations from chain...");
        // MEDIUM-02: Configurable lookback window (default 200,000 blocks ≈ 28 days)
        const filter = this.bridgeContract.filters.AttestationReceived();
        const currentBlock = await this.provider.getBlockNumber();
        const maxRange = this.config.replayLookbackBlocks;
        const fromBlock = Math.max(0, currentBlock - maxRange);
        // Paginate in chunks of 10,000 to avoid RPC limits
        const chunkSize = 10000;
        let events = [];
        for (let start = fromBlock; start <= currentBlock; start += chunkSize) {
            const end = Math.min(start + chunkSize - 1, currentBlock);
            const chunk = await this.bridgeContract.queryFilter(filter, start, end);
            events = events.concat(chunk);
        }
        for (const event of events) {
            const args = event.args;
            if (args) {
                this.processedAttestations.add(args.id);
            }
        }
        console.log(`[Relay] Found ${this.processedAttestations.size} processed attestations`);
    }
    // Maximum attestations to process per poll cycle to prevent memory exhaustion
    static MAX_BATCH_SIZE = 100;
    /**
     * Poll Canton for finalized attestations ready to bridge
     * Added pagination to prevent memory exhaustion on large backlogs.
     * Processes up to MAX_BATCH_SIZE attestations per cycle, prioritizing by nonce.
     */
    async pollForAttestations() {
        // Query active AttestationRequest contracts via Canton v2 HTTP API
        // Filter by aggregator party to only see attestations assigned to us
        let attestations;
        try {
            attestations = await this.canton.queryContracts(canton_client_1.TEMPLATES.AttestationRequest, (payload) => payload.aggregator === this.config.cantonParty);
        }
        catch (error) {
            console.error(`[Relay] Failed to query attestations: ${error}`);
            return;
        }
        // Limit batch size to prevent memory issues
        if (attestations.length > RelayService.MAX_BATCH_SIZE) {
            console.warn(`[Relay] Large backlog detected: ${attestations.length} attestations. Processing first ${RelayService.MAX_BATCH_SIZE}`);
            // Sort by nonce to process in order, then take first batch
            attestations = attestations
                .sort((a, b) => Number(a.payload.payload.nonce) - Number(b.payload.payload.nonce))
                .slice(0, RelayService.MAX_BATCH_SIZE);
        }
        // Track processed count for this cycle
        let processedThisCycle = 0;
        for (const attestation of attestations) {
            const payload = attestation.payload.payload;
            const attestationId = payload.attestationId;
            // Skip if already processed
            if (this.processedAttestations.has(attestationId)) {
                continue;
            }
            // BRIDGE-M-01: Check the count of actual ECDSA signatures, not the party set.
            // collectedSignatures tracks which parties have signed (DAML Set), but
            // ecdsaSignatures contains the actual cryptographic signatures needed for
            // Ethereum verification. If ECDSA sigs are missing/invalid, the party set
            // count would overstate the number of usable signatures.
            const ecdsaSigs = attestation.payload.ecdsaSignatures;
            const minSigs = await this.bridgeContract.minSignatures();
            if (ecdsaSigs.length < Number(minSigs)) {
                console.log(`[Relay] Attestation ${attestationId}: ${ecdsaSigs.length}/${minSigs} ECDSA signatures`);
                metrics_1.bridgeValidationFailuresTotal.labels("insufficient_ecdsa_signatures").inc();
                continue;
            }
            // Check if nonce matches expected
            const currentNonce = await this.bridgeContract.currentNonce();
            const expectedNonce = Number(currentNonce) + 1;
            if (Number(payload.nonce) !== expectedNonce) {
                console.log(`[Relay] Attestation ${attestationId}: nonce mismatch (got ${payload.nonce}, expected ${expectedNonce})`);
                metrics_1.bridgeValidationFailuresTotal.labels("nonce_mismatch").inc();
                continue;
            }
            // H-3: Relay-side nonce replay check (catches in-flight duplicates)
            if (!this.checkNonceReplay(Number(payload.nonce), attestationId)) {
                continue;
            }
            // H-1: Rate limit check before fetching signatures (avoid unnecessary work)
            if (!(await this.checkRateLimit())) {
                console.warn(`[Relay] Rate-limited — deferring attestation ${attestationId} to next cycle`);
                break; // Stop processing this cycle entirely
            }
            // H-2: Anomaly detection — check proposed asset change magnitude
            const proposedAssets = ethers_1.ethers.parseUnits(payload.globalCantonAssets, 18);
            if (!(await this.checkForAnomalies(proposedAssets))) {
                break; // Pause triggered — stop processing
            }
            // Fetch validator signatures
            const validatorSigs = await this.fetchValidatorSignatures(attestation.contractId);
            if (validatorSigs.length < Number(minSigs)) {
                console.log(`[Relay] Attestation ${attestationId}: not enough valid signatures`);
                metrics_1.bridgeValidationFailuresTotal.labels("insufficient_valid_signatures").inc();
                continue;
            }
            // Bridge it
            console.log(`[Relay] Bridging attestation ${attestationId}...`);
            await this.bridgeAttestation(payload, validatorSigs, attestation);
            processedThisCycle++;
        }
        if (processedThisCycle > 0) {
            console.log(`[Relay] Processed ${processedThisCycle} attestations this cycle`);
        }
    }
    // ============================================================
    //  DIRECTION 2: Ethereum → Canton (Bridge-Out Watcher)
    // ============================================================
    /**
     * Load bridge-out request IDs that have already been relayed to Canton
     */
    async loadProcessedBridgeOuts() {
        console.log("[Relay] Loading processed bridge-out requests from chain...");
        const filter = this.bridgeContract.filters.BridgeToCantonRequested();
        const currentBlock = await this.provider.getBlockNumber();
        const maxRange = this.config.replayLookbackBlocks;
        const fromBlock = Math.max(0, currentBlock - maxRange);
        const chunkSize = 10000;
        let events = [];
        for (let start = fromBlock; start <= currentBlock; start += chunkSize) {
            const end = Math.min(start + chunkSize - 1, currentBlock);
            const chunk = await this.bridgeContract.queryFilter(filter, start, end);
            events = events.concat(chunk);
        }
        // FIX: Cross-check against Canton — only mark events as processed if a
        // BridgeInRequest already exists on the ledger for that nonce.
        // Previously this blindly added ALL on-chain events, causing missed relays
        // when the relay was down during a bridge-out.
        let cantonBridgeInNonces;
        try {
            const existingRequests = await this.canton.queryContracts(canton_client_1.TEMPLATES.BridgeInRequest);
            cantonBridgeInNonces = new Set(existingRequests.map(c => Number(c.payload.nonce)));
            console.log(`[Relay] Found ${cantonBridgeInNonces.size} existing BridgeInRequest contracts on Canton`);
        }
        catch {
            // If Canton query fails, fall back to marking all as processed (safe default)
            console.warn("[Relay] Could not query Canton for existing BridgeInRequests — marking all as processed");
            cantonBridgeInNonces = new Set(events.map(e => Number(e.args?.nonce)));
        }
        let unrelayed = 0;
        for (const event of events) {
            const args = event.args;
            if (args) {
                const nonce = Number(args.nonce);
                if (cantonBridgeInNonces.has(nonce)) {
                    this.processedBridgeOuts.add(args.requestId);
                }
                else {
                    unrelayed++;
                    // Leave unprocessed — watchEthereumBridgeOut will pick these up
                }
            }
        }
        this.lastScannedBlock = fromBlock; // Start scanning from fromBlock so unrelayed events are picked up
        metrics_1.lastScannedBlock.set(this.lastScannedBlock);
        console.log(`[Relay] Found ${this.processedBridgeOuts.size} already-relayed bridge-outs, ${unrelayed} pending relay (scanning from block ${fromBlock})`);
    }
    /**
     * Watch Ethereum for BridgeToCantonRequested events and relay to Canton.
     *
     * For each new event:
     *   1. Verify the event hasn't been processed yet
     *   2. Wait for sufficient confirmations
     *   3. Create a BridgeInRequest contract on Canton
     *   4. Exercise Bridge_ReceiveFromEthereum on BridgeService (if attestation exists)
     */
    async watchEthereumBridgeOut() {
        const currentBlock = await this.provider.getBlockNumber();
        // Only scan confirmed blocks
        const confirmedBlock = currentBlock - this.config.confirmations;
        if (confirmedBlock <= this.lastScannedBlock) {
            return; // No new confirmed blocks
        }
        const filter = this.bridgeContract.filters.BridgeToCantonRequested();
        // Chunk the query to stay within RPC block range limits (public RPCs cap at 50k)
        const chunkSize = 10000;
        let events = [];
        for (let start = this.lastScannedBlock + 1; start <= confirmedBlock; start += chunkSize) {
            const end = Math.min(start + chunkSize - 1, confirmedBlock);
            const chunk = await this.bridgeContract.queryFilter(filter, start, end);
            events = events.concat(chunk);
        }
        this.lastScannedBlock = confirmedBlock;
        metrics_1.lastScannedBlock.set(this.lastScannedBlock);
        if (events.length === 0)
            return;
        console.log(`[Relay] Found ${events.length} new BridgeToCantonRequested events`);
        for (const event of events) {
            const args = event.args;
            if (!args)
                continue;
            const requestId = args.requestId;
            const sender = args.sender;
            const amount = args.amount;
            const nonce = args.nonce;
            const cantonRecipient = args.cantonRecipient;
            const timestamp = args.timestamp;
            // Skip if already processed
            if (this.processedBridgeOuts.has(requestId)) {
                continue;
            }
            // Skip yield bridge events — handled by Direction 4 (processYieldBridgeIn)
            if (this.config.yieldDistributorAddress &&
                sender.toLowerCase() === this.config.yieldDistributorAddress.toLowerCase()) {
                console.log(`[Relay] Skipping yield bridge-out #${nonce} from YieldDistributor (handled by Direction 4)`);
                this.processedBridgeOuts.add(requestId); // Mark processed to avoid re-checking
                continue;
            }
            // Skip ETH Pool yield bridge events — handled by Direction 4b (processETHPoolYieldBridgeIn)
            if (this.config.ethPoolYieldDistributorAddress &&
                sender.toLowerCase() === this.config.ethPoolYieldDistributorAddress.toLowerCase()) {
                console.log(`[Relay] Skipping ETH Pool yield bridge-out #${nonce} from ETHPoolYieldDistributor (handled by Direction 4b)`);
                this.processedBridgeOuts.add(requestId);
                continue;
            }
            console.log(`[Relay] Bridge-out #${nonce}: ${ethers_1.ethers.formatEther(amount)} mUSD → Canton (${cantonRecipient})`);
            // TS-M-01 FIX: Validate Canton party ID format before passing to Canton ledger.
            // cantonRecipient comes from user-supplied Ethereum event args and must be sanitized.
            try {
                (0, utils_1.validateCantonPartyId)(cantonRecipient, `BridgeToCantonRequested event #${nonce}`);
            }
            catch (validationError) {
                console.error(`[Relay] ${validationError.message}`);
                metrics_1.bridgeOutsTotal.labels("validation_error").inc();
                metrics_1.bridgeValidationFailuresTotal.inc();
                this.processedBridgeOuts.add(requestId); // Mark processed to avoid retrying invalid data
                continue;
            }
            try {
                const chainId = Number((await this.provider.getNetwork()).chainId);
                const resolvedRecipient = (0, recipient_routing_1.resolveRecipientParty)(cantonRecipient, this.config.recipientPartyAliases);
                if (resolvedRecipient !== cantonRecipient) {
                    console.log(`[Relay] Remapped bridge-out #${nonce} recipient ${cantonRecipient} -> ${resolvedRecipient}`);
                    // Validate mapped value from config before use.
                    (0, utils_1.validateCantonPartyId)(resolvedRecipient, `CANTON_RECIPIENT_PARTY_ALIASES mapped recipient for bridge-out #${nonce}`);
                }
                const payload = {
                    operator: this.config.cantonParty,
                    user: resolvedRecipient,
                    amount: ethers_1.ethers.formatEther(amount),
                    feeAmount: "0.0",
                    sourceChainId: chainId,
                    nonce: Number(nonce),
                    createdAt: new Date(Number(timestamp) * 1000).toISOString(),
                    status: "pending",
                    // NOTE: The deployed DAML package does not include validators/requiredSignatures.
                    // These fields exist in the local V3.daml source but have not been redeployed.
                    // When the DAML package is recompiled and uploaded, re-enable these:
                    // validators: Object.keys(this.config.validatorAddresses),
                    // requiredSignatures: Math.max(1, Math.ceil(Object.keys(this.config.validatorAddresses).length / 2)),
                };
                try {
                    // Validate payload against DAML ensure constraints before submission
                    (0, daml_schema_validator_1.validateCreatePayload)("BridgeInRequest", payload);
                    // Create BridgeInRequest on Canton with the original user party
                    await this.canton.createContract(canton_client_1.TEMPLATES.BridgeInRequest, payload);
                    console.log(`[Relay] Created BridgeInRequest on Canton for bridge-out #${nonce}`);
                }
                catch (innerError) {
                    const errMsg = innerError?.message || "";
                    // If user party is unknown on this participant, fallback to operator as user
                    if (errMsg.includes("UNKNOWN_INFORMEES") || errMsg.includes("NO_SYNCHRONIZER") || errMsg.includes("PARTY_NOT_KNOWN")) {
                        console.warn(`[Relay] User party not on this participant for bridge-out #${nonce}, using operator as user fallback`);
                        payload.user = this.config.cantonParty;
                        (0, daml_schema_validator_1.validateCreatePayload)("BridgeInRequest", payload);
                        await this.canton.createContract(canton_client_1.TEMPLATES.BridgeInRequest, payload);
                        console.log(`[Relay] Created BridgeInRequest (operator-as-user fallback) for bridge-out #${nonce}`);
                    }
                    else {
                        throw innerError; // Re-throw non-party errors
                    }
                }
                // Step 2: Exercise BridgeIn_Complete to mark as completed
                // Then create CantonMUSD token for the user
                await this.completeBridgeInAndMintMusd(Number(nonce), ethers_1.ethers.formatEther(amount), String(payload.user));
                // Mark as processed
                this.processedBridgeOuts.add(requestId);
                metrics_1.bridgeOutsTotal.labels("success").inc();
                // Evict oldest entries if cache exceeds limit
                if (this.processedBridgeOuts.size > this.MAX_PROCESSED_CACHE) {
                    const toEvict = Math.floor(this.MAX_PROCESSED_CACHE * 0.1);
                    let evicted = 0;
                    for (const key of this.processedBridgeOuts) {
                        if (evicted >= toEvict)
                            break;
                        this.processedBridgeOuts.delete(key);
                        evicted++;
                    }
                }
            }
            catch (error) {
                console.error(`[Relay] Failed to relay bridge-out #${nonce} to Canton:`, error.message);
                metrics_1.bridgeOutsTotal.labels("error").inc();
                // Don't mark as processed — will retry next cycle
            }
        }
    }
    // ============================================================
    //  Bridge-In Completion: BridgeInRequest → CantonMUSD
    // ============================================================
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
    async completeBridgeInAndMintMusd(nonce, amountStr, userParty) {
        try {
            // Create CantonMUSD token for the user
            // Use a deterministic agreementHash for idempotency checking
            // IMPORTANT: Use a delimiter AFTER the nonce to prevent hash collisions.
            // Previously `bridge-in-nonce-1` padded === `bridge-in-nonce-10` padded (same string!)
            const agreementHash = `bridge-in:nonce:${nonce}:`.padEnd(64, "0");
            const agreementUri = `ethereum:bridge-in:${this.config.bridgeContractAddress}:nonce:${nonce}`;
            // Check for existing CantonMUSD with this agreement hash (idempotency)
            // Also check the old hash format for backwards compatibility, but ONLY
            // when the agreementUri also matches (old hash has collisions: nonce 1 == nonce 10)
            const oldAgreementHash = `bridge-in-nonce-${nonce}`.padEnd(64, "0");
            const existingMusd = await this.canton.queryContracts(canton_client_1.TEMPLATES.CantonMUSD, (payload) => {
                if (payload.agreementHash === agreementHash)
                    return true;
                // For old format, also verify agreementUri to avoid hash collisions
                if (payload.agreementHash === oldAgreementHash &&
                    payload.agreementUri === agreementUri)
                    return true;
                return false;
            });
            if (existingMusd.length > 0) {
                console.log(`[Relay] CantonMUSD for bridge #${nonce} already exists ` +
                    `(${existingMusd[0].contractId.slice(0, 16)}...) — skipping duplicate`);
                return;
            }
            // FIX: Create CantonMUSD with operator as BOTH issuer AND owner.
            // CantonMUSD template requires `signatory issuer, owner` — if the user party
            // is not known on this Canton participant, creation fails with UNKNOWN_INFORMEES.
            // Instead: operator mints (both signatory slots satisfied), then transfers to user.
            const cantonMusdPayload = {
                issuer: this.config.cantonParty,
                owner: this.config.cantonParty, // Operator-owned initially
                amount: amountStr,
                agreementHash,
                agreementUri,
                privacyObservers: [],
            };
            (0, daml_schema_validator_1.validateCreatePayload)("CantonMUSD", cantonMusdPayload);
            const createResult = await this.canton.createContract(canton_client_1.TEMPLATES.CantonMUSD, cantonMusdPayload);
            console.log(`[Relay] Created CantonMUSD (operator-owned) for bridge-in #${nonce}: ${amountStr} mUSD`);
            // Transfer to user if different from operator
            if (userParty !== this.config.cantonParty) {
                try {
                    // Extract the contractId of the just-created CantonMUSD
                    let musdCid = this.extractCreatedContractId(createResult, "CantonMUSD");
                    if (!musdCid) {
                        // Fallback: query by agreementHash
                        const created = await this.canton.queryContracts(canton_client_1.TEMPLATES.CantonMUSD, (p) => p.agreementHash === agreementHash && p.owner === this.config.cantonParty);
                        if (created.length > 0)
                            musdCid = created[0].contractId;
                    }
                    if (musdCid) {
                        // CantonMUSD_Transfer requires complianceRegistryCid — query for it
                        const complianceContracts = await this.canton.queryContracts(canton_client_1.TEMPLATES.ComplianceRegistry, (p) => p.operator === this.config.cantonParty).catch(() => []);
                        if (complianceContracts.length > 0) {
                            const transferArgs = { newOwner: userParty, complianceRegistryCid: complianceContracts[0].contractId };
                            (0, daml_schema_validator_1.validateExerciseArgs)("CantonMUSD_Transfer", transferArgs);
                            const transferResult = await this.canton.exerciseChoice(canton_client_1.TEMPLATES.CantonMUSD, musdCid, "CantonMUSD_Transfer", transferArgs);
                            console.log(`[Relay] ✅ Transfer proposal created for bridge #${nonce} → ${userParty.slice(0, 30)}...`);
                            if (this.config.autoAcceptMusdTransferProposals) {
                                try {
                                    let proposalCid = this.extractCreatedContractId(transferResult, "CantonMUSDTransferProposal");
                                    if (!proposalCid) {
                                        const proposals = await this.canton.queryContracts(canton_client_1.TEMPLATES.CantonMUSDTransferProposal, (p) => p?.newOwner === userParty &&
                                            p?.musd?.agreementUri === agreementUri &&
                                            p?.musd?.owner === this.config.cantonParty).catch(() => []);
                                        if (proposals.length > 0) {
                                            proposalCid = proposals[0].contractId;
                                        }
                                    }
                                    if (proposalCid) {
                                        await this.canton.exerciseChoice(canton_client_1.TEMPLATES.CantonMUSDTransferProposal, proposalCid, "CantonMUSDTransferProposal_Accept", {}, [userParty]);
                                        console.log(`[Relay] ✅ Auto-accepted transfer proposal for bridge #${nonce}; mUSD delivered to user`);
                                    }
                                    else {
                                        console.warn(`[Relay] Could not resolve transfer proposal CID for bridge #${nonce}; user must accept manually`);
                                    }
                                }
                                catch (autoAcceptErr) {
                                    console.warn(`[Relay] Auto-accept failed for bridge #${nonce}; proposal remains pending: ${autoAcceptErr.message?.slice(0, 120)}`);
                                }
                            }
                        }
                        else {
                            console.warn(`[Relay] No ComplianceRegistry found — operator retains CantonMUSD #${nonce} (user can claim later)`);
                        }
                    }
                    else {
                        console.warn(`[Relay] Could not find CantonMUSD CID for transfer to user (bridge #${nonce})`);
                    }
                }
                catch (transferErr) {
                    // Non-fatal: mUSD exists operator-owned; user can claim later
                    console.warn(`[Relay] Transfer to user failed for bridge #${nonce} (operator retains): ${transferErr.message?.slice(0, 120)}`);
                }
            }
            else {
                console.log(`[Relay] ✅ CantonMUSD for bridge-in #${nonce}: ${amountStr} mUSD → operator (user = operator)`);
            }
            // Exercise BridgeIn_Complete properly: create an AttestationRequest on Canton,
            // then exercise BridgeIn_Complete with the attestation CID.
            try {
                const pendingRequests = await this.canton.queryContracts(canton_client_1.TEMPLATES.BridgeInRequest, (p) => Number(p.nonce) === nonce && p.status === "pending");
                if (pendingRequests.length > 0) {
                    const req = pendingRequests[0];
                    const hasAttestationFields = req.payload.validators && req.payload.requiredSignatures > 0;
                    if (hasAttestationFields) {
                        // New template: create AttestationRequest, collect sigs, exercise BridgeIn_Complete
                        try {
                            const chainId = Number((await this.provider.getNetwork()).chainId);
                            const attestationPayload = {
                                attestationId: `bridge-in-attest-${nonce}`,
                                globalCantonAssets: "0.0",
                                targetAddress: ethers_1.ethers.ZeroAddress,
                                amount: amountStr,
                                isMint: false,
                                nonce: String(nonce),
                                chainId: String(chainId),
                                expiresAt: new Date(Date.now() + 3600000).toISOString(),
                                entropy: ethers_1.ethers.hexlify(crypto.randomBytes(32)),
                                cantonStateHash: ethers_1.ethers.ZeroHash,
                            };
                            // Create AttestationRequest on Canton for the bridge-in direction
                            const attestPayload = {
                                aggregator: this.config.cantonParty,
                                validatorGroup: req.payload.validators,
                                payload: attestationPayload,
                                positionCids: [],
                                collectedSignatures: req.payload.validators, // All validators attest (operator-controlled)
                                ecdsaSignatures: [],
                                requiredSignatures: req.payload.requiredSignatures,
                                direction: "EthereumToCanton",
                            };
                            (0, daml_schema_validator_1.validateCreatePayload)("AttestationRequest", attestPayload);
                            const attestResult = await this.canton.createContract(canton_client_1.TEMPLATES.AttestationRequest, attestPayload);
                            // Extract attestation CID
                            let attestCid = this.extractCreatedContractId(attestResult, "AttestationRequest");
                            if (!attestCid) {
                                const attestContracts = await this.canton.queryContracts(canton_client_1.TEMPLATES.AttestationRequest, (p) => p.payload?.attestationId === `bridge-in-attest-${nonce}` &&
                                    p.direction === "EthereumToCanton");
                                if (attestContracts.length > 0)
                                    attestCid = attestContracts[0].contractId;
                            }
                            if (attestCid) {
                                const completeArgs = { attestationCid: attestCid };
                                (0, daml_schema_validator_1.validateExerciseArgs)("BridgeIn_Complete", completeArgs);
                                await this.canton.exerciseChoice(canton_client_1.TEMPLATES.BridgeInRequest, req.contractId, "BridgeIn_Complete", completeArgs);
                                console.log(`[Relay] ✅ BridgeIn_Complete exercised for #${nonce} with attestation ${attestCid.slice(0, 16)}...`);
                            }
                            else {
                                console.warn(`[Relay] Could not find AttestationRequest CID for BridgeIn_Complete #${nonce}`);
                            }
                        }
                        catch (attestErr) {
                            console.warn(`[Relay] BridgeIn_Complete with attestation failed for #${nonce}: ${attestErr.message?.slice(0, 120)}`);
                            // Fallback: cancel to archive
                            try {
                                await this.canton.exerciseChoice(canton_client_1.TEMPLATES.BridgeInRequest, req.contractId, "BridgeIn_Cancel", {});
                                console.log(`[Relay] Archived BridgeInRequest #${nonce} via cancel (attestation flow failed)`);
                            }
                            catch { /* best-effort */ }
                        }
                    }
                    else {
                        // Old template without attestation fields — cancel to archive
                        try {
                            await this.canton.exerciseChoice(canton_client_1.TEMPLATES.BridgeInRequest, req.contractId, "BridgeIn_Cancel", {});
                            console.log(`[Relay] Archived old BridgeInRequest #${nonce} (no attestation fields)`);
                        }
                        catch (cancelErr) {
                            console.warn(`[Relay] Could not archive BridgeInRequest #${nonce}: ${cancelErr.message?.slice(0, 100)}`);
                        }
                    }
                }
            }
            catch (queryErr) {
                console.warn(`[Relay] Could not query BridgeInRequest #${nonce}: ${queryErr.message?.slice(0, 100)}`);
            }
        }
        catch (error) {
            console.error(`[Relay] Failed to complete bridge-in #${nonce}: ${error.message}`);
            // Don't re-throw — we can retry later
        }
    }
    /**
     * Process any pending BridgeInRequests that haven't been completed yet.
     * Called on startup to catch up on any missed completions.
     */
    async processPendingBridgeInRequests() {
        try {
            const pendingRequests = await this.canton.queryContracts(canton_client_1.TEMPLATES.BridgeInRequest, (p) => p.status === "pending");
            if (pendingRequests.length === 0) {
                console.log("[Relay] No pending BridgeInRequests to process");
                return;
            }
            console.log(`[Relay] Found ${pendingRequests.length} pending BridgeInRequests — completing...`);
            for (const req of pendingRequests) {
                const nonce = Number(req.payload.nonce);
                await this.completeBridgeInAndMintMusd(nonce, req.payload.amount, req.payload.user || req.payload.operator);
            }
        }
        catch (error) {
            console.error(`[Relay] Failed to process pending BridgeInRequests: ${error.message}`);
        }
    }
    // ============================================================
    //  DIRECTION 4: Ethereum → Canton (Yield Bridge-In)
    // ============================================================
    /**
     * Load already-processed yield epochs from chain to prevent replay on restart.
     */
    async loadProcessedYieldBridgeIns() {
        if (!this.yieldDistributorContract)
            return;
        console.log("[Relay] Loading processed yield bridge-in epochs from chain...");
        const currentBlock = await this.provider.getBlockNumber();
        const maxRange = this.config.replayLookbackBlocks;
        const fromBlock = Math.max(0, currentBlock - maxRange);
        const filter = this.yieldDistributorContract.filters.CantonYieldBridged();
        const chunkSize = 10000;
        let events = [];
        for (let start = fromBlock; start <= currentBlock; start += chunkSize) {
            const end = Math.min(start + chunkSize - 1, currentBlock);
            const chunk = await this.yieldDistributorContract.queryFilter(filter, start, end);
            events = events.concat(chunk);
        }
        for (const event of events) {
            const args = event.args;
            if (args) {
                this.processedYieldEpochs.add(args.epoch.toString());
            }
        }
        this.lastYieldScannedBlock = currentBlock;
        console.log(`[Relay] Found ${this.processedYieldEpochs.size} yield epochs (scanning from block ${fromBlock})`);
    }
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
    async processYieldBridgeIn() {
        if (!this.yieldDistributorContract)
            return;
        const currentBlock = await this.provider.getBlockNumber();
        const confirmedBlock = currentBlock - this.config.confirmations;
        if (confirmedBlock <= this.lastYieldScannedBlock)
            return;
        const filter = this.yieldDistributorContract.filters.CantonYieldBridged();
        const events = await this.yieldDistributorContract.queryFilter(filter, this.lastYieldScannedBlock + 1, confirmedBlock);
        this.lastYieldScannedBlock = confirmedBlock;
        if (events.length === 0)
            return;
        console.log(`[Relay] Found ${events.length} new CantonYieldBridged events`);
        for (const event of events) {
            const args = event.args;
            if (!args)
                continue;
            const epoch = args.epoch.toString();
            const musdAmount = args.musdAmount;
            const cantonRecipient = args.cantonRecipient;
            if (this.processedYieldEpochs.has(epoch))
                continue;
            const amountStr = ethers_1.ethers.formatEther(musdAmount);
            console.log(`[Relay] Yield epoch #${epoch}: ${amountStr} mUSD → Canton staking pool (${cantonRecipient})`);
            try {
                // MEDIUM-02: Canton-side duplicate check before creating CantonMUSD
                // FIX: Pad agreementHash to 64 characters for consistency with bridge-in flow
                const agreementHash = `yield-epoch:${epoch}:`.padEnd(64, "0");
                const existingMusd = await this.canton.queryContracts(canton_client_1.TEMPLATES.CantonMUSD, (payload) => payload.owner === this.config.cantonParty &&
                    (payload.agreementHash === agreementHash ||
                        payload.agreementHash === `yield-epoch-${epoch}`) // backwards compat
                );
                if (existingMusd.length > 0) {
                    console.log(`[Relay] Yield epoch #${epoch} already has CantonMUSD on Canton ` +
                        `(${existingMusd[0].contractId.slice(0, 16)}...) — skipping duplicate create`);
                    this.processedYieldEpochs.add(epoch);
                    this.persistState();
                    continue;
                }
                // Step 1: Create CantonMUSD on Canton (operator-owned yield mUSD)
                const yieldMusdPayload = {
                    issuer: this.config.cantonParty,
                    owner: this.config.cantonParty,
                    amount: amountStr,
                    agreementHash,
                    agreementUri: `ethereum:yield-distributor:${this.config.yieldDistributorAddress}`,
                    privacyObservers: [],
                };
                (0, daml_schema_validator_1.validateCreatePayload)("CantonMUSD", yieldMusdPayload);
                const createResult = await this.canton.createContract(canton_client_1.TEMPLATES.CantonMUSD, yieldMusdPayload);
                // Extract contractId from create response
                // The v2 submit-and-wait response includes the completion with created events
                const musdContractId = this.extractCreatedContractId(createResult, "CantonMUSD");
                if (!musdContractId) {
                    // Fallback: query for the most recent CantonMUSD owned by operator
                    const musdContracts = await this.canton.queryContracts(canton_client_1.TEMPLATES.CantonMUSD, (payload) => payload.owner === this.config.cantonParty &&
                        (payload.agreementHash === agreementHash ||
                            payload.agreementHash === `yield-epoch-${epoch}`) // backwards compat
                    );
                    if (musdContracts.length === 0) {
                        throw new Error("Created CantonMUSD not found on Canton after create");
                    }
                    const latestMusd = musdContracts[musdContracts.length - 1];
                    console.log(`[Relay] CantonMUSD created (queried): ${latestMusd.contractId}`);
                    await this.creditCantonStakingPool(latestMusd.contractId, epoch, amountStr);
                }
                else {
                    console.log(`[Relay] CantonMUSD created: ${musdContractId}`);
                    await this.creditCantonStakingPool(musdContractId, epoch, amountStr);
                }
                // Mark epoch as processed
                this.processedYieldEpochs.add(epoch);
                // MEDIUM-02: Persist state to disk after each successful processing
                this.persistState();
                // Cache eviction
                if (this.processedYieldEpochs.size > this.MAX_PROCESSED_CACHE) {
                    const toEvict = Math.floor(this.MAX_PROCESSED_CACHE * 0.1);
                    let evicted = 0;
                    for (const key of this.processedYieldEpochs) {
                        if (evicted >= toEvict)
                            break;
                        this.processedYieldEpochs.delete(key);
                        evicted++;
                    }
                }
            }
            catch (error) {
                console.error(`[Relay] Failed to process yield epoch #${epoch}: ${error.message}`);
                // Don't mark as processed — retry next cycle
            }
        }
    }
    /**
     * Exercise ReceiveYield on CantonStakingService to credit the staking pool.
     */
    async creditCantonStakingPool(musdContractId, epoch, amountStr) {
        // Step 2: Query CantonStakingService to get its contractId
        const stakingServices = await this.canton.queryContracts(canton_client_1.TEMPLATES.CantonStakingService, (payload) => payload.operator === this.config.cantonParty);
        if (stakingServices.length === 0) {
            throw new Error("No CantonStakingService found on Canton — cannot credit yield");
        }
        const stakingService = stakingServices[0];
        // Step 3: Exercise ReceiveYield — merges mUSD into vault, pooledMusd ↑
        // ReceiveYield requires `controller operator, governance` — include governance in actAs
        const receiveYieldArgs = { yieldMusdCid: musdContractId };
        (0, daml_schema_validator_1.validateExerciseArgs)("ReceiveYield", receiveYieldArgs);
        await this.canton.exerciseChoice(canton_client_1.TEMPLATES.CantonStakingService, stakingService.contractId, "ReceiveYield", receiveYieldArgs, this.config.cantonGovernanceParty ? [this.config.cantonGovernanceParty] : []);
        console.log(`[Relay] ✅ Yield epoch #${epoch}: ${amountStr} mUSD credited to Canton staking pool ` +
            `(service: ${stakingService.contractId.slice(0, 16)}...)`);
    }
    // ============================================================
    //  DIRECTION 4b: Ethereum → Canton (ETH Pool Yield Bridge-In)
    // ============================================================
    /**
     * Load already-processed ETH Pool yield epochs from chain to prevent replay on restart.
     */
    async loadProcessedETHPoolYieldBridgeIns() {
        if (!this.ethPoolYieldDistributorContract)
            return;
        console.log("[Relay] Loading processed ETH Pool yield bridge-in epochs from chain...");
        const currentBlock = await this.provider.getBlockNumber();
        const maxRange = this.config.replayLookbackBlocks;
        const fromBlock = Math.max(0, currentBlock - maxRange);
        const filter = this.ethPoolYieldDistributorContract.filters.ETHPoolYieldBridged();
        const chunkSize = 10000;
        let events = [];
        for (let start = fromBlock; start <= currentBlock; start += chunkSize) {
            const end = Math.min(start + chunkSize - 1, currentBlock);
            const chunk = await this.ethPoolYieldDistributorContract.queryFilter(filter, start, end);
            events = events.concat(chunk);
        }
        for (const event of events) {
            const args = event.args;
            if (args) {
                this.processedETHPoolYieldEpochs.add(args.epoch.toString());
            }
        }
        this.lastETHPoolYieldScannedBlock = currentBlock;
        console.log(`[Relay] Found ${this.processedETHPoolYieldEpochs.size} ETH Pool yield epochs (scanning from block ${fromBlock})`);
    }
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
    async processETHPoolYieldBridgeIn() {
        if (!this.ethPoolYieldDistributorContract)
            return;
        const currentBlock = await this.provider.getBlockNumber();
        const confirmedBlock = currentBlock - this.config.confirmations;
        if (confirmedBlock <= this.lastETHPoolYieldScannedBlock)
            return;
        const filter = this.ethPoolYieldDistributorContract.filters.ETHPoolYieldBridged();
        const events = await this.ethPoolYieldDistributorContract.queryFilter(filter, this.lastETHPoolYieldScannedBlock + 1, confirmedBlock);
        this.lastETHPoolYieldScannedBlock = confirmedBlock;
        if (events.length === 0)
            return;
        console.log(`[Relay] Found ${events.length} new ETHPoolYieldBridged events`);
        for (const event of events) {
            const args = event.args;
            if (!args)
                continue;
            const epoch = args.epoch.toString();
            const musdBridged = args.musdBridged;
            const ethPoolRecipient = args.ethPoolRecipient;
            if (this.processedETHPoolYieldEpochs.has(epoch))
                continue;
            const amountStr = ethers_1.ethers.formatEther(musdBridged);
            console.log(`[Relay] ETH Pool yield epoch #${epoch}: ${amountStr} mUSD → Canton ETH Pool (${ethPoolRecipient})`);
            try {
                // MEDIUM-02: Canton-side duplicate check — query for existing CantonMUSD
                // with matching agreementHash before creating a new one. This prevents
                // orphaned CantonMUSD contracts if the relay restarts and re-encounters
                // an event that was processed but not persisted.
                // FIX: Pad agreementHash to 64 characters for consistency with bridge-in flow
                const agreementHash = `ethpool-yield-epoch:${epoch}:`.padEnd(64, "0");
                const existingMusd = await this.canton.queryContracts(canton_client_1.TEMPLATES.CantonMUSD, (payload) => payload.owner === this.config.cantonParty &&
                    (payload.agreementHash === agreementHash ||
                        payload.agreementHash === `ethpool-yield-epoch-${epoch}`) // backwards compat
                );
                if (existingMusd.length > 0) {
                    console.log(`[Relay] ETH Pool yield epoch #${epoch} already has CantonMUSD on Canton ` +
                        `(${existingMusd[0].contractId.slice(0, 16)}...) — skipping duplicate create`);
                    this.processedETHPoolYieldEpochs.add(epoch);
                    this.persistState();
                    continue;
                }
                // Step 1: Create CantonMUSD on Canton (operator-owned yield mUSD)
                const ethPoolMusdPayload = {
                    issuer: this.config.cantonParty,
                    owner: this.config.cantonParty,
                    amount: amountStr,
                    agreementHash,
                    agreementUri: `ethereum:ethpool-yield-distributor:${this.config.ethPoolYieldDistributorAddress}`,
                    privacyObservers: [],
                };
                (0, daml_schema_validator_1.validateCreatePayload)("CantonMUSD", ethPoolMusdPayload);
                const createResult = await this.canton.createContract(canton_client_1.TEMPLATES.CantonMUSD, ethPoolMusdPayload);
                // Extract contractId from create response
                const musdContractId = this.extractCreatedContractId(createResult, "CantonMUSD");
                if (!musdContractId) {
                    // Fallback: query for the most recent CantonMUSD owned by operator
                    const musdContracts = await this.canton.queryContracts(canton_client_1.TEMPLATES.CantonMUSD, (payload) => payload.owner === this.config.cantonParty &&
                        (payload.agreementHash === agreementHash ||
                            payload.agreementHash === `ethpool-yield-epoch-${epoch}`) // backwards compat
                    );
                    if (musdContracts.length === 0) {
                        throw new Error("Created CantonMUSD not found on Canton after create (ETH Pool)");
                    }
                    const latestMusd = musdContracts[musdContracts.length - 1];
                    console.log(`[Relay] CantonMUSD created for ETH Pool (queried): ${latestMusd.contractId}`);
                    await this.creditCantonETHPool(latestMusd.contractId, epoch, amountStr);
                }
                else {
                    console.log(`[Relay] CantonMUSD created for ETH Pool: ${musdContractId}`);
                    await this.creditCantonETHPool(musdContractId, epoch, amountStr);
                }
                // Mark epoch as processed
                this.processedETHPoolYieldEpochs.add(epoch);
                // MEDIUM-02: Persist state to disk after each successful processing
                this.persistState();
                // Cache eviction
                if (this.processedETHPoolYieldEpochs.size > this.MAX_PROCESSED_CACHE) {
                    const toEvict = Math.floor(this.MAX_PROCESSED_CACHE * 0.1);
                    let evicted = 0;
                    for (const key of this.processedETHPoolYieldEpochs) {
                        if (evicted >= toEvict)
                            break;
                        this.processedETHPoolYieldEpochs.delete(key);
                        evicted++;
                    }
                }
            }
            catch (error) {
                console.error(`[Relay] Failed to process ETH Pool yield epoch #${epoch}: ${error.message}`);
                // Don't mark as processed — retry next cycle
            }
        }
    }
    /**
     * Exercise ETHPool_ReceiveYield on CantonETHPoolService to credit the ETH Pool.
     * This increments pooledUsdc, which raises the ETH Pool share price.
     */
    async creditCantonETHPool(musdContractId, epoch, amountStr) {
        // Query CantonETHPoolService to get its contractId
        const ethPoolServices = await this.canton.queryContracts(canton_client_1.TEMPLATES.CantonETHPoolService, (payload) => payload.operator === this.config.cantonParty);
        if (ethPoolServices.length === 0) {
            throw new Error("No CantonETHPoolService found on Canton — cannot credit ETH Pool yield");
        }
        const ethPoolService = ethPoolServices[0];
        // Exercise ETHPool_ReceiveYield — archives mUSD, increments pooledUsdc
        // ETHPool_ReceiveYield may require `controller operator, governance` — include governance in actAs
        await this.canton.exerciseChoice(canton_client_1.TEMPLATES.CantonETHPoolService, ethPoolService.contractId, "ETHPool_ReceiveYield", { yieldMusdCid: musdContractId }, this.config.cantonGovernanceParty ? [this.config.cantonGovernanceParty] : []);
        console.log(`[Relay] ✅ ETH Pool yield epoch #${epoch}: ${amountStr} mUSD credited to Canton ETH Pool ` +
            `(service: ${ethPoolService.contractId.slice(0, 16)}...)`);
    }
    /**
     * Extract the created contract ID from a v2 submit-and-wait response.
     * Returns null if the response format doesn't contain a recognizable contractId.
     */
    extractCreatedContractId(response, entityName) {
        try {
            const resp = response;
            // Daml JSON API v2 submit-and-wait returns a transaction with events
            const transaction = resp?.transaction || resp?.result?.transaction;
            if (!transaction)
                return null;
            const events = transaction.events || transaction.eventsById;
            if (!events)
                return null;
            // events can be an array or a map
            const eventList = Array.isArray(events) ? events : Object.values(events);
            for (const evt of eventList) {
                const created = evt?.CreatedEvent || evt?.created || evt;
                if (created?.contractId && created?.templateId?.includes(entityName)) {
                    return created.contractId;
                }
            }
        }
        catch {
            /* Response format not recognized — fall back to query */
        }
        return null;
    }
    /**
     * Resolve Treasury asset address across contract versions.
     * TreasuryV2 exposes `asset()`; older deployments may still expose `usdc()`.
     */
    async resolveTreasuryAssetAddress(treasury) {
        try {
            const assetAddress = await treasury.asset();
            return ethers_1.ethers.getAddress(assetAddress);
        }
        catch (assetErr) {
            try {
                const usdcAddress = await treasury.usdc();
                const normalized = ethers_1.ethers.getAddress(usdcAddress);
                console.warn(`[Relay] Treasury does not expose asset(); falling back to usdc() at ${normalized}`);
                return normalized;
            }
            catch (usdcErr) {
                console.error(`[Relay] Failed to resolve Treasury asset via asset()/usdc(): ` +
                    `assetErr=${assetErr?.message || assetErr} usdcErr=${usdcErr?.message || usdcErr}`);
                return null;
            }
        }
    }
    /**
     * Log pending RedemptionRequest backlog to make settlement progress explicit.
     */
    async logPendingRedemptionBacklog(pendingRedemptionsInput, actionableCountInput) {
        const pendingRedemptions = pendingRedemptionsInput ?? await this.canton.queryContracts(canton_client_1.TEMPLATES.RedemptionRequest, (p) => p.operator === this.config.cantonParty && !p.fulfilled);
        const actionableCount = actionableCountInput ??
            pendingRedemptions.filter((r) => !this.processedRedemptionRequests.has(r.contractId)).length;
        if (pendingRedemptions.length === 0) {
            if (this.lastRedemptionBacklogSize > 0) {
                console.log("[Relay] RedemptionRequest backlog cleared");
            }
            this.lastRedemptionBacklogSize = 0;
            return;
        }
        const now = Date.now();
        const shouldLog = pendingRedemptions.length !== this.lastRedemptionBacklogSize ||
            now - this.lastRedemptionBacklogLogAt >= RelayService.DIAGNOSTIC_LOG_INTERVAL_MS;
        if (!shouldLog)
            return;
        let totalUsdcOwed = 0;
        for (const request of pendingRedemptions) {
            const owed = Number(request.payload.usdcOwed);
            if (!Number.isNaN(owed))
                totalUsdcOwed += owed;
        }
        const alreadySettled = pendingRedemptions.length - actionableCount;
        console.warn(`[Relay] Found ${pendingRedemptions.length} pending RedemptionRequests ` +
            `(total owed: ${totalUsdcOwed.toFixed(6)} mUSD-equivalent). ` +
            `${actionableCount} actionable for Ethereum payout, ${alreadySettled} already settled locally.`);
        this.lastRedemptionBacklogSize = pendingRedemptions.length;
        this.lastRedemptionBacklogLogAt = now;
    }
    /**
     * Parse DAML Numeric 18 values into wei-like bigint units.
     */
    parseDamlNumeric18(value, field) {
        try {
            return ethers_1.ethers.parseUnits(value, 18);
        }
        catch {
            throw new Error(`Invalid DAML Numeric(18) for ${field}: "${value}"`);
        }
    }
    /**
     * Load previously settled redemption IDs from on-ledger settlement markers.
     * This protects against replay after relay state-file loss.
     */
    async loadProcessedRedemptionsFromLedgerMarkers() {
        if (this.redemptionSettlementMarkerSupported === false)
            return;
        try {
            const markers = await this.canton.queryContracts(canton_client_1.TEMPLATES.RedemptionEthereumSettlement, (p) => p.operator === this.config.cantonParty);
            let loaded = 0;
            for (const marker of markers) {
                const cid = marker.payload.redemptionCid;
                if (!cid)
                    continue;
                if (!this.processedRedemptionRequests.has(cid)) {
                    this.processedRedemptionRequests.add(cid);
                    loaded++;
                }
            }
            if (loaded > 0) {
                console.log(`[Relay] Loaded ${loaded} settled redemptions from on-ledger markers`);
            }
            this.redemptionSettlementMarkerSupported = true;
        }
        catch (error) {
            const msg = String(error?.message || error);
            // If template is not yet deployed/vetted, keep relay operational with local-state fallback.
            if (msg.includes("Unknown template") ||
                msg.includes("TEMPLATES_OR_INTERFACES_NOT_FOUND") ||
                msg.includes("entity") ||
                msg.includes("template")) {
                if (!this.warnedRedemptionMarkerUnavailable) {
                    console.warn("[Relay] RedemptionEthereumSettlement template unavailable; using local-state idempotency fallback");
                    this.warnedRedemptionMarkerUnavailable = true;
                }
                this.redemptionSettlementMarkerSupported = false;
                return;
            }
            console.warn(`[Relay] Failed to load redemption settlement markers: ${msg}`);
        }
    }
    /**
     * Persist Ethereum payout as an on-ledger marker for durable idempotency.
     * Returns true when marker is written, false when unavailable/failing.
     */
    async writeRedemptionSettlementMarker(redemption, recipientEth, amountWei, ethTxHash) {
        if (this.redemptionSettlementMarkerSupported === false)
            return false;
        const payload = {
            operator: this.config.cantonParty,
            user: redemption.payload.user,
            redemptionCid: redemption.contractId,
            recipientEth,
            amountPaid: ethers_1.ethers.formatUnits(amountWei, 18),
            ethTxHash,
            settledAt: new Date().toISOString(),
        };
        try {
            await this.canton.createContract(canton_client_1.TEMPLATES.RedemptionEthereumSettlement, payload);
            this.redemptionSettlementMarkerSupported = true;
            return true;
        }
        catch (error) {
            const msg = String(error?.message || error);
            if (msg.includes("Unknown template") ||
                msg.includes("TEMPLATES_OR_INTERFACES_NOT_FOUND") ||
                msg.includes("entity") ||
                msg.includes("template")) {
                if (!this.warnedRedemptionMarkerUnavailable) {
                    console.warn("[Relay] RedemptionEthereumSettlement template unavailable; using local-state idempotency fallback");
                    this.warnedRedemptionMarkerUnavailable = true;
                }
                this.redemptionSettlementMarkerSupported = false;
                return false;
            }
            console.warn(`[Relay] Failed to write settlement marker for redemption ${redemption.contractId.slice(0, 16)}...: ${msg}`);
            return false;
        }
    }
    /**
     * Resolve Ethereum recipient for a Canton user party.
     * Supports exact party ID and party-hint mappings.
     */
    resolveRedemptionRecipientEthAddress(userParty) {
        const canonicalParty = (0, recipient_routing_1.resolveRecipientParty)(userParty, this.config.recipientPartyAliases);
        const candidates = Array.from(new Set([
            userParty,
            canonicalParty,
            userParty.split("::")[0],
            canonicalParty.split("::")[0],
        ]));
        for (const candidate of candidates) {
            const mapped = (0, recipient_routing_1.resolveRecipientEthAddress)(candidate, this.config.redemptionRecipientAddresses);
            if (mapped)
                return mapped;
            const validatorMapped = this.config.validatorAddresses[candidate];
            if (validatorMapped && ethers_1.ethers.isAddress(validatorMapped)) {
                return ethers_1.ethers.getAddress(validatorMapped);
            }
        }
        return null;
    }
    /**
     * Ensure relay wallet can mint mUSD for redemption payouts.
     * If configured and possible, self-grants BRIDGE_ROLE.
     */
    async ensureBridgeRoleForRedemptionPayouts() {
        const BRIDGE_ROLE = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes("BRIDGE_ROLE"));
        const DEFAULT_ADMIN_ROLE = ethers_1.ethers.ZeroHash;
        const walletAddress = await this.wallet.getAddress();
        let hasBridgeRole = false;
        try {
            hasBridgeRole = await this.musdTokenContract.hasRole(BRIDGE_ROLE, walletAddress);
        }
        catch (error) {
            console.error(`[Relay] Cannot verify BRIDGE_ROLE on mUSD token: ${error?.message || error}`);
            return false;
        }
        if (hasBridgeRole)
            return true;
        let hasAdminRole = false;
        try {
            hasAdminRole = await this.musdTokenContract.hasRole(DEFAULT_ADMIN_ROLE, walletAddress);
        }
        catch (error) {
            console.error(`[Relay] Cannot verify DEFAULT_ADMIN_ROLE on mUSD token: ${error?.message || error}`);
            return false;
        }
        if (!hasAdminRole) {
            console.error(`[Relay] Relayer ${walletAddress} is missing BRIDGE_ROLE on mUSD ${this.config.musdTokenAddress}. ` +
                `Grant BRIDGE_ROLE or provide an authorized payout signer.`);
            return false;
        }
        if (!this.config.autoGrantBridgeRoleForRedemptions) {
            console.error(`[Relay] Relayer ${walletAddress} has DEFAULT_ADMIN_ROLE but auto-grant is disabled. ` +
                `Set AUTO_GRANT_BRIDGE_ROLE_FOR_REDEMPTIONS=true or grant BRIDGE_ROLE manually.`);
            return false;
        }
        try {
            console.warn(`[Relay] Relayer ${walletAddress} missing BRIDGE_ROLE on ${this.config.musdTokenAddress}; granting role automatically.`);
            const grantTx = await this.musdTokenContract.grantRole(BRIDGE_ROLE, walletAddress);
            await grantTx.wait(this.config.confirmations);
            return true;
        }
        catch (error) {
            console.error(`[Relay] Failed to auto-grant BRIDGE_ROLE on mUSD token: ${error?.shortMessage || error?.message || error}`);
            return false;
        }
    }
    /**
     * Settle pending RedemptionRequests by minting mUSD on Ethereum.
     * Requests remain pending on Canton; idempotency is enforced by local persistence.
     */
    async processPendingRedemptions() {
        const pendingRedemptions = await this.canton.queryContracts(canton_client_1.TEMPLATES.RedemptionRequest, (p) => p.operator === this.config.cantonParty && !p.fulfilled);
        const actionableRedemptions = pendingRedemptions.filter((r) => !this.processedRedemptionRequests.has(r.contractId));
        await this.logPendingRedemptionBacklog(pendingRedemptions, actionableRedemptions.length);
        if (actionableRedemptions.length === 0)
            return;
        const canMintPayouts = await this.ensureBridgeRoleForRedemptionPayouts();
        if (!canMintPayouts)
            return;
        const orderedRedemptions = [...actionableRedemptions].sort((a, b) => new Date(a.payload.createdAt).getTime() - new Date(b.payload.createdAt).getTime());
        let settledThisCycle = 0;
        let skippedMissingRecipient = 0;
        let skippedOverLimit = 0;
        for (const redemption of orderedRedemptions) {
            let owedAmount;
            try {
                owedAmount = this.parseDamlNumeric18(redemption.payload.usdcOwed, "RedemptionRequest.usdcOwed");
            }
            catch (error) {
                console.error(`[Relay] Skipping RedemptionRequest ${redemption.contractId.slice(0, 16)}...: ${error.message}`);
                continue;
            }
            if (owedAmount <= 0n) {
                console.warn(`[Relay] Skipping RedemptionRequest ${redemption.contractId.slice(0, 16)}...: non-positive payout ${redemption.payload.usdcOwed}`);
                continue;
            }
            if (owedAmount > this.config.maxRedemptionEthPayoutWei) {
                skippedOverLimit++;
                continue;
            }
            const recipientEth = this.resolveRedemptionRecipientEthAddress(redemption.payload.user);
            if (!recipientEth) {
                skippedMissingRecipient++;
                console.warn(`[Relay] No ETH recipient mapping for redemption user ${redemption.payload.user}. ` +
                    `Add mapping to CANTON_REDEMPTION_ETH_RECIPIENTS.`);
                continue;
            }
            try {
                const mintTx = await this.musdTokenContract.mint(recipientEth, owedAmount);
                await mintTx.wait(this.config.confirmations);
                await this.writeRedemptionSettlementMarker(redemption, recipientEth, owedAmount, mintTx.hash);
                this.processedRedemptionRequests.add(redemption.contractId);
                this.persistState();
                settledThisCycle++;
                console.log(`[Relay] ✅ Settled RedemptionRequest ${redemption.contractId.slice(0, 16)}... ` +
                    `→ minted ${ethers_1.ethers.formatUnits(owedAmount, 18)} mUSD to ${recipientEth} ` +
                    `(tx: ${mintTx.hash})`);
            }
            catch (error) {
                console.error(`[Relay] Failed Ethereum payout for RedemptionRequest ${redemption.contractId.slice(0, 16)}...: ` +
                    `${error?.shortMessage || error?.message || error}`);
            }
        }
        if (settledThisCycle > 0) {
            console.log(`[Relay] Redemption settlement: ${settledThisCycle} request(s) paid on Ethereum this cycle`);
        }
        const now = Date.now();
        if ((skippedMissingRecipient > 0 || skippedOverLimit > 0) &&
            now - this.lastRedemptionFulfillmentWarningAt >= RelayService.DIAGNOSTIC_LOG_INTERVAL_MS) {
            if (skippedMissingRecipient > 0) {
                console.warn(`[Relay] Redemption settlement waiting on recipient mapping: ${skippedMissingRecipient} request(s).`);
            }
            if (skippedOverLimit > 0) {
                console.warn(`[Relay] Redemption settlement over per-request limit (${ethers_1.ethers.formatUnits(this.config.maxRedemptionEthPayoutWei, 18)} mUSD): ` +
                    `${skippedOverLimit} request(s).`);
            }
            this.lastRedemptionFulfillmentWarningAt = now;
        }
    }
    // ============================================================
    //  DIRECTION 3: Canton → Ethereum (Auto Bridge-Out Processing)
    // ============================================================
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
    async processCantonBridgeOuts() {
        // Query Canton for pending BridgeOutRequests (standalone module)
        const pendingRequests = await this.canton.queryContracts(canton_client_1.TEMPLATES.StandaloneBridgeOutRequest, (p) => p.status === "pending" && p.operator === this.config.cantonParty);
        if (pendingRequests.length === 0)
            return;
        console.log(`[Relay] Found ${pendingRequests.length} pending BridgeOutRequests on Canton`);
        // Treasury ABI — includes both general deposit and targeted depositToStrategy.
        // `asset()` is used by TreasuryV2; `usdc()` retained for backward compatibility.
        const treasuryAbi = [
            "function deposit(address from, uint256 amount) external",
            "function depositToStrategy(address strategy, uint256 amount) external returns (uint256)",
            "function asset() external view returns (address)",
            "function usdc() external view returns (address)",
            "function hasRole(bytes32 role, address account) external view returns (bool)",
        ];
        const treasury = new ethers_1.ethers.Contract(this.config.treasuryAddress, treasuryAbi, this.wallet);
        const erc20Abi = [
            "function approve(address spender, uint256 amount) external returns (bool)",
            "function balanceOf(address account) external view returns (uint256)",
        ];
        const walletAddress = await this.wallet.getAddress();
        const VAULT_ROLE = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes("VAULT_ROLE"));
        try {
            const hasVaultRole = await treasury.hasRole(VAULT_ROLE, walletAddress);
            if (!hasVaultRole) {
                const now = Date.now();
                if (now - this.lastVaultRoleWarningAt >= RelayService.DIAGNOSTIC_LOG_INTERVAL_MS) {
                    console.error(`[Relay] Relayer ${walletAddress} is missing VAULT_ROLE on Treasury ${this.config.treasuryAddress}. ` +
                        `Bridge-out deposits will be skipped until role is granted.`);
                    this.lastVaultRoleWarningAt = now;
                }
                return;
            }
        }
        catch {
            // Older treasury variants may not expose AccessControl introspection.
        }
        const usdcAddress = await this.resolveTreasuryAssetAddress(treasury);
        if (!usdcAddress) {
            return;
        }
        if (!ethers_1.ethers.isAddress(usdcAddress) || usdcAddress === ethers_1.ethers.ZeroAddress) {
            console.error(`[Relay] Invalid USDC address returned by Treasury: ${String(usdcAddress)}`);
            return;
        }
        let usdc;
        try {
            usdc = new ethers_1.ethers.Contract(usdcAddress, erc20Abi, this.wallet);
        }
        catch (err) {
            console.error(`[Relay] Failed to initialize USDC contract at ${usdcAddress}:`, err.message);
            return;
        }
        for (const req of pendingRequests) {
            const { payload, contractId } = req;
            try {
                // Convert DAML Numeric 18 to USDC 6-decimal amount
                const amountWei = ethers_1.ethers.parseEther(payload.amount);
                const amountUsdc = amountWei / BigInt(1e12);
                // Check relayer wallet has sufficient USDC
                // (arrives from xReserve/Circle CCTP redemption — handled off-chain by operator)
                const balance = await usdc.balanceOf(walletAddress);
                if (balance < amountUsdc) {
                    console.log(`[Relay] BridgeOut #${payload.nonce}: insufficient USDC ` +
                        `(need ${amountUsdc}, have ${balance}) — waiting for xReserve redemption`);
                    continue; // Skip — will retry next cycle when USDC arrives
                }
                const isEthPool = payload.source === "ethpool";
                const routeLabel = isEthPool ? "MetaVault #3 (Fluid)" : "Treasury (auto-allocate)";
                console.log(`[Relay] Processing BridgeOut #${payload.nonce} [${payload.source}]: ${ethers_1.ethers.formatUnits(amountUsdc, 6)} USDC → ${routeLabel}`);
                // Step 1: Approve Treasury to spend USDC
                const approveTx = await usdc.approve(this.config.treasuryAddress, amountUsdc);
                await approveTx.wait();
                // Step 2: Route deposit based on source
                if (isEthPool && this.config.metaVault3Address) {
                    // ETH Pool → deposit directly to MetaVault #3 (Fluid T2/T4 strategy)
                    const depositTx = await treasury.depositToStrategy(this.config.metaVault3Address, amountUsdc);
                    await depositTx.wait();
                    console.log(`[Relay] ✅ Deposited ${ethers_1.ethers.formatUnits(amountUsdc, 6)} USDC → MetaVault #3 (tx: ${depositTx.hash})`);
                }
                else {
                    // DirectMint → general deposit with auto-allocation
                    const depositTx = await treasury.deposit(walletAddress, amountUsdc);
                    await depositTx.wait();
                    console.log(`[Relay] ✅ Deposited ${ethers_1.ethers.formatUnits(amountUsdc, 6)} USDC to Treasury (tx: ${depositTx.hash})`);
                }
                // Step 3: Mark BridgeOutRequest as completed on Canton
                await this.canton.exerciseChoice(canton_client_1.TEMPLATES.StandaloneBridgeOutRequest, contractId, "BridgeOut_Complete", { relayParty: this.config.cantonParty });
                console.log(`[Relay] ✅ BridgeOutRequest #${payload.nonce} marked as bridged on Canton`);
            }
            catch (error) {
                const details = `${error?.shortMessage || error?.message || error}`;
                if (details.includes("0xe2517d3f") || details.includes("AccessControlUnauthorizedAccount")) {
                    console.error(`[Relay] BridgeOut #${payload.nonce} failed: Treasury rejected caller authorization. ` +
                        `Relayer must have VAULT_ROLE on ${this.config.treasuryAddress}.`);
                    this.lastVaultRoleWarningAt = Date.now();
                }
                else {
                    console.error(`[Relay] Failed to process BridgeOut #${payload.nonce}:`, details);
                }
                // Don't mark as failed — will retry next cycle
            }
        }
    }
    /**
     * Fetch ValidatorSignature contracts for an attestation
     */
    async fetchValidatorSignatures(requestId) {
        // Query all ValidatorSignature contracts and filter by requestId client-side
        const signatures = await this.canton.queryContracts(canton_client_1.TEMPLATES.ValidatorSignature, (payload) => payload.requestId === requestId);
        return signatures.map(s => s.payload);
    }
    /**
     * Submit attestation to Ethereum
     */
    async bridgeAttestation(payload, validatorSigs, cantonContract // BRIDGE-H-03: Need contract ID for Attestation_Complete
    ) {
        const attestationId = payload.attestationId;
        const nonceNum = Number(payload.nonce);
        let markedNonce = false;
        let txSubmitted = false;
        const observeDuration = metrics_1.attestationDuration.startTimer();
        try {
            // Validate chain ID matches connected network to prevent cross-chain replay
            const network = await this.provider.getNetwork();
            const expectedChainId = network.chainId;
            const payloadChainId = BigInt(payload.chainId);
            if (payloadChainId !== expectedChainId) {
                console.error(`[Relay] CRITICAL: Chain ID mismatch! Payload: ${payloadChainId}, Network: ${expectedChainId}`);
                console.error(`[Relay] Rejecting attestation ${attestationId} - possible cross-chain replay attack`);
                metrics_1.bridgeValidationFailuresTotal.labels("chain_id_mismatch").inc();
                metrics_1.attestationsProcessedTotal.labels("error").inc();
                throw new Error(`CHAIN_ID_MISMATCH: expected ${expectedChainId}, got ${payloadChainId}`);
            }
            // Compute entropy and derive attestation ID first (needed for on-chain checks)
            const entropy = payload.entropy
                ? (payload.entropy.startsWith("0x") ? payload.entropy : "0x" + payload.entropy)
                : ethers_1.ethers.hexlify(new Uint8Array(crypto.randomBytes(32)));
            // Read cantonStateHash from payload
            const cantonStateHash = payload.cantonStateHash
                ? (payload.cantonStateHash.startsWith("0x") ? payload.cantonStateHash : "0x" + payload.cantonStateHash)
                : ethers_1.ethers.ZeroHash;
            const cantonAssets = ethers_1.ethers.parseUnits(payload.globalCantonAssets, 18);
            const nonce = BigInt(payload.nonce);
            const expiresAtMs = new Date(payload.expiresAt).getTime();
            if (isNaN(expiresAtMs) || expiresAtMs <= 0) {
                throw new Error(`Invalid expiresAt timestamp: ${payload.expiresAt}`);
            }
            // BRIDGE-M-05: Use named constant instead of magic number for expiry-to-timestamp derivation
            const timestampSec = Math.floor(expiresAtMs / 1000) - RelayService.ATTESTATION_TTL_SECONDS;
            if (timestampSec <= 0) {
                throw new Error(`Computed timestamp is non-positive (${timestampSec}). expiresAt too early: ${payload.expiresAt}`);
            }
            // BRIDGE-M-05: Validate derived timestamp is within reasonable range (not more than 24h past or future)
            const nowSec = Math.floor(Date.now() / 1000);
            if (Math.abs(timestampSec - nowSec) > RelayService.MAX_TIMESTAMP_DRIFT_SECONDS) {
                throw new Error(`BRIDGE-M-05: Derived timestamp ${timestampSec} is more than ${RelayService.MAX_TIMESTAMP_DRIFT_SECONDS}s ` +
                    `from current time ${nowSec}. expiresAt=${payload.expiresAt}. Possible clock skew or stale attestation.`);
            }
            const chainId = expectedChainId;
            // ID derivation matches BLEBridgeV9.computeAttestationId()
            // On-chain: keccak256(abi.encodePacked(nonce, cantonAssets, timestamp, entropy, cantonStateHash, chainid, address))
            // cantonStateHash already extracted from payload at line 572
            const idBytes32 = ethers_1.ethers.solidityPackedKeccak256(["uint256", "uint256", "uint256", "bytes32", "bytes32", "uint256", "address"], [nonce, cantonAssets, BigInt(timestampSec), entropy, cantonStateHash, chainId, this.config.bridgeContractAddress]);
            // Check if already used on-chain
            const isUsed = await this.bridgeContract.usedAttestationIds(idBytes32);
            if (isUsed) {
                console.log(`[Relay] Attestation ${attestationId} already processed on-chain`);
                this.processedAttestations.add(attestationId);
                return;
            }
            // Format signatures for Ethereum
            const messageHash = this.buildMessageHash(payload, idBytes32, cantonStateHash);
            const formattedSigs = await this.formatSignatures(validatorSigs, messageHash);
            // Sort signatures by signer address (required by BLEBridgeV9)
            const sortedSigs = (0, signer_1.sortSignaturesBySignerAddress)(formattedSigs, messageHash);
            // Build attestation struct (entropy and ID already computed above)
            // Include cantonStateHash to bind attestation to Canton ledger state
            const attestation = {
                id: idBytes32,
                cantonAssets: cantonAssets,
                nonce: nonce,
                timestamp: BigInt(timestampSec),
                entropy: entropy,
                cantonStateHash: cantonStateHash,
            };
            // Simulate transaction before submission to prevent race condition gas drain
            // If another relay or MEV bot front-runs us, simulation will fail and we skip
            try {
                await this.bridgeContract.processAttestation.staticCall(attestation, sortedSigs);
            }
            catch (simulationError) {
                console.log(`[Relay] Pre-flight simulation failed for ${attestationId}: ${simulationError.reason || simulationError.message}`);
                // Check if it's because attestation was already processed
                const recheckUsed = await this.bridgeContract.usedAttestationIds(idBytes32);
                if (recheckUsed) {
                    console.log(`[Relay] Attestation ${attestationId} was processed by another relay`);
                    this.processedAttestations.add(attestationId);
                }
                return;
            }
            // Estimate gas (after successful simulation)
            const gasEstimate = await this.bridgeContract.processAttestation.estimateGas(attestation, sortedSigs);
            // Submit transaction
            // BRIDGE-M-04: RESOLVED — processAttestation() now requires RELAYER_ROLE
            // (onlyRole(RELAYER_ROLE) modifier added in BLEBridgeV9 upgrade).
            // The relay EOA must be granted RELAYER_ROLE on the deployed proxy after upgrade.
            // Defense-in-depth layers remain:
            //   1. The relay pre-verifies all ECDSA signatures via ecrecover before submitting
            //   2. BLEBridgeV9 verifies signatures on-chain against VALIDATOR_ROLE holders
            //   3. Attestation IDs are derived from nonce+entropy and checked for uniqueness
            //   4. Pre-flight simulation catches front-running/replay attempts
            //   5. RELAYER_ROLE access control prevents griefing by unauthorized callers
            console.log(`[Relay] Submitting attestation ${attestationId} with ${sortedSigs.length} signatures...`);
            // H-3: Mark nonce as submitted before tx (in-flight dedup)
            this.markNonceSubmitted(nonceNum, attestationId);
            markedNonce = true;
            const tx = await this.bridgeContract.processAttestation(attestation, sortedSigs, {
                gasLimit: gasEstimate * 120n / 100n, // 20% buffer
            });
            txSubmitted = true;
            console.log(`[Relay] Transaction submitted: ${tx.hash}`);
            // Wait for confirmations
            const receipt = await tx.wait(this.config.confirmations);
            if (receipt.status === 1) {
                console.log(`[Relay] Attestation ${attestationId} bridged successfully`);
                if (markedNonce) {
                    this.clearInFlightAttestation(attestationId);
                    markedNonce = false;
                }
                metrics_1.attestationsProcessedTotal.labels("success").inc();
                this.processedAttestations.add(attestationId);
                // H-1: Record successful submission for rate limiting
                this.recordTxSubmission();
                // H-2: Reset consecutive revert counter and update cap baseline
                this.recordSuccess();
                try {
                    const newCap = await this.bridgeContract.getCurrentSupplyCap();
                    this.anomalyDetector.lastKnownSupplyCap = BigInt(newCap);
                }
                catch { /* non-blocking */ }
                // BRIDGE-H-03: Exercise Attestation_Complete on DAML to archive
                // the attestation request. Without this, stale attestation contracts remain on
                // the Canton ledger, causing the relay to re-process them on every poll cycle
                // (retry storms) and leaving DAML state inconsistent with Ethereum.
                try {
                    await this.canton.exerciseChoice(canton_client_1.TEMPLATES.AttestationRequest, cantonContract.contractId, "Attestation_Complete", {});
                    console.log(`[Relay] Attestation ${attestationId} marked complete on Canton`);
                }
                catch (completeError) {
                    // Non-fatal: attestation is already bridged on Ethereum.
                    // The DAML contract will be cleaned up on next attempt or manually.
                    console.warn(`[Relay] Failed to complete attestation on Canton (non-fatal): ${completeError.message}`);
                }
                // Trigger auto-deploy to yield strategies if configured
                if (this.config.triggerAutoDeploy && this.config.treasuryAddress) {
                    await this.triggerYieldDeploy();
                }
                // MEDIUM-02: Persist state to disk after successful attestation processing
                this.persistState();
                // Evict oldest 10% of entries if cache exceeds limit
                if (this.processedAttestations.size > this.MAX_PROCESSED_CACHE) {
                    const toEvict = Math.floor(this.MAX_PROCESSED_CACHE * 0.1);
                    let evicted = 0;
                    for (const key of this.processedAttestations) {
                        if (evicted >= toEvict)
                            break;
                        this.processedAttestations.delete(key);
                        evicted++;
                    }
                }
            }
            else {
                console.error(`[Relay] Transaction reverted: ${tx.hash}`);
                if (markedNonce) {
                    this.unmarkNonceSubmitted(nonceNum, attestationId);
                    markedNonce = false;
                }
                metrics_1.txRevertsTotal.labels("processAttestation").inc();
                metrics_1.attestationsProcessedTotal.labels("revert").inc();
                // H-2: Track consecutive reverts for pause guardian
                await this.recordRevert();
            }
        }
        catch (error) {
            if (markedNonce) {
                // If tx was submitted but confirmation failed with an unknown transport
                // issue, keep dedup markers to avoid accidental double-submit.
                // For explicit revert/failure signals (or pre-submit failures), allow retry.
                const msg = String(error?.message || "").toLowerCase();
                const explicitFailure = !txSubmitted ||
                    msg.includes("revert") ||
                    msg.includes("failed") ||
                    msg.includes("execution reverted");
                if (explicitFailure) {
                    this.unmarkNonceSubmitted(nonceNum, attestationId);
                    markedNonce = false;
                }
                else {
                    console.warn(`[Relay] Keeping nonce/in-flight markers for ${attestationId} due to ambiguous post-submit error`);
                }
            }
            // M-3: Redact sensitive data from error logs
            console.error(`[Relay] Failed to bridge attestation ${attestationId}:`, RelayService.redact(error.message));
            metrics_1.attestationsProcessedTotal.labels("error").inc();
            if (typeof error?.message === "string" && error.message.toLowerCase().includes("revert")) {
                metrics_1.txRevertsTotal.labels("processAttestation").inc();
            }
            // Check if it's a revert with reason
            if (error.reason) {
                console.error(`[Relay] Revert reason: ${error.reason}`);
            }
            // H-2: Track consecutive reverts for pause guardian
            await this.recordRevert();
            // Don't mark as processed so we can retry
            throw error;
        }
        finally {
            observeDuration();
            this.updateMetricsSnapshot();
        }
    }
    /**
     * Build the message hash that validators signed
     * Includes entropy in hash to match BLEBridgeV9 verification
     * Includes cantonStateHash to match on-chain signature verification
     */
    buildMessageHash(payload, idBytes32, cantonStateHash) {
        // Use BigInt for chainId to avoid IEEE 754 precision loss on large chain IDs
        const chainId = BigInt(payload.chainId);
        // Read entropy from payload for inclusion in hash
        const entropy = payload.entropy
            ? (payload.entropy.startsWith("0x") ? payload.entropy : "0x" + payload.entropy)
            : ethers_1.ethers.ZeroHash;
        // cantonStateHash already received as parameter (formatted by caller)
        const stateHash = cantonStateHash || ethers_1.ethers.ZeroHash;
        // Matches on-chain: keccak256(abi.encodePacked(id, cantonAssets, nonce, timestamp, entropy, cantonStateHash, chainid, address))
        return ethers_1.ethers.solidityPackedKeccak256(["bytes32", "uint256", "uint256", "uint256", "bytes32", "bytes32", "uint256", "address"], [
            idBytes32,
            ethers_1.ethers.parseUnits(payload.globalCantonAssets, 18),
            BigInt(payload.nonce),
            // BRIDGE-M-05: Use named constant consistent with bridgeAttestation derivation
            BigInt(Math.max(1, Math.floor(new Date(payload.expiresAt).getTime() / 1000) - RelayService.ATTESTATION_TTL_SECONDS)),
            entropy,
            stateHash,
            chainId,
            this.config.bridgeContractAddress,
        ]);
    }
    /**
     * Format validator signatures for Ethereum
     * Pre-verify signatures using ecrecover before submitting to chain
     */
    async formatSignatures(validatorSigs, messageHash) {
        const formatted = [];
        // EIP-191 prefixed hash for ecrecover validation.
        // Validators sign via eth_sign / KMS signMessage, which applies the
        // "\x19Ethereum Signed Message:\n32" prefix before ECDSA signing.
        // We must use the SAME prefixed hash for recovery.
        // IMPORTANT: Use recoverAddress (not verifyMessage) downstream to avoid
        // double-prefixing — recoverAddress takes the already-prefixed digest.
        const ethSignedHash = ethers_1.ethers.hashMessage(ethers_1.ethers.getBytes(messageHash));
        for (const sig of validatorSigs) {
            try {
                let rsvSignature;
                // Look up the Ethereum address for this DAML Party
                // sig.validator is a DAML Party string like "validator1::122abc"
                // We need the corresponding Ethereum address like "0x71C7..."
                const validatorEthAddress = this.config.validatorAddresses[sig.validator];
                if (!validatorEthAddress) {
                    console.error(`[Relay] No Ethereum address mapped for validator party: ${sig.validator}`);
                    console.error(`[Relay] Add to VALIDATOR_ADDRESSES config: {"${sig.validator}": "0x..."}`);
                    metrics_1.bridgeValidationFailuresTotal.labels("validator_mapping_missing").inc();
                    continue; // Skip - no address mapping
                }
                // Validate RSV format more strictly (check hex content + v value)
                if (sig.ecdsaSignature.startsWith("0x") && sig.ecdsaSignature.length === 132) {
                    // Verify it's valid hex and has a valid v value (1b or 1c = 27 or 28)
                    const vByte = sig.ecdsaSignature.slice(130, 132).toLowerCase();
                    if (/^[0-9a-f]+$/.test(sig.ecdsaSignature.slice(2)) &&
                        (vByte === "1b" || vByte === "1c")) {
                        rsvSignature = sig.ecdsaSignature;
                    }
                    else {
                        console.warn(`[Relay] Invalid RSV signature from ${sig.validator}: bad v value`);
                        metrics_1.bridgeValidationFailuresTotal.labels("invalid_signature_v").inc();
                        continue;
                    }
                }
                // If signature is DER encoded (from AWS KMS)
                else {
                    const derBuffer = Buffer.from(sig.ecdsaSignature.replace("0x", ""), "hex");
                    rsvSignature = (0, signer_1.formatKMSSignature)(derBuffer, messageHash, validatorEthAddress // Use mapped Ethereum address, not DAML Party
                    );
                }
                // Pre-verify signature using ecrecover before including
                // This catches invalid signatures before wasting gas on-chain
                try {
                    const recoveredAddress = ethers_1.ethers.recoverAddress(ethSignedHash, rsvSignature);
                    // Compare to mapped Ethereum address, not DAML Party
                    const expectedAddress = validatorEthAddress.toLowerCase();
                    if (recoveredAddress.toLowerCase() !== expectedAddress) {
                        console.error(`[Relay] CRITICAL: Signature from ${sig.validator} (${validatorEthAddress}) recovers to ${recoveredAddress}`);
                        console.error(`[Relay] Rejecting invalid signature - possible attack or key mismatch`);
                        metrics_1.bridgeValidationFailuresTotal.labels("signature_mismatch").inc();
                        continue; // Skip this signature
                    }
                    // Signature verified - add to formatted list
                    formatted.push(rsvSignature);
                    console.log(`[Relay] Verified signature from ${sig.validator} (${validatorEthAddress})`);
                }
                catch (recoverError) {
                    console.error(`[Relay] Failed to recover address from signature by ${sig.validator}:`, recoverError);
                    metrics_1.bridgeValidationFailuresTotal.labels("signature_recover_error").inc();
                    continue; // Skip malformed signatures
                }
            }
            catch (error) {
                console.warn(`[Relay] Failed to format signature from ${sig.validator}:`, error);
                metrics_1.bridgeValidationFailuresTotal.labels("signature_format_error").inc();
            }
        }
        return formatted;
    }
    /**
     * Sleep helper
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    /**
     * Trigger Treasury auto-deploy to yield strategies after bridge-in
     */
    async triggerYieldDeploy() {
        if (!this.config.treasuryAddress)
            return;
        try {
            const TREASURY_ABI = [
                {
                    "inputs": [],
                    "name": "shouldAutoDeploy",
                    "outputs": [
                        { "internalType": "bool", "name": "", "type": "bool" },
                        { "internalType": "uint256", "name": "", "type": "uint256" }
                    ],
                    "stateMutability": "view",
                    "type": "function"
                },
                {
                    "inputs": [],
                    "name": "keeperTriggerAutoDeploy",
                    "outputs": [
                        { "internalType": "uint256", "name": "deployed", "type": "uint256" }
                    ],
                    "stateMutability": "nonpayable",
                    "type": "function"
                }
            ];
            const treasury = new ethers_1.ethers.Contract(this.config.treasuryAddress, TREASURY_ABI, this.wallet);
            // Check if auto-deploy would trigger
            const [shouldDeploy, deployable] = await treasury.shouldAutoDeploy();
            if (!shouldDeploy) {
                // TS-M-04: Use ethers.formatUnits for safe BigInt → decimal formatting
                console.log(`[Relay] Auto-deploy: No deployment needed (deployable: ${ethers_1.ethers.formatUnits(deployable, 6)} USDC)`);
                return;
            }
            console.log(`[Relay] Auto-deploy: Triggering deployment of ${ethers_1.ethers.formatUnits(deployable, 6)} USDC to yield strategy...`);
            const tx = await treasury.keeperTriggerAutoDeploy();
            const receipt = await tx.wait(1);
            if (receipt.status === 1) {
                console.log(`[Relay] Auto-deploy: Successfully deployed ${ethers_1.ethers.formatUnits(deployable, 6)} USDC to yield strategy`);
            }
            else {
                console.warn(`[Relay] Auto-deploy: Transaction reverted`);
            }
        }
        catch (error) {
            // Don't throw - auto-deploy failure shouldn't affect bridge success
            console.warn(`[Relay] Auto-deploy failed (non-critical):`, error.message);
        }
    }
}
exports.RelayService = RelayService;
// ============================================================
//                     HEALTH CHECK SERVER
// ============================================================
const http = __importStar(require("http"));
// Health server with optional bearer token authentication
function startHealthServer(port, relay) {
    const healthToken = process.env.HEALTH_AUTH_TOKEN || "";
    const server = http.createServer(async (req, res) => {
        // Require auth token for metrics endpoint (operational state)
        if (healthToken && req.url === "/metrics") {
            const authHeader = req.headers.authorization;
            if (!authHeader || authHeader !== `Bearer ${healthToken}`) {
                res.writeHead(401, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Unauthorized" }));
                return;
            }
        }
        if (req.url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                status: "ok",
                timestamp: new Date().toISOString(),
            }));
        }
        else if (req.url === "/metrics") {
            relay.updateMetricsSnapshot();
            await (0, metrics_1.metricsHandler)(req, res);
        }
        else {
            res.writeHead(404);
            res.end();
        }
    });
    // Bind to localhost by default instead of 0.0.0.0
    const bindHost = process.env.HEALTH_BIND_HOST || "127.0.0.1";
    server.listen(port, bindHost, () => {
        console.log(`[Health] Server listening on ${bindHost}:${port}`);
    });
    return server;
}
// ============================================================
//                     MAIN
// ============================================================
async function main() {
    console.log("==============================================");
    console.log("  Minted Protocol - Bidirectional Bridge Relay");
    console.log("  Canton ↔ Ethereum                          ");
    console.log("==============================================");
    console.log("");
    // Validate config
    if (!DEFAULT_CONFIG.bridgeContractAddress) {
        throw new Error("BRIDGE_CONTRACT_ADDRESS not set");
    }
    // Validate Ethereum address format
    if (!ethers_1.ethers.isAddress(DEFAULT_CONFIG.bridgeContractAddress)) {
        throw new Error("BRIDGE_CONTRACT_ADDRESS is not a valid Ethereum address");
    }
    if (!DEFAULT_CONFIG.relayerPrivateKey && !DEFAULT_CONFIG.relayerKmsKeyId) {
        throw new Error("Either RELAYER_PRIVATE_KEY or RELAYER_KMS_KEY_ID must be set");
    }
    // Prefer KMS in production
    if (DEFAULT_CONFIG.relayerKmsKeyId) {
        console.log("[Main] Using AWS KMS for Ethereum signing (H-07: key never in memory)");
    }
    else {
        // Validate private key format before wallet creation
        if (!/^(0x)?[0-9a-fA-F]{64}$/.test(DEFAULT_CONFIG.relayerPrivateKey)) {
            throw new Error("RELAYER_PRIVATE_KEY has invalid format (expected 64 hex chars)");
        }
    }
    if (!DEFAULT_CONFIG.cantonParty) {
        throw new Error("CANTON_PARTY not set");
    }
    if (!DEFAULT_CONFIG.cantonToken) {
        throw new Error("CANTON_TOKEN not set");
    }
    // Create relay service
    const relay = new RelayService(DEFAULT_CONFIG);
    // Start health server
    // Added explicit radix 10 to parseInt
    const healthPort = parseInt(process.env.HEALTH_PORT || "8080", 10);
    const healthServer = startHealthServer(healthPort, relay);
    // Handle shutdown — M-4: Graceful shutdown with drain
    const shutdown = async () => {
        console.log("\n[Main] Graceful shutdown initiated...");
        relay.stop();
        // M-4: Wait for in-flight operations to complete (max 30s)
        const drainTimeout = parseInt(process.env.SHUTDOWN_DRAIN_TIMEOUT_MS || "30000", 10);
        const drainStart = Date.now();
        const checkInterval = 500;
        while (Date.now() - drainStart < drainTimeout) {
            // Check if relay has drained (no in-flight attestations)
            const inFlight = relay.inFlightAttestations?.size || 0;
            if (inFlight === 0) {
                console.log("[Main] All in-flight operations drained.");
                break;
            }
            console.log(`[Main] Waiting for ${inFlight} in-flight operations to complete...`);
            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }
        // Close health server
        healthServer.close(() => {
            console.log("[Main] Health server closed.");
        });
        // M-1: Log final metrics on shutdown
        console.log("[Main] Final metrics:", JSON.stringify({
            processedAttestations: relay.processedAttestations.size,
            bridgeOutsRelayed: relay.processedBridgeOuts.size,
            lastScannedBlock: relay.lastScannedBlock,
            consecutiveFailures: relay.consecutiveFailures,
            rateLimiter: {
                txThisMinute: relay.rateLimiter.txThisMinute,
                txThisHour: relay.rateLimiter.txThisHour,
            },
            anomalyDetector: {
                consecutiveReverts: relay.anomalyDetector.consecutiveReverts,
                pauseTriggered: relay.anomalyDetector.pauseTriggered,
            },
        }));
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    // Start relay
    await relay.start();
}
// Handle unhandled promise rejections to prevent silent failures
process.on("unhandledRejection", (reason, promise) => {
    console.error("[Main] Unhandled rejection at:", promise, "reason:", reason);
    process.exit(1);
});
main().catch((error) => {
    console.error("[Main] Fatal error:", error);
    process.exit(1);
});
//# sourceMappingURL=relay-service.js.map