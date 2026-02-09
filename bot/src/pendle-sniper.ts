// ═══════════════════════════════════════════════════════════════════════════
// Pendle PT Pool Sniper Bot
// ═══════════════════════════════════════════════════════════════════════════
// Monitors Pendle MarketFactory for new sUSDe PT pool creation and
// auto-deposits USDC → PT the moment the pool goes live.
//
// Why: First depositor gets the highest PT discount = highest fixed APY.
// As capital flows in, the implied rate compresses. Being block-1 locks
// in the best rate for the mUSD treasury.
//
// Architecture:
//   1. Listen for CreateNewMarket events on ALL Pendle MarketFactory versions
//   2. Filter: does the new market's SY match our target (sUSDe/USDe/etc)?
//   3. If match → build swapExactTokenForPt tx → send via Flashbots bundle
//   4. Telegram alert on execution
// ═══════════════════════════════════════════════════════════════════════════

import { ethers, Wallet, Contract, EventLog } from "ethers";
import * as dotenv from "dotenv";
import { createLogger, format, transports } from "winston";
import MEVProtectedExecutor, { FlashbotsProvider, PrivateTxSender } from "./flashbots";

dotenv.config();

// ═══════════════════════════════════════════════════════════════════════════
//                          LOGGER
// ═══════════════════════════════════════════════════════════════════════════

const logger = createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: format.combine(
    format.timestamp(),
    format.printf(({ timestamp, level, message }) =>
      `${timestamp} [${level.toUpperCase()}] [SNIPER] ${message}`
    )
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: "pendle-sniper.log" }),
  ],
});

// ═══════════════════════════════════════════════════════════════════════════
//                     PENDLE MAINNET ADDRESSES
// ═══════════════════════════════════════════════════════════════════════════

// All MarketFactory versions on Ethereum Mainnet
// Source: https://github.com/pendle-finance/pendle-core-v2-public deployments/1-core.json
const MARKET_FACTORIES: Record<string, string> = {
  V3: "0x1A6fCc85557BC4fB7B534ed835a03EF056552D52",
  V4: "0x3d75Bd20C983edb5fD218A1b7e0024F1056c7A2F",
  V5: "0x6fcf753f2C67b83f7B09746Bbc4FA0047b35D050",
  V6: "0x6d247b1c044fA1E22e6B04fA9F71Baf99EB29A9f",
};

// Pendle Router V4 (same on all chains)
const PENDLE_ROUTER = "0x888888888889758F76e7103c6CbF23ABbF58F946";

// Yield Contract Factories (for PT verification)
const YIELD_CONTRACT_FACTORIES = [
  "0x70ee0A6DB4F5a2Dc4d9c0b57bE97B9987e75BAFD", // V1
  "0xdF3601014686674e53d1Fa52F7602525483F9122", // V3
  "0x273b4bFA3Bb30fe8F32c467b5f0046834557F072", // V4
  "0x35A338522a435D46f77Be32C70E215B813D0e3aC", // V5
  "0x3E6EBa46AbC5ab18ED95F6667d8B2fd4020E4637", // V6
];

// ═══════════════════════════════════════════════════════════════════════════
//                     TARGET ASSETS (what we snipe)
// ═══════════════════════════════════════════════════════════════════════════

// SY wrappers & underlying tokens we want to snipe new pools for
const TARGET_TOKENS: Record<string, { name: string; underlying: string; syAddresses: string[] }> = {
  sUSDe: {
    name: "Ethena Staked USDe",
    underlying: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", // sUSDe
    syAddresses: [
      "0xCAb15f4F23Ab5F82e35BB82b5caBDd5B846eFa09", // SY-sUSDe (known)
    ],
  },
  USDe: {
    name: "Ethena USDe",
    underlying: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3", // USDe
    syAddresses: [],
  },
  reUSDe: {
    name: "Resolv reUSDe",
    underlying: "0x", // placeholder — update with actual
    syAddresses: [],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//                          ABIs
// ═══════════════════════════════════════════════════════════════════════════

const MARKET_FACTORY_ABI = [
  "event CreateNewMarket(address indexed market, address indexed PT, int256 scalarRoot, int256 initialAnchor, uint256 lnFeeRateRoot)",
  "function isValidMarket(address market) external view returns (bool)",
];

const PT_ABI = [
  "function SY() external view returns (address)",
  "function YT() external view returns (address)",
  "function isExpired() external view returns (bool)",
  "function expiry() external view returns (uint256)",
  "function name() external view returns (string)",
  "function symbol() external view returns (string)",
];

const SY_ABI = [
  "function yieldToken() external view returns (address)",
  "function getTokensIn() external view returns (address[])",
  "function getTokensOut() external view returns (address[])",
  "function exchangeRate() external view returns (uint256)",
  "function name() external view returns (string)",
];

const MARKET_ABI = [
  "function readTokens() external view returns (address sy, address pt, address yt)",
  "function expiry() external view returns (uint256)",
  "function isExpired() external view returns (bool)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
];

// Full Pendle Router ABI for swapExactTokenForPt
const PENDLE_ROUTER_ABI = [
  `function swapExactTokenForPt(
    address receiver,
    address market,
    uint256 minPtOut,
    tuple(uint256 guessMin, uint256 guessMax, uint256 guessOffchain, uint256 maxIteration, uint256 eps) guessPtOut,
    tuple(address tokenIn, uint256 netTokenIn, address tokenMintSy, address pendleSwap, tuple(uint8 swapType, address extRouter, bytes extCalldata, bool needScale) swapData) input,
    tuple(address limitRouter, uint256 epsSkipMarket, tuple(tuple(uint256 salt, uint256 expiry, uint256 nonce, uint8 orderType, address token, address YT, address maker, address receiver, uint256 makingAmount, uint256 lnImpliedRate, uint256 failSafeRate, bytes permit) order, bytes signature, uint256 makingAmount)[] normalFills, tuple(tuple(uint256 salt, uint256 expiry, uint256 nonce, uint8 orderType, address token, address YT, address maker, address receiver, uint256 makingAmount, uint256 lnImpliedRate, uint256 failSafeRate, bytes permit) order, bytes signature, uint256 makingAmount)[] flashFills, bytes optData) limit
  ) external payable returns (uint256 netPtOut, uint256 netSyFee, uint256 netSyInterm)`,
];

// ═══════════════════════════════════════════════════════════════════════════
//                       CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

interface SniperConfig {
  rpcUrl: string;
  wsRpcUrl: string;
  chainId: number;
  privateKey: string;

  // Deposit settings
  depositToken: string;           // USDC address
  depositAmountRaw: bigint;       // Amount in token's smallest unit (e.g., 1_000_000 = 1 USDC)
  slippageBps: number;            // Slippage tolerance (e.g., 100 = 1%)
  maxGasPriceGwei: number;        // Max gas price to execute at

  // Execution mode
  useFlashbots: boolean;          // Use Flashbots for MEV protection
  usePrivateRpc: boolean;         // Use Flashbots Protect RPC
  priorityFeeGwei: number;       // Priority fee for Flashbots

  // Filtering
  targetAssets: string[];         // Keys from TARGET_TOKENS to watch
  minExpiryDays: number;          // Min days to maturity (skip short-dated)
  maxExpiryDays: number;          // Max days to maturity

  // Telegram alerts
  telegramEnabled: boolean;
  telegramBotToken: string;
  telegramChatId: string;

  // Treasury route (optional — deposit through PendleStrategyV2 instead of direct)
  useTreasuryRoute: boolean;
  treasuryAddress: string;
  pendleStrategyAddress: string;
}

function loadConfig(): SniperConfig {
  return {
    rpcUrl: process.env.RPC_URL || "https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
    wsRpcUrl: process.env.WS_RPC_URL || "wss://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
    chainId: parseInt(process.env.CHAIN_ID || "1"),
    privateKey: process.env.PRIVATE_KEY!,

    depositToken: process.env.SNIPER_DEPOSIT_TOKEN || "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
    depositAmountRaw: BigInt(process.env.SNIPER_DEPOSIT_AMOUNT || "1000000000"), // 1000 USDC default
    slippageBps: parseInt(process.env.SNIPER_SLIPPAGE_BPS || "100"), // 1%
    maxGasPriceGwei: parseInt(process.env.SNIPER_MAX_GAS_GWEI || "150"),

    useFlashbots: process.env.SNIPER_USE_FLASHBOTS === "true",
    usePrivateRpc: process.env.SNIPER_USE_PRIVATE_RPC !== "false", // default ON
    priorityFeeGwei: parseInt(process.env.SNIPER_PRIORITY_FEE_GWEI || "5"),

    targetAssets: (process.env.SNIPER_TARGET_ASSETS || "sUSDe,USDe").split(","),
    minExpiryDays: parseInt(process.env.SNIPER_MIN_EXPIRY_DAYS || "30"),
    maxExpiryDays: parseInt(process.env.SNIPER_MAX_EXPIRY_DAYS || "365"),

    telegramEnabled: process.env.TELEGRAM_ENABLED === "true",
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID || "",

    useTreasuryRoute: process.env.SNIPER_TREASURY_ROUTE === "true",
    treasuryAddress: process.env.TREASURY_ADDRESS || "",
    pendleStrategyAddress: process.env.PENDLE_STRATEGY_ADDRESS || "",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//                     TELEGRAM ALERTS
// ═══════════════════════════════════════════════════════════════════════════

async function sendTelegramAlert(config: SniperConfig, message: string): Promise<void> {
  if (!config.telegramEnabled || !config.telegramBotToken) return;

  try {
    const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text: `🎯 PENDLE SNIPER\n\n${message}`,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    logger.error(`Telegram alert failed: ${err}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//                    POOL SNIPER CLASS
// ═══════════════════════════════════════════════════════════════════════════

class PendlePoolSniper {
  private config: SniperConfig;
  private httpProvider: ethers.JsonRpcProvider;
  private wsProvider: ethers.WebSocketProvider | null = null;
  private wallet: Wallet;
  private flashbots: FlashbotsProvider | null = null;
  private privateTx: PrivateTxSender | null = null;

  // All known SY addresses (collected from TARGET_TOKENS + discovered dynamically)
  private targetSyAddresses: Set<string> = new Set();
  private targetUnderlyings: Set<string> = new Set();

  // Prevent double-sniping the same market
  private snipedMarkets: Set<string> = new Set();

  constructor(config: SniperConfig) {
    this.config = config;
    this.httpProvider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.wallet = new Wallet(config.privateKey, this.httpProvider);

    // Collect target SY addresses and underlying tokens
    for (const assetKey of config.targetAssets) {
      const target = TARGET_TOKENS[assetKey];
      if (!target) {
        logger.warn(`Unknown target asset: ${assetKey}`);
        continue;
      }
      for (const sy of target.syAddresses) {
        this.targetSyAddresses.add(sy.toLowerCase());
      }
      if (target.underlying !== "0x") {
        this.targetUnderlyings.add(target.underlying.toLowerCase());
      }
    }

    logger.info(`Watching for SY addresses: ${[...this.targetSyAddresses].join(", ")}`);
    logger.info(`Watching for underlyings: ${[...this.targetUnderlyings].join(", ")}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  //  STARTUP
  // ─────────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    logger.info("═══════════════════════════════════════════════════");
    logger.info("  PENDLE PT POOL SNIPER — Starting");
    logger.info(`  Wallet: ${this.wallet.address}`);
    logger.info(`  Deposit: ${ethers.formatUnits(this.config.depositAmountRaw, 6)} USDC`);
    logger.info(`  Flashbots: ${this.config.useFlashbots}`);
    logger.info(`  Private RPC: ${this.config.usePrivateRpc}`);
    logger.info(`  Target assets: ${this.config.targetAssets.join(", ")}`);
    logger.info("═══════════════════════════════════════════════════");

    // Pre-flight checks
    await this.preflight();

    // Initialize Flashbots if enabled
    if (this.config.useFlashbots) {
      this.flashbots = new FlashbotsProvider(this.httpProvider, this.wallet, this.config.chainId);
      logger.info("Flashbots provider initialized");
    }

    if (this.config.usePrivateRpc) {
      this.privateTx = new PrivateTxSender(this.httpProvider, this.wallet);
      logger.info("Private RPC sender initialized");
    }

    // Start WebSocket listener for real-time events
    await this.startWsListener();

    // Also poll as fallback (WebSocket can drop)
    this.startPolling();

    await sendTelegramAlert(this.config, "🟢 Pool Sniper started. Watching for new Pendle PT pools...");
  }

  // ─────────────────────────────────────────────────────────────────────
  //  PRE-FLIGHT CHECKS
  // ─────────────────────────────────────────────────────────────────────

  private async preflight(): Promise<void> {
    // Check ETH balance for gas
    const ethBalance = await this.httpProvider.getBalance(this.wallet.address);
    logger.info(`ETH balance: ${ethers.formatEther(ethBalance)} ETH`);
    if (ethBalance < ethers.parseEther("0.05")) {
      logger.warn("⚠️  Low ETH balance — may not have enough for gas");
    }

    // Check USDC balance
    const usdc = new Contract(this.config.depositToken, ERC20_ABI, this.wallet);
    const usdcBalance = await usdc.balanceOf(this.wallet.address);
    const usdcDecimals = await usdc.decimals();
    logger.info(`USDC balance: ${ethers.formatUnits(usdcBalance, usdcDecimals)} USDC`);

    if (usdcBalance < this.config.depositAmountRaw) {
      logger.error(`❌ Insufficient USDC. Have ${ethers.formatUnits(usdcBalance, usdcDecimals)}, need ${ethers.formatUnits(this.config.depositAmountRaw, usdcDecimals)}`);
      throw new Error("Insufficient USDC balance");
    }

    // Pre-approve Pendle Router for USDC (max approval)
    const currentAllowance = await usdc.allowance(this.wallet.address, PENDLE_ROUTER);
    if (currentAllowance < this.config.depositAmountRaw) {
      logger.info("Approving Pendle Router for USDC...");
      const approveTx = await usdc.approve(PENDLE_ROUTER, ethers.MaxUint256);
      await approveTx.wait();
      logger.info(`✅ USDC approved for Pendle Router`);
    } else {
      logger.info("USDC already approved for Pendle Router");
    }

    // Check gas price
    const feeData = await this.httpProvider.getFeeData();
    const gasPriceGwei = Number(ethers.formatUnits(feeData.gasPrice || 0n, "gwei"));
    logger.info(`Current gas price: ${gasPriceGwei.toFixed(1)} gwei`);
  }

  // ─────────────────────────────────────────────────────────────────────
  //  WEBSOCKET LISTENER (real-time, block-by-block)
  // ─────────────────────────────────────────────────────────────────────

  private async startWsListener(): Promise<void> {
    try {
      this.wsProvider = new ethers.WebSocketProvider(this.config.wsRpcUrl);
      logger.info("WebSocket connection established");

      for (const [version, factoryAddr] of Object.entries(MARKET_FACTORIES)) {
        const factory = new Contract(factoryAddr, MARKET_FACTORY_ABI, this.wsProvider);

        factory.on("CreateNewMarket", async (market: string, pt: string, scalarRoot: bigint, initialAnchor: bigint, lnFeeRateRoot: bigint, event: EventLog) => {
          logger.info(`\n🔔 NEW MARKET DETECTED on Factory ${version}!`);
          logger.info(`   Market: ${market}`);
          logger.info(`   PT: ${pt}`);
          logger.info(`   Block: ${event.blockNumber}`);

          await this.handleNewMarket(market, pt, version, event.blockNumber);
        });

        logger.info(`Subscribed to CreateNewMarket on Factory ${version} (${factoryAddr})`);
      }

      // Reconnect on disconnect
      this.wsProvider.on("error", (err) => {
        logger.error(`WebSocket error: ${err.message}`);
        setTimeout(() => this.startWsListener(), 5000);
      });

    } catch (err: any) {
      logger.error(`WebSocket setup failed: ${err.message}. Falling back to polling only.`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  POLLING FALLBACK (check every N blocks for events we might've missed)
  // ─────────────────────────────────────────────────────────────────────

  private startPolling(): void {
    const POLL_INTERVAL_MS = 12_000; // ~1 block
    let lastCheckedBlock = 0;

    const poll = async () => {
      try {
        const currentBlock = await this.httpProvider.getBlockNumber();

        if (lastCheckedBlock === 0) {
          // On first poll, only look back 10 blocks
          lastCheckedBlock = currentBlock - 10;
        }

        if (currentBlock <= lastCheckedBlock) return;

        for (const [version, factoryAddr] of Object.entries(MARKET_FACTORIES)) {
          const factory = new Contract(factoryAddr, MARKET_FACTORY_ABI, this.httpProvider);

          const filter = factory.filters.CreateNewMarket();
          const events = await factory.queryFilter(filter, lastCheckedBlock + 1, currentBlock);

          for (const event of events) {
            if (event instanceof EventLog) {
              const [market, pt] = [event.args[0], event.args[1]];
              logger.info(`[POLL] Found CreateNewMarket on ${version}: market=${market}, PT=${pt}`);
              await this.handleNewMarket(market, pt, version, event.blockNumber);
            }
          }
        }

        lastCheckedBlock = currentBlock;
      } catch (err: any) {
        logger.error(`Polling error: ${err.message}`);
      }
    };

    setInterval(poll, POLL_INTERVAL_MS);
    logger.info(`Polling fallback started (every ${POLL_INTERVAL_MS / 1000}s)`);
  }

  // ─────────────────────────────────────────────────────────────────────
  //  HANDLE NEW MARKET
  // ─────────────────────────────────────────────────────────────────────

  private async handleNewMarket(
    marketAddr: string,
    ptAddr: string,
    factoryVersion: string,
    blockNumber: number
  ): Promise<void> {
    // Dedup
    const marketKey = marketAddr.toLowerCase();
    if (this.snipedMarkets.has(marketKey)) {
      logger.info(`Market ${marketAddr} already processed, skipping`);
      return;
    }

    try {
      // 1. Check if the PT's SY matches our targets
      const pt = new Contract(ptAddr, PT_ABI, this.httpProvider);
      const syAddr: string = await pt.SY();
      const ptName: string = await pt.name();
      const ptExpiry: bigint = await pt.expiry();

      logger.info(`   PT Name: ${ptName}`);
      logger.info(`   SY: ${syAddr}`);
      logger.info(`   Expiry: ${new Date(Number(ptExpiry) * 1000).toISOString()}`);

      // Check SY match (direct)
      let isTarget = this.targetSyAddresses.has(syAddr.toLowerCase());

      // If SY not in known list, check underlying token
      if (!isTarget && this.targetUnderlyings.size > 0) {
        try {
          const sy = new Contract(syAddr, SY_ABI, this.httpProvider);
          const yieldToken: string = await sy.yieldToken();
          logger.info(`   Yield Token: ${yieldToken}`);

          if (this.targetUnderlyings.has(yieldToken.toLowerCase())) {
            isTarget = true;
            // Cache this SY for faster future lookups
            this.targetSyAddresses.add(syAddr.toLowerCase());
            logger.info(`   ✅ Matched via yieldToken!`);
          }

          // Also check tokensIn list
          if (!isTarget) {
            const tokensIn: string[] = await sy.getTokensIn();
            for (const token of tokensIn) {
              if (this.targetUnderlyings.has(token.toLowerCase())) {
                isTarget = true;
                this.targetSyAddresses.add(syAddr.toLowerCase());
                logger.info(`   ✅ Matched via tokensIn: ${token}`);
                break;
              }
            }
          }
        } catch (err: any) {
          logger.warn(`   Could not query SY ${syAddr}: ${err.message}`);
        }
      }

      if (!isTarget) {
        logger.info(`   ❌ Not a target asset, skipping`);
        return;
      }

      // 2. Check expiry constraints
      const now = Math.floor(Date.now() / 1000);
      const daysToExpiry = (Number(ptExpiry) - now) / 86400;

      if (daysToExpiry < this.config.minExpiryDays) {
        logger.info(`   ⏭️  Too short-dated (${daysToExpiry.toFixed(0)} days), skipping`);
        return;
      }
      if (daysToExpiry > this.config.maxExpiryDays) {
        logger.info(`   ⏭️  Too long-dated (${daysToExpiry.toFixed(0)} days), skipping`);
        return;
      }

      // 3. Check gas price
      const feeData = await this.httpProvider.getFeeData();
      const gasPriceGwei = Number(ethers.formatUnits(feeData.gasPrice || 0n, "gwei"));
      if (gasPriceGwei > this.config.maxGasPriceGwei) {
        logger.warn(`   ⛽ Gas too high (${gasPriceGwei.toFixed(1)} gwei > ${this.config.maxGasPriceGwei} max). Skipping but alerting.`);
        await sendTelegramAlert(this.config,
          `⚠️ *Target pool detected but gas too high!*\n` +
          `Pool: ${ptName}\n` +
          `Market: \`${marketAddr}\`\n` +
          `Expiry: ${daysToExpiry.toFixed(0)} days\n` +
          `Gas: ${gasPriceGwei.toFixed(1)} gwei (max: ${this.config.maxGasPriceGwei})`
        );
        return;
      }

      // 4. 🚀 EXECUTE SNIPE
      logger.info(`\n🎯 SNIPING: ${ptName}`);
      logger.info(`   Market: ${marketAddr}`);
      logger.info(`   Expiry: ${daysToExpiry.toFixed(0)} days`);
      logger.info(`   Amount: ${ethers.formatUnits(this.config.depositAmountRaw, 6)} USDC`);

      this.snipedMarkets.add(marketKey);

      const result = await this.executeSnipe(marketAddr, ptAddr);

      if (result.success) {
        const msg =
          `✅ *SNIPED SUCCESSFULLY*\n\n` +
          `Pool: ${ptName}\n` +
          `Market: \`${marketAddr}\`\n` +
          `Factory: ${factoryVersion}\n` +
          `PT Out: ${result.ptOut || "?"}\n` +
          `Expiry: ${daysToExpiry.toFixed(0)} days\n` +
          `TX: \`${result.txHash}\`\n` +
          `Block: ${result.blockNumber || blockNumber}`;

        logger.info(`✅ Snipe successful! TX: ${result.txHash}`);
        await sendTelegramAlert(this.config, msg);
      } else {
        const msg =
          `❌ *SNIPE FAILED*\n\n` +
          `Pool: ${ptName}\n` +
          `Market: \`${marketAddr}\`\n` +
          `Error: ${result.error}`;

        logger.error(`❌ Snipe failed: ${result.error}`);
        await sendTelegramAlert(this.config, msg);

        // Allow retry
        this.snipedMarkets.delete(marketKey);
      }

    } catch (err: any) {
      logger.error(`Error handling new market ${marketAddr}: ${err.message}`);
      logger.error(err.stack);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  EXECUTE SNIPE (USDC → PT via Pendle Router)
  // ─────────────────────────────────────────────────────────────────────

  private async executeSnipe(
    marketAddr: string,
    ptAddr: string
  ): Promise<{
    success: boolean;
    txHash?: string;
    blockNumber?: number;
    ptOut?: string;
    error?: string;
  }> {
    const depositAmount = this.config.depositAmountRaw;
    const minPtOut = (depositAmount * BigInt(10000 - this.config.slippageBps)) / 10000n;

    // Build the Pendle Router calldata
    const routerInterface = new ethers.Interface(PENDLE_ROUTER_ABI);

    const approxParams = {
      guessMin: minPtOut,
      guessMax: depositAmount * 2n, // PT can be worth more than underlying
      guessOffchain: 0n,
      maxIteration: 256n,
      eps: BigInt(1e14), // 0.01% precision
    };

    const tokenInput = {
      tokenIn: this.config.depositToken,
      netTokenIn: depositAmount,
      tokenMintSy: this.config.depositToken,
      pendleSwap: ethers.ZeroAddress,
      swapData: {
        swapType: 0, // NONE
        extRouter: ethers.ZeroAddress,
        extCalldata: "0x",
        needScale: false,
      },
    };

    const emptyLimitOrder = {
      limitRouter: ethers.ZeroAddress,
      epsSkipMarket: 0n,
      normalFills: [],
      flashFills: [],
      optData: "0x",
    };

    const calldata = routerInterface.encodeFunctionData("swapExactTokenForPt", [
      this.wallet.address,  // receiver
      marketAddr,            // market
      minPtOut,              // minPtOut
      approxParams,
      tokenInput,
      emptyLimitOrder,
    ]);

    // ── EXECUTION PATH ──

    // Path A: Flashbots bundle (block-level front-run protection)
    if (this.config.useFlashbots && this.flashbots) {
      return this.executeViaFlashbots(calldata);
    }

    // Path B: Private RPC (mempool protection, simpler)
    if (this.config.usePrivateRpc && this.privateTx) {
      return this.executeViaPrivateRpc(calldata);
    }

    // Path C: Regular transaction (no protection)
    return this.executeRegular(calldata);
  }

  private async executeViaFlashbots(calldata: string): Promise<{
    success: boolean;
    txHash?: string;
    blockNumber?: number;
    ptOut?: string;
    error?: string;
  }> {
    logger.info("Executing via Flashbots bundle...");

    const currentBlock = await this.httpProvider.getBlockNumber();
    const nonce = await this.httpProvider.getTransactionCount(this.wallet.address);
    const feeData = await this.httpProvider.getFeeData();

    const tx: ethers.TransactionLike = {
      to: PENDLE_ROUTER,
      data: calldata,
      value: 0n,
      nonce,
      gasLimit: 800_000n, // PT swaps can be gas-heavy
      chainId: BigInt(this.config.chainId),
      type: 2,
      maxFeePerGas: (feeData.maxFeePerGas || feeData.gasPrice || ethers.parseUnits("50", "gwei")) * 2n,
      maxPriorityFeePerGas: ethers.parseUnits(this.config.priorityFeeGwei.toString(), "gwei"),
    };

    const signedTx = await this.wallet.signTransaction(tx);

    // Try next 3 blocks
    for (let i = 0; i < 3; i++) {
      const targetBlock = currentBlock + 1 + i;

      try {
        // Simulate
        const sim = await this.flashbots!.simulateBundle([signedTx], targetBlock);
        if (!sim.success) {
          logger.error(`Flashbots simulation failed: ${sim.error}`);
          continue;
        }

        logger.info(`Simulation OK — gas used: ${sim.results[0]?.gasUsed}`);

        // Send
        const bundle = await this.flashbots!.sendBundle([signedTx], targetBlock);
        logger.info(`Bundle submitted: ${bundle.bundleHash} → targeting block ${targetBlock}`);

        // Wait for target block
        await this.waitForBlock(targetBlock);

        // Check inclusion
        const txHash = ethers.keccak256(signedTx);
        const receipt = await this.httpProvider.getTransactionReceipt(txHash);

        if (receipt && receipt.status === 1) {
          return {
            success: true,
            txHash: receipt.hash,
            blockNumber: receipt.blockNumber,
          };
        }
      } catch (err: any) {
        logger.warn(`Flashbots attempt for block ${targetBlock} failed: ${err.message}`);
      }
    }

    // Fallback to private RPC
    logger.warn("Flashbots failed after 3 blocks, falling back to private RPC...");
    if (this.privateTx) {
      return this.executeViaPrivateRpc(calldata);
    }
    return this.executeRegular(calldata);
  }

  private async executeViaPrivateRpc(calldata: string): Promise<{
    success: boolean;
    txHash?: string;
    blockNumber?: number;
    error?: string;
  }> {
    logger.info("Executing via Flashbots Protect RPC (private mempool)...");

    try {
      const txHash = await this.privateTx!.sendPrivate(
        PENDLE_ROUTER,
        calldata,
        0n,
        800_000n
      );

      logger.info(`Private TX sent: ${txHash}`);

      // Wait for confirmation (private RPCs can take a few blocks)
      const receipt = await this.httpProvider.waitForTransaction(txHash, 1, 120_000);

      if (receipt && receipt.status === 1) {
        return { success: true, txHash: receipt.hash, blockNumber: receipt.blockNumber };
      } else {
        return { success: false, error: "Transaction reverted" };
      }
    } catch (err: any) {
      logger.error(`Private RPC execution failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  private async executeRegular(calldata: string): Promise<{
    success: boolean;
    txHash?: string;
    blockNumber?: number;
    error?: string;
  }> {
    logger.info("Executing via regular transaction (no MEV protection)...");

    try {
      const tx = await this.wallet.sendTransaction({
        to: PENDLE_ROUTER,
        data: calldata,
        gasLimit: 800_000n,
      });

      logger.info(`TX sent: ${tx.hash}`);
      const receipt = await tx.wait();

      if (receipt && receipt.status === 1) {
        return { success: true, txHash: receipt.hash, blockNumber: receipt.blockNumber };
      } else {
        return { success: false, error: "Transaction reverted" };
      }
    } catch (err: any) {
      logger.error(`Regular execution failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  UTILITIES
  // ─────────────────────────────────────────────────────────────────────

  private async waitForBlock(blockNumber: number): Promise<void> {
    return new Promise((resolve) => {
      const check = async () => {
        const current = await this.httpProvider.getBlockNumber();
        if (current >= blockNumber) {
          resolve();
        } else {
          setTimeout(check, 1000);
        }
      };
      check();
    });
  }

  async stop(): Promise<void> {
    logger.info("Shutting down sniper...");
    if (this.wsProvider) {
      await this.wsProvider.destroy();
    }
    await sendTelegramAlert(this.config, "🔴 Pool Sniper stopped.");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//                          MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  logger.info("Loading configuration...");
  const config = loadConfig();

  if (!config.privateKey) {
    logger.error("PRIVATE_KEY not set in environment");
    process.exit(1);
  }

  const sniper = new PendlePoolSniper(config);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    await sniper.stop();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await sniper.stop();
    process.exit(0);
  });

  await sniper.start();

  // Keep alive
  logger.info("Sniper running. Press Ctrl+C to stop.");
}

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`);
  logger.error(err.stack);
  process.exit(1);
});
