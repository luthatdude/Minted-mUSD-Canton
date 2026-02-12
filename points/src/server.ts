/**
 * Minted Protocol — Points API Server
 *
 * Full Express REST API exposing:
 *
 * PUBLIC ENDPOINTS (no auth — for aggregators, Dune, frontends):
 *   GET  /api/points/:address       User points + tier + breakdown
 *   GET  /api/leaderboard           Top N users (default 100)
 *   GET  /api/season                Current season info
 *   GET  /api/seasons               All seasons
 *   GET  /api/stats/:seasonId       Season-level stats
 *   GET  /api/apy/scenarios         Implied APY scenarios
 *   GET  /api/referral/validate/:code   Validate a referral code
 *   GET  /api/referral/stats/:address   Referral stats for a user
 *   GET  /api/referral/metrics         Global referral metrics
 *   GET  /api/snapshot/latest          Latest transparency snapshot manifest
 *   GET  /api/snapshot/proof/:address  Merkle proof for a user
 *   GET  /api/snapshot/history         All snapshot manifests
 *   GET  /api/snapshot/csv/:id         Download CSV for a snapshot
 *
 * AUTHENTICATED ENDPOINTS (require API key):
 *   POST /api/referral/create          Create referral code (requires wallet sig)
 *   POST /api/referral/link            Link referee to referral code
 *
 * Rate limits: 60 req/min per IP on public endpoints.
 */

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { verifyMessage } from "ethers";
import fs from "fs";
import path from "path";
import { SnapshotService } from "./snapshot";
import { getTier, DEFAULT_POINTS_CONFIG, TIERS } from "./config";
import { ReferralService, DEFAULT_REFERRAL_CONFIG, ReferralConfig } from "./referral";
import {
  TransparencyService,
  PointBalance,
  SnapshotManifest,
} from "./transparency";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface PointsResponse {
  address: string;
  totalPoints: number;
  tier: string;
  multiplier: number;
  breakdown: {
    hold: number;
    stake: number;
    mint: number;
    collateral: number;
    referral: number;
  };
  referredBy: string | null;
  referralCode: string | null;
}

export interface LeaderboardEntry {
  rank: number;
  address: string;
  totalPoints: number;
  tier: string;
}

export interface SeasonInfo {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: "upcoming" | "active" | "completed";
  daysRemaining: number | null;
  multiplier: number;
}

// ═══════════════════════════════════════════════════════════════
// Rate Limiter (simple in-memory, per-IP)
// ═══════════════════════════════════════════════════════════════

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 60; // 60 req/min

function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    next();
    return;
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    res.status(429).json({ error: "RATE_LIMIT_EXCEEDED", retryAfterMs: entry.resetAt - now });
    return;
  }

  next();
}

// ═══════════════════════════════════════════════════════════════
// Wallet Signature Auth Middleware
// Referral write endpoints require EIP-191 signed message.
// Client must send { address, signature, message } where
// message = `minted:referral:<address>:<timestamp>` and
// timestamp is within 5 minutes of server time.
// ═══════════════════════════════════════════════════════════════

const SIG_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

function requireWalletSig(req: Request, res: Response, next: NextFunction): void {
  const { address, signature, message } = req.body;
  if (!address || !signature || !message) {
    res.status(401).json({ error: "SIGNATURE_REQUIRED", detail: "Provide address, signature, and message" });
    return;
  }

  // Validate message format: minted:referral:<address>:<timestamp>
  const parts = (message as string).split(":");
  if (parts.length !== 4 || parts[0] !== "minted" || parts[1] !== "referral") {
    res.status(401).json({ error: "INVALID_MESSAGE_FORMAT", detail: "Expected minted:referral:<address>:<timestamp>" });
    return;
  }

  const msgAddress = parts[2];
  const msgTimestamp = parseInt(parts[3], 10);

  // Check address matches
  if (msgAddress.toLowerCase() !== (address as string).toLowerCase()) {
    res.status(401).json({ error: "ADDRESS_MISMATCH", detail: "Message address does not match request address" });
    return;
  }

  // Check timestamp freshness
  const now = Date.now();
  if (isNaN(msgTimestamp) || Math.abs(now - msgTimestamp) > SIG_MAX_AGE_MS) {
    res.status(401).json({ error: "SIGNATURE_EXPIRED", detail: "Message timestamp is too old or invalid" });
    return;
  }

  // Verify EIP-191 signature
  try {
    const recovered = verifyMessage(message, signature);
    if (recovered.toLowerCase() !== (address as string).toLowerCase()) {
      res.status(401).json({ error: "SIGNATURE_INVALID", detail: "Recovered address does not match" });
      return;
    }
  } catch {
    res.status(401).json({ error: "SIGNATURE_INVALID", detail: "Could not verify signature" });
    return;
  }

  next();
}

// ═══════════════════════════════════════════════════════════════
// Server
// ═══════════════════════════════════════════════════════════════

export class PointsServer {
  private app: express.Application;
  private snapshotService: SnapshotService;
  private referralService: ReferralService;
  private transparencyService: TransparencyService;

  /** address -> { total, hold, stake, mint, collateral, referral } */
  private userPoints: Map<string, {
    total: number;
    hold: number;
    stake: number;
    mint: number;
    collateral: number;
    referral: number;
  }> = new Map();

  /** Seasons configuration */
  private seasons: SeasonInfo[] = [
    {
      id: "s1",
      name: "Season 1 — Genesis",
      startDate: "2026-03-01T00:00:00Z",
      endDate: "2026-06-01T00:00:00Z",
      status: "upcoming",
      daysRemaining: null,
      multiplier: 10,
    },
    {
      id: "s2",
      name: "Season 2 — Growth",
      startDate: "2026-06-01T00:00:00Z",
      endDate: "2026-09-01T00:00:00Z",
      status: "upcoming",
      daysRemaining: null,
      multiplier: 6,
    },
    {
      id: "s3",
      name: "Season 3 — Maturity",
      startDate: "2026-09-01T00:00:00Z",
      endDate: "2026-12-01T00:00:00Z",
      status: "upcoming",
      daysRemaining: null,
      multiplier: 4,
    },
  ];

  constructor(
    snapshotService?: SnapshotService,
    referralConfig?: ReferralConfig,
    snapshotOutputDir?: string,
  ) {
    this.app = express();
    this.app.use(cors());
    this.app.use(express.json());
    this.app.use(rateLimiter);

    this.snapshotService = snapshotService || new SnapshotService(DEFAULT_POINTS_CONFIG);
    this.referralService = new ReferralService(referralConfig || DEFAULT_REFERRAL_CONFIG);
    this.transparencyService = new TransparencyService(snapshotOutputDir || "./snapshots");

    this.registerRoutes();
  }

  // ─── Route Registration ─────────────────────────────────────

  private registerRoutes(): void {
    const r = this.app;

    // ── Points ──────────────────────────────────────────────
    r.get("/api/points/:address", (req, res) => {
      try {
        res.json(this.getPoints(req.params.address));
      } catch (e) {
        res.status(400).json({ error: (e as Error).message });
      }
    });

    r.get("/api/leaderboard", (req, res) => {
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
      res.json({ entries: this.getLeaderboard(limit) });
    });

    // ── Seasons ─────────────────────────────────────────────
    r.get("/api/season", (_req, res) => {
      const active = this.getActiveSeason();
      if (!active) {
        res.status(404).json({ error: "NO_ACTIVE_SEASON" });
        return;
      }
      res.json(active);
    });

    r.get("/api/seasons", (_req, res) => {
      res.json(this.seasons.map((s) => this.enrichSeason(s)));
    });

    r.get("/api/stats/:seasonId", (req, res) => {
      const stats = this.getSeasonStats(req.params.seasonId);
      if (!stats) {
        res.status(404).json({ error: "SEASON_NOT_FOUND" });
        return;
      }
      res.json(stats);
    });

    // ── APY ─────────────────────────────────────────────────
    r.get("/api/apy/scenarios", (_req, res) => {
      res.json(this.getAPYScenarios());
    });

    // ── Referral (public reads) ─────────────────────────────
    r.get("/api/referral/validate/:code", (req, res) => {
      res.json(this.referralService.validateCode(req.params.code));
    });

    r.get("/api/referral/stats/:address", (req, res) => {
      res.json(this.referralService.getStats(req.params.address));
    });

    r.get("/api/referral/tree/:address", (req, res) => {
      res.json(this.referralService.getReferralTree(req.params.address));
    });

    r.get("/api/referral/metrics", (_req, res) => {
      res.json(this.referralService.getGlobalMetrics());
    });

    // ── Referral (writes — requires wallet signature) ──
    r.post("/api/referral/create", requireWalletSig, (req, res) => {
      try {
        const { address } = req.body;
        if (!address) {
          res.status(400).json({ error: "ADDRESS_REQUIRED" });
          return;
        }
        const code = this.referralService.createCode(address);
        res.json({ code, address });
      } catch (e) {
        res.status(400).json({ error: (e as Error).message });
      }
    });

    r.post("/api/referral/link", requireWalletSig, (req, res) => {
      try {
        const { referee, code, address } = req.body;
        if (!referee || !code) {
          res.status(400).json({ error: "REFEREE_AND_CODE_REQUIRED" });
          return;
        }
        // Bind referee to the authenticated signer: the caller can only
        // link themselves as the referee, preventing referral hijacking
        // where an attacker signs as themselves but links a victim address.
        if (!address || (referee as string).toLowerCase() !== (address as string).toLowerCase()) {
          res.status(403).json({ error: "REFEREE_MUST_BE_SIGNER", detail: "You can only link your own address as referee" });
          return;
        }
        const link = this.referralService.linkReferral(referee, code);
        res.json(link);
      } catch (e) {
        res.status(400).json({ error: (e as Error).message });
      }
    });

    // ── Transparency / Snapshots ────────────────────────────
    r.get("/api/snapshot/latest", (_req, res) => {
      const latest = this.transparencyService.getLatest();
      if (!latest) {
        res.status(404).json({ error: "NO_SNAPSHOTS_YET" });
        return;
      }
      res.json(latest);
    });

    r.get("/api/snapshot/history", (_req, res) => {
      res.json(this.transparencyService.getManifests());
    });

    r.get("/api/snapshot/proof/:address", (req, res) => {
      const latest = this.transparencyService.getLatest();
      if (!latest) {
        res.status(404).json({ error: "NO_SNAPSHOTS_YET" });
        return;
      }
      const proof = this.transparencyService.generateProofFromDisk(
        latest.snapshotId,
        req.params.address,
      );
      if (!proof) {
        res.status(404).json({ error: "ADDRESS_NOT_IN_SNAPSHOT" });
        return;
      }
      res.json(proof);
    });

    r.get("/api/snapshot/csv/:id", (req, res) => {
      const id = parseInt(req.params.id);
      const csvPath = path.join("./snapshots", `snapshot-${id}`, `points-${id}.csv`);
      if (!fs.existsSync(csvPath)) {
        res.status(404).json({ error: "SNAPSHOT_NOT_FOUND" });
        return;
      }
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename=minted-points-${id}.csv`);
      fs.createReadStream(csvPath).pipe(res);
    });

    // ── Health ───────────────────────────────────────────────
    r.get("/health", (_req, res) => {
      res.json({
        status: "ok",
        uptime: process.uptime(),
        totalUsers: this.userPoints.size,
        latestSnapshot: this.transparencyService.getLatest()?.snapshotId || null,
      });
    });
  }

  // ─── Core Logic ──────────────────────────────────────────────

  getPoints(address: string): PointsResponse {
    const addr = address.toLowerCase();
    const pts = this.userPoints.get(addr) || {
      total: 0, hold: 0, stake: 0, mint: 0, collateral: 0, referral: 0,
    };
    const tier = getTier(pts.total);
    const referralStats = this.referralService.getStats(addr);
    const codes = referralStats.codes;

    // Find who referred this user
    const chain = referralStats.referralChain;
    const referredBy = chain.length > 0 ? chain[0].address : null;

    return {
      address: addr,
      totalPoints: pts.total,
      tier: tier.name,
      multiplier: tier.multiplier,
      breakdown: {
        hold: pts.hold,
        stake: pts.stake,
        mint: pts.mint,
        collateral: pts.collateral,
        referral: pts.referral,
      },
      referredBy,
      referralCode: codes.length > 0 ? codes[0].code : null,
    };
  }

  getLeaderboard(limit = 100): LeaderboardEntry[] {
    const sorted = Array.from(this.userPoints.entries())
      .sort(([, a], [, b]) => b.total - a.total)
      .slice(0, limit);

    return sorted.map(([address, pts], index) => ({
      rank: index + 1,
      address,
      totalPoints: pts.total,
      tier: getTier(pts.total).name,
    }));
  }

  /**
   * Apply points from a snapshot + calculate referral kickbacks.
   */
  applySnapshot(userPoints: Map<string, {
    hold: number; stake: number; mint: number; collateral: number;
  }>): void {
    for (const [address, breakdown] of userPoints) {
      const addr = address.toLowerCase();
      const existing = this.userPoints.get(addr) || {
        total: 0, hold: 0, stake: 0, mint: 0, collateral: 0, referral: 0,
      };

      const newPoints = breakdown.hold + breakdown.stake + breakdown.mint + breakdown.collateral;

      existing.hold += breakdown.hold;
      existing.stake += breakdown.stake;
      existing.mint += breakdown.mint;
      existing.collateral += breakdown.collateral;
      existing.total += newPoints;

      this.userPoints.set(addr, existing);

      // Calculate and apply referral kickbacks
      const kickbacks = this.referralService.calculateKickbacks(addr, newPoints);
      for (const kb of kickbacks) {
        const referrer = this.userPoints.get(kb.referrer) || {
          total: 0, hold: 0, stake: 0, mint: 0, collateral: 0, referral: 0,
        };
        referrer.referral += kb.pointsAwarded;
        referrer.total += kb.pointsAwarded;
        this.userPoints.set(kb.referrer, referrer);
      }
    }
  }

  /**
   * Run a transparency snapshot (called by cron / daily job).
   */
  async runTransparencySnapshot(blockNumber: number): Promise<SnapshotManifest> {
    const balances = this.getAllBalances();
    const snapshotId = (this.transparencyService.getManifests().length || 0) + 1;
    return this.transparencyService.generateSnapshot(snapshotId, blockNumber, balances);
  }

  // ─── Helpers ─────────────────────────────────────────────────

  private getAllBalances(): PointBalance[] {
    return Array.from(this.userPoints.entries()).map(([address, pts]) => ({
      address,
      totalPoints: pts.total,
      holdPoints: pts.hold,
      stakePoints: pts.stake,
      mintPoints: pts.mint,
      collateralPoints: pts.collateral,
      referralPoints: pts.referral,
      tier: getTier(pts.total).name,
    }));
  }

  private getActiveSeason(): SeasonInfo | null {
    const now = new Date();
    for (const s of this.seasons) {
      const start = new Date(s.startDate);
      const end = new Date(s.endDate);
      if (now >= start && now < end) {
        return this.enrichSeason({ ...s, status: "active" });
      }
    }
    // If no season active, return the next upcoming one
    for (const s of this.seasons) {
      const start = new Date(s.startDate);
      if (now < start) {
        return this.enrichSeason({ ...s, status: "upcoming" });
      }
    }
    return null;
  }

  private enrichSeason(s: SeasonInfo): SeasonInfo {
    const now = new Date();
    const end = new Date(s.endDate);
    const start = new Date(s.startDate);

    let status = s.status;
    if (now >= start && now < end) status = "active";
    else if (now >= end) status = "completed";
    else status = "upcoming";

    const daysRemaining = status === "active"
      ? Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86_400_000))
      : null;

    return { ...s, status, daysRemaining };
  }

  private getSeasonStats(seasonId: string): {
    seasonId: string;
    totalPoints: number;
    uniqueUsers: number;
    topActions: { action: string; total: number }[];
  } | null {
    const season = this.seasons.find((s) => s.id === seasonId);
    if (!season) return null;

    let totalPoints = 0;
    let holdTotal = 0, stakeTotal = 0, mintTotal = 0, collateralTotal = 0, referralTotal = 0;
    for (const [, pts] of this.userPoints) {
      totalPoints += pts.total;
      holdTotal += pts.hold;
      stakeTotal += pts.stake;
      mintTotal += pts.mint;
      collateralTotal += pts.collateral;
      referralTotal += pts.referral;
    }

    return {
      seasonId,
      totalPoints,
      uniqueUsers: this.userPoints.size,
      topActions: [
        { action: "ETH_STAKE", total: stakeTotal },
        { action: "ETH_MINT", total: mintTotal },
        { action: "ETH_COLLATERAL", total: collateralTotal },
        { action: "ETH_HOLD", total: holdTotal },
        { action: "REFERRAL", total: referralTotal },
      ].sort((a, b) => b.total - a.total),
    };
  }

  private getAPYScenarios() {
    const tokenPrice = 0.50;
    const totalTokens = 100_000_000;
    const airdropPct = 0.15; // 15% to points holders
    const totalAirdropTokens = totalTokens * airdropPct;
    const totalAirdropValue = totalAirdropTokens * tokenPrice;

    const scenarios = [
      { label: "Small Depositor", depositUsd: 1_000 },
      { label: "Medium Depositor", depositUsd: 10_000 },
      { label: "Large Depositor", depositUsd: 100_000 },
      { label: "Whale", depositUsd: 1_000_000 },
    ];

    const totalTVL = 25_000_000; // Assumed $25M weighted TVL

    return {
      impliedAPY: (totalAirdropValue / totalTVL) * 100,
      assumptions: {
        tokenPrice,
        totalTokensForAirdrop: totalAirdropTokens,
        totalValueOfAirdrop: totalAirdropValue,
      },
      scenarios: scenarios.map((s) => {
        const share = s.depositUsd / totalTVL;
        const tokenAllocation = totalAirdropTokens * share;
        const tokenValue = tokenAllocation * tokenPrice;
        const apy = (tokenValue / s.depositUsd) * 100;

        return {
          label: s.label,
          depositUsd: s.depositUsd,
          estimatedPoints: Math.floor(s.depositUsd * 365 * 3), // rough estimate
          tokenAllocation: Math.floor(tokenAllocation),
          tokenValue: Math.floor(tokenValue),
          apy: Math.round(apy * 10) / 10,
        };
      }),
    };
  }

  // ─── Server Lifecycle ────────────────────────────────────────

  async start(port = 3210): Promise<void> {
    this.transparencyService.loadFromDisk();

    this.app.listen(port, () => {
      console.log(`\n[PointsServer] ✅ Minted Points API live on http://localhost:${port}`);
      console.log("[PointsServer] Public endpoints:");
      console.log("  GET  /api/points/:address");
      console.log("  GET  /api/leaderboard?limit=100");
      console.log("  GET  /api/season");
      console.log("  GET  /api/seasons");
      console.log("  GET  /api/stats/:seasonId");
      console.log("  GET  /api/apy/scenarios");
      console.log("  GET  /api/referral/validate/:code");
      console.log("  GET  /api/referral/stats/:address");
      console.log("  GET  /api/referral/tree/:address");
      console.log("  GET  /api/referral/metrics");
      console.log("  POST /api/referral/create");
      console.log("  POST /api/referral/link");
      console.log("  GET  /api/snapshot/latest");
      console.log("  GET  /api/snapshot/history");
      console.log("  GET  /api/snapshot/proof/:address");
      console.log("  GET  /api/snapshot/csv/:id");
      console.log("  GET  /health\n");
    });
  }

  /** Expose for testing */
  getApp(): express.Application {
    return this.app;
  }
}

export default PointsServer;
