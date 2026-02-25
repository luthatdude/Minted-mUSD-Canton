import type { NextApiRequest, NextApiResponse } from "next";
import * as crypto from "crypto";

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

const CANTON_BASE_URL =
  process.env.CANTON_API_URL ||
  `http://${process.env.CANTON_HOST || "localhost"}:${process.env.CANTON_PORT || "7575"}`;
const CANTON_TOKEN = process.env.CANTON_TOKEN || "";
const CANTON_PARTY = process.env.CANTON_PARTY || "";
const RECIPIENT_ALIAS_MAP_RAW = process.env.CANTON_RECIPIENT_PARTY_ALIASES || "";
const CANTON_PARTY_PATTERN = /^[A-Za-z0-9._:-]+::1220[0-9a-f]{64}$/i;
const PKG_ID_PATTERN = /^[0-9a-f]{64}$/i;
const CANTON_USER = process.env.CANTON_USER || "administrator";
const PACKAGE_ID =
  process.env.NEXT_PUBLIC_DAML_PACKAGE_ID ||
  process.env.CANTON_PACKAGE_ID ||
  "";

function validateRequiredConfig(): string | null {
  if (!CANTON_PARTY || !CANTON_PARTY_PATTERN.test(CANTON_PARTY))
    return "CANTON_PARTY not configured";
  // PACKAGE_ID validated conditionally per-request: required only for short-name templates
  return null;
}
const ALLOW_OPERATOR_FALLBACK =
  (process.env.CANTON_ALLOW_OPERATOR_FALLBACK || "").toLowerCase() === "true";

/**
 * Map short template names to fully-qualified Canton template IDs.
 * Format: "packageId:ModuleName:EntityName"
 */
const TEMPLATE_MAP: Record<string, string> = {
  // CantonDirectMint module
  CantonMUSD:              `${PACKAGE_ID}:CantonDirectMint:CantonMUSD`,
  CantonUSDC:              `${PACKAGE_ID}:CantonDirectMint:CantonUSDC`,
  USDCx:                   `${PACKAGE_ID}:CantonDirectMint:USDCx`,
  CantonDirectMintService: `${PACKAGE_ID}:CantonDirectMint:CantonDirectMintService`,
  BridgeOutRequest:        `${PACKAGE_ID}:CantonDirectMint:BridgeOutRequest`,
  // CantonSMUSD module
  CantonStakingService:    `${PACKAGE_ID}:CantonSMUSD:CantonStakingService`,
  CantonSMUSD:             `${PACKAGE_ID}:CantonSMUSD:CantonSMUSD`,
  // CantonETHPool module
  CantonETHPoolService:    `${PACKAGE_ID}:CantonETHPool:CantonETHPoolService`,
  CantonSMUSD_E:           `${PACKAGE_ID}:CantonETHPool:CantonSMUSD_E`,
  // CantonBoostPool module
  CantonBoostPoolService:  `${PACKAGE_ID}:CantonBoostPool:CantonBoostPoolService`,
  BoostPoolLP:             `${PACKAGE_ID}:CantonBoostPool:BoostPoolLP`,
  // CantonLending module
  CantonLendingService:    `${PACKAGE_ID}:CantonLending:CantonLendingService`,
  CantonPriceFeed:         `${PACKAGE_ID}:CantonLending:CantonPriceFeed`,
  EscrowedCollateral:      `${PACKAGE_ID}:CantonLending:EscrowedCollateral`,
  CantonDebtPosition:      `${PACKAGE_ID}:CantonLending:CantonDebtPosition`,
  // CantonCoinToken module
  CantonCoin:              `${PACKAGE_ID}:CantonCoinToken:CantonCoin`,
  // Minted.Protocol.V3 module
  BridgeService:           `${PACKAGE_ID}:Minted.Protocol.V3:BridgeService`,
  MUSDSupplyService:       `${PACKAGE_ID}:Minted.Protocol.V3:MUSDSupplyService`,
  MintedMUSD:              `${PACKAGE_ID}:Minted.Protocol.V3:MintedMUSD`,
  // Compliance module
  ComplianceRegistry:      `${PACKAGE_ID}:Compliance:ComplianceRegistry`,
};

function parseRecipientAliasMap(): Record<string, string> {
  if (!RECIPIENT_ALIAS_MAP_RAW.trim()) return {};
  try {
    const parsed = JSON.parse(RECIPIENT_ALIAS_MAP_RAW);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([from, to]) =>
          typeof from === "string" &&
          from.trim().length > 0 &&
          typeof to === "string" &&
          to.trim().length > 0
      )
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

const RECIPIENT_ALIAS_MAP = parseRecipientAliasMap();

/** Resolve a short name or pass through a fully-qualified template ID. */
function resolveTemplateId(tpl: string): string {
  // Already fully qualified (contains ':')
  if (tpl.includes(":")) return tpl;
  const resolved = TEMPLATE_MAP[tpl];
  if (!resolved) throw new Error(`Unknown template short name: ${tpl}. Use fully qualified ID or add to TEMPLATE_MAP.`);
  return resolved;
}

function resolveRequestedParty(rawParty: unknown): string {
  if (typeof rawParty !== "string" || !rawParty.trim()) {
    if (ALLOW_OPERATOR_FALLBACK) return CANTON_PARTY;
    throw new Error("Missing Canton party for command submission");
  }
  const party = rawParty.trim();
  if (party.length > 200 || !CANTON_PARTY_PATTERN.test(party)) {
    throw new Error("Invalid Canton party");
  }
  return RECIPIENT_ALIAS_MAP[party] || party;
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

  return issuer === CANTON_PARTY && owner === actAsParty && actAsParty !== CANTON_PARTY;
}

async function cantonRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const resp = await fetch(`${CANTON_BASE_URL}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${CANTON_TOKEN}`,
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
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const configError = validateRequiredConfig();
  if (configError) {
    return res.status(500).json({ success: false, error: configError });
  }

  const { action, templateId, contractId, choice, argument, payload, party } = req.body || {};

  if (!templateId) {
    return res.status(400).json({ error: "Missing templateId" });
  }

  // PACKAGE_ID required for short-name templates (no ':'), not for fully-qualified
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
  const baseReadAsParties = Array.from(new Set([actAsParty, CANTON_PARTY]));

  const commandId = `ui-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

  try {
    if (action === "create") {
      // Create a new contract
      if (!payload) {
        return res.status(400).json({ error: "Missing payload for create" });
      }

      const createPayload = payload as Record<string, unknown>;
      const createActAs = shouldOperatorCosignCreate(resolvedTemplateId, createPayload, actAsParty)
        ? Array.from(new Set([actAsParty, CANTON_PARTY]))
        : [actAsParty];
      const createReadAs = Array.from(new Set([...baseReadAsParties, ...createActAs]));

      const body = {
        userId: CANTON_USER,
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

      const body = {
        userId: CANTON_USER,
        actAs: [actAsParty],
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
