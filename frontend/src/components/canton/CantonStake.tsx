import React, { useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { useCantonLedger } from "@/hooks/useCantonLedger";

// ─── Pool Definitions ──────────────────────────────────────────────────────
type CantonPoolTab = "smusd" | "ethpool" | "boost";

const CANTON_POOL_CONFIG = [
  { key: "smusd" as CantonPoolTab, label: "smUSD", badge: "Global Yield", color: "from-emerald-500 to-teal-500", desc: "Stake mUSD to earn protocol yield as smUSD. Auto-compounding with no lock period.", apy: "4.5%" },
  { key: "ethpool" as CantonPoolTab, label: "ETH Pool", badge: "smUSD-E", color: "from-blue-500 to-indigo-500", desc: "Provide ETH-denominated liquidity for smUSD-E with lock tier multipliers.", apy: "8.2%" },
  { key: "boost" as CantonPoolTab, label: "Boost Pool", badge: "Validator", color: "from-yellow-400 to-orange-500", desc: "Stake Canton Coin (CTN) to boost validator rewards and earn protocol fees.", apy: "12.0%" },
];

// ─── Component ──────────────────────────────────────────────────────────────
export function CantonStake() {
  const { data, loading, error, refresh } = useCantonLedger(15_000);
  const [pool, setPool] = useState<CantonPoolTab>("smusd");

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

  const selectedPool = CANTON_POOL_CONFIG.find((p) => p.key === pool)!;

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <PageHeader
        title="Stake"
        subtitle="Stake mUSD and Canton assets to earn protocol yield"
        badge="Canton"
        badgeColor="emerald"
        action={
          <button onClick={refresh} className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-400 hover:bg-emerald-500/20">
            <svg className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        }
      />

      {/* Balance Banner */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Available mUSD"
          value={totalMusd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          color="green"
          variant="glow"
        />
        <StatCard label="mUSD Contracts" value={String(data?.tokenCount || 0)} color="blue" />
        <StatCard label="Staked Balance" value="0.00" subValue="Services deploying…" />
      </div>

      {/* Pool Tabs */}
      <div className="flex gap-3">
        {CANTON_POOL_CONFIG.map(({ key, label, badge, color }) => (
          <button
            key={key}
            className={`group relative flex-1 rounded-xl border p-4 text-left transition-all duration-300 ${
              pool === key
                ? "border-white/20 bg-white/[0.04] shadow-lg"
                : "border-white/5 bg-white/[0.01] hover:border-white/10"
            }`}
            onClick={() => setPool(key)}
          >
            <div className="flex items-center gap-3">
              <div className={`h-10 w-10 rounded-full bg-gradient-to-br ${color} flex items-center justify-center`}>
                <span className="text-white font-bold text-sm">{label[0]}</span>
              </div>
              <div>
                <p className="font-semibold text-white">{label}</p>
                <p className="text-xs text-gray-500">{badge}</p>
              </div>
            </div>
            {pool === key && <span className="absolute bottom-0 left-1/2 h-0.5 w-16 -translate-x-1/2 rounded-full bg-gradient-to-r from-emerald-500 to-cyan-500" />}
          </button>
        ))}
      </div>

      {/* Selected Pool Card */}
      <div className="card-emerald overflow-hidden">
        <div className="p-8 text-center space-y-6">
          <div className={`mx-auto h-16 w-16 rounded-2xl bg-gradient-to-br ${selectedPool.color} flex items-center justify-center`}>
            <span className="text-white font-bold text-2xl">{selectedPool.label[0]}</span>
          </div>
          <div>
            <h3 className="text-2xl font-bold text-white">{selectedPool.label} Pool</h3>
            <p className="text-sm text-gray-400 mt-2 max-w-md mx-auto">{selectedPool.desc}</p>
          </div>

          {/* Projected APY */}
          <div className="rounded-xl bg-surface-800/50 border border-white/10 p-4 max-w-xs mx-auto">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Projected APY</p>
            <p className="text-3xl font-bold text-emerald-400 mt-1">{selectedPool.apy}</p>
          </div>

          {/* Coming Soon Banner */}
          <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-5 max-w-lg mx-auto">
            <div className="flex items-center justify-center gap-3 mb-2">
              <svg className="h-6 w-6 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-lg font-semibold text-yellow-300">Coming Soon</span>
            </div>
            <p className="text-sm text-gray-400">
              The {selectedPool.label} staking service is not yet deployed on this Canton participant.
              Your {totalMusd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} mUSD will be stakeable once the DAML templates are uploaded.
            </p>
          </div>

          {/* Disabled Stake Button */}
          <button
            disabled
            className="mx-auto flex items-center gap-2 rounded-xl bg-emerald-600/30 px-8 py-3 font-semibold text-emerald-300/50 cursor-not-allowed"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            Stake mUSD — Awaiting Deployment
          </button>
        </div>
      </div>

      {/* Pool Descriptions Grid */}
      <div className="grid gap-4 sm:grid-cols-3">
        {CANTON_POOL_CONFIG.map(({ key, label, desc, color, apy }) => (
          <div key={key} className="card group transition-all duration-300 hover:border-white/20">
            <div className={`mb-4 h-12 w-12 rounded-xl bg-gradient-to-br ${color} flex items-center justify-center`}>
              <span className="text-white font-bold">{label[0]}</span>
            </div>
            <h4 className="text-sm font-bold text-white mb-1">{label} Pool</h4>
            <p className="text-xs text-gray-400 mb-3">{desc}</p>
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500">Projected APY</span>
              <span className="text-sm font-bold text-emerald-400">{apy}</span>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs text-gray-500">Status</span>
              <span className="rounded-full bg-yellow-500/10 px-2 py-0.5 text-xs font-medium text-yellow-400">Not Deployed</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

