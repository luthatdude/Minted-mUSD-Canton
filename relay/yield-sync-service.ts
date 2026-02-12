/**
 * Minted Protocol - Yield Sync Service (Unified Cross-Chain)
 *
 * Synchronizes GLOBAL SHARE PRICE between Ethereum and Canton for equal yield distribution.
 * All smUSD holders on both chains receive the same yield rate.
 *
 * Architecture:
 *   - Canton MMF ($50B) acts as collateral reference for minting capacity
 *   - Ethereum TreasuryV2 generates yield via Pendle/Morpho/Sky strategies
 *   - This service ensures UNIFIED share price across both chains
 *
 * Unified Share Price Model:
 *   globalSharePrice = TreasuryV2.totalValue() / (ethShares + cantonShares)
 *
 * Bidirectional Sync Flow:
 *   1. Read Canton totalShares → sync to Ethereum SMUSD.syncCantonShares()
 *   2. Read Ethereum SMUSD.globalSharePrice() (includes Treasury yield)
 *   3. Sync global share price to Canton via SyncGlobalSharePrice
 *   4. Both chains now have identical share price → equal yield for all stakers
 */

import { ethers } from "ethers";
import Ledger from "@daml/ledger";
import { ContractId } from "@daml/types";
import { readSecret, readAndValidatePrivateKey } from "./utils";

// Handle unhandled promise rejections to prevent silent failures
process.on('unhandledRejection', (reason, promise) => {
  console.error('FATAL: Unhandled promise rejection:', reason);
  process.exit(1);
});

// Handle uncaught exceptions to prevent silent crashes
process.on('uncaughtException', (error) => {
  console.error('FATAL: Uncaught exception:', error);
  process.exit(1);
});

// ============================================================
//                     CONFIGURATION
// ============================================================

interface YieldSyncConfig {
  // Ethereum
  ethereumRpcUrl: string;
  treasuryAddress: string;
  smusdAddress: string;        // NEW: SMUSD contract for global share price
  bridgePrivateKey: string;    // NEW: Private key with BRIDGE_ROLE

  // Canton
  cantonHost: string;
  cantonPort: number;
  cantonToken: string;
  cantonParty: string;  // Operator party

  // Validators (for signing attestations)
  validatorParties: string[];

  // Sync parameters
  syncIntervalMs: number;      // How often to sync (e.g., every hour)
  minYieldThreshold: string;   // Minimum yield to trigger sync (e.g., "1000" = $1000)
  epochStartNumber: number;    // Starting epoch number
}

const DEFAULT_CONFIG: YieldSyncConfig = {
  ethereumRpcUrl: process.env.ETHEREUM_RPC_URL || "http://localhost:8545",
  treasuryAddress: process.env.TREASURY_ADDRESS || "",
  smusdAddress: process.env.SMUSD_ADDRESS || "",
  // Validate private key is in valid secp256k1 range
  bridgePrivateKey: readAndValidatePrivateKey("bridge_private_key", "BRIDGE_PRIVATE_KEY"),

  cantonHost: process.env.CANTON_HOST || "localhost",
  cantonPort: parseInt(process.env.CANTON_PORT || "6865", 10),
  cantonToken: readSecret("canton_token", "CANTON_TOKEN"),
  cantonParty: process.env.CANTON_PARTY || "",

  validatorParties: (process.env.VALIDATOR_PARTIES || "").split(",").filter(Boolean),

  syncIntervalMs: parseInt(process.env.YIELD_SYNC_INTERVAL_MS || "3600000", 10),  // 1 hour
  minYieldThreshold: process.env.MIN_YIELD_THRESHOLD || "1000000000",  // $1000 (6 decimals)
  epochStartNumber: parseInt(process.env.EPOCH_START || "1", 10),
};

// Warn if using insecure HTTP transport for Ethereum RPC
if (DEFAULT_CONFIG.ethereumRpcUrl && DEFAULT_CONFIG.ethereumRpcUrl.startsWith('http://') && !DEFAULT_CONFIG.ethereumRpcUrl.includes('localhost') && !DEFAULT_CONFIG.ethereumRpcUrl.includes('127.0.0.1')) {
  console.warn('WARNING: Using insecure HTTP transport for Ethereum RPC. Use HTTPS in production.');
}
// Reject insecure HTTP transport in production
if (process.env.NODE_ENV === 'production' && DEFAULT_CONFIG.ethereumRpcUrl && !DEFAULT_CONFIG.ethereumRpcUrl.startsWith('https://') && !DEFAULT_CONFIG.ethereumRpcUrl.startsWith('wss://')) {
  throw new Error('Insecure RPC transport in production. ETHEREUM_RPC_URL must use https:// or wss://');
}

// ============================================================
//                     CONTRACT ABIs
// ============================================================

const TREASURY_ABI = [
  {
    "inputs": [],
    "name": "totalValue",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "lastRecordedValue",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "availableReserves",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "deployedToStrategies",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
];

const SMUSD_ABI = [
  {
    "inputs": [],
    "name": "globalSharePrice",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "globalTotalShares",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "globalTotalAssets",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "ethereumTotalShares",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "cantonTotalShares",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "lastCantonSyncEpoch",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "uint256", "name": "_cantonShares", "type": "uint256" },
      { "internalType": "uint256", "name": "epoch", "type": "uint256" }
    ],
    "name": "syncCantonShares",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
];

// ============================================================
//                     DAML TYPES
// ============================================================

// Matches BLEBridgeProtocol.YieldPayload
interface YieldPayload {
  attestationId: string;
  totalTreasuryAssets: string;  // Numeric 18 as string
  totalMUSDSupply: string;      // Numeric 18 as string
  yieldAccrued: string;         // Numeric 18 as string
  epochNumber: string;          // Int as string
  timestamp: string;            // Time as ISO string
  nonce: string;                // Int as string
}

// Matches BLEBridgeProtocol.YieldAttestation
interface YieldAttestation {
  aggregator: string;
  validatorGroup: string[];
  payload: YieldPayload;
  signedValidators: string[];
}

// Matches BLEBridgeProtocol.YieldSignature
interface YieldSignature {
  requestCid: ContractId<YieldAttestation>;
  validator: string;
  aggregator: string;
  ecdsaSignature: string;
  nonce: string;
}

// Matches CantonSMUSD.CantonStakingService (updated for unified yield)
interface CantonStakingService {
  operator: string;
  totalShares: string;
  globalSharePrice: string;     // UNIFIED: Global share price from Ethereum
  globalTotalAssets: string;    // Total assets across both chains
  globalTotalShares: string;    // Total shares across both chains
  lastSyncEpoch: string;
  cooldownSeconds: string;
  minDeposit: string;
  paused: boolean;
  mpaHash: string;
  mpaUri: string;
  observers: string[];
}

// ============================================================
//                     YIELD SYNC SERVICE (UNIFIED)
// ============================================================

class YieldSyncService {
  private config: YieldSyncConfig;
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private treasury: ethers.Contract;
  private smusd: ethers.Contract;
  private ledger: Ledger;
  private isRunning: boolean = false;

  // State tracking
  private lastSyncedTotalValue: bigint = BigInt(0);
  private lastGlobalSharePrice: bigint = BigInt(0);
  private currentEpoch: number;
  private nonce: number = 1;

  constructor(config: YieldSyncConfig) {
    this.config = config;
    this.currentEpoch = config.epochStartNumber;

    // Validate Ethereum addresses before use
    if (!config.treasuryAddress || !ethers.isAddress(config.treasuryAddress)) {
      throw new Error(`Invalid TREASURY_ADDRESS: ${config.treasuryAddress}`);
    }
    if (!config.smusdAddress || !ethers.isAddress(config.smusdAddress)) {
      throw new Error(`Invalid SMUSD_ADDRESS: ${config.smusdAddress}`);
    }

    // Ethereum connection with signing capability
    this.provider = new ethers.JsonRpcProvider(config.ethereumRpcUrl);
    this.wallet = new ethers.Wallet(config.bridgePrivateKey, this.provider);
    
    this.treasury = new ethers.Contract(
      config.treasuryAddress,
      TREASURY_ABI,
      this.provider
    );
    
    this.smusd = new ethers.Contract(
      config.smusdAddress,
      SMUSD_ABI,
      this.wallet  // Signing wallet for syncCantonShares()
    );

    // Canton connection (TLS by default)
    const protocol = process.env.CANTON_USE_TLS === "false" ? "http" : "https";
    const wsProtocol = process.env.CANTON_USE_TLS === "false" ? "ws" : "wss";
    this.ledger = new Ledger({
      token: config.cantonToken,
      httpBaseUrl: `${protocol}://${config.cantonHost}:${config.cantonPort}`,
      wsBaseUrl: `${wsProtocol}://${config.cantonHost}:${config.cantonPort}`,
    });

    console.log("[YieldSync] Initialized (UNIFIED CROSS-CHAIN MODE)");
    console.log(`[YieldSync] Treasury: ${config.treasuryAddress}`);
    console.log(`[YieldSync] SMUSD: ${config.smusdAddress}`);
    console.log(`[YieldSync] Bridge wallet: ${this.wallet.address}`);
    console.log(`[YieldSync] Canton: ${config.cantonHost}:${config.cantonPort}`);
    console.log(`[YieldSync] Operator: ${config.cantonParty}`);
    console.log(`[YieldSync] Sync interval: ${config.syncIntervalMs}ms`);
  }

  /**
   * Start the yield sync service
   */
  async start(): Promise<void> {
    console.log("[YieldSync] Starting UNIFIED yield sync...");
    this.isRunning = true;

    // Initialize last synced value
    await this.initializeState();

    // Main sync loop
    while (this.isRunning) {
      try {
        await this.syncUnifiedYield();
      } catch (err) {
        console.error("[YieldSync] Error in sync cycle:", err);
      }

      await this.sleep(this.config.syncIntervalMs);
    }
  }

  /**
   * Stop the service
   */
  stop(): void {
    console.log("[YieldSync] Stopping...");
    this.isRunning = false;
  }

  /**
   * Initialize state from both chains
   */
  private async initializeState(): Promise<void> {
    console.log("[YieldSync] Initializing unified state...");

    // Get current values from Ethereum
    const currentTotalValue = await this.treasury.totalValue();
    this.lastSyncedTotalValue = BigInt(currentTotalValue.toString());
    
    const currentSharePrice = await this.smusd.globalSharePrice();
    this.lastGlobalSharePrice = BigInt(currentSharePrice.toString());

    // Get last epoch from Canton staking service
    const stakingServices = await (this.ledger.query as any)(
      "CantonSMUSD:CantonStakingService",
      { operator: this.config.cantonParty }
    );

    if (stakingServices.length > 0) {
      this.currentEpoch = parseInt(stakingServices[0].payload.lastSyncEpoch || "0", 10) + 1;
      console.log(`[YieldSync] Resuming from epoch ${this.currentEpoch}`);
      console.log(`[YieldSync] Canton totalShares: ${stakingServices[0].payload.totalShares}`);
      console.log(`[YieldSync] Canton globalSharePrice: ${stakingServices[0].payload.globalSharePrice}`);
    } else {
      console.log(`[YieldSync] No staking service found, starting fresh at epoch ${this.currentEpoch}`);
    }

    console.log(`[YieldSync] Ethereum Treasury value: $${this.formatUsdc(currentTotalValue)}`);
    console.log(`[YieldSync] Ethereum globalSharePrice: ${currentSharePrice}`);
  }

  /**
   * UNIFIED sync logic - bidirectional share price synchronization
   */
  private async syncUnifiedYield(): Promise<void> {
    console.log(`\n[YieldSync] ═══════════════════════════════════════════`);
    console.log(`[YieldSync] EPOCH ${this.currentEpoch} - UNIFIED YIELD SYNC`);
    console.log(`[YieldSync] ═══════════════════════════════════════════`);

    // ═══════════════════════════════════════════════════════════════════
    // STEP 1: Read Canton shares and sync to Ethereum
    // ═══════════════════════════════════════════════════════════════════
    console.log(`\n[YieldSync] Step 1: Syncing Canton shares → Ethereum...`);
    
    const stakingServices = await (this.ledger.query as any)(
      "CantonSMUSD:CantonStakingService",
      { operator: this.config.cantonParty }
    );

    if (stakingServices.length === 0) {
      console.log(`[YieldSync] No Canton staking service found, skipping`);
      return;
    }

    const cantonService = stakingServices[0];
    const cantonShares = this.parseNumeric18(cantonService.payload.totalShares);
    console.log(`[YieldSync] Canton totalShares: ${cantonShares}`);

    // Sync Canton shares to Ethereum SMUSD
    const lastEthEpoch = await this.smusd.lastCantonSyncEpoch();
    if (this.currentEpoch > Number(lastEthEpoch)) {
      console.log(`[YieldSync] Calling SMUSD.syncCantonShares(${cantonShares}, ${this.currentEpoch})...`);
      const tx = await this.smusd.syncCantonShares(cantonShares, this.currentEpoch);
      await tx.wait();
      console.log(`[YieldSync] ✅ Canton shares synced to Ethereum (tx: ${tx.hash})`);
    } else {
      console.log(`[YieldSync] Ethereum already synced for epoch ${this.currentEpoch}`);
    }

    // ═══════════════════════════════════════════════════════════════════
    // STEP 2: Read global share price from Ethereum (now includes Canton shares)
    // ═══════════════════════════════════════════════════════════════════
    console.log(`\n[YieldSync] Step 2: Reading global share price from Ethereum...`);
    
    const globalSharePrice = BigInt((await this.smusd.globalSharePrice()).toString());
    const globalTotalAssets = BigInt((await this.smusd.globalTotalAssets()).toString());
    const globalTotalShares = BigInt((await this.smusd.globalTotalShares()).toString());
    const ethShares = BigInt((await this.smusd.ethereumTotalShares()).toString());

    console.log(`[YieldSync] globalTotalAssets: $${this.formatUsdc(globalTotalAssets)}`);
    console.log(`[YieldSync] globalTotalShares: ${globalTotalShares} (ETH: ${ethShares}, Canton: ${cantonShares})`);
    console.log(`[YieldSync] globalSharePrice: ${globalSharePrice}`);

    // Check if share price increased (yield generated)
    if (globalSharePrice <= this.lastGlobalSharePrice) {
      console.log(`[YieldSync] No yield increase detected, skipping Canton sync`);
      return;
    }

    const sharePriceIncrease = globalSharePrice - this.lastGlobalSharePrice;
    console.log(`[YieldSync] Share price increase: ${sharePriceIncrease}`);

    // Sanity bound — reject share price changes > 10% per epoch
    // Prevents relay compromise from pushing catastrophic price updates
    // (DAML-side SyncGlobalSharePrice has its own 10% decrease cap + quorum)
    if (this.lastGlobalSharePrice > 0n) {
      const maxIncreaseBps = 1000n; // 10% max increase per epoch
      const maxAllowed = this.lastGlobalSharePrice + (this.lastGlobalSharePrice * maxIncreaseBps / 10000n);
      if (globalSharePrice > maxAllowed) {
        console.error(`[YieldSync] ❌ REJECTED: Share price increase exceeds 10% cap`);
        console.error(`[YieldSync]   last=${this.lastGlobalSharePrice}, new=${globalSharePrice}, max=${maxAllowed}`);
        return;
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // STEP 3: Collect attestation quorum and sync global share price to Canton
    // Route through multi-attestor quorum instead of direct
    // operator exercise. Independent validators must submit SharePriceAttestations
    // before sync is accepted. This eliminates the single-relay trust boundary.
    // ═══════════════════════════════════════════════════════════════════
    console.log(`\n[YieldSync] Step 3: Collecting attestation quorum for Canton sync...`);

    // Wait for independent validators to submit SharePriceAttestations.
    // Each validator independently reads Ethereum share price and creates an attestation.
    // The relay (operator) collects attestation CIDs once quorum is reached.
    const attestationCids = await this.collectAttestationQuorum(this.currentEpoch);

    if (attestationCids.length === 0) {
      console.error(`[YieldSync] ❌ Insufficient attestations for epoch ${this.currentEpoch}, skipping sync`);
      return;
    }

    // Retrieve pre-approved governance proof for parameter update
    const governanceProofCid = await this.getGovernanceProof("CantonSMUSD");

    if (!governanceProofCid) {
      console.error(`[YieldSync] ❌ No governance proof available for CantonSMUSD ParameterUpdate, skipping sync`);
      return;
    }

    console.log(`[YieldSync] Collected ${attestationCids.length} attestations, exercising SyncGlobalSharePrice...`);

    await (this.ledger.exercise as any)(
      "CantonSMUSD:CantonStakingService",
      cantonService.contractId,
      "SyncGlobalSharePrice",
      {
        attestationCids,
        epochNumber: this.currentEpoch.toString(),
        governanceProofCid,
      }
    );

    console.log(`[YieldSync] ✅ Global share price synced to Canton (quorum-verified)!`);

    // ═══════════════════════════════════════════════════════════════════
    // STEP 4: Update state and log summary
    // ═══════════════════════════════════════════════════════════════════
    this.lastSyncedTotalValue = globalTotalAssets;
    this.lastGlobalSharePrice = globalSharePrice;
    this.currentEpoch++;

    console.log(`\n[YieldSync] ═══════════════════════════════════════════`);
    console.log(`[YieldSync] ✅ UNIFIED YIELD SYNC COMPLETE!`);
    console.log(`[YieldSync] ═══════════════════════════════════════════`);
    console.log(`[YieldSync] All stakers on BOTH chains now have:`);
    console.log(`[YieldSync]   - Same share price: ${globalSharePrice}`);
    console.log(`[YieldSync]   - Equal yield rate`);
    console.log(`[YieldSync] Next sync in ${this.config.syncIntervalMs / 1000}s`);
  }

  // ============================================================
  //  Attestation Quorum Collection
  // ============================================================

  /**
   * Collect attestation quorum from independent validators.
   * Polls for SharePriceAttestation contracts matching the current epoch
   * until quorum (≥2/3 of authorized validators) is reached or timeout.
   *
   * Each validator independently observes Ethereum share price and creates
   * a SharePriceAttestation on Canton. The relay collects CIDs once enough
   * unique validators have attested.
   */
  private async collectAttestationQuorum(epochNumber: number): Promise<string[]> {
    const maxWaitMs = 300_000;     // 5 minutes max wait for attestations
    const pollIntervalMs = 10_000; // Poll every 10 seconds
    const minRequired = Math.max(1, Math.ceil(this.config.validatorParties.length * 2 / 3));
    const startTime = Date.now();

    console.log(`[YieldSync] Waiting for attestation quorum: need ${minRequired}/${this.config.validatorParties.length} validators`);

    while (Date.now() - startTime < maxWaitMs) {
      // Query for SharePriceAttestation contracts matching this epoch
      const attestations = await (this.ledger.query as any)(
        "CantonSMUSD:SharePriceAttestation",
        { operator: this.config.cantonParty }
      );

      // Filter for correct epoch and authorized validators, deduplicate by attestor
      const seenAttestors = new Set<string>();
      const uniqueCids: string[] = [];

      for (const a of attestations) {
        const attestor = a.payload.attestor;
        const epoch = parseInt(a.payload.epochNumber, 10);

        if (
          epoch === epochNumber &&
          this.config.validatorParties.includes(attestor) &&
          !seenAttestors.has(attestor)
        ) {
          seenAttestors.add(attestor);
          uniqueCids.push(a.contractId);
        }
      }

      console.log(`[YieldSync] Found ${uniqueCids.length}/${minRequired} attestations for epoch ${epochNumber}`);

      if (uniqueCids.length >= minRequired) {
        console.log(`[YieldSync] ✅ Quorum reached with ${uniqueCids.length} attestations`);
        return uniqueCids;
      }

      await this.sleep(pollIntervalMs);
    }

    console.error(`[YieldSync] ❌ Timeout waiting for attestation quorum (epoch ${epochNumber})`);
    return [];
  }

  /**
   * Retrieve a pre-approved governance proof for CantonSMUSD ParameterUpdate.
   * Governance proofs are created through the MultiSigProposal flow (Proposal_Execute)
   * and must be approved by the required governor quorum before they can be used.
   */
  private async getGovernanceProof(targetModule: string): Promise<string | null> {
    const proofs = await (this.ledger.query as any)(
      "Governance:GovernanceActionLog",
      { operator: this.config.cantonParty, targetModule }
    );

    // Find a proof matching ParameterUpdate action type
    const validProof = proofs.find(
      (p: any) => p.payload.actionType === "ParameterUpdate"
    );

    if (validProof) {
      console.log(`[YieldSync] Found governance proof: ${validProof.payload.proposalId}`);
      return validProof.contractId;
    }

    console.warn(`[YieldSync] No governance proof found for ${targetModule} ParameterUpdate`);
    return null;
  }

  // ============================================================
  //                     HELPERS
  // ============================================================

  private toNumeric18(value: bigint): string {
    // Convert USDC (6 decimals) to Numeric 18 (18 decimals)
    const scale12 = BigInt("1000000000000");      // 10^12
    const scale18 = BigInt("1000000000000000000"); // 10^18
    const scaled = value * scale12;
    const intPart = scaled / scale18;
    const fracPart = scaled % scale18;
    return `${intPart}.${fracPart.toString().padStart(18, "0")}`;
  }

  private parseNumeric18(value: string): bigint {
    // Convert DAML Numeric 18 string to BigInt (in 6 decimal USDC units)
    const parts = value.split(".");
    const intPart = BigInt(parts[0] || "0");
    const fracPart = parts[1] || "0";
    // Take first 6 decimal places for USDC
    const fracUsdc = fracPart.padEnd(6, "0").substring(0, 6);
    const scale6 = BigInt("1000000");
    return intPart * scale6 + BigInt(fracUsdc);
  }

  private formatUsdc(value: bigint): string {
    const million = BigInt(1000000);
    const intPart = value / million;
    const fracPart = value % million;
    return `${intPart.toLocaleString()}.${fracPart.toString().padStart(6, "0").substring(0, 2)}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================
//                     MAIN
// ============================================================

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("     MINTED PROTOCOL - UNIFIED YIELD SYNC SERVICE");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("");
  console.log("  UNIFIED CROSS-CHAIN YIELD DISTRIBUTION");
  console.log("");
  console.log("  This service ensures equal yield for ALL stakers:");
  console.log("    1. Reads Canton shares → syncs to Ethereum SMUSD");
  console.log("    2. Calculates global share price from Treasury");
  console.log("    3. Syncs global share price → Canton");
  console.log("    4. Both chains have IDENTICAL share price!");
  console.log("");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("");

  // Validate config
  if (!DEFAULT_CONFIG.treasuryAddress) {
    throw new Error("TREASURY_ADDRESS environment variable required");
  }
  if (!DEFAULT_CONFIG.smusdAddress) {
    throw new Error("SMUSD_ADDRESS environment variable required");
  }
  if (!DEFAULT_CONFIG.cantonParty) {
    throw new Error("CANTON_PARTY environment variable required");
  }

  const service = new YieldSyncService(DEFAULT_CONFIG);

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n[YieldSync] Received SIGINT, shutting down...");
    service.stop();
  });
  process.on("SIGTERM", () => {
    console.log("\n[YieldSync] Received SIGTERM, shutting down...");
    service.stop();
  });

  await service.start();
}

main().catch(err => {
  console.error("[YieldSync] Fatal error:", err);
  process.exit(1);
});

export { YieldSyncService, YieldSyncConfig };
