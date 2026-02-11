/**
 * Minted Protocol - Yield Keeper Service
 *
 * Monitors Treasury for idle USDC and triggers auto-deployment to yield strategies.
 *
 * Flow:
 *   1. Poll Treasury.shouldAutoDeploy() periodically
 *   2. When deployable amount > threshold, call keeperTriggerAutoDeploy()
 *   3. Log deployments and emit metrics
 *
 * Can run as a standalone service or integrated into the relay service.
 */

import { ethers } from "ethers";
import { readSecret } from "./utils";

// ============================================================
//                     CONFIGURATION
// ============================================================

interface KeeperConfig {
  ethereumRpcUrl: string;
  treasuryAddress: string;
  keeperPrivateKey: string;  // Must have KEEPER_ROLE on Treasury
  pollIntervalMs: number;
  maxGasPriceGwei: number;   // Skip if gas too high
  minProfitUsd: number;      // Minimum expected yield to justify gas
}

const DEFAULT_CONFIG: KeeperConfig = {
  ethereumRpcUrl: process.env.ETHEREUM_RPC_URL || "http://localhost:8545",
  treasuryAddress: process.env.TREASURY_ADDRESS || "",
  keeperPrivateKey: readSecret("keeper_private_key", "KEEPER_PRIVATE_KEY"),
  pollIntervalMs: parseInt(process.env.KEEPER_POLL_MS || "60000", 10),  // 1 minute
  maxGasPriceGwei: parseInt(process.env.MAX_GAS_PRICE_GWEI || "50", 10),
  minProfitUsd: parseFloat(process.env.MIN_PROFIT_USD || "10"),
};

// FIX BE-H05: Validate Treasury address at startup
if (DEFAULT_CONFIG.treasuryAddress && !ethers.isAddress(DEFAULT_CONFIG.treasuryAddress)) {
  throw new Error(`Invalid TREASURY_ADDRESS: ${DEFAULT_CONFIG.treasuryAddress}`);
}

// ============================================================
//                     TREASURY ABI
// ============================================================

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
  },
  {
    "inputs": [],
    "name": "autoDeployEnabled",
    "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "autoDeployThreshold",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "defaultStrategy",
    "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "deployableAmount",
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
  }
];

// ============================================================
//                     YIELD KEEPER
// ============================================================

class YieldKeeper {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private treasury: ethers.Contract;
  private config: KeeperConfig;
  private running: boolean = false;

  constructor(config: KeeperConfig) {
    this.config = config;
    this.provider = new ethers.JsonRpcProvider(config.ethereumRpcUrl);
    this.wallet = new ethers.Wallet(config.keeperPrivateKey, this.provider);
    this.treasury = new ethers.Contract(
      config.treasuryAddress,
      TREASURY_ABI,
      this.wallet
    );
  }

  /**
   * Start the keeper loop
   */
  async start(): Promise<void> {
    console.log("🚀 Yield Keeper starting...");
    console.log(`   Treasury: ${this.config.treasuryAddress}`);
    console.log(`   Keeper wallet: ${this.wallet.address}`);
    console.log(`   Poll interval: ${this.config.pollIntervalMs}ms`);

    // Verify connection and configuration
    await this.verifySetup();

    this.running = true;

    while (this.running) {
      try {
        await this.checkAndDeploy();
      } catch (err) {
        console.error("❌ Keeper cycle error:", err);
      }

      await this.sleep(this.config.pollIntervalMs);
    }
  }

  /**
   * Stop the keeper
   */
  stop(): void {
    console.log("🛑 Yield Keeper stopping...");
    this.running = false;
  }

  /**
   * Verify setup is correct
   */
  private async verifySetup(): Promise<void> {
    // Check Treasury is accessible
    const enabled = await this.treasury.autoDeployEnabled();
    const threshold = await this.treasury.autoDeployThreshold();
    const strategy = await this.treasury.defaultStrategy();

    console.log(`   Auto-deploy enabled: ${enabled}`);
    console.log(`   Threshold: $${this.formatUsdc(threshold)}`);
    console.log(`   Default strategy: ${strategy}`);

    if (!enabled) {
      console.warn("⚠️  Auto-deploy is DISABLED on Treasury");
    }

    if (strategy === ethers.ZeroAddress) {
      console.warn("⚠️  No default strategy configured");
    }
  }

  /**
   * Main keeper logic: check if deploy needed and execute
   */
  private async checkAndDeploy(): Promise<void> {
    // 1. Check if auto-deploy would trigger
    const [shouldDeploy, deployable] = await this.treasury.shouldAutoDeploy();

    if (!shouldDeploy) {
      console.log(`📊 No deploy needed. Deployable: $${this.formatUsdc(deployable)}`);
      return;
    }

    console.log(`💰 Deploy opportunity: $${this.formatUsdc(deployable)} deployable`);

    // 2. Check gas price
    const feeData = await this.provider.getFeeData();
    const gasPrice = feeData.gasPrice || 0n;
    const gasPriceGwei = Number(gasPrice) / 1e9;

    if (gasPriceGwei > this.config.maxGasPriceGwei) {
      console.log(`⛽ Gas too high (${gasPriceGwei.toFixed(1)} gwei > ${this.config.maxGasPriceGwei}), skipping`);
      return;
    }

    // 3. Estimate gas and check profitability
    try {
      const gasEstimate = await this.treasury.keeperTriggerAutoDeploy.estimateGas();
      const gasCostWei = gasEstimate * gasPrice;
      const gasCostEth = Number(gasCostWei) / 1e18;

      // FIX: Use env-driven ETH price instead of hardcoded constant
      const ethPriceUsd = parseFloat(process.env.ETH_PRICE_USD || "2000");
      const gasCostUsd = gasCostEth * ethPriceUsd;

      // Estimate daily yield on deployed amount (assume 10% APY)
      const deployableUsd = Number(deployable) / 1e6;
      const dailyYieldUsd = (deployableUsd * 0.10) / 365;

      console.log(`   Gas cost: $${gasCostUsd.toFixed(2)} | Daily yield: $${dailyYieldUsd.toFixed(2)}`);

      if (dailyYieldUsd < this.config.minProfitUsd) {
        console.log(`⚖️  Yield below minimum ($${this.config.minProfitUsd}), skipping`);
        return;
      }

      // 4. Execute deployment
      console.log("🔄 Triggering auto-deploy...");

      const tx = await this.treasury.keeperTriggerAutoDeploy({
        gasLimit: gasEstimate * 12n / 10n,  // 20% buffer
      });

      console.log(`   TX submitted: ${tx.hash}`);

      const receipt = await tx.wait(2);  // Wait for 2 confirmations

      if (receipt?.status === 1) {
        console.log(`✅ Deployed $${this.formatUsdc(deployable)} to strategy`);
        this.logMetrics("deploy_success", deployable);
      } else {
        console.error("❌ TX reverted");
        this.logMetrics("deploy_failed", 0n);
      }

    } catch (err) {
      console.error("❌ Deploy failed:", err);
      this.logMetrics("deploy_error", 0n);
    }
  }

  /**
   * Format USDC amount for display (6 decimals → human readable)
   */
  private formatUsdc(amount: bigint): string {
    return (Number(amount) / 1e6).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  /**
   * Log metrics (placeholder for Prometheus/DataDog integration)
   */
  private logMetrics(event: string, amount: bigint): void {
    const metrics = {
      timestamp: new Date().toISOString(),
      event,
      amountUsdc: Number(amount) / 1e6,
      keeper: this.wallet.address,
    };
    console.log("📈 METRICS:", JSON.stringify(metrics));
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================
//                     STATUS API
// ============================================================

/**
 * Get current Treasury/Keeper status (for monitoring dashboards)
 */
export async function getKeeperStatus(config: KeeperConfig): Promise<{
  autoDeployEnabled: boolean;
  defaultStrategy: string;
  threshold: string;
  deployable: string;
  availableReserves: string;
  deployedToStrategies: string;
  shouldDeploy: boolean;
}> {
  const provider = new ethers.JsonRpcProvider(config.ethereumRpcUrl);
  const treasury = new ethers.Contract(config.treasuryAddress, TREASURY_ABI, provider);

  const [enabled, strategy, threshold, deployable, reserves, deployed, [shouldDeploy]] = await Promise.all([
    treasury.autoDeployEnabled(),
    treasury.defaultStrategy(),
    treasury.autoDeployThreshold(),
    treasury.deployableAmount(),
    treasury.availableReserves(),
    treasury.deployedToStrategies(),
    treasury.shouldAutoDeploy(),
  ]);

  return {
    autoDeployEnabled: enabled,
    defaultStrategy: strategy,
    threshold: (Number(threshold) / 1e6).toFixed(2),
    deployable: (Number(deployable) / 1e6).toFixed(2),
    availableReserves: (Number(reserves) / 1e6).toFixed(2),
    deployedToStrategies: (Number(deployed) / 1e6).toFixed(2),
    shouldDeploy,
  };
}

// ============================================================
//                     MAIN
// ============================================================

async function main(): Promise<void> {
  // Validate config
  if (!DEFAULT_CONFIG.treasuryAddress) {
    console.error("❌ TREASURY_ADDRESS not set");
    process.exit(1);
  }

  if (!DEFAULT_CONFIG.keeperPrivateKey) {
    console.error("❌ KEEPER_PRIVATE_KEY not set");
    process.exit(1);
  }

  const keeper = new YieldKeeper(DEFAULT_CONFIG);

  // Graceful shutdown
  process.on("SIGINT", () => keeper.stop());
  process.on("SIGTERM", () => keeper.stop());

  await keeper.start();
}

// Run if executed directly
main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

export { YieldKeeper, DEFAULT_CONFIG };
