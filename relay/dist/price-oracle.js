"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.PriceOracleService = exports.fetchTradecraftQuote = exports.fetchTradecraftPoolState = void 0;
const canton_client_1 = require("./canton-client");
const utils_1 = require("./utils");
// INFRA-H-06: Ensure TLS certificate validation is enforced at process level
(0, utils_1.enforceTLSSecurity)();
const DEFAULT_CONFIG = {
    cantonHost: process.env.CANTON_HOST || "localhost",
    cantonPort: parseInt(process.env.CANTON_PORT || "6865", 10),
    cantonToken: (0, utils_1.readSecret)("canton_token", "CANTON_TOKEN"),
    cantonParty: process.env.CANTON_PARTY || "",
    tradecraftBaseUrl: process.env.TRADECRAFT_URL || "https://api.tradecraft.fi/v1",
    templeBaseUrl: process.env.TEMPLE_URL || "https://api.templedigitalgroup.com",
    templeEmail: (0, utils_1.readSecret)("temple_email", "TEMPLE_EMAIL"),
    templePassword: (0, utils_1.readSecret)("temple_password", "TEMPLE_PASSWORD"),
    pollIntervalMs: parseInt(process.env.PRICE_POLL_MS || "30000", 10), // 30s default
    // TS-H-01: Use Number() + validation instead of parseFloat for financial config values
    divergenceThresholdPct: (() => {
        const v = Number(process.env.DIVERGENCE_THRESHOLD || "5.0");
        if (Number.isNaN(v) || v < 0 || v > 100)
            throw new Error("DIVERGENCE_THRESHOLD must be 0-100");
        return v;
    })(),
    maxConsecutiveFailures: parseInt(process.env.MAX_FAILURES || "10", 10),
    stablecoinPrice: 1.0,
    // Off-chain price sanity bounds
    minPriceUsd: (() => {
        const v = Number(process.env.MIN_PRICE_USD || "0.001");
        if (Number.isNaN(v) || v <= 0)
            throw new Error("MIN_PRICE_USD must be positive");
        return v;
    })(),
    maxPriceUsd: (() => {
        const v = Number(process.env.MAX_PRICE_USD || "1000.0");
        if (Number.isNaN(v) || v <= 0)
            throw new Error("MAX_PRICE_USD must be positive");
        return v;
    })(),
    maxChangePerUpdatePct: (() => {
        const v = Number(process.env.MAX_CHANGE_PER_UPDATE_PCT || "25.0");
        if (Number.isNaN(v) || v < 0 || v > 100)
            throw new Error("MAX_CHANGE_PER_UPDATE_PCT must be 0-100");
        return v;
    })(),
};
// INFRA-H-06: Enforce HTTPS for all external API endpoints in production
(0, utils_1.requireHTTPS)(DEFAULT_CONFIG.tradecraftBaseUrl, "TRADECRAFT_URL");
(0, utils_1.requireHTTPS)(DEFAULT_CONFIG.templeBaseUrl, "TEMPLE_URL");
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
async function fetchTradecraftPrice(config) {
    const url = `${config.tradecraftBaseUrl}/ratio/CC/USDCx`;
    const response = await fetch(url, {
        method: "GET",
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(10000), // 10s timeout
    });
    if (!response.ok) {
        throw new Error(`Tradecraft API error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
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
async function fetchTradecraftPoolState(config) {
    const url = `${config.tradecraftBaseUrl}/inspect/CC/USDCx`;
    const response = await fetch(url, {
        method: "GET",
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
        throw new Error(`Tradecraft inspect error: ${response.status}`);
    }
    const data = await response.json();
    return {
        tokenAHoldings: data.token_a_holdings,
        tokenBHoldings: data.token_b_holdings,
        k: data.k,
        totalLpTokens: data.total_lp_token_supply,
    };
}
exports.fetchTradecraftPoolState = fetchTradecraftPoolState;
/**
 * Get a swap quote from Tradecraft for liquidation execution.
 * Endpoint: GET /v1/quoteForFixedInput/CC/USDCx?givingAmount=X
 * Returns how much USDCx the liquidator gets for selling seized CC.
 */
async function fetchTradecraftQuote(config, givingAmountCC) {
    const url = `${config.tradecraftBaseUrl}/quoteForFixedInput/CC/USDCx?givingAmount=${givingAmountCC}`;
    const response = await fetch(url, {
        method: "GET",
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
        throw new Error(`Tradecraft quote error: ${response.status}`);
    }
    const data = await response.json();
    return {
        userGets: data.user_gets,
        effectivePrice: data.user_gets / givingAmountCC,
    };
}
exports.fetchTradecraftQuote = fetchTradecraftQuote;
// ============================================================
//                     TEMPLE CLIENT (FALLBACK)
// ============================================================
let templeJwt = null;
let templeJwtExpiry = 0;
/**
 * Authenticate with Temple DEX API.
 * Endpoint: POST /auth/login
 * JWT expires in 30 minutes.
 */
async function templeLogin(config) {
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
    const data = await response.json();
    templeJwt = data.token;
    templeJwtExpiry = Date.now() + (data.expires_in || 1800) * 1000; // Default 30 min
    return templeJwt;
}
/**
 * Fetch Amulet/USDCx price from Temple DEX.
 * Endpoint: GET /api/v1/market/ticker?symbol=Amulet/USDCx
 * Requires JWT auth.
 */
async function fetchTemplePrice(config) {
    const jwt = await templeLogin(config);
    const response = await fetch(`${config.templeBaseUrl}/api/v1/market/ticker?symbol=Amulet/USDCx`, {
        method: "GET",
        headers: {
            "Accept": "application/json",
            "Authorization": `Bearer ${jwt}`,
        },
        signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
        // JWT might have expired between check and use
        if (response.status === 401) {
            templeJwt = null;
            templeJwtExpiry = 0;
        }
        throw new Error(`Temple API error: ${response.status}`);
    }
    const data = await response.json();
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
class PriceOracleService {
    config;
    canton = null;
    running = false;
    health;
    lastCtnPrice = 0;
    constructor(config = {}) {
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
    async connectLedger() {
        if (this.canton)
            return;
        if (!this.config.cantonParty) {
            throw new Error("CANTON_PARTY not configured");
        }
        // INFRA-H-01 / INF-01: TLS by default for Canton ledger connection
        // INF-01: Reject cleartext HTTP in production — matches relay-service.ts TLS pattern
        if (process.env.CANTON_USE_TLS === "false" && process.env.NODE_ENV === "production") {
            throw new Error("SECURITY: CANTON_USE_TLS=false is FORBIDDEN in production. " +
                "Canton ledger connections must use TLS. Remove CANTON_USE_TLS or set to 'true'.");
        }
        const protocol = process.env.CANTON_USE_TLS === "false" ? "http" : "https";
        this.canton = new canton_client_1.CantonClient({
            baseUrl: `${protocol}://${this.config.cantonHost}:${this.config.cantonPort}`,
            token: this.config.cantonToken,
            userId: "administrator",
            actAs: this.config.cantonParty,
            timeoutMs: 30000,
        });
        console.log(`[PriceOracle] Connected to Canton ledger at ${this.config.cantonHost}:${this.config.cantonPort}`);
    }
    /**
     * Fetch price with fallback logic:
     *   1. Try Tradecraft (primary — no auth, simpler)
     *   2. If Tradecraft fails, try Temple (fallback — JWT auth)
     *   3. If both available, cross-validate and alert on divergence
     */
    async fetchCTNPrice() {
        let tradecraftResult = null;
        let templeResult = null;
        // Try Tradecraft (primary)
        try {
            tradecraftResult = await fetchTradecraftPrice(this.config);
            this.health.tradecraft.consecutiveFailures = 0;
            this.health.tradecraft.lastSuccess = new Date();
            this.health.tradecraft.healthy = true;
            console.log(`[PriceOracle] Tradecraft CC price: $${tradecraftResult.price.toFixed(6)}`);
        }
        catch (err) {
            this.health.tradecraft.consecutiveFailures++;
            this.health.tradecraft.healthy = false;
            console.error(`[PriceOracle] Tradecraft failed (${this.health.tradecraft.consecutiveFailures}x):`, err.message);
        }
        // Try Temple (fallback / cross-validation)
        if (this.config.templeEmail) {
            try {
                templeResult = await fetchTemplePrice(this.config);
                this.health.temple.consecutiveFailures = 0;
                this.health.temple.lastSuccess = new Date();
                this.health.temple.healthy = true;
                console.log(`[PriceOracle] Temple Amulet price: $${templeResult.price.toFixed(6)}`);
            }
            catch (err) {
                this.health.temple.consecutiveFailures++;
                this.health.temple.healthy = false;
                console.error(`[PriceOracle] Temple failed (${this.health.temple.consecutiveFailures}x):`, err.message);
            }
        }
        // Cross-validation: block update if both sources available but diverge
        // Divergence now blocks updates instead of just logging
        if (tradecraftResult && templeResult) {
            const avgPrice = (tradecraftResult.price + templeResult.price) / 2;
            const divergencePct = Math.abs(tradecraftResult.price - templeResult.price) / avgPrice * 100;
            if (divergencePct > this.config.divergenceThresholdPct) {
                console.error(`[PriceOracle] 🚨 PRICE DIVERGENCE BLOCKED: ${divergencePct.toFixed(2)}% ` +
                    `(Tradecraft: $${tradecraftResult.price.toFixed(6)}, Temple: $${templeResult.price.toFixed(6)}). ` +
                    `Update rejected — manual review required.`);
                throw new Error(`Price divergence ${divergencePct.toFixed(2)}% exceeds threshold ${this.config.divergenceThresholdPct}%. ` +
                    `Update blocked for safety.`);
            }
        }
        // Multi-provider averaging for robustness
        // When both sources are available and within divergence threshold, use their
        // average instead of preferring a single source. This prevents manipulation
        // of any single DEX from fully controlling the oracle price.
        if (tradecraftResult && templeResult) {
            const avgPrice = (tradecraftResult.price + templeResult.price) / 2;
            console.log(`[PriceOracle] 🔀 Multi-provider average: $${avgPrice.toFixed(6)} ` +
                `(Tradecraft: $${tradecraftResult.price.toFixed(6)}, Temple: $${templeResult.price.toFixed(6)})`);
            return {
                price: avgPrice,
                source: "multi-provider-avg(tradecraft+temple)",
                timestamp: new Date(),
            };
        }
        // Single-source fallback: Tradecraft > Temple > error
        const result = tradecraftResult || templeResult;
        if (result) {
            console.warn(`[PriceOracle] ⚠️  Single-source price from ${result.source}. ` +
                `Multi-provider averaging unavailable — other source down.`);
        }
        if (!result) {
            // Circuit breaker check
            const totalFailures = this.health.tradecraft.consecutiveFailures +
                this.health.temple.consecutiveFailures;
            if (totalFailures >= this.config.maxConsecutiveFailures) {
                this.health.paused = true;
                console.error(`[PriceOracle] 🛑 CIRCUIT BREAKER: ${totalFailures} consecutive failures. ` +
                    `Oracle paused. On-ledger feeds will go stale → borrows blocked, liquidations still allowed.`);
            }
            throw new Error("All price sources unavailable");
        }
        // NOTE: lastCtnPrice is updated in the poll loop AFTER sanity checks pass
        return result;
    }
    /**
     * Push price update to Canton ledger via PriceFeed_Update choice.
     * The on-ledger CantonPriceFeed enforces ±50% movement cap.
     */
    async pushPriceUpdate(symbol, price, source) {
        await this.connectLedger();
        if (!this.canton) {
            throw new Error("Ledger not connected");
        }
        try {
            // Query the price feed contract by (operator, symbol), then exercise on it
            const feeds = await this.canton.queryContracts((0, canton_client_1.parseTemplateId)("CantonLending:CantonPriceFeed"), (p) => p.operator === this.config.cantonParty && p.symbol === symbol);
            if (feeds.length === 0) {
                throw new Error(`No CantonPriceFeed found for operator=${this.config.cantonParty}, symbol=${symbol}`);
            }
            await this.canton.exerciseChoice((0, canton_client_1.parseTemplateId)("CantonLending:CantonPriceFeed"), feeds[0].contractId, "PriceFeed_Update", {
                newPriceUsd: price.toFixed(18), // Money is Numeric 18
                newSource: source,
            });
            this.health.lastUpdate = new Date();
            console.log(`[PriceOracle] ✅ Updated ${symbol} feed: $${price.toFixed(6)} (${source})`);
        }
        catch (err) {
            const msg = err.message;
            // Handle ±50% cap rejection gracefully
            if (msg.includes("PRICE_MOVE_TOO_LARGE")) {
                console.warn(`[PriceOracle] ⚠️  Price move >50% rejected by on-ledger cap for ${symbol}. ` +
                    `Current on-ledger price too far from $${price.toFixed(6)}. ` +
                    `Manual PriceFeed_EmergencyUpdate may be needed.`);
                return; // Don't throw — this is expected safety behavior
            }
            throw err;
        }
    }
    /**
     * Initialize stable feeds — no longer needed for lending collateral.
     * USDC/USDCx removed as lending collateral types (economically redundant with DirectMint).
     */
    async refreshStableFeeds() {
        // No stable feeds to refresh — USDC/USDCx only used by DirectMint (not lending)
        return;
    }
    /**
     * Main poll loop: fetch CTN price → push to ledger → sleep → repeat
     */
    async start() {
        console.log("[PriceOracle] Starting Canton Price Oracle...");
        console.log(`[PriceOracle] Primary: Tradecraft (${this.config.tradecraftBaseUrl})`);
        console.log(`[PriceOracle] Fallback: Temple (${this.config.templeBaseUrl})`);
        console.log(`[PriceOracle] Poll interval: ${this.config.pollIntervalMs}ms`);
        console.log(`[PriceOracle] Divergence threshold: ${this.config.divergenceThresholdPct}%`);
        await this.connectLedger();
        // Refresh stable feeds on startup
        await this.refreshStableFeeds();
        this.running = true;
        let boundsViolationCount = 0;
        const MAX_BOUNDS_VIOLATIONS = 5; // After N consecutive rejections, reset lastCtnPrice to allow recovery
        while (this.running) {
            if (!this.health.paused) {
                try {
                    const result = await this.fetchCTNPrice();
                    // Off-chain price sanity check (absolute range + rate-of-change)
                    // Compare against lastCtnPrice BEFORE updating it
                    if (result.price < this.config.minPriceUsd || result.price > this.config.maxPriceUsd) {
                        boundsViolationCount++;
                        console.error(`[PriceOracle] 🚨 Price $${result.price.toFixed(6)} outside absolute bounds ` +
                            `[$${this.config.minPriceUsd}, $${this.config.maxPriceUsd}]. Update blocked (${boundsViolationCount}/${MAX_BOUNDS_VIOLATIONS}).`);
                    }
                    else if (this.lastCtnPrice > 0 &&
                        Math.abs(result.price - this.lastCtnPrice) / this.lastCtnPrice * 100 > this.config.maxChangePerUpdatePct) {
                        boundsViolationCount++;
                        console.error(`[PriceOracle] 🚨 Price change ${((result.price - this.lastCtnPrice) / this.lastCtnPrice * 100).toFixed(2)}% ` +
                            `exceeds per-update cap of ${this.config.maxChangePerUpdatePct}%. Update blocked (${boundsViolationCount}/${MAX_BOUNDS_VIOLATIONS}).`);
                    }
                    else {
                        await this.pushPriceUpdate("CTN", result.price, result.source);
                        this.lastCtnPrice = result.price; // Only update AFTER successful push
                        boundsViolationCount = 0; // Reset on success
                    }
                    // If too many consecutive bounds violations, reset baseline to allow recovery
                    if (boundsViolationCount >= MAX_BOUNDS_VIOLATIONS) {
                        console.warn(`[PriceOracle] ⚠️ ${MAX_BOUNDS_VIOLATIONS} consecutive bounds violations. ` +
                            `Resetting lastCtnPrice baseline to allow recovery. Manual review recommended.`);
                        this.lastCtnPrice = 0; // Reset baseline — next cycle will accept any price within absolute bounds
                        boundsViolationCount = 0;
                    }
                }
                catch (err) {
                    console.error("[PriceOracle] Poll cycle failed:", err.message);
                }
            }
            else {
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
    stop() {
        this.running = false;
        console.log("[PriceOracle] Stop requested.");
    }
    /**
     * Reset circuit breaker (manual intervention after investigating)
     */
    resetCircuitBreaker() {
        this.health.paused = false;
        this.health.tradecraft.consecutiveFailures = 0;
        this.health.temple.consecutiveFailures = 0;
        console.log("[PriceOracle] Circuit breaker reset.");
    }
    /**
     * Get current health status (for monitoring / HTTP health endpoint)
     */
    getHealth() {
        return { ...this.health };
    }
    /**
     * Get last known CTN price (for keeper bot)
     */
    getLastCTNPrice() {
        return this.lastCtnPrice;
    }
}
exports.PriceOracleService = PriceOracleService;
// ============================================================
//                     MAIN ENTRY POINT
// ============================================================
async function main() {
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
//# sourceMappingURL=price-oracle.js.map