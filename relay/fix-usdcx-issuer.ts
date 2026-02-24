/**
 * fix-usdcx-issuer.ts
 *
 * One-off script to fix the USDCx minting disabled issue.
 * Creates a new CantonDirectMintService with usdcxIssuer set to operator party,
 * then repoints ETHPoolService to use it.
 *
 * Usage:
 *   cd relay
 *   NODE_ENV=development npx ts-node --skip-project fix-usdcx-issuer.ts
 */

import * as dotenv from "dotenv";
import * as path from "path";
import * as crypto from "crypto";

dotenv.config({ path: path.resolve(__dirname, ".env.development") });

const CANTON_HOST = process.env.CANTON_HOST || "localhost";
const CANTON_PORT = process.env.CANTON_PORT || "7575";
const CANTON_BASE_URL = `http://${CANTON_HOST}:${CANTON_PORT}`;
const CANTON_TOKEN = process.env.CANTON_TOKEN || "dummy-no-auth";
const CANTON_PARTY = process.env.CANTON_PARTY || "";
const CANTON_USER = process.env.CANTON_USER || "administrator";

const KNOWN_PKG_ID = "eff3bf30edb508b2d052f969203db972e59c66e974344ed43016cfccfa618f06";
const COMPLIANCE_CID =
  "00f23ba244aa3972ffb23b6c93dbf9968a5fb619bd7d44eafc5f8b62855ce1e9d8ca121220d7cf0db4307b499ac60375f2b0508bafea673a8492f389e341c85768b832e4b7";

// ── Low-level helpers (eventFormat-based, compatible with node limit) ──

async function cantonRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const resp = await fetch(`${CANTON_BASE_URL}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${CANTON_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Canton API ${resp.status} on ${path}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function getLedgerEnd(): Promise<number> {
  const resp = (await cantonRequest("GET", "/v2/state/ledger-end")) as { offset: number };
  return resp.offset;
}

interface ActiveContract {
  contractId: string;
  templateId: string;
  payload: Record<string, unknown>;
}

async function queryTemplate(fullTemplateId: string): Promise<ActiveContract[]> {
  const offset = await getLedgerEnd();
  const body = {
    eventFormat: {
      filtersByParty: {
        [CANTON_PARTY]: {
          cumulative: [
            {
              identifierFilter: {
                TemplateFilter: {
                  value: {
                    templateId: fullTemplateId,
                    includeCreatedEventBlob: false,
                  },
                },
              },
            },
          ],
        },
      },
      verbose: true,
    },
    activeAtOffset: offset,
  };
  const raw = (await cantonRequest("POST", "/v2/state/active-contracts?limit=200", body)) as unknown[];
  const results: ActiveContract[] = [];
  for (const entry of raw) {
    const ac = (entry as any)?.contractEntry?.JsActiveContract;
    if (!ac) continue;
    const evt = ac.createdEvent;
    results.push({
      contractId: evt.contractId,
      templateId: evt.templateId,
      payload: evt.createArgument,
    });
  }
  return results;
}

async function submitCommand(commands: unknown[]): Promise<unknown> {
  const commandId = `fix-usdcx-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  return cantonRequest("POST", "/v2/commands/submit-and-wait", {
    userId: CANTON_USER,
    actAs: [CANTON_PARTY],
    readAs: [CANTON_PARTY],
    commandId,
    commands,
  });
}

// ── Main ──

async function main(): Promise<void> {
  if (!CANTON_PARTY) throw new Error("CANTON_PARTY not set");

  console.log(`Canton API: ${CANTON_BASE_URL}`);
  console.log(`Operator:   ${CANTON_PARTY.slice(0, 40)}...`);
  console.log(`Package:    ${KNOWN_PKG_ID.slice(0, 16)}...`);
  console.log();

  const DM_TPL = `${KNOWN_PKG_ID}:CantonDirectMint:CantonDirectMintService`;
  const EP_TPL = `${KNOWN_PKG_ID}:CantonETHPool:CantonETHPoolService`;

  // ── Step 1: Query DirectMintService contracts ──
  console.log("── Step 1: Current DirectMintService contracts ──");
  const dmContracts = await queryTemplate(DM_TPL);
  for (const dm of dmContracts) {
    const p = dm.payload;
    console.log(`  CID: ${dm.contractId.slice(0, 40)}...`);
    console.log(`  serviceName: ${p.serviceName}`);
    console.log(`  usdcxIssuer: ${JSON.stringify(p.usdcxIssuer)}`);
    console.log(`  paused: ${p.paused}`);
    console.log();
  }

  // ── Step 2: Query ETHPoolService ──
  console.log("── Step 2: Current ETHPoolService ──");
  const epContracts = await queryTemplate(EP_TPL);
  if (epContracts.length === 0) throw new Error("No ETHPoolService found");
  const ethPool = epContracts[0];
  const ep = ethPool.payload;
  console.log(`  CID: ${ethPool.contractId.slice(0, 40)}...`);
  console.log(`  directMintServiceCid: ${String(ep.directMintServiceCid || "").slice(0, 40)}...`);
  console.log(`  governance: ${String(ep.governance || "").slice(0, 40)}...`);
  console.log();

  // ── Step 3: Check if USDCx-enabled DirectMint already exists ──
  const existing = dmContracts.find((c) => c.payload.usdcxIssuer !== null);
  if (existing) {
    console.log(`── Found DirectMint with usdcxIssuer enabled ──`);
    console.log(`  CID: ${existing.contractId.slice(0, 40)}...`);
    console.log(`  serviceName: ${existing.payload.serviceName}`);
    if (ep.directMintServiceCid === existing.contractId) {
      console.log("  ETHPool already points to this service. Nothing to do.");
      return;
    }
  }

  let newDmCid: string;

  if (existing) {
    newDmCid = existing.contractId;
  } else {
    // ── Step 4: Create new DirectMintService with usdcxIssuer ──
    console.log("── Step 3: Creating new DirectMintService with usdcxIssuer ──");

    const template = dmContracts.find((c) => c.payload.serviceName === "minted-direct-mint-v1") || dmContracts[0];
    if (!template) throw new Error("No existing DirectMintService to copy from");
    const tp = template.payload;

    const newPayload = {
      operator: CANTON_PARTY,
      usdcIssuer: tp.usdcIssuer || CANTON_PARTY,
      usdcxIssuer: CANTON_PARTY,             // ← THE FIX: enable USDCx minting
      mintFeeBps: tp.mintFeeBps || "30",
      redeemFeeBps: tp.redeemFeeBps || "30",
      minAmount: tp.minAmount || "1.000000000000000000",
      maxAmount: tp.maxAmount || "1000000.000000000000000000",
      supplyCap: tp.supplyCap || "100000000.000000000000000000",
      currentSupply: "0.000000000000000000",
      accumulatedFees: "0.000000000000000000",
      paused: false,
      validators: tp.validators || [CANTON_PARTY],
      targetChainId: tp.targetChainId || "11155111",
      targetTreasury: tp.targetTreasury || "0x6218782d1699C9DCA2EB16495c6307C3729cC546",
      nextNonce: "1",
      dailyMintLimit: tp.dailyMintLimit || "10000000.000000000000000000",
      dailyMinted: "0.000000000000000000",
      dailyBurned: "0.000000000000000000",
      lastRateLimitReset: "1970-01-01T00:00:00Z",
      complianceRegistryCid: COMPLIANCE_CID,
      mpaHash: tp.mpaHash || "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      mpaUri: tp.mpaUri || "ipfs://QmDevMPA",
      authorizedMinters: tp.authorizedMinters || [CANTON_PARTY],
      cantonCoinPrice: tp.cantonCoinPrice,    // preserve existing (null)
      serviceName: "minted-direct-mint-v1-usdcx",
    };

    await submitCommand([
      {
        CreateCommand: {
          templateId: DM_TPL,
          createArguments: newPayload,
        },
      },
    ]);
    console.log("  Created");

    // Re-query to find the new contract
    const refreshed = await queryTemplate(DM_TPL);
    const newContract = refreshed.find(
      (c) => c.payload.serviceName === "minted-direct-mint-v1-usdcx" && c.payload.usdcxIssuer !== null
    );
    if (!newContract) throw new Error("Failed to find newly created DirectMintService");
    newDmCid = newContract.contractId;
    console.log(`  New CID: ${newDmCid.slice(0, 40)}...`);
    console.log(`  usdcxIssuer: ${String(newContract.payload.usdcxIssuer).slice(0, 30)}...`);
    console.log();
  }

  // ── Step 5: Repoint ETHPoolService ──
  console.log("── Step 4: Repoint ETHPoolService ──");
  console.log(`  Old directMintServiceCid: ${String(ep.directMintServiceCid || "").slice(0, 40)}...`);
  console.log(`  New directMintServiceCid: ${newDmCid.slice(0, 40)}...`);

  if (ep.directMintServiceCid === newDmCid) {
    console.log("  Already pointing to new service. Skipping.");
  } else {
    await submitCommand([
      {
        ExerciseCommand: {
          templateId: EP_TPL,
          contractId: ethPool.contractId,
          choice: "ETHPool_SetDirectMintService",
          choiceArgument: { newServiceCid: newDmCid },
        },
      },
    ]);
    console.log("  Repointed!");

    // Verify
    const verifyPool = await queryTemplate(EP_TPL);
    const updated = verifyPool[0];
    console.log(`  Verified: ${String(updated?.payload?.directMintServiceCid || "").slice(0, 40)}...`);
  }
  console.log();

  console.log("Done. ETHPool now points to DirectMintService with usdcxIssuer enabled.");
}

main().catch((err) => {
  console.error("Fix failed:", err.message || err);
  process.exit(1);
});
