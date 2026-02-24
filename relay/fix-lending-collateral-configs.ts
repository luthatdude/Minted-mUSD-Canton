/**
 * fix-lending-collateral-configs.ts
 *
 * One-off script to create a new CantonLendingService with full collateral configs.
 * The existing service may only have CTN_Coin; this creates a new one (lending-v2)
 * that includes CTN_Coin, CTN_SMUSD, and CTN_SMUSDE.
 *
 * Does NOT delete the old service — the frontend deterministic selection will prefer
 * the new one (higher config count).
 *
 * Usage:
 *   cd relay
 *   NODE_ENV=development npx ts-node --skip-project fix-lending-collateral-configs.ts
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

async function cantonRequest(method: string, urlPath: string, body?: unknown): Promise<unknown> {
  const resp = await fetch(`${CANTON_BASE_URL}${urlPath}`, {
    method,
    headers: {
      "Authorization": `Bearer ${CANTON_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Canton API ${resp.status} on ${urlPath}: ${text.slice(0, 200)}`);
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
  const commandId = `fix-lending-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
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

  const LS_TPL = `${KNOWN_PKG_ID}:CantonLending:CantonLendingService`;

  // ── Step 1: Query existing LendingService contracts ──
  console.log("── Step 1: Current CantonLendingService contracts ──");
  const lsContracts = await queryTemplate(LS_TPL);
  if (lsContracts.length === 0) {
    console.log("  No existing CantonLendingService found. Will create from scratch.");
  }
  for (const ls of lsContracts) {
    const p = ls.payload;
    const rawConfigs = (p.configs as Array<Record<string, unknown>>) || [];
    const configKeys = rawConfigs.map((c) => c.collateralType as string).filter(Boolean);
    console.log(`  CID: ${ls.contractId.slice(0, 40)}...`);
    console.log(`  serviceName: ${p.serviceName || "(none)"}`);
    console.log(`  configs: [${configKeys.join(", ")}]`);
    console.log(`  paused: ${p.paused}`);
    console.log(`  totalBorrows: ${p.totalBorrows}`);
    console.log();
  }

  // ── Step 2: Check if full-config service already exists ──
  const requiredKeys = ["CTN_Coin", "CTN_SMUSD", "CTN_SMUSDE"];
  const existing = lsContracts.find((ls) => {
    const rawConfigs = (ls.payload.configs as Array<Record<string, unknown>>) || [];
    const configKeys = rawConfigs.map((c) => c.collateralType as string);
    return requiredKeys.every((k) => configKeys.includes(k));
  });

  if (existing) {
    const rawConfigs = (existing.payload.configs as Array<Record<string, unknown>>) || [];
    const configKeys = rawConfigs.map((c) => c.collateralType as string);
    console.log(`── Found LendingService with all 3 configs ──`);
    console.log(`  CID: ${existing.contractId.slice(0, 40)}...`);
    console.log(`  configs: [${configKeys.join(", ")}]`);
    console.log("  Nothing to do.");
    return;
  }

  // ── Step 3: Copy economic params from existing service or use defaults ──
  console.log("── Step 2: Creating new CantonLendingService (lending-v2) ──");
  const template = lsContracts[0];
  const tp = template?.payload || {};

  const fullConfigs: Array<Record<string, unknown>> = [
    {
      collateralType: "CTN_Coin",
      enabled: true,
      collateralFactorBps: "6500",
      liquidationThresholdBps: "7500",
      liquidationPenaltyBps: "1000",
      liquidationBonusBps: "500",
      maxStalenessSecs: "300",
    },
    {
      collateralType: "CTN_SMUSD",
      enabled: true,
      collateralFactorBps: "7500",
      liquidationThresholdBps: "8500",
      liquidationPenaltyBps: "500",
      liquidationBonusBps: "250",
      maxStalenessSecs: "300",
    },
    {
      collateralType: "CTN_SMUSDE",
      enabled: true,
      collateralFactorBps: "6500",
      liquidationThresholdBps: "7500",
      liquidationPenaltyBps: "750",
      liquidationBonusBps: "375",
      maxStalenessSecs: "300",
    },
  ];

  // If existing service has config entries, merge their params for matching keys
  if (template) {
    const existingConfigs = (tp.configs as Array<Record<string, unknown>>) || [];
    for (const ec of existingConfigs) {
      const key = ec.collateralType as string;
      const match = fullConfigs.find((c) => c.collateralType === key);
      if (match) {
        // Preserve existing values for CTN_Coin from deployed service
        for (const field of Object.keys(ec)) {
          if (ec[field] !== undefined && ec[field] !== null) {
            match[field] = ec[field];
          }
        }
      }
    }
  }

  const newPayload = {
    operator: CANTON_PARTY,
    configs: fullConfigs,
    totalBorrows: "0.000000000000000000",
    interestRateBps: tp.interestRateBps || "500",
    reserveFactorBps: tp.reserveFactorBps || "1000",
    protocolReserves: "0.000000000000000000",
    minBorrow: tp.minBorrow || "10.000000000000000000",
    closeFactorBps: tp.closeFactorBps || "5000",
    paused: false,
    cantonSupplyCap: tp.cantonSupplyCap || "10000000.000000000000000000",
    cantonCurrentSupply: "0.000000000000000000",
    directMintServiceName: tp.directMintServiceName || "direct-mint",
    globalMintCap: tp.globalMintCap || "50000000.000000000000000000",
    complianceRegistryCid: COMPLIANCE_CID,
    mpaHash: tp.mpaHash || "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6abcd",
    mpaUri: tp.mpaUri || "https://minted.app/terms",
    serviceName: "lending-v2",
    observers: tp.observers || [],
  };

  console.log(`  configs: [${fullConfigs.map((c) => c.collateralType).join(", ")}]`);

  await submitCommand([
    {
      CreateCommand: {
        templateId: LS_TPL,
        createArguments: newPayload,
      },
    },
  ]);
  console.log("  Created");

  // Re-query to find the new contract
  const refreshed = await queryTemplate(LS_TPL);
  const newContract = refreshed.find(
    (c) => c.payload.serviceName === "lending-v2"
  );
  if (!newContract) throw new Error("Failed to find newly created CantonLendingService");
  const newConfigs = (newContract.payload.configs as Array<Record<string, unknown>>) || [];
  const newConfigKeys = newConfigs.map((c) => c.collateralType as string);

  console.log();
  console.log(`  New CID: ${newContract.contractId.slice(0, 40)}...`);
  console.log(`  Config keys: [${newConfigKeys.join(", ")}]`);
  console.log(`  paused: ${newContract.payload.paused}`);
  console.log();
  console.log("Done. New lending service with CTN_Coin, CTN_SMUSD, CTN_SMUSDE configs created.");
  console.log("Frontend will auto-select it (highest config count).");
}

main().catch((err) => {
  console.error("Fix failed:", err.message || err);
  process.exit(1);
});
