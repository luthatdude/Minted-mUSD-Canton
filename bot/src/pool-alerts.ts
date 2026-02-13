/**
 * Minted Protocol - Pool Alerts
 *
 * Monitors on-chain pool metrics and sends alerts when thresholds are breached.
 * Integrates with Telegram and Discord for notifications.
 *
 * Monitored conditions:
 *   - Utilisation rate exceeds threshold (e.g., >90%)
 *   - TVL drops below minimum
 *   - Oracle price deviation exceeds bounds
 *   - Circuit breaker trips
 *   - Large deposits/withdrawals
 */

export interface AlertConfig {
  /** Maximum utilisation rate before alerting (BPS) */
  maxUtilisationBps: number;
  /** Minimum TVL threshold (USD, 6 decimals) */
  minTvlUsd: bigint;
  /** Maximum price deviation before alerting (BPS) */
  maxDeviationBps: number;
  /** Minimum deposit/withdrawal size to alert on (USD, 6 decimals) */
  whaleThresholdUsd: bigint;
}

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  maxUtilisationBps: 9000, // 90%
  minTvlUsd: 1_000_000n * 1_000_000n, // $1M
  maxDeviationBps: 200, // 2%
  whaleThresholdUsd: 100_000n * 1_000_000n, // $100K
};

export interface Alert {
  severity: "info" | "warning" | "critical";
  category: string;
  message: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

/**
 * PoolAlertMonitor watches on-chain state and emits alerts.
 * Currently a stub — full implementation requires event subscription setup.
 */
export class PoolAlertMonitor {
  private config: AlertConfig;
  private running = false;

  constructor(config: AlertConfig = DEFAULT_ALERT_CONFIG) {
    this.config = config;
  }

  async start(): Promise<void> {
    console.log("[PoolAlerts] Starting pool monitor...");
    this.running = true;
    // TODO: Subscribe to contract events for real-time monitoring
    console.warn("[PoolAlerts] Stub — full implementation pending");
  }

  stop(): void {
    this.running = false;
    console.log("[PoolAlerts] Stopped");
  }
}
