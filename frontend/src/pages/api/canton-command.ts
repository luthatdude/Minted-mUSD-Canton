import type { NextApiRequest, NextApiResponse } from "next";
import * as crypto from "crypto";
import {
  getCantonBaseUrl,
  getCantonToken,
  getCantonParty,
  getCantonUser,
  getPackageId,
  getLendingPackageId,
  validateConfig,
  PKG_ID_PATTERN,
  guardMethod,
} from "@/lib/api-hardening";
import {
  resolveRequestedParty as resolvePartyViaSharedResolver,
  CANTON_PARTY_PATTERN,
} from "@/lib/server/canton-party-resolver";

/**
 * /api/canton-command — Server-side proxy to submit DAML commands to Canton.
 *
 * Supports:
 *   POST { action: "exercise", templateId, contractId, choice, argument }
 *   POST { action: "create", templateId, payload }
 *
 * Template IDs can be passed as short names (e.g. "CantonStakingService") or
 * fully qualified (e.g. "pkgId:Module:Entity"). Short names are resolved
 * via TEMPLATE_MAP below.
 *
 * This keeps the Canton auth token server-side and avoids CORS.
 */
const ALLOW_OPERATOR_FALLBACK =
  (process.env.CANTON_ALLOW_OPERATOR_FALLBACK || "").toLowerCase() === "true";

/**
 * Map short template names to fully-qualified Canton template IDs.
 * Format: "packageId:ModuleName:EntityName"
 */
function buildTemplateMap(): Record<string, string> {
  const pkgId = getPackageId();
  const lendingPkgId = getLendingPackageId();
  return {
    // CantonDirectMint module
    CantonMUSD:              `${pkgId}:CantonDirectMint:CantonMUSD`,
    CantonUSDC:              `${pkgId}:CantonDirectMint:CantonUSDC`,
    USDCx:                   `${pkgId}:CantonDirectMint:USDCx`,
    CantonDirectMintService: `${pkgId}:CantonDirectMint:CantonDirectMintService`,
    BridgeOutRequest:        `${pkgId}:CantonDirectMint:BridgeOutRequest`,
    // CantonSMUSD module
    CantonStakingService:    `${pkgId}:CantonSMUSD:CantonStakingService`,
    CantonSMUSD:             `${pkgId}:CantonSMUSD:CantonSMUSD`,
    // CantonETHPool module
    CantonETHPoolService:    `${pkgId}:CantonETHPool:CantonETHPoolService`,
    CantonSMUSD_E:           `${pkgId}:CantonETHPool:CantonSMUSD_E`,
    // CantonBoostPool module
    CantonBoostPoolService:  `${pkgId}:CantonBoostPool:CantonBoostPoolService`,
    BoostPoolLP:             `${pkgId}:CantonBoostPool:BoostPoolLP`,
    // CantonLending module (separate package — LF2-compatible build)
    CantonLendingService:    `${lendingPkgId}:CantonLending:CantonLendingService`,
    CantonPriceFeed:         `${lendingPkgId}:CantonLending:CantonPriceFeed`,
    EscrowedCollateral:      `${lendingPkgId}:CantonLending:EscrowedCollateral`,
    CantonDebtPosition:      `${lendingPkgId}:CantonLending:CantonDebtPosition`,
    // CantonCoinToken module
    CantonCoin:              `${pkgId}:CantonCoinToken:CantonCoin`,
    // CantonCoinMint module
    CoinMintService:         `${pkgId}:CantonCoinMint:CoinMintService`,
    // Minted.Protocol.V3 module
    BridgeService:           `${pkgId}:Minted.Protocol.V3:BridgeService`,
    MUSDSupplyService:       `${pkgId}:Minted.Protocol.V3:MUSDSupplyService`,
    MintedMUSD:              `${pkgId}:Minted.Protocol.V3:MintedMUSD`,
    // Compliance module
    ComplianceRegistry:      `${pkgId}:Compliance:ComplianceRegistry`,
  };
}

/** Resolve a short name or pass through a fully-qualified template ID. */
function resolveTemplateId(tpl: string): string {
  // Already fully qualified (contains ':')
  if (tpl.includes(":")) return tpl;
  const TEMPLATE_MAP = buildTemplateMap();
  const resolved = TEMPLATE_MAP[tpl];
  if (!resolved) throw new Error(`Unknown template short name: ${tpl}. Use fully qualified ID or add to TEMPLATE_MAP.`);
  return resolved;
}

function resolveRequestedParty(rawParty: unknown): string {
  const raw = typeof rawParty === "string" ? rawParty : undefined;
  try {
    const resolved = resolvePartyViaSharedResolver(
      raw ? [raw] : undefined,
      { allowFallback: ALLOW_OPERATOR_FALLBACK }
    );
    return resolved.resolvedParty;
  } catch {
    if (!raw || !raw.trim()) {
      throw new Error("Missing Canton party for command submission");
    }
    throw new Error("Invalid Canton party");
  }
}

function shouldOperatorCosignCreate(
  resolvedTemplateId: string,
  payload: Record<string, unknown>,
  actAsParty: string
): boolean {
  // Devnet faucet mint flow: create operator-issued user-owned token contracts.
  const entityName = resolvedTemplateId.split(":").pop() || "";
  const faucetEntities = new Set(["CantonCoin", "CantonUSDC", "USDCx"]);
  if (!faucetEntities.has(entityName)) return false;

  const issuer = typeof payload.issuer === "string" ? payload.issuer : "";
  const owner = typeof payload.owner === "string" ? payload.owner : "";
  if (!issuer || !owner) return false;

  const operatorParty = getCantonParty();
  return issuer === operatorParty && owner === actAsParty && actAsParty !== operatorParty;
}

async function cantonRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const resp = await fetch(`${getCantonBaseUrl()}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${getCantonToken()}`,
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

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (!guardMethod(req, res, "POST")) return;

  // Validate core config (party required, package ID validated per-request below)
  const operatorParty = getCantonParty();
  if (!operatorParty || !CANTON_PARTY_PATTERN.test(operatorParty)) {
    return res.status(500).json({ success: false, error: "CANTON_PARTY not configured" });
  }

  const { action, templateId, contractId, choice, argument, payload, party } = req.body || {};

  if (!templateId) {
    return res.status(400).json({ error: "Missing templateId" });
  }

  // PACKAGE_ID required for short-name templates (no ':'), not for fully-qualified
  const PACKAGE_ID = getPackageId();
  if (!templateId.includes(":") && (!PACKAGE_ID || !PKG_ID_PATTERN.test(PACKAGE_ID))) {
    return res.status(500).json({ success: false, error: "CANTON_PACKAGE_ID/NEXT_PUBLIC_DAML_PACKAGE_ID not configured" });
  }

  let resolvedTemplateId: string;
  try {
    resolvedTemplateId = resolveTemplateId(templateId);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  let actAsParty: string;
  try {
    actAsParty = resolveRequestedParty(party);
  } catch (err: any) {
    return res.status(400).json({ error: err.message || "Invalid Canton party" });
  }
  const baseReadAsParties = Array.from(new Set([actAsParty, operatorParty]));

  const commandId = `ui-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

  try {
    if (action === "create") {
      // Create a new contract
      if (!payload) {
        return res.status(400).json({ error: "Missing payload for create" });
      }

      const createPayload = payload as Record<string, unknown>;

      // Safe default: inject privacyObservers:[] for token templates that require it.
      // Does NOT override if caller already provides the field.
      const entityName = resolvedTemplateId.split(":").pop() || "";
      const needsPrivacyObservers = new Set([
        "CantonMUSD", "CantonUSDC", "USDCx", "CantonCoin",
      ]);
      if (needsPrivacyObservers.has(entityName) && !("privacyObservers" in createPayload)) {
        createPayload.privacyObservers = [];
      }

      const createActAs = shouldOperatorCosignCreate(resolvedTemplateId, createPayload, actAsParty)
        ? Array.from(new Set([actAsParty, operatorParty]))
        : [actAsParty];
      const createReadAs = Array.from(new Set([...baseReadAsParties, ...createActAs]));

      const body = {
        userId: getCantonUser(),
        actAs: createActAs,
        readAs: createReadAs,
        commandId,
        commands: [
          {
            CreateCommand: {
              templateId: resolvedTemplateId,
              createArguments: createPayload,
            },
          },
        ],
      };

      console.log("[canton-command] CREATE", resolvedTemplateId);
      const result = await cantonRequest("POST", "/v2/commands/submit-and-wait", body);
      return res.status(200).json({ success: true, result });

    } else {
      // Exercise a choice (default action)
      if (!contractId || !choice) {
        return res.status(400).json({ error: "Missing contractId or choice" });
      }

      // Operator-signatory services (Stake, Unstake, etc.) require operator in actAs
      // so the submitter can see the contract and the choice body has operator authority
      // for archiving/creating operator-signed sub-contracts.
      const needsOperatorActAs = new Set([
        "Stake", "Unstake", "StakeFromInventory",
        "ETHPool_StakeWithMusd", "ETHPool_StakeWithUSDC", "ETHPool_StakeWithCantonCoin", "ETHPool_Unstake",
        "BoostPool_Deposit", "BoostPool_Withdraw",
        "CantonMUSD_Split", "CantonMUSD_Merge", "CantonMUSD_Burn",
      ]);
      const exerciseActAs = needsOperatorActAs.has(choice)
        ? Array.from(new Set([actAsParty, operatorParty]))
        : [actAsParty];

      const body = {
        userId: getCantonUser(),
        actAs: exerciseActAs,
        readAs: baseReadAsParties,
        commandId,
        commands: [
          {
            ExerciseCommand: {
              templateId: resolvedTemplateId,
              contractId,
              choice,
              choiceArgument: argument || {},
            },
          },
        ],
      };

      console.log("[canton-command] EXERCISE", resolvedTemplateId, choice, "on", contractId.slice(0, 20));
      const result = await cantonRequest("POST", "/v2/commands/submit-and-wait", body);
      return res.status(200).json({ success: true, result });
    }
  } catch (err: any) {
    console.error("Canton command error:", err.message);
    return res.status(502).json({ success: false, error: err.message });
  }
}
