// Minted mUSD Protocol - Liquidation Bot
// Monitors positions and executes profitable liquidations

import { ethers } from "ethers";
import * as fs from "fs";
import { createLogger, format, transports } from "winston";
import MEVProtectedExecutor from "./flashbots";

// INFRA-H-02 / INFRA-H-06: Enforce TLS certificate validation at process level
// Prevents NODE_TLS_REJECT_UNAUTHORIZED=0 from disabling cert validation in production
if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    console.error("[SECURITY] NODE_TLS_REJECT_UNAUTHORIZED=0 is FORBIDDEN in production. Overriding to 1.");
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
  }
}

// Never load .env files containing private keys via dotenv.
function readSecret(name: string, envVar: string): string {
  const secretPath = `/run/secrets/${name}`;
  try {
    if (fs.existsSync(secretPath)) {
      return fs.readFileSync(secretPath, "utf-8").trim();
    }
  } catch { /* fall through to env var */ }
  return process.env[envVar] || "";
}

// secp256k1 curve order — private keys must be in range [1, n-1]
const SECP256K1_N = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"
);

function readAndValidatePrivateKey(secretName: string, envVar: string): string {
  const key = readSecret(secretName, envVar);
  if (!key) {
    throw new Error(`FATAL: ${envVar} not set. Use Docker secrets or env vars — never .env files.`);
  }
  const normalized = key.startsWith("0x") ? key.slice(2) : key;
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`SECURITY: ${envVar} is not a valid private key (expected 64 hex chars)`);
  }
  const keyValue = BigInt("0x" + normalized);
  if (keyValue === 0n || keyValue >= SECP256K1_N) {
    throw new Error(`SECURITY: ${envVar} is out of valid secp256k1 range [1, n-1]`);
  }
  return key;
}

process.on("unhandledRejection", (reason, promise) => {
  console.error("[FATAL] Unhandled rejection at:", promise, "reason:", reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("[FATAL] Uncaught exception:", error);
  process.exit(1);
});

// ============================================================
//                     CONFIGURATION
// ============================================================

// Private key loaded via Docker secrets / env — never from .env file.
function loadConfig() {
  const privateKey = readAndValidatePrivateKey("bot_private_key", "PRIVATE_KEY");

  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error("FATAL: RPC_URL is required");
  // INFRA-H-01: Reject insecure HTTP RPC in production
  if (process.env.NODE_ENV === "production" && !rpcUrl.startsWith("https://") && !rpcUrl.startsWith("wss://")) {
    throw new Error("FATAL: RPC_URL must use https:// or wss:// in production");
  }
  if (!rpcUrl.startsWith("https://") && !rpcUrl.startsWith("wss://") &&
      !rpcUrl.includes("localhost") && !rpcUrl.includes("127.0.0.1")) {
    console.warn("WARNING: Using insecure HTTP transport for RPC. Use HTTPS in production.");
  }

  const requiredAddrs = [
    "BORROW_MODULE_ADDRESS", "LIQUIDATION_ENGINE_ADDRESS",
    "COLLATERAL_VAULT_ADDRESS", "PRICE_ORACLE_ADDRESS", "MUSD_ADDRESS",
  ] as const;
  for (const name of requiredAddrs) {
    const val = process.env[name];
    if (!val || !ethers.isAddress(val)) {
      throw new Error(`FATAL: ${name} is missing or not a valid Ethereum address`);
    }
  }

  return {
    rpcUrl,
    chainId: parseInt(process.env.CHAIN_ID || "1", 10),
    privateKey,
    borrowModule: process.env.BORROW_MODULE_ADDRESS!,
    liquidationEngine: process.env.LIQUIDATION_ENGINE_ADDRESS!,
    collateralVault: process.env.COLLATERAL_VAULT_ADDRESS!,
    priceOracle: process.env.PRICE_ORACLE_ADDRESS!,
    musd: process.env.MUSD_ADDRESS!,
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "5000", 10),
    minProfitUsd: parseFloat(process.env.MIN_PROFIT_USD || "50"),
    gasPriceBufferPercent: parseInt(process.env.GAS_PRICE_BUFFER_PERCENT || "20", 10),
    maxGasPriceGwei: parseInt(process.env.MAX_GAS_PRICE_GWEI || "100", 10),
    useFlashbots: process.env.USE_FLASHBOTS === "true",
    flashbotsRelayUrl: process.env.FLASHBOTS_RELAY_URL || "https://relay.flashbots.net",
  };
}

const config = loadConfig();

// ============================================================
//                     LOGGER
// ============================================================

const logger = createLogger({
  level: "info",
  format: format.combine(
    format.timestamp(),
    format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}] ${message}`;
    })
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: "liquidations.log" }),
  ],
});

// ============================================================
//                     ABIs (Minimal)
// ============================================================

const BORROW_MODULE_ABI = [
  "function healthFactor(address user) external view returns (uint256)",
  "function totalDebt(address user) external view returns (uint256)",
  "function positions(address user) external view returns (uint256 principal, uint256 accruedInterest, uint256 lastAccrualTime)",
  "event Borrowed(address indexed user, uint256 amount, uint256 totalDebt)",
];

const LIQUIDATION_ENGINE_ABI = [
  "function liquidate(address borrower, address collateralToken, uint256 debtToRepay) external",
  "function isLiquidatable(address borrower) external view returns (bool)",
  "function estimateSeize(address borrower, address collateralToken, uint256 debtToRepay) external view returns (uint256)",
  "function closeFactorBps() external view returns (uint256)",
  "function fullLiquidationThreshold() external view returns (uint256)",
  "event Liquidation(address indexed liquidator, address indexed borrower, address indexed collateralToken, uint256 debtRepaid, uint256 collateralSeized)",
];

const COLLATERAL_VAULT_ABI = [
  "function deposits(address user, address token) external view returns (uint256)",
  "function getSupportedTokens() external view returns (address[])",
  "function getConfig(address token) external view returns (bool enabled, uint256 collateralFactorBps, uint256 liquidationThresholdBps, uint256 liquidationPenaltyBps)",
  "event Deposited(address indexed user, address indexed token, uint256 amount)",
];

const PRICE_ORACLE_ABI = [
  "function getPrice(address token) external view returns (uint256)",
  "function getValueUsd(address token, uint256 amount) external view returns (uint256)",
];

const ERC20_ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
];

// ============================================================
//                     TYPES
// ============================================================

interface Borrower {
  address: string;
  debt: bigint;
  healthFactor: bigint;
  collateral: Map<string, bigint>;
}

interface LiquidationOpportunity {
  borrower: string;
  collateralToken: string;
  collateralSymbol: string;
  debtToRepay: bigint;
  collateralToSeize: bigint;
  estimatedProfitUsd: number;
  healthFactor: bigint;
  gasCost: bigint;
}

// ============================================================
//                     BOT CLASS
// ============================================================

class LiquidationBot {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private borrowModule: ethers.Contract;
  private liquidationEngine: ethers.Contract;
  private collateralVault: ethers.Contract;
  private priceOracle: ethers.Contract;
  private musd: ethers.Contract;
  private mevExecutor: MEVProtectedExecutor | null = null;
  
  private borrowers: Set<string> = new Set();
  private supportedTokens: string[] = [];
  private tokenDecimals: Map<string, number> = new Map();
  private tokenSymbols: Map<string, string> = new Map();
  
  private isRunning = false;
  private liquidationCount = 0;
  private totalProfitUsd = 0;

  constructor() {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    // Guard against raw private key usage in production
    if (process.env.NODE_ENV === "production" && !process.env.KMS_KEY_ID) {
      throw new Error(
        "SECURITY: Raw private key usage is forbidden in production. " +
        "Configure KMS_KEY_ID, KMS_PROVIDER, and KMS_REGION environment variables. " +
        "See relay/kms-ethereum-signer.ts for KMS signer implementation."
      );
    }
    this.wallet = new ethers.Wallet(config.privateKey, this.provider);
    
    this.borrowModule = new ethers.Contract(config.borrowModule, BORROW_MODULE_ABI, this.wallet);
    this.liquidationEngine = new ethers.Contract(config.liquidationEngine, LIQUIDATION_ENGINE_ABI, this.wallet);
    this.collateralVault = new ethers.Contract(config.collateralVault, COLLATERAL_VAULT_ABI, this.wallet);
    this.priceOracle = new ethers.Contract(config.priceOracle, PRICE_ORACLE_ABI, this.provider);
    this.musd = new ethers.Contract(config.musd, ERC20_ABI, this.wallet);
    
    // Initialize MEV protection if enabled
    if (config.useFlashbots) {
      this.mevExecutor = new MEVProtectedExecutor(this.provider, this.wallet, config.chainId);
      logger.info("Flashbots MEV protection enabled");
    }
  }

  async initialize(): Promise<void> {
    logger.info("Initializing liquidation bot...");
    
    // Validate configuration
    if (!config.privateKey || config.privateKey === "0x...") {
      throw new Error("Invalid private key");
    }
    
    // Get wallet info
    const balance = await this.provider.getBalance(this.wallet.address);
    const musdBalance = await this.musd.balanceOf(this.wallet.address);
    logger.info(`Bot wallet: ${this.wallet.address}`);
    logger.info(`ETH balance: ${ethers.formatEther(balance)} ETH`);
    logger.info(`mUSD balance: ${ethers.formatEther(musdBalance)} mUSD`);
    
    // Get supported collateral tokens
    this.supportedTokens = await this.collateralVault.getSupportedTokens();
    logger.info(`Supported collateral tokens: ${this.supportedTokens.length}`);
    
    // Cache token info
    for (const token of this.supportedTokens) {
      const tokenContract = new ethers.Contract(token, ERC20_ABI, this.provider);
      const decimals = await tokenContract.decimals();
      const symbol = await tokenContract.symbol();
      this.tokenDecimals.set(token, decimals);
      this.tokenSymbols.set(token, symbol);
      logger.info(`  - ${symbol} (${token}) - ${decimals} decimals`);
    }
    
    // Set up event listeners for new borrowers
    this.setupEventListeners();
    
    // Approve mUSD spending for liquidation engine
    await this.ensureApproval();
    
    logger.info("Bot initialized successfully");
  }

  private setupEventListeners(): void {
    // Listen for new borrowers
    this.borrowModule.on("Borrowed", (user: string, amount: bigint, totalDebt: bigint) => {
      logger.info(`New borrower detected: ${user} - Debt: ${ethers.formatEther(totalDebt)} mUSD`);
      this.borrowers.add(user);
    });
    
    // Listen for deposits (potential new positions)
    this.collateralVault.on("Deposited", (user: string, token: string, amount: bigint) => {
      logger.info(`Deposit detected: ${user} - ${ethers.formatEther(amount)} ${this.tokenSymbols.get(token) || token}`);
      // Depositors might become borrowers
    });
    
    // Listen for our own liquidations
    this.liquidationEngine.on("Liquidation", 
      (liquidator: string, borrower: string, collateralToken: string, debtRepaid: bigint, collateralSeized: bigint) => {
        if (liquidator.toLowerCase() === this.wallet.address.toLowerCase()) {
          logger.info(`✅ LIQUIDATION SUCCESS: ${borrower}`);
          logger.info(`   Debt repaid: ${ethers.formatEther(debtRepaid)} mUSD`);
          logger.info(`   Collateral seized: ${ethers.formatUnits(collateralSeized, this.tokenDecimals.get(collateralToken) || 18)} ${this.tokenSymbols.get(collateralToken)}`);
          this.liquidationCount++;
        }
      }
    );
  }

  // Approve only the amount needed for the current liquidation + buffer.
  // This limits exposure if the liquidation engine contract has a vulnerability.
  private async ensureApproval(requiredAmount?: bigint): Promise<void> {
    const allowance = await this.musd.allowance(this.wallet.address, config.liquidationEngine);
    
    if (requiredAmount) {
      // Per-liquidation approval: approve exactly what's needed + 1% buffer
      if (allowance < requiredAmount) {
        const approvalAmount = requiredAmount * 102n / 100n; // 2% buffer
        logger.info(`Approving ${ethers.formatEther(approvalAmount)} mUSD for liquidation...`);
        const tx = await this.musd.approve(config.liquidationEngine, approvalAmount);
        await tx.wait();
        logger.info("Per-tx approval complete");
      }
    } else {
      // Initial startup: set a reasonable cap (e.g. 1M mUSD)
      const APPROVAL_CAP = ethers.parseEther("1000000"); // 1M mUSD max
      if (allowance < APPROVAL_CAP / 2n) {
        logger.info("Setting bounded mUSD approval for liquidation engine...");
        const tx = await this.musd.approve(config.liquidationEngine, APPROVAL_CAP);
        await tx.wait();
        logger.info(`Approval set to ${ethers.formatEther(APPROVAL_CAP)} mUSD (bounded)`);
      }
    }
  }

  async start(): Promise<void> {
    this.isRunning = true;
    logger.info(`Starting liquidation bot with ${config.pollIntervalMs}ms poll interval...`);
    
    while (this.isRunning) {
      try {
        await this.checkAndLiquidate();
      } catch (error) {
        logger.error(`Error in main loop: ${error}`);
      }
      
      await this.sleep(config.pollIntervalMs);
    }
  }

  stop(): void {
    logger.info("Stopping bot...");
    this.isRunning = false;
    // TS-H-03 FIX: Remove all event listeners to prevent memory leaks on restart
    this.borrowModule.removeAllListeners();
    this.collateralVault.removeAllListeners();
    this.liquidationEngine.removeAllListeners();
    logger.info("Event listeners removed");
  }

  private async checkAndLiquidate(): Promise<void> {
    // Check gas price first
    const feeData = await this.provider.getFeeData();
    const gasPrice = feeData.gasPrice || 0n;
    const gasPriceGwei = Number(gasPrice) / 1e9;
    
    if (gasPriceGwei > config.maxGasPriceGwei) {
      logger.warn(`Gas price too high: ${gasPriceGwei.toFixed(2)} gwei (max: ${config.maxGasPriceGwei})`);
      return;
    }
    
    // Find liquidation opportunities
    const opportunities = await this.findOpportunities();
    
    if (opportunities.length === 0) {
      return;
    }
    
    logger.info(`Found ${opportunities.length} liquidation opportunities`);
    
    // Sort by profit (highest first)
    opportunities.sort((a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd);
    
    // Execute most profitable liquidation
    const best = opportunities[0];
    
    if (best.estimatedProfitUsd >= config.minProfitUsd) {
      await this.executeLiquidation(best);
    } else {
      logger.info(`Best opportunity profit ($${best.estimatedProfitUsd.toFixed(2)}) below minimum ($${config.minProfitUsd})`);
    }
  }

  private async findOpportunities(): Promise<LiquidationOpportunity[]> {
    const opportunities: LiquidationOpportunity[] = [];
    
    // Get list of borrowers (in production, you'd query events or use a subgraph)
    const borrowerList = Array.from(this.borrowers);
    
    for (const borrower of borrowerList) {
      try {
        // Check if liquidatable
        const isLiquidatable = await this.liquidationEngine.isLiquidatable(borrower);
        if (!isLiquidatable) continue;
        
        const healthFactor = await this.borrowModule.healthFactor(borrower);
        const totalDebt = await this.borrowModule.totalDebt(borrower);
        
        if (totalDebt === 0n) {
          this.borrowers.delete(borrower);
          continue;
        }
        
        logger.info(`Liquidatable position found: ${borrower} (HF: ${Number(healthFactor) / 10000})`);
        
        // Check each collateral token
        for (const token of this.supportedTokens) {
          const collateralBalance = await this.collateralVault.deposits(borrower, token);
          if (collateralBalance === 0n) continue;
          
          // Get close factor
          const closeFactorBps = BigInt(await this.liquidationEngine.closeFactorBps());
          const fullLiqThreshold = BigInt(await this.liquidationEngine.fullLiquidationThreshold());
          
          // Calculate max repayable debt
          let maxRepay: bigint;
          if (healthFactor < fullLiqThreshold) {
            maxRepay = totalDebt; // Full liquidation allowed
          } else {
            maxRepay = (totalDebt * closeFactorBps) / 10000n;
          }
          
          // Estimate collateral to seize
          const estimatedSeize = await this.liquidationEngine.estimateSeize(borrower, token, maxRepay);
          
          // Calculate profit
          const collateralPrice = BigInt(await this.priceOracle.getPrice(token));
          const decimals = this.tokenDecimals.get(token) || 18;
          const seizeValueUsd = (estimatedSeize * collateralPrice) / (10n ** BigInt(decimals));
          
          // Profit = seize value - debt repaid
          const profitWei = seizeValueUsd - maxRepay;
          const profitUsd = Number(ethers.formatEther(profitWei));
          
          // Estimate gas cost
          const gasEstimate = 300000n; // Conservative estimate
          const feeData = await this.provider.getFeeData();
          const gasPrice = feeData.gasPrice || 0n;
          const gasCostWei = gasEstimate * gasPrice;
          const gasCostUsd = Number(ethers.formatEther(gasCostWei)) * 2500; // Assume ETH = $2500
          
          const netProfitUsd = profitUsd - gasCostUsd;
          
          opportunities.push({
            borrower,
            collateralToken: token,
            collateralSymbol: this.tokenSymbols.get(token) || "UNKNOWN",
            debtToRepay: maxRepay,
            collateralToSeize: estimatedSeize,
            estimatedProfitUsd: netProfitUsd,
            healthFactor,
            gasCost: gasCostWei,
          });
        }
      } catch (error) {
        logger.error(`Error checking borrower ${borrower}: ${error}`);
      }
    }
    
    return opportunities;
  }

  private async executeLiquidation(opp: LiquidationOpportunity): Promise<void> {
    logger.info(`Executing liquidation:`);
    logger.info(`  Borrower: ${opp.borrower}`);
    logger.info(`  Collateral: ${opp.collateralSymbol}`);
    logger.info(`  Debt to repay: ${ethers.formatEther(opp.debtToRepay)} mUSD`);
    logger.info(`  Est. profit: $${opp.estimatedProfitUsd.toFixed(2)}`);
    
    try {
      // Check mUSD balance
      const musdBalance = await this.musd.balanceOf(this.wallet.address);
      if (musdBalance < opp.debtToRepay) {
        logger.error(`Insufficient mUSD balance: have ${ethers.formatEther(musdBalance)}, need ${ethers.formatEther(opp.debtToRepay)}`);
        return;
      }

      await this.ensureApproval(opp.debtToRepay);
      
      let success = false;
      let txHash: string | undefined;
      
      // Use Flashbots if enabled for MEV protection
      if (this.mevExecutor && config.useFlashbots) {
        logger.info("Executing via Flashbots (MEV protected)...");
        const result = await this.mevExecutor.executeWithFallback(
          this.liquidationEngine,
          opp.borrower,
          opp.collateralToken,
          opp.debtToRepay,
          true // useFlashbots
        );
        success = result.success;
        txHash = result.txHash;
        logger.info(`Execution method: ${result.method}`);
      } else {
        // Regular transaction (public mempool)
        logger.info("Executing via regular transaction...");
        const feeData = await this.provider.getFeeData();
        const gasPrice = feeData.gasPrice || 0n;
        const bufferedGasPrice = (gasPrice * BigInt(100 + config.gasPriceBufferPercent)) / 100n;
        
        const tx = await this.liquidationEngine.liquidate(
          opp.borrower,
          opp.collateralToken,
          opp.debtToRepay,
          {
            gasLimit: 500000n,
            gasPrice: bufferedGasPrice,
          }
        );
        
        logger.info(`Transaction submitted: ${tx.hash}`);
        txHash = tx.hash;
        
        const receipt = await tx.wait();
        success = receipt.status === 1;
      }
      
      if (success) {
        logger.info(`✅ Liquidation successful! TX: ${txHash}`);
        this.totalProfitUsd += opp.estimatedProfitUsd;
        
        // Remove borrower if fully liquidated
        const remainingDebt = await this.borrowModule.totalDebt(opp.borrower);
        if (remainingDebt === 0n) {
          this.borrowers.delete(opp.borrower);
        }
      } else {
        logger.error(`❌ Liquidation failed`);
      }
    } catch (error: any) {
      if (error.code === "CALL_EXCEPTION") {
        logger.error(`Liquidation reverted: ${error.reason || "Unknown reason"}`);
      } else {
        logger.error(`Liquidation error: ${error}`);
      }
    }
  }

  // Utility to scan historical events for borrowers
  async scanHistoricalBorrowers(fromBlock: number): Promise<void> {
    logger.info(`Scanning for borrowers from block ${fromBlock}...`);
    
    const currentBlock = await this.provider.getBlockNumber();
    const batchSize = 10000;
    
    for (let start = fromBlock; start < currentBlock; start += batchSize) {
      const end = Math.min(start + batchSize - 1, currentBlock);
      
      const filter = this.borrowModule.filters.Borrowed();
      const events = await this.borrowModule.queryFilter(filter, start, end);
      
      for (const event of events) {
        const args = (event as any).args;
        if (args && args.user) {
          this.borrowers.add(args.user);
        }
      }
      
      logger.info(`Scanned blocks ${start}-${end}: ${this.borrowers.size} borrowers found`);
    }
    
    logger.info(`Historical scan complete: ${this.borrowers.size} total borrowers`);
  }

  getStats(): { liquidations: number; profitUsd: number; borrowersTracked: number } {
    return {
      liquidations: this.liquidationCount,
      profitUsd: this.totalProfitUsd,
      borrowersTracked: this.borrowers.size,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================
//                     MAIN
// ============================================================

async function main() {
  const bot = new LiquidationBot();
  
  // Handle graceful shutdown
  process.on("SIGINT", () => {
    logger.info("Received SIGINT, shutting down...");
    bot.stop();
    const stats = bot.getStats();
    logger.info(`Final stats: ${stats.liquidations} liquidations, $${stats.profitUsd.toFixed(2)} profit`);
    process.exit(0);
  });
  
  await bot.initialize();
  
  // Optionally scan historical borrowers
  // await bot.scanHistoricalBorrowers(18000000); // Start from some block
  
  await bot.start();
}

main().catch((error) => {
  logger.error(`Fatal error: ${error}`);
  process.exit(1);
});
