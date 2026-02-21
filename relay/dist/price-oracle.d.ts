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
interface PriceOracleConfig {
    cantonHost: string;
    cantonPort: number;
    cantonToken: string;
    cantonParty: string;
    tradecraftBaseUrl: string;
    templeBaseUrl: string;
    templeEmail: string;
    templePassword: string;
    pollIntervalMs: number;
    divergenceThresholdPct: number;
    maxConsecutiveFailures: number;
    stablecoinPrice: number;
    minPriceUsd: number;
    maxPriceUsd: number;
    maxChangePerUpdatePct: number;
}
interface PriceResult {
    price: number;
    source: string;
    timestamp: Date;
}
interface HealthStatus {
    tradecraft: {
        healthy: boolean;
        lastSuccess: Date | null;
        consecutiveFailures: number;
    };
    temple: {
        healthy: boolean;
        lastSuccess: Date | null;
        consecutiveFailures: number;
    };
    lastUpdate: Date | null;
    paused: boolean;
}
/**
 * Fetch pool state for depth analysis.
 * Endpoint: GET /v1/inspect/CC/USDCx
 * Used by keeper bot to check if pool can absorb liquidation.
 */
export declare function fetchTradecraftPoolState(config: PriceOracleConfig): Promise<{
    tokenAHoldings: number;
    tokenBHoldings: number;
    k: number;
    totalLpTokens: number;
}>;
/**
 * Get a swap quote from Tradecraft for liquidation execution.
 * Endpoint: GET /v1/quoteForFixedInput/CC/USDCx?givingAmount=X
 * Returns how much USDCx the liquidator gets for selling seized CC.
 */
export declare function fetchTradecraftQuote(config: PriceOracleConfig, givingAmountCC: number): Promise<{
    userGets: number;
    effectivePrice: number;
}>;
export declare class PriceOracleService {
    private config;
    private canton;
    private running;
    private health;
    private lastCtnPrice;
    constructor(config?: Partial<PriceOracleConfig>);
    /**
     * Connect to Canton ledger via JSON API
     */
    private connectLedger;
    /**
     * Fetch price with fallback logic:
     *   1. Try Tradecraft (primary — no auth, simpler)
     *   2. If Tradecraft fails, try Temple (fallback — JWT auth)
     *   3. If both available, cross-validate and alert on divergence
     */
    fetchCTNPrice(): Promise<PriceResult>;
    /**
     * Push price update to Canton ledger via PriceFeed_Update choice.
     * The on-ledger CantonPriceFeed enforces ±50% movement cap.
     */
    pushPriceUpdate(symbol: string, price: number, source: string): Promise<void>;
    /**
     * Initialize stable feeds — no longer needed for lending collateral.
     * USDC/USDCx removed as lending collateral types (economically redundant with DirectMint).
     */
    refreshStableFeeds(): Promise<void>;
    /**
     * Main poll loop: fetch CTN price → push to ledger → sleep → repeat
     */
    start(): Promise<void>;
    /**
     * Stop the oracle gracefully
     */
    stop(): void;
    /**
     * Reset circuit breaker (manual intervention after investigating)
     */
    resetCircuitBreaker(): void;
    /**
     * Get current health status (for monitoring / HTTP health endpoint)
     */
    getHealth(): HealthStatus;
    /**
     * Get last known CTN price (for keeper bot)
     */
    getLastCTNPrice(): number;
}
export {};
//# sourceMappingURL=price-oracle.d.ts.map