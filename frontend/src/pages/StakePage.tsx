import React, { useState, useEffect } from "react";
import { ethers } from "ethers";
import { TxButton } from "@/components/TxButton";
import { StatCard } from "@/components/StatCard";
import { PageHeader } from "@/components/PageHeader";
import { useTx } from "@/hooks/useTx";
import { formatToken, formatUSD } from "@/lib/format";
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

  const cooldownSeconds = Number(stats.cooldownRemaining);
  const cooldownHours = cooldownSeconds / 3600;
  const cooldownPct = Math.max(0, Math.min(100, ((86400 - cooldownSeconds) / 86400) * 100));

  // Estimate APY from exchange rate drift
  const sharePrice = stats.totalSupply > 0n
    ? Number(stats.totalAssets) / Number(stats.totalSupply)
    : 1;
  const estimatedApy = Math.max(0, (sharePrice - 1) * 100);

  // User's position value in mUSD
  const positionValue = stats.smusdBal > 0n && stats.totalSupply > 0n
    ? (stats.smusdBal * stats.totalAssets) / stats.totalSupply
    : 0n;
  const yieldEarned = positionValue > stats.smusdBal ? positionValue - stats.smusdBal : 0n;

  if (!isConnected) {
    return <WalletConnector mode="ethereum" />;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <PageHeader
        title="Stake & Earn"
        subtitle="Stake mUSD into the ERC-4626 vault to receive smUSD and earn protocol yield"
        badge="ERC-4626"
        badgeColor="emerald"
      />

      {/* Yield Overview Dashboard */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Share Price"
          value={`${exchangeRate} mUSD`}
          subValue="per smUSD"
          color="green"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
          }
        />
        <StatCard
          label="Estimated APY"
          value={`${estimatedApy.toFixed(2)}%`}
          color="green"
          trend={estimatedApy > 0 ? "up" : "neutral"}
          trendValue={estimatedApy > 0 ? "Earning" : "Base"}
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
        <StatCard
          label="Total Vault TVL"
          value={formatToken(stats.totalAssets) + " mUSD"}
          color="blue"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          }
        />
        <StatCard
          label="Total smUSD"
          value={formatToken(stats.totalSupply)}
          color="purple"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
            </svg>
          }
        />
      </div>

      {/* Your Position Card */}
      {stats.smusdBal > 0n && (
        <div className="card-gradient-border overflow-hidden">
          <div className="flex items-center gap-3 mb-5">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500 to-teal-500">
              <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 8v8m-4-5v5m-4-2v2m-2 4h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">Your Position</h2>
              <p className="text-sm text-gray-400">Staking performance overview</p>
            </div>
          </div>

          <div className="grid gap-6 sm:grid-cols-3">
            <div className="space-y-1">
              <p className="text-sm text-gray-400">smUSD Balance</p>
              <p className="text-2xl font-bold text-white">{formatToken(stats.smusdBal)}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-gray-400">Position Value</p>
              <p className="text-2xl font-bold text-emerald-400">{formatToken(positionValue)} mUSD</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-gray-400">Yield Earned</p>
              <p className="text-2xl font-bold text-green-400">+{formatToken(yieldEarned)} mUSD</p>
            </div>
          </div>
        </div>
      )}

      {/* Cooldown Timer */}
      {!stats.canWithdraw && stats.cooldownRemaining > 0n && (
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-yellow-500/20">
                <svg className="h-5 w-5 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div>
                <p className="font-medium text-white">Withdrawal Cooldown</p>
                <p className="text-sm text-gray-400">
                  {cooldownHours >= 1
                    ? `${cooldownHours.toFixed(1)} hours remaining`
                    : `${Math.ceil(cooldownSeconds / 60)} minutes remaining`}
                </p>
              </div>
            </div>
            <span className="badge-warning">{Math.round(cooldownPct)}% Complete</span>
          </div>
          <div className="progress">
            <div
              className="progress-bar-emerald h-full rounded-full transition-all duration-1000"
              style={{ width: `${cooldownPct}%` }}
            />
          </div>
        </div>
      )}

      {/* Balance Cards */}
      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard
          label="Your mUSD Balance"
          value={formatToken(stats.musdBal)}
          color="blue"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
        <StatCard
          label="Your smUSD Balance"
          value={formatToken(stats.smusdBal)}
          color="purple"
          subValue={stats.smusdBal > 0n ? `≈ ${formatToken(positionValue)} mUSD` : undefined}
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
            </svg>
          }
        />
      </div>

      {/* Main Action Card */}
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
                <span className="text-gray-300">24 hours</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-400">Withdrawal Fee</span>
                <span className="text-emerald-400 font-medium">None</span>
              </div>
            </div>
          )}

          {/* Unstake Warning */}
          {tab === "unstake" && !stats.canWithdraw && stats.cooldownRemaining > 0n && (
            <div className="alert-warning flex items-center gap-3">
              <svg className="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-sm">Cooldown active — {cooldownHours.toFixed(1)}h remaining before you can withdraw.</span>
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
                  Stake mUSD
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

      {/* How Staking Works */}
      <div className="card">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-500/20">
            <svg className="h-5 w-5 text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-white">How Staking Works</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-500/20 text-brand-400 font-bold text-sm mb-3">1</div>
            <h3 className="font-medium text-white mb-1">Deposit mUSD</h3>
            <p className="text-sm text-gray-400">Stake your mUSD tokens into the ERC-4626 vault to begin earning yield.</p>
          </div>
          <div className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400 font-bold text-sm mb-3">2</div>
            <h3 className="font-medium text-white mb-1">Earn Yield</h3>
            <p className="text-sm text-gray-400">The smUSD share price increases as protocol revenue accrues to the vault.</p>
          </div>
          <div className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-500/20 text-purple-400 font-bold text-sm mb-3">3</div>
            <h3 className="font-medium text-white mb-1">Withdraw Anytime</h3>
            <p className="text-sm text-gray-400">Redeem smUSD for mUSD at the current share price after a 24h cooldown.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default StakePage;
