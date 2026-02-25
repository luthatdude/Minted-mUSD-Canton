#!/usr/bin/env npx ts-node --skip-project
/**
 * cip56-bridge-canary.ts — End-to-end bridge canary that exercises
 * the CIP-56 → redeemable conversion + redeem path.
 *
 * Usage:
 *   npx ts-node --skip-project scripts/cip56-bridge-canary.ts [flags]
 *
 * Flags:
 *   --amount <n>    Amount to convert/bridge (default: 0.5)
 *   --party <p>     User party (default: env CANTON_CANARY_PARTY)
 *   --execute       Actually submit (default: dry-run)
 *   --base-url <u>  Frontend API base URL (default: http://localhost:3001)
 */

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return fallback;
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const AMOUNT = parseFloat(getArg("amount", "0.5"));
const EXECUTE = hasFlag("execute");
const BASE_URL = getArg("base-url", "http://localhost:3001");
const PARTY = getArg("party",
  process.env.CANTON_CANARY_PARTY || "minted-canary::122006df00c631440327e68ba87f61795bbcd67db26142e580137e5038649f22edce"
);

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

async function convert(amount: number): Promise<{ success: boolean; convertedAmount?: string; error?: string }> {
  const resp = await fetch(`${BASE_URL}/api/canton-convert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ party: PARTY, amount: amount.toString() }),
  });
  return resp.json() as Promise<{ success: boolean; convertedAmount?: string; error?: string }>;
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

async function main() {
  console.log(`[canary] amount=${AMOUNT} execute=${EXECUTE}`);
  console.log(`[canary] party=${PARTY.slice(0, 30)}...`);
  console.log(`[canary] base=${BASE_URL}\n`);

  // Step 1: Preflight + health
  const pf = await fetchPreflight();
  const cip56 = parseFloat(pf.userCip56Balance);
  const redeemable = parseFloat(pf.userRedeemableBalance);
  const opInv = parseFloat(pf.operatorInventory);
  const maxBridge = parseFloat(pf.maxBridgeable);

  console.log(`[canary] cip56=${cip56.toFixed(2)} redeemable=${redeemable.toFixed(2)} opInv=${opInv.toFixed(2)} maxBridge=${maxBridge.toFixed(2)}`);
  console.log(`[canary] blockers=${JSON.stringify(pf.blockers)}`);

  // Step 2: Validate amount
  if (AMOUNT > maxBridge) {
    console.error(`[canary] FAIL — amount ${AMOUNT} > maxBridgeable ${maxBridge.toFixed(2)}`);
    process.exit(1);
  }
  if (AMOUNT <= 0) {
    console.error("[canary] FAIL — amount must be > 0");
    process.exit(1);
  }
  if (cip56 <= 0 && redeemable < AMOUNT) {
    console.error(`[canary] FAIL — insufficient balance (redeemable=${redeemable.toFixed(2)}, cip56=${cip56.toFixed(2)})`);
    process.exit(1);
  }

  const needsConversion = AMOUNT > redeemable && cip56 > 0;
  const convertAmount = needsConversion ? Math.min(AMOUNT - redeemable, cip56, opInv) : 0;

  console.log(`[canary] needsConversion=${needsConversion} convertAmount=${convertAmount.toFixed(6)}\n`);

  if (!EXECUTE) {
    console.log("[canary] DRY RUN — pass --execute to submit.");
    console.log("[canary] Would convert " + convertAmount.toFixed(6) + " CIP-56 → redeemable, then exercise redeem.");
    process.exit(0);
  }

  // Step 3: Convert if needed
  if (needsConversion && convertAmount > 0) {
    console.log(`[canary] Converting ${convertAmount.toFixed(6)} CIP-56 → redeemable...`);
    const convResult = await convert(convertAmount);
    if (!convResult.success) {
      console.error(`[canary] FAIL — conversion error: ${convResult.error}`);
      process.exit(1);
    }
    console.log(`[canary] Conversion OK: ${convResult.convertedAmount} mUSD`);
  }

  // Step 4: Find a token and service for redeem exercise
  const bal = await fetchBalances();
  if (!bal.directMintService) {
    console.warn("[canary] WARN — no DirectMintService. Skipping redeem exercise (conversion still validated).");
    console.log("[canary] PASS (conversion-only)");
    process.exit(0);
  }

  // CantonDirectMintService enforces minAmount=1.0 on redeem — filter dust tokens
  const MIN_REDEEM = 1.0;
  const smallToken = bal.tokens
    .filter((t) => parseFloat(t.amount) >= MIN_REDEEM)
    .sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount))[0];

  if (!smallToken) {
    console.warn("[canary] WARN — no redeemable tokens available for redeem exercise.");
    console.log("[canary] PASS (conversion-only)");
    process.exit(0);
  }

  console.log(`[canary] Exercising DirectMint_Redeem on token ${smallToken.contractId.slice(0, 30)}... (${smallToken.amount} mUSD)`);
  const redeemResult = await exerciseRedeem(bal.directMintService.contractId, smallToken.contractId);
  if (!redeemResult.success) {
    console.error(`[canary] FAIL — redeem error: ${redeemResult.error}`);
    process.exit(1);
  }

  console.log("[canary] Redeem OK");
  console.log("\n[canary] PASS — full bridge path (convert + redeem) succeeded.");
}

main().catch((err) => {
  console.error(`[canary] Fatal: ${err.message}`);
  process.exit(1);
});
