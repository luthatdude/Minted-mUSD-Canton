"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startMetricsServer = exports.metricsHandler = exports.rpcLatency = exports.yieldDistributionDuration = exports.attestationDuration = exports.cantonApiDuration = exports.orphanRecoveryTotal = exports.cantonApiRetriesTotal = exports.cantonApiErrorsTotal = exports.directionConsecutiveFailures = exports.directionStatus = exports.anomalyConsecutiveReverts = exports.activeProviderIndex = exports.hwmDesyncFlagged = exports.heapUsedBytes = exports.uptimeSeconds = exports.inFlightAttestations = exports.rateLimiterTxPerHour = exports.rateLimiterTxPerMinute = exports.anomalyPauseTriggered = exports.consecutiveFailures = exports.lastScannedBlock = exports.nonceCollisionsTotal = exports.txRevertsTotal = exports.validatorRateLimitHitsTotal = exports.bridgeValidationFailuresTotal = exports.yieldDistributionsTotal = exports.bridgeOutsTotal = exports.attestationsProcessedTotal = exports.register = void 0;
const prom_client_1 = __importStar(require("prom-client"));
const http = __importStar(require("http"));
// ============================================================
//  REGISTRY
// ============================================================
/** Default registry shared across all services in this process. */
exports.register = new prom_client_1.default.Registry();
// Collect Node.js runtime metrics (GC, event loop lag, memory, etc.)
(0, prom_client_1.collectDefaultMetrics)({ register: exports.register, prefix: "minted_" });
// ============================================================
//  COUNTERS
// ============================================================
/** Total attestations processed by the relay (Canton → Ethereum). */
exports.attestationsProcessedTotal = new prom_client_1.Counter({
    name: "minted_attestations_processed_total",
    help: "Total Canton attestations bridged to Ethereum",
    labelNames: ["status"], // success | revert | error
    registers: [exports.register],
});
/** Total bridge-out operations relayed (Ethereum → Canton). */
exports.bridgeOutsTotal = new prom_client_1.Counter({
    name: "minted_bridge_outs_total",
    help: "Total Ethereum bridge-out events relayed to Canton",
    labelNames: ["status"],
    registers: [exports.register],
});
/** Total yield distributions executed by the keeper. */
exports.yieldDistributionsTotal = new prom_client_1.Counter({
    name: "minted_yield_distributions_total",
    help: "Total yield distribution transactions executed",
    labelNames: ["type", "status"], // type: usdc | ethpool
    registers: [exports.register],
});
/**
 * Bridge validation failures — referenced by prometheus-rules.yaml
 * alert BridgeValidationFailureSpike.
 */
exports.bridgeValidationFailuresTotal = new prom_client_1.Counter({
    name: "minted_bridge_validation_failures_total",
    help: "Total attestation validation failures",
    labelNames: ["reason"],
    registers: [exports.register],
});
/**
 * Validator rate-limit hits — referenced by prometheus-rules.yaml
 * alert ValidatorRateLimitExceeded.
 */
exports.validatorRateLimitHitsTotal = new prom_client_1.Counter({
    name: "minted_validator_rate_limit_hits_total",
    help: "Total rate-limit rejections on validator signing",
    registers: [exports.register],
});
/** Transaction reverts. */
exports.txRevertsTotal = new prom_client_1.Counter({
    name: "minted_tx_reverts_total",
    help: "Total on-chain transaction reverts",
    labelNames: ["operation"],
    registers: [exports.register],
});
/** Nonce collisions detected. */
exports.nonceCollisionsTotal = new prom_client_1.Counter({
    name: "minted_nonce_collisions_total",
    help: "Total Ethereum nonce collisions detected",
    registers: [exports.register],
});
// ============================================================
//  GAUGES
// ============================================================
/** Latest Ethereum block scanned by the relay. */
exports.lastScannedBlock = new prom_client_1.Gauge({
    name: "minted_relay_last_scanned_block",
    help: "Latest Ethereum block number scanned by the relay",
    registers: [exports.register],
});
/** Consecutive RPC failures before provider failover. */
exports.consecutiveFailures = new prom_client_1.Gauge({
    name: "minted_relay_consecutive_failures",
    help: "Consecutive RPC call failures",
    registers: [exports.register],
});
/** Whether the anomaly detector has triggered a pause. */
exports.anomalyPauseTriggered = new prom_client_1.Gauge({
    name: "minted_anomaly_detector_pause_triggered",
    help: "1 if anomaly detector has paused the relay, 0 otherwise",
    registers: [exports.register],
});
/** Rate-limiter: tx/min slot. */
exports.rateLimiterTxPerMinute = new prom_client_1.Gauge({
    name: "minted_rate_limiter_tx_per_minute",
    help: "Transactions submitted in the current minute window",
    registers: [exports.register],
});
/** Rate-limiter: tx/hour slot. */
exports.rateLimiterTxPerHour = new prom_client_1.Gauge({
    name: "minted_rate_limiter_tx_per_hour",
    help: "Transactions submitted in the current hour window",
    registers: [exports.register],
});
/** Number of in-flight attestations (queued but not yet confirmed). */
exports.inFlightAttestations = new prom_client_1.Gauge({
    name: "minted_relay_in_flight_attestations",
    help: "Attestations currently in-flight (submitted, awaiting confirmation)",
    registers: [exports.register],
});
/** Process uptime in seconds. */
exports.uptimeSeconds = new prom_client_1.Gauge({
    name: "minted_relay_uptime_seconds",
    help: "Process uptime in seconds",
    registers: [exports.register],
});
/** Heap memory used in bytes. */
exports.heapUsedBytes = new prom_client_1.Gauge({
    name: "minted_relay_heap_used_bytes",
    help: "V8 heap used in bytes",
    registers: [exports.register],
});
/** HWM desync flag (Canton ↔ Ethereum high-water-mark mismatch). */
exports.hwmDesyncFlagged = new prom_client_1.Gauge({
    name: "minted_hwm_desync_flagged",
    help: "1 if high-water-mark desync detected between Canton and Ethereum",
    registers: [exports.register],
});
/** Active RPC provider index. */
exports.activeProviderIndex = new prom_client_1.Gauge({
    name: "minted_relay_active_provider_index",
    help: "Index of the currently active RPC provider",
    registers: [exports.register],
});
/** Anomaly detector consecutive reverts. */
exports.anomalyConsecutiveReverts = new prom_client_1.Gauge({
    name: "minted_anomaly_consecutive_reverts",
    help: "Anomaly detector consecutive revert count",
    registers: [exports.register],
});
// ============================================================
//  BRIDGE HARDENING — Per-direction & Canton API observability
// ============================================================
/**
 * Per-direction health status gauge.
 *   direction: "attestations" | "bridge_out_watcher" | "canton_bridge_outs" | "yield_bridge_in" | "ethpool_yield_bridge_in"
 *   Values: 0 = ok, 1 = degraded (retryable errors), 2 = failed (permanent error)
 */
exports.directionStatus = new prom_client_1.Gauge({
    name: "minted_relay_direction_status",
    help: "Health status of each relay direction (0=ok, 1=degraded, 2=failed)",
    labelNames: ["direction"],
    registers: [exports.register],
});
/** Per-direction consecutive failure count. */
exports.directionConsecutiveFailures = new prom_client_1.Gauge({
    name: "minted_relay_direction_consecutive_failures",
    help: "Consecutive failures for each relay direction",
    labelNames: ["direction"],
    registers: [exports.register],
});
/**
 * Canton API errors by HTTP status code and endpoint.
 * Enables alerting on 413 (payload too large), 429 (rate limit), 503 (unavailable).
 */
exports.cantonApiErrorsTotal = new prom_client_1.Counter({
    name: "minted_canton_api_errors_total",
    help: "Canton API errors by status code and path",
    labelNames: ["status", "path"],
    registers: [exports.register],
});
/** Canton API retry attempts. */
exports.cantonApiRetriesTotal = new prom_client_1.Counter({
    name: "minted_canton_api_retries_total",
    help: "Canton API retry attempts by status code and path",
    labelNames: ["status", "path"],
    registers: [exports.register],
});
/** Orphan CantonMUSD recovery attempts. */
exports.orphanRecoveryTotal = new prom_client_1.Counter({
    name: "minted_orphan_recovery_total",
    help: "Orphan CantonMUSD recovery attempts",
    labelNames: ["status"], // success | error | skipped
    registers: [exports.register],
});
/** Canton API call duration (seconds). */
exports.cantonApiDuration = new prom_client_1.Histogram({
    name: "minted_canton_api_duration_seconds",
    help: "Canton API call duration",
    labelNames: ["method", "path"],
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
    registers: [exports.register],
});
// ============================================================
//  HISTOGRAMS
// ============================================================
/** Attestation processing duration end-to-end (seconds). */
exports.attestationDuration = new prom_client_1.Histogram({
    name: "minted_attestation_processing_duration_seconds",
    help: "End-to-end attestation processing duration",
    buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
    registers: [exports.register],
});
/** Yield distribution transaction duration (seconds). */
exports.yieldDistributionDuration = new prom_client_1.Histogram({
    name: "minted_yield_distribution_duration_seconds",
    help: "Yield distribution transaction duration",
    buckets: [1, 5, 10, 30, 60, 120, 300],
    registers: [exports.register],
});
/** Ethereum RPC call latency (seconds). */
exports.rpcLatency = new prom_client_1.Histogram({
    name: "minted_rpc_call_duration_seconds",
    help: "Ethereum JSON-RPC call latency",
    labelNames: ["method"],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [exports.register],
});
// ============================================================
//  METRICS HTTP HANDLER
// ============================================================
/**
 * Return the Prometheus text-format metrics payload.
 * Drop-in replacement for the old JSON `/metrics` handler.
 */
async function metricsHandler(_req, res) {
    // Refresh uptime & memory gauges every scrape
    exports.uptimeSeconds.set(Math.floor(process.uptime()));
    exports.heapUsedBytes.set(process.memoryUsage().heapUsed);
    try {
        const payload = await exports.register.metrics();
        res.writeHead(200, { "Content-Type": exports.register.contentType });
        res.end(payload);
    }
    catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("# Error collecting metrics\n");
    }
}
exports.metricsHandler = metricsHandler;
/**
 * Convenience: start a standalone metrics HTTP server.
 * Used by services that don't already have an HTTP server
 * (e.g., yield-keeper, security-sentinel).
 */
function startMetricsServer(port, bindHost = "127.0.0.1") {
    const server = http.createServer(async (req, res) => {
        if (req.url === "/metrics") {
            await metricsHandler(req, res);
        }
        else if (req.url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
        }
        else {
            res.writeHead(404);
            res.end();
        }
    });
    server.listen(port, bindHost, () => {
        console.log(`[Metrics] Prometheus endpoint on ${bindHost}:${port}/metrics`);
    });
    return server;
}
exports.startMetricsServer = startMetricsServer;
//# sourceMappingURL=metrics.js.map