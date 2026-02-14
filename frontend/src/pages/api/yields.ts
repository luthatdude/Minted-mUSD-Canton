/**
 * Next.js API Route: /api/yields
 *
 * Proxies the DeFi Llama indexer service (/api/yields/full)
 * and returns the top 50 Ethereum yield opportunities with tranche scoring.
 *
 * If the indexer is not running, falls back to a direct DeFiLlama fetch
 * with simplified scoring (no project-level TVL filtering).
 *
 * Security:
 *   - API key auth via x-api-key header (set YIELD_API_KEY env var)
 *   - Per-IP rate limiting (60 requests per minute)
 *   - Staleness check on cached indexer data (rejects data > 30 min old)
 */

import type { NextApiRequest, NextApiResponse } from "next";

const INDEXER_URL = process.env.YIELD_INDEXER_URL || "http://127.0.0.1:3212";
const DEFI_LLAMA_URL = "https://yields.llama.fi/pools";
const API_KEY = process.env.YIELD_API_KEY || ""; // empty = no auth required (dev mode)
const MAX_STALENESS_MS = parseInt(process.env.YIELD_MAX_STALENESS_MS || "1800000", 10); // 30 min

// ── Structured logging ──────────────────────────────────────────────
function log(level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    service: "api/yields",
    msg,
    ...meta,
  };
  if (level === "error") console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

// ── Per-IP rate limiting ────────────────────────────────────────────
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true; // allowed
  }
  bucket.count++;
  return bucket.count <= RATE_MAX;
}

// Cleanup stale buckets every 5 minutes
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of rateBuckets) {
      if (now >= b.resetAt) rateBuckets.delete(ip);
    }
  }, 300_000);
}

// Stablecoin symbols for fallback filtering
const STABLECOIN_KEYWORDS = [
  "usdc", "usdt", "dai", "usde", "susde", "frax", "lusd", "gusd",
  "musd", "gho", "cusd", "pyusd", "usdm", "usdd", "tusd",
  "susd", "usds", "susds", "usd+", "rlusd", "usda", "usd0",
];

// Simple security scores for fallback (subset of the full indexer registry)
const SECURITY_SCORES: Record<string, number> = {
  "aave-v3": 96, "compound-v3": 94, "lido": 95, "maker": 95,
  "sky-savings-rate": 93, "spark": 90, "rocket-pool": 92,
  "morpho": 90, "morpho-blue": 90, "pendle": 88,
  "curve-dex": 87, "convex-finance": 86, "fluid": 82,
  "yearn-finance": 84, "euler": 75, "ethena": 72,
  "silo-finance": 72, "gearbox": 74, "frax-lend": 83,
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ── C-1: API key authentication ───────────────────────────────────
  if (API_KEY) {
    const provided = req.headers["x-api-key"];
    if (provided !== API_KEY) {
      log("warn", "Unauthorized request — invalid or missing API key", {
        ip: req.socket.remoteAddress,
      });
      return res.status(401).json({ error: "Unauthorized — provide valid x-api-key header" });
    }
  }

  // ── C-1: Rate limiting ────────────────────────────────────────────
  const clientIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
    || req.socket.remoteAddress || "unknown";
  if (!checkRateLimit(clientIp)) {
    log("warn", "Rate limited", { ip: clientIp });
    return res.status(429).json({ error: "Too many requests — limit 60/min" });
  }

  // Restrict CORS to configured origin (not wildcard)
  const allowedOrigin = process.env.CORS_ORIGIN || "http://localhost:3000";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");

  try {
    // Try the indexer first
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const indexerResp = await fetch(`${INDEXER_URL}/api/yields/full`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (indexerResp.ok) {
        const data = await indexerResp.json();

        // ── L-4: Staleness check ──────────────────────────────────
        const scanTs = data?.meta?.scanTimestamp;
        if (scanTs && Date.now() - scanTs > MAX_STALENESS_MS) {
          log("warn", "Indexer data is stale — falling through to direct fetch", {
            ageMs: Date.now() - scanTs,
            maxMs: MAX_STALENESS_MS,
          });
          // Don't return stale data — fall through to direct DeFiLlama
        } else {
          return res.status(200).json({
            source: "indexer",
            ...data,
          });
        }
      }
    } catch {
      clearTimeout(timeout);
      // Indexer unavailable — fall through to direct fetch
    }

    // Fallback: Direct DeFiLlama fetch with simplified filtering
    const llamaResp = await fetch(DEFI_LLAMA_URL);
    if (!llamaResp.ok) {
      return res.status(502).json({ error: `DeFiLlama returned ${llamaResp.status}` });
    }
    const llamaData = (await llamaResp.json()) as { data?: any[] };
    if (!llamaData.data) {
      return res.status(502).json({ error: "Invalid DeFiLlama response" });
    }

    // Filter: Ethereum + stablecoin + active
    const filtered = llamaData.data.filter((p: any) => {
      if (p.chain?.toLowerCase() !== "ethereum") return false;
      if ((p.tvlUsd ?? 0) < 500_000) return false;
      const apy = p.apyBase ?? p.apy ?? 0;
      if (apy <= 0) return false;
      const sym = (p.symbol || "").toLowerCase();
      return STABLECOIN_KEYWORDS.some((kw) => sym.includes(kw));
    });

    // Deduplicate
    const best = new Map<string, any>();
    for (const p of filtered) {
      const key = `${p.project.toLowerCase()}::${p.symbol.toLowerCase()}`;
      const existing = best.get(key);
      if (!existing || (p.tvlUsd ?? 0) > (existing.tvlUsd ?? 0)) {
        best.set(key, p);
      }
    }

    // Score and sort
    const scored = Array.from(best.values()).map((p: any) => {
      const slug = p.project.toLowerCase().replace(/\s+/g, "-");
      const sec = SECURITY_SCORES[slug] ?? 40;
      const apyBps = Math.round((p.apyBase ?? p.apy ?? 0) * 100);
      const tvl = p.tvlUsd ?? 0;
      const yieldScore = Math.min(10000, apyBps * 10);
      const tvlScore = tvl >= 1e9 ? 10000 : tvl >= 1e8 ? 8000 : tvl >= 1e7 ? 6000 : tvl >= 1e6 ? 4000 : 2000;
      const composite = Math.round(yieldScore * 0.30 + sec * 100 * 0.35 + tvlScore * 0.20 + 7000 * 0.15);

      return {
        protocol: -1, // Unknown in fallback mode
        protocolName: p.project,
        risk: sec >= 90 ? 0 : sec >= 75 ? 1 : sec >= 60 ? 2 : 3,
        label: `${p.project} ${p.symbol}`,
        venue: p.pool,
        marketId: "0x0000000000000000000000000000000000000000000000000000000000000000",
        supplyApyBps: apyBps,
        borrowApyBps: 0,
        tvlUsd: tvl,
        utilizationBps: 0,
        extraData: 0,
        available: true,
        apyBase: p.apyBase ?? 0,
        apyReward: p.apyReward ?? 0,
        apy7dDelta: p.apyPct7D,
        apy30dDelta: p.apyPct30D,
        volumeUsd7d: p.volumeUsd7d,
        projectTotalTvl: 0,
        securityScore: sec,
        securityTier: sec >= 90 ? "S" : sec >= 80 ? "A" : sec >= 65 ? "B" : sec >= 50 ? "C" : "D",
        underlyingTokens: p.underlyingTokens ?? [],
        poolMeta: p.poolMeta,
        _compositeScore: composite,
      };
    });

    scored.sort((a: any, b: any) => b._compositeScore - a._compositeScore);
    const top50 = scored.slice(0, 50);

    return res.status(200).json({
      source: "direct-defillama",
      opportunities: top50,
      tranches: { senior: [], mezzanine: [], junior: [] }, // Simplified fallback
      meta: {
        totalPoolsScanned: llamaData.data.length,
        ethereumPoolsFound: filtered.length,
        activePoolsAfterFilter: best.size,
        projectsRepresented: new Set(top50.map((o: any) => o.protocolName)).size,
        scanTimestamp: Date.now(),
        scanNumber: 0,
      },
    });
  } catch (err: any) {
    log("error", "Yield API handler failed", { error: err.message || String(err) });
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
}
