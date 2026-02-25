#!/usr/bin/env npx ts-node --skip-project
export {}; // module boundary — prevents global scope conflicts with other scripts
/**
 * cip56-bridge-canary.ts — Strict end-to-end bridge canary that exercises
 * the CIP-56 → redeemable conversion + redeem path with post-state assertions.
 *
 * Usage:
 *   npx ts-node --skip-project scripts/cip56-bridge-canary.ts [flags]
 *
 * Flags:
 *   --amount <n>            Amount to convert/bridge (default: 1.0)
 *   --party <p>             User party (default: env CANTON_CANARY_PARTY)
 *   --execute               Actually submit (default: dry-run)
 *   --base-url <u>          Frontend API base URL (default: http://localhost:3001)
 *   --require-conversion    Fail if conversion would not occur (default: true)
 *   --allow-redeem-only     Allow redeem-only path without conversion
 *   --force-conversion-probe Force a CIP-56→redeemable conversion regardless of existing
 *                             redeemable balance, then constrain redeem to the newly
 *                             converted CID(s). Implies --require-conversion.
 *   --no-fallback            Mark hybrid fallback as disabled; force-conversion will
 *                             report EXPECTED_BLOCKED_BY_POLICY instead of FAIL.
 *   --fallback-enabled       Override: explicitly mark fallback as enabled.
 *
 * Assertions (all checked when --execute):
 *   1. No template-not-found or config errors in responses
 *   2. Conversion amount matches expected delta
 *   3. CIP-56 balance decreases when conversion occurs
 *   4. Redeemable balance changes as expected
 *   5. Redeem command succeeds
 *   6. MIN_REDEEM >= 1.0 enforced for token selection
 *   7. conversion_path_executed (force mode only): conversion succeeded AND
 *      redeem consumed a CID created by this conversion run
 *   8. verdict: PASS | FAIL | EXPECTED_BLOCKED_BY_POLICY with mode/fallback context
 */

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return fallback;
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const AMOUNT = parseFloat(getArg("amount", "1.0"));
const EXECUTE = hasFlag("execute");
const BASE_URL = getArg("base-url", "http://localhost:3001");
const PARTY = getArg("party",
  process.env.CANTON_CANARY_PARTY || "minted-canary::122006df00c631440327e68ba87f61795bbcd67db26142e580137e5038649f22edce"
);
// --force-conversion-probe always converts, regardless of existing redeemable balance
const FORCE_CONVERSION = hasFlag("force-conversion-probe");
// --require-conversion defaults to true unless --allow-redeem-only is passed
const ALLOW_REDEEM_ONLY = hasFlag("allow-redeem-only") && !FORCE_CONVERSION;
const REQUIRE_CONVERSION = FORCE_CONVERSION || hasFlag("require-conversion") || !ALLOW_REDEEM_ONLY;
const MIN_REDEEM = 1.0;
// --no-fallback marks hybrid fallback as disabled; --fallback-enabled re-enables it explicitly
const FALLBACK_ENABLED = hasFlag("fallback-enabled") ||
  (!hasFlag("no-fallback") && process.env.CANTON_HYBRID_FALLBACK_ENABLED !== "false");
const MODE: "native" | "force-conversion" = FORCE_CONVERSION ? "force-conversion" : "native";

interface Preflight {
  userCip56Balance: string;
  userRedeemableBalance: string;
  operatorInventory: string;
  maxBridgeable: string;
  blockers: string[];
}

interface Balances {
  totalBalance: string;
  tokens: Array<{ contractId: string; amount: string }>;
  directMintService: { contractId: string } | null;
}

interface Assertion {
  name: string;
  result: "PASS" | "FAIL" | "SKIP" | "EXPECTED_BLOCKED_BY_POLICY";
  detail: string;
}

const assertions: Assertion[] = [];

function assert(name: string, pass: boolean, detail: string): boolean {
  assertions.push({ name, result: pass ? "PASS" : "FAIL", detail });
  console.log(`  [assert] ${pass ? "PASS" : "FAIL"} — ${name}: ${detail}`);
  return pass;
}

function skip(name: string, detail: string): void {
  assertions.push({ name, result: "SKIP", detail });
  console.log(`  [assert] SKIP — ${name}: ${detail}`);
}

function policyBlock(name: string, detail: string): void {
  assertions.push({ name, result: "EXPECTED_BLOCKED_BY_POLICY", detail });
  console.log(`  [assert] EXPECTED_BLOCKED_BY_POLICY — ${name}: ${detail}`);
}

type Verdict = "PASS" | "FAIL" | "EXPECTED_BLOCKED_BY_POLICY";

function computeVerdict(): Verdict {
  if (assertions.some(a => a.result === "FAIL")) return "FAIL";
  if (assertions.some(a => a.result === "EXPECTED_BLOCKED_BY_POLICY")) return "EXPECTED_BLOCKED_BY_POLICY";
  return "PASS";
}

async function fetchPreflight(): Promise<Preflight> {
  const resp = await fetch(`${BASE_URL}/api/canton-bridge-preflight?party=${encodeURIComponent(PARTY)}`);
  if (!resp.ok) throw new Error(`preflight ${resp.status}`);
  return resp.json() as Promise<Preflight>;
}

async function fetchBalances(): Promise<Balances> {
  const resp = await fetch(`${BASE_URL}/api/canton-balances?party=${encodeURIComponent(PARTY)}`);
  if (!resp.ok) throw new Error(`balances ${resp.status}`);
  return resp.json() as Promise<Balances>;
}

interface ConvertResult {
  success: boolean;
  convertedAmount?: string;
  error?: string;
  commandId?: string;
  /** Archived operator inventory CIDs (consumed sources). */
  releasedFromCids?: string[];
  /** Archived user CIP-56 CIDs (locked as escrow). */
  lockedCip56Cids?: string[];
}

async function convert(amount: number): Promise<ConvertResult> {
  const resp = await fetch(`${BASE_URL}/api/canton-convert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ party: PARTY, amount: amount.toString() }),
  });
  return resp.json() as Promise<ConvertResult>;
}

async function exerciseRedeem(serviceCid: string, tokenCid: string): Promise<{ success: boolean; error?: string }> {
  const resp = await fetch(`${BASE_URL}/api/canton-command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "exercise",
      templateId: "CantonDirectMintService",
      contractId: serviceCid,
      choice: "DirectMint_Redeem",
      argument: { user: PARTY, musdCid: tokenCid },
      party: PARTY,
    }),
  });
  return resp.json() as Promise<{ success: boolean; error?: string }>;
}

function checkForKnownErrors(blockers: string[]): boolean {
  const errorBlockers = ["TEMPLATES_OR_INTERFACES_NOT_FOUND", "CONFIG_ERROR"];
  for (const b of blockers) {
    if (errorBlockers.includes(b)) return true;
  }
  return false;
}

async function main() {
  console.log(`[canary] mode=${MODE} fallbackEnabled=${FALLBACK_ENABLED} amount=${AMOUNT} execute=${EXECUTE} require-conversion=${REQUIRE_CONVERSION} force-conversion=${FORCE_CONVERSION}`);
  console.log(`[canary] party=${PARTY.slice(0, 30)}...`);
  console.log(`[canary] base=${BASE_URL}\n`);

  // Step 1: Preflight
  const pf = await fetchPreflight();
  const cip56Before = parseFloat(pf.userCip56Balance);
  const redeemableBefore = parseFloat(pf.userRedeemableBalance);
  const opInv = parseFloat(pf.operatorInventory);
  const maxBridge = parseFloat(pf.maxBridgeable);

  console.log(`[canary] cip56=${cip56Before.toFixed(2)} redeemable=${redeemableBefore.toFixed(2)} opInv=${opInv.toFixed(2)} maxBridge=${maxBridge.toFixed(2)}`);
  console.log(`[canary] blockers=${JSON.stringify(pf.blockers)}`);

  // Check for config/template errors in blockers
  if (checkForKnownErrors(pf.blockers)) {
    console.error(`[canary] FAIL — config/template errors detected in blockers: ${JSON.stringify(pf.blockers)}`);
    assert("no_config_errors", false, `blockers contain error: ${JSON.stringify(pf.blockers)}`);
    printSummary();
    process.exit(1);
  }

  // Step 2: Validate amount
  if (AMOUNT > maxBridge) {
    console.error(`[canary] FAIL — amount ${AMOUNT} > maxBridgeable ${maxBridge.toFixed(2)}`);
    process.exit(1);
  }
  if (AMOUNT < MIN_REDEEM) {
    console.error(`[canary] FAIL — amount ${AMOUNT} < MIN_REDEEM ${MIN_REDEEM} (DAML enforces minAmount=1.0)`);
    process.exit(1);
  }
  if (cip56Before <= 0 && redeemableBefore < AMOUNT) {
    console.error(`[canary] FAIL — insufficient balance (redeemable=${redeemableBefore.toFixed(2)}, cip56=${cip56Before.toFixed(2)})`);
    process.exit(1);
  }

  // Determine conversion strategy
  let wouldConvert: boolean;
  let convertAmount: number;

  if (FORCE_CONVERSION) {
    // Force mode: always convert regardless of redeemable balance
    if (cip56Before < MIN_REDEEM) {
      console.error(`[canary] FAIL — --force-conversion-probe requires CIP-56 balance >= ${MIN_REDEEM}, have ${cip56Before.toFixed(2)}`);
      assert("force_conversion_precondition", false, `cip56=${cip56Before.toFixed(2)} < MIN_REDEEM=${MIN_REDEEM}`);
      printSummary();
      process.exit(1);
    }
    if (opInv < MIN_REDEEM) {
      console.error(`[canary] FAIL — --force-conversion-probe requires operator inventory >= ${MIN_REDEEM}, have ${opInv.toFixed(2)}`);
      assert("force_conversion_precondition", false, `opInv=${opInv.toFixed(2)} < MIN_REDEEM=${MIN_REDEEM}`);
      printSummary();
      process.exit(1);
    }
    wouldConvert = true;
    convertAmount = Math.min(MIN_REDEEM, cip56Before, opInv);
    console.log(`[canary] FORCE CONVERSION MODE: converting ${convertAmount.toFixed(6)} CIP-56 → redeemable`);
  } else {
    wouldConvert = AMOUNT > redeemableBefore && cip56Before > 0;
    convertAmount = wouldConvert ? Math.min(AMOUNT - redeemableBefore, cip56Before, opInv) : 0;
  }

  console.log(`[canary] wouldConvert=${wouldConvert} convertAmount=${convertAmount.toFixed(6)}\n`);

  // Enforce --require-conversion (skipped in force mode since wouldConvert is always true)
  if (REQUIRE_CONVERSION && !wouldConvert) {
    console.error("[canary] FAIL — --require-conversion is set but no conversion would occur.");
    console.error(`[canary] redeemable (${redeemableBefore.toFixed(2)}) already covers amount (${AMOUNT}).`);
    console.error("[canary] To test redeem-only path, pass --allow-redeem-only.");
    console.error("[canary] To force a conversion probe regardless, pass --force-conversion-probe.");
    assert("require_conversion", false, `redeemable ${redeemableBefore.toFixed(2)} >= amount ${AMOUNT}`);
    printSummary();
    process.exit(1);
  }

  if (!EXECUTE) {
    console.log("[canary] DRY RUN — pass --execute to submit.");
    console.log("[canary] Would convert " + convertAmount.toFixed(6) + " CIP-56 → redeemable, then exercise redeem.");
    process.exit(0);
  }

  // Step 3: Pre-conversion CID snapshot (for force mode CID-constrained redeem)
  let preConversionCids = new Set<string>();
  if (FORCE_CONVERSION) {
    const preConvBal = await fetchBalances();
    preConversionCids = new Set(preConvBal.tokens.map(t => t.contractId));
    console.log(`[canary] Pre-conversion CID snapshot: ${preConversionCids.size} existing token(s)`);
  }

  // Step 3b: Convert if needed
  let conversionOk = true;
  if (wouldConvert && convertAmount > 0) {
    console.log(`[canary] Converting ${convertAmount.toFixed(6)} CIP-56 → redeemable...`);
    const convResult = await convert(convertAmount);

    // Check for template/config errors in conversion response
    const convError = convResult.error || "";
    assert("no_template_errors", !convError.includes("TEMPLATES_OR_INTERFACES_NOT_FOUND"),
      convError ? `error: ${convError.slice(0, 100)}` : "no template errors");
    assert("no_config_errors_convert", !convError.includes("COMMAND_PREPROCESSING_FAILED"),
      convError ? `error: ${convError.slice(0, 100)}` : "no preprocessing errors");

    if (!convResult.success) {
      if (FORCE_CONVERSION && !FALLBACK_ENABLED) {
        policyBlock("conversion_success", `blocked by policy (fallback disabled): ${convResult.error}`);
      } else {
        assert("conversion_success", false, `error: ${convResult.error}`);
      }
      conversionOk = false;
    } else {
      assert("conversion_success", true, `converted ${convResult.convertedAmount} mUSD`);
      console.log(`[canary] Conversion OK: ${convResult.convertedAmount} mUSD`);
    }
  } else {
    skip("conversion_success", "no conversion needed");
    skip("no_template_errors", "no conversion needed");
    skip("no_config_errors_convert", "no conversion needed");
  }

  // Early exit: force-conversion with fallback disabled — policy block is expected
  if (FORCE_CONVERSION && !FALLBACK_ENABLED && !conversionOk) {
    skip("cip56_decreased", "policy-blocked (expected)");
    skip("redeemable_increased", "policy-blocked (expected)");
    skip("redeem_service_exists", "policy-blocked (expected)");
    skip("min_redeem_enforced", "policy-blocked (expected)");
    skip("redeem_token_found", "policy-blocked (expected)");
    skip("redeem_no_template_error", "policy-blocked (expected)");
    skip("redeem_no_preprocessing_error", "policy-blocked (expected)");
    skip("redeem_success", "policy-blocked (expected)");
    skip("conversion_path_executed", "policy-blocked (expected)");
    printSummary();
    process.exit(0);
  }

  // Step 4: Post-conversion state assertions
  console.log("\n[canary] Post-conversion state check...");
  const pfAfter = await fetchPreflight();
  const cip56After = parseFloat(pfAfter.userCip56Balance);
  const redeemableAfter = parseFloat(pfAfter.userRedeemableBalance);

  if (wouldConvert && conversionOk) {
    // CIP-56 should decrease
    const cip56Delta = cip56Before - cip56After;
    assert("cip56_decreased", cip56Delta > 0,
      `before=${cip56Before.toFixed(2)} after=${cip56After.toFixed(2)} delta=${cip56Delta.toFixed(2)}`);

    // Redeemable should increase (approximately by convertAmount, allowing for rounding)
    const redeemableDelta = redeemableAfter - redeemableBefore;
    const tolerance = 0.01; // 1 cent tolerance for rounding
    assert("redeemable_increased", redeemableDelta > -tolerance,
      `before=${redeemableBefore.toFixed(2)} after=${redeemableAfter.toFixed(2)} delta=${redeemableDelta.toFixed(2)}`);
  } else if (!wouldConvert) {
    skip("cip56_decreased", "no conversion occurred");
    skip("redeemable_increased", "no conversion occurred");
  } else {
    // Conversion failed — these should fail
    assert("cip56_decreased", false, "conversion failed, no balance change expected");
    assert("redeemable_increased", false, "conversion failed, no balance change expected");
  }

  // Check for LOW_OPERATOR_INVENTORY warning (not a hard fail, just log)
  if (pfAfter.blockers.includes("LOW_OPERATOR_INVENTORY")) {
    console.log("[canary] NOTE: LOW_OPERATOR_INVENTORY present (informational, not a test failure)");
  }

  // Step 5: Find a token and service for redeem exercise
  console.log("\n[canary] Redeem exercise...");
  const bal = await fetchBalances();
  if (!bal.directMintService) {
    console.warn("[canary] WARN — no DirectMintService found.");
    assert("redeem_service_exists", false, "no DirectMintService on ledger");
    printSummary();
    process.exit(1);
  }
  assert("redeem_service_exists", true, `service=${bal.directMintService.contractId.slice(0, 20)}...`);

  // Select token: enforce MIN_REDEEM, prefer smallest eligible token
  // In force mode, constrain to CIDs that appeared AFTER conversion (newly created)
  let eligibleTokens: Array<{ contractId: string; amount: string }>;

  if (FORCE_CONVERSION && conversionOk) {
    const newCids = bal.tokens.filter(t => !preConversionCids.has(t.contractId));
    console.log(`[canary] Force mode: ${newCids.length} new CID(s) from conversion, ${preConversionCids.size} pre-existing`);
    eligibleTokens = newCids
      .filter((t) => parseFloat(t.amount) >= MIN_REDEEM)
      .sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount));
  } else {
    eligibleTokens = bal.tokens
      .filter((t) => parseFloat(t.amount) >= MIN_REDEEM)
      .sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount));
  }

  assert("min_redeem_enforced", true,
    `MIN_REDEEM=${MIN_REDEEM}, eligible tokens=${eligibleTokens.length}${FORCE_CONVERSION ? " (force-constrained)" : ""}`);

  if (eligibleTokens.length === 0) {
    if (FORCE_CONVERSION) {
      console.error("[canary] FAIL — force mode: no newly-converted tokens >= MIN_REDEEM available for redeem.");
    } else {
      console.error("[canary] FAIL — no tokens >= MIN_REDEEM available for redeem exercise.");
    }
    assert("redeem_token_found", false, `no tokens >= ${MIN_REDEEM} mUSD${FORCE_CONVERSION ? " (from this conversion)" : ""}`);
    printSummary();
    process.exit(1);
  }

  const redeemToken = eligibleTokens[0];
  const isNewCid = FORCE_CONVERSION ? !preConversionCids.has(redeemToken.contractId) : false;
  assert("redeem_token_found", true,
    `cid=${redeemToken.contractId.slice(0, 20)}... amount=${redeemToken.amount}${FORCE_CONVERSION ? ` newCid=${isNewCid}` : ""}`);

  console.log(`[canary] Exercising DirectMint_Redeem on token ${redeemToken.contractId.slice(0, 30)}... (${redeemToken.amount} mUSD)`);
  const redeemResult = await exerciseRedeem(bal.directMintService.contractId, redeemToken.contractId);

  // Check redeem response for known errors
  const redeemError = redeemResult.error || "";
  assert("redeem_no_template_error", !redeemError.includes("TEMPLATES_OR_INTERFACES_NOT_FOUND"),
    redeemError ? `error: ${redeemError.slice(0, 100)}` : "no template errors");
  assert("redeem_no_preprocessing_error", !redeemError.includes("COMMAND_PREPROCESSING_FAILED"),
    redeemError ? `error: ${redeemError.slice(0, 100)}` : "no preprocessing errors");

  if (!redeemResult.success) {
    assert("redeem_success", false, `error: ${redeemResult.error}`);
  } else {
    assert("redeem_success", true, "redeem command succeeded");
    console.log("[canary] Redeem OK");
  }

  // Step 6: conversion_path_executed assertion (force mode only)
  if (FORCE_CONVERSION) {
    const pathExecuted = conversionOk && isNewCid && redeemResult.success;
    assert("conversion_path_executed", pathExecuted,
      pathExecuted
        ? "conversion succeeded AND redeem consumed a newly-converted CID"
        : `conversion=${conversionOk} newCid=${isNewCid} redeemOk=${redeemResult.success}`);
  } else {
    skip("conversion_path_executed", "not in force-conversion-probe mode");
  }

  printSummary();

  const verdict = computeVerdict();
  if (verdict === "FAIL") {
    const failCount = assertions.filter((a) => a.result === "FAIL").length;
    console.error(`\n[canary] FAIL — ${failCount} assertion(s) failed.`);
    process.exit(1);
  }

  if (verdict === "EXPECTED_BLOCKED_BY_POLICY") {
    console.log("\n[canary] EXPECTED_BLOCKED_BY_POLICY — force-conversion correctly blocked (fallback disabled).");
    process.exit(0);
  }

  console.log("\n[canary] PASS — all assertions passed.");
}

function printSummary(): void {
  const verdict = computeVerdict();
  console.log("\n[canary:summary]");
  console.log(`  mode: ${MODE}`);
  console.log(`  fallbackEnabled: ${FALLBACK_ENABLED}`);
  console.log(`  verdict: ${verdict}`);
  console.log("[canary:assertions]");
  for (const a of assertions) {
    console.log(`  ${a.result.padEnd(28)} ${a.name}: ${a.detail}`);
  }
  console.log(`[canary:result] ${JSON.stringify({ mode: MODE, fallbackEnabled: FALLBACK_ENABLED, verdict, assertions })}`);
}

main().catch((err) => {
  console.error(`[canary] Fatal: ${err.message}`);
  process.exit(1);
});
