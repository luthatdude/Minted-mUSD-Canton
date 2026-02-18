// Points Page — displays user points, leaderboard, and referral system

import React, { useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { useUnifiedWallet } from "@/hooks/useUnifiedWallet";
import { useReferral } from "@/hooks/useReferral";
import WalletConnector from "@/components/WalletConnector";
import { ReferralTracker } from "@/components/ReferralTracker";
import { ReferralLeaderboard } from "@/components/ReferralLeaderboard";
import { ReferralWidget } from "@/components/ReferralWidget";

type PointsTab = "overview" | "referrals" | "leaderboard";

export function PointsPage() {
  const { address, isConnected } = useUnifiedWallet();
  const { dashboard } = useReferral();
  const [activeTab, setActiveTab] = useState<PointsTab>("overview");

  const tabs: { id: PointsTab; label: string; icon: JSX.Element }[] = [
    {
      id: "overview",
      label: "Overview",
      icon: (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
      ),
    },
    {
      id: "referrals",
      label: "My Referrals",
      icon: (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      ),
    },
    {
      id: "leaderboard",
      label: "Leaderboard",
      icon: (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
        </svg>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Points & Referrals"
        description="Earn points by minting, staking, borrowing, and referring friends. Referred TVL unlocks boosted multipliers."
      />

      {!isConnected ? (
        <WalletConnector />
      ) : (
        <>
          {/* Top-level Stats */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <StatCard label="Total Points" value="—" color="blue" />
            <StatCard label="Rank" value="—" />
            <StatCard
              label="Referrals"
              value={dashboard ? String(dashboard.numReferees) : "0"}
              color="green"
            />
            <StatCard
              label="Referral Boost"
              value={dashboard?.multiplier || "1.0x"}
              color="yellow"
              variant="glow"
            />
          </div>

          {/* Tab Navigation */}
          <div className="flex gap-1 rounded-xl bg-surface-800/50 p-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-all ${
                  activeTab === tab.id
                    ? "bg-brand-500 text-white shadow-lg shadow-brand-500/20"
                    : "text-gray-400 hover:text-white"
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab Content */}
          {activeTab === "overview" && (
            <div className="space-y-6">
              {/* Points Breakdown */}
              <div className="rounded-xl border border-white/10 bg-surface-900/50 p-6">
                <h3 className="mb-4 text-lg font-semibold text-white">Points Breakdown</h3>
                <p className="mb-6 text-sm text-gray-400">
                  Points are calculated daily based on your protocol activity.
                </p>
                <div className="space-y-3">
                  {[
                    { label: "mUSD Holding", rate: "1x / $ / day", icon: "💵" },
                    { label: "smUSD Staking", rate: "3x / $ / day", icon: "🔒" },
                    { label: "Borrowing", rate: "2x / $ / day", icon: "🏦" },
                    { label: "LP Positions", rate: "5x / $ / day", icon: "💎" },
                    { label: "Canton Bridge", rate: "1.5x multiplier", icon: "🌉" },
                    { label: "Referral Bonus", rate: "Up to 3x on referred TVL", icon: "🤝" },
                  ].map((item) => (
                    <div
                      key={item.label}
                      className="flex items-center justify-between rounded-lg bg-surface-800/30 px-4 py-3"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-lg">{item.icon}</span>
                        <span className="text-sm font-medium text-gray-300">{item.label}</span>
                      </div>
                      <span className="text-sm font-semibold text-brand-400">{item.rate}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Referral Widget (compact) */}
              <ReferralWidget />
            </div>
          )}

          {activeTab === "referrals" && <ReferralTracker />}

          {activeTab === "leaderboard" && <ReferralLeaderboard />}
        </>
      )}
    </div>
  );
}

export default PointsPage;
