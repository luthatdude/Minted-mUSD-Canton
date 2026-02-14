/**
 * graceful-shutdown.ts — GAP-6: Graceful shutdown utility with drain timeout.
 *
 * Previously each relay/validator service had its own shutdown handler that called
 * process.exit(0) immediately, potentially aborting in-flight bridge transactions
 * or leaving partial state. This utility:
 *
 *   1. Registers SIGTERM + SIGINT handlers (idempotent — safe to call multiple times)
 *   2. Waits for a configurable drain period to let in-flight ops complete
 *   3. Force-exits after timeout to prevent hanging in Kubernetes pod termination
 *   4. Logs shutdown lifecycle for forensics
 *
 * Usage:
 *   import { registerGracefulShutdown } from "./graceful-shutdown";
 *   registerGracefulShutdown("BridgeRelay", () => relay.stop(), { drainTimeoutMs: 15000 });
 */

export interface GracefulShutdownOptions {
  /** How long to wait for in-flight operations to drain (default: 10s) */
  drainTimeoutMs?: number;
  /** Callback to invoke on shutdown (e.g., stop polling, close connections) */
  onShutdown?: () => void | Promise<void>;
  /** Optional health server to close */
  healthServer?: { close: (cb?: () => void) => void };
}

let shutdownInitiated = false;

export function registerGracefulShutdown(
  serviceName: string,
  stopFn: () => void | Promise<void>,
  options: GracefulShutdownOptions = {}
): void {
  const drainTimeout = options.drainTimeoutMs ?? 10_000;

  const shutdown = async (signal: string) => {
    if (shutdownInitiated) {
      console.log(`[${serviceName}] Duplicate ${signal} received — already shutting down`);
      return;
    }
    shutdownInitiated = true;

    console.log(`\n[${serviceName}] ${signal} received — initiating graceful shutdown`);
    console.log(`[${serviceName}] Drain timeout: ${drainTimeout}ms`);

    // Set a hard deadline to prevent hanging forever during pod termination
    const forceExitTimer = setTimeout(() => {
      console.error(`[${serviceName}] Drain timeout exceeded — forcing exit`);
      process.exit(1);
    }, drainTimeout);
    // Unref so the timer doesn't keep the event loop alive if everything else finishes
    forceExitTimer.unref();

    try {
      // Stop the main service (finish current loop iteration, close connections)
      await stopFn();
      console.log(`[${serviceName}] Service stopped`);

      // Close health check server if provided
      if (options.healthServer) {
        await new Promise<void>((resolve) => {
          options.healthServer!.close(() => resolve());
        });
        console.log(`[${serviceName}] Health server closed`);
      }

      // Run any additional shutdown callback
      if (options.onShutdown) {
        await options.onShutdown();
      }

      console.log(`[${serviceName}] Graceful shutdown complete`);
      clearTimeout(forceExitTimer);
      process.exit(0);
    } catch (err) {
      console.error(`[${serviceName}] Error during shutdown:`, err);
      clearTimeout(forceExitTimer);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Also handle uncaught errors during shutdown
  process.on("unhandledRejection", (reason, promise) => {
    console.error(`[${serviceName}] Unhandled rejection:`, reason);
    if (!shutdownInitiated) {
      process.exit(1);
    }
  });
}
