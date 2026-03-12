import type { NextApiRequest, NextApiResponse } from "next";
import {
  resolveRequestedParty,
  CANTON_PARTY_PATTERN,
} from "@/lib/server/canton-party-resolver";

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
const CANTON_TOKEN = process.env.CANTON_TOKEN || "";
const CANTON_PARTY = process.env.CANTON_PARTY || "";
const PACKAGE_ID =
  process.env.NEXT_PUBLIC_DAML_PACKAGE_ID ||
  process.env.CANTON_PACKAGE_ID ||
  "";
const LENDING_PACKAGE_ID =
  process.env.CANTON_LENDING_PACKAGE_ID || PACKAGE_ID;
const PKG_ID_PATTERN = /^[0-9a-f]{64}$/i;

function validateRequiredConfig(): string | null {
  if (!CANTON_PARTY || !CANTON_PARTY_PATTERN.test(CANTON_PARTY))
    return "CANTON_PARTY not configured";
  if (!PACKAGE_ID || !PKG_ID_PATTERN.test(PACKAGE_ID))
    return "CANTON_PACKAGE_ID/NEXT_PUBLIC_DAML_PACKAGE_ID not configured";
  return null;
}

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

interface BoostPoolServiceInfo {
  contractId: string;
  totalCantonDeposited: string;
  totalLPShares: string;
  cantonPriceMusd: string;
  globalSharePrice: string;
  entryFeeBps: number;
  exitFeeBps: number;
  cooldownSeconds: number;
  paused: boolean;
}

interface LendingServiceInfo {
  contractId: string;
  totalBorrows: string;
  interestRateBps: number;
  reserveFactorBps: number;
  protocolReserves: string;
  minBorrow: string;
  closeFactorBps: number;
  paused: boolean;
  cantonSupplyCap: string;
  cantonCurrentSupply: string;
  configs: Record<string, { ltvBps: number; liqThresholdBps: number; liqPenaltyBps: number }>;
}

interface PriceFeedInfo {
  contractId: string;
  asset: string;
  priceMusd: string;
  lastUpdate: string;
}

interface EscrowInfo {
  contractId: string;
  owner: string;
  collateralType: string;
  amount: string;
}

interface DebtPositionInfo {
  contractId: string;
  owner: string;
  collateralType: string;
  collateralAmount: string;
  debtMusd: string;
  interestAccrued: string;
}

interface SimpleToken {
  contractId: string;
  amount: string;
  template?: string;
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
  boostPoolService: BoostPoolServiceInfo | null;
  lendingService: LendingServiceInfo | null;
  priceFeeds: PriceFeedInfo[];
  directMintService: { contractId: string; paused: boolean; serviceName?: string; hasValidCompliance?: boolean } | null;
  coinMintService: { contractId: string; cantonCoinPrice: string } | null;
  smusdTokens: SimpleToken[];
  totalSmusd: string;
  smusdETokens: SimpleToken[];
  totalSmusdE: string;
  boostLPTokens: SimpleToken[];
  totalBoostLP: string;
  cantonCoinTokens: SimpleToken[];
  totalCoin: string;
  usdcTokens: SimpleToken[];
  totalUsdc: string;
  escrowPositions: EscrowInfo[];
  debtPositions: DebtPositionInfo[];
  ledgerOffset: number;
  party: string;
  effectiveParty: string;
  connectedParty?: string;
  aliasApplied: boolean;
  timestamp: string;
}

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

function templateId(moduleName: string, entityName: string): string {
  return `${PACKAGE_ID}:${moduleName}:${entityName}`;
}

function lendingTemplateId(entityName: string): string {
  return `${LENDING_PACKAGE_ID}:CantonLending:${entityName}`;
}

function buildEventFormat(party: string, fullTemplateId: string): Record<string, unknown> {
  return {
    filtersByParty: {
      [party]: {
        cumulative: [
          {
            identifierFilter: {
              TemplateFilter: {
                value: {
                  templateId: fullTemplateId,
                  includeCreatedEventBlob: false,
                },
              },
            },
          },
        ],
      },
    },
    verbose: true,
  };
}

function normalizeEntries(payload: unknown): RawEntry[] {
  if (Array.isArray(payload)) return payload as RawEntry[];
  if (payload && typeof payload === "object") {
    const obj = payload as { result?: unknown };
    if (Array.isArray(obj.result)) return obj.result as RawEntry[];
  }
  return [];
}

async function queryTemplateEntries(
  party: string,
  activeAtOffset: number,
  fullTemplateId: string
): Promise<RawEntry[]> {
  try {
    const raw = await cantonRequest<unknown>("POST", "/v2/state/active-contracts?limit=200", {
      eventFormat: buildEventFormat(party, fullTemplateId),
      activeAtOffset,
    });
    return normalizeEntries(raw);
  } catch (err: any) {
    const msg = String(err?.message || "");
    // Some optional templates may not exist on this package/version.
    if (msg.includes("Canton API 404")) {
      return [];
    }
    throw err;
  }
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

  const configError = validateRequiredConfig();
  if (configError) {
    return res.status(500).json({ error: configError });
  }

  let actAsParty: string;
  let aliasApplied = false;
  let connectedParty: string | undefined;
  try {
    const resolved = resolveRequestedParty(req.query.party, { allowFallback: true });
    actAsParty = resolved.resolvedParty;
    aliasApplied = resolved.wasAliased;
    connectedParty = resolved.wasAliased ? resolved.requestedParty : undefined;
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || "Invalid Canton party" });
  }

  try {
    const effectiveParty = actAsParty;
    // 1. Get current ledger offset
    const { offset } = await cantonRequest<{ offset: number }>("GET", "/v2/state/ledger-end");

    // 2. Query template-scoped slices to avoid wildcard ACS 413 at 200-element node cap.
    const templates = [
      templateId("CantonDirectMint", "CantonMUSD"),
      templateId("Minted.Protocol.V3", "BridgeService"),
      templateId("Minted.Protocol.V3", "BridgeInRequest"),
      templateId("Minted.Protocol.V3", "MUSDSupplyService"),
      templateId("CantonSMUSD", "CantonStakingService"),
      templateId("CantonETHPool", "CantonETHPoolService"),
      templateId("CantonBoostPool", "CantonBoostPoolService"),
      lendingTemplateId("CantonLendingService"),
      lendingTemplateId("CantonPriceFeed"),
      templateId("CantonETHPool", "CantonSMUSD_E"),
      templateId("CantonBoostPool", "BoostPoolLP"),
      lendingTemplateId("EscrowedCollateral"),
      lendingTemplateId("CantonDebtPosition"),
      templateId("CantonDirectMint", "CantonDirectMintService"),
      templateId("CantonSMUSD", "CantonSMUSD"),
      templateId("CantonCoinToken", "CantonCoin"),
      templateId("CantonDirectMint", "CantonUSDC"),
      templateId("CantonDirectMint", "USDCx"),
      templateId("CantonCoinMint", "CoinMintService"),
    ] as const;

    const entryGroups = await Promise.all(
      templates.map((tpl) => queryTemplateEntries(actAsParty, offset, tpl))
    );
    const entries = entryGroups.flat();

    // 3. Parse contracts by template
    const tokens: CantonMUSDToken[] = [];
    let bridgeService: BridgeServiceInfo | null = null;
    let pendingBridgeIns = 0;
    let supplyService = false;
    let stakingService: StakingServiceInfo | null = null;
    let ethPoolService: ETHPoolServiceInfo | null = null;
    let ethPoolHasValidCompliance = false;
    let boostPoolService: BoostPoolServiceInfo | null = null;
    let lendingService: LendingServiceInfo | null = null;
    let directMintService: { contractId: string; paused: boolean; serviceName?: string; hasValidCompliance?: boolean } | null = null;
    let coinMintService: { contractId: string; cantonCoinPrice: string } | null = null;
    let stakingHasValidCompliance = false;
    const smusdTokens: SimpleToken[] = [];
    const smusdETokens: SimpleToken[] = [];
    const boostLPTokens: SimpleToken[] = [];
    const cantonCoinTokens: SimpleToken[] = [];
    const usdcTokens: SimpleToken[] = [];
    const priceFeeds: PriceFeedInfo[] = [];
    const escrowPositions: EscrowInfo[] = [];
    const debtPositions: DebtPositionInfo[] = [];

    const matchesActingOwner = (payload: Record<string, unknown>, field: "owner" | "borrower" = "owner"): boolean => {
      const owner = (payload[field] as string) || "";
      return !owner || owner === actAsParty;
    };
    const matchesOperatorIssuer = (payload: Record<string, unknown>): boolean => {
      const issuer = (payload.issuer as string) || "";
      return issuer === CANTON_PARTY;
    };

    for (const entry of entries) {
      const ac = entry.contractEntry?.JsActiveContract;
      if (!ac) continue;

      const evt = ac.createdEvent;
      const tplId = evt.templateId; // "pkgId:ModuleName:EntityName"
      const parts = tplId.split(":");
      const entityName = parts[parts.length - 1] || "";

      if (entityName === "CantonMUSD") {
        const p = evt.createArgument;
        if (!matchesActingOwner(p, "owner")) continue;
        if (!matchesOperatorIssuer(p)) continue;
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
        const p = evt.createArgument;
        const status = String(p.status || "").toLowerCase();
        if (status === "pending") {
          pendingBridgeIns++;
        }
      } else if (entityName === "MUSDSupplyService") {
        supplyService = true;
      } else if (entityName === "CantonStakingService") {
        const p = evt.createArgument;
        const ts = parseFloat(String(p.totalShares || "0"));
        // Deployed version uses globalSharePrice (not pooledMusd)
        const gsp = parseFloat(String(p.globalSharePrice || "1.0"));
        const pm = parseFloat(String(p.pooledMusd || "0"));
        // Pool-derived TVL: if pooledMusd is available use it, otherwise estimate from shares * sharePrice
        const tvl = pm > 0 ? pm : (ts * gsp);
        // Share price: prefer pool-derived, fall back to globalSharePrice
        const sharePrice = pm > 0 && ts > 0 ? pm / ts : gsp;
        const isPaused = p.paused === true || p.paused === "True";
        const compCid = (p.complianceRegistryCid as string) || "";
        const hasValidCompliance = compCid.length > 10 && !compCid.match(/^0+$/);
        const candidate: StakingServiceInfo = {
          contractId: evt.contractId,
          totalShares: String(ts),
          pooledMusd: String(tvl),
          sharePrice: String(sharePrice),
          cooldownSeconds: parseInt(String(p.cooldownSeconds || "86400"), 10),
          minDeposit: String(p.minDeposit || "0.01"),
          paused: isPaused,
        };
        const prevTvl = stakingService ? parseFloat(stakingService.pooledMusd) : -1;
        // Prefer service with valid complianceRegistryCid, unpaused, and higher TVL
        if (!stakingService
            || (hasValidCompliance && !stakingHasValidCompliance)
            || (hasValidCompliance === stakingHasValidCompliance && !isPaused && stakingService.paused)
            || (hasValidCompliance === stakingHasValidCompliance && isPaused === stakingService.paused && tvl > prevTvl)) {
          stakingService = candidate;
          stakingHasValidCompliance = hasValidCompliance;
        }
      } else if (entityName === "CantonETHPoolService") {
        const p = evt.createArgument;
        const isPaused = p.paused === true || p.paused === "True";
        const compCid = (p.complianceRegistryCid as string) || "";
        const hasValidCompliance = compCid.length > 10 && !compCid.match(/^0+$/);
        const tvl = parseFloat((p.totalUsdcStaked as string) || (p.totalMusdStaked as string) || "0");
        const candidate: ETHPoolServiceInfo = {
          contractId: evt.contractId,
          totalShares: (p.totalShares as string) || "0",
          poolCap: (p.poolCap as string) || "0",
          sharePrice: (p.sharePrice as string) || "1.0",
          pooledUsdc: (p.pooledUsdc as string) || "0",
          paused: isPaused,
          totalMusdStaked: (p.totalUsdcStaked as string) || (p.totalMusdStaked as string) || "0",
        };
        const prevTvl = ethPoolService ? parseFloat(ethPoolService.totalMusdStaked) : -1;
        if (!ethPoolService
            || (hasValidCompliance && !ethPoolHasValidCompliance)
            || (hasValidCompliance === ethPoolHasValidCompliance && !isPaused && ethPoolService.paused)
            || (hasValidCompliance === ethPoolHasValidCompliance && isPaused === ethPoolService.paused && tvl > prevTvl)) {
          ethPoolService = candidate;
          ethPoolHasValidCompliance = hasValidCompliance;
        }
      } else if (entityName === "CantonBoostPoolService") {
        const p = evt.createArgument;
        boostPoolService = {
          contractId: evt.contractId,
          totalCantonDeposited: (p.totalCantonDeposited as string) || "0",
          totalLPShares: (p.totalLPShares as string) || "0",
          cantonPriceMusd: (p.cantonPriceMusd as string) || "1.0",
          globalSharePrice: (p.globalSharePrice as string) || "1.0",
          entryFeeBps: parseInt(String(p.entryFeeBps || "25"), 10),
          exitFeeBps: parseInt(String(p.exitFeeBps || "50"), 10),
          cooldownSeconds: parseInt(String(p.cooldownSeconds || "86400"), 10),
          paused: p.paused === true || p.paused === "True",
        };
      } else if (entityName === "CantonLendingService") {
        const p = evt.createArgument;
        // Parse configs array (ACS returns array of collateral config objects)
        const rawConfigs = (p.configs as Array<Record<string, unknown>>) || [];
        const configs: Record<string, { ltvBps: number; liqThresholdBps: number; liqPenaltyBps: number }> = {};
        for (const val of rawConfigs) {
          const key = (val.collateralType as string) || "";
          if (key) {
            configs[key] = {
              ltvBps: parseInt(String(val.collateralFactorBps || "0"), 10),
              liqThresholdBps: parseInt(String(val.liquidationThresholdBps || "0"), 10),
              liqPenaltyBps: parseInt(String(val.liquidationPenaltyBps || "0"), 10),
            };
          }
        }
        lendingService = {
          contractId: evt.contractId,
          totalBorrows: (p.totalBorrows as string) || "0",
          interestRateBps: parseInt(String(p.interestRateBps || "500"), 10),
          reserveFactorBps: parseInt(String(p.reserveFactorBps || "1000"), 10),
          protocolReserves: (p.protocolReserves as string) || "0",
          minBorrow: (p.minBorrow as string) || "100",
          closeFactorBps: parseInt(String(p.closeFactorBps || "5000"), 10),
          paused: p.paused === true || p.paused === "True",
          cantonSupplyCap: (p.cantonSupplyCap as string) || "0",
          cantonCurrentSupply: (p.cantonCurrentSupply as string) || "0",
          configs,
        };
      } else if (entityName === "CantonPriceFeed") {
        const p = evt.createArgument;
        priceFeeds.push({
          contractId: evt.contractId,
          asset: (p.symbol as string) || "",
          priceMusd: (p.priceUsd as string) || "0",
          lastUpdate: (p.lastUpdated as string) || evt.createdAt || "",
        });
      } else if (entityName === "CantonSMUSD_E") {
        const p = evt.createArgument;
        if (!matchesActingOwner(p, "owner")) continue;
        if (!matchesOperatorIssuer(p)) continue;
        smusdETokens.push({
          contractId: evt.contractId,
          amount: (p.shares as string) || (p.amount as string) || "0",
        });
      } else if (entityName === "BoostPoolLP") {
        const p = evt.createArgument;
        if (!matchesActingOwner(p, "owner")) continue;
        boostLPTokens.push({
          contractId: evt.contractId,
          amount: (p.shares as string) || (p.amount as string) || "0",
        });
      } else if (entityName === "EscrowedCollateral") {
        const p = evt.createArgument;
        if (!matchesActingOwner(p, "owner")) continue;
        escrowPositions.push({
          contractId: evt.contractId,
          owner: (p.owner as string) || "",
          collateralType: (p.collateralType as string) || "",
          amount: (p.amount as string) || "0",
        });
      } else if (entityName === "CantonDebtPosition") {
        const p = evt.createArgument;
        if (!matchesActingOwner(p, "borrower")) continue;
        debtPositions.push({
          contractId: evt.contractId,
          owner: (p.borrower as string) || "",
          collateralType: "",  // Debt position is global — backed by all escrows
          collateralAmount: "0",
          debtMusd: (p.principalDebt as string) || "0",
          interestAccrued: (p.accruedInterest as string) || "0",
        });
      } else if (entityName === "CantonDirectMintService") {
        const p = evt.createArgument;
        // Pick the best service: prefer unpaused + valid complianceRegistryCid
        const isPaused = p.paused === true || p.paused === "True";
        const compCid = (p.complianceRegistryCid as string) || "";
        const hasValidCompliance = compCid.length > 10 && !compCid.match(/^0+$/);
        const candidate = {
          contractId: evt.contractId,
          paused: isPaused,
          serviceName: (p.serviceName as string) || "",
          hasValidCompliance,
        };
        // Prefer: (1) valid compliance, (2) unpaused, (3) latest seen
        if (!directMintService
            || (hasValidCompliance && !directMintService.hasValidCompliance)
            || (hasValidCompliance === directMintService.hasValidCompliance && !isPaused && directMintService.paused)) {
          directMintService = candidate;
        }
      } else if (entityName === "CantonSMUSD") {
        const p = evt.createArgument;
        if (!matchesActingOwner(p, "owner")) continue;
        if (!matchesOperatorIssuer(p)) continue;
        smusdTokens.push({
          contractId: evt.contractId,
          amount: (p.shares as string) || (p.amount as string) || "0",
        });
      } else if (entityName === "CantonCoin") {
        const p = evt.createArgument;
        if (!matchesActingOwner(p, "owner")) continue;
        if (!matchesOperatorIssuer(p)) continue;
        cantonCoinTokens.push({
          contractId: evt.contractId,
          amount: (p.amount as string) || "0",
        });
      } else if (entityName === "CantonUSDC") {
        const p = evt.createArgument;
        if (!matchesActingOwner(p, "owner")) continue;
        if (!matchesOperatorIssuer(p)) continue;
        usdcTokens.push({
          contractId: evt.contractId,
          amount: (p.amount as string) || "0",
        });
      } else if (entityName === "USDCx") {
        // USDCx is a separate template; track separately so DirectMint_Mint
        // (which expects CantonUSDC) doesn't accidentally receive a USDCx CID.
        const p = evt.createArgument;
        if (!matchesActingOwner(p, "owner")) continue;
        if (!matchesOperatorIssuer(p)) continue;
        usdcTokens.push({
          contractId: evt.contractId,
          amount: (p.amount as string) || "0",
          template: "USDCx",
        });
      } else if (entityName === "CoinMintService") {
        const p = evt.createArgument;
        coinMintService = {
          contractId: evt.contractId,
          cantonCoinPrice: (p.cantonCoinPrice as string) || "0",
        };
      }
    }

    // Some service contracts (for example CantonDirectMintService) may not be
    // directly visible to end-user parties even though they are operational.
    // In that case, fall back to the operator party view for service discovery.
    if (
      effectiveParty !== CANTON_PARTY &&
      (
        !directMintService ||
        !coinMintService ||
        !bridgeService ||
        !supplyService ||
        !stakingService ||
        !ethPoolService ||
        !boostPoolService ||
        !lendingService
      )
    ) {
      try {
        const operatorTemplates = [
          templateId("Minted.Protocol.V3", "BridgeService"),
          templateId("Minted.Protocol.V3", "MUSDSupplyService"),
          templateId("CantonDirectMint", "CantonDirectMintService"),
          templateId("CantonCoinMint", "CoinMintService"),
          templateId("CantonSMUSD", "CantonStakingService"),
          templateId("CantonETHPool", "CantonETHPoolService"),
          templateId("CantonBoostPool", "CantonBoostPoolService"),
          lendingTemplateId("CantonLendingService"),
        ] as const;

        const operatorGroups = await Promise.all(
          operatorTemplates.map((tpl) => queryTemplateEntries(CANTON_PARTY, offset, tpl))
        );
        const operatorEntries = operatorGroups.flat();

        for (const entry of operatorEntries) {
          const ac = entry.contractEntry?.JsActiveContract;
          if (!ac) continue;
          const evt = ac.createdEvent;
          const tplId = evt.templateId;
          const parts = tplId.split(":");
          const entityName = parts[parts.length - 1] || "";

          if (!bridgeService && entityName === "BridgeService") {
            const p = evt.createArgument;
            bridgeService = {
              contractId: evt.contractId,
              operator: (p.operator as string) || "",
              lastNonce: parseInt(String(p.lastNonce || "0"), 10),
            };
          } else if (!supplyService && entityName === "MUSDSupplyService") {
            supplyService = true;
          } else if (entityName === "CantonStakingService") {
            const p = evt.createArgument;
            const ts = parseFloat(String(p.totalShares || "0"));
            const gsp = parseFloat(String(p.globalSharePrice || "1.0"));
            const pm = parseFloat(String(p.pooledMusd || "0"));
            const tvl = pm > 0 ? pm : ts * gsp;
            const sharePrice = pm > 0 && ts > 0 ? pm / ts : gsp;
            const isPaused = p.paused === true || p.paused === "True";
            const compCid = (p.complianceRegistryCid as string) || "";
            const hasValidCompliance = compCid.length > 10 && !compCid.match(/^0+$/);
            const candidate: StakingServiceInfo = {
              contractId: evt.contractId,
              totalShares: String(ts),
              pooledMusd: String(tvl),
              sharePrice: String(sharePrice),
              cooldownSeconds: parseInt(String(p.cooldownSeconds || "86400"), 10),
              minDeposit: String(p.minDeposit || "0.01"),
              paused: isPaused,
            };
            const prevTvl = stakingService ? parseFloat(stakingService.pooledMusd) : -1;
            if (
              !stakingService ||
              (hasValidCompliance && !stakingHasValidCompliance) ||
              (hasValidCompliance === stakingHasValidCompliance && !isPaused && stakingService.paused) ||
              (hasValidCompliance === stakingHasValidCompliance && isPaused === stakingService.paused && tvl > prevTvl)
            ) {
              stakingService = candidate;
              stakingHasValidCompliance = hasValidCompliance;
            }
          } else if (entityName === "CantonETHPoolService") {
            const p = evt.createArgument;
            const isPaused = p.paused === true || p.paused === "True";
            const compCid = (p.complianceRegistryCid as string) || "";
            const hasValidCompliance = compCid.length > 10 && !compCid.match(/^0+$/);
            const tvl = parseFloat((p.totalUsdcStaked as string) || (p.totalMusdStaked as string) || "0");
            const candidate: ETHPoolServiceInfo = {
              contractId: evt.contractId,
              totalShares: (p.totalShares as string) || "0",
              poolCap: (p.poolCap as string) || "0",
              sharePrice: (p.sharePrice as string) || "1.0",
              pooledUsdc: (p.pooledUsdc as string) || "0",
              paused: isPaused,
              totalMusdStaked: (p.totalUsdcStaked as string) || (p.totalMusdStaked as string) || "0",
            };
            const prevTvl = ethPoolService ? parseFloat(ethPoolService.totalMusdStaked) : -1;
            if (
              !ethPoolService ||
              (hasValidCompliance && !ethPoolHasValidCompliance) ||
              (hasValidCompliance === ethPoolHasValidCompliance && !isPaused && ethPoolService.paused) ||
              (hasValidCompliance === ethPoolHasValidCompliance && isPaused === ethPoolService.paused && tvl > prevTvl)
            ) {
              ethPoolService = candidate;
              ethPoolHasValidCompliance = hasValidCompliance;
            }
          } else if (entityName === "CantonBoostPoolService") {
            const p = evt.createArgument;
            boostPoolService = {
              contractId: evt.contractId,
              totalCantonDeposited: (p.totalCantonDeposited as string) || "0",
              totalLPShares: (p.totalLPShares as string) || "0",
              cantonPriceMusd: (p.cantonPriceMusd as string) || "1.0",
              globalSharePrice: (p.globalSharePrice as string) || "1.0",
              entryFeeBps: parseInt(String(p.entryFeeBps || "25"), 10),
              exitFeeBps: parseInt(String(p.exitFeeBps || "50"), 10),
              cooldownSeconds: parseInt(String(p.cooldownSeconds || "86400"), 10),
              paused: p.paused === true || p.paused === "True",
            };
          } else if (entityName === "CantonLendingService") {
            const p = evt.createArgument;
            const rawConfigs = (p.configs as Array<Record<string, unknown>>) || [];
            const configs: Record<string, { ltvBps: number; liqThresholdBps: number; liqPenaltyBps: number }> = {};
            for (const val of rawConfigs) {
              const key = (val.collateralType as string) || "";
              if (key) {
                configs[key] = {
                  ltvBps: parseInt(String(val.collateralFactorBps || "0"), 10),
                  liqThresholdBps: parseInt(String(val.liquidationThresholdBps || "0"), 10),
                  liqPenaltyBps: parseInt(String(val.liquidationPenaltyBps || "0"), 10),
                };
              }
            }
            lendingService = {
              contractId: evt.contractId,
              totalBorrows: (p.totalBorrows as string) || "0",
              interestRateBps: parseInt(String(p.interestRateBps || "500"), 10),
              reserveFactorBps: parseInt(String(p.reserveFactorBps || "1000"), 10),
              protocolReserves: (p.protocolReserves as string) || "0",
              minBorrow: (p.minBorrow as string) || "100",
              closeFactorBps: parseInt(String(p.closeFactorBps || "5000"), 10),
              paused: p.paused === true || p.paused === "True",
              cantonSupplyCap: (p.cantonSupplyCap as string) || "0",
              cantonCurrentSupply: (p.cantonCurrentSupply as string) || "0",
              configs,
            };
          } else if (entityName === "CantonDirectMintService") {
            const p = evt.createArgument;
            const isPaused = p.paused === true || p.paused === "True";
            const compCid = (p.complianceRegistryCid as string) || "";
            const hasValidCompliance = compCid.length > 10 && !compCid.match(/^0+$/);
            const candidate = {
              contractId: evt.contractId,
              paused: isPaused,
              serviceName: (p.serviceName as string) || "",
              hasValidCompliance,
            };
            if (
              !directMintService ||
              (hasValidCompliance && !directMintService.hasValidCompliance) ||
              (hasValidCompliance === directMintService.hasValidCompliance &&
                !isPaused &&
                directMintService.paused)
            ) {
              directMintService = candidate;
            }
          } else if (!coinMintService && entityName === "CoinMintService") {
            const p = evt.createArgument;
            coinMintService = {
              contractId: evt.contractId,
              cantonCoinPrice: (p.cantonCoinPrice as string) || "0",
            };
          }
        }
      } catch (fallbackErr) {
        console.warn(
          "Canton balances service fallback failed:",
          (fallbackErr as Error)?.message || fallbackErr
        );
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
    const totalSmusdE = smusdETokens.reduce((s, t) => s + parseFloat(t.amount), 0).toFixed(6);
    const totalBoostLP = boostLPTokens.reduce((s, t) => s + parseFloat(t.amount), 0).toFixed(6);
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
      boostPoolService,
      lendingService,
      priceFeeds,
      directMintService,
      coinMintService,
      smusdTokens,
      totalSmusd,
      smusdETokens,
      totalSmusdE,
      boostLPTokens,
      totalBoostLP,
      cantonCoinTokens,
      totalCoin,
      usdcTokens,
      totalUsdc,
      escrowPositions,
      debtPositions,
      ledgerOffset: offset,
      party: actAsParty,
      effectiveParty: actAsParty,
      ...(connectedParty ? { connectedParty } : {}),
      aliasApplied,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("Canton balances API error:", err.message);
    return res.status(502).json({ error: `Canton API unavailable: ${err.message}` });
  }
}
