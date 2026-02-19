import React from "react";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { useCantonLedger } from "@/hooks/useCantonLedger";

const COLLATERAL_TOKENS = [
  { key: "smusd",  label: "smUSD",   color: "from-emerald-500 to-teal-500",  ltv: "85%", liqThreshold: "90%", liqPenalty: "5%" },
  { key: "smusde", label: "smUSD-E", color: "from-blue-500 to-indigo-500",   ltv: "85%", liqThreshold: "90%", liqPenalty: "5%" },
  { key: "ctn",    label: "CTN",     color: "from-yellow-400 to-orange-500", ltv: "65%", liqThreshold: "75%", liqPenalty: "10%" },
];

export function CantonBorrow() {
  const { data, loading, error, refresh } = useCantonLedger(15_000);

  const totalMusd = data ? parseFloat(data.totalBalance) : 0;

  if (loading && !data) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-4 border-emerald-500/20 border-t-emerald-500" />
          <p className="text-gray-400">Loading Canton ledger…</p>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="max-w-md space-y-4 text-center">
          <h3 className="text-xl font-semibold text-white">Canton Unavailable</h3>
          <p className="text-sm text-gray-400">{error}</p>
          <button onClick={refresh} className="rounded-xl bg-emerald-600 px-6 py-2 font-medium text-white hover:bg-emerald-500">Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <PageHeader
        title="Borrow"
        subtitle="Deposit collateral and borrow mUSD at competitive rates"
        badge="Canton"
        badgeColor="warning"
        action={
          <button onClick={refresh} className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-400 hover:bg-emerald-500/20">
            <svg className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        }
      />

      {/* Balance Overview */}
      <div className="grid gap-4 sm:grid-cols-4">
        <StatCard
          label="Available mUSD"
          value={totalMusd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          color="green"
          variant="glow"
        />
        <StatCard label="mUSD Contracts" value={String(data?.tokenCount || 0)} color="blue" />
        <StatCard label="Total Borrowed" value="0.00" subValue="No debt positions" />
        <StatCard label="Collateral" value="0.00" subValue="No escrows" />
      </div>

      {/* Coming Soon Banner */}
      <div className="card-emerald overflow-hidden p-8 text-center space-y-6">
        <div className="mx-auto h-16 w-16 rounded-2xl bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center">
          <svg className="h-8 w-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
          </svg>
        </div>
        <div>
          <h3 className="text-2xl font-bold text-white">Canton Lending Protocol</h3>
          <p className="text-sm text-gray-400 mt-2 max-w-lg mx-auto">
            Deposit smUSD, smUSD-E, or CTN as collateral and borrow mUSD at competitive rates.
            Over-collateralized lending with real-time liquidation protection.
          </p>
        </div>

        <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-5 max-w-lg mx-auto">
          <div className="flex items-center justify-center gap-3 mb-2">
            <svg className="h-6 w-6 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-lg font-semibold text-yellow-300">Coming Soon</span>
          </div>
          <p className="text-sm text-gray-400">
            The Canton Lending Service is not yet deployed on this participant.
            Your {totalMusd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} mUSD will be available as borrowable liquidity once the DAML templates are uploaded.
          </p>
        </div>

        <button
          disabled
          className="mx-auto flex items-center gap-2 rounded-xl bg-yellow-600/30 px-8 py-3 font-semibold text-yellow-300/50 cursor-not-allowed"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          Borrow mUSD — Awaiting Deployment
        </button>
      </div>

      {/* Collateral Types */}
      <div className="grid gap-4 sm:grid-cols-3">
        {COLLATERAL_TOKENS.map(({ key, label, color, ltv, liqThreshold, liqPenalty }) => (
          <div key={key} className="card group transition-all duration-300 hover:border-white/20">
            <div className={`mb-4 h-12 w-12 rounded-xl bg-gradient-to-br ${color} flex items-center justify-center`}>
              <span className="text-white font-bold">{label[0]}</span>
            </div>
            <h4 className="text-sm font-bold text-white mb-3">{label} Collateral</h4>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-500">Max LTV</span>
                <span className="text-white font-medium">{ltv}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-500">Liquidation</span>
                <span className="text-yellow-400 font-medium">{liqThreshold}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-500">Penalty</span>
                <span className="text-red-400 font-medium">{liqPenalty}</span>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between">
              <span className="text-xs text-gray-500">Status</span>
              <span className="rounded-full bg-yellow-500/10 px-2 py-0.5 text-xs font-medium text-yellow-400">Not Deployed</span>
            </div>
          </div>
        ))}
      </div>

      {/* How It Works */}
      <div className="card">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-yellow-500/20">
            <svg className="h-5 w-5 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-white">How Canton Lending Works</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-4">
          {[
            { step: "1", title: "Deposit Collateral", desc: "Deposit smUSD, smUSD-E, or CTN into a collateral escrow.", color: "emerald" },
            { step: "2", title: "Borrow mUSD", desc: "Borrow mUSD up to the LTV ratio of your collateral.", color: "blue" },
            { step: "3", title: "Repay Debt", desc: "Repay your mUSD debt plus accrued interest.", color: "purple" },
            { step: "4", title: "Withdraw", desc: "Reclaim your collateral once debt is cleared.", color: "yellow" },
          ].map(({ step, title, desc, color }) => (
            <div key={step} className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
              <div className={`flex h-8 w-8 items-center justify-center rounded-full bg-${color}-500/20 text-${color}-400 font-bold text-sm mb-3`}>{step}</div>
              <h3 className="font-medium text-white mb-1">{title}</h3>
              <p className="text-sm text-gray-400">{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
