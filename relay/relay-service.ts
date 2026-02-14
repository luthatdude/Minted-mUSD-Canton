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

import { ethers } from "ethers";
import Ledger, { CreateEvent } from "@daml/ledger";
import { ContractId } from "@daml/types";
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
  relayerPrivateKey: string;   // Hot wallet for gas (deprecated: use KMS)
  // KMS key for Ethereum transaction signing (key never in memory)
  relayerKmsKeyId: string;     // AWS KMS key ARN for relay signing
  awsRegion: string;           // AWS region for KMS

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
  // Validate private key is in valid secp256k1 range
  relayerPrivateKey: readAndValidatePrivateKey("relayer_private_key", "RELAYER_PRIVATE_KEY"),
  // KMS key for Ethereum transaction signing
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
  positionCids: ContractId<unknown>[];
  collectedSignatures: string[];  // Set as array (party identifiers)
  // BRIDGE-C-01: ECDSA signatures stored alongside party set on DAML ledger.
  // Each entry is [Party, hex-encoded ECDSA signature].
  ecdsaSignatures: [string, string][];
  requiredSignatures: number;     // BRIDGE-H-01: Threshold from BridgeService, matches Solidity minSignatures
  direction: string;              // "CantonToEthereum" | "EthereumToCanton"
}

interface ValidatorSignature {
  requestId: ContractId<AttestationRequest>;
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
  }
];

// ============================================================
//                     RELAY SERVICE
// ============================================================

class RelayService {
  private config: RelayConfig;
  private ledger: Ledger;
  private provider: ethers.JsonRpcProvider;
  private wallet!: ethers.Signer;  // Abstract signer (KMS or raw)
  private bridgeContract!: ethers.Contract;
  // Bounded cache with eviction
  private processedAttestations: Set<string> = new Set();
  private readonly MAX_PROCESSED_CACHE = 10000;
  private isRunning: boolean = false;

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
    const wsProtocol = process.env.CANTON_USE_TLS === "false" ? "ws" : "wss";
    this.ledger = new Ledger({
      token: config.cantonToken,
      httpBaseUrl: `${protocol}://${config.cantonHost}:${config.cantonPort}`,
      wsBaseUrl: `${wsProtocol}://${config.cantonHost}:${config.cantonPort}`,
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
    const address = await this.wallet.getAddress();
    console.log(`[Relay] Relayer: ${address}`);
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

    // Load already-processed attestations from chain
    await this.loadProcessedAttestations();

    // Main loop
    while (this.isRunning) {
      try {
        await this.pollForAttestations();
        // Reset failure counter on success
        this.consecutiveFailures = 0;
      } catch (error) {
        console.error("[Relay] Poll error:", error);
        // Failover to backup RPC on consecutive failures
        this.consecutiveFailures++;
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

  /**
   * Load attestation IDs that have already been processed on-chain
   */
  private async loadProcessedAttestations(): Promise<void> {
    console.log("[Relay] Loading processed attestations from chain...");

    // Increased block range from 10,000 to 50,000 and added pagination
    // to avoid missing processed attestations during longer relay downtime
    const filter = this.bridgeContract.filters.AttestationReceived();
    const currentBlock = await this.provider.getBlockNumber();
    const maxRange = 50000;
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
    // Query active AttestationRequest contracts
    // Use MintedProtocolV3 to match validator-node-v2.ts
    // Previously used V2 which meant relay and validator saw different data
    // Added query timeout to prevent indefinite hangs (matching validator-node.ts)
    let attestations: CreateEvent<AttestationRequest>[];
    
    try {
      const queryPromise = (this.ledger.query as any)(
        "MintedProtocolV3:AttestationRequest",
        { aggregator: this.config.cantonParty }
      ) as Promise<CreateEvent<AttestationRequest>[]>;
      
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Canton query timeout (30s)")), 30_000)
      );
      
      attestations = await Promise.race([queryPromise, timeoutPromise]);
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

  /**
   * Fetch ValidatorSignature contracts for an attestation
   */
  private async fetchValidatorSignatures(
    requestId: ContractId<AttestationRequest>
  ): Promise<ValidatorSignature[]> {
    // Use MintedProtocolV3 to match pollForAttestations query version
    // Previously used V2 which would miss signatures created on V3 templates
    const signatures = await (this.ledger.query as any)(
      "MintedProtocolV3:ValidatorSignature",
      { requestId }
    ) as CreateEvent<ValidatorSignature>[];
    return signatures.map(s => s.payload);
  }

  /**
   * Submit attestation to Ethereum
   */
  private async bridgeAttestation(
    payload: AttestationPayload,
    validatorSigs: ValidatorSignature[],
    attestation: CreateEvent<AttestationRequest>  // BRIDGE-H-03: Need contract ID for Attestation_Complete
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
      // BRIDGE-M-04: SECURITY NOTE — processAttestation() on BLEBridgeV9 is permissionless
      // (any address can call it). This means anyone with valid signatures can submit.
      // This is mitigated by:
      //   1. The relay pre-verifies all ECDSA signatures via ecrecover before submitting
      //   2. BLEBridgeV9 verifies signatures on-chain against VALIDATOR_ROLE holders
      //   3. Attestation IDs are derived from nonce+entropy and checked for uniqueness
      //   4. Pre-flight simulation catches front-running/replay attempts
      // TODO(BRIDGE-M-04): Add access control (e.g., RELAYER_ROLE) to processAttestation
      //   in the next BLEBridgeV9 Solidity upgrade to defense-in-depth against
      //   griefing attacks where adversaries submit invalid signature sets to burn gas.
      console.log(`[Relay] Submitting attestation ${attestationId} with ${sortedSigs.length} signatures...`);

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

        // SECURITY FIX BRIDGE-H-03: Exercise Attestation_Complete on DAML to archive
        // the attestation request. Without this, stale attestation contracts remain on
        // the Canton ledger, causing the relay to re-process them on every poll cycle
        // (retry storms) and leaving DAML state inconsistent with Ethereum.
        try {
          await (this.ledger.exercise as any)(
            "MintedProtocolV3:AttestationRequest",
            attestation.contractId,
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
      }

    } catch (error: any) {
      console.error(`[Relay] Failed to bridge attestation ${attestationId}:`, error.message);

      // Check if it's a revert with reason
      if (error.reason) {
        console.error(`[Relay] Revert reason: ${error.reason}`);
      }

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

// Health server with optional bearer token authentication
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
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        processedCount: (relay as any).processedAttestations.size,
        activeProviderIndex: (relay as any).activeProviderIndex,
        consecutiveFailures: (relay as any).consecutiveFailures,
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
  console.log("===========================================");
  console.log("  Minted Protocol - Canton-Ethereum Relay  ");
  console.log("===========================================");
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

  // Handle shutdown
  const shutdown = () => {
    console.log("\n[Main] Shutting down...");
    relay.stop();
    healthServer.close();
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
