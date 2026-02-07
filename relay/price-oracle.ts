/**
 * Minted Protocol - Canton Price Oracle Service
 *
 * Polls Tradecraft DEX (primary) and Temple DEX (fallback) for CC/USDCx price,
 * then pushes updates to CantonPriceFeed contracts on the Canton ledger.
 *
 * Data Sources:
 *   Primary:  Tradecraft API — GET /v1/ratio/CC/USDCx (no auth, AMM-based)
 *   Fallback: Temple API    — GET /api/v1/market/ticker?symbol=Amulet/USDCx (JWT auth)
 *
 * Supported Feeds:
 *   - CTN  → Tradecraft ratio CC/USDCx (volatile, polled every interval)
 *   - USDC → Hardcoded 1.0 (stable, updated only on service start)
 *   - USDCx → Hardcoded 1.0 (stable, updated only on service start)
 *   - sMUSD → Synced from yield-sync-service globalSharePrice (not handled here)
 *
 * Safety:
 *   - Cross-validates Tradecraft vs Temple prices; alerts if >5% divergence
 *   - CantonPriceFeed on-ledger enforces ±50% movement cap per update
 *   - Staleness: feeds older than 1h block new borrows (but not liquidations)
 *   - Circuit breaker: pauses on repeated API failures
 */

import Ledger from "@daml/ledger";
import { readSecret } from "./utils";

// ============================================================
//                     CONFIGURATION
// ============================================================

interface PriceOracleConfig {
  // Canton Ledger
  cantonHost: string;
  cantonPort: number;
  cantonToken: string;
  cantonParty: string;    // Operator party

  // Tradecraft (primary — no auth)
  tradecraftBaseUrl: string;

  // Temple (fallback — JWT auth)
  templeBaseUrl: string;
  templeEmail: string;
  templePassword: string;

  // Oracle parameters
  pollIntervalMs: number;       // How often to fetch prices
  divergenceThresholdPct: number; // Alert if sources diverge > this %
  maxConsecutiveFailures: number; // Circuit breaker threshold
  stablecoinPrice: number;      // Hardcoded USDC/USDCx price
}

const DEFAULT_CONFIG: PriceOracleConfig = {
  cantonHost: process.env.CANTON_HOST || "localhost",
  cantonPort: parseInt(process.env.CANTON_PORT || "6865", 10),
  cantonToken: readSecret("canton_token", "CANTON_TOKEN"),
  cantonParty: process.env.CANTON_PARTY || "",

  tradecraftBaseUrl: process.env.TRADECRAFT_URL || "https://api.tradecraft.fi/v1",
  templeBaseUrl: process.env.TEMPLE_URL || "https://api.templedigitalgroup.com",
  templeEmail: readSecret("temple_email", "TEMPLE_EMAIL"),
  templePassword: readSecret("temple_password", "TEMPLE_PASSWORD"),

  pollIntervalMs: parseInt(process.env.PRICE_POLL_MS || "30000", 10),  // 30s default
  divergenceThresholdPct: parseFloat(process.env.DIVERGENCE_THRESHOLD || "5.0"),
  maxConsecutiveFailures: parseInt(process.env.MAX_FAILURES || "10", 10),
  stablecoinPrice: 1.0,
};

// ============================================================
//                     PRICE SOURCE TYPES
// ============================================================

interface PriceResult {
  price: number;
  source: string;
  timestamp: Date;
}

interface HealthStatus {
  tradecraft: { healthy: boolean; lastSuccess: Date | null; consecutiveFailures: number };
  temple: { healthy: boolean; lastSuccess: Date | null; consecutiveFailures: number };
  lastUpdate: Date | null;
  paused: boolean;
}

// ============================================================
//                     TRADECRAFT CLIENT
// ============================================================

/**
 * Fetch CC/USDCx price ratio from Tradecraft DEX.
 * Endpoint: GET /v1/ratio/CC/USDCx
 * Response: { "price_of_b_in_a": 2 }
 * Meaning: 1 CC = 2 USDCx → price of CC in USDCx terms
 *
 * No authentication required.
 */
async function fetchTradecraftPrice(config: PriceOracleConfig): Promise<PriceResult> {
  const url = `${config.tradecraftBaseUrl}/ratio/CC/USDCx`;
  const response = await fetch(url, {
    method: "GET",
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(10000), // 10s timeout
  });

  if (!response.ok) {
    throw new Error(`Tradecraft API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { price_of_b_in_a: number };

  if (typeof data.price_of_b_in_a !== "number" || data.price_of_b_in_a <= 0) {
    throw new Error(`Tradecraft returned invalid price: ${JSON.stringify(data)}`);
  }

  // price_of_b_in_a = how much USDCx per CC
  // Since USDCx ≈ 1 USD, this is effectively the USD price of CC
  // But the ratio endpoint returns "price of B in terms of A"
  // So ratio/CC/USDCx → price of USDCx in CC terms
  // We need the inverse: price of CC in USDCx (USD) terms
  const priceOfCcInUsdcx = 1 / data.price_of_b_in_a;

  return {
    price: priceOfCcInUsdcx,
    source: "tradecraft-amm",
    timestamp: new Date(),
  };
}

/**
 * Fetch pool state for depth analysis.
 * Endpoint: GET /v1/inspect/CC/USDCx
 * Used by keeper bot to check if pool can absorb liquidation.
 */
export async function fetchTradecraftPoolState(config: PriceOracleConfig): Promise<{
  tokenAHoldings: number;
  tokenBHoldings: number;
  k: number;
  totalLpTokens: number;
}> {
  const url = `${config.tradecraftBaseUrl}/inspect/CC/USDCx`;
  const response = await fetch(url, {
    method: "GET",
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Tradecraft inspect error: ${response.status}`);
  }

  const data = await response.json() as {
    token_a_holdings: number;
    token_b_holdings: number;
    k: number;
    total_lp_token_supply: number;
  };

  return {
    tokenAHoldings: data.token_a_holdings,
    tokenBHoldings: data.token_b_holdings,
    k: data.k,
    totalLpTokens: data.total_lp_token_supply,
  };
}

/**
 * Get a swap quote from Tradecraft for liquidation execution.
 * Endpoint: GET /v1/quoteForFixedInput/CC/USDCx?givingAmount=X
 * Returns how much USDCx the liquidator gets for selling seized CC.
 */
export async function fetchTradecraftQuote(
  config: PriceOracleConfig,
  givingAmountCC: number
): Promise<{ userGets: number; effectivePrice: number }> {
  const url = `${config.tradecraftBaseUrl}/quoteForFixedInput/CC/USDCx?givingAmount=${givingAmountCC}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Tradecraft quote error: ${response.status}`);
  }

  const data = await response.json() as { user_gets: number };

  return {
    userGets: data.user_gets,
    effectivePrice: data.user_gets / givingAmountCC,
  };
}

// ============================================================
//                     TEMPLE CLIENT (FALLBACK)
// ============================================================

let templeJwt: string | null = null;
let templeJwtExpiry: number = 0;

/**
 * Authenticate with Temple DEX API.
 * Endpoint: POST /auth/login
 * JWT expires in 30 minutes.
 */
async function templeLogin(config: PriceOracleConfig): Promise<string> {
  // Check if existing JWT is still valid (with 2-min buffer)
  if (templeJwt && Date.now() < templeJwtExpiry - 120000) {
    return templeJwt;
  }

  if (!config.templeEmail || !config.templePassword) {
    throw new Error("Temple credentials not configured — fallback unavailable");
  }

  const response = await fetch(`${config.templeBaseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: config.templeEmail,
      password: config.templePassword,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Temple auth failed: ${response.status}`);
  }

  const data = await response.json() as { token: string; expires_in?: number };
  templeJwt = data.token;
  templeJwtExpiry = Date.now() + (data.expires_in || 1800) * 1000; // Default 30 min

  return templeJwt!;
}

/**
 * Fetch Amulet/USDCx price from Temple DEX.
 * Endpoint: GET /api/v1/market/ticker?symbol=Amulet/USDCx
 * Requires JWT auth.
 */
async function fetchTemplePrice(config: PriceOracleConfig): Promise<PriceResult> {
  const jwt = await templeLogin(config);

  const response = await fetch(
    `${config.templeBaseUrl}/api/v1/market/ticker?symbol=Amulet/USDCx`,
    {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${jwt}`,
      },
      signal: AbortSignal.timeout(10000),
    }
  );

  if (!response.ok) {
    // JWT might have expired between check and use
    if (response.status === 401) {
      templeJwt = null;
      templeJwtExpiry = 0;
    }
    throw new Error(`Temple API error: ${response.status}`);
  }

  const data = await response.json() as { last_price: number; last_trade_ts: string };

  if (typeof data.last_price !== "number" || data.last_price <= 0) {
    throw new Error(`Temple returned invalid price: ${JSON.stringify(data)}`);
  }

  return {
    price: data.last_price,
    source: "temple-dex",
    timestamp: new Date(data.last_trade_ts || Date.now()),
  };
}

// ============================================================
//                     PRICE ORACLE SERVICE
// ============================================================

export class PriceOracleService {
  private config: PriceOracleConfig;
  private ledger: Ledger | null = null;
  private running = false;
  private health: HealthStatus;
  private lastCtnPrice: number = 0;

  constructor(config: Partial<PriceOracleConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.health = {
      tradecraft: { healthy: true, lastSuccess: null, consecutiveFailures: 0 },
      temple: { healthy: true, lastSuccess: null, consecutiveFailures: 0 },
      lastUpdate: null,
      paused: false,
    };
  }

  /**
   * Connect to Canton ledger via JSON API
   */
  private async connectLedger(): Promise<void> {
    if (this.ledger) return;

    if (!this.config.cantonParty) {
      throw new Error("CANTON_PARTY not configured");
    }

    this.ledger = new Ledger({
      token: this.config.cantonToken,
      httpBaseUrl: `http://${this.config.cantonHost}:${this.config.cantonPort}`,
      wsBaseUrl: `ws://${this.config.cantonHost}:${this.config.cantonPort}`,
    });

    console.log(`[PriceOracle] Connected to Canton ledger at ${this.config.cantonHost}:${this.config.cantonPort}`);
  }

  /**
   * Fetch price with fallback logic:
   *   1. Try Tradecraft (primary — no auth, simpler)
   *   2. If Tradecraft fails, try Temple (fallback — JWT auth)
   *   3. If both available, cross-validate and alert on divergence
   */
  async fetchCTNPrice(): Promise<PriceResult> {
    let tradecraftResult: PriceResult | null = null;
    let templeResult: PriceResult | null = null;

    // Try Tradecraft (primary)
    try {
      tradecraftResult = await fetchTradecraftPrice(this.config);
      this.health.tradecraft.consecutiveFailures = 0;
      this.health.tradecraft.lastSuccess = new Date();
      this.health.tradecraft.healthy = true;
      console.log(`[PriceOracle] Tradecraft CC price: $${tradecraftResult.price.toFixed(6)}`);
    } catch (err) {
      this.health.tradecraft.consecutiveFailures++;
      this.health.tradecraft.healthy = false;
      console.error(`[PriceOracle] Tradecraft failed (${this.health.tradecraft.consecutiveFailures}x):`, (err as Error).message);
    }

    // Try Temple (fallback / cross-validation)
    if (this.config.templeEmail) {
      try {
        templeResult = await fetchTemplePrice(this.config);
        this.health.temple.consecutiveFailures = 0;
        this.health.temple.lastSuccess = new Date();
        this.health.temple.healthy = true;
        console.log(`[PriceOracle] Temple Amulet price: $${templeResult.price.toFixed(6)}`);
      } catch (err) {
        this.health.temple.consecutiveFailures++;
        this.health.temple.healthy = false;
        console.error(`[PriceOracle] Temple failed (${this.health.temple.consecutiveFailures}x):`, (err as Error).message);
      }
    }

    // Cross-validation: alert if both sources available but diverge
    if (tradecraftResult && templeResult) {
      const avgPrice = (tradecraftResult.price + templeResult.price) / 2;
      const divergencePct = Math.abs(tradecraftResult.price - templeResult.price) / avgPrice * 100;

      if (divergencePct > this.config.divergenceThresholdPct) {
        console.warn(
          `[PriceOracle] ⚠️  PRICE DIVERGENCE: ${divergencePct.toFixed(2)}% ` +
          `(Tradecraft: $${tradecraftResult.price.toFixed(6)}, Temple: $${templeResult.price.toFixed(6)}). ` +
          `Using Tradecraft (AMM — harder to manipulate).`
        );
        // TODO: Send alert to monitoring (PagerDuty / Slack webhook)
      }
    }

    // Pick result: Tradecraft > Temple > error
    const result = tradecraftResult || templeResult;
    if (!result) {
      // Circuit breaker check
      const totalFailures =
        this.health.tradecraft.consecutiveFailures +
        this.health.temple.consecutiveFailures;

      if (totalFailures >= this.config.maxConsecutiveFailures) {
        this.health.paused = true;
        console.error(
          `[PriceOracle] 🛑 CIRCUIT BREAKER: ${totalFailures} consecutive failures. ` +
          `Oracle paused. On-ledger feeds will go stale → borrows blocked, liquidations still allowed.`
        );
      }

      throw new Error("All price sources unavailable");
    }

    this.lastCtnPrice = result.price;
    return result;
  }

  /**
   * Push price update to Canton ledger via PriceFeed_Update choice.
   * The on-ledger CantonPriceFeed enforces ±50% movement cap.
   */
  async pushPriceUpdate(symbol: string, price: number, source: string): Promise<void> {
    await this.connectLedger();

    if (!this.ledger) {
      throw new Error("Ledger not connected");
    }

    try {
      // Exercise PriceFeed_Update on the keyed contract (operator, symbol)
      // Using DAML JSON API exerciseByKey
      await this.ledger.exerciseByKey(
        // Template ID — must match codegen
        "CantonLending:CantonPriceFeed" as any,
        // Key: (operator, symbol)
        { _1: this.config.cantonParty, _2: symbol },
        // Choice name
        "PriceFeed_Update",
        // Choice arguments
        {
          newPriceUsd: price.toFixed(18), // Money is Numeric 18
          newSource: source,
        }
      );

      this.health.lastUpdate = new Date();
      console.log(`[PriceOracle] ✅ Updated ${symbol} feed: $${price.toFixed(6)} (${source})`);
    } catch (err) {
      const msg = (err as Error).message;

      // Handle ±50% cap rejection gracefully
      if (msg.includes("PRICE_MOVE_TOO_LARGE")) {
        console.warn(
          `[PriceOracle] ⚠️  Price move >50% rejected by on-ledger cap for ${symbol}. ` +
          `Current on-ledger price too far from $${price.toFixed(6)}. ` +
          `Manual PriceFeed_EmergencyUpdate may be needed.`
        );
        return; // Don't throw — this is expected safety behavior
      }

      throw err;
    }
  }

  /**
   * Initialize stable feeds (USDC, USDCx) — called once on startup.
   * These don't change, but we refresh the timestamp to prevent staleness.
   */
  async refreshStableFeeds(): Promise<void> {
    const stableSymbols = ["USDC", "USDCx"];

    for (const symbol of stableSymbols) {
      try {
        await this.pushPriceUpdate(symbol, this.config.stablecoinPrice, "hardcoded-stable");
        console.log(`[PriceOracle] Refreshed ${symbol} feed (${this.config.stablecoinPrice})`);
      } catch (err) {
        // Feed might not exist yet — that's OK on first run
        console.warn(`[PriceOracle] Could not refresh ${symbol} feed:`, (err as Error).message);
      }
    }
  }

  /**
   * Main poll loop: fetch CTN price → push to ledger → sleep → repeat
   */
  async start(): Promise<void> {
    console.log("[PriceOracle] Starting Canton Price Oracle...");
    console.log(`[PriceOracle] Primary: Tradecraft (${this.config.tradecraftBaseUrl})`);
    console.log(`[PriceOracle] Fallback: Temple (${this.config.templeBaseUrl})`);
    console.log(`[PriceOracle] Poll interval: ${this.config.pollIntervalMs}ms`);
    console.log(`[PriceOracle] Divergence threshold: ${this.config.divergenceThresholdPct}%`);

    await this.connectLedger();

    // Refresh stable feeds on startup
    await this.refreshStableFeeds();

    this.running = true;

    while (this.running) {
      if (!this.health.paused) {
        try {
          const result = await this.fetchCTNPrice();
          await this.pushPriceUpdate("CTN", result.price, result.source);
        } catch (err) {
          console.error("[PriceOracle] Poll cycle failed:", (err as Error).message);
        }
      } else {
        console.warn("[PriceOracle] 🛑 Oracle paused (circuit breaker). Waiting for manual intervention.");
      }

      // Sleep
      await new Promise((resolve) => setTimeout(resolve, this.config.pollIntervalMs));
    }

    console.log("[PriceOracle] Stopped.");
  }

  /**
   * Stop the oracle gracefully
   */
  stop(): void {
    this.running = false;
    console.log("[PriceOracle] Stop requested.");
  }

  /**
   * Reset circuit breaker (manual intervention after investigating)
   */
  resetCircuitBreaker(): void {
    this.health.paused = false;
    this.health.tradecraft.consecutiveFailures = 0;
    this.health.temple.consecutiveFailures = 0;
    console.log("[PriceOracle] Circuit breaker reset.");
  }

  /**
   * Get current health status (for monitoring / HTTP health endpoint)
   */
  getHealth(): HealthStatus {
    return { ...this.health };
  }

  /**
   * Get last known CTN price (for keeper bot)
   */
  getLastCTNPrice(): number {
    return this.lastCtnPrice;
  }
}

// ============================================================
//                     MAIN ENTRY POINT
// ============================================================

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════");
  console.log("  Minted Protocol — Canton Price Oracle");
  console.log("  Primary: Tradecraft DEX | Fallback: Temple DEX");
  console.log("═══════════════════════════════════════════════════");

  const oracle = new PriceOracleService();

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n[PriceOracle] SIGINT received, shutting down...");
    oracle.stop();
  });

  process.on("SIGTERM", () => {
    console.log("[PriceOracle] SIGTERM received, shutting down...");
    oracle.stop();
  });

  await oracle.start();
}

main().catch((err) => {
  console.error("[PriceOracle] Fatal error:", err);
  process.exit(1);
});
