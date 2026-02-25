import type { NextApiRequest, NextApiResponse } from "next";
import * as crypto from "crypto";
import {
  getCantonBaseUrl,
  getCantonToken,
  getCantonParty,
  getCantonUser,
  getPackageId,
  getCip56PackageId,
  getV3PackageIds,
  validateConfig,
  guardMethod,
  guardBodyParty,
  IdempotencyStore,
  deriveIdempotencyKey,
  parseAmount,
  gte,
  gt,
  toDisplay,
  toDamlDecimal,
} from "@/lib/api-hardening";

/**
 * /api/canton-cip56-repay — CIP-56 Native Lending Repay (Phase 4)
 *
 * Single atomic batch that:
 *   1. Archives user's CIP-56 tokens
 *   2. Creates CIP-56 change for user (if inputs > repayAmount)
 *   3. Creates CIP-56 escrow for operator
 *   4. Exercises Lending_RepayFromInventory on the lending service
 *
 * This eliminates the intermediate user-owned CantonMUSD step that the
 * hybrid flow (canton-convert + Lending_Repay) requires.
 *
 * POST { party: string, amount: string, debtCid: string }
 * Returns: { success, mode, repayAmount, commandId }
 *
 * Falls back cleanly — if this endpoint returns an error, the caller
 * should retry with the hybrid flow (canton-convert → Lending_Repay).
 */

// ── Idempotency store (bounded: 1000 entries, 5 min TTL) ────
interface RepayRecord {
  success: boolean;
  mode: string;
  repayAmount: string;
  commandId: string;
  cip56Consumed: number;
  inventoryConsumed: number;
  timestamp: string;
}

const repayLog = new IdempotencyStore<RepayRecord>();

// ── Canton API helpers ─────────────────────────────────────
interface RawContract {
  contractId: string;
  templateId: string;
  createArgument: Record<string, unknown>;
}

async function cantonRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const resp = await fetch(`${getCantonBaseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${getCantonToken()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Canton API ${resp.status}: ${text}`);
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

// ── Main handler ───────────────────────────────────────────
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (!guardMethod(req, res, "POST")) return;

  const configError = validateConfig({ requireCip56: true });
  if (configError) {
    return res.status(500).json({ success: false, error: configError.error, mode: "native" });
  }

  const userParty = guardBodyParty(req, res, { extraFields: { mode: "native" } });
  if (!userParty) return;

  const { amount, debtCid } = req.body || {};

  if (!amount || typeof amount !== "string") {
    return res.status(400).json({ error: "Missing amount", mode: "native" });
  }
  const repayAmount = parseAmount(amount);
  if (repayAmount <= 0) {
    return res.status(400).json({ error: "Amount must be positive", mode: "native" });
  }

  if (!debtCid || typeof debtCid !== "string" || debtCid.trim().length === 0) {
    return res.status(400).json({ error: "Missing debtCid", mode: "native" });
  }

  const operatorParty = getCantonParty();
  const PACKAGE_ID = getPackageId();
  const CIP56_PACKAGE_ID = getCip56PackageId();
  const V3_PACKAGE_IDS = getV3PackageIds();

  try {
    // 1. Get ledger offset
    const { offset } = await cantonRequest<{ offset: number }>("GET", "/v2/state/ledger-end");

    // 2. Query user's CIP-56 tokens
    const cip56TemplateId = `${CIP56_PACKAGE_ID}:CIP56Interfaces:CIP56MintedMUSD`;
    const userCip56Raw = await queryActiveContracts(userParty, offset, cip56TemplateId);

    const userCip56 = userCip56Raw
      .filter(c => (c.createArgument.owner as string) === userParty)
      .map(c => ({
        contractId: c.contractId,
        templateId: c.templateId,
        amount: parseAmount(c.createArgument.amount as string),
        issuer: (c.createArgument.issuer as string) || operatorParty,
        blacklisted: (c.createArgument.blacklisted as boolean) ?? false,
        agreementHash: (c.createArgument.agreementHash as string) || "",
        agreementUri: (c.createArgument.agreementUri as string) || "",
      }))
      .sort((a, b) => b.amount - a.amount);

    const totalCip56 = userCip56.reduce((s, c) => s + c.amount, 0);
    if (!gte(totalCip56, repayAmount)) {
      return res.status(400).json({
        error: `Insufficient CIP-56 balance: have ${toDisplay(totalCip56)}, need ${toDisplay(repayAmount)}`,
        mode: "native",
      });
    }

    // 3. Select CIP-56 tokens to archive (greedy, largest-first)
    const selectedCip56: typeof userCip56 = [];
    let selectedSum = 0;
    for (const c of userCip56) {
      if (gte(selectedSum, repayAmount)) break;
      selectedCip56.push(c);
      selectedSum += c.amount;
    }

    // 3a. Reject if any selected token is blacklisted (compliance safety)
    if (selectedCip56.some(c => c.blacklisted)) {
      return res.status(400).json({
        error: "One or more CIP-56 tokens are blacklisted and cannot be used for repay",
        mode: "native",
      });
    }

    // 3b. Idempotency check
    const sourceCids = selectedCip56.map(c => c.contractId);
    const idemKey = deriveIdempotencyKey("repay", sourceCids, toDisplay(repayAmount), userParty, debtCid.trim());
    const existing = repayLog.get(idemKey);
    if (existing) {
      return res.status(200).json(existing);
    }

    // 4. Discover pool-reserved CIDs to exclude from inventory
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
      } catch { /* staking service may not exist for all packages */ }
    }

    // 5. Query operator's CantonMUSD inventory
    const operatorMusd: Array<{
      contractId: string;
      templateId: string;
      amount: number;
    }> = [];

    for (const pkg of V3_PACKAGE_IDS) {
      const tplId = `${pkg}:CantonDirectMint:CantonMUSD`;
      const contracts = await queryActiveContracts(operatorParty, offset, tplId);
      for (const c of contracts) {
        if ((c.createArgument.owner as string) === operatorParty &&
            (c.createArgument.issuer as string) === operatorParty &&
            !reservedCids.has(c.contractId)) {
          operatorMusd.push({
            contractId: c.contractId,
            templateId: c.templateId,
            amount: parseAmount(c.createArgument.amount as string),
          });
        }
      }
    }

    const totalOperatorMusd = operatorMusd.reduce((s, c) => s + c.amount, 0);
    if (!gte(totalOperatorMusd, repayAmount)) {
      return res.status(409).json({
        error: `Insufficient operator inventory: have ${toDisplay(totalOperatorMusd)}, need ${toDisplay(repayAmount)}`,
        inventoryAvailable: toDisplay(totalOperatorMusd),
        mode: "native",
      });
    }

    // Select operator inventory CIDs (greedy, largest-first)
    operatorMusd.sort((a, b) => b.amount - a.amount);
    const selectedInventory: typeof operatorMusd = [];
    let inventorySum = 0;
    for (const c of operatorMusd) {
      if (gte(inventorySum, repayAmount)) break;
      selectedInventory.push(c);
      inventorySum += c.amount;
    }

    // 6. Query CantonLendingService
    const svcTemplateId = `${PACKAGE_ID}:CantonLending:CantonLendingService`;
    const svcContracts = await queryActiveContracts(operatorParty, offset, svcTemplateId);
    if (svcContracts.length === 0) {
      return res.status(404).json({
        error: "CantonLendingService not found",
        mode: "native",
      });
    }
    const lendingService = svcContracts[0];

    // 7. Build atomic batch command
    const commandId = `cip56-repay-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const commands: unknown[] = [];
    const actAs = Array.from(new Set([userParty, operatorParty]));
    const readAs = actAs;

    const refCip56 = selectedCip56[0];
    const cip56Issuer = refCip56.issuer || operatorParty;

    // A. Archive each selected CIP-56 token
    for (const c of selectedCip56) {
      commands.push({
        ExerciseCommand: {
          templateId: cip56TemplateId,
          contractId: c.contractId,
          choice: "Archive",
          choiceArgument: {},
        },
      });
    }

    // B. Create CIP-56 change for user (if inputs > repayAmount)
    const cip56Change = selectedSum - repayAmount;
    if (gt(cip56Change, 0)) {
      commands.push({
        CreateCommand: {
          templateId: cip56TemplateId,
          createArguments: {
            issuer: cip56Issuer,
            owner: userParty,
            amount: toDamlDecimal(cip56Change),
            blacklisted: false,
            agreementHash: refCip56.agreementHash,
            agreementUri: refCip56.agreementUri,
            observers: [],
          },
        },
      });
    }

    // C. Create CIP-56 escrow for operator (locked amount)
    commands.push({
      CreateCommand: {
        templateId: cip56TemplateId,
        createArguments: {
          issuer: cip56Issuer,
          owner: operatorParty,
          amount: toDamlDecimal(repayAmount),
          blacklisted: false,
          agreementHash: refCip56.agreementHash,
          agreementUri: refCip56.agreementUri,
          observers: [],
        },
      },
    });

    // D. Exercise Lending_RepayFromInventory
    commands.push({
      ExerciseCommand: {
        templateId: svcTemplateId,
        contractId: lendingService.contractId,
        choice: "Lending_RepayFromInventory",
        choiceArgument: {
          user: userParty,
          inventoryMusdCids: selectedInventory.map(c => c.contractId),
          repayAmount: toDamlDecimal(repayAmount),
          debtCid: debtCid.trim(),
        },
      },
    });

    // 8. Submit atomic batch
    console.log(
      `[canton-cip56-repay] NATIVE: ${commands.length} cmds, ` +
      `${selectedCip56.length} CIP-56 → ${selectedInventory.length} inventory → RepayFromInventory ` +
      `for ${toDisplay(repayAmount)} mUSD, user=${userParty.slice(0, 30)}`
    );

    const result = await cantonRequest("POST", "/v2/commands/submit-and-wait", {
      userId: getCantonUser(),
      actAs,
      readAs,
      commandId,
      commands,
    });

    // Record idempotency entry
    const record: RepayRecord = {
      success: true,
      mode: "native",
      repayAmount: toDisplay(repayAmount),
      commandId,
      cip56Consumed: selectedCip56.length,
      inventoryConsumed: selectedInventory.length,
      timestamp: new Date().toISOString(),
    };
    repayLog.set(idemKey, record);

    return res.status(200).json({
      ...record,
      result,
    });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[canton-cip56-repay] Error:", message);
    return res.status(502).json({ success: false, error: message, mode: "native" });
  }
}
