/**
 * Minted Protocol — Yield Scanner
 *
 * Scans available DeFi yield opportunities across integrated protocols
 * (Pendle, Aave, Compound, Morpho) and ranks them by risk-adjusted return.
 *
 * Used by TreasuryV2 strategy allocation to decide where idle USDC
 * should be deployed for maximum yield within risk constraints.
 */

// ============================================================
//                     TYPES
// ============================================================

export interface YieldOpportunity {
  /** Protocol name (e.g. "Pendle", "Aave-v3", "Morpho") */
  protocol: string;
  /** Asset being supplied (e.g. "USDC", "sDAI") */
  asset: string;
  /** Chain ID where the opportunity exists */
  chainId: number;
  /** Current APY in basis points (e.g. 500 = 5%) */
  apyBps: number;
  /** Total value locked in USD */
  tvlUsd: number;
  /** Risk tier: 1 = lowest risk (blue-chip lending), 5 = highest */
  riskTier: number;
  /** Strategy contract address on target chain */
  strategyAddress: string;
  /** When this data was last fetched */
  lastUpdated: Date;
  /** Whether this opportunity is currently active / accepting deposits */
  isActive: boolean;
}

export interface ScannerConfig {
  /** Minimum APY (bps) to include in results */
  minApyBps: number;
  /** Maximum risk tier to include */
  maxRiskTier: number;
  /** Minimum TVL (USD) to consider a pool safe */
  minTvlUsd: number;
  /** How often to re-scan (ms) */
  scanIntervalMs: number;
  /** Protocol endpoints */
  endpoints: Record<string, string>;
}

export interface ScanResult {
  opportunities: YieldOpportunity[];
  scannedAt: Date;
  protocolsScanned: number;
  errors: string[];
}

// ============================================================
//                     DEFAULT CONFIG
// ============================================================

const DEFAULT_CONFIG: ScannerConfig = {
  minApyBps: 100,             // 1% minimum
  maxRiskTier: 3,             // Up to medium risk
  minTvlUsd: 1_000_000,      // $1M minimum TVL
  scanIntervalMs: 60_000,    // 1 minute
  endpoints: {
    pendle: process.env.PENDLE_API_URL || "https://api-v2.pendle.finance/core",
    aave: process.env.AAVE_API_URL || "https://aave-api-v2.aave.com",
  },
};

// ============================================================
//                     YIELD SCANNER
// ============================================================

export class YieldScanner {
  private config: ScannerConfig;
  private running = false;
  private lastScan: ScanResult | null = null;

  constructor(config: Partial<ScannerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Perform a single scan across all configured protocols.
   * Returns ranked opportunities filtered by config constraints.
   */
  async scan(): Promise<ScanResult> {
    const errors: string[] = [];
    const opportunities: YieldOpportunity[] = [];
    let protocolsScanned = 0;

    // Scan each configured protocol
    for (const [protocol, endpoint] of Object.entries(this.config.endpoints)) {
      try {
        const results = await this.scanProtocol(protocol, endpoint);
        opportunities.push(...results);
        protocolsScanned++;
      } catch (err) {
        const msg = `Failed to scan ${protocol}: ${(err as Error).message}`;
        errors.push(msg);
        console.warn(`[YieldScanner] ${msg}`);
      }
    }

    // Filter by config constraints
    const filtered = opportunities.filter(
      (o) =>
        o.apyBps >= this.config.minApyBps &&
        o.riskTier <= this.config.maxRiskTier &&
        o.tvlUsd >= this.config.minTvlUsd &&
        o.isActive
    );

    // Sort by risk-adjusted yield (APY / riskTier) descending
    filtered.sort((a, b) => b.apyBps / b.riskTier - a.apyBps / a.riskTier);

    const result: ScanResult = {
      opportunities: filtered,
      scannedAt: new Date(),
      protocolsScanned,
      errors,
    };

    this.lastScan = result;
    return result;
  }

  /**
   * Scan a single protocol for yield opportunities.
   * Subclasses or future implementations will add real API calls.
   */
  private async scanProtocol(
    protocol: string,
    _endpoint: string
  ): Promise<YieldOpportunity[]> {
    // Placeholder — production would call the real API
    console.log(`[YieldScanner] Scanning ${protocol}...`);
    return [];
  }

  /**
   * Get the most recent scan result (cached).
   */
  getLastScan(): ScanResult | null {
    return this.lastScan;
  }

  /**
   * Get the single best opportunity from the last scan.
   */
  getBestOpportunity(): YieldOpportunity | null {
    if (!this.lastScan || this.lastScan.opportunities.length === 0) return null;
    return this.lastScan.opportunities[0];
  }

  /**
   * Start continuous scanning loop.
   */
  async start(): Promise<void> {
    console.log("[YieldScanner] Starting yield scanner...");
    this.running = true;

    while (this.running) {
      try {
        const result = await this.scan();
        console.log(
          `[YieldScanner] Scan complete: ${result.opportunities.length} opportunities, ` +
            `${result.errors.length} errors`
        );
      } catch (err) {
        console.error("[YieldScanner] Scan failed:", (err as Error).message);
      }

      await new Promise((resolve) =>
        setTimeout(resolve, this.config.scanIntervalMs)
      );
    }
  }

  /**
   * Stop the scanner gracefully.
   */
  stop(): void {
    this.running = false;
    console.log("[YieldScanner] Stopped.");
  }
}
