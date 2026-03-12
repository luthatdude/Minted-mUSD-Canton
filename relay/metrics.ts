/**
 * Minted Protocol — Prometheus Metrics Module
 *
 * Shared instrumentation for all relay/bot services.
 * Exports counters, gauges, and histograms that align with
 * k8s/monitoring/prometheus-rules.yaml alert expressions and
 * k8s/monitoring/grafana-dashboards.yaml panel queries.
 *
 * Metrics naming convention:  minted_<subsystem>_<metric>_<unit>
 *
 * AUDIT TRAIL: Item-10 — Remove placeholder-only metrics; deliver
 * production Prometheus instrumentation.
 */

import client, {
  Registry,
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
} from "prom-client";
import * as http from "http";

// ============================================================
//  REGISTRY
// ============================================================

/** Default registry shared across all services in this process. */
export const register: Registry = new client.Registry();

// Collect Node.js runtime metrics (GC, event loop lag, memory, etc.)
collectDefaultMetrics({ register, prefix: "minted_" });

// ============================================================
//  COUNTERS
// ============================================================

/** Total attestations processed by the relay (Canton → Ethereum). */
export const attestationsProcessedTotal = new Counter({
  name: "minted_attestations_processed_total",
  help: "Total Canton attestations bridged to Ethereum",
  labelNames: ["status"] as const, // success | revert | error
  registers: [register],
});

/** Total bridge-out operations relayed (Ethereum → Canton). */
export const bridgeOutsTotal = new Counter({
  name: "minted_bridge_outs_total",
  help: "Total Ethereum bridge-out events relayed to Canton",
  labelNames: ["status"] as const,
  registers: [register],
});

/** Total yield distributions executed by the keeper. */
export const yieldDistributionsTotal = new Counter({
  name: "minted_yield_distributions_total",
  help: "Total yield distribution transactions executed",
  labelNames: ["type", "status"] as const, // type: usdc | ethpool
  registers: [register],
});

/**
 * Bridge validation failures — referenced by prometheus-rules.yaml
 * alert BridgeValidationFailureSpike.
 */
export const bridgeValidationFailuresTotal = new Counter({
  name: "minted_bridge_validation_failures_total",
  help: "Total attestation validation failures",
  labelNames: ["reason"] as const,
  registers: [register],
});

/**
 * Validator rate-limit hits — referenced by prometheus-rules.yaml
 * alert ValidatorRateLimitExceeded.
 */
export const validatorRateLimitHitsTotal = new Counter({
  name: "minted_validator_rate_limit_hits_total",
  help: "Total rate-limit rejections on validator signing",
  registers: [register],
});

/** Transaction reverts. */
export const txRevertsTotal = new Counter({
  name: "minted_tx_reverts_total",
  help: "Total on-chain transaction reverts",
  labelNames: ["operation"] as const,
  registers: [register],
});

/** Nonce collisions detected. */
export const nonceCollisionsTotal = new Counter({
  name: "minted_nonce_collisions_total",
  help: "Total Ethereum nonce collisions detected",
  registers: [register],
});

// ============================================================
//  GAUGES
// ============================================================

/** Latest Ethereum block scanned by the relay. */
export const lastScannedBlock = new Gauge({
  name: "minted_relay_last_scanned_block",
  help: "Latest Ethereum block number scanned by the relay",
  registers: [register],
});

/** Consecutive RPC failures before provider failover. */
export const consecutiveFailures = new Gauge({
  name: "minted_relay_consecutive_failures",
  help: "Consecutive RPC call failures",
  registers: [register],
});

/** Whether the anomaly detector has triggered a pause. */
export const anomalyPauseTriggered = new Gauge({
  name: "minted_anomaly_detector_pause_triggered",
  help: "1 if anomaly detector has paused the relay, 0 otherwise",
  registers: [register],
});

/** Rate-limiter: tx/min slot. */
export const rateLimiterTxPerMinute = new Gauge({
  name: "minted_rate_limiter_tx_per_minute",
  help: "Transactions submitted in the current minute window",
  registers: [register],
});

/** Rate-limiter: tx/hour slot. */
export const rateLimiterTxPerHour = new Gauge({
  name: "minted_rate_limiter_tx_per_hour",
  help: "Transactions submitted in the current hour window",
  registers: [register],
});

/** Number of in-flight attestations (queued but not yet confirmed). */
export const inFlightAttestations = new Gauge({
  name: "minted_relay_in_flight_attestations",
  help: "Attestations currently in-flight (submitted, awaiting confirmation)",
  registers: [register],
});

/** Process uptime in seconds. */
export const uptimeSeconds = new Gauge({
  name: "minted_relay_uptime_seconds",
  help: "Process uptime in seconds",
  registers: [register],
});

/** Heap memory used in bytes. */
export const heapUsedBytes = new Gauge({
  name: "minted_relay_heap_used_bytes",
  help: "V8 heap used in bytes",
  registers: [register],
});

/** HWM desync flag (Canton ↔ Ethereum high-water-mark mismatch). */
export const hwmDesyncFlagged = new Gauge({
  name: "minted_hwm_desync_flagged",
  help: "1 if high-water-mark desync detected between Canton and Ethereum",
  registers: [register],
});

/** Active RPC provider index. */
export const activeProviderIndex = new Gauge({
  name: "minted_relay_active_provider_index",
  help: "Index of the currently active RPC provider",
  registers: [register],
});

/** Anomaly detector consecutive reverts. */
export const anomalyConsecutiveReverts = new Gauge({
  name: "minted_anomaly_consecutive_reverts",
  help: "Anomaly detector consecutive revert count",
  registers: [register],
});

/** Whether the configured Canton package ID is present on the ledger. */
export const packageIdPresent = new Gauge({
  name: "minted_relay_package_id_present",
  help: "1 if configured Canton package ID is present on ledger, 0 otherwise",
  registers: [register],
});

/** Whether a package ID mismatch has been detected. */
export const packageMismatch = new Gauge({
  name: "minted_relay_package_mismatch",
  help: "1 if package ID mismatch detected, 0 otherwise",
  registers: [register],
});

// ============================================================
//  BRIDGE HARDENING — Per-direction & Canton API observability
// ============================================================

/**
 * Per-direction health status gauge.
 *   direction: "attestations" | "bridge_out_watcher" | "canton_bridge_outs" | "yield_bridge_in" | "ethpool_yield_bridge_in"
 *   Values: 0 = ok, 1 = degraded (retryable errors), 2 = failed (permanent error)
 */
export const directionStatus = new Gauge({
  name: "minted_relay_direction_status",
  help: "Health status of each relay direction (0=ok, 1=degraded, 2=failed)",
  labelNames: ["direction"] as const,
  registers: [register],
});

/** Per-direction consecutive failure count. */
export const directionConsecutiveFailures = new Gauge({
  name: "minted_relay_direction_consecutive_failures",
  help: "Consecutive failures for each relay direction",
  labelNames: ["direction"] as const,
  registers: [register],
});

/**
 * Canton API errors by HTTP status code and endpoint.
 * Enables alerting on 413 (payload too large), 429 (rate limit), 503 (unavailable).
 */
export const cantonApiErrorsTotal = new Counter({
  name: "minted_canton_api_errors_total",
  help: "Canton API errors by status code and path",
  labelNames: ["status", "path"] as const,
  registers: [register],
});

/** Canton API retry attempts. */
export const cantonApiRetriesTotal = new Counter({
  name: "minted_canton_api_retries_total",
  help: "Canton API retry attempts by status code and path",
  labelNames: ["status", "path"] as const,
  registers: [register],
});

/** Orphan CantonMUSD recovery attempts. */
export const orphanRecoveryTotal = new Counter({
  name: "minted_orphan_recovery_total",
  help: "Orphan CantonMUSD recovery attempts",
  labelNames: ["status"] as const, // success | error | skipped
  registers: [register],
});

/** Canton API call duration (seconds). */
export const cantonApiDuration = new Histogram({
  name: "minted_canton_api_duration_seconds",
  help: "Canton API call duration",
  labelNames: ["method", "path"] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

// ============================================================
//  HISTOGRAMS
// ============================================================

/** Attestation processing duration end-to-end (seconds). */
export const attestationDuration = new Histogram({
  name: "minted_attestation_processing_duration_seconds",
  help: "End-to-end attestation processing duration",
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
  registers: [register],
});

/** Yield distribution transaction duration (seconds). */
export const yieldDistributionDuration = new Histogram({
  name: "minted_yield_distribution_duration_seconds",
  help: "Yield distribution transaction duration",
  buckets: [1, 5, 10, 30, 60, 120, 300],
  registers: [register],
});

/** Ethereum RPC call latency (seconds). */
export const rpcLatency = new Histogram({
  name: "minted_rpc_call_duration_seconds",
  help: "Ethereum JSON-RPC call latency",
  labelNames: ["method"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

// ============================================================
//  METRICS HTTP HANDLER
// ============================================================

/**
 * Return the Prometheus text-format metrics payload.
 * Drop-in replacement for the old JSON `/metrics` handler.
 */
export async function metricsHandler(
  _req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  // Refresh uptime & memory gauges every scrape
  uptimeSeconds.set(Math.floor(process.uptime()));
  heapUsedBytes.set(process.memoryUsage().heapUsed);

  try {
    const payload = await register.metrics();
    res.writeHead(200, { "Content-Type": register.contentType });
    res.end(payload);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("# Error collecting metrics\n");
  }
}

/**
 * Convenience: start a standalone metrics HTTP server.
 * Used by services that don't already have an HTTP server
 * (e.g., yield-keeper, security-sentinel).
 */
export function startMetricsServer(
  port: number,
  bindHost = "127.0.0.1"
): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/metrics") {
      await metricsHandler(req, res);
    } else if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, bindHost, () => {
    console.log(`[Metrics] Prometheus endpoint on ${bindHost}:${port}/metrics`);
  });

  return server;
}
