import { useState, useEffect, useCallback } from "react";

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

export interface CantonBalancesData {
  tokens: CantonMUSDToken[];
  totalBalance: string;
  tokenCount: number;
  bridgeService: BridgeServiceInfo | null;
  pendingBridgeIns: number;
  supplyService: boolean;
  ledgerOffset: number;
  party: string;
  timestamp: string;
}

export function useCantonLedger(autoRefreshMs = 15_000) {
  const [data, setData] = useState<CantonBalancesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const resp = await fetch("/api/canton-balances");
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
  }, []);

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
  argument: Record<string, unknown>
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const resp = await fetch("/api/canton-command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ templateId, contractId, choice, argument }),
  });
  return resp.json();
}

/**
 * Create a DAML contract on Canton via server-side API route.
 */
export async function cantonCreate(
  templateId: string,
  payload: Record<string, unknown>
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const resp = await fetch("/api/canton-command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "create", templateId, payload }),
  });
  return resp.json();
}
