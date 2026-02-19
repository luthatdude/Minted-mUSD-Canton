import type { NextApiRequest, NextApiResponse } from "next";

/**
 * /api/canton-balances — Server-side proxy to Canton JSON API v2.
 *
 * Queries the Canton participant's Active Contract Set (ACS) for CantonMUSD
 * tokens and other BLE protocol contracts, then returns a summarized response.
 *
 * This avoids CORS issues and keeps the Canton auth token server-side.
 */

const CANTON_BASE_URL =
  process.env.CANTON_API_URL ||
  `http://${process.env.CANTON_HOST || "localhost"}:${process.env.CANTON_PORT || "7575"}`;
const CANTON_TOKEN = process.env.CANTON_TOKEN || "dummy-no-auth";
const CANTON_PARTY =
  process.env.CANTON_PARTY ||
  "minted-validator-1::12203f16a8f4b26778d5c8c6847dc055acf5db91e0c5b0846de29ba5ea272ab2a0e4";

interface CantonMUSDToken {
  contractId: string;
  owner: string;
  amount: string;
  nonce: number;
  sourceChain: number;
  ethTxHash: string;
  createdAt: string;
}

interface BridgeServiceInfo {
  contractId: string;
  operator: string;
  lastNonce: number;
}

interface StakingServiceInfo {
  contractId: string;
  totalShares: string;
  pooledMusd: string;
  sharePrice: string;
  cooldownSeconds: number;
  minDeposit: string;
  paused: boolean;
}

interface ETHPoolServiceInfo {
  contractId: string;
  totalShares: string;
  poolCap: string;
  sharePrice: string;
  pooledUsdc: string;
  paused: boolean;
  totalMusdStaked: string;
}

interface SimpleToken {
  contractId: string;
  amount: string;
}

interface BalancesResponse {
  tokens: CantonMUSDToken[];
  totalBalance: string;
  tokenCount: number;
  bridgeService: BridgeServiceInfo | null;
  pendingBridgeIns: number;
  supplyService: boolean;
  stakingService: StakingServiceInfo | null;
  ethPoolService: ETHPoolServiceInfo | null;
  directMintService: { contractId: string; paused: boolean } | null;
  smusdTokens: SimpleToken[];
  totalSmusd: string;
  cantonCoinTokens: SimpleToken[];
  totalCoin: string;
  usdcTokens: SimpleToken[];
  totalUsdc: string;
  ledgerOffset: number;
  party: string;
  timestamp: string;
}

async function cantonRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const resp = await fetch(`${CANTON_BASE_URL}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${CANTON_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Canton API ${resp.status}: ${text}`);
  }

  return resp.json() as Promise<T>;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<BalancesResponse | { error: string }>
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // 1. Get current ledger offset
    const { offset } = await cantonRequest<{ offset: number }>("GET", "/v2/state/ledger-end");

    // 2. Query all contracts visible to our party
    const filter = {
      filtersByParty: {
        [CANTON_PARTY]: {
          identifierFilter: {
            wildcardFilter: {},
          },
        },
      },
    };

    type RawEntry = {
      contractEntry: {
        JsActiveContract?: {
          createdEvent: {
            contractId: string;
            templateId: string;
            createArgument: Record<string, unknown>;
            createdAt: string;
            offset: number;
            signatories: string[];
            observers: string[];
          };
        };
      };
    };

    const entries = await cantonRequest<RawEntry[]>("POST", "/v2/state/active-contracts", {
      filter,
      activeAtOffset: offset,
    });

    // 3. Parse contracts by template
    const tokens: CantonMUSDToken[] = [];
    let bridgeService: BridgeServiceInfo | null = null;
    let pendingBridgeIns = 0;
    let supplyService = false;
    let stakingService: StakingServiceInfo | null = null;
    let ethPoolService: ETHPoolServiceInfo | null = null;
    let directMintService: { contractId: string; paused: boolean } | null = null;
    const smusdTokens: SimpleToken[] = [];
    const cantonCoinTokens: SimpleToken[] = [];
    const usdcTokens: SimpleToken[] = [];

    for (const entry of entries) {
      const ac = entry.contractEntry?.JsActiveContract;
      if (!ac) continue;

      const evt = ac.createdEvent;
      const tplId = evt.templateId; // "pkgId:ModuleName:EntityName"
      const parts = tplId.split(":");
      const entityName = parts[parts.length - 1] || "";

      if (entityName === "CantonMUSD") {
        const p = evt.createArgument;
        tokens.push({
          contractId: evt.contractId,
          owner: (p.owner as string) || "",
          amount: (p.amount as string) || "0",
          nonce: parseInt(String(p.nonce || "0"), 10),
          sourceChain: parseInt(String(p.sourceChain || "0"), 10),
          ethTxHash: (p.ethTxHash as string) || "",
          createdAt: evt.createdAt || "",
        });
      } else if (entityName === "BridgeService") {
        const p = evt.createArgument;
        bridgeService = {
          contractId: evt.contractId,
          operator: (p.operator as string) || "",
          lastNonce: parseInt(String(p.lastNonce || "0"), 10),
        };
      } else if (entityName === "BridgeInRequest") {
        pendingBridgeIns++;
      } else if (entityName === "MUSDSupplyService") {
        supplyService = true;
      } else if (entityName === "CantonStakingService") {
        const p = evt.createArgument;
        const ts = parseFloat(String(p.totalShares || "0"));
        const pm = parseFloat(String(p.pooledMusd || "0"));
        stakingService = {
          contractId: evt.contractId,
          totalShares: String(ts),
          pooledMusd: String(pm),
          sharePrice: ts > 0 ? String(pm / ts) : "1.0",
          cooldownSeconds: parseInt(String(p.cooldownSeconds || "86400"), 10),
          minDeposit: (p.minDeposit as string) || "0.01",
          paused: p.paused === true || p.paused === "True",
        };
      } else if (entityName === "CantonETHPoolService") {
        const p = evt.createArgument;
        ethPoolService = {
          contractId: evt.contractId,
          totalShares: (p.totalShares as string) || "0",
          poolCap: (p.poolCap as string) || "0",
          sharePrice: (p.sharePrice as string) || "1.0",
          pooledUsdc: (p.pooledUsdc as string) || "0",
          paused: p.paused === true || p.paused === "True",
          totalMusdStaked: (p.totalUsdcStaked as string) || (p.totalMusdStaked as string) || "0",
        };
      } else if (entityName === "CantonDirectMintService") {
        const p = evt.createArgument;
        directMintService = {
          contractId: evt.contractId,
          paused: p.paused === true || p.paused === "True",
        };
      } else if (entityName === "CantonSMUSD") {
        const p = evt.createArgument;
        smusdTokens.push({
          contractId: evt.contractId,
          amount: (p.shares as string) || (p.amount as string) || "0",
        });
      } else if (entityName === "CantonCoin") {
        const p = evt.createArgument;
        cantonCoinTokens.push({
          contractId: evt.contractId,
          amount: (p.amount as string) || "0",
        });
      } else if (entityName === "CantonUSDC" || entityName === "USDCx") {
        const p = evt.createArgument;
        usdcTokens.push({
          contractId: evt.contractId,
          amount: (p.amount as string) || "0",
        });
      }
    }

    // Sort tokens by nonce
    tokens.sort((a, b) => a.nonce - b.nonce);

    // Calculate total
    const totalBalance = tokens
      .reduce((sum, t) => sum + parseFloat(t.amount), 0)
      .toFixed(6);

    // Sum token balances for non-mUSD tokens
    const totalSmusd = smusdTokens.reduce((s, t) => s + parseFloat(t.amount), 0).toFixed(6);
    const totalCoin = cantonCoinTokens.reduce((s, t) => s + parseFloat(t.amount), 0).toFixed(6);
    const totalUsdc = usdcTokens.reduce((s, t) => s + parseFloat(t.amount), 0).toFixed(6);

    return res.status(200).json({
      tokens,
      totalBalance,
      tokenCount: tokens.length,
      bridgeService,
      pendingBridgeIns,
      supplyService,
      stakingService,
      ethPoolService,
      directMintService,
      smusdTokens,
      totalSmusd,
      cantonCoinTokens,
      totalCoin,
      usdcTokens,
      totalUsdc,
      ledgerOffset: offset,
      party: CANTON_PARTY,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("Canton balances API error:", err.message);
    return res.status(502).json({ error: `Canton API unavailable: ${err.message}` });
  }
}
