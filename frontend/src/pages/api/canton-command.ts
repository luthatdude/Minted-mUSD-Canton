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
const CANTON_TOKEN = process.env.CANTON_TOKEN || "dummy-no-auth";
const CANTON_PARTY =
  process.env.CANTON_PARTY ||
  "minted-validator-1::12203f16a8f4b26778d5c8c6847dc055acf5db91e0c5b0846de29ba5ea272ab2a0e4";
const CANTON_USER = process.env.CANTON_USER || "administrator";
const PACKAGE_ID =
  process.env.NEXT_PUBLIC_DAML_PACKAGE_ID ||
  "0489a86388cc81e3e0bee8dc8f6781229d0e01451c1f2d19deea594255e5993b";

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

/** Resolve a short name or pass through a fully-qualified template ID. */
function resolveTemplateId(tpl: string): string {
  // Already fully qualified (contains ':')
  if (tpl.includes(":")) return tpl;
  const resolved = TEMPLATE_MAP[tpl];
  if (!resolved) throw new Error(`Unknown template short name: ${tpl}. Use fully qualified ID or add to TEMPLATE_MAP.`);
  return resolved;
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

  const { action, templateId, contractId, choice, argument, payload } = req.body;

  if (!templateId) {
    return res.status(400).json({ error: "Missing templateId" });
  }

  let resolvedTemplateId: string;
  try {
    resolvedTemplateId = resolveTemplateId(templateId);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  const commandId = `ui-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

  try {
    if (action === "create") {
      // Create a new contract
      if (!payload) {
        return res.status(400).json({ error: "Missing payload for create" });
      }

      const body = {
        userId: CANTON_USER,
        actAs: [CANTON_PARTY],
        readAs: [CANTON_PARTY],
        commandId,
        commands: [
          {
            CreateCommand: {
              templateId: resolvedTemplateId,
              createArguments: payload,
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
        actAs: [CANTON_PARTY],
        readAs: [CANTON_PARTY],
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
