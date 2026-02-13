/**
 * Minted Protocol - Bot HTTP Server
 *
 * Health check and metrics endpoint for bot services.
 * Kubernetes liveness/readiness probes hit these endpoints.
 */

import http from "http";

export interface ServerConfig {
  port: number;
  healthPath: string;
}

const DEFAULT_SERVER_CONFIG: ServerConfig = {
  port: Number(process.env.BOT_PORT) || 8080,
  healthPath: "/health",
};

/**
 * Start a lightweight HTTP server for health checks.
 * Returns a handle to stop the server gracefully.
 */
export function startHealthServer(
  config: ServerConfig = DEFAULT_SERVER_CONFIG,
  isHealthy: () => boolean = () => true,
): { stop: () => void } {
  const server = http.createServer((req, res) => {
    if (req.url === config.healthPath && req.method === "GET") {
      const healthy = isHealthy();
      res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: healthy ? "ok" : "unhealthy", timestamp: Date.now() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(config.port, () => {
    console.log(`[HealthServer] Listening on port ${config.port}`);
  });

  return {
    stop: () => {
      server.close();
    },
  };
}
