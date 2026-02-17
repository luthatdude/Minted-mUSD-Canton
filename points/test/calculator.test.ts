/**
 * Smoke tests for the Minted Points Calculator.
 * Run: cd points && npx ts-node --esm test/calculator.test.ts
 * (Uses Node built-in assert — zero extra deps.)
 */

import assert from "node:assert/strict";
import {
  calculatePoints,
  getReferralMultiplier,
  getReferralTierLabel,
  calculateReferralKickback,
  calculateEpochReferralKickbacks,
  DEFAULT_CONFIG,
  REFERRAL_TIERS,
} from "../src/calculator";

// ─── calculatePoints ──────────────────────────────────────────

console.log("▶ calculatePoints");

// Basic: $1 000 for 30 days at 1× hold rate = 30 000 pts
assert.equal(calculatePoints(1000, 30, 1.0), 30_000);

// smusdStakeRate (3×)
assert.equal(calculatePoints(1000, 30, 3.0), 90_000);

// With Canton bridge multiplier (1.5×)
assert.equal(calculatePoints(1000, 30, 1.0, 1.5), 45_000);

// Zero balance → zero points
assert.equal(calculatePoints(0, 365, 5.0, 2.0), 0);

// Zero duration → zero points
assert.equal(calculatePoints(10_000, 0, 5.0), 0);

console.log("  ✅ All calculatePoints tests passed");

// ─── getReferralMultiplier ────────────────────────────────────

console.log("▶ getReferralMultiplier");

// Diamond tier: ≥ $1M
assert.equal(getReferralMultiplier(1_000_000), 3.0);
assert.equal(getReferralMultiplier(5_000_000), 3.0);

// Platinum: ≥ $500k
assert.equal(getReferralMultiplier(500_000), 2.5);
assert.equal(getReferralMultiplier(999_999), 2.5);

// Gold: ≥ $100k
assert.equal(getReferralMultiplier(100_000), 2.0);

// Silver: ≥ $10k
assert.equal(getReferralMultiplier(10_000), 1.5);

// Below Silver: base multiplier
assert.equal(getReferralMultiplier(9_999), 1.0);
assert.equal(getReferralMultiplier(0), 1.0);

console.log("  ✅ All getReferralMultiplier tests passed");

// ─── getReferralTierLabel ─────────────────────────────────────

console.log("▶ getReferralTierLabel");

assert.equal(getReferralTierLabel(2_000_000), "Diamond");
assert.equal(getReferralTierLabel(600_000), "Platinum");
assert.equal(getReferralTierLabel(200_000), "Gold");
assert.equal(getReferralTierLabel(50_000), "Silver");
assert.equal(getReferralTierLabel(5_000), "Bronze");
assert.equal(getReferralTierLabel(0), "Bronze");

console.log("  ✅ All getReferralTierLabel tests passed");

// ─── calculateReferralKickback ────────────────────────────────

console.log("▶ calculateReferralKickback");

// Depth 1 (direct), Silver TVL ($50k → 1.5× multiplier)
// 1000 pts × 10% × 1.5 = 150
assert.equal(calculateReferralKickback(1000, 1, 50_000), 150);

// Depth 2 (grandparent), Silver TVL
// 1000 pts × 10% × 0.5 (decay) × 1.5 = 75
assert.equal(calculateReferralKickback(1000, 2, 50_000), 75);

// Depth 1, Diamond TVL ($1M → 3× multiplier)
// 1000 pts × 10% × 3.0 = 300
assert.equal(calculateReferralKickback(1000, 1, 1_000_000), 300);

// Depth 1, below Silver TVL → 1× multiplier
// 1000 pts × 10% × 1.0 = 100
assert.equal(calculateReferralKickback(1000, 1, 5_000), 100);

// Depth 0 → invalid (below min), should return 0
assert.equal(calculateReferralKickback(1000, 0, 50_000), 0);

// Depth 3 → exceeds default maxDepth=2, should return 0
assert.equal(calculateReferralKickback(1000, 3, 50_000), 0);

// Zero points → zero kickback
assert.equal(calculateReferralKickback(0, 1, 1_000_000), 0);

console.log("  ✅ All calculateReferralKickback tests passed");

// ─── calculateEpochReferralKickbacks ──────────────────────────

console.log("▶ calculateEpochReferralKickbacks");

// Set up a chain: C → B → A (A referred B, B referred C)
const refereePoints = new Map<string, number>();
refereePoints.set("0xCCC", 10_000);  // C earned 10k pts

const referralLinks = new Map<string, string>();
referralLinks.set("0xCCC", "0xBBB");   // C was referred by B
referralLinks.set("0xBBB", "0xAAA");   // B was referred by A

const referrerTvls = new Map<string, number>();
referrerTvls.set("0xBBB", 50_000);   // B's referees have $50k TVL → Silver (1.5×)
referrerTvls.set("0xAAA", 200_000);  // A's referees have $200k TVL → Gold (2.0×)

const kickbacks = calculateEpochReferralKickbacks(
  refereePoints,
  referralLinks,
  referrerTvls
);

// B (depth 1 from C): 10000 × 10% × 1.5 = 1500
assert.equal(kickbacks.get("0xBBB"), 1500);

// A (depth 2 from C): 10000 × 10% × 0.5 × 2.0 = 1000
assert.equal(kickbacks.get("0xAAA"), 1000);

// No kickback for C (nobody below C)
assert.equal(kickbacks.has("0xCCC"), false);

console.log("  ✅ All calculateEpochReferralKickbacks tests passed");

// ─── Edge: empty maps ────────────────────────────────────────

console.log("▶ Edge cases");

const emptyKickbacks = calculateEpochReferralKickbacks(
  new Map(),
  new Map(),
  new Map()
);
assert.equal(emptyKickbacks.size, 0);

// Referee with no referral link → no kickback generated
const soloPoints = new Map<string, number>();
soloPoints.set("0xSOLO", 5_000);
const noLinks = calculateEpochReferralKickbacks(soloPoints, new Map(), new Map());
assert.equal(noLinks.size, 0);

console.log("  ✅ All edge case tests passed");

// ─── REFERRAL_TIERS ordering ─────────────────────────────────

console.log("▶ REFERRAL_TIERS invariants");

// Tiers must be sorted descending by minTvlUsd (first match = highest tier)
for (let i = 0; i < REFERRAL_TIERS.length - 1; i++) {
  assert.ok(
    REFERRAL_TIERS[i].minTvlUsd > REFERRAL_TIERS[i + 1].minTvlUsd,
    `Tiers not sorted: index ${i} (${REFERRAL_TIERS[i].minTvlUsd}) <= index ${i + 1} (${REFERRAL_TIERS[i + 1].minTvlUsd})`
  );
}

// All multipliers ≥ 1
for (const tier of REFERRAL_TIERS) {
  assert.ok(tier.multiplier >= 1.0, `Tier ${tier.label} has multiplier < 1`);
}

console.log("  ✅ All REFERRAL_TIERS invariant tests passed");

console.log("\n🎉 All calculator smoke tests passed!");
