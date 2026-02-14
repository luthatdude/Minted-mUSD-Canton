// Points API server — serves points data, leaderboard, and referral system

import { loadConfig } from "./config";
import { ReferralService, DEFAULT_REFERRAL_CONFIG } from "./referral";
import {
  calculateEpochReferralKickbacks,
  getReferralMultiplier,
  getReferralTierLabel,
  REFERRAL_TIERS,
} from "./calculator";

const config = loadConfig();

// Initialize referral service (in production, back with DB)
const referralService = new ReferralService(DEFAULT_REFERRAL_CONFIG);

// ═══════════════════════════════════════════════════════════
// API Endpoints (Express/Fastify stub)
// ═══════════════════════════════════════════════════════════
//
// GET  /api/points/:address         — user's total points and breakdown
// GET  /api/leaderboard             — top N users by points
// GET  /api/snapshot/latest         — latest snapshot metadata
// GET  /api/merkle/:address         — Merkle proof for airdrop claim
// POST /api/snapshot/trigger        — admin: trigger manual snapshot (auth required)
//
// Referral endpoints:
// POST /api/referral/code           — generate a referral code for the caller
// POST /api/referral/link           — link a referee to a referral code
// GET  /api/referral/validate/:code — validate a referral code
// GET  /api/referral/stats/:address — get referral stats for an address
// GET  /api/referral/leaderboard    — top referrers by referred TVL
// GET  /api/referral/tiers          — multiplier tier definitions
// GET  /api/referral/global         — global referral metrics
//
// ═══════════════════════════════════════════════════════════

/**
 * Example route handler: GET /api/referral/stats/:address
 */
function handleReferralStats(address: string) {
  const stats = referralService.getStats(address);
  const tvl = 0; // TODO: fetch from on-chain or Dune
  const multiplier = getReferralMultiplier(tvl);
  const tierLabel = getReferralTierLabel(tvl);

  return {
    ...stats,
    referredTvlUsd: tvl,
    multiplier,
    tierLabel,
    tiers: REFERRAL_TIERS,
  };
}

/**
 * Example route handler: GET /api/referral/leaderboard
 */
function handleReferralLeaderboard() {
  // In production, query DB sorted by referred TVL
  const metrics = referralService.getGlobalMetrics();
  return {
    metrics,
    // entries would come from DB
    entries: [],
  };
}

console.log(`[Points] Server starting on port ${config.port}`);
console.log(`[Points] Epoch start: ${config.epochStart}`);
console.log(`[Points] Referral tiers: ${REFERRAL_TIERS.length} configured`);

