import type { NextApiRequest, NextApiResponse } from "next";
import * as crypto from "crypto";

/**
 * /api/canton-command — Server-side proxy to submit DAML commands to Canton.
 *
 * Supports:
 *   POST { action: "exercise", templateId, contractId, choice, argument }
 *   POST { action: "create", templateId, payload }
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
              templateId,
              createArguments: payload,
            },
          },
        ],
      };

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
              templateId,
              contractId,
              choice,
              choiceArgument: argument || {},
            },
          },
        ],
      };

      const result = await cantonRequest("POST", "/v2/commands/submit-and-wait", body);
      return res.status(200).json({ success: true, result });
    }
  } catch (err: any) {
    console.error("Canton command error:", err.message);
    return res.status(502).json({ success: false, error: err.message });
  }
}
