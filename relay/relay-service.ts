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
// FIX T-M01: Use shared readSecret utility
// FIX B-H07: Use readAndValidatePrivateKey for secp256k1 range validation
import { readSecret, readAndValidatePrivateKey } from "./utils";
// Import yield keeper for auto-deploy integration
import { getKeeperStatus } from "./yield-keeper";

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
  relayerPrivateKey: string;   // Hot wallet for gas

  // FIX CRITICAL: Mapping from DAML Party ID to Ethereum address
  // Without this, signature validation ALWAYS fails because we compared
  // Party strings like "validator1::122abc" to addresses like "0x71C7..."
  validatorAddresses: Record<string, string>;

  // Operational
  pollIntervalMs: number;
  maxRetries: number;
  confirmations: number;
  triggerAutoDeploy: boolean;  // Whether to trigger auto-deploy after bridge
}

const DEFAULT_CONFIG: RelayConfig = {
  cantonHost: process.env.CANTON_HOST || "localhost",
  // FIX H-7: Added explicit radix 10 to all parseInt calls
  cantonPort: parseInt(process.env.CANTON_PORT || "6865", 10),
  // FIX I-C01: Read sensitive values from Docker secrets, fallback to env vars
  cantonToken: readSecret("canton_token", "CANTON_TOKEN"),
  cantonParty: process.env.CANTON_PARTY || "",

  // INFRA-H-02: No insecure fallback — require explicit RPC URL in production
  ethereumRpcUrl: (() => {
    const url = process.env.ETHEREUM_RPC_URL;
    if (!url) throw new Error("ETHEREUM_RPC_URL is required");
    if (!url.startsWith("https://") && process.env.NODE_ENV !== "development") {
      throw new Error("ETHEREUM_RPC_URL must use HTTPS in production");
    }
    return url;
  })(),
  bridgeContractAddress: process.env.BRIDGE_CONTRACT_ADDRESS || "",
  treasuryAddress: process.env.TREASURY_ADDRESS || "",
  // FIX B-H07: Validate private key is in valid secp256k1 range
  relayerPrivateKey: readAndValidatePrivateKey("relayer_private_key", "RELAYER_PRIVATE_KEY"),

  // FIX CRITICAL: Map DAML Party → Ethereum address
  // Load from JSON config file or environment
  // Format: {"validator1::122abc": "0x71C7...", "validator2::456def": "0x82D8..."}
  // FIX B-H03: Limit JSON size to 10KB to prevent memory exhaustion attacks
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
};

// ============================================================
//                     DAML TYPES (generated)
// ============================================================

// These mirror your DAML templates
interface AttestationPayload {
  attestationId: string;
  globalCantonAssets: string;  // Numeric as string
  targetAddress: string;
  amount: string;
  isMint: boolean;
  nonce: string;
  chainId: string;
  expiresAt: string;  // ISO timestamp
}

interface AttestationRequest {
  aggregator: string;
  validatorGroup: string[];
  payload: AttestationPayload;
  positionCids: ContractId<unknown>[];
  collectedSignatures: string[];  // Set as array
}

interface ValidatorSignature {
  requestId: ContractId<AttestationRequest>;
  validator: string;
  aggregator: string;
  ecdsaSignature: string;
  nonce: string;
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
          { "name": "timestamp", "type": "uint256" }
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
  // FIX B-C03: ABI for hasRole to validate validator addresses on-chain
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
  private wallet: ethers.Wallet;
  private bridgeContract: ethers.Contract;
  // FIX M-18: Bounded cache with eviction
  private processedAttestations: Set<string> = new Set();
  private readonly MAX_PROCESSED_CACHE = 10000;
  private isRunning: boolean = false;

  constructor(config: RelayConfig) {
    this.config = config;

    // FIX H-12: Default to TLS for Canton ledger connections (opt-out instead of opt-in)
    const protocol = process.env.CANTON_USE_TLS === "false" ? "http" : "https";
    const wsProtocol = process.env.CANTON_USE_TLS === "false" ? "ws" : "wss";
    this.ledger = new Ledger({
      token: config.cantonToken,
      httpBaseUrl: `${protocol}://${config.cantonHost}:${config.cantonPort}`,
      wsBaseUrl: `${wsProtocol}://${config.cantonHost}:${config.cantonPort}`,
    });

    // Initialize Ethereum connection
    this.provider = new ethers.JsonRpcProvider(config.ethereumRpcUrl);
    this.wallet = new ethers.Wallet(config.relayerPrivateKey, this.provider);
    this.bridgeContract = new ethers.Contract(
      config.bridgeContractAddress,
      BRIDGE_ABI,
      this.wallet
    );

    console.log(`[Relay] Initialized`);
    console.log(`[Relay] Canton: ${config.cantonHost}:${config.cantonPort}`);
    console.log(`[Relay] Ethereum: ${config.ethereumRpcUrl}`);
    console.log(`[Relay] Bridge: ${config.bridgeContractAddress}`);
    console.log(`[Relay] Relayer: ${this.wallet.address}`);
  }

  /**
   * Start the relay service
   */
  async start(): Promise<void> {
    console.log("[Relay] Starting...");
    
    // FIX B-C03: Validate validator addresses against on-chain roles before starting
    await this.validateValidatorAddresses();
    
    this.isRunning = true;

    // Load already-processed attestations from chain
    await this.loadProcessedAttestations();

    // Main loop
    while (this.isRunning) {
      try {
        await this.pollForAttestations();
      } catch (error) {
        console.error("[Relay] Poll error:", error);
      }
      await this.sleep(this.config.pollIntervalMs);
    }
  }

  /**
   * FIX B-C03: Validate that all configured validator addresses have VALIDATOR_ROLE on-chain
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

    // FIX B-M02: Increased block range from 10,000 to 50,000 and added pagination
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
   * FIX M-06: Added pagination to prevent memory exhaustion on large backlogs.
   * Processes up to MAX_BATCH_SIZE attestations per cycle, prioritizing by nonce.
   */
  private async pollForAttestations(): Promise<void> {
    // Query active AttestationRequest contracts
    // FIX P0: Use MintedProtocolV3 to match validator-node-v2.ts
    // Previously used V2 which meant relay and validator saw different data
    // FIX B-M03: Added query timeout to prevent indefinite hangs (matching validator-node.ts)
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

    // FIX M-06: Limit batch size to prevent memory issues
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

      // Check if we have enough signatures
      const signatures = attestation.payload.collectedSignatures;
      const minSigs = await this.bridgeContract.minSignatures();

      if (signatures.length < Number(minSigs)) {
        console.log(`[Relay] Attestation ${attestationId}: ${signatures.length}/${minSigs} signatures`);
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
      await this.bridgeAttestation(payload, validatorSigs);
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
    // FIX R-H01: Use MintedProtocolV3 to match pollForAttestations query version
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
    validatorSigs: ValidatorSignature[]
  ): Promise<void> {
    const attestationId = payload.attestationId;

    try {
      // FIX IC-02: Validate chain ID matches connected network to prevent cross-chain replay
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

      // Convert attestation ID to bytes32
      const idBytes32 = ethers.id(attestationId);

      // Check if already used on-chain
      const isUsed = await this.bridgeContract.usedAttestationIds(idBytes32);
      if (isUsed) {
        console.log(`[Relay] Attestation ${attestationId} already processed on-chain`);
        this.processedAttestations.add(attestationId);
        return;
      }

      // Format signatures for Ethereum
      const messageHash = this.buildMessageHash(payload, idBytes32);
      const formattedSigs = await this.formatSignatures(validatorSigs, messageHash);

      // Sort signatures by signer address (required by BLEBridgeV9)
      const sortedSigs = sortSignaturesBySignerAddress(formattedSigs, messageHash);

      // Build attestation struct
      // FIX B-M01: Validate timestamp to prevent negative values from expiresAt - 3600
      const expiresAtMs = new Date(payload.expiresAt).getTime();
      if (isNaN(expiresAtMs) || expiresAtMs <= 0) {
        throw new Error(`Invalid expiresAt timestamp: ${payload.expiresAt}`);
      }
      const timestampSec = Math.floor(expiresAtMs / 1000) - 3600;
      if (timestampSec <= 0) {
        throw new Error(`Computed timestamp is non-positive (${timestampSec}). expiresAt too early: ${payload.expiresAt}`);
      }
      const attestation = {
        id: idBytes32,
        cantonAssets: ethers.parseUnits(payload.globalCantonAssets, 18),
        nonce: BigInt(payload.nonce),
        timestamp: BigInt(timestampSec),
      };

      // FIX B-C01: Simulate transaction before submission to prevent race condition gas drain
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

        // Trigger auto-deploy to yield strategies if configured
        if (this.config.triggerAutoDeploy && this.config.treasuryAddress) {
          await this.triggerYieldDeploy();
        }

        // FIX M-18: Evict oldest 10% of entries if cache exceeds limit
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
   */
  private buildMessageHash(payload: AttestationPayload, idBytes32: string): string {
    // FIX T-C01: Use BigInt for chainId to avoid IEEE 754 precision loss on large chain IDs
    const chainId = BigInt(payload.chainId);

    return ethers.solidityPackedKeccak256(
      ["bytes32", "uint256", "uint256", "uint256", "uint256", "address"],
      [
        idBytes32,
        ethers.parseUnits(payload.globalCantonAssets, 18),
        BigInt(payload.nonce),
        // FIX B-M01: Use validated timestamp calculation consistent with bridgeAttestation
        BigInt(Math.max(1, Math.floor(new Date(payload.expiresAt).getTime() / 1000) - 3600)),
        chainId,
        this.config.bridgeContractAddress,
      ]
    );
  }

  /**
   * Format validator signatures for Ethereum
   * FIX IC-08: Pre-verify signatures using ecrecover before submitting to chain
   */
  private async formatSignatures(
    validatorSigs: ValidatorSignature[],
    messageHash: string
  ): Promise<string[]> {
    const formatted: string[] = [];
    // FIX IC-08: Use Ethereum-signed message hash for ecrecover validation
    const ethSignedHash = ethers.hashMessage(ethers.getBytes(messageHash));

    for (const sig of validatorSigs) {
      try {
        let rsvSignature: string;

        // FIX CRITICAL: Look up the Ethereum address for this DAML Party
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

        // FIX M-19: Validate RSV format more strictly (check hex content + v value)
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
            validatorEthAddress  // FIX: Use mapped Ethereum address, not DAML Party
          );
        }

        // FIX IC-08: Pre-verify signature using ecrecover before including
        // This catches invalid signatures before wasting gas on-chain
        try {
          const recoveredAddress = ethers.recoverAddress(ethSignedHash, rsvSignature);
          // FIX CRITICAL: Compare to mapped Ethereum address, not DAML Party
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
        console.log(`[Relay] Auto-deploy: No deployment needed (deployable: ${Number(deployable) / 1e6} USDC)`);
        return;
      }

      console.log(`[Relay] Auto-deploy: Triggering deployment of ${Number(deployable) / 1e6} USDC to yield strategy...`);

      const tx = await treasury.keeperTriggerAutoDeploy();
      const receipt = await tx.wait(1);

      if (receipt.status === 1) {
        console.log(`[Relay] Auto-deploy: Successfully deployed ${Number(deployable) / 1e6} USDC to yield strategy`);
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

// FIX H-15: Health server with optional bearer token authentication
function startHealthServer(port: number, relay: RelayService): http.Server {
  const healthToken = process.env.HEALTH_AUTH_TOKEN || "";

  const server = http.createServer(async (req, res) => {
    // FIX H-15: Require auth token for metrics endpoint (operational state)
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
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  // FIX M-22: Bind to localhost by default instead of 0.0.0.0
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
  // FIX M-23: Validate Ethereum address format
  if (!ethers.isAddress(DEFAULT_CONFIG.bridgeContractAddress)) {
    throw new Error("BRIDGE_CONTRACT_ADDRESS is not a valid Ethereum address");
  }
  if (!DEFAULT_CONFIG.relayerPrivateKey) {
    throw new Error("RELAYER_PRIVATE_KEY not set");
  }
  // FIX H-9: Validate private key format before wallet creation
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(DEFAULT_CONFIG.relayerPrivateKey)) {
    throw new Error("RELAYER_PRIVATE_KEY has invalid format (expected 64 hex chars)");
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
  // FIX H-7: Added explicit radix 10 to parseInt
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

// FIX T-C03: Handle unhandled promise rejections to prevent silent failures
process.on("unhandledRejection", (reason, promise) => {
  console.error("[Main] Unhandled rejection at:", promise, "reason:", reason);
  process.exit(1);
});

main().catch((error) => {
  console.error("[Main] Fatal error:", error);
  process.exit(1);
});

export { RelayService, RelayConfig };
