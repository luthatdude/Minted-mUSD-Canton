// Minted mUSD Protocol - totalBorrows Reconciliation Keeper
// Automated periodic reconciliation to prevent totalBorrows drift
//
// BorrowModule.totalBorrows can drift from the actual sum of user debts due to
// rounding in interest accrual, repayment, and liquidation. This keeper:
//   1. Indexes all borrowers from Borrowed/Repaid/DebtAdjusted events
//   2. Calls BorrowModule.reconcileTotalBorrows() with the full borrower list
//   3. Runs on a configurable schedule (default: weekly)
//
// See BorrowModule.sol:reconcileTotalBorrows() for the on-chain implementation.

import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";

// TS-H-03: Import shared utilities instead of duplicating them.
// readSecret handles Docker /run/secrets/ with env var fallback.
// createSigner supports KMS in production, raw key in dev only.
// enforceTLSSecurity blocks NODE_TLS_REJECT_UNAUTHORIZED=0.
const RELAY_UTILS_PATH = path.resolve(__dirname, "../../relay/utils");
let readSecret: (name: string, envVar: string) => string;
let createSigner: (
  provider: ethers.JsonRpcProvider,
  secretName: string,
  envVar: string,
) => Promise<ethers.Signer>;
let enforceTLSSecurity: () => void;
try {
  const utils = require(RELAY_UTILS_PATH);
  readSecret = utils.readSecret;
  createSigner = utils.createSigner;
  enforceTLSSecurity = utils.enforceTLSSecurity;
} catch {
  // Fallback if relay/utils not available (standalone deployment)
  readSecret = (name: string, envVar: string): string => {
    const secretPath = `/run/secrets/${name}`;
    try {
      if (fs.existsSync(secretPath)) {
        return fs.readFileSync(secretPath, "utf-8").trim();
      }
    } catch { /* fall through */ }
    return process.env[envVar] || "";
  };
  // No KMS fallback — force raw key with production guard
  createSigner = async (provider, secretName, envVar) => {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SECURITY: Raw private key forbidden in production. Configure KMS_KEY_ID.");
    }
    const key = readSecret(secretName, envVar);
    if (!key) throw new Error(`FATAL: Neither KMS_KEY_ID nor ${envVar} configured`);
    return new ethers.Wallet(key, provider);
  };
  enforceTLSSecurity = () => {
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
      throw new Error("SECURITY: NODE_TLS_REJECT_UNAUTHORIZED=0 is forbidden");
    }
  };
}

// Enforce TLS at process level
enforceTLSSecurity();

// ============================================================
//                     CONFIGURATION
// ============================================================

interface ReconciliationConfig {
  rpcUrl: string;
  borrowModuleAddress: string;
  intervalMs: number; // How often to reconcile (default: 7 days)
  maxGasPrice: bigint; // Max gas price to avoid overpaying
  fromBlock: number;  // Block to start indexing events from
}

function loadConfig(): ReconciliationConfig {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error("FATAL: RPC_URL is required");

  const borrowModuleAddress = process.env.BORROW_MODULE_ADDRESS;
  if (!borrowModuleAddress) throw new Error("FATAL: BORROW_MODULE_ADDRESS is required");

  return {
    rpcUrl,
    borrowModuleAddress,
    intervalMs: parseInt(process.env.RECONCILIATION_INTERVAL_MS || String(7 * 24 * 60 * 60 * 1000)), // 7 days
    maxGasPrice: BigInt(process.env.MAX_GAS_PRICE_GWEI || "50") * 10n ** 9n,
    fromBlock: parseInt(process.env.RECONCILIATION_FROM_BLOCK || "0"),
  };
}

// ============================================================
//                     BORROW MODULE ABI (minimal)
// ============================================================

const BORROW_MODULE_ABI = [
  "function reconcileTotalBorrows(address[] calldata borrowers) external",
  "function totalBorrows() external view returns (uint256)",
  "function positions(address user) external view returns (uint256 principal, uint256 accruedInterest, uint256 lastAccrualTime)",
  "event Borrowed(address indexed user, uint256 amount, uint256 totalDebt)",
  "event Repaid(address indexed user, uint256 amount, uint256 remaining)",
  "event DebtAdjusted(address indexed user, uint256 newDebt, string reason)",
  "event TotalBorrowsReconciled(uint256 oldTotalBorrows, uint256 newTotalBorrows, int256 drift)",
];

// ============================================================
//                     KEEPER LOGIC
// ============================================================

class ReconciliationKeeper {
  private config: ReconciliationConfig;
  private provider: ethers.JsonRpcProvider;
  private signer!: ethers.Signer;
  private contract!: ethers.Contract;
  private knownBorrowers: Set<string> = new Set();
  private lastIndexedBlock: number;

  constructor(config: ReconciliationConfig) {
    this.config = config;
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.lastIndexedBlock = config.fromBlock;
  }

  /// TS-H-03: Initialize signer via shared createSigner (KMS in prod, raw key in dev)
  async init(): Promise<void> {
    this.signer = await createSigner(
      this.provider,
      "reconciliation_keeper_key",
      "RECONCILIATION_KEEPER_KEY",
    );
    this.contract = new ethers.Contract(
      this.config.borrowModuleAddress,
      BORROW_MODULE_ABI,
      this.signer,
    );
    const address = await this.signer.getAddress();
    console.log(`[Reconciliation] Signer address: ${address}`);
  }

  /// Index all borrowers from historical events
  async indexBorrowers(): Promise<void> {
    const currentBlock = await this.provider.getBlockNumber();
    const batchSize = 10000;

    console.log(`[Reconciliation] Indexing borrowers from block ${this.lastIndexedBlock} to ${currentBlock}`);

    for (let from = this.lastIndexedBlock; from <= currentBlock; from += batchSize) {
      const to = Math.min(from + batchSize - 1, currentBlock);

      // Query Borrowed events
      const borrowedFilter = this.contract.filters.Borrowed();
      const borrowedEvents = await this.contract.queryFilter(borrowedFilter, from, to);
      for (const event of borrowedEvents) {
        if ("args" in event && event.args) {
          this.knownBorrowers.add(event.args[0]); // user address
        }
      }

      // Query Repaid events
      const repaidFilter = this.contract.filters.Repaid();
      const repaidEvents = await this.contract.queryFilter(repaidFilter, from, to);
      for (const event of repaidEvents) {
        if ("args" in event && event.args) {
          this.knownBorrowers.add(event.args[0]);
        }
      }

      // Query DebtAdjusted events (liquidations)
      const debtAdjFilter = this.contract.filters.DebtAdjusted();
      const debtAdjEvents = await this.contract.queryFilter(debtAdjFilter, from, to);
      for (const event of debtAdjEvents) {
        if ("args" in event && event.args) {
          this.knownBorrowers.add(event.args[0]);
        }
      }
    }

    this.lastIndexedBlock = currentBlock + 1;
    console.log(`[Reconciliation] Found ${this.knownBorrowers.size} unique borrowers`);
  }

  /// Filter to only borrowers with active debt
  async filterActiveBorrowers(): Promise<string[]> {
    const active: string[] = [];

    for (const borrower of this.knownBorrowers) {
      try {
        const [principal, accruedInterest] = await this.contract.positions(borrower);
        if (principal > 0n || accruedInterest > 0n) {
          active.push(borrower);
        }
      } catch (err) {
        console.warn(`[Reconciliation] Failed to check position for ${borrower}:`, err);
      }
    }

    console.log(`[Reconciliation] ${active.length} borrowers with active debt`);
    return active;
  }

  /// Execute reconciliation
  async reconcile(): Promise<void> {
    console.log("[Reconciliation] Starting reconciliation cycle...");

    // Check gas price
    const feeData = await this.provider.getFeeData();
    const gasPrice = feeData.gasPrice || 0n;
    if (gasPrice > this.config.maxGasPrice) {
      console.log(`[Reconciliation] Gas price ${gasPrice} exceeds max ${this.config.maxGasPrice}, skipping`);
      return;
    }

    // Get current totalBorrows for reporting
    const currentTotal = await this.contract.totalBorrows();
    console.log(`[Reconciliation] Current totalBorrows: ${ethers.formatEther(currentTotal)} mUSD`);

    // Index new borrowers
    await this.indexBorrowers();

    // Filter to active borrowers only
    const activeBorrowers = await this.filterActiveBorrowers();

    if (activeBorrowers.length === 0) {
      console.log("[Reconciliation] No active borrowers, nothing to reconcile");
      return;
    }

    // Execute reconciliation
    try {
      console.log(`[Reconciliation] Calling reconcileTotalBorrows with ${activeBorrowers.length} borrowers...`);

      const tx = await this.contract.reconcileTotalBorrows(activeBorrowers);
      console.log(`[Reconciliation] Transaction sent: ${tx.hash}`);

      const receipt = await tx.wait();
      console.log(`[Reconciliation] Transaction confirmed in block ${receipt.blockNumber}`);

      // Parse TotalBorrowsReconciled event
      for (const log of receipt.logs) {
        try {
          const parsed = this.contract.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          if (parsed && parsed.name === "TotalBorrowsReconciled") {
            const [oldTotal, newTotal, drift] = parsed.args;
            console.log(`[Reconciliation] Reconciled:`);
            console.log(`  Old totalBorrows: ${ethers.formatEther(oldTotal)} mUSD`);
            console.log(`  New totalBorrows: ${ethers.formatEther(newTotal)} mUSD`);
            console.log(`  Drift corrected:  ${ethers.formatEther(drift)} mUSD`);
          }
        } catch {
          // Not our event
        }
      }
    } catch (err) {
      console.error("[Reconciliation] Transaction failed:", err);
    }
  }

  /// Run the keeper loop
  async run(): Promise<void> {
    console.log("[Reconciliation] Keeper starting...");
    console.log(`[Reconciliation] BorrowModule: ${this.config.borrowModuleAddress}`);
    console.log(`[Reconciliation] Interval: ${this.config.intervalMs / (1000 * 60 * 60)} hours`);

    // TS-H-03: Initialize signer via shared createSigner (supports KMS)
    await this.init();

    // Initial reconciliation
    await this.reconcile();

    // Schedule recurring reconciliation
    setInterval(async () => {
      try {
        await this.reconcile();
      } catch (err) {
        console.error("[Reconciliation] Cycle failed:", err);
      }
    }, this.config.intervalMs);
  }
}

// ============================================================
//                     MAIN
// ============================================================

async function main() {
  const config = loadConfig();
  const keeper = new ReconciliationKeeper(config);
  await keeper.run();
}

main().catch((err) => {
  console.error("[FATAL] Reconciliation keeper crashed:", err);
  process.exit(1);
});
