/**
 * Smoke tests for the Minted Referral Service.
 * Run: cd points && npx ts-node --esm test/referral.test.ts
 */

import assert from "node:assert/strict";
import {
  generateReferralCode,
  ReferralService,
  DEFAULT_REFERRAL_CONFIG,
} from "../src/referral";

// ─── Code Generation ──────────────────────────────────────────

console.log("▶ generateReferralCode");

const code1 = generateReferralCode();
assert.match(code1, /^MNTD-[A-Z2-9]{6}$/, `Invalid format: ${code1}`);

// Uniqueness: 50 codes should all be distinct
const codes = new Set<string>();
for (let i = 0; i < 50; i++) {
  codes.add(generateReferralCode());
}
assert.equal(codes.size, 50, "Expected 50 unique codes");

console.log("  ✅ Code generation tests passed");

// ─── ReferralService: Code Management ─────────────────────────

console.log("▶ ReferralService — createCode / getCodesForOwner");

const svc = new ReferralService();
const alice = "0xAlice";
const bob   = "0xBob";
const carol = "0xCarol";

const aliceCode = svc.createCode(alice);
assert.match(aliceCode, /^MNTD-/);

const aliceCodes = svc.getCodesForOwner(alice);
assert.equal(aliceCodes.length, 1);
assert.equal(aliceCodes[0].owner, alice.toLowerCase());

// Max codes per user (default = 5)
for (let i = 1; i < DEFAULT_REFERRAL_CONFIG.maxCodesPerUser; i++) {
  svc.createCode(alice);
}
assert.throws(
  () => svc.createCode(alice),
  /MAX_CODES_REACHED/,
  "Should reject when max codes reached"
);

console.log("  ✅ Code management tests passed");

// ─── ReferralService: Link Management ─────────────────────────

console.log("▶ ReferralService — linkReferral");

// Normal link
const link = svc.linkReferral(bob, aliceCode);
assert.equal(link.referee, bob.toLowerCase());
assert.equal(link.referrer, alice.toLowerCase());

// Self-referral (bob tries his own code — but bob is already referred, so ALREADY_REFERRED fires)
const bobCode = svc.createCode(bob);
assert.throws(
  () => svc.linkReferral(bob, bobCode),
  /ALREADY_REFERRED|SELF_REFERRAL/,
  "Should reject bob reusing or self-referring"
);

// Double-link (carol links via alice, then tries again with bob's code)
svc.linkReferral(carol, aliceCode);
assert.throws(
  () => svc.linkReferral(carol, bobCode),
  /ALREADY_REFERRED/,
  "Should reject double-link"
);

// Invalid code
assert.throws(
  () => svc.linkReferral(carol, "MNTD-INVALID"),
  /INVALID_CODE/,
  "Should reject invalid code"
);

console.log("  ✅ Link management tests passed");

// ─── Self-Referral ────────────────────────────────────────────

console.log("▶ ReferralService — self-referral prevention");

const svc2 = new ReferralService();
const selfCode = svc2.createCode("0xSelf");
assert.throws(
  () => svc2.linkReferral("0xSelf", selfCode),
  /SELF_REFERRAL/,
  "Should reject self-referral"
);

console.log("  ✅ Self-referral prevention passed");

// ─── Circular Referral ───────────────────────────────────────

console.log("▶ ReferralService — circular referral prevention");

const svc3 = new ReferralService();
const codeA = svc3.createCode("0xA");
svc3.linkReferral("0xB", codeA);         // B → A
const codeB = svc3.createCode("0xB");
assert.throws(
  () => svc3.linkReferral("0xA", codeB), // A → B would create A → B → A cycle
  /CIRCULAR_REFERRAL/,
  "Should detect circular referral"
);

console.log("  ✅ Circular referral prevention passed");

// ─── Kickback Calculation ────────────────────────────────────

console.log("▶ ReferralService — calculateKickbacks");

const svc4 = new ReferralService();
const codeX = svc4.createCode("0xX");
svc4.linkReferral("0xY", codeX);         // Y referred by X
const codeY = svc4.createCode("0xY");
svc4.linkReferral("0xZ", codeY);         // Z referred by Y (X is grandparent)

// Z earns 10,000 pts
const entries = svc4.calculateKickbacks("0xZ", 10_000);
assert.equal(entries.length, 2, "Should have 2 kickback entries (depth 1 + depth 2)");

// Y (direct, depth 1): 10000 × 10% = 1000
assert.equal(entries[0].referrer, "0xy");
assert.equal(entries[0].depth, 1);
assert.equal(entries[0].pointsAwarded, 1000);

// X (grandparent, depth 2): 10000 × 10% × 0.5 = 500
assert.equal(entries[1].referrer, "0xx");
assert.equal(entries[1].depth, 2);
assert.equal(entries[1].pointsAwarded, 500);

console.log("  ✅ Kickback calculation tests passed");

// ─── Stats ───────────────────────────────────────────────────

console.log("▶ ReferralService — getStats");

const stats = svc4.getStats("0xX");
assert.equal(stats.address, "0xx");
assert.ok(stats.codes.length >= 1);
assert.equal(stats.totalReferees, 1); // X directly referred Y only
assert.ok(stats.totalKickbackPoints > 0);

const zStats = svc4.getStats("0xZ");
assert.equal(zStats.totalReferees, 0); // Z hasn't referred anyone
assert.equal(zStats.referralChain.length, 2); // Z → Y → X

console.log("  ✅ Stats tests passed");

// ─── Code Validation ─────────────────────────────────────────

console.log("▶ ReferralService — validateCode");

const svc5 = new ReferralService();
const validCode = svc5.createCode("0xOwner");

const result = svc5.validateCode(validCode);
assert.equal(result.valid, true);
assert.equal(result.owner, "0xowner");

const invalidResult = svc5.validateCode("MNTD-XXXXXX");
assert.equal(invalidResult.valid, false);

console.log("  ✅ Code validation tests passed");

// ─── Code Exhaustion (max referees per code) ──────────────────

console.log("▶ ReferralService — maxRefereesPerCode");

const svc6 = new ReferralService({
  ...DEFAULT_REFERRAL_CONFIG,
  maxRefereesPerCode: 2,
});

const limitedCode = svc6.createCode("0xLimited");
svc6.linkReferral("0xR1", limitedCode);
svc6.linkReferral("0xR2", limitedCode);

assert.throws(
  () => svc6.linkReferral("0xR3", limitedCode),
  /CODE_EXHAUSTED/,
  "Should reject when code usage limit reached"
);

console.log("  ✅ Code exhaustion tests passed");

// ─── Global Metrics ──────────────────────────────────────────

console.log("▶ ReferralService — getGlobalMetrics");

const metrics = svc4.getGlobalMetrics();
assert.ok(metrics.totalCodes >= 2);
assert.ok(metrics.totalLinks >= 2);
assert.ok(metrics.totalKickbackPoints > 0);
assert.ok(typeof metrics.avgRefereesPerReferrer === "number");
assert.ok(typeof metrics.viralCoefficient === "number");

console.log("  ✅ Global metrics tests passed");

// ─── getReferralTree ─────────────────────────────────────────

console.log("▶ ReferralService — getReferralTree");

const tree = svc4.getReferralTree("0xX");
assert.equal(tree.address, "0xx");
assert.ok(tree.referees.length >= 1);
assert.equal(tree.referees[0].address, "0xy");

console.log("  ✅ Referral tree tests passed");

console.log("\n🎉 All referral smoke tests passed!");
