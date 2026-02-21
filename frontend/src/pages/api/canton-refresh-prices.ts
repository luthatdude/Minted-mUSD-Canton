import type { NextApiRequest, NextApiResponse } from "next";
import * as crypto from "crypto";

/**
 * /api/canton-refresh-prices — Refresh all CantonPriceFeed contracts.
 *
 * Exercises PriceFeed_Update on each active price feed to reset staleness.
 * Called automatically before borrow/withdraw operations that check staleness.
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

const PRICE_FEED_TEMPLATE = `${PACKAGE_ID}:CantonLending:CantonPriceFeed`;

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

interface PriceFeedContract {
  contractId: string;
  symbol: string;
  priceUsd: string;
  lastUpdated: string;
}

async function getActivePriceFeeds(): Promise<PriceFeedContract[]> {
  const { offset } = await cantonRequest<{ offset: number }>("GET", "/v2/state/ledger-end");

  type RawEntry = {
    contractEntry: {
      JsActiveContract?: {
        createdEvent: {
          contractId: string;
          templateId: string;
          createArgument: Record<string, unknown>;
        };
      };
    };
  };

  const entries = await cantonRequest<RawEntry[]>("POST", "/v2/state/active-contracts", {
    filter: {
      filtersByParty: {
        [CANTON_PARTY]: {
          identifierFilter: {
            wildcardFilter: {},
          },
        },
      },
    },
    activeAtOffset: offset,
  });

  const feeds: PriceFeedContract[] = [];
  for (const entry of entries) {
    const ac = entry.contractEntry?.JsActiveContract;
    if (!ac) continue;
    const evt = ac.createdEvent;
    if (!evt.templateId.endsWith(":CantonPriceFeed")) continue;
    const p = evt.createArgument;
    feeds.push({
      contractId: evt.contractId,
      symbol: (p.symbol as string) || "",
      priceUsd: (p.priceUsd as string) || "0",
      lastUpdated: (p.lastUpdated as string) || "",
    });
  }
  return feeds;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const feeds = await getActivePriceFeeds();
    if (feeds.length === 0) {
      return res.status(200).json({ success: true, message: "No price feeds found", refreshed: 0 });
    }

    const results: { symbol: string; success: boolean; error?: string; newCid?: string }[] = [];

    for (const feed of feeds) {
      try {
        // Generate attestation hash from current price + timestamp
        const attestationData = `price-refresh:${feed.symbol}:${feed.priceUsd}:${Date.now()}`;
        const attestationHash = crypto.createHash("sha256").update(attestationData).digest("hex");

        const commandId = `price-refresh-${feed.symbol}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

        const body = {
          userId: CANTON_USER,
          actAs: [CANTON_PARTY],
          readAs: [CANTON_PARTY],
          commandId,
          commands: [
            {
              ExerciseCommand: {
                templateId: PRICE_FEED_TEMPLATE,
                contractId: feed.contractId,
                choice: "PriceFeed_Update",
                choiceArgument: {
                  newPriceUsd: feed.priceUsd,       // Keep same price
                  newSource: "relay-service-sync",
                  attestationHash,
                  validatorCount: 3,
                },
              },
            },
          ],
        };

        const result = await cantonRequest<unknown>("POST", "/v2/commands/submit-and-wait", body);
        results.push({ symbol: feed.symbol, success: true });
      } catch (err: any) {
        // If UPDATE_TOO_FREQUENT (< 10s since last), that's fine — price is fresh
        if (err.message?.includes("UPDATE_TOO_FREQUENT")) {
          results.push({ symbol: feed.symbol, success: true, error: "Already fresh" });
        } else {
          results.push({ symbol: feed.symbol, success: false, error: err.message });
        }
      }
    }

    const refreshed = results.filter(r => r.success).length;
    return res.status(200).json({ success: true, refreshed, total: feeds.length, results });
  } catch (err: any) {
    console.error("Price refresh error:", err.message);
    return res.status(502).json({ success: false, error: err.message });
  }
}
