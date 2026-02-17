/**
 * YieldScanner — scans DeFi protocols for yield opportunities.
 *
 * Filters by APY, risk tier, TVL, and active status.
 * Used by the bot service to find the best yield opportunities.
 */

export interface YieldOpportunity {
  protocol: string;
  asset: string;
  chainId: number;
  apyBps: number;
  tvlUsd: number;
  riskTier: number;
  strategyAddress: string;
  lastUpdated: Date;
  isActive: boolean;
}

export interface ScanResult {
  opportunities: YieldOpportunity[];
  scannedAt: Date;
  protocolsScanned: number;
  errors: string[];
}

export interface YieldScannerConfig {
  scanIntervalMs?: number;
  minApyBps?: number;
  maxRiskTier?: number;
  minTvlUsd?: number;
}

const DEFAULT_CONFIG: Required<YieldScannerConfig> = {
  scanIntervalMs: 60_000,
  minApyBps: 100,
  maxRiskTier: 3,
  minTvlUsd: 1_000_000,
};

export class YieldScanner {
  private config: Required<YieldScannerConfig>;
  private lastScan: ScanResult | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(config?: YieldScannerConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Scan all registered protocols and return filtered, sorted opportunities. */
  async scan(): Promise<ScanResult> {
    const raw = await this.scanProtocols();
    const filtered = raw.filter(
      (o) =>
        o.apyBps >= this.config.minApyBps &&
        o.riskTier <= this.config.maxRiskTier &&
        o.tvlUsd >= this.config.minTvlUsd &&
        o.isActive,
    );

    // Sort by risk-adjusted yield descending
    filtered.sort((a, b) => b.apyBps / b.riskTier - a.apyBps / a.riskTier);

    const result: ScanResult = {
      opportunities: filtered,
      scannedAt: new Date(),
      protocolsScanned: 0,
      errors: [],
    };

    this.lastScan = result;
    return result;
  }

  /** Return the best (highest risk-adjusted) opportunity from the last scan, or null. */
  getBestOpportunity(): YieldOpportunity | null {
    if (!this.lastScan || this.lastScan.opportunities.length === 0) return null;
    return this.lastScan.opportunities[0];
  }

  /** Return the full last scan result, or null if no scan has been performed. */
  getLastScan(): ScanResult | null {
    return this.lastScan;
  }

  /** Stop the periodic scanner (no-op if not started). */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Placeholder protocol scanner — returns empty array in test/dev.
   *  INFO-02: Callers should check result length and log if empty.
   *  In production, integrate with DeFi Llama / on-chain strategy queries. */
  private async scanProtocols(): Promise<YieldOpportunity[]> {
    console.warn(
      "[YieldScanner] scanProtocols() is a stub — returning empty array. " +
      "Integrate with DeFi Llama or on-chain queries for production use."
    );
    return [];
  }
}
