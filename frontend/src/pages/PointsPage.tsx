import React, { useEffect, useState, useCallback } from "react";
import { StatCard } from "@/components/StatCard";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/Section";
import { useWalletConnect } from "@/hooks/useWalletConnect";

// ═══════════════════════════════════════════════════════════════
// Types — Mirrors points API response shapes
// ═══════════════════════════════════════════════════════════════

interface SeasonInfo {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: string;
  daysRemaining?: number;
  multiplier: number;
}

interface UserPoints {
  address: string;
  totalPoints: number;
  currentSeason: { id: string; name: string; rank: number | null } | null;
  breakdown: Record<string, Record<string, number>>;
  seasonRanks: { seasonId: string; seasonName: string; rank: number | null }[];
}

interface LeaderboardEntry {
  rank: number;
  address: string;
  points: number;
}

interface SeasonStats {
  seasonId: string;
  totalPoints: number;
  uniqueUsers: number;
  topActions: { action: string; total: number }[];
}

interface APYData {
  impliedAPY: number;
  assumptions: {
    tokenPrice: number;
    totalTokensForAirdrop: number;
    totalValueOfAirdrop: number;
  };
  scenarios: {
    label: string;
    depositUsd: number;
    estimatedPoints: number;
    tokenAllocation: number;
    tokenValue: number;
    apy: number;
  }[];
}

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

const POINTS_API = process.env.NEXT_PUBLIC_POINTS_API_URL || "http://localhost:3210";

const ACTION_LABELS: Record<string, string> = {
  ETH_MINT: "Mint mUSD",
  ETH_STAKE: "Stake sMUSD",
  ETH_BORROW: "Borrow",
  ETH_COLLATERAL: "Deposit Collateral",
  ETH_BRIDGE: "Bridge",
  ETH_LEVERAGE: "Leverage",
  CTN_MINT: "Canton Mint",
  CTN_STAKE: "Canton Stake",
  CTN_BORROW: "Canton Borrow",
  CTN_BRIDGE: "Canton Bridge",
  CTN_BOOST: "Canton Boost Pool",
};

// ═══════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════

export function PointsPage() {
  const { address, isConnected } = useWalletConnect();

  const [season, setSeason] = useState<SeasonInfo | null>(null);
  const [allSeasons, setAllSeasons] = useState<SeasonInfo[]>([]);
  const [userPoints, setUserPoints] = useState<UserPoints | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [stats, setStats] = useState<SeasonStats | null>(null);
  const [apyData, setApyData] = useState<APYData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"overview" | "leaderboard" | "calculator">("overview");
  const [error, setError] = useState<string | null>(null);

  // ─── Fetch helpers ──────────────────────────────────────────
  const fetchApi = useCallback(async <T,>(path: string): Promise<T | null> => {
    try {
      const res = await fetch(`${POINTS_API}${path}`);
      if (!res.ok) throw new Error(`API ${res.status}`);
      return await res.json();
    } catch (e) {
      console.error(`[Points] Failed to fetch ${path}:`, e);
      return null;
    }
  }, []);

  // ─── Load data ──────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);

      try {
        const [seasonRes, seasonsRes, leaderRes, apyRes] = await Promise.all([
          fetchApi<SeasonInfo>("/api/season"),
          fetchApi<SeasonInfo[]>("/api/seasons"),
          fetchApi<{ entries: LeaderboardEntry[] }>("/api/leaderboard?limit=25"),
          fetchApi<APYData>("/api/apy/scenarios"),
        ]);

        if (seasonRes) setSeason(seasonRes);
        if (seasonsRes) setAllSeasons(seasonsRes);
        if (leaderRes) setLeaderboard(leaderRes.entries || []);
        if (apyRes) setApyData(apyRes);

        // Per-season stats
        if (seasonRes?.id) {
          const statsRes = await fetchApi<SeasonStats>(`/api/stats/${seasonRes.id}`);
          if (statsRes) setStats(statsRes);
        }
      } catch (e) {
        setError("Failed to connect to Points API");
      }

      setLoading(false);
    }
    load();
  }, [fetchApi]);

  // ─── Load user data when connected ─────────────────────────
  useEffect(() => {
    if (!address) {
      setUserPoints(null);
      return;
    }
    fetchApi<UserPoints>(`/api/points/${address}`).then((res) => {
      if (res) setUserPoints(res);
    });
  }, [address, fetchApi]);

  // ─── Rendering helpers ─────────────────────────────────────
  const formatNumber = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` :
    n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` :
    n.toFixed(0);

  const shortenAddr = (addr: string) =>
    `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  const getSeasonProgress = (): number => {
    if (!season?.startDate || !season?.endDate) return 0;
    const start = new Date(season.startDate).getTime();
    const end = new Date(season.endDate).getTime();
    const now = Date.now();
    return Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100));
  };

  // ─── Loading state ─────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="h-12 w-12 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
          <p className="text-gray-400">Loading Points...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="card p-8 text-center">
          <p className="text-lg font-semibold text-red-400">⚠ {error}</p>
          <p className="mt-2 text-sm text-gray-500">Ensure the Points API is running on port 3210</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <PageHeader
        title="Points Program"
        subtitle="Earn points for using the protocol. Points convert to MNTD token airdrop."
        badge={season?.name || "No Active Season"}
        badgeColor="brand"
      />

      {/* Season Progress Bar */}
      {season && (
        <div className="card p-6">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold text-white">{season.name}</h3>
              <p className="text-sm text-gray-400">
                {season.multiplier}x multiplier &bull;{" "}
                {season.daysRemaining != null ? `${season.daysRemaining} days remaining` : season.status}
              </p>
            </div>
            <span className="rounded-full border border-brand-500/30 bg-brand-500/10 px-3 py-1 text-xs font-semibold text-brand-400">
              {getSeasonProgress().toFixed(0)}% Complete
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-700">
            <div
              className="h-full rounded-full bg-gradient-to-r from-brand-500 to-purple-500 transition-all duration-500"
              style={{ width: `${getSeasonProgress()}%` }}
            />
          </div>
          {allSeasons.length > 0 && (
            <div className="mt-4 flex gap-4">
              {allSeasons.map((s) => (
                <div key={s.id} className="flex items-center gap-2 text-xs text-gray-500">
                  <span className={`h-2 w-2 rounded-full ${s.status === "active" ? "bg-emerald-400" : s.status === "completed" ? "bg-gray-600" : "bg-gray-700"}`} />
                  {s.name} ({s.multiplier}x)
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab Nav */}
      <div className="flex gap-2 rounded-xl bg-surface-800/50 p-1">
        {(["overview", "leaderboard", "calculator"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 rounded-lg px-4 py-2.5 text-sm font-medium capitalize transition-all ${
              activeTab === tab
                ? "bg-brand-500/20 text-brand-400"
                : "text-gray-400 hover:text-white"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* ════════════ TAB: OVERVIEW ════════════ */}
      {activeTab === "overview" && (
        <div className="space-y-8">
          {/* User Stats */}
          {isConnected && userPoints ? (
            <Section title="Your Points" subtitle="Personal earnings summary">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard
                  label="Total Points"
                  value={formatNumber(userPoints.totalPoints)}
                  color="blue"
                  variant="glow"
                />
                <StatCard
                  label="Global Rank"
                  value={userPoints.currentSeason?.rank ? `#${userPoints.currentSeason.rank}` : "—"}
                  color="purple"
                />
                <StatCard
                  label="Current Season"
                  value={userPoints.currentSeason?.name || "—"}
                  color="default"
                />
                <StatCard
                  label="Seasons Active"
                  value={`${userPoints.seasonRanks.filter((r) => r.rank !== null).length} / ${allSeasons.length}`}
                  color="green"
                />
              </div>

              {/* Per-action breakdown */}
              <div className="mt-6 card p-6">
                <h4 className="mb-4 text-sm font-semibold uppercase text-gray-400">Points Breakdown</h4>
                <div className="space-y-3">
                  {Object.entries(userPoints.breakdown).map(([seasonId, actions]) => (
                    <div key={seasonId} className="space-y-2">
                      <p className="text-xs font-medium text-gray-500">{seasonId}</p>
                      {Object.entries(actions).map(([action, pts]) => (
                        <div key={action} className="flex items-center justify-between rounded-lg bg-surface-800/50 px-4 py-2">
                          <span className="text-sm text-gray-300">{ACTION_LABELS[action] || action}</span>
                          <span className="text-sm font-semibold text-brand-400">{formatNumber(pts)} pts</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </Section>
          ) : (
            <div className="card flex flex-col items-center gap-4 p-12 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-500/10">
                <svg className="h-8 w-8 text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-white">Connect Wallet to View Your Points</h3>
              <p className="text-sm text-gray-400">Earn points by minting, staking, borrowing, and bridging</p>
            </div>
          )}

          {/* Global Stats */}
          {stats && (
            <Section title="Season Statistics" subtitle={`Stats for ${season?.name || "current season"}`}>
              <div className="grid gap-4 sm:grid-cols-3">
                <StatCard label="Total Points Earned" value={formatNumber(stats.totalPoints)} color="blue" />
                <StatCard label="Unique Users" value={formatNumber(stats.uniqueUsers)} color="green" />
                <StatCard label="Top Actions" value={`${stats.topActions?.[0]?.action || "—"}`} color="purple" />
              </div>
            </Section>
          )}

          {/* How It Works */}
          <Section title="How It Works" subtitle="Every dollar-hour of participation earns points">
            <div className="card p-6">
              <p className="text-sm text-gray-400 leading-relaxed mb-4">
                Deposit, stake, borrow, or provide liquidity — every dollar-hour of participation earns points.
                The more you deploy and the longer you hold, the more you earn.
              </p>
              <div className="rounded-xl bg-surface-800/50 border border-white/5 p-4 text-center">
                <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Formula</p>
                <p className="text-lg font-bold text-white">Your Points = USD Value × Multiplier × Hours</p>
              </div>
            </div>
          </Section>

          {/* 3 Seasons Multiplier Table */}
          <Section title="3 Seasons — Early Adopters Earn the Most" subtitle="Multipliers decrease over time — get in early">
            <div className="card overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/5 text-left text-xs uppercase text-gray-500">
                    <th className="px-6 py-4">Season</th>
                    <th className="px-6 py-4 text-right">Canton Boost Pool</th>
                    <th className="px-6 py-4 text-right">sMUSD</th>
                    <th className="px-6 py-4 text-right">Collateral</th>
                    <th className="px-6 py-4 text-right">Borrow</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-white/5 bg-emerald-500/5">
                    <td className="px-6 py-4 font-medium text-white">1 — Genesis</td>
                    <td className="px-6 py-4 text-right font-bold text-emerald-400">10× 🔥</td>
                    <td className="px-6 py-4 text-right text-white">4×</td>
                    <td className="px-6 py-4 text-right text-white">3×</td>
                    <td className="px-6 py-4 text-right text-white">2×</td>
                  </tr>
                  <tr className="border-b border-white/5">
                    <td className="px-6 py-4 font-medium text-gray-300">2 — Growth</td>
                    <td className="px-6 py-4 text-right text-gray-300">6×</td>
                    <td className="px-6 py-4 text-right text-gray-300">2.5×</td>
                    <td className="px-6 py-4 text-right text-gray-300">2×</td>
                    <td className="px-6 py-4 text-right text-gray-300">1.5×</td>
                  </tr>
                  <tr>
                    <td className="px-6 py-4 font-medium text-gray-400">3 — Maturity</td>
                    <td className="px-6 py-4 text-right text-gray-400">4×</td>
                    <td className="px-6 py-4 text-right text-gray-400">1.5×</td>
                    <td className="px-6 py-4 text-right text-gray-400">1×</td>
                    <td className="px-6 py-4 text-right text-gray-400">1×</td>
                  </tr>
                </tbody>
              </table>
              <p className="px-6 py-3 text-xs text-gray-500 border-t border-white/5">
                Multipliers shown for Canton. Ethereum multipliers are lower — Canton users always earn more.
              </p>
            </div>
          </Section>

          {/* What Earns Points */}
          <Section title="What Earns Points" subtitle="Actions across both chains">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="card p-5">
                <div className="flex items-center gap-2 mb-4">
                  <span className="rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-bold text-emerald-400">Canton</span>
                  <span className="text-xs text-gray-500">Higher multipliers</span>
                </div>
                <ul className="space-y-2 text-sm text-gray-300">
                  <li className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Stake mUSD → sMUSD
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Deposit sMUSD or CTN as collateral
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Borrow mUSD
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" /> Deposit $CC in the Canton Boost Pool ← <span className="font-semibold text-emerald-400">highest multiplier, always</span>
                  </li>
                </ul>
              </div>
              <div className="card p-5">
                <div className="flex items-center gap-2 mb-4">
                  <span className="rounded-full bg-brand-500/20 px-3 py-1 text-xs font-bold text-brand-400">Ethereum</span>
                </div>
                <ul className="space-y-2 text-sm text-gray-300">
                  <li className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-brand-400" /> Hold sMUSD
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-brand-400" /> Deposit ETH, WBTC, or sMUSD as collateral
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-brand-400" /> Borrow mUSD
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-brand-400" /> Open Leverage Vault positions
                  </li>
                </ul>
              </div>
            </div>
          </Section>

          {/* Points APY by TVL */}
          <Section title="Points APY (Implied)" subtitle="Your points APY depends on total protocol TVL — get in early, earn BIG">
            <div className="card overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/5 text-left text-xs uppercase text-gray-500">
                    <th className="px-6 py-4">Weighted TVL</th>
                    <th className="px-6 py-4 text-right">Canton Boost Pool 🔥</th>
                    <th className="px-6 py-4 text-right">sMUSD (Canton)</th>
                    <th className="px-6 py-4 text-right">sMUSD (Ethereum)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-white/5 bg-emerald-500/5">
                    <td className="px-6 py-4 font-medium text-white">$5M</td>
                    <td className="px-6 py-4 text-right font-bold text-emerald-400">354%</td>
                    <td className="px-6 py-4 text-right text-white">142%</td>
                    <td className="px-6 py-4 text-right text-gray-300">106%</td>
                  </tr>
                  <tr className="border-b border-white/5">
                    <td className="px-6 py-4 font-medium text-white">$10M</td>
                    <td className="px-6 py-4 text-right font-bold text-emerald-400">177%</td>
                    <td className="px-6 py-4 text-right text-white">71%</td>
                    <td className="px-6 py-4 text-right text-gray-300">53%</td>
                  </tr>
                  <tr className="border-b border-white/5">
                    <td className="px-6 py-4 font-medium text-white">$25M</td>
                    <td className="px-6 py-4 text-right font-bold text-emerald-400">71%</td>
                    <td className="px-6 py-4 text-right text-white">28%</td>
                    <td className="px-6 py-4 text-right text-gray-300">21%</td>
                  </tr>
                  <tr>
                    <td className="px-6 py-4 font-medium text-white">$50M</td>
                    <td className="px-6 py-4 text-right font-bold text-emerald-400">35%</td>
                    <td className="px-6 py-4 text-right text-white">14%</td>
                    <td className="px-6 py-4 text-right text-gray-300">11%</td>
                  </tr>
                </tbody>
              </table>
              <p className="px-6 py-3 text-xs text-gray-500 border-t border-white/5">
                Implied at $100M FDV. This is in addition to protocol yield.
              </p>
            </div>
          </Section>

          {/* Maximize Your Points */}
          <Section title="Maximize Your Points" subtitle="Strategies to earn the most">
            <div className="card p-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex items-start gap-3">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-500/20 text-brand-400 font-bold text-sm flex-shrink-0">1</span>
                  <div>
                    <h4 className="font-medium text-white text-sm">Get in early</h4>
                    <p className="text-xs text-gray-400">Season 1 multipliers are the highest</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400 font-bold text-sm flex-shrink-0">2</span>
                  <div>
                    <h4 className="font-medium text-white text-sm">Use Canton</h4>
                    <p className="text-xs text-gray-400">Every action earns more points than Ethereum</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-purple-500/20 text-purple-400 font-bold text-sm flex-shrink-0">3</span>
                  <div>
                    <h4 className="font-medium text-white text-sm">Loop your sMUSD</h4>
                    <p className="text-xs text-gray-400">Leverage multiplies your points on every layer</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-yellow-500/20 text-yellow-400 font-bold text-sm flex-shrink-0">4</span>
                  <div>
                    <h4 className="font-medium text-white text-sm">Deposit $CC in the Boost Pool</h4>
                    <p className="text-xs text-gray-400">10× in Season 1, always the highest multiplier</p>
                  </div>
                </div>
              </div>
            </div>
          </Section>

          {/* Airdrop */}
          <Section title="Airdrop" subtitle="$MINT Token Generation Event">
            <div className="card p-6">
              <div className="flex items-center gap-3 mb-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-purple-500">
                  <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v13m0-13V6a2 2 0 112 2h-2zm0 0V5.5A2.5 2.5 0 109.5 8H12zm-7 4h14M5 12a2 2 0 110-4h14a2 2 0 110 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7" />
                  </svg>
                </div>
                <div>
                  <h3 className="font-semibold text-white">Points → $MINT Tokens</h3>
                  <p className="text-sm text-gray-400">End of Season 3, proportional to your share of total points</p>
                </div>
              </div>
              <p className="text-sm text-gray-400">
                All points accumulated across all three seasons convert to $MINT tokens at TGE. Your allocation is proportional
                to your share of the total points pool. The earlier and more actively you participate, the larger your share.
              </p>
            </div>
          </Section>
        </div>
      )}

      {/* ════════════ TAB: LEADERBOARD ════════════ */}
      {activeTab === "leaderboard" && (
        <Section title="Leaderboard" subtitle="Top 25 point earners">
          <div className="card overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/5 text-left text-xs uppercase text-gray-500">
                  <th className="px-6 py-4">Rank</th>
                  <th className="px-6 py-4">Address</th>
                  <th className="px-6 py-4 text-right">Points</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((entry, i) => {
                  const isUser = address && entry.address.toLowerCase() === address.toLowerCase();
                  return (
                    <tr
                      key={entry.address}
                      className={`border-b border-white/5 transition-colors ${
                        isUser ? "bg-brand-500/10" : "hover:bg-white/[0.02]"
                      }`}
                    >
                      <td className="px-6 py-4">
                        <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                          i === 0 ? "bg-yellow-500/20 text-yellow-400" :
                          i === 1 ? "bg-gray-400/20 text-gray-300" :
                          i === 2 ? "bg-amber-700/20 text-amber-500" :
                          "text-gray-500"
                        }`}>
                          {entry.rank}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`font-mono text-sm ${isUser ? "text-brand-400 font-semibold" : "text-gray-300"}`}>
                          {isUser ? `${shortenAddr(entry.address)} (you)` : shortenAddr(entry.address)}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <span className="text-sm font-semibold text-white">{formatNumber(entry.points)}</span>
                      </td>
                    </tr>
                  );
                })}
                {leaderboard.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-6 py-12 text-center text-sm text-gray-500">
                      No leaderboard data yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* ════════════ TAB: CALCULATOR ════════════ */}
      {activeTab === "calculator" && apyData && (
        <div className="space-y-8">
          <Section title="Implied APY" subtitle="Estimated returns from MNTD airdrop">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard
                label="Implied APY"
                value={`${apyData.impliedAPY.toFixed(1)}%`}
                color="green"
                variant="glow"
              />
              <StatCard
                label="MNTD Token Price"
                value={`$${apyData.assumptions.tokenPrice.toFixed(2)}`}
                color="blue"
              />
              <StatCard
                label="Total Airdrop Value"
                value={`$${formatNumber(apyData.assumptions.totalValueOfAirdrop)}`}
                color="purple"
              />
            </div>
          </Section>

          <Section title="Scenarios" subtitle="How much can you earn?">
            <div className="card overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/5 text-left text-xs uppercase text-gray-500">
                    <th className="px-6 py-4">Scenario</th>
                    <th className="px-6 py-4 text-right">Deposit</th>
                    <th className="px-6 py-4 text-right">Est. Points</th>
                    <th className="px-6 py-4 text-right">Token Allocation</th>
                    <th className="px-6 py-4 text-right">Value</th>
                    <th className="px-6 py-4 text-right">APY</th>
                  </tr>
                </thead>
                <tbody>
                  {apyData.scenarios.map((s) => (
                    <tr key={s.label} className="border-b border-white/5 hover:bg-white/[0.02]">
                      <td className="px-6 py-4 text-sm font-medium text-gray-200">{s.label}</td>
                      <td className="px-6 py-4 text-right text-sm text-gray-400">${formatNumber(s.depositUsd)}</td>
                      <td className="px-6 py-4 text-right text-sm text-gray-400">{formatNumber(s.estimatedPoints)}</td>
                      <td className="px-6 py-4 text-right text-sm text-gray-400">{formatNumber(s.tokenAllocation)}</td>
                      <td className="px-6 py-4 text-right text-sm font-semibold text-emerald-400">${formatNumber(s.tokenValue)}</td>
                      <td className="px-6 py-4 text-right text-sm font-bold text-brand-400">{s.apy.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          {/* Multiplier Reference */}
          <Section title="Multiplier Schedule" subtitle="Points multipliers by action and season">
            <div className="card p-6">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {Object.entries(ACTION_LABELS).map(([key, label]) => (
                  <div key={key} className="flex items-center justify-between rounded-lg bg-surface-800/50 px-4 py-3">
                    <span className="text-sm text-gray-300">{label}</span>
                    <div className="flex items-center gap-2">
                      <span className={`rounded px-2 py-0.5 text-xs font-bold ${
                        key.startsWith("ETH") ? "bg-brand-500/20 text-brand-400" : "bg-emerald-500/20 text-emerald-400"
                      }`}>
                        {key.startsWith("ETH") ? "ETH" : "CTN"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Section>
        </div>
      )}
    </div>
  );
}
