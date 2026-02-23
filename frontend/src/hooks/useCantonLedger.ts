import { useState, useEffect, useCallback } from "react";
import { normalizeCantonParty } from "@/lib/canton-party";

/**
 * Shared hook to fetch Canton mUSD balances from the server-side API route.
 * Works without Loop Wallet — queries Canton JSON API directly via /api/canton-balances.
 */

export interface CantonMUSDToken {
  contractId: string;
  owner: string;
  amount: string;
  nonce: number;
  sourceChain: number;
  ethTxHash: string;
  createdAt: string;
}

export interface BridgeServiceInfo {
  contractId: string;
  operator: string;
  lastNonce: number;
}

export interface StakingServiceInfo {
  contractId: string;
  totalShares: string;
  pooledMusd: string;
  sharePrice: string;
  cooldownSeconds: number;
  minDeposit: string;
  paused: boolean;
}

export interface ETHPoolServiceInfo {
  contractId: string;
  totalShares: string;
  poolCap: string;
  sharePrice: string;
  pooledUsdc: string;
  paused: boolean;
  totalMusdStaked: string;
}

export interface BoostPoolServiceInfo {
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

export interface LendingServiceInfo {
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

export interface PriceFeedInfo {
  contractId: string;
  asset: string;
  priceMusd: string;
  lastUpdate: string;
}

export interface EscrowInfo {
  contractId: string;
  owner: string;
  collateralType: string;
  amount: string;
}

export interface DebtPositionInfo {
  contractId: string;
  owner: string;
  collateralType: string;
  collateralAmount: string;
  debtMusd: string;
  interestAccrued: string;
}

export interface SimpleToken {
  contractId: string;
  amount: string;
  template?: string;
}

export interface CantonBalancesData {
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
  directMintService: { contractId: string; paused: boolean } | null;
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
  timestamp: string;
}

function partyQueryParam(party?: string | null): string {
  const normalized = normalizeCantonParty(party);
  if (!normalized || !normalized.trim()) return "";
  return `?party=${encodeURIComponent(normalized.trim())}`;
}

type PartyArg = string | null | { party?: string | null } | undefined;

function resolvePartyArg(input?: PartyArg): string | null {
  const rawParty: string | null =
    input && typeof input === "object"
      ? (input.party ?? null)
      : (input ?? null);
  return normalizeCantonParty(rawParty);
}

export function useCantonLedger(autoRefreshMs = 15_000, party?: string | null) {
  const effectiveParty = normalizeCantonParty(party);
  const [data, setData] = useState<CantonBalancesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const resp = await fetch(`/api/canton-balances${partyQueryParam(effectiveParty)}`);
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      const result: CantonBalancesData = await resp.json();
      setData(result);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [effectiveParty]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh
  useEffect(() => {
    if (autoRefreshMs <= 0) return;
    const interval = setInterval(refresh, autoRefreshMs);
    return () => clearInterval(interval);
  }, [autoRefreshMs, refresh]);

  return { data, loading, error, refresh };
}

/**
 * Submit a DAML command to Canton via server-side API route.
 */
export async function cantonExercise(
  templateId: string,
  contractId: string,
  choice: string,
  argument: Record<string, unknown>,
  partyOrOptions?: PartyArg
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const effectiveParty = resolvePartyArg(partyOrOptions);
  const resp = await fetch("/api/canton-command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ templateId, contractId, choice, argument, party: effectiveParty || undefined }),
  });
  // Handle non-JSON responses (e.g. Next.js error pages returning HTML)
  const contentType = resp.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await resp.text().catch(() => "Unknown error");
    return { success: false, error: `HTTP ${resp.status}: ${text.slice(0, 300)}` };
  }
  return resp.json();
}

/**
 * Fetch fresh balances data inline (not through React state).
 * Use this before exercising consuming choices to ensure the CID is current.
 */
export async function fetchFreshBalances(party?: string | null): Promise<CantonBalancesData> {
  const effectiveParty = normalizeCantonParty(party);
  const resp = await fetch(`/api/canton-balances${partyQueryParam(effectiveParty)}`);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

/**
 * Refresh all price feeds to prevent PRICE_STALE errors.
 * Call before borrow/withdraw operations.
 */
export async function refreshPriceFeeds(): Promise<{ success: boolean; refreshed?: number; error?: string }> {
  const resp = await fetch("/api/canton-refresh-prices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const contentType = resp.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await resp.text().catch(() => "Unknown error");
    return { success: false, error: `HTTP ${resp.status}: ${text.slice(0, 300)}` };
  }
  return resp.json();
}

/**
 * Create a DAML contract on Canton via server-side API route.
 */
export async function cantonCreate(
  templateId: string,
  payload: Record<string, unknown>,
  partyOrOptions?: PartyArg
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const effectiveParty = resolvePartyArg(partyOrOptions);
  const resp = await fetch("/api/canton-command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "create", templateId, payload, party: effectiveParty || undefined }),
  });
  // Handle non-JSON responses (e.g. Next.js error pages returning HTML)
  const contentType = resp.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await resp.text().catch(() => "Unknown error");
    return { success: false, error: `HTTP ${resp.status}: ${text.slice(0, 300)}` };
  }
  return resp.json();
}
