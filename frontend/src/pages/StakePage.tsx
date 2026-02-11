import React, { useState, useEffect } from "react";
import { ethers } from "ethers";
import { TxButton } from "@/components/TxButton";
import { StatCard } from "@/components/StatCard";
import { PageHeader } from "@/components/PageHeader";
import { useTx } from "@/hooks/useTx";
import { formatToken } from "@/lib/format";
import { CONTRACTS, MUSD_DECIMALS } from "@/lib/config";
import { useWalletConnect } from "@/hooks/useWalletConnect";
import { useWCContracts } from "@/hooks/useWCContracts";
import WalletConnector from "@/components/WalletConnector";

export function StakePage() {
  const { address, isConnected } = useWalletConnect();
  const contracts = useWCContracts();
  const [tab, setTab] = useState<"stake" | "unstake">("stake");
  const [amount, setAmount] = useState("");
  const [stats, setStats] = useState({
    musdBal: 0n,
    smusdBal: 0n,
    totalAssets: 0n,
    totalSupply: 0n,
    canWithdraw: false,
    cooldownRemaining: 0n,
    previewDeposit: 0n,
    previewRedeem: 0n,
  });
  const tx = useTx();
  const { musd, smusd } = contracts;

  useEffect(() => {
    async function load() {
      if (!smusd || !musd || !address) return;
      const [musdBal, smusdBal, totalAssets, totalSupply, canWithdraw, cooldownRemaining] = await Promise.all([
        musd.balanceOf(address),
        smusd.balanceOf(address),
        smusd.totalAssets(),
        smusd.totalSupply(),
        smusd.canWithdraw(address),
        smusd.getRemainingCooldown(address),
      ]);
      setStats((s) => ({ ...s, musdBal, smusdBal, totalAssets, totalSupply, canWithdraw, cooldownRemaining }));
    }
    load();
  }, [musd, smusd, address, tx.success]);

  useEffect(() => {
    async function loadPreview() {
      if (!smusd || !amount || parseFloat(amount) <= 0) {
        setStats((s) => ({ ...s, previewDeposit: 0n, previewRedeem: 0n }));
        return;
      }
      try {
        const parsed = ethers.parseUnits(amount, MUSD_DECIMALS);
        if (tab === "stake") {
          const shares = await smusd.previewDeposit(parsed);
          setStats((s) => ({ ...s, previewDeposit: shares }));
        } else {
          const assets = await smusd.previewRedeem(parsed);
          setStats((s) => ({ ...s, previewRedeem: assets }));
        }
      } catch {}
    }
    const timer = setTimeout(loadPreview, 300);
    return () => clearTimeout(timer);
  }, [smusd, amount, tab]);

  async function handleStake() {
    if (!smusd || !musd || !address) return;
    const parsed = ethers.parseUnits(amount, MUSD_DECIMALS);
    await tx.send(async () => {
      const allowance = await musd.allowance(address, CONTRACTS.SMUSD);
      if (allowance < parsed) {
        const approveTx = await musd.approve(CONTRACTS.SMUSD, parsed);
        await approveTx.wait();
      }
      return smusd.deposit(parsed, address);
    });
    setAmount("");
  }

  async function handleUnstake() {
    if (!smusd || !address) return;
    const parsed = ethers.parseUnits(amount, MUSD_DECIMALS);
    await tx.send(() => smusd.redeem(parsed, address, address));
    setAmount("");
  }

  const exchangeRate =
    stats.totalSupply > 0n
      ? (Number(stats.totalAssets) / Number(stats.totalSupply)).toFixed(4)
      : "1.0000";

  // 10-day cooldown = 864000 seconds
  const COOLDOWN_DURATION = 864000;
  const cooldownSeconds = Number(stats.cooldownRemaining);
  const cooldownDays = cooldownSeconds / 86400;
  const cooldownPct = Math.max(0, Math.min(100, ((COOLDOWN_DURATION - cooldownSeconds) / COOLDOWN_DURATION) * 100));

  // Estimate APY from exchange rate drift
  const sharePrice = stats.totalSupply > 0n
    ? Number(stats.totalAssets) / Number(stats.totalSupply)
    : 1;
  const estimatedApy = Math.max(0, (sharePrice - 1) * 100);

  if (!isConnected) {
    return <WalletConnector mode="ethereum" />;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <PageHeader
        title="Stake mUSD"
        subtitle="Stake mUSD to receive smUSD and earn AI-optimized yield"
        badge="ERC-4626"
        badgeColor="emerald"
      />

      {/* Key Stats */}
      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard
          label="Total Staked"
          value={formatToken(stats.totalAssets) + " mUSD"}
          color="blue"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          }
        />
        <StatCard
          label="Current APY"
          value={`${estimatedApy.toFixed(2)}%`}
          color="green"
          trend={estimatedApy > 0 ? "up" : "neutral"}
          trendValue={estimatedApy > 0 ? "Earning" : "Base"}
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
          }
        />
      </div>

      {/* Stake/Unstake Widget */}
      <div className="card-gradient-border overflow-hidden">
        {/* Tabs */}
        <div className="flex border-b border-white/10">
          <button
            className={`relative flex-1 px-6 py-4 text-center text-sm font-semibold transition-all duration-300 ${
              tab === "stake" ? "text-white" : "text-gray-400 hover:text-white"
            }`}
            onClick={() => { setTab("stake"); setAmount(""); }}
          >
            <span className="relative z-10 flex items-center justify-center gap-2">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
              </svg>
              Stake mUSD
            </span>
            {tab === "stake" && (
              <span className="absolute bottom-0 left-1/2 h-0.5 w-24 -translate-x-1/2 rounded-full bg-gradient-to-r from-emerald-500 to-teal-500" />
            )}
          </button>
          <button
            className={`relative flex-1 px-6 py-4 text-center text-sm font-semibold transition-all duration-300 ${
              tab === "unstake" ? "text-white" : "text-gray-400 hover:text-white"
            }`}
            onClick={() => { setTab("unstake"); setAmount(""); }}
          >
            <span className="relative z-10 flex items-center justify-center gap-2">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Unstake smUSD
            </span>
            {tab === "unstake" && (
              <span className="absolute bottom-0 left-1/2 h-0.5 w-24 -translate-x-1/2 rounded-full bg-gradient-to-r from-emerald-500 to-teal-500" />
            )}
          </button>
        </div>

        {/* Form Content */}
        <div className="space-y-6 p-6">
          {/* Balance Cards */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
              <p className="text-sm text-gray-400 mb-1">Your mUSD Balance</p>
              <p className="text-xl font-bold text-white">{formatToken(stats.musdBal)}</p>
            </div>
            <div className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
              <p className="text-sm text-gray-400 mb-1">Your smUSD Balance</p>
              <p className="text-xl font-bold text-emerald-400">{formatToken(stats.smusdBal)}</p>
            </div>
          </div>

          {/* Input */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-gray-400">
                {tab === "stake" ? "You Stake" : "You Unstake"}
              </label>
              <span className="text-xs text-gray-500">
                Balance: {formatToken(tab === "stake" ? stats.musdBal : stats.smusdBal)}
              </span>
            </div>
            <div className="relative rounded-xl border border-white/10 bg-surface-800/50 p-4 transition-all duration-300 focus-within:border-emerald-500/50 focus-within:shadow-[0_0_20px_-5px_rgba(16,185,129,0.3)]">
              <div className="flex items-center gap-4">
                <input
                  type="number"
                  className="flex-1 bg-transparent text-2xl font-semibold text-white placeholder-gray-600 focus:outline-none"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <div className="flex items-center gap-2">
                  <button
                    className="rounded-lg bg-emerald-500/20 px-3 py-1.5 text-xs font-semibold text-emerald-400 transition-colors hover:bg-emerald-500/30"
                    onClick={() =>
                      setAmount(
                        ethers.formatUnits(tab === "stake" ? stats.musdBal : stats.smusdBal, MUSD_DECIMALS)
                      )
                    }
                  >
                    MAX
                  </button>
                  <div className="flex items-center gap-2 rounded-full bg-surface-700/50 px-3 py-1.5">
                    <div className={`h-6 w-6 rounded-full ${tab === "stake" ? "bg-gradient-to-br from-brand-500 to-purple-500" : "bg-gradient-to-br from-emerald-500 to-teal-500"}`} />
                    <span className="font-semibold text-white">{tab === "stake" ? "mUSD" : "smUSD"}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Arrow */}
          <div className="flex justify-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-surface-800">
              <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
              </svg>
            </div>
          </div>

          {/* Output Preview */}
          <div className="space-y-3">
            <label className="text-sm font-medium text-gray-400">You Receive</label>
            <div className="rounded-xl border border-white/10 bg-surface-800/30 p-4">
              <div className="flex items-center justify-between">
                <span className="text-2xl font-semibold text-white">
                  {amount && parseFloat(amount) > 0
                    ? (tab === "stake"
                      ? formatToken(stats.previewDeposit)
                      : formatToken(stats.previewRedeem))
                    : "0.00"}
                </span>
                <div className="flex items-center gap-2 rounded-full bg-surface-700/50 px-3 py-1.5">
                  <div className={`h-6 w-6 rounded-full ${tab === "stake" ? "bg-gradient-to-br from-emerald-500 to-teal-500" : "bg-gradient-to-br from-brand-500 to-purple-500"}`} />
                  <span className="font-semibold text-white">{tab === "stake" ? "smUSD" : "mUSD"}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Exchange Info */}
          {amount && parseFloat(amount) > 0 && (
            <div className="space-y-2 rounded-xl bg-surface-800/30 p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-400">Exchange Rate</span>
                <span className="font-medium text-white">1 smUSD = {exchangeRate} mUSD</span>
              </div>
              <div className="divider my-2" />
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-400">Cooldown Period</span>
                <span className="text-gray-300">10 days</span>
              </div>
            </div>
          )}

          {/* Unstake Cooldown Warning */}
          {tab === "unstake" && !stats.canWithdraw && stats.cooldownRemaining > 0n && (
            <div className="alert-warning flex items-center gap-3">
              <svg className="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-sm">Cooldown active — {cooldownDays.toFixed(1)} days remaining before you can withdraw.</span>
            </div>
          )}

          {/* Cooldown Progress */}
          {!stats.canWithdraw && stats.cooldownRemaining > 0n && (
            <div className="rounded-xl bg-surface-800/30 p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <svg className="h-5 w-5 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className="font-medium text-white">10-Day Cooldown</span>
                </div>
                <span className="text-sm text-gray-400">{Math.round(cooldownPct)}% Complete</span>
              </div>
              <div className="progress">
                <div
                  className="progress-bar-emerald h-full rounded-full transition-all duration-1000"
                  style={{ width: `${cooldownPct}%` }}
                />
              </div>
            </div>
          )}

          {/* Action Button */}
          <TxButton
            onClick={tab === "stake" ? handleStake : handleUnstake}
            loading={tx.loading}
            disabled={
              !amount ||
              parseFloat(amount) <= 0 ||
              (tab === "unstake" && !stats.canWithdraw)
            }
            className="w-full"
          >
            <span className="flex items-center justify-center gap-2">
              {tab === "stake" ? (
                <>
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                  </svg>
                  Stake mUSD → Receive smUSD
                </>
              ) : (
                <>
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  {stats.canWithdraw ? "Unstake smUSD" : "Cooldown Active"}
                </>
              )}
            </span>
          </TxButton>

          {/* Transaction Status */}
          {tx.error && (
            <div className="alert-error flex items-center gap-3">
              <svg className="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-sm">{tx.error}</span>
            </div>
          )}
          {tx.success && (
            <div className="alert-success flex items-center gap-3">
              <svg className="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-sm">
                Transaction confirmed! {tx.hash && (
                  <a href={`https://etherscan.io/tx/${tx.hash}`} target="_blank" rel="noopener noreferrer" className="underline">
                    View on Etherscan
                  </a>
                )}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* AI Yield Aggregation Engine — How It Works */}
      <div className="card">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/20">
            <svg className="h-5 w-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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

export default StakePage;
