/**
 * Minted Protocol — PriceOracle Circuit Breaker Keeper
 *
 * FIX INFRA: Automates PriceOracle circuit breaker resets.
 * Monitors oracle staleness and resets the circuit breaker when
 * the price feed recovers after a legitimate price move.
 *
 * Architecture:
 *   1. Poll PriceOracle.getPrice() for each collateral token
 *   2. If circuit breaker trips → compare with external feed (Chainlink/CoinGecko)
 *   3. If external feed confirms price is valid → call resetLastKnownPrice()
 *   4. Alert via Telegram on all state changes
 */

import { ethers, Wallet } from "ethers";
import * as dotenv from "dotenv";
import * as fs from "fs";
import { createLogger, format, transports } from "winston";

dotenv.config();

// FIX BE-003: Handle unhandled promise rejections to prevent silent failures
process.on('unhandledRejection', (reason, promise) => {
  console.error('FATAL: Unhandled promise rejection:', reason);
  process.exit(1);
});

// FIX BE-003: Handle uncaught exceptions to prevent silent crashes
process.on('uncaughtException', (error) => {
  console.error('FATAL: Uncaught exception:', error);
  process.exit(1);
});

// ============================================================
//                     TYPES
// ============================================================

export interface OracleKeeperConfig {
  rpcUrl: string;
  chainId: number;
  privateKey: string;
  priceOracleAddress: string;
  /** Tokens to monitor (address → symbol) */
  monitoredTokens: Record<string, string>;
  /** How often to check oracle health (ms) */
  pollIntervalMs: number;
  /** Max seconds before an oracle is considered stale */
  maxStalenessSeconds: number;
  /** Max price deviation (bps) between oracle and external feed */
  maxDeviationBps: number;
  /** External price feed URL template (placeholder {symbol} replaced) */
  externalFeedUrl: string;
  /** Telegram notifications */
  telegramBotToken: string;
  telegramChatId: string;
}

export const DEFAULT_KEEPER_CONFIG: OracleKeeperConfig = {
  rpcUrl: process.env.RPC_URL || "",
  chainId: parseInt(process.env.CHAIN_ID || "1", 10),
  privateKey: "",
  priceOracleAddress: process.env.PRICE_ORACLE_ADDRESS || "",
  monitoredTokens: {},
  pollIntervalMs: parseInt(process.env.KEEPER_POLL_MS || "30000", 10),
  maxStalenessSeconds: parseInt(process.env.KEEPER_MAX_STALENESS || "600", 10),
  maxDeviationBps: parseInt(process.env.KEEPER_MAX_DEVIATION_BPS || "500", 10),
  externalFeedUrl:
    process.env.EXTERNAL_FEED_URL ||
    "https://api.coingecko.com/api/v3/simple/price?ids={symbol}&vs_currencies=usd",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
};

// FIX BE-004: Warn if using insecure HTTP transport for Ethereum RPC
if (DEFAULT_KEEPER_CONFIG.rpcUrl && DEFAULT_KEEPER_CONFIG.rpcUrl.startsWith('http://') && !DEFAULT_KEEPER_CONFIG.rpcUrl.includes('localhost') && !DEFAULT_KEEPER_CONFIG.rpcUrl.includes('127.0.0.1')) {
  console.warn('WARNING: Using insecure HTTP transport for Ethereum RPC. Use HTTPS in production.');
}
// FIX BE-004: Reject insecure HTTP transport in production
if (process.env.NODE_ENV === 'production' && DEFAULT_KEEPER_CONFIG.rpcUrl && !DEFAULT_KEEPER_CONFIG.rpcUrl.startsWith('https://') && !DEFAULT_KEEPER_CONFIG.rpcUrl.startsWith('wss://')) {
  throw new Error('FIX BE-004: Insecure RPC transport in production. RPC_URL must use https:// or wss://');
}

// ============================================================
//                     PURE HELPERS (exported for testing)
// ============================================================

/**
 * Determines if the circuit breaker should be reset based on staleness.
 */
export function shouldResetCircuitBreaker(
  lastUpdateTimestamp: number,
  currentTimestamp: number,
  maxStalenessSeconds: number
): boolean {
  if (lastUpdateTimestamp === 0) return true;
  return currentTimestamp - lastUpdateTimestamp > maxStalenessSeconds;
}

// ============================================================
//                     ABIs
// ============================================================

const PRICE_ORACLE_ABI = [
  "function getPrice(address token) external view returns (uint256)",
  "function getPriceUnsafe(address token) external view returns (uint256)",
  "function lastKnownPrice(address token) external view returns (uint256)",
  "function lastUpdateTimestamp(address token) external view returns (uint256)",
  "function updatePrice(address token) external",
  "function resetLastKnownPrice(address token, uint256 price) external",
  "function circuitBreakerTripped(address token) external view returns (bool)",
  "event PriceUpdated(address indexed token, uint256 price)",
  "event CircuitBreakerTripped(address indexed token, uint256 oraclePrice, uint256 lastKnownPrice)",
  "event CircuitBreakerReset(address indexed token, uint256 newPrice)",
];

// ============================================================
//                     LOGGER
// ============================================================

const logger = createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: format.combine(
    format.timestamp(),
    format.printf(
      ({ timestamp, level, message }) =>
        `${timestamp} [${level.toUpperCase()}] [ORACLE-KEEPER] ${message}`
    )
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: "oracle-keeper.log" }),
  ],
});

// ============================================================
//                     KEEPER CLASS
// ============================================================

function readSecret(name: string, envVar: string): string {
  const secretPath = `/run/secrets/${name}`;
  try {
    if (fs.existsSync(secretPath)) {
      return fs.readFileSync(secretPath, "utf-8").trim();
    }
  } catch {
    /* Fall through to env var */
  }
  return process.env[envVar] || "";
}

// FIX BE-001: secp256k1 curve order — private keys must be in range [1, n-1]
const SECP256K1_N = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"
);

/** FIX BE-001: Validate private key is in valid secp256k1 range and read from secret/env */
function readAndValidatePrivateKey(secretName: string, envVar: string): string {
  const key = readSecret(secretName, envVar);
  if (!key) return "";
  const normalized = key.startsWith("0x") ? key.slice(2) : key;
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`SECURITY: ${envVar} is not a valid private key (expected 64 hex chars)`);
  }
  const keyValue = BigInt("0x" + normalized);
  if (keyValue === 0n || keyValue >= SECP256K1_N) {
    throw new Error(
      `SECURITY: ${envVar} is not a valid secp256k1 private key. ` +
      `Key must be in range [1, curve order-1]`
    );
  }
  return key;
}

export class OracleKeeper {
  private config: OracleKeeperConfig;
  private provider: ethers.JsonRpcProvider;
  private wallet: Wallet;
  private oracle: ethers.Contract;
  private running = false;

  constructor(config: OracleKeeperConfig) {
    this.config = config;

    const fetchReq = new ethers.FetchRequest(config.rpcUrl);
    fetchReq.timeout = parseInt(process.env.RPC_TIMEOUT_MS || "30000", 10);
    this.provider = new ethers.JsonRpcProvider(fetchReq, undefined, {
      staticNetwork: true,
      batchMaxCount: 1,
    });

    this.wallet = new Wallet(config.privateKey, this.provider);
    this.oracle = new ethers.Contract(
      config.priceOracleAddress,
      PRICE_ORACLE_ABI,
      this.wallet
    );
  }

  async start(): Promise<void> {
    logger.info("═══════════════════════════════════════════════════");
    logger.info("  ORACLE KEEPER — Starting");
    logger.info(`  Oracle: ${this.config.priceOracleAddress}`);
    logger.info(
      `  Tokens: ${Object.values(this.config.monitoredTokens).join(", ")}`
    );
    logger.info(
      `  Poll interval: ${this.config.pollIntervalMs / 1000}s`
    );
    logger.info("═══════════════════════════════════════════════════");

    this.running = true;

    while (this.running) {
      try {
        await this.checkAllTokens();
      } catch (err) {
        logger.error(`Check cycle failed: ${(err as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, this.config.pollIntervalMs));
    }
  }

  stop(): void {
    this.running = false;
    logger.info("Oracle keeper stopped.");
  }

  private async checkAllTokens(): Promise<void> {
    for (const [tokenAddr, symbol] of Object.entries(
      this.config.monitoredTokens
    )) {
      try {
        await this.checkToken(tokenAddr, symbol);
      } catch (err) {
        logger.warn(`Failed to check ${symbol}: ${(err as Error).message}`);
      }
    }
  }

  private async checkToken(
    tokenAddr: string,
    symbol: string
  ): Promise<void> {
    // Try getPrice — if it reverts, circuit breaker may be tripped
    try {
      const price = await this.oracle.getPrice(tokenAddr);
      // Price feed is healthy
      logger.debug(`${symbol} price OK: ${ethers.formatUnits(price, 8)}`);
      return;
    } catch {
      logger.warn(`${symbol} getPrice() reverted — circuit breaker likely tripped`);
    }

    // Circuit breaker is tripped — get unsafe price and external feed
    try {
      const unsafePrice = await this.oracle.getPriceUnsafe(tokenAddr);
      const unsafePriceNum = Number(ethers.formatUnits(unsafePrice, 8));

      // Fetch external price for validation
      const externalPrice = await this.fetchExternalPrice(symbol);
      if (externalPrice === null) {
        logger.warn(`${symbol} — cannot validate via external feed, skipping reset`);
        return;
      }

      // Check deviation between oracle and external feed
      const deviationBps = Math.abs(
        ((unsafePriceNum - externalPrice) / externalPrice) * 10_000
      );

      if (deviationBps > this.config.maxDeviationBps) {
        logger.warn(
          `${symbol} — oracle (${unsafePriceNum}) vs external (${externalPrice}) ` +
            `deviation ${deviationBps.toFixed(0)}bps exceeds max ${this.config.maxDeviationBps}bps. NOT resetting.`
        );
        await this.sendAlert(
          `⚠️ *Oracle Deviation Alert*\n${symbol}: ${deviationBps.toFixed(0)}bps deviation\n` +
            `Oracle: $${unsafePriceNum}\nExternal: $${externalPrice}\nManual review required.`
        );
        return;
      }

      // External feed confirms price is valid — reset circuit breaker
      logger.info(
        `${symbol} — external feed confirms price ($${externalPrice}), ` +
          `deviation ${deviationBps.toFixed(0)}bps within tolerance. Resetting circuit breaker.`
      );

      const tx = await this.oracle.resetLastKnownPrice(
        tokenAddr,
        unsafePrice
      );
      const receipt = await tx.wait();
      logger.info(
        `${symbol} — circuit breaker reset in tx ${receipt.hash}`
      );

      await this.sendAlert(
        `✅ *Circuit Breaker Reset*\n${symbol}: $${unsafePriceNum}\n` +
          `External: $${externalPrice}\nDeviation: ${deviationBps.toFixed(0)}bps\nTx: ${receipt.hash}`
      );
    } catch (err) {
      logger.error(
        `${symbol} — circuit breaker reset failed: ${(err as Error).message}`
      );
    }
  }

  private async fetchExternalPrice(
    symbol: string
  ): Promise<number | null> {
    const url = this.config.externalFeedUrl.replace("{symbol}", symbol.toLowerCase());
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) return null;
      const data = await resp.json();
      // CoinGecko format: { "ethereum": { "usd": 2500 } }
      const values = Object.values(data as Record<string, any>);
      if (values.length > 0 && values[0]?.usd) {
        return values[0].usd as number;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async sendAlert(message: string): Promise<void> {
    if (!this.config.telegramBotToken || !this.config.telegramChatId) return;
    try {
      const url = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`;
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.config.telegramChatId,
          text: message,
          parse_mode: "Markdown",
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      logger.warn(`Telegram alert failed: ${(err as Error).message}`);
    }
  }
}

// ============================================================
//                     ENTRYPOINT
// ============================================================

async function main(): Promise<void> {
  // FIX BE-001: Validate private key is in valid secp256k1 range
  const privateKey = readAndValidatePrivateKey("keeper_private_key", "KEEPER_PRIVATE_KEY");
  if (!privateKey) {
    console.error("FATAL: KEEPER_PRIVATE_KEY is required");
    process.exit(1);
  }

  // Parse monitored tokens from env: "0xAddr1:ETH,0xAddr2:USDC"
  const monitoredTokens: Record<string, string> = {};
  const tokensEnv = process.env.MONITORED_TOKENS || "";
  for (const pair of tokensEnv.split(",").filter(Boolean)) {
    const [addr, sym] = pair.split(":");
    if (addr && sym) monitoredTokens[addr.trim()] = sym.trim();
  }

  if (Object.keys(monitoredTokens).length === 0) {
    console.error("FATAL: MONITORED_TOKENS env var is required (format: 0xAddr:SYMBOL,0xAddr:SYMBOL)");
    process.exit(1);
  }

  const config: OracleKeeperConfig = {
    ...DEFAULT_KEEPER_CONFIG,
    privateKey,
    monitoredTokens,
  };

  const keeper = new OracleKeeper(config);

  process.on("SIGINT", () => keeper.stop());
  process.on("SIGTERM", () => keeper.stop());

  await keeper.start();
}

// Only run main when executed directly
if (require.main === module) {
  main().catch((err) => {
    console.error("Oracle keeper crashed:", err);
    process.exit(1);
  });
}
