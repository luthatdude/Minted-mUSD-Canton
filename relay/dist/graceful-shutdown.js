"use strict";
/**
 * graceful-shutdown.ts — Shared graceful shutdown module for relay services
 *
 * Provides consistent signal handling, in-flight transaction draining,
 * configurable timeout, and Kubernetes preStop hook support.
 *
 * Usage:
 *   import { GracefulShutdown } from "./graceful-shutdown";
 *
 *   const shutdown = new GracefulShutdown({ timeoutMs: 30_000 });
 *   shutdown.registerCleanup("relay", () => relay.stop());
 *   shutdown.registerCleanup("health", () => healthServer.close());
 *   shutdown.install(); // registers SIGINT, SIGTERM handlers
 *
 *   // In hot-path code, track in-flight work:
 *   shutdown.trackInflight("mint-tx-0x123");
 *   await sendTx();
 *   shutdown.resolveInflight("mint-tx-0x123");
 *
 *   // Check if shutting down (e.g., to reject new work):
 *   if (shutdown.isShuttingDown) return;
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
exports.GracefulShutdown = void 0;
const http = __importStar(require("http"));
// ═══════════════════════════════════════════════════════════════════════════
//                      GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════
class GracefulShutdown {
    timeoutMs;
    preStopPort;
    serviceName;
    exitCode;
    exitOnComplete;
    /** Ordered cleanup callbacks — executed in registration order */
    cleanups = [];
    /** In-flight work items being tracked */
    inflight = new Map();
    /** Whether shutdown has been initiated */
    _isShuttingDown = false;
    /** PreStop HTTP server (if enabled) */
    preStopServer = null;
    /** Resolve function for the shutdown promise (used in tests) */
    shutdownResolve = null;
    /** Promise that resolves when shutdown is complete */
    shutdownComplete;
    constructor(options = {}) {
        this.timeoutMs = options.timeoutMs ?? 30000;
        this.preStopPort = options.preStopPort ?? 0;
        this.serviceName = options.serviceName ?? "Service";
        this.exitCode = options.exitCode ?? 0;
        this.exitOnComplete = options.exitOnComplete ?? true;
        this.shutdownComplete = new Promise((resolve) => {
            this.shutdownResolve = resolve;
        });
    }
    // ─── Public API ──────────────────────────────────────────────────────
    /** Whether shutdown has been initiated */
    get isShuttingDown() {
        return this._isShuttingDown;
    }
    /** Number of in-flight work items */
    get inflightCount() {
        return this.inflight.size;
    }
    /**
     * Register a named cleanup callback.
     * Callbacks are executed in registration order during shutdown.
     */
    registerCleanup(name, fn) {
        this.cleanups.push({ name, fn });
    }
    /**
     * Track an in-flight work item (e.g., a pending transaction).
     * Shutdown will wait for all tracked items to resolve before exiting.
     */
    trackInflight(id) {
        this.inflight.set(id, { startedAt: Date.now() });
    }
    /**
     * Mark an in-flight work item as complete.
     */
    resolveInflight(id) {
        this.inflight.delete(id);
    }
    /**
     * Install signal handlers (SIGINT, SIGTERM) and optionally start
     * the Kubernetes preStop HTTP endpoint.
     */
    install() {
        process.on("SIGINT", () => {
            this.log("SIGINT received");
            this.initiateShutdown();
        });
        process.on("SIGTERM", () => {
            this.log("SIGTERM received");
            this.initiateShutdown();
        });
        // Handle unhandled rejections consistently
        process.on("unhandledRejection", (reason, promise) => {
            console.error(`[${this.serviceName}] Unhandled rejection at:`, promise, "reason:", reason);
            if (!this._isShuttingDown) {
                this.initiateShutdown(1);
            }
        });
        // Start preStop HTTP server if configured
        if (this.preStopPort > 0) {
            this.startPreStopServer();
        }
        this.log(`Graceful shutdown installed (timeout=${this.timeoutMs}ms)`);
    }
    /**
     * Programmatically initiate shutdown (e.g., from a health check failure).
     */
    async initiateShutdown(overrideExitCode) {
        if (this._isShuttingDown) {
            this.log("Shutdown already in progress, ignoring duplicate signal");
            return;
        }
        this._isShuttingDown = true;
        const code = overrideExitCode ?? this.exitCode;
        this.log("Initiating graceful shutdown...");
        // Phase 1: Drain in-flight work (with timeout)
        await this.drainInflight();
        // Phase 2: Execute cleanup callbacks in order
        await this.executeCleanups();
        // Phase 3: Close preStop server
        if (this.preStopServer) {
            this.preStopServer.close();
        }
        this.log("Shutdown complete");
        this.shutdownResolve?.();
        if (this.exitOnComplete) {
            process.exit(code);
        }
    }
    // ─── Internal ────────────────────────────────────────────────────────
    /**
     * Wait for all in-flight work items to complete, with timeout.
     */
    async drainInflight() {
        if (this.inflight.size === 0) {
            this.log("No in-flight work to drain");
            return;
        }
        this.log(`Waiting for ${this.inflight.size} in-flight item(s) to complete...`);
        const deadline = Date.now() + this.timeoutMs;
        const pollInterval = 250; // ms
        while (this.inflight.size > 0 && Date.now() < deadline) {
            await sleep(pollInterval);
        }
        if (this.inflight.size > 0) {
            const remaining = Array.from(this.inflight.keys());
            this.log(`⚠ Timeout reached with ${remaining.length} in-flight item(s) still pending: ${remaining.join(", ")}`);
        }
        else {
            this.log("All in-flight work drained successfully");
        }
    }
    /**
     * Execute all registered cleanup callbacks in order.
     * Each callback gets a per-callback timeout (timeoutMs / cleanups.length, min 5s).
     */
    async executeCleanups() {
        if (this.cleanups.length === 0)
            return;
        const perCleanupTimeout = Math.max(5000, Math.floor(this.timeoutMs / this.cleanups.length));
        for (const { name, fn } of this.cleanups) {
            try {
                this.log(`Running cleanup: ${name}...`);
                await Promise.race([
                    Promise.resolve(fn()),
                    sleep(perCleanupTimeout).then(() => {
                        this.log(`⚠ Cleanup "${name}" timed out after ${perCleanupTimeout}ms`);
                    }),
                ]);
            }
            catch (err) {
                this.log(`⚠ Cleanup "${name}" failed: ${err}`);
            }
        }
    }
    /**
     * Start a minimal HTTP server for Kubernetes preStop hook.
     * POST /prestop → triggers shutdown
     * GET  /healthz → returns 200 if running, 503 if shutting down
     */
    startPreStopServer() {
        this.preStopServer = http.createServer((req, res) => {
            if (req.method === "POST" && req.url === "/prestop") {
                this.log("preStop hook received");
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end("shutting down\n");
                // Give K8s a moment to remove from endpoints before actually shutting down
                setTimeout(() => this.initiateShutdown(), 2000);
                return;
            }
            if (req.method === "GET" && req.url === "/healthz") {
                if (this._isShuttingDown) {
                    res.writeHead(503, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ status: "shutting_down", inflight: this.inflight.size }));
                }
                else {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ status: "ok", inflight: this.inflight.size }));
                }
                return;
            }
            res.writeHead(404);
            res.end();
        });
        const host = "0.0.0.0";
        this.preStopServer.listen(this.preStopPort, host, () => {
            this.log(`preStop server listening on ${host}:${this.preStopPort}`);
        });
    }
    log(msg) {
        console.log(`[${this.serviceName}] ${msg}`);
    }
}
exports.GracefulShutdown = GracefulShutdown;
// ═══════════════════════════════════════════════════════════════════════════
//                          HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=graceful-shutdown.js.map