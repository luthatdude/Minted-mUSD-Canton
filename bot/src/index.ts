// Minted mUSD Protocol - Liquidation Bot
// Monitors positions and executes profitable liquidations

import { ethers } from "ethers";
import * as dotenv from "dotenv";
import { createLogger, format, transports } from "winston";
import MEVProtectedExecutor from "./flashbots";

dotenv.config();

// ============================================================
//                     CONFIGURATION
// ============================================================

const config = {
  rpcUrl: process.env.RPC_URL!,
  chainId: parseInt(process.env.CHAIN_ID || "1"),
  privateKey: process.env.PRIVATE_KEY!,
  
  // Contract addresses
  borrowModule: process.env.BORROW_MODULE_ADDRESS!,
  liquidationEngine: process.env.LIQUIDATION_ENGINE_ADDRESS!,
  collateralVault: process.env.COLLATERAL_VAULT_ADDRESS!,
  priceOracle: process.env.PRICE_ORACLE_ADDRESS!,
  musd: process.env.MUSD_ADDRESS!,
  
  // Bot settings
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "5000"),
  minProfitUsd: parseFloat(process.env.MIN_PROFIT_USD || "50"),
  gasPriceBufferPercent: parseInt(process.env.GAS_PRICE_BUFFER_PERCENT || "20"),
  maxGasPriceGwei: parseInt(process.env.MAX_GAS_PRICE_GWEI || "100"),
  
  // Flashbots
  useFlashbots: process.env.USE_FLASHBOTS === "true",
  flashbotsRelayUrl: process.env.FLASHBOTS_RELAY_URL || "https://relay.flashbots.net",
};

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

  private async ensureApproval(): Promise<void> {
    const allowance = await this.musd.allowance(this.wallet.address, config.liquidationEngine);
    const maxApproval = ethers.MaxUint256;
    
    if (allowance < maxApproval / 2n) {
      logger.info("Approving mUSD for liquidation engine...");
      const tx = await this.musd.approve(config.liquidationEngine, maxApproval);
      await tx.wait();
      logger.info("Approval complete");
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
