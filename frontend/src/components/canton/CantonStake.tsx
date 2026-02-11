import React, { useState, useEffect, useCallback } from "react";
import { StatCard } from "@/components/StatCard";
import { useLoopWallet, LoopContract } from "@/hooks/useLoopWallet";
import WalletConnector from "@/components/WalletConnector";

// DAML template IDs
const PACKAGE_ID = process.env.NEXT_PUBLIC_DAML_PACKAGE_ID || "";
const templates = {
  StakingService: `${PACKAGE_ID}:MintedProtocolV2Fixed:StakingService`,
  MUSD: `${PACKAGE_ID}:MintedProtocolV2Fixed:MUSD`,
};

export function CantonStake() {
  const loopWallet = useLoopWallet();
  
  const [tab, setTab] = useState<"stake" | "unstake">("stake");
  const [amount, setAmount] = useState("");
  const [musdContractId, setMusdContractId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Canton Coin staking
  const [cantonCoinTab, setCantonCoinTab] = useState<"stake" | "unstake">("stake");
  const [cantonCoinAmount, setCantonCoinAmount] = useState("");
  const [cantonCoinLoading, setCantonCoinLoading] = useState(false);

  const [services, setServices] = useState<LoopContract[]>([]);
  const [musdContracts, setMusdContracts] = useState<LoopContract[]>([]);
  const [stakingInfo, setStakingInfo] = useState<any>(null);

  const loadContracts = useCallback(async () => {
    if (!loopWallet.isConnected) return;
    try {
      const [svc, musd] = await Promise.all([
        loopWallet.queryContracts(templates.StakingService).catch(() => []),
        loopWallet.queryContracts(templates.MUSD).catch(() => []),
      ]);
      setServices(svc);
      setMusdContracts(musd);
      if (svc.length > 0) {
        setServiceId(svc[0].contractId);
        setStakingInfo(svc[0].payload);
      }
      if (musd.length > 0) setMusdContractId(musd[0].contractId);
    } catch (err) {
      console.error("Failed to load contracts:", err);
    }
  }, [loopWallet.isConnected, loopWallet.queryContracts]);

  useEffect(() => {
    loadContracts();
  }, [loadContracts]);

  const totalMusd = musdContracts.reduce(
    (sum, c) => sum + parseFloat(c.payload?.amount || "0"), 0
  );

  async function handleStake() {
    if (!serviceId || !musdContractId) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      await loopWallet.exerciseChoice(
        templates.StakingService,
        serviceId,
        "Stake",
        { musdCid: musdContractId, amount }
      );
      setResult(`Staked ${amount} mUSD for smUSD on Canton`);
      setAmount("");
      await loadContracts();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleUnstake() {
    if (!serviceId) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      await loopWallet.exerciseChoice(
        templates.StakingService,
        serviceId,
        "Unstake",
        { amount }
      );
      setResult(`Unstaked ${amount} smUSD on Canton`);
      setAmount("");
      await loadContracts();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (!loopWallet.isConnected) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="max-w-md space-y-6">
          <div className="text-center">
            <h3 className="mb-2 text-xl font-semibold text-white">Connect to Canton</h3>
            <p className="text-gray-400 mb-6">Connect your Loop Wallet to stake mUSD on Canton.</p>
          </div>
          <WalletConnector mode="canton" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-white">Stake mUSD</h1>
        <p className="text-amber-400 text-sm font-medium mt-1">Canton Network (Daml Ledger)</p>
      </div>

      {/* Key Stats */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Total Staked"
          value={stakingInfo?.totalStaked ? parseFloat(stakingInfo.totalStaked).toFixed(2) + " mUSD" : "0 mUSD"}
          color="blue"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          }
        />
        <StatCard
          label="Current APY"
          value={stakingInfo?.annualRateBps ? `${(Number(stakingInfo.annualRateBps) / 100).toFixed(2)}%` : "..."}
          color="green"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
          }
        />
        <StatCard
          label="Minted Points Earned"
          value="0"
          subValue="Season 1"
          color="purple"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
            </svg>
          }
        />
      </div>

      {/* mUSD Stake/Unstake Widget */}
      <div className="card-gradient-border overflow-hidden border-amber-500/20">
        {/* Tabs */}
        <div className="flex border-b border-white/10">
          <button
            className={`relative flex-1 px-6 py-4 text-center text-sm font-semibold transition-all duration-300 ${
              tab === "stake" ? "text-white" : "text-gray-400 hover:text-white"
            }`}
            onClick={() => { setTab("stake"); setAmount(""); setError(null); setResult(null); }}
          >
            <span className="relative z-10 flex items-center justify-center gap-2">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
              </svg>
              Stake mUSD
            </span>
            {tab === "stake" && (
              <span className="absolute bottom-0 left-1/2 h-0.5 w-24 -translate-x-1/2 rounded-full bg-gradient-to-r from-amber-500 to-yellow-500" />
            )}
          </button>
          <button
            className={`relative flex-1 px-6 py-4 text-center text-sm font-semibold transition-all duration-300 ${
              tab === "unstake" ? "text-white" : "text-gray-400 hover:text-white"
            }`}
            onClick={() => { setTab("unstake"); setAmount(""); setError(null); setResult(null); }}
          >
            <span className="relative z-10 flex items-center justify-center gap-2">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Unstake smUSD
            </span>
            {tab === "unstake" && (
              <span className="absolute bottom-0 left-1/2 h-0.5 w-24 -translate-x-1/2 rounded-full bg-gradient-to-r from-amber-500 to-yellow-500" />
            )}
          </button>
        </div>

        {/* Form Content */}
        <div className="space-y-6 p-6">
          {/* Balance */}
          <div className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
            <p className="text-sm text-gray-400 mb-1">Your mUSD Balance (Canton)</p>
            <p className="text-xl font-bold text-white">{totalMusd.toFixed(2)}</p>
          </div>

          {/* mUSD Contract Selector (stake only) */}
          {tab === "stake" && musdContracts.length > 0 && (
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-400">mUSD Contract</label>
              <select
                className="input"
                value={musdContractId}
                onChange={(e) => setMusdContractId(e.target.value)}
              >
                {musdContracts.map((c) => (
                  <option key={c.contractId} value={c.contractId}>
                    {c.payload?.amount || "?"} mUSD - {c.contractId.slice(0, 16)}...
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Amount Input */}
          <div className="space-y-3">
            <label className="text-sm font-medium text-gray-400">
              {tab === "stake" ? "mUSD Amount" : "smUSD Amount"}
            </label>
            <div className="relative rounded-xl border border-white/10 bg-surface-800/50 p-4 transition-all duration-300 focus-within:border-amber-500/50 focus-within:shadow-[0_0_20px_-5px_rgba(245,158,11,0.3)]">
              <div className="flex items-center gap-4">
                <input
                  type="number"
                  className="flex-1 bg-transparent text-2xl font-semibold text-white placeholder-gray-600 focus:outline-none"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <div className="flex items-center gap-2 rounded-full bg-surface-700/50 px-3 py-1.5">
                  <div className={`h-6 w-6 rounded-full ${tab === "stake" ? "bg-gradient-to-br from-brand-500 to-purple-500" : "bg-gradient-to-br from-amber-500 to-yellow-500"}`} />
                  <span className="font-semibold text-white">{tab === "stake" ? "mUSD" : "smUSD"}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Action Button */}
          <button
            onClick={tab === "stake" ? handleStake : handleUnstake}
            disabled={loading || !amount || parseFloat(amount) <= 0}
            className="btn-primary w-full"
          >
            {loading ? "Processing on Canton..." : tab === "stake" ? "Stake mUSD → Receive smUSD" : "Unstake smUSD"}
          </button>

          {error && <p className="text-sm text-red-400">{error}</p>}
          {result && <p className="text-sm text-green-400">{result}</p>}
        </div>
      </div>

      {/* Canton Coin Staking Widget — Canton ONLY */}
      <div className="card border-2 border-amber-500/30 bg-gradient-to-br from-amber-900/10 to-yellow-900/10">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-amber-500 to-yellow-500">
            <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
            </svg>
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">Stake Canton Coin</h2>
            <span className="rounded-full bg-amber-500/20 px-3 py-1 text-xs font-semibold text-amber-400">Canton Only — Boost Pool</span>
          </div>
        </div>

        {/* Canton Coin Explainer */}
        <div className="rounded-xl bg-amber-900/20 border border-amber-500/20 p-4 mb-6">
          <p className="text-sm text-amber-200/90 leading-relaxed">
            Stake <span className="font-semibold text-amber-100">20% of your mUSD stake</span> in Canton Coin to receive{" "}
            <span className="font-semibold text-amber-100">boosted yield of 2-4%</span> PLUS{" "}
            <span className="font-semibold text-amber-100">60% of all validator rewards</span> mUSD generates.
            You&apos;ll also earn exclusive <span className="font-semibold text-amber-100">Minted Points</span> which
            earn you an airdrop for the <span className="font-semibold text-amber-100">$MINT TGE</span>.
          </p>
        </div>

        {/* Boost Pool Stats */}
        <div className="grid gap-4 sm:grid-cols-3 mb-6">
          <StatCard label="Boost Pool APY" value="2-4%" color="green" />
          <StatCard label="Validator Rewards" value="60% share" color="green" />
          <StatCard label="Points Multiplier" value="10×" subValue="Season 1" color="purple" />
        </div>

        {/* Canton Coin Tabs */}
        <div className="flex border-b border-amber-500/20 mb-4">
          <button
            className={`flex-1 py-3 text-sm font-semibold ${cantonCoinTab === "stake" ? "text-amber-400 border-b-2 border-amber-400" : "text-gray-400"}`}
            onClick={() => setCantonCoinTab("stake")}
          >
            Stake Canton Coin
          </button>
          <button
            className={`flex-1 py-3 text-sm font-semibold ${cantonCoinTab === "unstake" ? "text-amber-400 border-b-2 border-amber-400" : "text-gray-400"}`}
            onClick={() => setCantonCoinTab("unstake")}
          >
            Unstake Canton Coin
          </button>
        </div>

        {/* Canton Coin Input */}
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-400">Canton Coin Amount</label>
            <div className="relative rounded-xl border border-amber-500/20 bg-surface-800/50 p-4">
              <div className="flex items-center gap-4">
                <input
                  type="number"
                  className="flex-1 bg-transparent text-2xl font-semibold text-white placeholder-gray-600 focus:outline-none"
                  placeholder="0.00"
                  value={cantonCoinAmount}
                  onChange={(e) => setCantonCoinAmount(e.target.value)}
                  disabled
                />
                <div className="flex items-center gap-2 rounded-full bg-amber-500/10 px-3 py-1.5">
                  <div className="h-6 w-6 rounded-full bg-gradient-to-br from-amber-500 to-yellow-500" />
                  <span className="font-semibold text-amber-400">CTN</span>
                </div>
              </div>
            </div>
          </div>

          <button
            disabled
            className="w-full rounded-xl bg-amber-500/20 py-4 text-amber-400 font-semibold opacity-60 cursor-not-allowed"
          >
            {cantonCoinTab === "stake" ? "Stake Canton Coin" : "Unstake Canton Coin"} (Coming Soon)
          </button>
          <p className="text-xs text-gray-500 text-center">Canton Coin staking activates when the Boost Pool launches.</p>
        </div>
      </div>

      {/* AI Yield Aggregation Engine — How It Works */}
      <div className="card">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/20">
            <svg className="h-5 w-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">How It Works</h2>
            <p className="text-sm text-gray-400">AI Yield Aggregation Engine</p>
          </div>
        </div>
        <div className="space-y-4 text-sm text-gray-300 leading-relaxed">
          <p>
            Staking distributes generated yield exclusively to mUSD stakers, using our AI yield aggregation engine.
            The AI deliberates across 100&apos;s of protocols in Web3 using a proprietary algorithm, taking into
            consideration many different variables: <span className="text-white font-medium">Highest Yield</span>,{" "}
            <span className="text-white font-medium">Pool Liquidity</span>,{" "}
            <span className="text-white font-medium">Weighted Performance over time</span>,{" "}
            <span className="text-white font-medium">Security/Risk Profile</span>,{" "}
            <span className="text-white font-medium">Oracle Stability</span>,{" "}
            <span className="text-white font-medium">Curators</span>, and more.
          </p>
          <p>
            It then carefully deploys and monitors positions in real time.
          </p>
          <p className="text-gray-400 italic">
            Note* This does NOT mean TVL is distributed across 100&apos;s of platforms, it means pools are scrutinized,
            and selected based on intuitively safe, asymmetrical upside. That could mean 5 protocols or less.
          </p>
        </div>
      </div>

      {/* Unstaking Info */}
      <div className="card">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-purple-500/20">
            <svg className="h-5 w-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-white">Unstaking</h2>
        </div>
        <p className="text-sm text-gray-300 leading-relaxed">
          Upon unstaking, smUSD tokens are burned and users receive back their proportional share of mUSD with appreciated
          yield included. The protocol enforces a <span className="text-white font-medium">10-day cooldown period</span> before
          withdrawals can be executed.
        </p>
      </div>
    </div>
  );
}

export default CantonStake;
