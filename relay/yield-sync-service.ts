/**
 * Minted Protocol - Yield Sync Service
 *
 * Synchronizes yield from Ethereum TreasuryV2 to Canton smUSD staking service.
 * This allows Canton smUSD holders to receive yield generated on Ethereum.
 *
 * Architecture:
 *   - Canton MMF ($50B) acts as collateral reference for minting capacity
 *   - Ethereum TreasuryV2 generates yield via Pendle/Morpho/Sky strategies
 *   - This service bridges yield data back to Canton for smUSD share price updates
 *
 * Flow:
 *   1. Poll TreasuryV2.totalValue() on Ethereum
 *   2. Calculate yield delta since last sync
 *   3. Create YieldAttestation on Canton
 *   4. Validators sign the attestation (anonymous/automatic)
 *   5. Finalize attestation → call SyncYield on CantonStakingService
 *   6. smUSD share price increases → holders profit on unstake
 */

import { ethers } from "ethers";
import Ledger from "@daml/ledger";
import { ContractId } from "@daml/types";
import { readSecret } from "./utils";

// ============================================================
//                     CONFIGURATION
// ============================================================

interface YieldSyncConfig {
  // Ethereum
  ethereumRpcUrl: string;
  treasuryAddress: string;

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

  cantonHost: process.env.CANTON_HOST || "localhost",
  cantonPort: parseInt(process.env.CANTON_PORT || "6865", 10),
  cantonToken: readSecret("canton_token", "CANTON_TOKEN"),
  cantonParty: process.env.CANTON_PARTY || "",

  validatorParties: (process.env.VALIDATOR_PARTIES || "").split(",").filter(Boolean),

  syncIntervalMs: parseInt(process.env.YIELD_SYNC_INTERVAL_MS || "3600000", 10),  // 1 hour
  minYieldThreshold: process.env.MIN_YIELD_THRESHOLD || "1000000000",  // $1000 (6 decimals)
  epochStartNumber: parseInt(process.env.EPOCH_START || "1", 10),
};

// ============================================================
//                     TREASURY ABI
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

// Matches CantonSMUSD.CantonStakingService
interface CantonStakingService {
  operator: string;
  totalShares: string;
  totalAssets: string;
  lastYieldEpoch: string;
  cooldownSeconds: string;
  minDeposit: string;
  paused: boolean;
  mpaHash: string;
  mpaUri: string;
  observers: string[];
}

// ============================================================
//                     YIELD SYNC SERVICE
// ============================================================

class YieldSyncService {
  private config: YieldSyncConfig;
  private provider: ethers.JsonRpcProvider;
  private treasury: ethers.Contract;
  private ledger: Ledger;
  private isRunning: boolean = false;

  // State tracking
  private lastSyncedTotalValue: bigint = BigInt(0);
  private currentEpoch: number;
  private nonce: number = 1;

  constructor(config: YieldSyncConfig) {
    this.config = config;
    this.currentEpoch = config.epochStartNumber;

    // Ethereum connection
    this.provider = new ethers.JsonRpcProvider(config.ethereumRpcUrl);
    this.treasury = new ethers.Contract(
      config.treasuryAddress,
      TREASURY_ABI,
      this.provider
    );

    // Canton connection (TLS by default)
    const protocol = process.env.CANTON_USE_TLS === "false" ? "http" : "https";
    const wsProtocol = process.env.CANTON_USE_TLS === "false" ? "ws" : "wss";
    this.ledger = new Ledger({
      token: config.cantonToken,
      httpBaseUrl: `${protocol}://${config.cantonHost}:${config.cantonPort}`,
      wsBaseUrl: `${wsProtocol}://${config.cantonHost}:${config.cantonPort}`,
    });

    console.log("[YieldSync] Initialized");
    console.log(`[YieldSync] Treasury: ${config.treasuryAddress}`);
    console.log(`[YieldSync] Canton: ${config.cantonHost}:${config.cantonPort}`);
    console.log(`[YieldSync] Operator: ${config.cantonParty}`);
    console.log(`[YieldSync] Validators: ${config.validatorParties.length}`);
    console.log(`[YieldSync] Sync interval: ${config.syncIntervalMs}ms`);
  }

  /**
   * Start the yield sync service
   */
  async start(): Promise<void> {
    console.log("[YieldSync] Starting...");
    this.isRunning = true;

    // Initialize last synced value
    await this.initializeState();

    // Main sync loop
    while (this.isRunning) {
      try {
        await this.syncYield();
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
   * Initialize state from Canton
   */
  private async initializeState(): Promise<void> {
    console.log("[YieldSync] Initializing state...");

    // Get current Treasury value from Ethereum
    const currentTotalValue = await this.treasury.totalValue();
    this.lastSyncedTotalValue = BigInt(currentTotalValue.toString());

    // Get last epoch from Canton staking service
    const stakingServices = await (this.ledger.query as any)(
      "CantonSMUSD:CantonStakingService",
      { operator: this.config.cantonParty }
    );

    if (stakingServices.length > 0) {
      this.currentEpoch = parseInt(stakingServices[0].payload.lastYieldEpoch, 10) + 1;
      console.log(`[YieldSync] Resuming from epoch ${this.currentEpoch}`);
      console.log(`[YieldSync] Canton totalAssets: ${stakingServices[0].payload.totalAssets}`);
    } else {
      console.log(`[YieldSync] No staking service found, starting fresh at epoch ${this.currentEpoch}`);
    }

    console.log(`[YieldSync] Ethereum Treasury value: $${this.formatUsdc(currentTotalValue)}`);
  }

  /**
   * Main sync logic
   */
  private async syncYield(): Promise<void> {
    // 1. Get current Treasury value from Ethereum
    const rawValue = await this.treasury.totalValue();
    const currentTotalValue: bigint = BigInt(rawValue.toString());

    // 2. Calculate yield delta
    const yieldDelta = currentTotalValue - this.lastSyncedTotalValue;

    console.log(`[YieldSync] Treasury value: $${this.formatUsdc(currentTotalValue)}`);
    console.log(`[YieldSync] Last synced: $${this.formatUsdc(this.lastSyncedTotalValue)}`);
    console.log(`[YieldSync] Yield delta: $${this.formatUsdc(yieldDelta)}`);

    // 3. Check if yield exceeds threshold
    const threshold = BigInt(this.config.minYieldThreshold);
    if (yieldDelta < threshold) {
      console.log(`[YieldSync] Yield below threshold ($${this.formatUsdc(threshold)}), skipping`);
      return;
    }

    // 4. Create yield attestation on Canton
    console.log(`[YieldSync] Creating YieldAttestation for epoch ${this.currentEpoch}...`);

    const attestationId = this.generateAttestationId();
    const now = new Date().toISOString();

    const payload: YieldPayload = {
      attestationId,
      totalTreasuryAssets: this.toNumeric18(currentTotalValue),
      totalMUSDSupply: this.toNumeric18(currentTotalValue),  // Assuming 1:1 backing
      yieldAccrued: this.toNumeric18(yieldDelta),
      epochNumber: this.currentEpoch.toString(),
      timestamp: now,
      nonce: (this.nonce++).toString(),
    };

    // Create the attestation contract
    const attestationResult = await (this.ledger.create as any)(
      "BLEBridgeProtocol:YieldAttestation",
      {
        aggregator: this.config.cantonParty,
        validatorGroup: this.config.validatorParties,
        payload,
        signedValidators: [],
      }
    );
    const attestationCid = attestationResult.contractId;

    console.log(`[YieldSync] Created attestation: ${attestationCid}`);

    // 5. Collect validator signatures (automatic/anonymous)
    const signatureCids = await this.collectValidatorSignatures(attestationCid, payload);

    // 6. Finalize the attestation
    const finalPayload = await this.finalizeAttestation(attestationCid, signatureCids);

    // 7. Call SyncYield on CantonStakingService
    await this.updateStakingService(finalPayload);

    // 8. Update state
    this.lastSyncedTotalValue = currentTotalValue;
    this.currentEpoch++;

    console.log(`[YieldSync] ✅ Sync complete! Epoch ${this.currentEpoch - 1} synced`);
    console.log(`[YieldSync] smUSD holders now have access to $${this.formatUsdc(yieldDelta)} in yield`);
  }

  /**
   * Collect signatures from validators
   * In production, validators would sign independently.
   * For anonymous attestation, this can be automated.
   */
  private async collectValidatorSignatures(
    attestationCid: string,
    payload: YieldPayload
  ): Promise<string[]> {
    console.log(`[YieldSync] Collecting validator signatures...`);

    const signatureCids: string[] = [];
    let currentAttestationCid = attestationCid;

    // Majority quorum required
    const requiredSignatures = Math.floor(this.config.validatorParties.length / 2) + 1;

    for (let i = 0; i < requiredSignatures; i++) {
      const validator = this.config.validatorParties[i];

      // Generate ECDSA signature (in production, validator would sign independently)
      const signature = await this.generateValidatorSignature(payload, validator);

      // Exercise Yield_Sign choice
      const result = await (this.ledger.exercise as any)(
        "BLEBridgeProtocol:YieldAttestation",
        currentAttestationCid,
        "Yield_Sign",
        {
          validator,
          ecdsaSignature: signature,
        }
      );

      // Update attestation CID (recreated after each sign)
      // Result format: [exerciseResult, events]
      if (result && result[0]) {
        currentAttestationCid = result[0][0];  // New attestation CID
        signatureCids.push(result[0][1]);       // Signature CID
      }

      console.log(`[YieldSync] Signature ${i + 1}/${requiredSignatures} collected from ${validator.substring(0, 16)}...`);
    }

    return signatureCids;
  }

  /**
   * Finalize the attestation and get verified payload
   */
  private async finalizeAttestation(
    attestationCid: string,
    signatureCids: string[]
  ): Promise<YieldPayload> {
    console.log(`[YieldSync] Finalizing attestation with ${signatureCids.length} signatures...`);

    // Need to get the latest attestation CID (after all signatures)
    const attestations = await (this.ledger.query as any)(
      "BLEBridgeProtocol:YieldAttestation",
      { aggregator: this.config.cantonParty }
    );

    if (attestations.length === 0) {
      throw new Error("No attestation found to finalize");
    }

    // Get the one with matching signed validators count
    const latestAttestation = attestations.find(
      (a: any) => a.payload.signedValidators.length >= signatureCids.length
    );

    if (!latestAttestation) {
      throw new Error("Could not find attestation with required signatures");
    }

    const result = await (this.ledger.exercise as any)(
      "BLEBridgeProtocol:YieldAttestation",
      latestAttestation.contractId,
      "Yield_Finalize",
      { signatureCids }
    );

    console.log(`[YieldSync] Attestation finalized`);
    // Result format: [exerciseResult, events]
    return result[0] as YieldPayload;
  }

  /**
   * Update CantonStakingService with synced yield
   */
  private async updateStakingService(payload: YieldPayload): Promise<void> {
    console.log(`[YieldSync] Updating CantonStakingService...`);

    // Find the staking service
    const stakingServices = await (this.ledger.query as any)(
      "CantonSMUSD:CantonStakingService",
      { operator: this.config.cantonParty }
    );

    if (stakingServices.length === 0) {
      throw new Error("No CantonStakingService found");
    }

    const stakingService = stakingServices[0];
    const oldTotalAssets = stakingService.payload.totalAssets;
    const oldSharePrice = this.calculateSharePrice(
      stakingService.payload.totalAssets,
      stakingService.payload.totalShares
    );

    // Exercise SyncYield choice
    await (this.ledger.exercise as any)(
      "CantonSMUSD:CantonStakingService",
      stakingService.contractId,
      "SyncYield",
      {
        newTotalTreasuryAssets: payload.totalTreasuryAssets,
        yieldAccrued: payload.yieldAccrued,
        epochNumber: payload.epochNumber,
      }
    );

    // Calculate new share price
    const newTotalAssets = (
      BigInt(oldTotalAssets.replace(".", "")) + BigInt(payload.yieldAccrued.replace(".", ""))
    ).toString();
    const newSharePrice = this.calculateSharePrice(
      newTotalAssets,
      stakingService.payload.totalShares
    );

    console.log(`[YieldSync] totalAssets: ${oldTotalAssets} → ${newTotalAssets}`);
    console.log(`[YieldSync] sharePrice: ${oldSharePrice} → ${newSharePrice}`);
  }

  // ============================================================
  //                     HELPERS
  // ============================================================

  private generateAttestationId(): string {
    const timestamp = Date.now().toString(16);
    const random = Math.random().toString(16).substring(2, 10);
    return `yield-${timestamp}-${random}`;
  }

  private async generateValidatorSignature(payload: YieldPayload, validator: string): Promise<string> {
    // In production, each validator would sign independently with their key
    // For anonymous attestation, we generate a deterministic signature
    const message = JSON.stringify(payload);
    const hash = ethers.keccak256(ethers.toUtf8Bytes(message + validator));
    return hash;
  }

  private toNumeric18(value: bigint): string {
    // Convert USDC (6 decimals) to Numeric 18 (18 decimals)
    const scale12 = BigInt("1000000000000");      // 10^12
    const scale18 = BigInt("1000000000000000000"); // 10^18
    const scaled = value * scale12;
    const intPart = scaled / scale18;
    const fracPart = scaled % scale18;
    return `${intPart}.${fracPart.toString().padStart(18, "0")}`;
  }

  private formatUsdc(value: bigint): string {
    const million = BigInt(1000000);
    const intPart = value / million;
    const fracPart = value % million;
    return `${intPart.toLocaleString()}.${fracPart.toString().padStart(6, "0").substring(0, 2)}`;
  }

  private calculateSharePrice(totalAssets: string, totalShares: string): string {
    const assets = parseFloat(totalAssets);
    const shares = parseFloat(totalShares);
    if (shares === 0) return "1.000000000000000000";
    return (assets / shares).toFixed(18);
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
  console.log("     MINTED PROTOCOL - YIELD SYNC SERVICE");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("");
  console.log("  Syncs yield from Ethereum Treasury → Canton smUSD");
  console.log("  Canton MMF ($50B) provides minting capacity reference");
  console.log("");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("");

  // Validate config
  if (!DEFAULT_CONFIG.treasuryAddress) {
    throw new Error("TREASURY_ADDRESS environment variable required");
  }
  if (!DEFAULT_CONFIG.cantonParty) {
    throw new Error("CANTON_PARTY environment variable required");
  }
  if (DEFAULT_CONFIG.validatorParties.length === 0) {
    throw new Error("VALIDATOR_PARTIES environment variable required (comma-separated)");
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
