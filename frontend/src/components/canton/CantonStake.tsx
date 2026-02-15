import React from "react";

// ═════════════════════════════════════════════════════════════════
//  Canton Staking — Placeholder
//  Yield vaults have been removed. This component shows a placeholder
//  for the Canton staking route.
// ═════════════════════════════════════════════════════════════════

export function CantonStake() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-24 text-center">
      {/* Icon */}
      <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-orange-500/20 to-blue-500/20 border border-white/10">
        <svg className="h-8 w-8 text-orange-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
        </svg>
      </div>

      <h1 className="text-2xl font-bold text-white mb-3">
        Yield Vaults — Coming Soon
      </h1>

      <p className="text-gray-400 max-w-md mx-auto mb-8 leading-relaxed">
        Leveraged LP vaults for BTC and ETH are being redesigned.
        Strategy parameters, risk limits, and pool configuration are under review.
      </p>

      <div className="inline-flex items-center gap-2 rounded-full bg-surface-800 px-4 py-2 text-sm text-gray-500 border border-white/5">
        <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
        Strategy review in progress
      </div>
    </div>
  );
}
