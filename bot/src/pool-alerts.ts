// ═══════════════════════════════════════════════════════════════════════════
// Pendle & Aave PT Pool Alert Bot
// ═══════════════════════════════════════════════════════════════════════════
// Monitors for new PT pool listings on Pendle + Aave and sends
// Telegram alerts with pool details (APY, expiry, liquidity, etc.)
//
// Watches:
//   1. Pendle MarketFactory V3-V6 → CreateNewMarket events
//   2. Aave V3 PoolConfigurator → ReserveInitialized events (filtered for PT tokens)
//   3. Morpho Blue → CreateMarket events (filtered for PT collateral)
//
// Run:  npm run alerts
// ═══════════════════════════════════════════════════════════════════════════

import { ethers, Contract, EventLog } from "ethers";
import * as dotenv from "dotenv";
import * as path from "path";
import { createLogger, format, transports } from "winston";

// Load .env from the bot/ directory regardless of where we run from
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

// ═══════════════════════════════════════════════════════════════════════════
//                          LOGGER
// ═══════════════════════════════════════════════════════════════════════════

const logger = createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: format.combine(
    format.timestamp(),
    format.printf(({ timestamp, level, message }) =>
      `${timestamp} [${level.toUpperCase()}] [ALERTS] ${message}`
    )
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: "pool-alerts.log" }),
  ],
});

// ═══════════════════════════════════════════════════════════════════════════
//                     CONTRACT ADDRESSES (Ethereum Mainnet)
// ═══════════════════════════════════════════════════════════════════════════

// Pendle MarketFactory versions
const PENDLE_FACTORIES: Record<string, string> = {
  V3: "0x1A6fCc85557BC4fB7B534ed835a03EF056552D52",
  V4: "0x3d75Bd20C983edb5fD218A1b7e0024F1056c7A2F",
  V5: "0x6fcf753f2C67b83f7B09746Bbc4FA0047b35D050",
  V6: "0x6d247b1c044fA1E22e6B04fA9F71Baf99EB29A9f",
};

// Aave V3 (Ethereum)
const AAVE_POOL_CONFIGURATOR = "0x64b761D848206f447Fe2dd461b0c635Ec39EbB27";
const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const AAVE_UI_DATA_PROVIDER = "0x91c0eA31b49B69Ea18607702c5d9aC360bf3dE7d";

// Morpho Blue
const MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

// Pendle Router (for reference links)
const PENDLE_APP_BASE = "https://app.pendle.finance/trade/markets";

// ═══════════════════════════════════════════════════════════════════════════
//                          ABIs
// ═══════════════════════════════════════════════════════════════════════════

const PENDLE_FACTORY_ABI = [
  "event CreateNewMarket(address indexed market, address indexed PT, int256 scalarRoot, int256 initialAnchor, uint256 lnFeeRateRoot)",
];

const AAVE_CONFIGURATOR_ABI = [
  "event ReserveInitialized(address indexed asset, address indexed aToken, address stableDebtToken, address variableDebtToken, address interestRateStrategyAddress)",
  "event CollateralConfigurationChanged(address indexed asset, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus)",
  "event BorrowingEnabledOnReserve(address indexed asset, bool stableRateEnabled)",
  "event EModeCategoryAdded(uint8 indexed categoryId, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, address oracle, string label)",
  "event AssetCollateralInEModeChanged(address indexed asset, uint8 indexed categoryId, bool allowed)",
];

const MORPHO_BLUE_ABI = [
  "event CreateMarket(bytes32 indexed id, tuple(address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams)",
];

const PT_ABI = [
  "function SY() external view returns (address)",
  "function YT() external view returns (address)",
  "function expiry() external view returns (uint256)",
  "function name() external view returns (string)",
  "function symbol() external view returns (string)",
];

const SY_ABI = [
  "function yieldToken() external view returns (address)",
  "function name() external view returns (string)",
  "function exchangeRate() external view returns (uint256)",
];

const MARKET_ABI = [
  "function readTokens() external view returns (address sy, address pt, address yt)",
  "function expiry() external view returns (uint256)",
];

const ERC20_ABI = [
  "function name() external view returns (string)",
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
  "function totalSupply() external view returns (uint256)",
];

const AAVE_POOL_ABI = [
  "function getReserveData(address asset) external view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint256 unbacked, uint256 isolationModeTotalDebt))",
];

// ═══════════════════════════════════════════════════════════════════════════
//                     CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

interface AlertConfig {
  rpcUrl: string;
  wsRpcUrl: string;
  chainId: number;

  // Telegram
  telegramBotToken: string;
  telegramChatId: string;

  // What to watch
  watchPendle: boolean;
  watchAave: boolean;
  watchMorpho: boolean;

  // Filter — only alert on PT-related assets (set false to see everything)
  ptOnlyFilter: boolean;

  // Polling fallback interval (ms)
  pollIntervalMs: number;
}

function loadConfig(): AlertConfig {
  return {
    rpcUrl: process.env.RPC_URL || "https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
    wsRpcUrl: process.env.WS_RPC_URL || "wss://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
    chainId: parseInt(process.env.CHAIN_ID || "1"),

    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN!,
    telegramChatId: process.env.TELEGRAM_CHAT_ID!,

    watchPendle: process.env.WATCH_PENDLE !== "false",  // default ON
    watchAave: process.env.WATCH_AAVE !== "false",      // default ON
    watchMorpho: process.env.WATCH_MORPHO !== "false",  // default ON

    ptOnlyFilter: process.env.PT_ONLY_FILTER !== "false", // default ON for Aave/Morpho

    pollIntervalMs: parseInt(process.env.ALERT_POLL_INTERVAL_MS || "15000"),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//                     TELEGRAM
// ═══════════════════════════════════════════════════════════════════════════

async function sendTelegram(config: AlertConfig, message: string): Promise<void> {
  if (!config.telegramBotToken || !config.telegramChatId) {
    logger.warn("Telegram not configured — logging alert to console only");
    logger.info(`\n${message}\n`);
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text: message,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error(`Telegram API error: ${res.status} ${body}`);
    }
  } catch (err: any) {
    logger.error(`Telegram send failed: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//                     POOL ALERT BOT
// ═══════════════════════════════════════════════════════════════════════════

class PoolAlertBot {
  private config: AlertConfig;
  private httpProvider: ethers.JsonRpcProvider;
  private wsProvider: ethers.WebSocketProvider | null = null;

  // Dedup — track seen events by tx hash + log index
  private seenEvents: Set<string> = new Set();
  private lastCheckedBlock: number = 0;

  constructor(config: AlertConfig) {
    this.config = config;
    this.httpProvider = new ethers.JsonRpcProvider(config.rpcUrl);
  }

  async start(): Promise<void> {
    logger.info("═══════════════════════════════════════════════════");
    logger.info("  PENDLE & AAVE PT POOL ALERT BOT");
    logger.info(`  Watching: ${[
      this.config.watchPendle && "Pendle",
      this.config.watchAave && "Aave",
      this.config.watchMorpho && "Morpho",
    ].filter(Boolean).join(", ")}`);
    logger.info("═══════════════════════════════════════════════════");

    if (!this.config.telegramBotToken) {
      logger.warn("⚠️  TELEGRAM_BOT_TOKEN not set — alerts will only appear in console/log");
    }

    // Try WebSocket for real-time
    await this.startWsListeners();

    // Polling fallback
    this.startPolling();

    await sendTelegram(this.config,
      "🟢 *Pool Alert Bot Started*\n\n" +
      `Watching: ${[
        this.config.watchPendle && "Pendle (all factories)",
        this.config.watchAave && "Aave V3",
        this.config.watchMorpho && "Morpho Blue",
      ].filter(Boolean).join(", ")}`
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  //  WEBSOCKET LISTENERS
  // ─────────────────────────────────────────────────────────────────────

  private async startWsListeners(): Promise<void> {
    try {
      this.wsProvider = new ethers.WebSocketProvider(this.config.wsRpcUrl);

      // Pendle
      if (this.config.watchPendle) {
        for (const [version, addr] of Object.entries(PENDLE_FACTORIES)) {
          const factory = new Contract(addr, PENDLE_FACTORY_ABI, this.wsProvider);
          factory.on("CreateNewMarket", async (market: string, pt: string, _s: any, _a: any, _l: any, event: EventLog) => {
            const key = `${event.transactionHash}-${event.index}`;
            if (this.seenEvents.has(key)) return;
            this.seenEvents.add(key);
            await this.handlePendleNewMarket(market, pt, version, event.blockNumber);
          });
          logger.info(`[WS] Subscribed: Pendle ${version} (${addr})`);
        }
      }

      // Aave
      if (this.config.watchAave) {
        const configurator = new Contract(AAVE_POOL_CONFIGURATOR, AAVE_CONFIGURATOR_ABI, this.wsProvider);
        configurator.on("ReserveInitialized", async (asset: string, aToken: string, _s: any, _v: any, _i: any, event: EventLog) => {
          const key = `${event.transactionHash}-${event.index}`;
          if (this.seenEvents.has(key)) return;
          this.seenEvents.add(key);
          await this.handleAaveNewReserve(asset, aToken, event.blockNumber);
        });
        logger.info(`[WS] Subscribed: Aave V3 PoolConfigurator`);

        // Also watch for eMode changes (PT tokens often get added to eMode)
        configurator.on("AssetCollateralInEModeChanged", async (asset: string, categoryId: number, allowed: boolean, event: EventLog) => {
          const key = `${event.transactionHash}-${event.index}`;
          if (this.seenEvents.has(key)) return;
          this.seenEvents.add(key);
          if (allowed) {
            await this.handleAaveEModeChange(asset, categoryId, event.blockNumber);
          }
        });
        logger.info(`[WS] Subscribed: Aave eMode changes`);
      }

      // Morpho
      if (this.config.watchMorpho) {
        const morpho = new Contract(MORPHO_BLUE, MORPHO_BLUE_ABI, this.wsProvider);
        morpho.on("CreateMarket", async (id: string, marketParams: any, event: EventLog) => {
          const key = `${event.transactionHash}-${event.index}`;
          if (this.seenEvents.has(key)) return;
          this.seenEvents.add(key);
          await this.handleMorphoNewMarket(id, marketParams, event.blockNumber);
        });
        logger.info(`[WS] Subscribed: Morpho Blue CreateMarket`);
      }

      // Reconnect on error
      this.wsProvider.on("error", (err) => {
        logger.warn(`WebSocket error: ${err.message} — continuing with polling only`);
        this.wsProvider = null;
      });

    } catch (err: any) {
      logger.warn(`WebSocket not available: ${err.message}. Using HTTP polling only (works fine).`);
      this.wsProvider = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  POLLING FALLBACK
  // ─────────────────────────────────────────────────────────────────────

  private startPolling(): void {
    const poll = async () => {
      try {
        const currentBlock = await this.httpProvider.getBlockNumber();
        if (this.lastCheckedBlock === 0) {
          this.lastCheckedBlock = currentBlock - 5;
        }
        if (currentBlock <= this.lastCheckedBlock) return;

        const fromBlock = this.lastCheckedBlock + 1;
        const toBlock = currentBlock;

        // Pendle
        if (this.config.watchPendle) {
          for (const [version, addr] of Object.entries(PENDLE_FACTORIES)) {
            const factory = new Contract(addr, PENDLE_FACTORY_ABI, this.httpProvider);
            const events = await factory.queryFilter(factory.filters.CreateNewMarket(), fromBlock, toBlock);
            for (const event of events) {
              if (event instanceof EventLog) {
                const key = `${event.transactionHash}-${event.index}`;
                if (this.seenEvents.has(key)) continue;
                this.seenEvents.add(key);
                await this.handlePendleNewMarket(event.args[0], event.args[1], version, event.blockNumber);
              }
            }
          }
        }

        // Aave
        if (this.config.watchAave) {
          const configurator = new Contract(AAVE_POOL_CONFIGURATOR, AAVE_CONFIGURATOR_ABI, this.httpProvider);

          const reserveEvents = await configurator.queryFilter(configurator.filters.ReserveInitialized(), fromBlock, toBlock);
          for (const event of reserveEvents) {
            if (event instanceof EventLog) {
              const key = `${event.transactionHash}-${event.index}`;
              if (this.seenEvents.has(key)) continue;
              this.seenEvents.add(key);
              await this.handleAaveNewReserve(event.args[0], event.args[1], event.blockNumber);
            }
          }

          const eModeEvents = await configurator.queryFilter(configurator.filters.AssetCollateralInEModeChanged(), fromBlock, toBlock);
          for (const event of eModeEvents) {
            if (event instanceof EventLog) {
              const key = `${event.transactionHash}-${event.index}`;
              if (this.seenEvents.has(key)) continue;
              this.seenEvents.add(key);
              if (event.args[2]) { // allowed = true
                await this.handleAaveEModeChange(event.args[0], event.args[1], event.blockNumber);
              }
            }
          }
        }

        // Morpho
        if (this.config.watchMorpho) {
          const morpho = new Contract(MORPHO_BLUE, MORPHO_BLUE_ABI, this.httpProvider);
          const events = await morpho.queryFilter(morpho.filters.CreateMarket(), fromBlock, toBlock);
          for (const event of events) {
            if (event instanceof EventLog) {
              const key = `${event.transactionHash}-${event.index}`;
              if (this.seenEvents.has(key)) continue;
              this.seenEvents.add(key);
              await this.handleMorphoNewMarket(event.args[0], event.args[1], event.blockNumber);
            }
          }
        }

        this.lastCheckedBlock = toBlock;
      } catch (err: any) {
        logger.error(`Polling error: ${err.message}`);
      }
    };

    setInterval(poll, this.config.pollIntervalMs);
    logger.info(`Polling started (every ${this.config.pollIntervalMs / 1000}s)`);
  }

  // ─────────────────────────────────────────────────────────────────────
  //  PENDLE: New Market
  // ─────────────────────────────────────────────────────────────────────

  private async handlePendleNewMarket(
    marketAddr: string,
    ptAddr: string,
    factoryVersion: string,
    blockNumber: number
  ): Promise<void> {
    try {
      const pt = new Contract(ptAddr, PT_ABI, this.httpProvider);
      const [ptName, ptSymbol, ptExpiry, syAddr] = await Promise.all([
        pt.name(),
        pt.symbol(),
        pt.expiry(),
        pt.SY(),
      ]);

      // Get SY info
      let syName = "Unknown";
      let yieldToken = "Unknown";
      try {
        const sy = new Contract(syAddr, SY_ABI, this.httpProvider);
        [syName, yieldToken] = await Promise.all([sy.name(), sy.yieldToken()]);
      } catch {}

      const now = Math.floor(Date.now() / 1000);
      const daysToExpiry = ((Number(ptExpiry) - now) / 86400).toFixed(0);
      const expiryDate = new Date(Number(ptExpiry) * 1000).toLocaleDateString("en-US", {
        day: "numeric", month: "short", year: "numeric"
      });

      const message =
        `🟢 *NEW PENDLE PT POOL*\n\n` +
        `*${ptName}*\n` +
        `Symbol: \`${ptSymbol}\`\n` +
        `Factory: ${factoryVersion}\n\n` +
        `📅 Expiry: ${expiryDate} (${daysToExpiry} days)\n` +
        `🔗 Market: \`${marketAddr}\`\n` +
        `🎯 PT: \`${ptAddr}\`\n` +
        `📦 SY: \`${syAddr}\`\n` +
        `💰 Yield Token: \`${yieldToken}\`\n\n` +
        `🌐 [View on Pendle](${PENDLE_APP_BASE})\n` +
        `📊 [Etherscan](https://etherscan.io/address/${marketAddr})\n\n` +
        `Block: ${blockNumber}`;

      logger.info(`NEW PENDLE POOL: ${ptName} | Expiry: ${expiryDate} | Factory: ${factoryVersion}`);
      await sendTelegram(this.config, message);

    } catch (err: any) {
      logger.error(`Error processing Pendle market ${marketAddr}: ${err.message}`);
      // Still send basic alert
      await sendTelegram(this.config,
        `🟢 *NEW PENDLE PT POOL*\n\nMarket: \`${marketAddr}\`\nPT: \`${ptAddr}\`\nFactory: ${factoryVersion}\nBlock: ${blockNumber}\n\n⚠️ Could not fetch full details`
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  AAVE: New Reserve
  // ─────────────────────────────────────────────────────────────────────

  private async handleAaveNewReserve(
    assetAddr: string,
    aTokenAddr: string,
    blockNumber: number
  ): Promise<void> {
    try {
      const asset = new Contract(assetAddr, ERC20_ABI, this.httpProvider);
      const [name, symbol] = await Promise.all([asset.name(), asset.symbol()]);

      const isPT = this.looksLikePT(name, symbol);

      // If filter is on, only alert for PT-related assets
      if (this.config.ptOnlyFilter && !isPT) {
        logger.info(`Aave new reserve: ${symbol} — not PT-related, skipping alert`);
        return;
      }

      // Try to get PT details if it looks like a PT
      let ptDetails = "";
      if (isPT) {
        try {
          const pt = new Contract(assetAddr, PT_ABI, this.httpProvider);
          const expiry = await pt.expiry();
          const expiryDate = new Date(Number(expiry) * 1000).toLocaleDateString("en-US", {
            day: "numeric", month: "short", year: "numeric"
          });
          const daysToExpiry = ((Number(expiry) - Math.floor(Date.now() / 1000)) / 86400).toFixed(0);
          ptDetails = `\n📅 PT Expiry: ${expiryDate} (${daysToExpiry} days)`;

          const syAddr = await pt.SY();
          ptDetails += `\n📦 SY: \`${syAddr}\``;
        } catch {}
      }

      const emoji = isPT ? "🎯" : "🔵";
      const message =
        `${emoji} *NEW AAVE V3 RESERVE*\n\n` +
        `*${name}*\n` +
        `Symbol: \`${symbol}\`\n` +
        `${isPT ? "⚡ *THIS IS A PENDLE PT TOKEN*\n" : ""}` +
        `\n🔗 Asset: \`${assetAddr}\`\n` +
        `🏦 aToken: \`${aTokenAddr}\`${ptDetails}\n\n` +
        `📊 [Aave Market](https://app.aave.com/reserve-overview/?underlyingAsset=${assetAddr.toLowerCase()}&marketName=proto_mainnet_v3)\n` +
        `📊 [Etherscan](https://etherscan.io/address/${assetAddr})\n\n` +
        `Block: ${blockNumber}`;

      logger.info(`NEW AAVE RESERVE: ${symbol} ${isPT ? "(PT!)" : ""}`);
      await sendTelegram(this.config, message);

    } catch (err: any) {
      logger.error(`Error processing Aave reserve ${assetAddr}: ${err.message}`);
      await sendTelegram(this.config,
        `🔵 *NEW AAVE V3 RESERVE*\n\nAsset: \`${assetAddr}\`\nBlock: ${blockNumber}\n\n⚠️ Could not fetch details`
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  AAVE: eMode Change (PT tokens often get added to eMode for higher LTV)
  // ─────────────────────────────────────────────────────────────────────

  private async handleAaveEModeChange(
    assetAddr: string,
    categoryId: number,
    blockNumber: number
  ): Promise<void> {
    try {
      const asset = new Contract(assetAddr, ERC20_ABI, this.httpProvider);
      const [name, symbol] = await Promise.all([asset.name(), asset.symbol()]);

      const isPT = this.looksLikePT(name, symbol);

      if (this.config.ptOnlyFilter && !isPT) {
        logger.info(`Aave eMode change: ${symbol} → category ${categoryId} — not PT, skipping`);
        return;
      }

      const message =
        `⚡ *AAVE eMODE UPDATE*\n\n` +
        `*${name}* (\`${symbol}\`)\n` +
        `Added to eMode category: *${categoryId}*\n` +
        `${isPT ? "🎯 *This is a Pendle PT — higher LTV unlocked for looping!*\n" : ""}` +
        `\n🔗 Asset: \`${assetAddr}\`\n\n` +
        `Block: ${blockNumber}`;

      logger.info(`AAVE eMODE: ${symbol} → category ${categoryId}`);
      await sendTelegram(this.config, message);

    } catch (err: any) {
      logger.error(`Error processing eMode change for ${assetAddr}: ${err.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  MORPHO: New Market
  // ─────────────────────────────────────────────────────────────────────

  private async handleMorphoNewMarket(
    marketId: string,
    marketParams: any,
    blockNumber: number
  ): Promise<void> {
    try {
      const { loanToken, collateralToken, oracle, irm, lltv } = marketParams;

      // Get token names
      const loan = new Contract(loanToken, ERC20_ABI, this.httpProvider);
      const collateral = new Contract(collateralToken, ERC20_ABI, this.httpProvider);

      const [loanName, loanSymbol, collateralName, collateralSymbol] = await Promise.all([
        loan.name(), loan.symbol(),
        collateral.name(), collateral.symbol(),
      ]);

      const isPTCollateral = this.looksLikePT(collateralName, collateralSymbol);
      const isPTLoan = this.looksLikePT(loanName, loanSymbol);
      const hasPT = isPTCollateral || isPTLoan;

      if (this.config.ptOnlyFilter && !hasPT) {
        logger.info(`Morpho new market: ${collateralSymbol}/${loanSymbol} — no PT, skipping`);
        return;
      }

      const lltvPercent = (Number(lltv) / 1e16).toFixed(1);

      // If collateral is PT, get expiry
      let ptDetails = "";
      if (isPTCollateral) {
        try {
          const pt = new Contract(collateralToken, PT_ABI, this.httpProvider);
          const expiry = await pt.expiry();
          const expiryDate = new Date(Number(expiry) * 1000).toLocaleDateString("en-US", {
            day: "numeric", month: "short", year: "numeric"
          });
          const daysToExpiry = ((Number(expiry) - Math.floor(Date.now() / 1000)) / 86400).toFixed(0);
          ptDetails = `\n📅 PT Expiry: ${expiryDate} (${daysToExpiry} days)`;
        } catch {}
      }

      const emoji = hasPT ? "🎯" : "🟣";
      const message =
        `${emoji} *NEW MORPHO BLUE MARKET*\n\n` +
        `*${collateralSymbol} / ${loanSymbol}*\n` +
        `${isPTCollateral ? "⚡ *PT as collateral — loopable!*\n" : ""}` +
        `\n📊 LLTV: ${lltvPercent}%` +
        `${ptDetails}\n\n` +
        `💰 Loan: ${loanName} (\`${loanToken}\`)\n` +
        `🔒 Collateral: ${collateralName} (\`${collateralToken}\`)\n` +
        `🔮 Oracle: \`${oracle}\`\n` +
        `📈 IRM: \`${irm}\`\n\n` +
        `🌐 [Morpho App](https://app.morpho.org/market?id=${marketId})\n\n` +
        `Block: ${blockNumber}`;

      logger.info(`NEW MORPHO MARKET: ${collateralSymbol}/${loanSymbol} | LLTV: ${lltvPercent}% ${hasPT ? "(PT!)" : ""}`);
      await sendTelegram(this.config, message);

    } catch (err: any) {
      logger.error(`Error processing Morpho market ${marketId}: ${err.message}`);
      await sendTelegram(this.config,
        `🟣 *NEW MORPHO BLUE MARKET*\n\nID: \`${marketId}\`\nBlock: ${blockNumber}\n\n⚠️ Could not fetch details`
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  HELPERS
  // ─────────────────────────────────────────────────────────────────────

  /** Heuristic: does this token name/symbol look like a Pendle PT? */
  private looksLikePT(name: string, symbol: string): boolean {
    const n = name.toLowerCase();
    const s = symbol.toLowerCase();
    return (
      s.startsWith("pt-") ||
      s.startsWith("pt ") ||
      n.startsWith("pt ") ||
      n.includes("pendle") ||
      n.includes("principal token")
    );
  }

  async stop(): Promise<void> {
    logger.info("Shutting down alert bot...");
    if (this.wsProvider) {
      await this.wsProvider.destroy();
    }
    await sendTelegram(this.config, "🔴 Pool Alert Bot stopped.");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//                          MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.telegramBotToken) {
    logger.warn("════════════════════════════════════════════════");
    logger.warn("  TELEGRAM_BOT_TOKEN not set!");
    logger.warn("  Alerts will only appear in console/log.");
    logger.warn("");
    logger.warn("  To set up Telegram:");
    logger.warn("  1. Message @BotFather on Telegram");
    logger.warn("  2. Send /newbot and follow the prompts");
    logger.warn("  3. Copy the bot token → TELEGRAM_BOT_TOKEN");
    logger.warn("  4. Add your bot to a chat/group");
    logger.warn("  5. Get chat ID → TELEGRAM_CHAT_ID");
    logger.warn("════════════════════════════════════════════════");
  }

  const bot = new PoolAlertBot(config);

  process.on("SIGINT", async () => { await bot.stop(); process.exit(0); });
  process.on("SIGTERM", async () => { await bot.stop(); process.exit(0); });

  await bot.start();
  logger.info("Alert bot running. Press Ctrl+C to stop.");
}

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
