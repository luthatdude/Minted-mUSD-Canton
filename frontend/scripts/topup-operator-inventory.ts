#!/usr/bin/env npx ts-node --skip-project
export {}; // module boundary — prevents global scope conflicts with other scripts
/**
 * topup-operator-inventory.ts — Repeatable operator inventory top-up.
 *
 * Usage:
 *   npx ts-node --skip-project scripts/topup-operator-inventory.ts [flags]
 *
 * Flags:
 *   --target <n>                  Floor target in mUSD (default: 2000)
 *   --chunk <n>                   mUSD per transaction (default: 250)
 *   --max-tx <n>                  Max transactions to submit (default: 20)
 *   --execute                     Actually submit (default: dry-run)
 *   --mode <protocol|direct-create>  Mint mode (default: protocol)
 *   --allow-unsafe-direct-create  Required when --mode direct-create
 *   --party <p>                   User party for health reads (default: env CANTON_CANARY_PARTY)
 *   --base-url <u>               Frontend API base URL (default: http://localhost:3001)
 *
 * Modes:
 *   protocol       — Validates CantonDirectMintService exists via ops-health before minting.
 *                     Fails with actionable message if service unavailable.
 *   direct-create  — Raw CantonMUSD create (economically unsafe for production).
 *                     Requires --allow-unsafe-direct-create flag.
 */

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return fallback;
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const TARGET = parseFloat(getArg("target", "2000"));
const CHUNK = parseFloat(getArg("chunk", "250"));
const MAX_TX = parseInt(getArg("max-tx", "20"), 10);
const EXECUTE = hasFlag("execute");
const MODE = getArg("mode", "protocol") as "protocol" | "direct-create";
const ALLOW_UNSAFE = hasFlag("allow-unsafe-direct-create");
const BASE_URL = getArg("base-url", "http://localhost:3001");
const PARTY = getArg("party",
  process.env.CANTON_CANARY_PARTY || "minted-canary::122006df00c631440327e68ba87f61795bbcd67db26142e580137e5038649f22edce"
);

interface OpsHealth {
  operatorInventory: string;
  operatorParty: string;
  floorTarget: number;
  floorDeficit: string;
  status: string;
  maxBridgeable: string;
}

interface Balances {
  directMintService: { contractId: string } | null;
}

interface TopupSummary {
  mode: string;
  target: number;
  chunk: number;
  inventoryBefore: number;
  inventoryAfter: number;
  delta: number;
  txSucceeded: number;
  txFailed: number;
  minted: number;
  status: string;
  stoppedEarly: boolean;
}

async function fetchHealth(): Promise<OpsHealth> {
  const resp = await fetch(`${BASE_URL}/api/canton-ops-health?party=${encodeURIComponent(PARTY)}`);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`ops-health ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json() as Promise<OpsHealth>;
}

async function fetchBalances(): Promise<Balances> {
  const resp = await fetch(`${BASE_URL}/api/canton-balances?party=${encodeURIComponent(PARTY)}`);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`balances ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json() as Promise<Balances>;
}

async function mintChunk(operatorParty: string, amount: number): Promise<boolean> {
  const PACKAGE_ID = process.env.NEXT_PUBLIC_DAML_PACKAGE_ID || "";
  const templateId = PACKAGE_ID
    ? `${PACKAGE_ID}:CantonDirectMint:CantonMUSD`
    : "CantonMUSD";

  const resp = await fetch(`${BASE_URL}/api/canton-command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "create",
      templateId,
      payload: {
        issuer: operatorParty,
        owner: operatorParty,
        amount: amount.toFixed(18),
        agreementHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        agreementUri: "ipfs://QmDevMPA",
        privacyObservers: [],
      },
      party: operatorParty,
    }),
  });
  const data = (await resp.json()) as { success?: boolean; error?: string };
  if (!data.success && data.error) {
    throw new Error(data.error.slice(0, 200));
  }
  return data.success === true;
}

async function validateProtocolMode(operatorParty: string): Promise<void> {
  const bal = await fetchBalances();
  if (!bal.directMintService) {
    console.error("[topup] FAIL — protocol mode requires a live CantonDirectMintService.");
    console.error("[topup] No service found via /api/canton-balances.");
    console.error("[topup] Actions:");
    console.error("  1. Deploy CantonDirectMintService on the Canton participant.");
    console.error("  2. Verify CANTON_PARTY and NEXT_PUBLIC_DAML_PACKAGE_ID are correct.");
    console.error("  3. Or use --mode direct-create --allow-unsafe-direct-create to bypass.");
    process.exit(1);
  }
  console.log(`[topup] Protocol validation: CantonDirectMintService found (${bal.directMintService.contractId.slice(0, 20)}...)`);
}

async function main() {
  if (MODE !== "protocol" && MODE !== "direct-create") {
    console.error(`[topup] FAIL — unknown mode '${MODE}'. Use 'protocol' or 'direct-create'.`);
    process.exit(1);
  }
  if (MODE === "direct-create" && !ALLOW_UNSAFE) {
    console.error("[topup] FAIL — direct-create mode requires --allow-unsafe-direct-create flag.");
    console.error("[topup] This mode bypasses protocol validation and creates raw CantonMUSD contracts.");
    console.error("[topup] Use --mode protocol (default) for validated minting.");
    process.exit(1);
  }

  console.log(`[topup] target=${TARGET} chunk=${CHUNK} max-tx=${MAX_TX} execute=${EXECUTE} mode=${MODE}`);
  console.log(`[topup] party=${PARTY.slice(0, 30)}...`);
  console.log(`[topup] base=${BASE_URL}\n`);

  const before = await fetchHealth();
  const inventory = parseFloat(before.operatorInventory);
  console.log(`[topup] BEFORE  inventory=${inventory.toFixed(2)}  status=${before.status}  maxBridgeable=${before.maxBridgeable}`);

  if (inventory >= TARGET) {
    const summary: TopupSummary = {
      mode: MODE, target: TARGET, chunk: CHUNK,
      inventoryBefore: inventory, inventoryAfter: inventory, delta: 0,
      txSucceeded: 0, txFailed: 0, minted: 0, status: "ALREADY_ABOVE_TARGET",
      stoppedEarly: false,
    };
    console.log(`[topup] Inventory ${inventory.toFixed(2)} >= target ${TARGET}. No action needed.`);
    console.log(`\n[topup:summary] ${JSON.stringify(summary)}`);
    process.exit(0);
  }

  if (MODE === "protocol") {
    await validateProtocolMode(before.operatorParty);
  } else {
    console.log("[topup] WARNING: direct-create mode — skipping protocol validation.");
  }

  const needed = TARGET - inventory;
  const txCount = Math.min(MAX_TX, Math.ceil(needed / CHUNK));
  console.log(`[topup] Deficit: ${needed.toFixed(2)} mUSD — planning ${txCount} transactions of ${CHUNK} mUSD\n`);

  if (!EXECUTE) {
    const summary: TopupSummary = {
      mode: MODE, target: TARGET, chunk: CHUNK,
      inventoryBefore: inventory, inventoryAfter: inventory, delta: 0,
      txSucceeded: 0, txFailed: 0, minted: 0, status: "DRY_RUN",
      stoppedEarly: false,
    };
    console.log("[topup] DRY RUN — pass --execute to actually mint.");
    console.log(`\n[topup:summary] ${JSON.stringify(summary)}`);
    process.exit(0);
  }

  let succeeded = 0;
  let failed = 0;
  let minted = 0;
  let stoppedEarly = false;

  for (let i = 1; i <= txCount; i++) {
    const thisChunk = Math.min(CHUNK, TARGET - inventory - minted);
    if (thisChunk <= 0) break;
    try {
      const ok = await mintChunk(before.operatorParty, thisChunk);
      if (ok) {
        succeeded++;
        minted += thisChunk;
        console.log(`  tx${i}: +${thisChunk.toFixed(2)} mUSD — OK`);
      } else {
        failed++;
        console.error(`  tx${i}: +${thisChunk.toFixed(2)} mUSD — FAIL (API returned success=false)`);
      }
    } catch (err: unknown) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  tx${i}: FAIL — ${msg.slice(0, 100)}`);
    }

    // Re-check inventory after each tx to stop early when target reached
    if (i < txCount) {
      try {
        const mid = await fetchHealth();
        const midInv = parseFloat(mid.operatorInventory);
        if (midInv >= TARGET) {
          console.log(`[topup] Inventory ${midInv.toFixed(2)} reached target ${TARGET} — stopping early.`);
          stoppedEarly = true;
          break;
        }
      } catch {
        // Non-fatal: continue if mid-check fails
      }
    }
  }

  console.log(`\n[topup] Submitted: ${succeeded} OK, ${failed} failed, ${minted.toFixed(2)} mUSD minted`);

  let afterInv = inventory + minted;
  let finalStatus = "COMPLETED";
  try {
    const after = await fetchHealth();
    afterInv = parseFloat(after.operatorInventory);
    console.log(`[topup] AFTER   inventory=${afterInv.toFixed(2)}  status=${after.status}  maxBridgeable=${after.maxBridgeable}`);
    console.log(`[topup] Delta:  +${(afterInv - inventory).toFixed(2)} mUSD`);

    if (afterInv < TARGET) {
      finalStatus = "BELOW_TARGET";
      console.error(`[topup] WARNING: inventory ${afterInv.toFixed(2)} still below target ${TARGET}`);
    } else {
      finalStatus = "TARGET_REACHED";
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[topup] Post-check failed: ${msg}`);
    finalStatus = "POST_CHECK_FAILED";
  }

  const summary: TopupSummary = {
    mode: MODE, target: TARGET, chunk: CHUNK,
    inventoryBefore: inventory, inventoryAfter: afterInv,
    delta: afterInv - inventory,
    txSucceeded: succeeded, txFailed: failed, minted,
    status: finalStatus, stoppedEarly,
  };
  console.log(`\n[topup:summary] ${JSON.stringify(summary)}`);

  if (finalStatus === "BELOW_TARGET" || finalStatus === "POST_CHECK_FAILED") {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[topup] Fatal: ${err.message}`);
  process.exit(1);
});
