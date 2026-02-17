/**
 * Minted Protocol — PriceOracle Circuit Breaker Keeper
 *
 * Automates PriceOracle circuit breaker resets.
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
// INFRA-H-02: Removed dotenv - never load .env files that may contain
// NODE_TLS_REJECT_UNAUTHORIZED=0 or private keys. Use Docker secrets or env vars.
import * as fs from "fs";
import { createLogger, format, transports } from "winston";

// INFRA-H-02 / INFRA-H-06: Enforce TLS certificate validation at process level
if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    console.error("[SECURITY] NODE_TLS_REJECT_UNAUTHORIZED=0 is FORBIDDEN in production. Overriding to 1.");
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
  }
}

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
  // TS-H-03: Use CoinGecko Pro API when API key is available (higher rate limits)
  externalFeedUrl:
    process.env.EXTERNAL_FEED_URL ||
    (process.env.COINGECKO_API_KEY
      ? "https://pro-api.coingecko.com/api/v3/simple/price?ids={symbol}&vs_currencies=usd"
      : "https://api.coingecko.com/api/v3/simple/price?ids={symbol}&vs_currencies=usd"),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
};

// Warn if using insecure HTTP transport for Ethereum RPC
if (DEFAULT_KEEPER_CONFIG.rpcUrl && DEFAULT_KEEPER_CONFIG.rpcUrl.startsWith('http://') && !DEFAULT_KEEPER_CONFIG.rpcUrl.includes('localhost') && !DEFAULT_KEEPER_CONFIG.rpcUrl.includes('127.0.0.1')) {
  console.warn('WARNING: Using insecure HTTP transport for Ethereum RPC. Use HTTPS in production.');
}
// Reject insecure HTTP transport in production
if (process.env.NODE_ENV === 'production' && DEFAULT_KEEPER_CONFIG.rpcUrl && !DEFAULT_KEEPER_CONFIG.rpcUrl.startsWith('https://') && !DEFAULT_KEEPER_CONFIG.rpcUrl.startsWith('wss://')) {
  throw new Error('Insecure RPC transport in production. RPC_URL must use https:// or wss://');
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

// secp256k1 curve order — private keys must be in range [1, n-1]
const SECP256K1_N = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"
);

/** Validate private key is in valid secp256k1 range and read from secret/env */
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

    // Guard against raw private key usage in production
    if (process.env.NODE_ENV === "production" && !process.env.KMS_KEY_ID) {
      throw new Error(
        "SECURITY: Raw private key usage is forbidden in production. " +
        "Configure KMS_KEY_ID, KMS_PROVIDER, and KMS_REGION environment variables. " +
        "See relay/kms-ethereum-signer.ts for KMS signer implementation."
      );
    }
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
    // INFRA-H-06: Validate external feed URL uses HTTPS
    if (!url.startsWith("https://")) {
      logger.warn(`${symbol} — external feed URL does not use HTTPS: ${url.substring(0, 50)}`);
      if (process.env.NODE_ENV === "production") {
        logger.error(`${symbol} — HTTPS required for external feeds in production`);
        return null;
      }
    }
    try {
      // TS-H-03: Include API key header for authenticated CoinGecko access
      const headers: Record<string, string> = {};
      const apiKey = process.env.COINGECKO_API_KEY;
      if (apiKey) {
        headers[url.includes("pro-api.coingecko.com") ? "x-cg-pro-api-key" : "x-cg-demo-api-key"] = apiKey;
      } else if (process.env.NODE_ENV === "production") {
        logger.warn(`${symbol} — COINGECKO_API_KEY not set; external feed is rate-limited`);
      }
      const resp = await fetch(url, { signal: AbortSignal.timeout(10_000), headers });
      if (!resp.ok) return null;
      const data = await resp.json();

      // Prevents MITM/malformed response from injecting arbitrary price data.
      // Expected format: { "ethereum": { "usd": 2500.0 } }
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        logger.warn(`${symbol} — external feed returned non-object response`);
        return null;
      }
      const values = Object.values(data as Record<string, unknown>);
      if (values.length !== 1) {
        logger.warn(`${symbol} — external feed returned unexpected number of entries: ${values.length}`);
        return null;
      }
      const entry = values[0];
      if (typeof entry !== "object" || entry === null || !("usd" in entry)) {
        logger.warn(`${symbol} — external feed entry missing 'usd' field`);
        return null;
      }
      const price = (entry as Record<string, unknown>).usd;
      if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
        logger.warn(`${symbol} — external feed returned invalid price: ${price}`);
        return null;
      }
      // Sanity bound: reject prices outside $0.0001 — $10M range
      if (price < 0.0001 || price > 10_000_000) {
        logger.warn(`${symbol} — external price $${price} outside sanity bounds [$0.0001, $10M]`);
        return null;
      }
      return price;
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
  // Validate private key is in valid secp256k1 range
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
