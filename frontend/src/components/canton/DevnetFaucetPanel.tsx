import React, { useState, useCallback } from "react";
import { useLoopWallet } from "@/hooks/useLoopWallet";
import {
  useCantonLedger,
  fetchBridgePreflight,
} from "@/hooks/useCantonLedger";

/**
 * DevnetFaucetPanel — Devnet-only panel for minting test Canton assets.
 *
 * Shows only when:
 *   1. Loop wallet party is connected
 *   2. NEXT_PUBLIC_ENABLE_DEVNET_FAUCET=true
 *
 * Uses the /api/canton-devnet-faucet endpoint which enforces server-side
 * safety gates (env flag, allowlist, rate limit, daily cap).
 */

type FaucetAsset = "mUSD" | "CTN" | "USDC" | "USDCx";

interface FaucetState {
  loading: boolean;
  success: string | null;
  error: string | null;
  errorType: string | null;
  remainingDailyCap: string | null;
  nextAllowedAt: string | null;
}

const CANTON_ASSETS: { key: FaucetAsset; label: string; description: string; defaultAmount: string; gradient: string }[] = [
  {
    key: "mUSD",
    label: "Canton mUSD",
    description: "CantonMUSD token for staking into smUSD pools",
    defaultAmount: "100",
    gradient: "from-brand-500 to-purple-500",
  },
  {
    key: "CTN",
    label: "Canton Coin (CTN)",
    description: "CantonCoin for Boost Pool deposits and ETH Pool staking",
    defaultAmount: "50",
    gradient: "from-yellow-400 to-orange-500",
  },
  {
    key: "USDC",
    label: "Canton USDC",
    description: "CantonUSDC for ETH Pool deposits",
    defaultAmount: "100",
    gradient: "from-blue-500 to-cyan-500",
  },
  {
    key: "USDCx",
    label: "Canton USDCx",
    description: "USDCx (bridged USDC variant) for ETH Pool deposits",
    defaultAmount: "100",
    gradient: "from-teal-500 to-emerald-500",
  },
];

function fmtAmount(v: string | number, decimals = 2): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (isNaN(n)) return "0.00";
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function DevnetFaucetPanel() {
  const { partyId } = useLoopWallet();
  const activeParty = partyId || null;
  const { refresh } = useCantonLedger(0, activeParty);

  const [amounts, setAmounts] = useState<Record<string, string>>({
    mUSD: "100",
    CTN: "50",
    USDC: "100",
    USDCx: "100",
  });
  const [states, setStates] = useState<Record<string, FaucetState>>({});

  // Feature flag check (client-side, server enforces independently)
  const clientEnabled = process.env.NEXT_PUBLIC_ENABLE_DEVNET_FAUCET === "true";

  const handleMint = useCallback(async (asset: FaucetAsset) => {
    if (!activeParty) return;
    const amount = amounts[asset];
    if (!amount || parseFloat(amount) <= 0) return;

    setStates((s) => ({
      ...s,
      [asset]: { loading: true, success: null, error: null, errorType: null, remainingDailyCap: null, nextAllowedAt: null },
    }));

    try {
      const resp = await fetch("/api/canton-devnet-faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ party: activeParty, asset, amount }),
      });

      const data = await resp.json();

      if (data.success) {
        setStates((s) => ({
          ...s,
          [asset]: {
            loading: false,
            success: `Minted ${fmtAmount(data.amount)} ${asset} (tx: ${data.txId?.slice(0, 20)}...)`,
            error: null,
            errorType: null,
            remainingDailyCap: data.remainingDailyCap || null,
            nextAllowedAt: data.nextAllowedAt || null,
          },
        }));
        // Refresh balances + preflight after successful mint
        await refresh();
        if (activeParty) {
          try { await fetchBridgePreflight(activeParty); } catch { /* non-critical */ }
        }
      } else {
        setStates((s) => ({
          ...s,
          [asset]: {
            loading: false,
            success: null,
            error: data.error || "Unknown error",
            errorType: data.errorType || null,
            remainingDailyCap: data.remainingDailyCap || null,
            nextAllowedAt: data.nextAllowedAt || null,
          },
        }));
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setStates((s) => ({
        ...s,
        [asset]: { loading: false, success: null, error: message, errorType: "NETWORK_ERROR", remainingDailyCap: null, nextAllowedAt: null },
      }));
    }
  }, [activeParty, amounts, refresh]);

  // Don't render if feature flag is off or wallet disconnected
  if (!clientEnabled || !activeParty) return null;

  return (
    <div className="space-y-4">
      {/* Warning banner */}
      <div className="rounded-xl border-2 border-amber-500/40 bg-amber-500/10 p-4">
        <div className="flex items-center gap-3">
          <svg className="h-6 w-6 shrink-0 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <div>
            <p className="font-semibold text-amber-300">DEVNET ONLY &mdash; TEST ASSET FAUCET</p>
            <p className="text-sm text-amber-400/70">These tokens have no real value. For testing Canton staking and bridge flows only.</p>
          </div>
        </div>
      </div>

      {/* Party info */}
      <div className="rounded-lg border border-white/5 bg-surface-900/30 px-4 py-2 text-xs text-gray-500">
        Party: <span className="font-mono text-gray-400">{activeParty.slice(0, 40)}...</span>
      </div>

      {/* Asset faucet cards */}
      {CANTON_ASSETS.map((asset) => {
        const state = states[asset.key] || { loading: false, success: null, error: null, errorType: null, remainingDailyCap: null, nextAllowedAt: null };

        return (
          <div key={asset.key} className="rounded-xl border border-white/10 bg-surface-800/50 p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className={`flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br ${asset.gradient}`}>
                  <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                </div>
                <div>
                  <h4 className="font-semibold text-white">{asset.label}</h4>
                  <p className="text-xs text-gray-400">{asset.description}</p>
                </div>
              </div>
            </div>

            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <input
                  type="number"
                  value={amounts[asset.key] || ""}
                  onChange={(e) => setAmounts((a) => ({ ...a, [asset.key]: e.target.value }))}
                  placeholder="Amount"
                  min="0"
                  className="w-full rounded-lg border border-white/10 bg-surface-900/50 px-4 py-2.5 text-white placeholder-gray-500 outline-none focus:border-brand-500/50 focus:ring-1 focus:ring-brand-500/30"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-500">
                  {asset.key}
                </span>
              </div>
              <button
                onClick={() => handleMint(asset.key)}
                disabled={state.loading || !amounts[asset.key] || parseFloat(amounts[asset.key] || "0") <= 0}
                className={`flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r ${asset.gradient} px-5 py-2.5 text-sm font-medium text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50`}
              >
                {state.loading ? (
                  <>
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    Minting...
                  </>
                ) : (
                  <>Mint {asset.key}</>
                )}
              </button>
            </div>

            {/* Quota info */}
            {(state.remainingDailyCap || state.nextAllowedAt) && (
              <div className="mt-2 flex gap-4 text-xs text-gray-500">
                {state.remainingDailyCap && (
                  <span>Daily cap remaining: {fmtAmount(state.remainingDailyCap)}</span>
                )}
                {state.nextAllowedAt && (
                  <span>Next allowed: {new Date(state.nextAllowedAt).toLocaleTimeString()}</span>
                )}
              </div>
            )}

            {/* Success message */}
            {state.success && (
              <div className="mt-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400">
                {state.success}
              </div>
            )}

            {/* Error message */}
            {state.error && (
              <div className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                <span className="font-medium">{state.errorType ? `[${state.errorType}] ` : ""}</span>
                {state.error}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
