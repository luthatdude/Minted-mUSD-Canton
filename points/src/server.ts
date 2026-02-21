// Points API server — serves points data, leaderboard, and referral system

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { loadConfig } from "./config";
import { ReferralService, DEFAULT_REFERRAL_CONFIG } from "./referral";
import {
  calculateEpochReferralKickbacks,
  getReferralMultiplier,
  getReferralTierLabel,
  REFERRAL_TIERS,
} from "./calculator";
import { SnapshotService } from "./snapshot";

const config = loadConfig();

// Initialize services
const referralService = new ReferralService(DEFAULT_REFERRAL_CONFIG);
const snapshotService = new SnapshotService();

// ═══════════════════════════════════════════════════════════
// Express App
// ═══════════════════════════════════════════════════════════

const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

// ═══════════════════════════════════════════════════════════
// Points Routes
// ═══════════════════════════════════════════════════════════

/** GET /api/points/:address — user's total points and breakdown */
app.get("/api/points/:address", async (req: Request, res: Response) => {
  const address = req.params.address as string;
  if (!isValidAddress(address)) {
    res.status(400).json({ error: "Invalid Ethereum address" });
    return;
  }
  // Return points from latest snapshot
  const latest = snapshotService.getLatestManifest();
  if (!latest) {
    res.json({ address, totalPoints: 0, breakdown: {}, epoch: config.epochStart });
    return;
  }
  const proof = snapshotService.getProof(latest.epoch, address);
  res.json({
    address,
    totalPoints: proof?.amount ?? 0,
    epoch: latest.epoch,
    snapshotTimestamp: latest.timestamp,
  });
});

/** GET /api/leaderboard — top N users by points */
app.get("/api/leaderboard", async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const latest = snapshotService.getLatestManifest();
  if (!latest) {
    res.json({ entries: [], epoch: null });
    return;
  }
  const entries = snapshotService.getLeaderboard(latest.epoch, limit);
  res.json({ entries, epoch: latest.epoch });
});

/** GET /api/snapshot/latest — latest snapshot metadata */
app.get("/api/snapshot/latest", (_req: Request, res: Response) => {
  const latest = snapshotService.getLatestManifest();
  if (!latest) {
    res.status(404).json({ error: "No snapshots available" });
    return;
  }
  res.json(latest);
});

/** GET /api/merkle/:address — Merkle proof for airdrop claim */
app.get("/api/merkle/:address", (req: Request, res: Response) => {
  const address = req.params.address as string;
  if (!isValidAddress(address)) {
    res.status(400).json({ error: "Invalid Ethereum address" });
    return;
  }
  const latest = snapshotService.getLatestManifest();
  if (!latest) {
    res.status(404).json({ error: "No snapshots available" });
    return;
  }
  const proof = snapshotService.getProof(latest.epoch, address);
  if (!proof) {
    res.status(404).json({ error: "Address not found in snapshot" });
    return;
  }
  res.json(proof);
});

/** POST /api/snapshot/trigger — admin: trigger manual snapshot (auth required) */
app.post("/api/snapshot/trigger", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const epoch = Date.now();
    // In production, this would query Dune/on-chain data to compute points
    await snapshotService.createSnapshot(epoch, []);
    res.json({ status: "snapshot_created", epoch });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// Referral Routes
// ═══════════════════════════════════════════════════════════

/** POST /api/referral/code — generate a referral code for the caller */
app.post("/api/referral/code", (req: Request, res: Response) => {
  const { address } = req.body;
  if (!isValidAddress(address)) {
    res.status(400).json({ error: "Invalid address" });
    return;
  }
  try {
    const code = referralService.createCode(address);
    res.json({ code, address });
  } catch (err: any) {
    res.status(409).json({ error: err.message });
  }
});

/** POST /api/referral/link — link a referee to a referral code */
app.post("/api/referral/link", (req: Request, res: Response) => {
  const { referee, code } = req.body;
  if (!isValidAddress(referee)) {
    res.status(400).json({ error: "Invalid referee address" });
    return;
  }
  if (!code || typeof code !== "string") {
    res.status(400).json({ error: "Invalid referral code" });
    return;
  }
  try {
    const result = referralService.linkReferral(referee, code);
    res.json({ success: result, referee, code });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/** GET /api/referral/validate/:code — validate a referral code */
app.get("/api/referral/validate/:code", (req: Request, res: Response) => {
  const code = req.params.code as string;
  const result = referralService.validateCode(code);
  res.json({ code, valid: result.valid });
});

/** GET /api/referral/stats/:address — get referral stats for an address */
app.get("/api/referral/stats/:address", (req: Request, res: Response) => {
  const address = req.params.address as string;
  if (!isValidAddress(address)) {
    res.status(400).json({ error: "Invalid address" });
    return;
  }
  const stats = referralService.getStats(address);
  const tvl = 0; // TODO: fetch from on-chain or Dune
  const multiplier = getReferralMultiplier(tvl);
  const tierLabel = getReferralTierLabel(tvl);

  res.json({
    ...stats,
    referredTvlUsd: tvl,
    multiplier,
    tierLabel,
    tiers: REFERRAL_TIERS,
  });
});

/** GET /api/referral/leaderboard — top referrers */
app.get("/api/referral/leaderboard", (_req: Request, res: Response) => {
  const metrics = referralService.getGlobalMetrics();
  res.json({ metrics, entries: [] });
});

/** GET /api/referral/tiers — multiplier tier definitions */
app.get("/api/referral/tiers", (_req: Request, res: Response) => {
  res.json({ tiers: REFERRAL_TIERS });
});

/** GET /api/referral/global — global referral metrics */
app.get("/api/referral/global", (_req: Request, res: Response) => {
  const metrics = referralService.getGlobalMetrics();
  res.json(metrics);
});

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

function isValidAddress(addr: unknown): addr is string {
  return typeof addr === "string" && /^0x[0-9a-fA-F]{40}$/.test(addr);
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.headers["x-admin-key"];
  if (!apiKey || apiKey !== process.env.POINTS_ADMIN_KEY) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[Points] Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ═══════════════════════════════════════════════════════════
// Start
// ═══════════════════════════════════════════════════════════

app.listen(config.port, () => {
  console.log(`[Points] Server listening on port ${config.port}`);
  console.log(`[Points] Epoch start: ${config.epochStart}`);
  console.log(`[Points] Referral tiers: ${REFERRAL_TIERS.length} configured`);
});

export default app;

