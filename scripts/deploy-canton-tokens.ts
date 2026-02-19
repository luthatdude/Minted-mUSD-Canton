/**
 * Deploy Tokens on Canton Devnet
 *
 * Creates core token and service contracts on Canton Network:
 *   - CantonUSDC    (deposit asset)
 *   - USDCx         (xReserve bridged USDC)
 *   - CantonMUSD    (Canton-native mUSD)
 *   - CantonCoin    (native Canton coin)
 *   - CantonStakingService  (smUSD vault)
 *   - CantonETHPoolService  (ETH pool yield)
 *
 * Idempotent — skips singletons that already exist.
 *
 * Usage:
 *   cd /path/to/Minted-mUSD-Canton && npx ts-node --skip-project scripts/deploy-canton-tokens.ts
 */

const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.join(process.cwd(), "relay/.env.development") });

const CANTON_HOST = process.env.CANTON_HOST || "localhost";
const CANTON_PORT = parseInt(process.env.CANTON_PORT || "7575", 10);
const CANTON_TOKEN = process.env.CANTON_TOKEN || "dummy-no-auth";
const CANTON_PARTY = process.env.CANTON_PARTY || "";
const PACKAGE_ID = process.env.CANTON_PACKAGE_ID || "";
const BASE_URL = `http://${CANTON_HOST}:${CANTON_PORT}`;

// Master Participation Agreement (devnet placeholder — 64-char SHA-256 hash)
const MPA_HASH = "a".repeat(64);
const MPA_URI = "https://minted.finance/legal/mpa-devnet-v1.pdf";

if (!CANTON_PARTY) throw new Error("CANTON_PARTY not set");
if (!PACKAGE_ID) throw new Error("CANTON_PACKAGE_ID not set");

// ─── Canton v2 JSON API helpers ───────────────────────────────────────

async function cantonRequest(method: string, apiPath: string, body?: unknown): Promise<any> {
  const resp = await fetch(`${BASE_URL}${apiPath}`, {
    method,
    headers: {
      "Authorization": `Bearer ${CANTON_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Canton ${resp.status}: ${text.slice(0, 400)}`);
  }
  return resp.json();
}

async function getLedgerEnd(): Promise<number> {
  return (await cantonRequest("GET", "/v2/state/ledger-end")).offset;
}

async function queryContracts(moduleName: string, entityName: string): Promise<any[]> {
  const offset = await getLedgerEnd();
  const entries = await cantonRequest("POST", "/v2/state/active-contracts", {
    filter: {
      filtersByParty: {
        [CANTON_PARTY]: {
          identifierFilter: {
            templateFilter: {
              value: { templateId: { moduleName, entityName } },
            },
          },
        },
      },
    },
    activeAtOffset: offset,
  });

  const contracts: any[] = [];
  for (const entry of entries) {
    const ac = entry?.contractEntry?.JsActiveContract;
    if (!ac) continue;
    const evt = ac.createdEvent;
    const parts = (evt.templateId || "").split(":");
    if (parts[parts.length - 2] === moduleName && parts[parts.length - 1] === entityName) {
      contracts.push({ contractId: evt.contractId, payload: evt.createArgument });
    }
  }
  return contracts;
}

let cmdN = 0;
async function createContract(moduleName: string, entityName: string, payload: Record<string, unknown>): Promise<string> {
  cmdN++;
  const commandId = `deploy-tokens-${Date.now()}-${cmdN}`;
  const result = await cantonRequest("POST", "/v2/commands/submit-and-wait", {
    userId: "administrator",
    actAs: [CANTON_PARTY],
    readAs: [],
    commandId,
    commands: [{
      CreateCommand: {
        templateId: `${PACKAGE_ID}:${moduleName}:${entityName}`,
        createArguments: payload,
      },
    }],
  });
  const events = result?.transaction?.events || result?.events || [];
  for (const evt of events) {
    const c = evt?.CreatedEvent || evt?.created;
    if (c?.contractId) return c.contractId;
  }
  return `ok-${commandId}`;
}

async function queryAllCounts(): Promise<Record<string, number>> {
  const offset = await getLedgerEnd();
  const entries = await cantonRequest("POST", "/v2/state/active-contracts", {
    filter: {
      filtersByParty: {
        [CANTON_PARTY]: { identifierFilter: { wildcardFilter: {} } },
      },
    },
    activeAtOffset: offset,
  });
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    const tpl = entry?.contractEntry?.JsActiveContract?.createdEvent?.templateId || "";
    const parts = tpl.split(":");
    const name = parts.length >= 3 ? `${parts[parts.length - 2]}:${parts[parts.length - 1]}` : tpl;
    if (name) counts[name] = (counts[name] || 0) + 1;
  }
  return counts;
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║          Deploy Tokens on Canton Devnet                     ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`  Canton:   ${BASE_URL}`);
  console.log(`  Party:    ${CANTON_PARTY.slice(0, 50)}...`);
  console.log(`  Package:  ${PACKAGE_ID.slice(0, 16)}...`);
  console.log();

  const startOffset = await getLedgerEnd();
  console.log(`✓ Connected — ledger offset: ${startOffset}\n`);

  // Show existing state
  console.log("━━━ Existing contracts ━━━");
  const counts = await queryAllCounts();
  for (const [tpl, cnt] of Object.entries(counts).sort()) console.log(`  ${tpl}: ${cnt}`);
  console.log();

  // ── CantonUSDC tokens ────────────────────────────────────────────
  console.log("━━━ CantonUSDC tokens ━━━");
  for (const amount of ["10000.0", "25000.0", "50000.0"]) {
    try {
      const cid = await createContract("CantonDirectMint", "CantonUSDC", {
        issuer: CANTON_PARTY, owner: CANTON_PARTY, amount, privacyObservers: [],
      });
      console.log(`  ✓ CantonUSDC ${amount}`);
    } catch (e: any) { console.error(`  ✗ CantonUSDC ${amount}: ${e.message.slice(0, 120)}`); }
  }
  console.log();

  // ── USDCx tokens ─────────────────────────────────────────────────
  console.log("━━━ USDCx tokens ━━━");
  for (const { amount, sourceChain, cctpNonce } of [
    { amount: "10000.0", sourceChain: "ethereum", cctpNonce: 3001 },
    { amount: "5000.0",  sourceChain: "base",     cctpNonce: 3002 },
    { amount: "15000.0", sourceChain: "arbitrum",  cctpNonce: 3003 },
  ]) {
    try {
      await createContract("CantonDirectMint", "USDCx", {
        issuer: CANTON_PARTY, owner: CANTON_PARTY, amount, sourceChain, cctpNonce, privacyObservers: [],
      });
      console.log(`  ✓ USDCx ${amount} (${sourceChain})`);
    } catch (e: any) { console.error(`  ✗ USDCx ${amount}: ${e.message.slice(0, 120)}`); }
  }
  console.log();

  // ── CantonMUSD tokens ────────────────────────────────────────────
  console.log("━━━ CantonMUSD tokens ━━━");
  for (const amount of ["5000.0", "10000.0", "25000.0", "100000.0"]) {
    try {
      await createContract("CantonDirectMint", "CantonMUSD", {
        issuer: CANTON_PARTY, owner: CANTON_PARTY, amount,
        agreementHash: MPA_HASH, agreementUri: MPA_URI, privacyObservers: [],
      });
      console.log(`  ✓ CantonMUSD ${amount}`);
    } catch (e: any) { console.error(`  ✗ CantonMUSD ${amount}: ${e.message.slice(0, 120)}`); }
  }
  console.log();

  // ── CantonCoin tokens ────────────────────────────────────────────
  console.log("━━━ CantonCoin tokens ━━━");
  for (const amount of ["1000.0", "5000.0", "10000.0"]) {
    try {
      await createContract("CantonCoinToken", "CantonCoin", {
        issuer: CANTON_PARTY, owner: CANTON_PARTY, amount, privacyObservers: [],
      });
      console.log(`  ✓ CantonCoin ${amount}`);
    } catch (e: any) { console.error(`  ✗ CantonCoin ${amount}: ${e.message.slice(0, 120)}`); }
  }
  console.log();

  // ── CantonStakingService (singleton) ─────────────────────────────
  console.log("━━━ CantonStakingService ━━━");
  const existingStaking = await queryContracts("CantonSMUSD", "CantonStakingService");
  if (existingStaking.length > 0) {
    console.log(`  ⏭  Already exists (${existingStaking.length} instance(s))`);
  } else {
    try {
      // Note: complianceRegistryCid is a dummy — ComplianceRegistry requires regulator ≠ operator
      // and we only have one party on devnet. Staking will work for minting but compliance
      // checks will fail. For full compliance, allocate a separate regulator party.
      await createContract("CantonSMUSD", "CantonStakingService", {
        operator: CANTON_PARTY,
        governance: CANTON_PARTY,
        totalShares: "0.0",
        globalSharePrice: "1.0",
        globalTotalAssets: "0.0",
        globalTotalShares: "0.0",
        lastSyncEpoch: 0,
        cooldownSeconds: 86400,
        minDeposit: "100.0",
        paused: false,
        complianceRegistryCid: "00".repeat(70),
        mpaHash: MPA_HASH,
        mpaUri: MPA_URI,
        musdMintCap: "10000000.0",
        currentUnstakeMinted: "0.0",
        observers: [CANTON_PARTY],
      });
      console.log("  ✓ CantonStakingService created");
    } catch (e: any) { console.error(`  ✗ ${e.message.slice(0, 250)}`); }
  }
  console.log();

  // ── CantonETHPoolService (singleton) ─────────────────────────────
  console.log("━━━ CantonETHPoolService ━━━");
  const existingPool = await queryContracts("CantonETHPool", "CantonETHPoolService");
  if (existingPool.length > 0) {
    console.log(`  ⏭  Already exists (${existingPool.length} instance(s))`);
  } else {
    try {
      await createContract("CantonETHPool", "CantonETHPoolService", {
        operator: CANTON_PARTY,
        governance: CANTON_PARTY,
        totalShares: "0.0",
        totalMusdStaked: "0.0",
        sharePrice: "1.0",
        poolCap: "10000000.0",
        lastSyncEpoch: 0,
        paused: false,
        cantonCoinPrice: "0.15",
        complianceRegistryCid: "00".repeat(70),
        directMintServiceCid: "00".repeat(70),
        musdMintCap: "10000000.0",
        currentUnstakeMinted: "0.0",
        mpaHash: MPA_HASH,
        mpaUri: MPA_URI,
        observers: [CANTON_PARTY],
      });
      console.log("  ✓ CantonETHPoolService created");
    } catch (e: any) { console.error(`  ✗ ${e.message.slice(0, 250)}`); }
  }
  console.log();

  // ── Final state ──────────────────────────────────────────────────
  console.log("━━━ Final State ━━━");
  const finalOffset = await getLedgerEnd();
  const final = await queryAllCounts();
  console.log(`  Ledger offset: ${finalOffset} (+${finalOffset - startOffset})`);
  for (const [tpl, cnt] of Object.entries(final).sort()) console.log(`  ${tpl}: ${cnt}`);
  console.log(`\n✅ Canton token deployment complete!`);
}

main().catch((err) => { console.error("✗ Fatal:", err.message); process.exit(1); });
