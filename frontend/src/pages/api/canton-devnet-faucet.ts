import type { NextApiRequest, NextApiResponse } from "next";
import * as crypto from "crypto";
import {
  getCantonBaseUrl,
  getCantonToken,
  getCantonParty,
  getCantonUser,
  getPackageId,
  validateConfig,
  guardMethod,
  guardBodyParty,
  CANTON_PARTY_PATTERN,
  parseAmount,
  toDamlDecimal,
  toDisplay,
} from "@/lib/api-hardening";

/**
 * /api/canton-devnet-faucet — Devnet-only gated faucet for test asset provisioning.
 *
 * POST { party: string, asset: "mUSD" | "CTN" | "USDC" | "USDCx", amount: string }
 *
 * Safety gates (all required):
 *   1. ENABLE_DEVNET_FAUCET=true
 *   2. NODE_ENV !== "production" (or DEVNET_ENV=true)
 *   3. Party must be in DEVNET_FAUCET_ALLOWLIST
 *   4. Per-party rate limit (cooldown) + max amount per tx + daily cap
 *   5. Structured audit log for every request
 */

// ── Types ───────────────────────────────────────────────────

type FaucetAsset = "mUSD" | "CTN" | "USDC" | "USDCx";

type FaucetErrorType =
  | "DISABLED"
  | "NOT_ALLOWLISTED"
  | "RATE_LIMITED"
  | "INVALID_INPUT"
  | "CONFIG_ERROR"
  | "UPSTREAM_ERROR";

interface FaucetSuccessResponse {
  success: true;
  asset: FaucetAsset;
  amount: string;
  party: string;
  txId: string;
  remainingDailyCap: string;
  nextAllowedAt: string;
}

interface FaucetErrorResponse {
  success: false;
  error: string;
  errorType: FaucetErrorType;
  remainingDailyCap?: string;
  nextAllowedAt?: string;
}

// ── Supported assets → Canton template mapping ──────────────

const ASSET_TEMPLATE_MAP: Record<FaucetAsset, string> = {
  mUSD: "CantonDirectMint:CantonMUSD",
  CTN: "CantonCoinToken:CantonCoin",
  USDC: "CantonDirectMint:CantonUSDC",
  USDCx: "CantonDirectMint:USDCx",
};

const SUPPORTED_ASSETS = new Set<string>(Object.keys(ASSET_TEMPLATE_MAP));

// ── Rate limiting store (in-memory, bounded) ────────────────

interface PartyQuota {
  /** Timestamps of successful mints (within current day window) */
  mintTimestamps: number[];
  /** Amounts of successful mints (within current day window) */
  mintAmounts: number[];
  /** Last successful mint timestamp */
  lastMintAt: number;
}

const quotaStore = new Map<string, PartyQuota>();
const MAX_STORE_ENTRIES = 500;

function getOrCreateQuota(party: string): PartyQuota {
  let quota = quotaStore.get(party);
  if (!quota) {
    if (quotaStore.size >= MAX_STORE_ENTRIES) {
      // Evict oldest entry
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
    // Allow override via explicit DEVNET_ENV=true for staging-as-production setups
    return (process.env.DEVNET_ENV || "").toLowerCase() === "true";
  }
  return true; // development/test are always devnet-safe
}

function getAllowlist(): Set<string> {
  const raw = process.env.DEVNET_FAUCET_ALLOWLIST || "";
  if (!raw.trim()) return new Set();
  return new Set(
    raw
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
  );
}

function getMaxPerTx(): number {
  const raw = parseAmount(process.env.DEVNET_FAUCET_MAX_PER_TX);
  return raw > 0 ? raw : 100; // default: 100 units
}

function getDailyCap(): number {
  const raw = parseAmount(process.env.DEVNET_FAUCET_DAILY_CAP_PER_PARTY);
  return raw > 0 ? raw : 1000; // default: 1000 units per day
}

function getCooldownSeconds(): number {
  const raw = parseInt(process.env.DEVNET_FAUCET_COOLDOWN_SECONDS || "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30; // default: 30 seconds
}

// ── Canton API helper ───────────────────────────────────────

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

// ── Audit logger ────────────────────────────────────────────

function auditLog(entry: {
  party: string;
  asset: string;
  amount: string;
  allowlisted: boolean;
  gateResult: "ALLOWED" | "DENIED";
  decision: "MINT" | "REJECT";
  reason: string;
  txId?: string;
}): void {
  const log = {
    type: "DEVNET_FAUCET_AUDIT",
    timestamp: new Date().toISOString(),
    ...entry,
  };
  console.log(`[devnet-faucet] AUDIT: ${JSON.stringify(log)}`);
}

// ── Main handler ────────────────────────────────────────────

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<FaucetSuccessResponse | FaucetErrorResponse>
) {
  if (!guardMethod(req, res, "POST")) return;

  // Gate 1: Feature flag
  if (!isFaucetEnabled()) {
    auditLog({
      party: req.body?.party || "unknown",
      asset: req.body?.asset || "unknown",
      amount: req.body?.amount || "0",
      allowlisted: false,
      gateResult: "DENIED",
      decision: "REJECT",
      reason: "ENABLE_DEVNET_FAUCET is not true",
    });
    return res.status(403).json({
      success: false,
      error: "Devnet faucet is disabled. Set ENABLE_DEVNET_FAUCET=true to enable.",
      errorType: "DISABLED",
    });
  }

  // Gate 2: Environment check
  if (!isDevnetEnvironment()) {
    auditLog({
      party: req.body?.party || "unknown",
      asset: req.body?.asset || "unknown",
      amount: req.body?.amount || "0",
      allowlisted: false,
      gateResult: "DENIED",
      decision: "REJECT",
      reason: "Production environment without DEVNET_ENV=true",
    });
    return res.status(403).json({
      success: false,
      error: "Devnet faucet is not available in production.",
      errorType: "DISABLED",
    });
  }

  // Validate Canton config
  const configError = validateConfig();
  if (configError) {
    return res.status(500).json({
      success: false,
      error: configError.error,
      errorType: "CONFIG_ERROR",
    });
  }

  // Validate party
  const userParty = guardBodyParty(req, res);
  if (!userParty) return; // guardBodyParty already sent 400

  // Validate asset
  const { asset, amount: rawAmount } = req.body || {};
  if (!asset || typeof asset !== "string" || !SUPPORTED_ASSETS.has(asset)) {
    auditLog({
      party: userParty,
      asset: asset || "unknown",
      amount: rawAmount || "0",
      allowlisted: false,
      gateResult: "DENIED",
      decision: "REJECT",
      reason: `Invalid asset: ${asset}`,
    });
    return res.status(400).json({
      success: false,
      error: `Invalid asset. Supported: ${Array.from(SUPPORTED_ASSETS).join(", ")}`,
      errorType: "INVALID_INPUT",
    });
  }

  // Validate amount
  if (!rawAmount || typeof rawAmount !== "string") {
    return res.status(400).json({
      success: false,
      error: "Missing amount",
      errorType: "INVALID_INPUT",
    });
  }
  const amount = parseAmount(rawAmount);
  if (amount <= 0) {
    return res.status(400).json({
      success: false,
      error: "Amount must be positive",
      errorType: "INVALID_INPUT",
    });
  }

  const maxPerTx = getMaxPerTx();
  if (amount > maxPerTx) {
    auditLog({
      party: userParty,
      asset,
      amount: toDisplay(amount),
      allowlisted: true,
      gateResult: "DENIED",
      decision: "REJECT",
      reason: `Amount ${amount} exceeds max per tx ${maxPerTx}`,
    });
    return res.status(400).json({
      success: false,
      error: `Amount exceeds maximum per transaction (${maxPerTx})`,
      errorType: "INVALID_INPUT",
    });
  }

  // Gate 3: Allowlist check
  const allowlist = getAllowlist();
  if (allowlist.size === 0) {
    auditLog({
      party: userParty,
      asset,
      amount: toDisplay(amount),
      allowlisted: false,
      gateResult: "DENIED",
      decision: "REJECT",
      reason: "DEVNET_FAUCET_ALLOWLIST is empty or not configured",
    });
    return res.status(403).json({
      success: false,
      error: "Faucet allowlist is empty. Configure DEVNET_FAUCET_ALLOWLIST.",
      errorType: "CONFIG_ERROR",
    });
  }

  if (!allowlist.has(userParty)) {
    auditLog({
      party: userParty,
      asset,
      amount: toDisplay(amount),
      allowlisted: false,
      gateResult: "DENIED",
      decision: "REJECT",
      reason: "Party not in allowlist",
    });
    return res.status(403).json({
      success: false,
      error: "Party is not in the devnet faucet allowlist.",
      errorType: "NOT_ALLOWLISTED",
    });
  }

  // Gate 4: Rate limiting + daily cap
  const quota = getOrCreateQuota(userParty);
  pruneDayWindow(quota);

  const cooldownSeconds = getCooldownSeconds();
  const now = Date.now();
  const cooldownMs = cooldownSeconds * 1000;
  const nextAllowedAt = quota.lastMintAt > 0
    ? new Date(quota.lastMintAt + cooldownMs).toISOString()
    : new Date().toISOString();

  if (quota.lastMintAt > 0 && now - quota.lastMintAt < cooldownMs) {
    auditLog({
      party: userParty,
      asset,
      amount: toDisplay(amount),
      allowlisted: true,
      gateResult: "DENIED",
      decision: "REJECT",
      reason: `Cooldown active: ${cooldownSeconds}s, next allowed at ${nextAllowedAt}`,
    });
    const dailyCap = getDailyCap();
    const usedToday = quota.mintAmounts.reduce((s, a) => s + a, 0);
    return res.status(429).json({
      success: false,
      error: `Rate limited. Try again after cooldown (${cooldownSeconds}s).`,
      errorType: "RATE_LIMITED",
      remainingDailyCap: toDisplay(Math.max(0, dailyCap - usedToday)),
      nextAllowedAt,
    });
  }

  const dailyCap = getDailyCap();
  const usedToday = quota.mintAmounts.reduce((s, a) => s + a, 0);
  if (usedToday + amount > dailyCap) {
    auditLog({
      party: userParty,
      asset,
      amount: toDisplay(amount),
      allowlisted: true,
      gateResult: "DENIED",
      decision: "REJECT",
      reason: `Daily cap exceeded: used ${toDisplay(usedToday)} of ${toDisplay(dailyCap)}`,
    });
    return res.status(429).json({
      success: false,
      error: `Daily cap exceeded. Used ${toDisplay(usedToday)} of ${toDisplay(dailyCap)} today.`,
      errorType: "RATE_LIMITED",
      remainingDailyCap: toDisplay(Math.max(0, dailyCap - usedToday)),
      nextAllowedAt: new Date().toISOString(),
    });
  }

  // ── Execute mint via Canton ───────────────────────────────
  const operatorParty = getCantonParty();
  const packageId = getPackageId();
  const templatePath = ASSET_TEMPLATE_MAP[asset as FaucetAsset];
  const fullTemplateId = `${packageId}:${templatePath}`;
  const commandId = `devnet-faucet-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

  try {
    // Build create payload — each DAML template has different required fields.
    // Discovered empirically via Canton API error responses:
    //   CantonMUSD:  requires agreementHash, agreementUri
    //   CantonCoin:  base fields only (issuer, owner, amount, privacyObservers)
    //   CantonUSDC:  base fields only
    //   USDCx:       requires sourceChain
    const baseFields = {
      issuer: operatorParty,
      owner: userParty,
      amount: toDamlDecimal(amount),
      privacyObservers: [],
    };

    const templateExtras: Record<FaucetAsset, Record<string, unknown>> = {
      mUSD: { agreementHash: "0000000000000000000000000000000000000000000000000000000000000000", agreementUri: "devnet-faucet" },
      CTN: {},
      USDC: {},
      USDCx: { sourceChain: "0", cctpNonce: "0" },
    };

    const createPayload: Record<string, unknown> = {
      ...baseFields,
      ...templateExtras[asset as FaucetAsset],
    };

    const body = {
      userId: getCantonUser(),
      actAs: [operatorParty, userParty],
      readAs: [operatorParty, userParty],
      commandId,
      commands: [
        {
          CreateCommand: {
            templateId: fullTemplateId,
            createArguments: createPayload,
          },
        },
      ],
    };

    console.log(
      `[devnet-faucet] MINT: ${asset} ${toDisplay(amount)} for ${userParty.slice(0, 30)}...`
    );

    await cantonRequest("POST", "/v2/commands/submit-and-wait", body);

    // Record successful mint in quota
    quota.mintTimestamps.push(now);
    quota.mintAmounts.push(amount);
    quota.lastMintAt = now;

    const remainingDailyCap = toDisplay(Math.max(0, dailyCap - usedToday - amount));
    const newNextAllowedAt = new Date(now + cooldownMs).toISOString();

    auditLog({
      party: userParty,
      asset,
      amount: toDisplay(amount),
      allowlisted: true,
      gateResult: "ALLOWED",
      decision: "MINT",
      reason: "All gates passed",
      txId: commandId,
    });

    return res.status(200).json({
      success: true,
      asset: asset as FaucetAsset,
      amount: toDisplay(amount),
      party: userParty,
      txId: commandId,
      remainingDailyCap,
      nextAllowedAt: newNextAllowedAt,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[devnet-faucet] Upstream error:", message);

    auditLog({
      party: userParty,
      asset,
      amount: toDisplay(amount),
      allowlisted: true,
      gateResult: "ALLOWED",
      decision: "REJECT",
      reason: `Upstream error: ${message}`,
    });

    return res.status(502).json({
      success: false,
      error: message,
      errorType: "UPSTREAM_ERROR",
    });
  }
}
