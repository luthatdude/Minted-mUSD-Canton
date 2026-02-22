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
export interface ShutdownOptions {
    /** Maximum time (ms) to wait for in-flight work before force-exit. Default: 30000 */
    timeoutMs?: number;
    /** Port for Kubernetes preStop HTTP endpoint. 0 = disabled. Default: 0 */
    preStopPort?: number;
    /** Service name for log prefixes. Default: "Service" */
    serviceName?: string;
    /** Exit code on clean shutdown. Default: 0 */
    exitCode?: number;
    /** Whether to call process.exit() at the end. Default: true (set false for tests) */
    exitOnComplete?: boolean;
}
export type CleanupFn = () => void | Promise<void>;
export declare class GracefulShutdown {
    private readonly timeoutMs;
    private readonly preStopPort;
    private readonly serviceName;
    private readonly exitCode;
    private readonly exitOnComplete;
    /** Ordered cleanup callbacks — executed in registration order */
    private readonly cleanups;
    /** In-flight work items being tracked */
    private readonly inflight;
    /** Whether shutdown has been initiated */
    private _isShuttingDown;
    /** PreStop HTTP server (if enabled) */
    private preStopServer;
    /** Resolve function for the shutdown promise (used in tests) */
    private shutdownResolve;
    /** Promise that resolves when shutdown is complete */
    readonly shutdownComplete: Promise<void>;
    constructor(options?: ShutdownOptions);
    /** Whether shutdown has been initiated */
    get isShuttingDown(): boolean;
    /** Number of in-flight work items */
    get inflightCount(): number;
    /**
     * Register a named cleanup callback.
     * Callbacks are executed in registration order during shutdown.
     */
    registerCleanup(name: string, fn: CleanupFn): void;
    /**
     * Track an in-flight work item (e.g., a pending transaction).
     * Shutdown will wait for all tracked items to resolve before exiting.
     */
    trackInflight(id: string): void;
    /**
     * Mark an in-flight work item as complete.
     */
    resolveInflight(id: string): void;
    /**
     * Install signal handlers (SIGINT, SIGTERM) and optionally start
     * the Kubernetes preStop HTTP endpoint.
     */
    install(): void;
    /**
     * Programmatically initiate shutdown (e.g., from a health check failure).
     */
    initiateShutdown(overrideExitCode?: number): Promise<void>;
    /**
     * Wait for all in-flight work items to complete, with timeout.
     */
    private drainInflight;
    /**
     * Execute all registered cleanup callbacks in order.
     * Each callback gets a per-callback timeout (timeoutMs / cleanups.length, min 5s).
     */
    private executeCleanups;
    /**
     * Start a minimal HTTP server for Kubernetes preStop hook.
     * POST /prestop → triggers shutdown
     * GET  /healthz → returns 200 if running, 503 if shutting down
     */
    private startPreStopServer;
    private log;
}
//# sourceMappingURL=graceful-shutdown.d.ts.map