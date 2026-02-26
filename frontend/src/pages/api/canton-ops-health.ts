import type { NextApiRequest, NextApiResponse } from "next";
import {
  resolveRequestedParty,
  CANTON_PARTY_PATTERN,
} from "@/lib/server/canton-party-resolver";

/**
 * /api/canton-ops-health — Operator inventory health check.
 *
 * Returns operator conversion inventory status relative to a configurable
 * floor target, plus user bridge capacity metrics.
 *
 * GET ?party=<canton-party>
 *
 * Env:
 *   CANTON_OPERATOR_INVENTORY_FLOOR — target floor in mUSD (default 2000)
 */

const CANTON_BASE_URL =
  process.env.CANTON_API_URL ||
  `http://${process.env.CANTON_HOST || "localhost"}:${process.env.CANTON_PORT || "7575"}`;
const CANTON_TOKEN = process.env.CANTON_TOKEN || "";
const CANTON_PARTY = process.env.CANTON_PARTY || "";
const PACKAGE_ID =
  process.env.NEXT_PUBLIC_DAML_PACKAGE_ID ||
  process.env.CANTON_PACKAGE_ID ||
  "";
const CIP56_PACKAGE_ID =
  process.env.NEXT_PUBLIC_CIP56_PACKAGE_ID ||
  process.env.CIP56_PACKAGE_ID ||
  "";
const PKG_ID_PATTERN = /^[0-9a-f]{64}$/i;

const INVENTORY_FLOOR = Math.max(
  0,
  parseInt(process.env.CANTON_OPERATOR_INVENTORY_FLOOR || "2000", 10) || 2000
);
const INVENTORY_BUFFER = Math.max(
  0,
  parseInt(process.env.CANTON_OPERATOR_INVENTORY_BUFFER || "1000", 10) || 1000
);

function validateRequiredConfig(): string | null {
  if (!CANTON_PARTY || !CANTON_PARTY_PATTERN.test(CANTON_PARTY))
    return "CANTON_PARTY not configured";
  if (!PACKAGE_ID || !PKG_ID_PATTERN.test(PACKAGE_ID))
    return "CANTON_PACKAGE_ID/NEXT_PUBLIC_DAML_PACKAGE_ID not configured";
  return null;
}

const V3_PACKAGE_IDS: string[] = Array.from(new Set([
  PACKAGE_ID,
  process.env.CANTON_PACKAGE_ID,
].filter((id): id is string => typeof id === "string" && id.length === 64)));

// ── Canton API helpers (same as bridge-preflight) ──────────
interface RawContract {
  contractId: string;
  templateId: string;
  createArgument: Record<string, unknown>;
}

async function cantonRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const resp = await fetch(`${CANTON_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${CANTON_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Canton API ${resp.status}: ${text.slice(0, 300)}`);
  }
  return resp.json() as Promise<T>;
}

async function queryActiveContracts(
  party: string,
  offset: number,
  fullTemplateId: string
): Promise<RawContract[]> {
  try {
    const raw = await cantonRequest<unknown>("POST", "/v2/state/active-contracts?limit=200", {
      eventFormat: {
        filtersByParty: {
          [party]: {
            cumulative: [{
              identifierFilter: {
                TemplateFilter: {
                  value: { templateId: fullTemplateId, includeCreatedEventBlob: false },
                },
              },
            }],
          },
        },
        verbose: true,
      },
      activeAtOffset: offset,
    });

    const entries: unknown[] = Array.isArray(raw) ? raw :
      (raw && typeof raw === "object" && Array.isArray((raw as { result?: unknown[] }).result))
        ? (raw as { result: unknown[] }).result
        : [];

    const contracts: RawContract[] = [];
    for (const entry of entries) {
      const ac = (entry as Record<string, unknown>)?.contractEntry;
      const jsAc = ac && typeof ac === "object" ? (ac as Record<string, unknown>).JsActiveContract : null;
      if (!jsAc || typeof jsAc !== "object") continue;
      const evt = (jsAc as Record<string, unknown>).createdEvent as Record<string, unknown> | undefined;
      if (!evt) continue;
      contracts.push({
        contractId: evt.contractId as string,
        templateId: evt.templateId as string,
        createArgument: evt.createArgument as Record<string, unknown>,
      });
    }
    return contracts;
  } catch (err: unknown) {
    if (String((err as Error)?.message || "").includes("Canton API 404")) return [];
    throw err;
  }
}

// ── Handler ────────────────────────────────────────────────
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const configError = validateRequiredConfig();
  if (configError) {
    return res.status(500).json({ error: configError, errorType: "CONFIG_ERROR" });
  }

  let party: string;
  let aliasApplied = false;
  let connectedParty: string | undefined;
  try {
    const resolved = resolveRequestedParty(req.query.party);
    party = resolved.resolvedParty;
    aliasApplied = resolved.wasAliased;
    connectedParty = resolved.wasAliased ? resolved.requestedParty : undefined;
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || "Invalid or missing Canton party" });
  }

  const operatorParty = CANTON_PARTY;

  try {
    const { offset } = await cantonRequest<{ offset: number }>("GET", "/v2/state/ledger-end");

    // User CIP-56 balance
    let userCip56Balance = 0;
    if (CIP56_PACKAGE_ID) {
      const cip56TemplateId = `${CIP56_PACKAGE_ID}:CIP56Interfaces:CIP56MintedMUSD`;
      const cip56Contracts = await queryActiveContracts(party, offset, cip56TemplateId);
      for (const c of cip56Contracts) {
        if ((c.createArgument.owner as string) === party) {
          userCip56Balance += parseFloat((c.createArgument.amount as string) || "0");
        }
      }
    }

    // User redeemable balance
    let userRedeemableBalance = 0;
    for (const pkg of V3_PACKAGE_IDS) {
      const tplId = `${pkg}:CantonDirectMint:CantonMUSD`;
      const contracts = await queryActiveContracts(party, offset, tplId);
      for (const c of contracts) {
        if ((c.createArgument.owner as string) === party) {
          userRedeemableBalance += parseFloat((c.createArgument.amount as string) || "0");
        }
      }
    }

    // Operator inventory (excluding pool-reserved)
    const reservedCids = new Set<string>();
    for (const pkg of V3_PACKAGE_IDS) {
      try {
        const svcs = await queryActiveContracts(
          operatorParty, offset, `${pkg}:CantonSMUSD:CantonStakingService`
        );
        for (const s of svcs) {
          const poolCid = s.createArgument.poolMusdCid;
          if (typeof poolCid === "string" && poolCid.length > 0) {
            reservedCids.add(poolCid);
          }
        }
      } catch { /* staking service may not exist */ }
    }

    let operatorInventory = 0;
    for (const pkg of V3_PACKAGE_IDS) {
      const tplId = `${pkg}:CantonDirectMint:CantonMUSD`;
      const contracts = await queryActiveContracts(operatorParty, offset, tplId);
      for (const c of contracts) {
        if ((c.createArgument.owner as string) === operatorParty &&
            (c.createArgument.issuer as string) === operatorParty &&
            !reservedCids.has(c.contractId)) {
          operatorInventory += parseFloat((c.createArgument.amount as string) || "0");
        }
      }
    }

    // Compute derived metrics
    const convertibleCip56 = Math.min(userCip56Balance, operatorInventory);
    const maxBridgeable = userRedeemableBalance + convertibleCip56;
    const floorTarget = INVENTORY_FLOOR;
    const floorDeficit = Math.max(0, floorTarget - operatorInventory);

    // Determine blockers
    const blockers: string[] = [];
    if (userCip56Balance + userRedeemableBalance <= 0) blockers.push("NO_BALANCE");
    if (userCip56Balance > 0 && operatorInventory <= 0) blockers.push("NO_OPERATOR_INVENTORY");
    if (operatorInventory > 0 && operatorInventory < floorTarget + INVENTORY_BUFFER) blockers.push("LOW_OPERATOR_INVENTORY");
    if (userCip56Balance > operatorInventory && operatorInventory > 0) blockers.push("CAPACITY_LIMITED");

    // Status classification
    const status: "OK" | "LOW" | "EMPTY" =
      operatorInventory <= 0 ? "EMPTY" :
      operatorInventory < floorTarget ? "LOW" :
      "OK";

    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json({
      party,
      effectiveParty: party,
      ...(connectedParty ? { connectedParty } : {}),
      aliasApplied,
      operatorParty,
      userCip56Balance: userCip56Balance.toFixed(6),
      userRedeemableBalance: userRedeemableBalance.toFixed(6),
      operatorInventory: operatorInventory.toFixed(6),
      maxBridgeable: maxBridgeable.toFixed(6),
      floorTarget,
      floorDeficit: floorDeficit.toFixed(6),
      status,
      blockers,
      ledgerOffset: offset,
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[canton-ops-health] Error:", message);
    return res.status(502).json({ error: message, errorType: "CANTON_ERROR" });
  }
}
