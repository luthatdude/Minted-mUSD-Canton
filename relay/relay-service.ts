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

// Load environment variables BEFORE any config initialization
import * as path from "path";
import * as dotenv from "dotenv";
const envFile = process.env.NODE_ENV === "production" ? ".env" : ".env.development";
dotenv.config({ path: path.resolve(__dirname, envFile) });

import { ethers } from "ethers";
import { CantonClient, ActiveContract, TEMPLATES } from "./canton-client";
import { formatKMSSignature, sortSignaturesBySignerAddress } from "./signer";
// Use shared readSecret utility
// Use readAndValidatePrivateKey for secp256k1 range validation
// INFRA-H-06: Import enforceTLSSecurity for explicit TLS cert validation
import { readSecret, readAndValidatePrivateKey, enforceTLSSecurity, sanitizeUrl } from "./utils";
// Import yield keeper for auto-deploy integration
import { getKeeperStatus } from "./yield-keeper";
// KMS-based Ethereum transaction signer (key never enters Node.js memory)
import { createEthereumSigner } from "./kms-ethereum-signer";
// Cryptographic entropy for attestation ID unpredictability
import * as crypto from "crypto";
// MEDIUM-02: File-based state persistence for replay protection
import * as fs from "fs";
// Item-10: Prometheus metrics instrumentation
import * as metrics from "./metrics";

// INFRA-H-06: Ensure TLS certificate validation is enforced at process level
enforceTLSSecurity();

// ============================================================
//                     CONFIGURATION
// ============================================================

interface RelayConfig {
  // Canton
  cantonHost: string;
  cantonPort: number;
  cantonToken: string;
  cantonParty: string;  // Aggregator party ID

  // Ethereum
  ethereumRpcUrl: string;
  bridgeContractAddress: string;
  treasuryAddress: string;     // Treasury for auto-deploy trigger
  metaVault3Address: string;   // MetaVault #3 (Fluid) strategy for ETH Pool deposits
  /** @deprecated SEC-GATE-01: Use relayerKmsKeyId instead. Raw keys forbidden on mainnet. */
  relayerPrivateKey: string;
  /** AWS KMS key ARN for Ethereum transaction signing (key never in memory) */
  relayerKmsKeyId: string;
  /** AWS region for KMS */
  awsRegion: string;

  // Mapping from DAML Party ID to Ethereum address
  // Without this, signature validation ALWAYS fails because we compared
  // Party strings like "validator1::122abc" to addresses like "0x71C7..."
  validatorAddresses: Record<string, string>;

  // Operational
  pollIntervalMs: number;
  maxRetries: number;
  confirmations: number;
  triggerAutoDeploy: boolean;  // Whether to trigger auto-deploy after bridge
  // Fallback RPC URLs for relay redundancy
  fallbackRpcUrls: string[];
  // YieldDistributor contract address (Direction 4: yield bridge-in to Canton)
  yieldDistributorAddress: string;
  // ETHPoolYieldDistributor contract address (Direction 4b: MetaVault #3 yield → Canton ETH Pool)
  ethPoolYieldDistributorAddress: string;
  // Canton governance party — required for ReceiveYield exercise (controller operator, governance)
  cantonGovernanceParty: string;
  // MEDIUM-02: File-based state persistence for relay crash recovery
  stateFilePath: string;
  // MEDIUM-02: Configurable lookback window for on-chain replay scan (default: 200,000 blocks)
  replayLookbackBlocks: number;
}

const DEFAULT_CONFIG: RelayConfig = {
  cantonHost: process.env.CANTON_HOST || "localhost",
  // Added explicit radix 10 to all parseInt calls
  cantonPort: parseInt(process.env.CANTON_PORT || "6865", 10),
  // Read sensitive values from Docker secrets, fallback to env vars
  cantonToken: readSecret("canton_token", "CANTON_TOKEN"),
  cantonParty: process.env.CANTON_PARTY || "",

  // INFRA-H-01 / INFRA-H-03: No insecure fallback — require explicit RPC URL in production
  // Read from Docker secret first (contains API keys), fallback to env var
  ethereumRpcUrl: (() => {
    const url = readSecret("ethereum_rpc_url", "ETHEREUM_RPC_URL");
    if (!url) throw new Error("ETHEREUM_RPC_URL is required");
    if (!url.startsWith("https://") && process.env.NODE_ENV !== "development") {
      throw new Error("ETHEREUM_RPC_URL must use HTTPS in production");
    }
    return url;
  })(),
  bridgeContractAddress: process.env.BRIDGE_CONTRACT_ADDRESS || "",
  treasuryAddress: process.env.TREASURY_ADDRESS || "",
  metaVault3Address: process.env.META_VAULT3_ADDRESS || "",  // Fluid T2/T4 strategy
  // SEC-GATE-01: Validate private key is in valid secp256k1 range
  // @deprecated — migrate to RELAYER_KMS_KEY_ID for production
  relayerPrivateKey: (() => {
    const kmsId = readSecret("relayer_kms_key_id", "RELAYER_KMS_KEY_ID");
    const rawKey = readAndValidatePrivateKey("relayer_private_key", "RELAYER_PRIVATE_KEY");
    if (rawKey && !kmsId) {
      console.warn(
        "⚠️  DEPRECATED: RELAYER_PRIVATE_KEY is deprecated. " +
        "Migrate to RELAYER_KMS_KEY_ID for HSM-backed signing. " +
        "Raw private keys will be rejected in a future release."
      );
    }
    return rawKey;
  })(),
  // KMS key for Ethereum transaction signing (key never in memory)
  relayerKmsKeyId: readSecret("relayer_kms_key_id", "RELAYER_KMS_KEY_ID"),
  awsRegion: process.env.AWS_REGION || "us-east-1",

  // Map DAML Party → Ethereum address
  // Load from JSON config file or environment
  // Format: {"validator1::122abc": "0x71C7...", "validator2::456def": "0x82D8..."}
  // Limit JSON size to 10KB to prevent memory exhaustion attacks
  validatorAddresses: (() => {
    const raw = process.env.VALIDATOR_ADDRESSES || readSecret("validator_addresses", "") || "{}";
    const MAX_JSON_SIZE = 10 * 1024; // 10KB
    if (raw.length > MAX_JSON_SIZE) {
      throw new Error(`VALIDATOR_ADDRESSES exceeds ${MAX_JSON_SIZE} byte limit - possible injection attack`);
    }
    return JSON.parse(raw);
  })(),

  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "5000", 10),
  maxRetries: parseInt(process.env.MAX_RETRIES || "3", 10),
  confirmations: parseInt(process.env.CONFIRMATIONS || "2", 10),
  triggerAutoDeploy: process.env.TRIGGER_AUTO_DEPLOY !== "false",  // Default enabled
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
    ? ethers.getAddress(process.env.ETH_POOL_YIELD_DISTRIBUTOR_ADDRESS)
    : "",
  // Canton governance party for ReceiveYield exercise (defaults to operator party)
  cantonGovernanceParty: process.env.CANTON_GOVERNANCE_PARTY || process.env.CANTON_PARTY || "",
  // MEDIUM-02: File path for persisting relay state (processed epochs, scanned blocks)
  stateFilePath: process.env.RELAY_STATE_FILE || path.resolve(__dirname, "relay-state.json"),
  // MEDIUM-02: Lookback window for on-chain replay scan (default 200,000 blocks ≈ 28 days on Ethereum)
  replayLookbackBlocks: parseInt(process.env.RELAY_LOOKBACK_BLOCKS || "200000", 10),
};

// ============================================================
//                     DAML TYPES (generated)
// ============================================================

// BRIDGE-M-07: These mirror the DAML AttestationPayload data type in Minted.Protocol.V3.
// Fields must stay aligned with:
//   - DAML: data AttestationPayload (10 fields: attestationId..cantonStateHash)
//   - Solidity: BLEBridgeV9.Attestation struct (6 fields: id, cantonAssets, nonce, timestamp, entropy, cantonStateHash)
// The Solidity struct is a derived subset — `id` is computed from (nonce, cantonAssets, timestamp, entropy, cantonStateHash, chainId, address),
// and `timestamp` is derived from `expiresAt - ATTESTATION_TTL_SECONDS`.
// Fields not in the Solidity struct (attestationId, targetAddress, amount, isMint, chainId, expiresAt) are used
// for relay-side logic and ID derivation but are not passed to the contract directly.
interface AttestationPayload {
  attestationId: string;
  globalCantonAssets: string;  // Numeric as string (DAML: Money = Numeric 18)
  targetAddress: string;
  amount: string;
  isMint: boolean;
  nonce: string;
  chainId: string;
  expiresAt: string;  // ISO timestamp (DAML: Time)
  entropy: string;    // Hex-encoded entropy from aggregator (Solidity: bytes32)
  cantonStateHash: string;  // Canton ledger state hash (Solidity: bytes32)
}

// BRIDGE-M-07: Mirrors DAML AttestationRequest template in Minted.Protocol.V3.
interface AttestationRequest {
  aggregator: string;
  validatorGroup: string[];
  payload: AttestationPayload;
  positionCids: string[];
  collectedSignatures: string[];  // Set as array (party identifiers)
  // BRIDGE-C-01: ECDSA signatures stored alongside party set on DAML ledger.
  // Each entry is [Party, hex-encoded ECDSA signature].
  ecdsaSignatures: [string, string][];
  requiredSignatures: number;     // BRIDGE-H-01: Threshold from BridgeService, matches Solidity minSignatures
  direction: string;              // "CantonToEthereum" | "EthereumToCanton"
}

interface ValidatorSignature {
  requestId: string;
  validator: string;
  aggregator: string;
  ecdsaSignature: string;
  nonce: string;
  cantonStateHash: string;  // Canton state hash from validator verification
}

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
  private config: RelayConfig;
  private canton: CantonClient;
  private provider: ethers.JsonRpcProvider;
  private wallet!: ethers.Signer;  // Abstract signer (KMS or raw)
  private bridgeContract!: ethers.Contract;
  // Bounded cache with eviction
  private processedAttestations: Set<string> = new Set();
  private readonly MAX_PROCESSED_CACHE = 10000;
  private isRunning: boolean = false;

  // ETH → Canton: Track processed bridge-out request IDs
  private processedBridgeOuts: Set<string> = new Set();
  // Last Ethereum block scanned for BridgeToCantonRequested events
  private lastScannedBlock: number = 0;

  // Direction 4: Yield bridge-in tracking
  private yieldDistributorContract: ethers.Contract | null = null;
  private processedYieldEpochs: Set<string> = new Set();
  private lastYieldScannedBlock: number = 0;

  // Direction 4b: ETH Pool yield bridge-in tracking
  private ethPoolYieldDistributorContract: ethers.Contract | null = null;
  private processedETHPoolYieldEpochs: Set<string> = new Set();
  private lastETHPoolYieldScannedBlock: number = 0;

  // BRIDGE-M-05: Named constant for the expiry-to-timestamp offset.
  // The DAML attestation carries an `expiresAt` timestamp (when the attestation becomes invalid).
  // The Solidity contract expects a `timestamp` representing when the attestation was *created*.
  // We derive the creation timestamp by subtracting this offset from the expiry time.
  // This must match the attestation TTL configured in the BridgeService / aggregator.
  private static readonly ATTESTATION_TTL_SECONDS = 3600; // 1 hour
  // BRIDGE-M-05: Maximum allowed age/future drift for derived timestamps (24 hours)
  private static readonly MAX_TIMESTAMP_DRIFT_SECONDS = 86400;

  // Fallback RPC providers for relay redundancy
  private fallbackProviders: ethers.JsonRpcProvider[] = [];
  private activeProviderIndex: number = 0;
  private consecutiveFailures: number = 0;
  private readonly MAX_CONSECUTIVE_FAILURES = 3;

  // ── H-1: Rate limiting ──────────────────────────────────────────────
  // Per-block and per-minute caps to prevent relay DoS / spam
  private rateLimiter = {
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
  private anomalyDetector = {
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
  private submittedNonces: Set<number> = new Set();
  // Track attestation IDs submitted (distinct from on-chain check — catches in-flight dupes)
  private inFlightAttestations: Set<string> = new Set();

  constructor(config: RelayConfig) {
    this.config = config;

    // Default to TLS for Canton ledger connections (opt-out instead of opt-in)
    // Reject cleartext HTTP in production
    if (process.env.CANTON_USE_TLS === "false" && process.env.NODE_ENV === "production") {
      throw new Error(
        "SECURITY: CANTON_USE_TLS=false is FORBIDDEN in production. " +
        "Canton ledger connections must use TLS. Remove CANTON_USE_TLS or set to 'true'."
      );
    }
    const protocol = process.env.CANTON_USE_TLS === "false" ? "http" : "https";
    this.canton = new CantonClient({
      baseUrl: `${protocol}://${config.cantonHost}:${config.cantonPort}`,
      token: config.cantonToken,
      userId: process.env.CANTON_USER_ID || "administrator",
      actAs: config.cantonParty,
      timeoutMs: 30_000,
    });

    // Initialize Ethereum connection
    this.provider = new ethers.JsonRpcProvider(config.ethereumRpcUrl);
    // Initialize fallback RPC providers
    if (config.fallbackRpcUrls && config.fallbackRpcUrls.length > 0) {
      for (const url of config.fallbackRpcUrls) {
        this.fallbackProviders.push(new ethers.JsonRpcProvider(url));
      }
      console.log(`[Relay] ${this.fallbackProviders.length} fallback RPC providers configured`);
    }
    // Wallet initialized asynchronously via initSigner()
    // to support KMS-based signing (key never enters Node.js memory)

    console.log(`[Relay] Initialized`);
    console.log(`[Relay] Canton: ${config.cantonHost}:${config.cantonPort}`);
    // Sanitize RPC URL in logs to prevent API key leakage
    console.log(`[Relay] Ethereum: ${sanitizeUrl(config.ethereumRpcUrl)}`);
    console.log(`[Relay] Bridge: ${config.bridgeContractAddress}`);
  }

  /**
   * Initialize Ethereum signer (KMS or raw key)
   * Must be called before start()
   */
  async initSigner(): Promise<void> {
    this.wallet = await createEthereumSigner(
      {
        kmsKeyId: this.config.relayerKmsKeyId,
        awsRegion: this.config.awsRegion,
        privateKey: this.config.relayerPrivateKey,
      },
      this.provider
    );
    this.bridgeContract = new ethers.Contract(
      this.config.bridgeContractAddress,
      BRIDGE_ABI,
      this.wallet
    );
    // Direction 4: YieldDistributor contract (read-only, for event scanning)
    if (this.config.yieldDistributorAddress) {
      this.yieldDistributorContract = new ethers.Contract(
        this.config.yieldDistributorAddress,
        YIELD_DISTRIBUTOR_ABI,
        this.provider  // read-only — no signing needed for event queries
      );
    }
    const address = await this.wallet.getAddress();
    console.log(`[Relay] Relayer: ${address}`);
    if (this.config.yieldDistributorAddress) {
      console.log(`[Relay] YieldDistributor: ${this.config.yieldDistributorAddress}`);
    }
    // Direction 4b: ETHPoolYieldDistributor contract (read-only, for event scanning)
    if (this.config.ethPoolYieldDistributorAddress) {
      this.ethPoolYieldDistributorContract = new ethers.Contract(
        this.config.ethPoolYieldDistributorAddress,
        ETH_POOL_YIELD_DISTRIBUTOR_ABI,
        this.provider
      );
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
  private static readonly STATE_VERSION = 1;

  /**
   * Load persisted state from disk on startup.
   * Merges with in-memory state (chain-scanned data takes priority).
   */
  private loadPersistedState(): void {
    const filePath = this.config.stateFilePath;
    if (!filePath) return;

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

      console.log(
        `[Relay] Loaded persisted state: ` +
        `${state.processedAttestations?.length || 0} attestations, ` +
        `${state.processedYieldEpochs?.length || 0} yield epochs, ` +
        `${state.processedETHPoolYieldEpochs?.length || 0} ETH Pool yield epochs, ` +
        `lastScanned=${state.lastScannedBlock || 0}, ` +
        `lastYieldScanned=${state.lastYieldScannedBlock || 0}, ` +
        `lastETHPoolYieldScanned=${state.lastETHPoolYieldScannedBlock || 0}`
      );
    } catch (error: any) {
      console.warn(`[Relay] Failed to load persisted state: ${error.message} — starting fresh`);
    }
  }

  /**
   * Persist current relay state to disk.
   * Called after each successful epoch/attestation processing.
   * Uses atomic write (write to temp file, then rename) to prevent corruption.
   */
  private persistState(): void {
    const filePath = this.config.stateFilePath;
    if (!filePath) return;

    try {
      const state = {
        version: RelayService.STATE_VERSION,
        timestamp: new Date().toISOString(),
        processedAttestations: Array.from(this.processedAttestations),
        processedYieldEpochs: Array.from(this.processedYieldEpochs),
        processedETHPoolYieldEpochs: Array.from(this.processedETHPoolYieldEpochs),
        lastScannedBlock: this.lastScannedBlock,
        lastYieldScannedBlock: this.lastYieldScannedBlock,
        lastETHPoolYieldScannedBlock: this.lastETHPoolYieldScannedBlock,
      };

      const json = JSON.stringify(state, null, 2);

      // Atomic write: write to temp file, then rename (prevents partial writes on crash)
      const tmpPath = filePath + ".tmp";
      fs.writeFileSync(tmpPath, json, "utf-8");
      fs.renameSync(tmpPath, filePath);
    } catch (error: any) {
      // Non-fatal: state persistence failure should not stop the relay
      console.error(`[Relay] Failed to persist state: ${error.message}`);
    }
  }

  /**
   * Start the relay service
   */
  async start(): Promise<void> {
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

    // Main loop — bidirectional
    while (this.isRunning) {
      try {
        // Direction 1: Canton → Ethereum (attestation relay)
        await this.pollForAttestations();
        // Direction 2: Ethereum → Canton (bridge-out watcher)
        await this.watchEthereumBridgeOut();
        // Direction 3: Canton → Ethereum (auto-process bridge-out backing)
        await this.processCantonBridgeOuts();
        // Direction 4: Ethereum → Canton (yield bridge-in — credit Canton pools)
        await this.processYieldBridgeIn();
        // Direction 4b: Ethereum → Canton (ETH Pool yield — credit Canton ETH Pool)
        await this.processETHPoolYieldBridgeIn();
        // Reset failure counter on success
        this.consecutiveFailures = 0;
        metrics.consecutiveFailures.set(0);
      } catch (error) {
        console.error("[Relay] Poll error:", error);
        // Failover to backup RPC on consecutive failures
        this.consecutiveFailures++;
        metrics.consecutiveFailures.set(this.consecutiveFailures);
        if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
          console.warn(
            `[Relay] ${this.consecutiveFailures} consecutive failures — attempting provider failover`
          );
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
  private async validateValidatorAddresses(): Promise<void> {
    const VALIDATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("VALIDATOR_ROLE"));
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
      } catch (error: any) {
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
  private async switchToFallbackProvider(): Promise<boolean> {
    if (this.fallbackProviders.length === 0) {
      console.warn("[Relay] No fallback RPC providers configured — cannot failover");
      return false;
    }

    const nextIndex = (this.activeProviderIndex + 1) % (this.fallbackProviders.length + 1);

    // Index 0 = primary, 1..N = fallback providers
    if (nextIndex === 0) {
      console.log("[Relay] Cycling back to primary RPC provider");
      this.provider = new ethers.JsonRpcProvider(this.config.ethereumRpcUrl);
    } else {
      const fallbackUrl = this.config.fallbackRpcUrls[nextIndex - 1];
      // Sanitize fallback URL to prevent API key leakage in logs
      console.log(`[Relay] Switching to fallback RPC provider #${nextIndex}: ${sanitizeUrl(fallbackUrl)}`);
      this.provider = this.fallbackProviders[nextIndex - 1];
    }

    this.activeProviderIndex = nextIndex;
    this.consecutiveFailures = 0;

    // Re-initialise signer + contract against the new provider
    try {
      await this.initSigner();
      console.log("[Relay] Signer re-initialised on new provider");
      return true;
    } catch (err: any) {
      console.error(`[Relay] Failed to re-init signer on fallback: ${err.message}`);
      return false;
    }
  }

  /**
   * Stop the relay service
   */
  stop(): void {
    console.log("[Relay] Stopping...");
    this.isRunning = false;
  }

  // ============================================================
  //  H-1: RATE LIMITING
  // ============================================================

  /**
   * Check if a transaction is allowed under rate limits.
   * Returns true if allowed, false if rate-limited.
   */
  private async checkRateLimit(): Promise<boolean> {
    const now = Date.now();
    const rl = this.rateLimiter;

    // Reset minute window
    if (now - rl.minuteWindowStart > 60_000) {
      rl.txThisMinute = 0;
      rl.minuteWindowStart = now;
    }

    // Reset hour window
    if (now - rl.hourWindowStart > 3_600_000) {
      rl.txThisHour = 0;
      rl.hourWindowStart = now;
    }

    // Check per-minute cap
    if (rl.txThisMinute >= rl.maxTxPerMinute) {
      console.warn(`[RateLimit] Per-minute cap reached (${rl.maxTxPerMinute}/min). Skipping.`);
      metrics.validatorRateLimitHitsTotal.inc();
      return false;
    }

    // Check per-hour cap
    if (rl.txThisHour >= rl.maxTxPerHour) {
      console.warn(`[RateLimit] Per-hour cap reached (${rl.maxTxPerHour}/hr). Skipping.`);
      metrics.validatorRateLimitHitsTotal.inc();
      return false;
    }

    // Check per-block cap
    try {
      const currentBlock = await this.provider.getBlockNumber();
      if (currentBlock === rl.lastSubmittedBlock) {
        if (rl.txThisBlock >= rl.maxTxPerBlock) {
          console.warn(`[RateLimit] Per-block cap reached (${rl.maxTxPerBlock}/block). Waiting for next block.`);
          return false;
        }
      } else {
        rl.lastSubmittedBlock = currentBlock;
        rl.txThisBlock = 0;
      }
    } catch {
      // If block number check fails, still allow (don't block on RPC hiccup)
    }

    return true;
  }

  /**
   * Record a successful transaction submission for rate limiting
   */
  private recordTxSubmission(): void {
    this.rateLimiter.txThisMinute++;
    this.rateLimiter.txThisHour++;
    this.rateLimiter.txThisBlock++;
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
  private async checkForAnomalies(proposedCantonAssets: bigint): Promise<boolean> {
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
            console.error(
              `[PauseGuardian] ANOMALY: Canton assets change ${Number(changeBps) / 100}% exceeds ` +
              `${this.anomalyDetector.maxCapChangePct}% threshold. Auto-pausing bridge.`
            );
            await this.triggerEmergencyPause(
              `Anomalous asset change: ${Number(changeBps) / 100}% (threshold: ${this.anomalyDetector.maxCapChangePct}%)`
            );
            return false;
          }
        }
      }
    } catch (err: any) {
      // Don't block on anomaly check failure — log and continue
      console.warn(`[PauseGuardian] Anomaly check failed (non-blocking): ${err.message}`);
    }

    return true;
  }

  /**
   * Record a transaction revert and check consecutive revert threshold
   */
  private async recordRevert(): Promise<void> {
    this.anomalyDetector.consecutiveReverts++;
    // Item-10: gauge for anomaly detector state
    metrics.anomalyConsecutiveReverts.set(this.anomalyDetector.consecutiveReverts);
    if (this.anomalyDetector.consecutiveReverts >= this.anomalyDetector.maxConsecutiveReverts) {
      console.error(
        `[PauseGuardian] ${this.anomalyDetector.consecutiveReverts} consecutive reverts — auto-pausing bridge.`
      );
      await this.triggerEmergencyPause(
        `${this.anomalyDetector.consecutiveReverts} consecutive transaction reverts`
      );
    }
  }

  /**
   * Reset consecutive revert counter on successful transaction
   */
  private recordSuccess(): void {
    this.anomalyDetector.consecutiveReverts = 0;
  }

  /**
   * Trigger emergency pause on the bridge contract.
   * Requires the relay signer to hold EMERGENCY_ROLE.
   */
  private async triggerEmergencyPause(reason: string): Promise<void> {
    if (this.anomalyDetector.pauseTriggered) return;
    this.anomalyDetector.pauseTriggered = true;
    // Item-10: flag pause in Prometheus
    metrics.anomalyPauseTriggered.set(1);

    console.error(`[PauseGuardian] ⚠️  EMERGENCY PAUSE TRIGGERED: ${reason}`);

    try {
      // Check if already paused
      const PAUSE_ABI = [
        { inputs: [], name: "paused", outputs: [{ type: "bool" }], stateMutability: "view", type: "function" },
        { inputs: [], name: "pause", outputs: [], stateMutability: "nonpayable", type: "function" },
      ];
      const pausable = new ethers.Contract(
        this.config.bridgeContractAddress,
        PAUSE_ABI,
        this.wallet
      );

      const isPaused = await pausable.paused();
      if (isPaused) {
        console.warn("[PauseGuardian] Bridge is already paused.");
        return;
      }

      const tx = await pausable.pause();
      console.error(`[PauseGuardian] Pause tx: ${tx.hash}`);
      await tx.wait(1);
      console.error(`[PauseGuardian] ✓ Bridge paused successfully. Manual review required.`);
    } catch (err: any) {
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
  private checkNonceReplay(nonce: number, attestationId: string): boolean {
    if (this.submittedNonces.has(nonce)) {
      console.warn(`[NonceGuard] Nonce ${nonce} already submitted by this relay. Skipping duplicate.`);
      metrics.nonceCollisionsTotal.inc();
      return false;
    }
    if (this.inFlightAttestations.has(attestationId)) {
      console.warn(`[NonceGuard] Attestation ${attestationId} already in-flight. Skipping duplicate.`);
      metrics.nonceCollisionsTotal.inc();
      return false;
    }
    return true;
  }

  /**
   * Mark a nonce and attestation as submitted (in-flight)
   */
  private markNonceSubmitted(nonce: number, attestationId: string): void {
    this.submittedNonces.add(nonce);
    this.inFlightAttestations.add(attestationId);
    // Evict old nonces if set grows too large
    if (this.submittedNonces.size > 1000) {
      const toEvict = Array.from(this.submittedNonces).slice(0, 100);
      toEvict.forEach(n => this.submittedNonces.delete(n));
    }
    if (this.inFlightAttestations.size > 1000) {
      const toEvict = Array.from(this.inFlightAttestations).slice(0, 100);
      toEvict.forEach(id => this.inFlightAttestations.delete(id));
    }
  }

  // ============================================================
  //  M-3: LOG REDACTION
  // ============================================================

  /**
   * Redact sensitive data from log output.
   * Masks private keys, API keys, and bearer tokens.
   */
  private static redact(msg: string): string {
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
  private async loadProcessedAttestations(): Promise<void> {
    console.log("[Relay] Loading processed attestations from chain...");

    // MEDIUM-02: Configurable lookback window (default 200,000 blocks ≈ 28 days)
    const filter = this.bridgeContract.filters.AttestationReceived();
    const currentBlock = await this.provider.getBlockNumber();
    const maxRange = this.config.replayLookbackBlocks;
    const fromBlock = Math.max(0, currentBlock - maxRange);
    
    // Paginate in chunks of 10,000 to avoid RPC limits
    const chunkSize = 10000;
    let events: ethers.EventLog[] = [];
    for (let start = fromBlock; start <= currentBlock; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, currentBlock);
      const chunk = await this.bridgeContract.queryFilter(filter, start, end);
      events = events.concat(chunk as ethers.EventLog[]);
    }

    for (const event of events) {
      const args = (event as ethers.EventLog).args;
      if (args) {
        this.processedAttestations.add(args.id);
      }
    }

    console.log(`[Relay] Found ${this.processedAttestations.size} processed attestations`);
  }

  // Maximum attestations to process per poll cycle to prevent memory exhaustion
  private static readonly MAX_BATCH_SIZE = 100;

  /**
   * Poll Canton for finalized attestations ready to bridge
   * Added pagination to prevent memory exhaustion on large backlogs.
   * Processes up to MAX_BATCH_SIZE attestations per cycle, prioritizing by nonce.
   */
  private async pollForAttestations(): Promise<void> {
    // Query active AttestationRequest contracts via Canton v2 HTTP API
    // Filter by aggregator party to only see attestations assigned to us
    let attestations: ActiveContract<AttestationRequest>[];
    
    try {
      attestations = await this.canton.queryContracts<AttestationRequest>(
        TEMPLATES.AttestationRequest,
        (payload) => payload.aggregator === this.config.cantonParty
      );
    } catch (error) {
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
        continue;
      }

      // Check if nonce matches expected
      const currentNonce = await this.bridgeContract.currentNonce();
      const expectedNonce = Number(currentNonce) + 1;

      if (Number(payload.nonce) !== expectedNonce) {
        console.log(`[Relay] Attestation ${attestationId}: nonce mismatch (got ${payload.nonce}, expected ${expectedNonce})`);
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
      const proposedAssets = ethers.parseUnits(payload.globalCantonAssets, 18);
      if (!(await this.checkForAnomalies(proposedAssets))) {
        break; // Pause triggered — stop processing
      }

      // Fetch validator signatures
      const validatorSigs = await this.fetchValidatorSignatures(attestation.contractId);

      if (validatorSigs.length < Number(minSigs)) {
        console.log(`[Relay] Attestation ${attestationId}: not enough valid signatures`);
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
  private async loadProcessedBridgeOuts(): Promise<void> {
    console.log("[Relay] Loading processed bridge-out requests from chain...");

    const filter = this.bridgeContract.filters.BridgeToCantonRequested();
    const currentBlock = await this.provider.getBlockNumber();
    const maxRange = this.config.replayLookbackBlocks;
    const fromBlock = Math.max(0, currentBlock - maxRange);

    const chunkSize = 10000;
    let events: ethers.EventLog[] = [];
    for (let start = fromBlock; start <= currentBlock; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, currentBlock);
      const chunk = await this.bridgeContract.queryFilter(filter, start, end);
      events = events.concat(chunk as ethers.EventLog[]);
    }

    // Check which ones already have BridgeInRequest on Canton
    for (const event of events) {
      const args = (event as ethers.EventLog).args;
      if (args) {
        this.processedBridgeOuts.add(args.requestId);
      }
    }

    this.lastScannedBlock = currentBlock;
    console.log(`[Relay] Found ${this.processedBridgeOuts.size} bridge-out requests (scanning from block ${fromBlock})`);
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
  private async watchEthereumBridgeOut(): Promise<void> {
    const currentBlock = await this.provider.getBlockNumber();
    // Only scan confirmed blocks
    const confirmedBlock = currentBlock - this.config.confirmations;

    if (confirmedBlock <= this.lastScannedBlock) {
      return; // No new confirmed blocks
    }

    const filter = this.bridgeContract.filters.BridgeToCantonRequested();
    const events = await this.bridgeContract.queryFilter(
      filter,
      this.lastScannedBlock + 1,
      confirmedBlock
    );

    this.lastScannedBlock = confirmedBlock;

    if (events.length === 0) return;

    console.log(`[Relay] Found ${events.length} new BridgeToCantonRequested events`);

    for (const event of events) {
      const args = (event as ethers.EventLog).args;
      if (!args) continue;

      const requestId: string = args.requestId;
      const sender: string = args.sender;
      const amount: bigint = args.amount;
      const nonce: bigint = args.nonce;
      const cantonRecipient: string = args.cantonRecipient;
      const timestamp: bigint = args.timestamp;

      // Skip if already processed
      if (this.processedBridgeOuts.has(requestId)) {
        continue;
      }

      // Skip yield bridge events — handled by Direction 4 (processYieldBridgeIn)
      if (
        this.config.yieldDistributorAddress &&
        sender.toLowerCase() === this.config.yieldDistributorAddress.toLowerCase()
      ) {
        console.log(`[Relay] Skipping yield bridge-out #${nonce} from YieldDistributor (handled by Direction 4)`);
        this.processedBridgeOuts.add(requestId); // Mark processed to avoid re-checking
        continue;
      }

      // Skip ETH Pool yield bridge events — handled by Direction 4b (processETHPoolYieldBridgeIn)
      if (
        this.config.ethPoolYieldDistributorAddress &&
        sender.toLowerCase() === this.config.ethPoolYieldDistributorAddress.toLowerCase()
      ) {
        console.log(`[Relay] Skipping ETH Pool yield bridge-out #${nonce} from ETHPoolYieldDistributor (handled by Direction 4b)`);
        this.processedBridgeOuts.add(requestId);
        continue;
      }

      console.log(`[Relay] Bridge-out #${nonce}: ${ethers.formatEther(amount)} mUSD → Canton (${cantonRecipient})`);
      // Item-10: count bridge-outs
      metrics.bridgeOutsTotal.inc({ status: "processing" });

      try {
        // Create BridgeInRequest on Canton
        await this.canton.createContract(
          TEMPLATES.BridgeInRequest,
          {
            operator: this.config.cantonParty,
            user: cantonRecipient,
            amount: ethers.formatEther(amount),
            feeAmount: "0.0",
            sourceChainId: Number((await this.provider.getNetwork()).chainId),
            nonce: Number(nonce),
            createdAt: new Date(Number(timestamp) * 1000).toISOString(),
            status: "pending",
          }
        );

        console.log(`[Relay] Created BridgeInRequest on Canton for bridge-out #${nonce}`);

        // Mark as processed
        this.processedBridgeOuts.add(requestId);

        // Evict oldest entries if cache exceeds limit
        if (this.processedBridgeOuts.size > this.MAX_PROCESSED_CACHE) {
          const toEvict = Math.floor(this.MAX_PROCESSED_CACHE * 0.1);
          let evicted = 0;
          for (const key of this.processedBridgeOuts) {
            if (evicted >= toEvict) break;
            this.processedBridgeOuts.delete(key);
            evicted++;
          }
        }

      } catch (error: any) {
        console.error(`[Relay] Failed to relay bridge-out #${nonce} to Canton:`, error.message);
        // Don't mark as processed — will retry next cycle
      }
    }
  }

  // ============================================================
  //  DIRECTION 4: Ethereum → Canton (Yield Bridge-In)
  // ============================================================

  /**
   * Load already-processed yield epochs from chain to prevent replay on restart.
   */
  private async loadProcessedYieldBridgeIns(): Promise<void> {
    if (!this.yieldDistributorContract) return;

    console.log("[Relay] Loading processed yield bridge-in epochs from chain...");

    const currentBlock = await this.provider.getBlockNumber();
    const maxRange = this.config.replayLookbackBlocks;
    const fromBlock = Math.max(0, currentBlock - maxRange);

    const filter = this.yieldDistributorContract.filters.CantonYieldBridged();
    const chunkSize = 10000;
    let events: ethers.EventLog[] = [];
    for (let start = fromBlock; start <= currentBlock; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, currentBlock);
      const chunk = await this.yieldDistributorContract.queryFilter(filter, start, end);
      events = events.concat(chunk as ethers.EventLog[]);
    }

    for (const event of events) {
      const args = (event as ethers.EventLog).args;
      if (args) {
        this.processedYieldEpochs.add(args.epoch.toString());
      }
    }

    this.lastYieldScannedBlock = currentBlock;
    console.log(
      `[Relay] Found ${this.processedYieldEpochs.size} yield epochs (scanning from block ${fromBlock})`
    );
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
  private async processYieldBridgeIn(): Promise<void> {
    if (!this.yieldDistributorContract) return;

    const currentBlock = await this.provider.getBlockNumber();
    const confirmedBlock = currentBlock - this.config.confirmations;

    if (confirmedBlock <= this.lastYieldScannedBlock) return;

    const filter = this.yieldDistributorContract.filters.CantonYieldBridged();
    const events = await this.yieldDistributorContract.queryFilter(
      filter,
      this.lastYieldScannedBlock + 1,
      confirmedBlock
    );

    this.lastYieldScannedBlock = confirmedBlock;

    if (events.length === 0) return;

    console.log(`[Relay] Found ${events.length} new CantonYieldBridged events`);

    for (const event of events) {
      const args = (event as ethers.EventLog).args;
      if (!args) continue;

      const epoch: string = args.epoch.toString();
      const musdAmount: bigint = args.musdAmount;
      const cantonRecipient: string = args.cantonRecipient;

      if (this.processedYieldEpochs.has(epoch)) continue;

      const amountStr = ethers.formatEther(musdAmount);
      console.log(
        `[Relay] Yield epoch #${epoch}: ${amountStr} mUSD → Canton staking pool (${cantonRecipient})`
      );

      try {
        // MEDIUM-02: Canton-side duplicate check before creating CantonMUSD
        const agreementHash = `yield-epoch-${epoch}`;
        const existingMusd = await this.canton.queryContracts(
          TEMPLATES.CantonMUSD,
          (payload: any) =>
            payload.owner === this.config.cantonParty &&
            payload.agreementHash === agreementHash
        );
        if (existingMusd.length > 0) {
          console.log(
            `[Relay] Yield epoch #${epoch} already has CantonMUSD on Canton ` +
            `(${existingMusd[0].contractId.slice(0, 16)}...) — skipping duplicate create`
          );
          this.processedYieldEpochs.add(epoch);
          this.persistState();
          continue;
        }

        // Step 1: Create CantonMUSD on Canton (operator-owned yield mUSD)
        const createResult = await this.canton.createContract(
          TEMPLATES.CantonMUSD,
          {
            issuer: this.config.cantonParty,
            owner: this.config.cantonParty,
            amount: amountStr,
            agreementHash: `yield-epoch-${epoch}`,
            agreementUri: `ethereum:yield-distributor:${this.config.yieldDistributorAddress}`,
            privacyObservers: [] as string[],
          }
        );

        // Extract contractId from create response
        // The v2 submit-and-wait response includes the completion with created events
        const musdContractId = this.extractCreatedContractId(createResult, "CantonMUSD");
        if (!musdContractId) {
          // Fallback: query for the most recent CantonMUSD owned by operator
          const musdContracts = await this.canton.queryContracts(
            TEMPLATES.CantonMUSD,
            (payload: any) =>
              payload.owner === this.config.cantonParty &&
              payload.agreementHash === `yield-epoch-${epoch}`
          );
          if (musdContracts.length === 0) {
            throw new Error("Created CantonMUSD not found on Canton after create");
          }
          const latestMusd = musdContracts[musdContracts.length - 1];
          console.log(`[Relay] CantonMUSD created (queried): ${latestMusd.contractId}`);
          await this.creditCantonStakingPool(latestMusd.contractId, epoch, amountStr);
        } else {
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
            if (evicted >= toEvict) break;
            this.processedYieldEpochs.delete(key);
            evicted++;
          }
        }
      } catch (error: any) {
        console.error(
          `[Relay] Failed to process yield epoch #${epoch}: ${error.message}`
        );
        // Don't mark as processed — retry next cycle
      }
    }
  }

  /**
   * Exercise ReceiveYield on CantonStakingService to credit the staking pool.
   */
  private async creditCantonStakingPool(
    musdContractId: string,
    epoch: string,
    amountStr: string
  ): Promise<void> {
    // Step 2: Query CantonStakingService to get its contractId
    const stakingServices = await this.canton.queryContracts(
      TEMPLATES.CantonStakingService,
      (payload: any) => payload.operator === this.config.cantonParty
    );

    if (stakingServices.length === 0) {
      throw new Error("No CantonStakingService found on Canton — cannot credit yield");
    }

    const stakingService = stakingServices[0];

    // Step 3: Exercise ReceiveYield — merges mUSD into vault, pooledMusd ↑
    await this.canton.exerciseChoice(
      TEMPLATES.CantonStakingService,
      stakingService.contractId,
      "ReceiveYield",
      { yieldMusdCid: musdContractId }
    );

    console.log(
      `[Relay] ✅ Yield epoch #${epoch}: ${amountStr} mUSD credited to Canton staking pool ` +
      `(service: ${stakingService.contractId.slice(0, 16)}...)`
    );
  }

  // ============================================================
  //  DIRECTION 4b: Ethereum → Canton (ETH Pool Yield Bridge-In)
  // ============================================================

  /**
   * Load already-processed ETH Pool yield epochs from chain to prevent replay on restart.
   */
  private async loadProcessedETHPoolYieldBridgeIns(): Promise<void> {
    if (!this.ethPoolYieldDistributorContract) return;

    console.log("[Relay] Loading processed ETH Pool yield bridge-in epochs from chain...");

    const currentBlock = await this.provider.getBlockNumber();
    const maxRange = this.config.replayLookbackBlocks;
    const fromBlock = Math.max(0, currentBlock - maxRange);

    const filter = this.ethPoolYieldDistributorContract.filters.ETHPoolYieldBridged();
    const chunkSize = 10000;
    let events: ethers.EventLog[] = [];
    for (let start = fromBlock; start <= currentBlock; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, currentBlock);
      const chunk = await this.ethPoolYieldDistributorContract.queryFilter(filter, start, end);
      events = events.concat(chunk as ethers.EventLog[]);
    }

    for (const event of events) {
      const args = (event as ethers.EventLog).args;
      if (args) {
        this.processedETHPoolYieldEpochs.add(args.epoch.toString());
      }
    }

    this.lastETHPoolYieldScannedBlock = currentBlock;
    console.log(
      `[Relay] Found ${this.processedETHPoolYieldEpochs.size} ETH Pool yield epochs (scanning from block ${fromBlock})`
    );
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
  private async processETHPoolYieldBridgeIn(): Promise<void> {
    if (!this.ethPoolYieldDistributorContract) return;

    const currentBlock = await this.provider.getBlockNumber();
    const confirmedBlock = currentBlock - this.config.confirmations;

    if (confirmedBlock <= this.lastETHPoolYieldScannedBlock) return;

    const filter = this.ethPoolYieldDistributorContract.filters.ETHPoolYieldBridged();
    const events = await this.ethPoolYieldDistributorContract.queryFilter(
      filter,
      this.lastETHPoolYieldScannedBlock + 1,
      confirmedBlock
    );

    this.lastETHPoolYieldScannedBlock = confirmedBlock;

    if (events.length === 0) return;

    console.log(`[Relay] Found ${events.length} new ETHPoolYieldBridged events`);

    for (const event of events) {
      const args = (event as ethers.EventLog).args;
      if (!args) continue;

      const epoch: string = args.epoch.toString();
      const musdBridged: bigint = args.musdBridged;
      const ethPoolRecipient: string = args.ethPoolRecipient;

      if (this.processedETHPoolYieldEpochs.has(epoch)) continue;

      const amountStr = ethers.formatEther(musdBridged);
      console.log(
        `[Relay] ETH Pool yield epoch #${epoch}: ${amountStr} mUSD → Canton ETH Pool (${ethPoolRecipient})`
      );

      try {
        // MEDIUM-02: Canton-side duplicate check — query for existing CantonMUSD
        // with matching agreementHash before creating a new one. This prevents
        // orphaned CantonMUSD contracts if the relay restarts and re-encounters
        // an event that was processed but not persisted.
        const agreementHash = `ethpool-yield-epoch-${epoch}`;
        const existingMusd = await this.canton.queryContracts(
          TEMPLATES.CantonMUSD,
          (payload: any) =>
            payload.owner === this.config.cantonParty &&
            payload.agreementHash === agreementHash
        );
        if (existingMusd.length > 0) {
          console.log(
            `[Relay] ETH Pool yield epoch #${epoch} already has CantonMUSD on Canton ` +
            `(${existingMusd[0].contractId.slice(0, 16)}...) — skipping duplicate create`
          );
          this.processedETHPoolYieldEpochs.add(epoch);
          this.persistState();
          continue;
        }

        // Step 1: Create CantonMUSD on Canton (operator-owned yield mUSD)
        const createResult = await this.canton.createContract(
          TEMPLATES.CantonMUSD,
          {
            issuer: this.config.cantonParty,
            owner: this.config.cantonParty,
            amount: amountStr,
            agreementHash: `ethpool-yield-epoch-${epoch}`,
            agreementUri: `ethereum:ethpool-yield-distributor:${this.config.ethPoolYieldDistributorAddress}`,
            privacyObservers: [] as string[],
          }
        );

        // Extract contractId from create response
        const musdContractId = this.extractCreatedContractId(createResult, "CantonMUSD");
        if (!musdContractId) {
          // Fallback: query for the most recent CantonMUSD owned by operator
          const musdContracts = await this.canton.queryContracts(
            TEMPLATES.CantonMUSD,
            (payload: any) =>
              payload.owner === this.config.cantonParty &&
              payload.agreementHash === `ethpool-yield-epoch-${epoch}`
          );
          if (musdContracts.length === 0) {
            throw new Error("Created CantonMUSD not found on Canton after create (ETH Pool)");
          }
          const latestMusd = musdContracts[musdContracts.length - 1];
          console.log(`[Relay] CantonMUSD created for ETH Pool (queried): ${latestMusd.contractId}`);
          await this.creditCantonETHPool(latestMusd.contractId, epoch, amountStr);
        } else {
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
            if (evicted >= toEvict) break;
            this.processedETHPoolYieldEpochs.delete(key);
            evicted++;
          }
        }
      } catch (error: any) {
        console.error(
          `[Relay] Failed to process ETH Pool yield epoch #${epoch}: ${error.message}`
        );
        // Don't mark as processed — retry next cycle
      }
    }
  }

  /**
   * Exercise ETHPool_ReceiveYield on CantonETHPoolService to credit the ETH Pool.
   * This increments pooledUsdc, which raises the ETH Pool share price.
   */
  private async creditCantonETHPool(
    musdContractId: string,
    epoch: string,
    amountStr: string
  ): Promise<void> {
    // Query CantonETHPoolService to get its contractId
    const ethPoolServices = await this.canton.queryContracts(
      TEMPLATES.CantonETHPoolService,
      (payload: any) => payload.operator === this.config.cantonParty
    );

    if (ethPoolServices.length === 0) {
      throw new Error("No CantonETHPoolService found on Canton — cannot credit ETH Pool yield");
    }

    const ethPoolService = ethPoolServices[0];

    // Exercise ETHPool_ReceiveYield — archives mUSD, increments pooledUsdc
    await this.canton.exerciseChoice(
      TEMPLATES.CantonETHPoolService,
      ethPoolService.contractId,
      "ETHPool_ReceiveYield",
      { yieldMusdCid: musdContractId }
    );

    console.log(
      `[Relay] ✅ ETH Pool yield epoch #${epoch}: ${amountStr} mUSD credited to Canton ETH Pool ` +
      `(service: ${ethPoolService.contractId.slice(0, 16)}...)`
    );
  }

  /**
   * Extract the created contract ID from a v2 submit-and-wait response.
   * Returns null if the response format doesn't contain a recognizable contractId.
   */
  private extractCreatedContractId(response: unknown, entityName: string): string | null {
    try {
      const resp = response as any;
      // Daml JSON API v2 submit-and-wait returns a transaction with events
      const transaction = resp?.transaction || resp?.result?.transaction;
      if (!transaction) return null;

      const events = transaction.events || transaction.eventsById;
      if (!events) return null;

      // events can be an array or a map
      const eventList = Array.isArray(events) ? events : Object.values(events);
      for (const evt of eventList) {
        const created = evt?.CreatedEvent || evt?.created || evt;
        if (created?.contractId && created?.templateId?.includes(entityName)) {
          return created.contractId;
        }
      }
    } catch {
      /* Response format not recognized — fall back to query */
    }
    return null;
  }

  // ============================================================
  //  DIRECTION 3: Canton → Ethereum (Auto Bridge-Out Processing)
  // ============================================================

  /**
   * Auto-process Canton BridgeOutRequests.
   *
   * When a user mints mUSD on Canton (via USDC/USDCx), a BridgeOutRequest is created.
   * This method polls Canton for pending requests and processes them:
   *
   *   1. Check if USDC backing is available in relayer wallet
   *      (from xReserve/Circle CCTP redemption — operator redeems USDCx off-chain)
   *   2. Route USDC based on source:
   *      - "ethpool" → depositToStrategy(MetaVault #3) — targeted Fluid allocation
   *      - "directmint" → deposit() — general auto-allocation across strategies
   *   3. Mark BridgeOutRequest as "bridged" on Canton
   */
  private async processCantonBridgeOuts(): Promise<void> {
    // Query Canton for pending BridgeOutRequests (standalone module)
    const pendingRequests = await this.canton.queryContracts<{
      operator: string;
      user: string;
      amount: string;
      targetChainId: number;
      targetTreasury: string;
      nonce: number;
      createdAt: string;
      status: string;
      source: string;
      validators: string[];
    }>(
      TEMPLATES.StandaloneBridgeOutRequest,
      (p) => p.status === "pending" && p.operator === this.config.cantonParty
    );

    if (pendingRequests.length === 0) return;

    console.log(`[Relay] Found ${pendingRequests.length} pending BridgeOutRequests on Canton`);

    // Treasury ABI — includes both general deposit and targeted depositToStrategy
    const treasuryAbi = [
      "function deposit(address from, uint256 amount) external",
      "function depositToStrategy(address strategy, uint256 amount) external returns (uint256)",
      "function usdc() external view returns (address)",
    ];
    const treasury = new ethers.Contract(
      this.config.treasuryAddress,
      treasuryAbi,
      this.wallet
    );

    const erc20Abi = [
      "function approve(address spender, uint256 amount) external returns (bool)",
      "function balanceOf(address account) external view returns (uint256)",
    ];

    let usdcAddress: string;
    try {
      usdcAddress = await treasury.usdc();
    } catch (err: any) {
      console.error(`[Relay] Failed to read USDC address from Treasury:`, err.message);
      return;
    }

    const usdc = new ethers.Contract(usdcAddress, erc20Abi, this.wallet);
    const walletAddress = await this.wallet.getAddress();

    for (const req of pendingRequests) {
      const { payload, contractId } = req;
      try {
        // Convert DAML Numeric 18 to USDC 6-decimal amount
        const amountWei = ethers.parseEther(payload.amount);
        const amountUsdc = amountWei / BigInt(1e12);

        // Check relayer wallet has sufficient USDC
        // (arrives from xReserve/Circle CCTP redemption — handled off-chain by operator)
        const balance: bigint = await usdc.balanceOf(walletAddress);
        if (balance < amountUsdc) {
          console.log(
            `[Relay] BridgeOut #${payload.nonce}: insufficient USDC ` +
            `(need ${amountUsdc}, have ${balance}) — waiting for xReserve redemption`
          );
          continue; // Skip — will retry next cycle when USDC arrives
        }

        const isEthPool = payload.source === "ethpool";
        const routeLabel = isEthPool ? "MetaVault #3 (Fluid)" : "Treasury (auto-allocate)";

        console.log(`[Relay] Processing BridgeOut #${payload.nonce} [${payload.source}]: ${ethers.formatUnits(amountUsdc, 6)} USDC → ${routeLabel}`);

        // Step 1: Approve Treasury to spend USDC
        const approveTx = await usdc.approve(this.config.treasuryAddress, amountUsdc);
        await approveTx.wait();

        // Step 2: Route deposit based on source
        if (isEthPool && this.config.metaVault3Address) {
          // ETH Pool → deposit directly to MetaVault #3 (Fluid T2/T4 strategy)
          const depositTx = await treasury.depositToStrategy(
            this.config.metaVault3Address,
            amountUsdc
          );
          await depositTx.wait();
          console.log(`[Relay] ✅ Deposited ${ethers.formatUnits(amountUsdc, 6)} USDC → MetaVault #3 (tx: ${depositTx.hash})`);
        } else {
          // DirectMint → general deposit with auto-allocation
          const depositTx = await treasury.deposit(walletAddress, amountUsdc);
          await depositTx.wait();
          console.log(`[Relay] ✅ Deposited ${ethers.formatUnits(amountUsdc, 6)} USDC to Treasury (tx: ${depositTx.hash})`);
        }

        // Step 3: Mark BridgeOutRequest as completed on Canton
        await this.canton.exerciseChoice(
          TEMPLATES.StandaloneBridgeOutRequest,
          contractId,
          "BridgeOut_Complete",
          { relayParty: this.config.cantonParty }
        );
        console.log(`[Relay] ✅ BridgeOutRequest #${payload.nonce} marked as bridged on Canton`);

      } catch (error: any) {
        console.error(`[Relay] Failed to process BridgeOut #${payload.nonce}:`, error.message);
        // Don't mark as failed — will retry next cycle
      }
    }
  }

  /**
   * Fetch ValidatorSignature contracts for an attestation
   */
  private async fetchValidatorSignatures(
    requestId: string
  ): Promise<ValidatorSignature[]> {
    // Query all ValidatorSignature contracts and filter by requestId client-side
    const signatures = await this.canton.queryContracts<ValidatorSignature>(
      TEMPLATES.ValidatorSignature,
      (payload) => payload.requestId === requestId
    );
    return signatures.map(s => s.payload);
  }

  /**
   * Submit attestation to Ethereum
   */
  private async bridgeAttestation(
    payload: AttestationPayload,
    validatorSigs: ValidatorSignature[],
    cantonContract: ActiveContract<AttestationRequest>  // BRIDGE-H-03: Need contract ID for Attestation_Complete
  ): Promise<void> {
    const attestationId = payload.attestationId;

    try {
      // Validate chain ID matches connected network to prevent cross-chain replay
      const network = await this.provider.getNetwork();
      const expectedChainId = network.chainId;
      const payloadChainId = BigInt(payload.chainId);

      if (payloadChainId !== expectedChainId) {
        console.error(
          `[Relay] CRITICAL: Chain ID mismatch! Payload: ${payloadChainId}, Network: ${expectedChainId}`
        );
        console.error(`[Relay] Rejecting attestation ${attestationId} - possible cross-chain replay attack`);
        throw new Error(`CHAIN_ID_MISMATCH: expected ${expectedChainId}, got ${payloadChainId}`);
      }

      // Compute entropy and derive attestation ID first (needed for on-chain checks)
      const entropy = payload.entropy
        ? (payload.entropy.startsWith("0x") ? payload.entropy : "0x" + payload.entropy)
        : ethers.hexlify(new Uint8Array(crypto.randomBytes(32)));
      // Read cantonStateHash from payload
      const cantonStateHash = payload.cantonStateHash
        ? (payload.cantonStateHash.startsWith("0x") ? payload.cantonStateHash : "0x" + payload.cantonStateHash)
        : ethers.ZeroHash;
      const cantonAssets = ethers.parseUnits(payload.globalCantonAssets, 18);
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
        throw new Error(
          `BRIDGE-M-05: Derived timestamp ${timestampSec} is more than ${RelayService.MAX_TIMESTAMP_DRIFT_SECONDS}s ` +
          `from current time ${nowSec}. expiresAt=${payload.expiresAt}. Possible clock skew or stale attestation.`
        );
      }
      const chainId = expectedChainId;
      // ID derivation matches BLEBridgeV9.computeAttestationId()
      // On-chain: keccak256(abi.encodePacked(nonce, cantonAssets, timestamp, entropy, cantonStateHash, chainid, address))
      // cantonStateHash already extracted from payload at line 572
      const idBytes32 = ethers.solidityPackedKeccak256(
        ["uint256", "uint256", "uint256", "bytes32", "bytes32", "uint256", "address"],
        [nonce, cantonAssets, BigInt(timestampSec), entropy, cantonStateHash, chainId, this.config.bridgeContractAddress]
      );

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
      const sortedSigs = sortSignaturesBySignerAddress(formattedSigs, messageHash);

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
      } catch (simulationError: any) {
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
      const gasEstimate = await this.bridgeContract.processAttestation.estimateGas(
        attestation,
        sortedSigs
      );

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
      this.markNonceSubmitted(Number(nonce), attestationId);

      const tx = await this.bridgeContract.processAttestation(
        attestation,
        sortedSigs,
        {
          gasLimit: gasEstimate * 120n / 100n,  // 20% buffer
        }
      );

      console.log(`[Relay] Transaction submitted: ${tx.hash}`);

      // Wait for confirmations
      const receipt = await tx.wait(this.config.confirmations);

      if (receipt.status === 1) {
        console.log(`[Relay] Attestation ${attestationId} bridged successfully`);
        this.processedAttestations.add(attestationId);
        // Item-10: Prometheus counters
        metrics.attestationsProcessedTotal.inc({ status: "success" });
        // H-1: Record successful submission for rate limiting
        this.recordTxSubmission();
        // H-2: Reset consecutive revert counter and update cap baseline
        this.recordSuccess();
        try {
          const newCap = await this.bridgeContract.getCurrentSupplyCap();
          this.anomalyDetector.lastKnownSupplyCap = BigInt(newCap);
        } catch { /* non-blocking */ }

        // BRIDGE-H-03: Exercise Attestation_Complete on DAML to archive
        // the attestation request. Without this, stale attestation contracts remain on
        // the Canton ledger, causing the relay to re-process them on every poll cycle
        // (retry storms) and leaving DAML state inconsistent with Ethereum.
        try {
          await this.canton.exerciseChoice(
            TEMPLATES.AttestationRequest,
            cantonContract.contractId,
            "Attestation_Complete",
            {}
          );
          console.log(`[Relay] Attestation ${attestationId} marked complete on Canton`);
        } catch (completeError: any) {
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
            if (evicted >= toEvict) break;
            this.processedAttestations.delete(key);
            evicted++;
          }
        }
      } else {
        console.error(`[Relay] Transaction reverted: ${tx.hash}`);
        // Item-10: Prometheus counters
        metrics.attestationsProcessedTotal.inc({ status: "revert" });
        metrics.txRevertsTotal.inc({ operation: "attestation" });
        // H-2: Track consecutive reverts for pause guardian
        await this.recordRevert();
      }

    } catch (error: any) {
      // M-3: Redact sensitive data from error logs
      console.error(`[Relay] Failed to bridge attestation ${attestationId}:`, RelayService.redact(error.message));

      // Check if it's a revert with reason
      if (error.reason) {
        console.error(`[Relay] Revert reason: ${error.reason}`);
      }

      // H-2: Track consecutive reverts for pause guardian
      await this.recordRevert();

      // Don't mark as processed so we can retry
      throw error;
    }
  }

  /**
   * Build the message hash that validators signed
   * Includes entropy in hash to match BLEBridgeV9 verification
   * Includes cantonStateHash to match on-chain signature verification
   */
  private buildMessageHash(payload: AttestationPayload, idBytes32: string, cantonStateHash?: string): string {
    // Use BigInt for chainId to avoid IEEE 754 precision loss on large chain IDs
    const chainId = BigInt(payload.chainId);

    // Read entropy from payload for inclusion in hash
    const entropy = payload.entropy
      ? (payload.entropy.startsWith("0x") ? payload.entropy : "0x" + payload.entropy)
      : ethers.ZeroHash;

    // cantonStateHash already received as parameter (formatted by caller)
    const stateHash = cantonStateHash || ethers.ZeroHash;

    // Matches on-chain: keccak256(abi.encodePacked(id, cantonAssets, nonce, timestamp, entropy, cantonStateHash, chainid, address))
    return ethers.solidityPackedKeccak256(
      ["bytes32", "uint256", "uint256", "uint256", "bytes32", "bytes32", "uint256", "address"],
      [
        idBytes32,
        ethers.parseUnits(payload.globalCantonAssets, 18),
        BigInt(payload.nonce),
        // BRIDGE-M-05: Use named constant consistent with bridgeAttestation derivation
        BigInt(Math.max(1, Math.floor(new Date(payload.expiresAt).getTime() / 1000) - RelayService.ATTESTATION_TTL_SECONDS)),
        entropy,
        stateHash,
        chainId,
        this.config.bridgeContractAddress,
      ]
    );
  }

  /**
   * Format validator signatures for Ethereum
   * Pre-verify signatures using ecrecover before submitting to chain
   */
  private async formatSignatures(
    validatorSigs: ValidatorSignature[],
    messageHash: string
  ): Promise<string[]> {
    const formatted: string[] = [];
    // Use Ethereum-signed message hash for ecrecover validation
    const ethSignedHash = ethers.hashMessage(ethers.getBytes(messageHash));

    for (const sig of validatorSigs) {
      try {
        let rsvSignature: string;

        // Look up the Ethereum address for this DAML Party
        // sig.validator is a DAML Party string like "validator1::122abc"
        // We need the corresponding Ethereum address like "0x71C7..."
        const validatorEthAddress = this.config.validatorAddresses[sig.validator];
        if (!validatorEthAddress) {
          console.error(
            `[Relay] No Ethereum address mapped for validator party: ${sig.validator}`
          );
          console.error(`[Relay] Add to VALIDATOR_ADDRESSES config: {"${sig.validator}": "0x..."}`);
          continue;  // Skip - no address mapping
        }

        // Validate RSV format more strictly (check hex content + v value)
        if (sig.ecdsaSignature.startsWith("0x") && sig.ecdsaSignature.length === 132) {
          // Verify it's valid hex and has a valid v value (1b or 1c = 27 or 28)
          const vByte = sig.ecdsaSignature.slice(130, 132).toLowerCase();
          if (/^[0-9a-f]+$/.test(sig.ecdsaSignature.slice(2)) &&
              (vByte === "1b" || vByte === "1c")) {
            rsvSignature = sig.ecdsaSignature;
          } else {
            console.warn(`[Relay] Invalid RSV signature from ${sig.validator}: bad v value`);
            metrics.bridgeValidationFailuresTotal.inc({ reason: "bad_v_value" });
            continue;
          }
        }
        // If signature is DER encoded (from AWS KMS)
        else {
          const derBuffer = Buffer.from(sig.ecdsaSignature.replace("0x", ""), "hex");
          rsvSignature = formatKMSSignature(
            derBuffer,
            messageHash,
            validatorEthAddress  // Use mapped Ethereum address, not DAML Party
          );
        }

        // Pre-verify signature using ecrecover before including
        // This catches invalid signatures before wasting gas on-chain
        try {
          const recoveredAddress = ethers.recoverAddress(ethSignedHash, rsvSignature);
          // Compare to mapped Ethereum address, not DAML Party
          const expectedAddress = validatorEthAddress.toLowerCase();

          if (recoveredAddress.toLowerCase() !== expectedAddress) {
            console.error(
              `[Relay] CRITICAL: Signature from ${sig.validator} (${validatorEthAddress}) recovers to ${recoveredAddress}`
            );
            console.error(`[Relay] Rejecting invalid signature - possible attack or key mismatch`);
            metrics.bridgeValidationFailuresTotal.inc({ reason: "ecrecover_mismatch" });
            continue;  // Skip this signature
          }

          // Signature verified - add to formatted list
          formatted.push(rsvSignature);
          console.log(`[Relay] Verified signature from ${sig.validator} (${validatorEthAddress})`);

        } catch (recoverError) {
          console.error(
            `[Relay] Failed to recover address from signature by ${sig.validator}:`,
            recoverError
          );
          continue;  // Skip malformed signatures
        }

      } catch (error) {
        console.warn(`[Relay] Failed to format signature from ${sig.validator}:`, error);
      }
    }

    return formatted;
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Trigger Treasury auto-deploy to yield strategies after bridge-in
   */
  private async triggerYieldDeploy(): Promise<void> {
    if (!this.config.treasuryAddress) return;

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

      const treasury = new ethers.Contract(
        this.config.treasuryAddress,
        TREASURY_ABI,
        this.wallet
      );

      // Check if auto-deploy would trigger
      const [shouldDeploy, deployable] = await treasury.shouldAutoDeploy();

      if (!shouldDeploy) {
        // TS-M-04: Use ethers.formatUnits for safe BigInt → decimal formatting
        console.log(`[Relay] Auto-deploy: No deployment needed (deployable: ${ethers.formatUnits(deployable, 6)} USDC)`);
        return;
      }

      console.log(`[Relay] Auto-deploy: Triggering deployment of ${ethers.formatUnits(deployable, 6)} USDC to yield strategy...`);

      const tx = await treasury.keeperTriggerAutoDeploy();
      const receipt = await tx.wait(1);

      if (receipt.status === 1) {
        console.log(`[Relay] Auto-deploy: Successfully deployed ${ethers.formatUnits(deployable, 6)} USDC to yield strategy`);
      } else {
        console.warn(`[Relay] Auto-deploy: Transaction reverted`);
      }

    } catch (error: any) {
      // Don't throw - auto-deploy failure shouldn't affect bridge success
      console.warn(`[Relay] Auto-deploy failed (non-critical):`, error.message);
    }
  }
}

// ============================================================
//                     HEALTH CHECK SERVER
// ============================================================

import * as http from "http";

// Health server with Prometheus metrics endpoint (Item-10)
// Replaces the legacy JSON /metrics with Prometheus text exposition format
// so that K8s PodMonitors / ServiceMonitors can scrape correctly.
function startHealthServer(port: number, relay: RelayService): http.Server {
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
    } else if (req.url === "/metrics") {
      // Item-10: Refresh relay-specific gauges before every Prometheus scrape
      metrics.lastScannedBlock.set((relay as any).lastScannedBlock || 0);
      metrics.activeProviderIndex.set((relay as any).activeProviderIndex || 0);
      metrics.consecutiveFailures.set((relay as any).consecutiveFailures || 0);
      metrics.rateLimiterTxPerMinute.set((relay as any).rateLimiter?.txThisMinute || 0);
      metrics.rateLimiterTxPerHour.set((relay as any).rateLimiter?.txThisHour || 0);
      metrics.inFlightAttestations.set((relay as any).inFlightAttestations?.size || 0);
      metrics.anomalyConsecutiveReverts.set((relay as any).anomalyDetector?.consecutiveReverts || 0);
      metrics.anomalyPauseTriggered.set((relay as any).anomalyDetector?.pauseTriggered ? 1 : 0);

      // Serve Prometheus text exposition format
      await metrics.metricsHandler(req, res);
    } else if (req.url === "/metrics/json") {
      // Legacy JSON endpoint preserved for backwards compatibility
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        processedCount: (relay as any).processedAttestations.size,
        bridgeOutCount: (relay as any).processedBridgeOuts.size,
        lastScannedBlock: (relay as any).lastScannedBlock,
        activeProviderIndex: (relay as any).activeProviderIndex,
        consecutiveFailures: (relay as any).consecutiveFailures,
        rateLimiter: {
          txThisMinute: (relay as any).rateLimiter.txThisMinute,
          txThisHour: (relay as any).rateLimiter.txThisHour,
        },
        anomalyDetector: {
          consecutiveReverts: (relay as any).anomalyDetector.consecutiveReverts,
          pauseTriggered: (relay as any).anomalyDetector.pauseTriggered,
        },
        submittedNonces: (relay as any).submittedNonces.size,
        inFlightAttestations: (relay as any).inFlightAttestations.size,
        uptimeSeconds: Math.floor(process.uptime()),
        memoryMB: Math.floor(process.memoryUsage().heapUsed / 1024 / 1024),
      }));
    } else {
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

async function main(): Promise<void> {
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
  if (!ethers.isAddress(DEFAULT_CONFIG.bridgeContractAddress)) {
    throw new Error("BRIDGE_CONTRACT_ADDRESS is not a valid Ethereum address");
  }
  if (!DEFAULT_CONFIG.relayerPrivateKey && !DEFAULT_CONFIG.relayerKmsKeyId) {
    throw new Error("Either RELAYER_PRIVATE_KEY or RELAYER_KMS_KEY_ID must be set");
  }
  // Prefer KMS in production
  if (DEFAULT_CONFIG.relayerKmsKeyId) {
    console.log("[Main] Using AWS KMS for Ethereum signing (H-07: key never in memory)");
  } else {
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
      const inFlight = (relay as any).inFlightAttestations?.size || 0;
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
      processedAttestations: (relay as any).processedAttestations.size,
      bridgeOutsRelayed: (relay as any).processedBridgeOuts.size,
      lastScannedBlock: (relay as any).lastScannedBlock,
      consecutiveFailures: (relay as any).consecutiveFailures,
      rateLimiter: {
        txThisMinute: (relay as any).rateLimiter.txThisMinute,
        txThisHour: (relay as any).rateLimiter.txThisHour,
      },
      anomalyDetector: {
        consecutiveReverts: (relay as any).anomalyDetector.consecutiveReverts,
        pauseTriggered: (relay as any).anomalyDetector.pauseTriggered,
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

export { RelayService, RelayConfig };
