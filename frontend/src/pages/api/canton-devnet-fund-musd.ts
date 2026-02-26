import type { NextApiRequest, NextApiResponse } from "next";
import * as crypto from "crypto";
import {
  getCantonBaseUrl,
  getCantonToken,
  getCantonParty,
  getCantonUser,
  getPackageId,
  getV3PackageIds,
  validateConfig,
  guardMethod,
  guardBodyParty,
  IdempotencyStore,
  deriveIdempotencyKey,
  parseAmount,
  gte,
  gt,
  toDamlDecimal,
  toDisplay,
} from "@/lib/api-hardening";

/**
 * /api/canton-devnet-fund-musd — Devnet-only operator-mediated mUSD funding.
 *
 * Resolves the single-party devnet limitation where direct CantonMUSD creates
 * fail when issuer == owner (DAML precondition). Instead of creating from
 * scratch, this endpoint transfers mUSD from operator inventory to the target
 * party via an atomic batch:
 *
 *   1. Archive operator-owned CantonMUSD contract(s)
 *   2. Create new CantonMUSD owned by target party (amount requested)
 *   3. Create change CantonMUSD for operator (if inventory > requested)
 *
 * POST { party: string, amount: string, mode?: "inventory_transfer" }
 *
 * Safety gates (same as faucet + mUSD-specific):
 *   1. ENABLE_DEVNET_FAUCET=true
 *   2. NODE_ENV !== "production" (or DEVNET_ENV=true)
 *   3. Party in DEVNET_FAUCET_ALLOWLIST
 *   4. Per-party rate limit + max per tx + daily cap
 *   5. Structured audit log
 *   6. Sufficient operator inventory required
 *   7. Idempotency (short-window dedup)
 */

// ── Types ───────────────────────────────────────────────────

type FundingMode = "inventory_transfer";

type FundErrorType =
  | "DISABLED"
  | "NOT_ALLOWLISTED"
  | "RATE_LIMITED"
  | "INVALID_INPUT"
  | "CONFIG_ERROR"
  | "INSUFFICIENT_OPERATOR_INVENTORY"
  | "UNSUPPORTED_MODE"
  | "UPSTREAM_ERROR";

interface FundSuccessResponse {
  success: true;
  asset: "mUSD";
  amount: string;
  party: string;
  mode: FundingMode;
  txId: string;
  inventoryConsumed: number;
  inventoryRemaining: string;
  remainingDailyCap: string;
  nextAllowedAt: string;
}

interface FundErrorResponse {
  success: false;
  error: string;
  errorType: FundErrorType;
  remainingDailyCap?: string;
  nextAllowedAt?: string;
  inventoryAvailable?: string;
}

// ── Idempotency store ───────────────────────────────────────

interface FundRecord {
  success: true;
  asset: "mUSD";
  amount: string;
  party: string;
  mode: FundingMode;
  txId: string;
  inventoryConsumed: number;
  inventoryRemaining: string;
  remainingDailyCap: string;
  nextAllowedAt: string;
  timestamp: string;
}

const fundLog = new IdempotencyStore<FundRecord>();

// ── Rate limiting (shared daily quota with faucet by party) ─

interface PartyQuota {
  mintTimestamps: number[];
  mintAmounts: number[];
  lastMintAt: number;
}

const quotaStore = new Map<string, PartyQuota>();
const MAX_STORE_ENTRIES = 500;

function getOrCreateQuota(party: string): PartyQuota {
  let quota = quotaStore.get(party);
  if (!quota) {
    if (quotaStore.size >= MAX_STORE_ENTRIES) {
      const oldestKey = quotaStore.keys().next().value;
      if (oldestKey) quotaStore.delete(oldestKey);
    }
    quota = { mintTimestamps: [], mintAmounts: [], lastMintAt: 0 };
    quotaStore.set(party, quota);
  }
  return quota;
}

function pruneDayWindow(quota: PartyQuota): void {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  while (quota.mintTimestamps.length > 0 && quota.mintTimestamps[0] < dayAgo) {
    quota.mintTimestamps.shift();
    quota.mintAmounts.shift();
  }
}

// ── Config readers ──────────────────────────────────────────

function isFaucetEnabled(): boolean {
  return (process.env.ENABLE_DEVNET_FAUCET || "").toLowerCase() === "true";
}

function isDevnetEnvironment(): boolean {
  if (process.env.NODE_ENV === "production") {
    return (process.env.DEVNET_ENV || "").toLowerCase() === "true";
  }
  return true;
}

function getAllowlist(): Set<string> {
  const raw = process.env.DEVNET_FAUCET_ALLOWLIST || "";
  if (!raw.trim()) return new Set();
  return new Set(raw.split(",").map((p) => p.trim()).filter((p) => p.length > 0));
}

function getMaxPerTx(): number {
  const raw = parseAmount(process.env.DEVNET_FAUCET_MAX_PER_TX);
  return raw > 0 ? raw : 100;
}

function getDailyCap(): number {
  const raw = parseAmount(process.env.DEVNET_FAUCET_DAILY_CAP_PER_PARTY);
  return raw > 0 ? raw : 1000;
}

function getCooldownSeconds(): number {
  const raw = parseInt(process.env.DEVNET_FAUCET_COOLDOWN_SECONDS || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

// ── Canton API helpers ──────────────────────────────────────

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

// ── Audit logger ────────────────────────────────────────────

function auditLog(entry: {
  party: string;
  amount: string;
  mode: string;
  allowlisted: boolean;
  gateResult: "ALLOWED" | "DENIED";
  decision: "FUND" | "REJECT";
  reason: string;
  txId?: string;
  inventoryBefore?: string;
  inventoryAfter?: string;
}): void {
  const log = {
    type: "DEVNET_MUSD_FUND_AUDIT",
    timestamp: new Date().toISOString(),
    asset: "mUSD",
    ...entry,
  };
  console.log(`[devnet-fund-musd] AUDIT: ${JSON.stringify(log)}`);
}

// ── Main handler ────────────────────────────────────────────

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<FundSuccessResponse | FundErrorResponse>
) {
  if (!guardMethod(req, res, "POST")) return;

  // Gate 1: Feature flag
  if (!isFaucetEnabled()) {
    auditLog({ party: req.body?.party || "unknown", amount: req.body?.amount || "0", mode: "inventory_transfer", allowlisted: false, gateResult: "DENIED", decision: "REJECT", reason: "ENABLE_DEVNET_FAUCET is not true" });
    return res.status(403).json({ success: false, error: "Devnet faucet is disabled. Set ENABLE_DEVNET_FAUCET=true to enable.", errorType: "DISABLED" });
  }

  // Gate 2: Environment check
  if (!isDevnetEnvironment()) {
    auditLog({ party: req.body?.party || "unknown", amount: req.body?.amount || "0", mode: "inventory_transfer", allowlisted: false, gateResult: "DENIED", decision: "REJECT", reason: "Production environment without DEVNET_ENV=true" });
    return res.status(403).json({ success: false, error: "Devnet faucet is not available in production.", errorType: "DISABLED" });
  }

  // Validate Canton config
  const configError = validateConfig();
  if (configError) {
    return res.status(500).json({ success: false, error: configError.error, errorType: "CONFIG_ERROR" });
  }

  // Validate party
  const userParty = guardBodyParty(req, res);
  if (!userParty) return;

  // Validate mode
  const { amount: rawAmount, mode: rawMode } = req.body || {};
  const mode: FundingMode = rawMode === "native_convert_seed" ? "inventory_transfer" : "inventory_transfer";
  if (rawMode && rawMode !== "inventory_transfer" && rawMode !== "native_convert_seed") {
    return res.status(400).json({ success: false, error: `Unsupported mode: ${rawMode}. Use "inventory_transfer".`, errorType: "UNSUPPORTED_MODE" });
  }

  // Validate amount
  if (!rawAmount || typeof rawAmount !== "string") {
    return res.status(400).json({ success: false, error: "Missing amount", errorType: "INVALID_INPUT" });
  }
  const amount = parseAmount(rawAmount);
  if (amount <= 0) {
    return res.status(400).json({ success: false, error: "Amount must be positive", errorType: "INVALID_INPUT" });
  }
  const maxPerTx = getMaxPerTx();
  if (amount > maxPerTx) {
    auditLog({ party: userParty, amount: toDisplay(amount), mode, allowlisted: true, gateResult: "DENIED", decision: "REJECT", reason: `Amount ${amount} exceeds max per tx ${maxPerTx}` });
    return res.status(400).json({ success: false, error: `Amount exceeds maximum per transaction (${maxPerTx})`, errorType: "INVALID_INPUT" });
  }

  // Gate 3: Allowlist check
  const allowlist = getAllowlist();
  if (allowlist.size === 0) {
    auditLog({ party: userParty, amount: toDisplay(amount), mode, allowlisted: false, gateResult: "DENIED", decision: "REJECT", reason: "DEVNET_FAUCET_ALLOWLIST is empty" });
    return res.status(403).json({ success: false, error: "Faucet allowlist is empty. Configure DEVNET_FAUCET_ALLOWLIST.", errorType: "CONFIG_ERROR" });
  }
  if (!allowlist.has(userParty)) {
    auditLog({ party: userParty, amount: toDisplay(amount), mode, allowlisted: false, gateResult: "DENIED", decision: "REJECT", reason: "Party not in allowlist" });
    return res.status(403).json({ success: false, error: "Party is not in the devnet faucet allowlist.", errorType: "NOT_ALLOWLISTED" });
  }

  // Gate 4: Rate limiting + daily cap
  const quota = getOrCreateQuota(userParty);
  pruneDayWindow(quota);

  const cooldownSeconds = getCooldownSeconds();
  const now = Date.now();
  const cooldownMs = cooldownSeconds * 1000;
  const dailyCap = getDailyCap();
  const usedToday = quota.mintAmounts.reduce((s, a) => s + a, 0);

  if (quota.lastMintAt > 0 && now - quota.lastMintAt < cooldownMs) {
    const nextAllowedAt = new Date(quota.lastMintAt + cooldownMs).toISOString();
    auditLog({ party: userParty, amount: toDisplay(amount), mode, allowlisted: true, gateResult: "DENIED", decision: "REJECT", reason: `Cooldown active: ${cooldownSeconds}s` });
    return res.status(429).json({ success: false, error: `Rate limited. Try again after cooldown (${cooldownSeconds}s).`, errorType: "RATE_LIMITED", remainingDailyCap: toDisplay(Math.max(0, dailyCap - usedToday)), nextAllowedAt });
  }

  if (usedToday + amount > dailyCap) {
    auditLog({ party: userParty, amount: toDisplay(amount), mode, allowlisted: true, gateResult: "DENIED", decision: "REJECT", reason: `Daily cap exceeded: ${toDisplay(usedToday)}/${toDisplay(dailyCap)}` });
    return res.status(429).json({ success: false, error: `Daily cap exceeded. Used ${toDisplay(usedToday)} of ${toDisplay(dailyCap)} today.`, errorType: "RATE_LIMITED", remainingDailyCap: toDisplay(Math.max(0, dailyCap - usedToday)), nextAllowedAt: new Date().toISOString() });
  }

  // ── Execute: Operator inventory transfer ──────────────────
  const operatorParty = getCantonParty();
  const V3_PACKAGE_IDS = getV3PackageIds();

  try {
    // 1. Get ledger offset
    const { offset } = await cantonRequest<{ offset: number }>("GET", "/v2/state/ledger-end");

    // 2. Discover pool-reserved CIDs (exclude from inventory)
    const reservedCids = new Set<string>();
    for (const pkg of V3_PACKAGE_IDS) {
      try {
        const svcs = await queryActiveContracts(operatorParty, offset, `${pkg}:CantonSMUSD:CantonStakingService`);
        for (const s of svcs) {
          const poolCid = s.createArgument.poolMusdCid;
          if (typeof poolCid === "string" && poolCid.length > 0) reservedCids.add(poolCid);
        }
      } catch { /* staking service may not exist */ }
    }

    // 3. Query operator's CantonMUSD inventory
    const operatorMusd: Array<{
      contractId: string;
      templateId: string;
      amount: number;
      agreementHash: string;
      agreementUri: string;
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
            agreementHash: (c.createArgument.agreementHash as string) || "",
            agreementUri: (c.createArgument.agreementUri as string) || "",
          });
        }
      }
    }

    const totalInventory = operatorMusd.reduce((s, c) => s + c.amount, 0);
    if (!gte(totalInventory, amount)) {
      auditLog({ party: userParty, amount: toDisplay(amount), mode, allowlisted: true, gateResult: "DENIED", decision: "REJECT", reason: `Insufficient inventory: ${toDisplay(totalInventory)} < ${toDisplay(amount)}`, inventoryBefore: toDisplay(totalInventory) });
      return res.status(409).json({
        success: false,
        error: `Insufficient operator mUSD inventory: have ${toDisplay(totalInventory)}, need ${toDisplay(amount)}. Run ops:topup to restore.`,
        errorType: "INSUFFICIENT_OPERATOR_INVENTORY",
        inventoryAvailable: toDisplay(totalInventory),
      });
    }

    // 4. Select inventory CIDs (greedy, largest-first)
    operatorMusd.sort((a, b) => b.amount - a.amount);
    const selected: typeof operatorMusd = [];
    let selectedSum = 0;
    for (const c of operatorMusd) {
      if (gte(selectedSum, amount)) break;
      selected.push(c);
      selectedSum += c.amount;
    }

    // 5. Idempotency check
    const sourceCids = selected.map((c) => c.contractId);
    const idemKey = deriveIdempotencyKey("fund-musd", sourceCids, toDisplay(amount), userParty);
    const existing = fundLog.get(idemKey);
    if (existing) {
      return res.status(200).json(existing);
    }

    // 6. Build atomic batch command
    const commandId = `devnet-fund-musd-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const commands: unknown[] = [];

    // Preserve template metadata from reference contract
    const refContract = selected[0];
    const refTemplateId = refContract.templateId;

    // A. Archive each selected operator inventory contract
    for (const c of selected) {
      commands.push({
        ExerciseCommand: {
          templateId: c.templateId,
          contractId: c.contractId,
          choice: "Archive",
          choiceArgument: {},
        },
      });
    }

    // B. Create new CantonMUSD for target party (funded amount)
    commands.push({
      CreateCommand: {
        templateId: refTemplateId,
        createArguments: {
          issuer: operatorParty,
          owner: userParty,
          amount: toDamlDecimal(amount),
          agreementHash: refContract.agreementHash,
          agreementUri: refContract.agreementUri,
          privacyObservers: [],
        },
      },
    });

    // C. Create change for operator (if inputs > requested)
    const change = selectedSum - amount;
    if (gt(change, 0)) {
      commands.push({
        CreateCommand: {
          templateId: refTemplateId,
          createArguments: {
            issuer: operatorParty,
            owner: operatorParty,
            amount: toDamlDecimal(change),
            agreementHash: refContract.agreementHash,
            agreementUri: refContract.agreementUri,
            privacyObservers: [],
          },
        },
      });
    }

    // 7. Submit atomic batch
    // CantonMUSD has `signatory issuer, owner` — both parties must authorize.
    // On multi-party devnets, both must be connected to the synchronizer.
    const actAs = [operatorParty];
    if (userParty !== operatorParty) {
      actAs.push(userParty);
    }

    console.log(
      `[devnet-fund-musd] TRANSFER: ${selected.length} inventory → ${toDisplay(amount)} mUSD for ${userParty.slice(0, 30)}... (change: ${toDisplay(change)})`
    );

    await cantonRequest("POST", "/v2/commands/submit-and-wait", {
      userId: getCantonUser(),
      actAs,
      readAs: actAs,
      commandId,
      commands,
    });

    // Record in quota and idempotency
    quota.mintTimestamps.push(now);
    quota.mintAmounts.push(amount);
    quota.lastMintAt = now;

    const inventoryRemaining = toDisplay(Math.max(0, totalInventory - amount));
    const remainingDailyCap = toDisplay(Math.max(0, dailyCap - usedToday - amount));
    const nextAllowedAt = new Date(now + cooldownMs).toISOString();

    const record: FundRecord = {
      success: true,
      asset: "mUSD",
      amount: toDisplay(amount),
      party: userParty,
      mode,
      txId: commandId,
      inventoryConsumed: selected.length,
      inventoryRemaining,
      remainingDailyCap,
      nextAllowedAt,
      timestamp: new Date().toISOString(),
    };
    fundLog.set(idemKey, record);

    auditLog({
      party: userParty,
      amount: toDisplay(amount),
      mode,
      allowlisted: true,
      gateResult: "ALLOWED",
      decision: "FUND",
      reason: "All gates passed",
      txId: commandId,
      inventoryBefore: toDisplay(totalInventory),
      inventoryAfter: inventoryRemaining,
    });

    return res.status(200).json(record);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[devnet-fund-musd] Upstream error:", message);
    auditLog({ party: userParty, amount: toDisplay(amount), mode, allowlisted: true, gateResult: "ALLOWED", decision: "REJECT", reason: `Upstream error: ${message}` });
    return res.status(502).json({ success: false, error: message, errorType: "UPSTREAM_ERROR" });
  }
}
