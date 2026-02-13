// ═══════════════════════════════════════════════════════════════════════════
// Yield Scanner — API Server
// ═══════════════════════════════════════════════════════════════════════════
// Exposes the latest scan results via HTTP for the frontend Stake page.
// Runs alongside the main scanner. Uses the scanner output data.
//
// Endpoints:
//   GET  /api/yields              — Latest top pools (raw yield)
//   GET  /api/yields/loops        — Latest loop opportunities
//   GET  /api/yields/status       — Scanner status & last scan time
//   GET  /api/yields/protocols    — Protocol security database
//   GET  /health                  — Health check
//
// Run:  npx ts-node src/yield-api.ts
// ═══════════════════════════════════════════════════════════════════════════

import * as http from "http";
import { createLogger, format, transports } from "winston";

// Enforce TLS certificate validation
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
  throw new Error("[YieldAPI] NODE_TLS_REJECT_UNAUTHORIZED=0 is forbidden");
}

// Handle unhandled promise rejections to prevent silent failures
process.on('unhandledRejection', (reason, promise) => {
  console.error('FATAL: Unhandled promise rejection:', reason);
  process.exit(1);
});

// Handle uncaught exceptions to prevent silent crashes
process.on('uncaughtException', (error) => {
  console.error('FATAL: Uncaught exception:', error);
  process.exit(1);
});

const logger = createLogger({
  level: "info",
  format: format.combine(
    format.timestamp(),
    format.printf(({ timestamp, level, message }) =>
      `${timestamp} [${level.toUpperCase()}] [YIELD-API] ${message}`
    )
  ),
  transports: [new transports.Console()],
});

const PORT = parseInt(process.env.YIELD_API_PORT || "3211", 10);

// ═══════════════════════════════════════════════════════════════════════════
//                      IN-MEMORY STORE
// ═══════════════════════════════════════════════════════════════════════════

interface PoolData {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apyBase: number | null;
  apyReward: number | null;
  apy: number | null;
  stablecoin: boolean;
  securityScore: number;
  curatorScore: number;
  overallScore: number;
  isPT: boolean;
  ptExpiry: string | null;
}

interface LoopData {
  symbol: string;
  project: string;
  chain: string;
  borrowProtocol: string;
  supplyApy: number;
  borrowRate: number;
  ltv: number;
  loops: number;
  leverage: number;
  netApy: number;
  riskLevel: string;
  tvlUsd: number;
}

interface ScanResult {
  pools: PoolData[];
  loops: LoopData[];
  scanTimestamp: number;
  scanNumber: number;
  poolsScanned: number;
}

let latestResult: ScanResult = {
  pools: [],
  loops: [],
  scanTimestamp: 0,
  scanNumber: 0,
  poolsScanned: 0,
};

// ═══════════════════════════════════════════════════════════════════════════
//   DATA FETCHER — Runs on same schedule as scanner, stores results
// ═══════════════════════════════════════════════════════════════════════════

const DEFI_LLAMA_URL = "https://yields.llama.fi/pools";

const STABLECOIN_KEYWORDS = [
  "usdc", "usdt", "dai", "usde", "susde", "frax", "lusd", "gusd",
  "musd", "gho", "cusd", "pyusd", "usdm", "usdd", "tusd",
  "susd", "usds", "susds", "usd+", "rlusd", "usda",
];

const PROTOCOL_SECURITY: Record<string, { score: number; tier: string }> = {
  "aave-v3": { score: 95, tier: "S" },
  "morpho-blue": { score: 90, tier: "S" },
  "compound-v3": { score: 92, tier: "S" },
  "pendle": { score: 88, tier: "A" },
  "sky-savings-rate": { score: 90, tier: "S" },
  "spark": { score: 88, tier: "A" },
  "ethena": { score: 75, tier: "B" },
  "fluid": { score: 80, tier: "A" },
  "euler": { score: 78, tier: "B" },
  "lido": { score: 93, tier: "S" },
  "rocket-pool": { score: 90, tier: "S" },
  "frax-lend": { score: 85, tier: "A" },
  "curve-dex": { score: 85, tier: "A" },
  "default": { score: 40, tier: "D" },
};

// Borrow rates are FALLBACK ESTIMATES — allow env-driven overrides
const BORROW_RATES: Record<string, number> = (() => {
  const defaults: Record<string, number> = {
    "aave-v3": 3.5,
    "morpho-blue": 6.0,
    "compound-v3": 4.2,
    "spark": 5.5,
  };
  const overrides = process.env.BORROW_RATE_OVERRIDES;
  if (overrides) {
    try {
      const parsed = JSON.parse(overrides);
      for (const [protocol, rate] of Object.entries(parsed)) {
        if (typeof rate === "number") defaults[protocol] = rate;
        // Also accept nested format: {"aave-v3": {"USDC": 4.0}} → use first value
        if (typeof rate === "object" && rate !== null) {
          const values = Object.values(rate as Record<string, number>);
          if (values.length > 0) defaults[protocol] = values[0];
        }
      }
    } catch (e) {
      console.error("[Yield-API] Invalid BORROW_RATE_OVERRIDES JSON:", e);
    }
  }
  return defaults;
})();

const SCAN_CHAINS = (process.env.SCANNER_CHAINS || "Ethereum,Arbitrum,Base").split(",");
const MIN_TVL = parseFloat(process.env.SCANNER_MIN_TVL || "1000000");
const MIN_APY = parseFloat(process.env.SCANNER_MIN_APY || "3");
const DEFAULT_LTV = parseFloat(process.env.SCANNER_DEFAULT_LTV || "0.50");
const MAX_LOOPS = parseInt(process.env.SCANNER_MAX_LOOPS || "5", 10);
const MAX_RESULTS = parseInt(process.env.SCANNER_MAX_RESULTS || "15", 10);

interface RawPool {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apyBase: number | null;
  apyReward: number | null;
  apy: number | null;
  stablecoin: boolean;
  exposure: string;
  poolMeta: string | null;
}

let scanCount = 0;

async function fetchAndProcess(): Promise<void> {
  scanCount++;
  logger.info(`Running API scan #${scanCount}`);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000); // 30s timeout
    let resp: Response;
    try {
      resp = await fetch(DEFI_LLAMA_URL, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!resp.ok) {
      logger.error(`DeFi Llama returned ${resp.status}`);
      return;
    }
    // Schema validation — verify response structure before using
    const text = await resp.text();
    const MAX_RESPONSE_SIZE = 50 * 1024 * 1024; // 50MB
    if (text.length > MAX_RESPONSE_SIZE) {
      logger.error(`Response too large: ${(text.length / 1e6).toFixed(1)}MB`);
      return;
    }
    const json = JSON.parse(text) as { data?: RawPool[] };
    if (!json.data || !Array.isArray(json.data)) {
      logger.error("DeFi Llama response missing 'data' array — schema mismatch");
      return;
    }
    const allPools = json.data;
    logger.info(`Fetched ${allPools.length} pools from DeFi Llama`);

    // Filter
    const filtered = allPools.filter((p) => {
      if (!SCAN_CHAINS.some((c) => c.toLowerCase() === p.chain.toLowerCase())) return false;
      if (p.tvlUsd < MIN_TVL) return false;
      const baseApy = p.apyBase ?? p.apy ?? 0;
      if (baseApy < MIN_APY) return false;
      // Only stablecoins
      const sym = p.symbol.toLowerCase();
      if (!STABLECOIN_KEYWORDS.some((kw) => sym.includes(kw))) return false;
      return true;
    });

    // Score & sort
    const scored: PoolData[] = filtered.map((p) => {
      const key = p.project.toLowerCase().replace(/\s+/g, "-");
      const sec = PROTOCOL_SECURITY[key] || PROTOCOL_SECURITY["default"];
      const tvlScore = Math.min(100, (p.tvlUsd / 100_000_000) * 100);
      const apyScore = Math.min(100, ((p.apyBase ?? 0) / 20) * 100);
      const overall = sec.score * 0.4 + tvlScore * 0.25 + apyScore * 0.25 + 50 * 0.1;

      return {
        pool: p.pool,
        chain: p.chain,
        project: p.project,
        symbol: p.symbol,
        tvlUsd: p.tvlUsd,
        apyBase: p.apyBase,
        apyReward: p.apyReward,
        apy: p.apy,
        stablecoin: p.stablecoin,
        securityScore: sec.score,
        curatorScore: sec.score,
        overallScore: Math.round(overall),
        isPT: p.symbol.toLowerCase().includes("pt-") || (p.poolMeta?.includes("maturity") ?? false),
        ptExpiry: p.poolMeta?.match(/\d{4}-\d{2}-\d{2}/)?.[0] || null,
      };
    });

    scored.sort((a, b) => b.overallScore - a.overallScore);
    const topPools = scored.slice(0, MAX_RESULTS);

    // Find loop opportunities
    const loops: LoopData[] = [];
    for (const pool of scored) {
      for (const [protocol, rate] of Object.entries(BORROW_RATES)) {
        const supplyApy = pool.apyBase ?? 0;
        const spread = supplyApy - rate;
        if (spread <= 0) continue;

        const ltv = DEFAULT_LTV;
        let leverage = 1;
        let factor = 1;
        for (let i = 0; i < MAX_LOOPS; i++) {
          factor *= ltv;
          leverage += factor;
        }
        const netApy = supplyApy * leverage - rate * (leverage - 1);
        if (netApy < 8) continue;

        loops.push({
          symbol: pool.symbol,
          project: pool.project,
          chain: pool.chain,
          borrowProtocol: protocol,
          supplyApy,
          borrowRate: rate,
          ltv,
          loops: MAX_LOOPS,
          leverage: Math.round(leverage * 100) / 100,
          netApy: Math.round(netApy * 100) / 100,
          riskLevel: netApy > 25 ? "HIGH" : netApy > 15 ? "MEDIUM" : "LOW",
          tvlUsd: pool.tvlUsd,
        });
      }
    }

    loops.sort((a, b) => b.netApy - a.netApy);

    latestResult = {
      pools: topPools,
      loops: loops.slice(0, MAX_RESULTS),
      scanTimestamp: Date.now(),
      scanNumber: scanCount,
      poolsScanned: allPools.length,
    };

    logger.info(`Stored ${topPools.length} pools and ${loops.length} loop opportunities`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Scan failed: ${msg}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//                      HTTP SERVER
// ═══════════════════════════════════════════════════════════════════════════

function sendJSON(res: http.ServerResponse, data: unknown, status = 200): void {
  const origin = process.env.CORS_ORIGIN || "http://localhost:3000";
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "public, max-age=300",
  });
  res.end(JSON.stringify(data));
}

// ═══════════════════════════════════════════════════════════════════════════
// In-memory rate limiting (token bucket per IP)
// ═══════════════════════════════════════════════════════════════════════════
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 60;  // 60 requests per minute per IP
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

// Periodic cleanup of stale rate limit entries (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now >= entry.resetAt) rateLimitMap.delete(ip);
  }
}, 300_000);

const server = http.createServer((req, res) => {
  // Use socket.remoteAddress as primary IP source to prevent
  // X-Forwarded-For spoofing. Only trust X-Forwarded-For behind a known reverse proxy.
  const trustedProxy = process.env.TRUSTED_PROXY_SUBNET || "";
  const socketIp = req.socket.remoteAddress || "unknown";
  const clientIp = trustedProxy && socketIp.startsWith(trustedProxy)
    ? (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || socketIp
    : socketIp;
  if (isRateLimited(clientIp)) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Too many requests. Try again later." }));
    return;
  }

  // Restrict CORS to configured origin instead of wildcard
  const allowedOrigin = process.env.CORS_ORIGIN || "http://localhost:3000";
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // Health check
  if (pathname === "/health") {
    sendJSON(res, {
      status: "ok",
      service: "yield-scanner-api",
      scanCount,
      lastScan: latestResult.scanTimestamp
        ? new Date(latestResult.scanTimestamp).toISOString()
        : null,
    });
    return;
  }

  // Latest top pools
  if (pathname === "/api/yields") {
    const limit = parseInt(url.searchParams.get("limit") || String(MAX_RESULTS), 10);
    const chain = url.searchParams.get("chain");
    let pools = latestResult.pools;
    if (chain) {
      pools = pools.filter((p) => p.chain.toLowerCase() === chain.toLowerCase());
    }
    sendJSON(res, {
      pools: pools.slice(0, limit),
      scanTimestamp: latestResult.scanTimestamp,
      scanNumber: latestResult.scanNumber,
      totalPoolsScanned: latestResult.poolsScanned,
    });
    return;
  }

  // Loop opportunities
  if (pathname === "/api/yields/loops") {
    const limit = parseInt(url.searchParams.get("limit") || String(MAX_RESULTS), 10);
    const minApy = parseFloat(url.searchParams.get("minApy") || "0");
    let loops = latestResult.loops;
    if (minApy > 0) {
      loops = loops.filter((l) => l.netApy >= minApy);
    }
    sendJSON(res, {
      loops: loops.slice(0, limit),
      scanTimestamp: latestResult.scanTimestamp,
    });
    return;
  }

  // Scanner status
  if (pathname === "/api/yields/status") {
    sendJSON(res, {
      scanCount,
      lastScan: latestResult.scanTimestamp
        ? new Date(latestResult.scanTimestamp).toISOString()
        : null,
      poolsInLastScan: latestResult.poolsScanned,
      topPoolCount: latestResult.pools.length,
      loopCount: latestResult.loops.length,
      config: {
        chains: SCAN_CHAINS,
        minTvlUsd: MIN_TVL,
        minApyPct: MIN_APY,
        scanInterval: "8h",
      },
    });
    return;
  }

  // Protocol security database
  if (pathname === "/api/yields/protocols") {
    sendJSON(res, { protocols: PROTOCOL_SECURITY });
    return;
  }

  // 404
  sendJSON(res, { error: "Not found" }, 404);
});

// ═══════════════════════════════════════════════════════════════════════════
//                          MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  logger.info("Starting Yield Scanner API...");

  // Run first scan immediately
  await fetchAndProcess();

  // Schedule recurring scans (every 8 hours, matching the main scanner)
  const interval = parseInt(process.env.SCANNER_INTERVAL_MS || String(8 * 60 * 60 * 1000), 10);
  setInterval(() => fetchAndProcess(), interval);

  // Start HTTP server
  // Bind to localhost — use a reverse proxy for external access
  const HOST = process.env.HOST || "127.0.0.1";
  server.listen(PORT, HOST, () => {
    logger.info(`Yield API listening on http://${HOST}:${PORT}`);
    logger.info("Endpoints:");
    logger.info("  GET /api/yields          — Top stablecoin pools");
    logger.info("  GET /api/yields/loops    — Loop opportunities");
    logger.info("  GET /api/yields/status   — Scanner status");
    logger.info("  GET /api/yields/protocols — Protocol security data");
    logger.info("  GET /health              — Health check");
  });
}

// Graceful shutdown handlers
const gracefulShutdown = (signal: string) => {
  logger.info(`${signal} received. Shutting down gracefully...`);
  server.close(() => {
    logger.info('HTTP server closed.');
    process.exit(0);
  });
  // Force exit after 10s if server hasn't closed
  setTimeout(() => process.exit(0), 10_000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
