/**
 * Minted Points — REST API Server
 *
 * Endpoints:
 *   GET  /api/points/:address         — User's points breakdown
 *   GET  /api/leaderboard             — Global leaderboard
 *   GET  /api/leaderboard/:seasonId   — Per-season leaderboard
 *   GET  /api/season                  — Current season info
 *   GET  /api/seasons                 — All seasons overview
 *   GET  /api/stats/:seasonId         — Season statistics
 *   GET  /api/projection              — Points projection calculator
 *   GET  /api/apy                     — Implied APY from token airdrop
 *   GET  /health                      — Health check
 */

import express from "express";
import cors from "cors";
import {
  getCurrentSeason,
  getSeasonById,
  SEASONS,
  PointAction,
} from "./config";
import {
  getUserPoints,
  getUserRank,
  getLeaderboard,
  getGlobalLeaderboard,
  getDb,
} from "./db";
import {
  compareActions,
  projectPoints,
  getSeasonStats,
  getImpliedAPY,
  getImpliedAPYTable,
  getAPYScenarios,
} from "./calculator";
import { TOKENOMICS } from "./config";
import { startSnapshotLoop, takeSnapshot } from "./snapshot";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = parseInt(process.env.POINTS_API_PORT || "3210");

// ═══════════════════════════════════════════════════════════════════════════
// USER POINTS
// ═══════════════════════════════════════════════════════════════════════════

app.get("/api/points/:address", (req, res) => {
  try {
    const { address } = req.params;
    const userPoints = getUserPoints(address);

    // Get rank in current season
    const currentSeason = getCurrentSeason();
    const currentRank = currentSeason
      ? getUserRank(address, currentSeason.id)
      : null;

    // Get rank per season
    const seasonRanks = SEASONS.map((s) => ({
      seasonId: s.id,
      seasonName: s.name,
      rank: getUserRank(address, s.id),
    }));

    res.json({
      address,
      totalPoints: userPoints.totalPoints,
      currentSeason: currentSeason
        ? { id: currentSeason.id, name: currentSeason.name, rank: currentRank }
        : null,
      breakdown: userPoints.bySeasonAndAction,
      seasonRanks,
    });
  } catch (e) {
    console.error("[API] Error fetching user points:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// LEADERBOARD
// ═══════════════════════════════════════════════════════════════════════════

app.get("/api/leaderboard", (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const offset = parseInt(req.query.offset as string) || 0;

    const entries = getGlobalLeaderboard(limit, offset);

    res.json({
      scope: "global",
      entries,
      limit,
      offset,
    });
  } catch (e) {
    console.error("[API] Error fetching global leaderboard:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/leaderboard/:seasonId", (req, res) => {
  try {
    const seasonId = parseInt(req.params.seasonId);
    const season = getSeasonById(seasonId);
    if (!season) {
      return res.status(404).json({ error: `Season ${seasonId} not found` });
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const offset = parseInt(req.query.offset as string) || 0;

    const entries = getLeaderboard(seasonId, limit, offset);

    res.json({
      scope: "season",
      seasonId: season.id,
      seasonName: season.name,
      entries,
      limit,
      offset,
    });
  } catch (e) {
    console.error("[API] Error fetching season leaderboard:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SEASON INFO
// ═══════════════════════════════════════════════════════════════════════════

app.get("/api/season", (_req, res) => {
  const currentSeason = getCurrentSeason();

  if (!currentSeason) {
    // Determine if we're before season 1 or after season 3
    const now = new Date();
    const firstSeason = SEASONS[0];
    const lastSeason = SEASONS[SEASONS.length - 1];

    if (now < firstSeason.startDate) {
      return res.json({
        active: false,
        status: "upcoming",
        message: "Points program has not started yet",
        startsAt: firstSeason.startDate.toISOString(),
        countdown: Math.floor((firstSeason.startDate.getTime() - now.getTime()) / 1000),
      });
    }

    return res.json({
      active: false,
      status: "ended",
      message: "All seasons have concluded",
      endedAt: lastSeason.endDate.toISOString(),
    });
  }

  const now = new Date();
  const elapsed = now.getTime() - currentSeason.startDate.getTime();
  const total = currentSeason.endDate.getTime() - currentSeason.startDate.getTime();
  const remaining = currentSeason.endDate.getTime() - now.getTime();

  res.json({
    active: true,
    id: currentSeason.id,
    name: currentSeason.name,
    startDate: currentSeason.startDate.toISOString(),
    endDate: currentSeason.endDate.toISOString(),
    progress: Math.min(elapsed / total, 1),
    remainingSeconds: Math.max(Math.floor(remaining / 1000), 0),
    multipliers: currentSeason.multipliers,
  });
});

app.get("/api/seasons", (_req, res) => {
  const now = new Date();

  const seasons = SEASONS.map((s) => {
    let status: "upcoming" | "active" | "ended";
    if (now < s.startDate) status = "upcoming";
    else if (now < s.endDate) status = "active";
    else status = "ended";

    return {
      id: s.id,
      name: s.name,
      status,
      startDate: s.startDate.toISOString(),
      endDate: s.endDate.toISOString(),
      multipliers: s.multipliers,
    };
  });

  res.json({ seasons });
});

// ═══════════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════════

app.get("/api/stats/:seasonId", (req, res) => {
  try {
    const seasonId = parseInt(req.params.seasonId);
    const stats = getSeasonStats(seasonId);
    if (!stats) {
      return res.status(404).json({ error: `Season ${seasonId} not found` });
    }
    res.json(stats);
  } catch (e) {
    console.error("[API] Error fetching stats:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PROJECTIONS — "How many points would I earn?"
// ═══════════════════════════════════════════════════════════════════════════

app.get("/api/projection", (req, res) => {
  try {
    const valueUsd = parseFloat(req.query.value as string);
    const action = req.query.action as string | undefined;
    const seasonId = req.query.season ? parseInt(req.query.season as string) : undefined;

    if (isNaN(valueUsd) || valueUsd <= 0) {
      return res.status(400).json({ error: "Query param 'value' (USD) is required and must be positive" });
    }

    if (action) {
      // Project for a specific action
      if (!Object.values(PointAction).includes(action as PointAction)) {
        return res.status(400).json({
          error: `Invalid action. Valid: ${Object.values(PointAction).join(", ")}`,
        });
      }

      const projection = projectPoints(valueUsd, action as PointAction, seasonId);
      if (!projection) {
        return res.status(404).json({ error: "No active season or invalid season" });
      }

      return res.json(projection);
    }

    // Compare all actions
    const projections = compareActions(valueUsd, seasonId);
    res.json({
      valueUsd,
      seasonId: seasonId ?? getCurrentSeason()?.id,
      projections,
    });
  } catch (e) {
    console.error("[API] Error computing projection:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// IMPLIED APY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/apy?weightedTvl=25000000
 * GET /api/apy?weightedTvl=25000000&action=CTN_BOOST_POOL
 * GET /api/apy/scenarios — APY across multiple TVL levels
 */
app.get("/api/apy/scenarios", (_req, res) => {
  try {
    const scenarios = getAPYScenarios();
    res.json({
      tokenomics: {
        totalSupply: TOKENOMICS.totalSupply,
        launchFDV: TOKENOMICS.launchFDV,
        tokenPrice: TOKENOMICS.tokenPrice,
        airdropPct: TOKENOMICS.airdropPct,
        airdropTokens: TOKENOMICS.airdropTokens,
        airdropValueUsd: TOKENOMICS.airdropValueUsd,
        programDays: TOKENOMICS.programDays,
      },
      note: "Implied APY assumes full-program participation and constant TVL. Actual returns depend on total weighted TVL at time of airdrop.",
      scenarios,
    });
  } catch (e) {
    console.error("[API] Error fetching APY scenarios:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/apy", (req, res) => {
  try {
    const weightedTvl = parseFloat(req.query.weightedTvl as string);
    const action = req.query.action as string | undefined;

    if (isNaN(weightedTvl) || weightedTvl <= 0) {
      return res.status(400).json({
        error: "Query param 'weightedTvl' is required (total weighted TVL in USD)",
        example: "/api/apy?weightedTvl=25000000",
      });
    }

    if (action) {
      if (!Object.values(PointAction).includes(action as PointAction)) {
        return res.status(400).json({
          error: `Invalid action. Valid: ${Object.values(PointAction).join(", ")}`,
        });
      }

      const apy = getImpliedAPY(action as PointAction, weightedTvl);
      return res.json(apy);
    }

    // All actions
    const table = getImpliedAPYTable(weightedTvl);
    res.json({
      weightedTvl,
      tokenomics: {
        airdropValueUsd: TOKENOMICS.airdropValueUsd,
        tokenPrice: TOKENOMICS.tokenPrice,
        programDays: TOKENOMICS.programDays,
      },
      actions: table,
    });
  } catch (e) {
    console.error("[API] Error computing APY:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// HEALTH
// ═══════════════════════════════════════════════════════════════════════════

app.get("/health", (_req, res) => {
  const d = getDb();
  const snapshotCount = d.prepare("SELECT COUNT(*) as count FROM snapshots").get() as { count: number };
  const userCount = d.prepare("SELECT COUNT(DISTINCT user_address) as count FROM points").get() as { count: number };

  res.json({
    status: "ok",
    currentSeason: getCurrentSeason()?.name ?? "none",
    totalSnapshots: snapshotCount.count,
    trackedUsers: userCount.count,
    uptime: process.uptime(),
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS (protected by simple bearer token)
// ═══════════════════════════════════════════════════════════════════════════

function adminAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token || token !== process.env.ADMIN_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

/** Force a snapshot (for testing) */
app.post("/admin/snapshot", adminAuth, async (_req, res) => {
  try {
    const rows = await takeSnapshot();
    res.json({
      success: true,
      rowsProcessed: rows.length,
    });
  } catch (e) {
    console.error("[Admin] Snapshot error:", e);
    res.status(500).json({ error: "Snapshot failed" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════════════

export function startServer(): void {
  // Initialize database (lazy, happens on first getDb() call)
  getDb();

  // Note: snapshot loop is started by index.ts, not here.
  // startSnapshotLoop() is available for standalone use.

  // Start the API server
  app.listen(PORT, () => {
    console.log(`\n╔══════════════════════════════════════════╗`);
    console.log(`║   Minted Points API — Port ${PORT}          ║`);
    console.log(`║   Season: ${(getCurrentSeason()?.name ?? "Inactive").padEnd(29)}║`);
    console.log(`╚══════════════════════════════════════════╝\n`);
  });
}

// Run if called directly
if (require.main === module) {
  startServer();
}
