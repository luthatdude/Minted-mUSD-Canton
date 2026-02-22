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
/// <reference types="node" />
import client, { Registry } from "prom-client";
import * as http from "http";
/** Default registry shared across all services in this process. */
export declare const register: Registry;
/** Total attestations processed by the relay (Canton → Ethereum). */
export declare const attestationsProcessedTotal: client.Counter<"status">;
/** Total bridge-out operations relayed (Ethereum → Canton). */
export declare const bridgeOutsTotal: client.Counter<"status">;
/** Total yield distributions executed by the keeper. */
export declare const yieldDistributionsTotal: client.Counter<"status" | "type">;
/**
 * Bridge validation failures — referenced by prometheus-rules.yaml
 * alert BridgeValidationFailureSpike.
 */
export declare const bridgeValidationFailuresTotal: client.Counter<"reason">;
/**
 * Validator rate-limit hits — referenced by prometheus-rules.yaml
 * alert ValidatorRateLimitExceeded.
 */
export declare const validatorRateLimitHitsTotal: client.Counter<string>;
/** Transaction reverts. */
export declare const txRevertsTotal: client.Counter<"operation">;
/** Nonce collisions detected. */
export declare const nonceCollisionsTotal: client.Counter<string>;
/** Latest Ethereum block scanned by the relay. */
export declare const lastScannedBlock: client.Gauge<string>;
/** Consecutive RPC failures before provider failover. */
export declare const consecutiveFailures: client.Gauge<string>;
/** Whether the anomaly detector has triggered a pause. */
export declare const anomalyPauseTriggered: client.Gauge<string>;
/** Rate-limiter: tx/min slot. */
export declare const rateLimiterTxPerMinute: client.Gauge<string>;
/** Rate-limiter: tx/hour slot. */
export declare const rateLimiterTxPerHour: client.Gauge<string>;
/** Number of in-flight attestations (queued but not yet confirmed). */
export declare const inFlightAttestations: client.Gauge<string>;
/** Process uptime in seconds. */
export declare const uptimeSeconds: client.Gauge<string>;
/** Heap memory used in bytes. */
export declare const heapUsedBytes: client.Gauge<string>;
/** HWM desync flag (Canton ↔ Ethereum high-water-mark mismatch). */
export declare const hwmDesyncFlagged: client.Gauge<string>;
/** Active RPC provider index. */
export declare const activeProviderIndex: client.Gauge<string>;
/** Anomaly detector consecutive reverts. */
export declare const anomalyConsecutiveReverts: client.Gauge<string>;
/** Attestation processing duration end-to-end (seconds). */
export declare const attestationDuration: client.Histogram<string>;
/** Yield distribution transaction duration (seconds). */
export declare const yieldDistributionDuration: client.Histogram<string>;
/** Ethereum RPC call latency (seconds). */
export declare const rpcLatency: client.Histogram<"method">;
/**
 * Return the Prometheus text-format metrics payload.
 * Drop-in replacement for the old JSON `/metrics` handler.
 */
export declare function metricsHandler(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
/**
 * Convenience: start a standalone metrics HTTP server.
 * Used by services that don't already have an HTTP server
 * (e.g., yield-keeper, security-sentinel).
 */
export declare function startMetricsServer(port: number, bindHost?: string): http.Server;
//# sourceMappingURL=metrics.d.ts.map