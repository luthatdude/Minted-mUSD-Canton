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

type VaultType = "ybBTC" | "ybETH";

interface VaultStats {
  musdBal: bigint;
  sharesBal: bigint;
  totalAssets: bigint;
  totalSupply: bigint;
  canWithdraw: boolean;
  cooldownRemaining: bigint;
  previewDeposit: bigint;
  previewRedeem: bigint;
  currentAPY: bigint;
  currentUtilization: bigint;
}

const VAULT_INFO: Record<VaultType, { name: string; symbol: string; color: string; icon: string; description: string }> = {
  ybBTC: {
    name: "Yield Basis BTC",
    symbol: "ybBTC",
    color: "orange",
    icon: "₿",
    description: "Earn yield from BTC/USDC market-making via Yield Basis protocol",
  },
  ybETH: {
    name: "Yield Basis ETH",
    symbol: "ybETH",
    color: "blue",
    icon: "Ξ",
    description: "Earn yield from ETH/USDC market-making via Yield Basis protocol",
  },
};

export function YBStakePage() {
  const { address, isConnected } = useWalletConnect();
  const contracts = useWCContracts();
  const [activeVault, setActiveVault] = useState<VaultType>("ybBTC");
  const [tab, setTab] = useState<"stake" | "unstake">("stake");
  const [amount, setAmount] = useState("");
  const [btcStats, setBtcStats] = useState<VaultStats>(defaultStats());
  const [ethStats, setEthStats] = useState<VaultStats>(defaultStats());
  const tx = useTx();

  const stats = activeVault === "ybBTC" ? btcStats : ethStats;
  const info = VAULT_INFO[activeVault];

  function defaultStats(): VaultStats {
    return {
      musdBal: 0n, sharesBal: 0n, totalAssets: 0n, totalSupply: 0n,
      canWithdraw: false, cooldownRemaining: 0n, previewDeposit: 0n,
      previewRedeem: 0n, currentAPY: 0n, currentUtilization: 0n,
    };
  }

  useEffect(() => {
    async function loadStats() {
      if (!address) return;
      const { musd, ybBTC, ybETH } = contracts;
      if (!musd) return;

      const musdBal = await musd.balanceOf(address);

      for (const [vault, setFn] of [[ybBTC, setBtcStats], [ybETH, setEthStats]] as const) {
        if (!vault) continue;
        try {
          const [sharesBal, totalAssets, totalSupply, canWithdraw, cooldownRemaining, currentAPY, currentUtilization] =
            await Promise.all([
              vault.balanceOf(address),
              vault.totalAssets(),
              vault.totalSupply(),
              vault.canWithdraw(address),
              vault.getRemainingCooldown(address),
              vault.currentAPY(),
              vault.currentUtilization(),
            ]);
          (setFn as any)((s: VaultStats) => ({
            ...s, musdBal, sharesBal, totalAssets, totalSupply, canWithdraw,
            cooldownRemaining, currentAPY, currentUtilization,
          }));
        } catch {
          (setFn as any)((s: VaultStats) => ({ ...s, musdBal }));
        }
      }
    }
    loadStats();
  }, [contracts, address, tx.success]);

  useEffect(() => {
    async function preview() {
      const vault = activeVault === "ybBTC" ? contracts.ybBTC : contracts.ybETH;
      const setFn = activeVault === "ybBTC" ? setBtcStats : setEthStats;
      if (!vault || !amount || parseFloat(amount) <= 0) {
        (setFn as any)((s: VaultStats) => ({ ...s, previewDeposit: 0n, previewRedeem: 0n }));
        return;
      }
      try {
        const parsed = ethers.parseUnits(amount, MUSD_DECIMALS);
        if (tab === "stake") {
          const shares = await vault.previewDeposit(parsed);
          (setFn as any)((s: VaultStats) => ({ ...s, previewDeposit: shares }));
        } else {
          const assets = await vault.previewRedeem(parsed);
          (setFn as any)((s: VaultStats) => ({ ...s, previewRedeem: assets }));
        }
      } catch {}
    }
    const timer = setTimeout(preview, 300);
    return () => clearTimeout(timer);
  }, [contracts, amount, tab, activeVault]);

  const vaultAddress = activeVault === "ybBTC" ? CONTRACTS.YB_BTC : CONTRACTS.YB_ETH;

  async function handleStake() {
    const vault = activeVault === "ybBTC" ? contracts.ybBTC : contracts.ybETH;
    if (!vault || !contracts.musd || !address) return;
    const parsed = ethers.parseUnits(amount, MUSD_DECIMALS);
    await tx.send(async () => {
      const allowance = await contracts.musd!.allowance(address, vaultAddress);
      if (allowance < parsed) {
        const approveTx = await contracts.musd!.approve(vaultAddress, parsed);
        await approveTx.wait();
      }
      return vault.deposit(parsed, address);
    });
    setAmount("");
  }

  async function handleUnstake() {
    const vault = activeVault === "ybBTC" ? contracts.ybBTC : contracts.ybETH;
    if (!vault || !address) return;
    const parsed = ethers.parseUnits(amount, MUSD_DECIMALS);
    await tx.send(() => vault.redeem(parsed, address, address));
    setAmount("");
  }

  const exchangeRate = stats.totalSupply > 0n
    ? (Number(stats.totalAssets) / Number(stats.totalSupply)).toFixed(4)
    : "1.0000";

  const apyDisplay = stats.currentAPY > 0n
    ? (Number(stats.currentAPY) / 1e16).toFixed(2) // 1e18 = 100%, so /1e16 = %
    : "—";

  const utilDisplay = stats.currentUtilization > 0n
    ? (Number(stats.currentUtilization) / 100).toFixed(1) // bps to %
    : "0.0";

  const cooldownSeconds = Number(stats.cooldownRemaining);
  const cooldownHours = cooldownSeconds / 3600;
  const cooldownPct = Math.max(0, Math.min(100, ((86400 - cooldownSeconds) / 86400) * 100));

  const positionValue = stats.sharesBal > 0n && stats.totalSupply > 0n
    ? (stats.sharesBal * stats.totalAssets) / stats.totalSupply
    : 0n;

  if (!isConnected) return <WalletConnector mode="ethereum" />;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <PageHeader
        title="Yield Basis Staking"
        subtitle="Stake mUSD to earn yield from BTC or ETH market-making via Yield Basis protocol"
        badge="Yield Basis"
        badgeColor="orange"
      />

      {/* Vault Selector */}
      <div className="grid gap-4 sm:grid-cols-2">
        {(["ybBTC", "ybETH"] as VaultType[]).map((v) => {
          const vi = VAULT_INFO[v];
          const isActive = activeVault === v;
          const vStats = v === "ybBTC" ? btcStats : ethStats;
          return (
            <button
              key={v}
              onClick={() => { setActiveVault(v); setAmount(""); }}
              className={`relative rounded-xl border p-5 text-left transition-all duration-300 ${
                isActive
                  ? `border-${vi.color}-500/50 bg-${vi.color}-500/10 shadow-[0_0_20px_-5px_rgba(var(--${vi.color}),0.3)]`
                  : "border-white/10 bg-surface-800/30 hover:border-white/20"
              }`}
            >
              <div className="flex items-center gap-3 mb-3">
                <div className={`flex h-10 w-10 items-center justify-center rounded-full text-xl font-bold ${
                  vi.color === "orange" ? "bg-orange-500/20 text-orange-400" : "bg-blue-500/20 text-blue-400"
                }`}>
                  {vi.icon}
                </div>
                <div>
                  <h3 className="font-semibold text-white">{vi.name}</h3>
                  <p className="text-xs text-gray-400">{vi.symbol}</p>
                </div>
                {isActive && (
                  <div className="ml-auto">
                    <div className="h-3 w-3 rounded-full bg-emerald-400 animate-pulse" />
                  </div>
                )}
              </div>
              <p className="text-xs text-gray-400 mb-3">{vi.description}</p>
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-400">APY</span>
                <span className={`font-semibold ${vi.color === "orange" ? "text-orange-400" : "text-blue-400"}`}>
                  {vStats.currentAPY > 0n ? (Number(vStats.currentAPY) / 1e16).toFixed(2) + "%" : "—"}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm mt-1">
                <span className="text-gray-400">TVL</span>
                <span className="text-white font-medium">{formatToken(vStats.totalAssets)} mUSD</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Stats Row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Share Price"
          value={`${exchangeRate} mUSD`}
          subValue={`per ${info.symbol}`}
          color="green"
        />
        <StatCard
          label="Pool APY"
          value={`${apyDisplay}%`}
          color={info.color === "orange" ? "yellow" : "blue"}
          trend="up"
          trendValue="Live from YB"
        />
        <StatCard
          label="Vault TVL"
          value={formatToken(stats.totalAssets) + " mUSD"}
          color="blue"
        />
        <StatCard
          label="Utilization"
          value={`${utilDisplay}%`}
          color="purple"
        />
      </div>

      {/* Your Position */}
      {stats.sharesBal > 0n && (
        <div className="card-gradient-border overflow-hidden">
          <div className="flex items-center gap-3 mb-5">
            <div className={`flex h-10 w-10 items-center justify-center rounded-full text-xl font-bold ${
              info.color === "orange" ? "bg-orange-500/20 text-orange-400" : "bg-blue-500/20 text-blue-400"
            }`}>
              {info.icon}
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">Your {info.symbol} Position</h2>
              <p className="text-sm text-gray-400">YB market-making yield</p>
            </div>
          </div>
          <div className="grid gap-6 sm:grid-cols-3">
            <div className="space-y-1">
              <p className="text-sm text-gray-400">{info.symbol} Shares</p>
              <p className="text-2xl font-bold text-white">{formatToken(stats.sharesBal)}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-gray-400">Position Value</p>
              <p className="text-2xl font-bold text-emerald-400">{formatToken(positionValue)} mUSD</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-gray-400">Status</p>
              <p className={`text-lg font-bold ${stats.canWithdraw ? "text-green-400" : "text-yellow-400"}`}>
                {stats.canWithdraw ? "Withdrawable" : "In Cooldown"}
              </p>
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
            <div className="progress-bar-emerald h-full rounded-full transition-all duration-1000" style={{ width: `${cooldownPct}%` }} />
          </div>
        </div>
      )}

      {/* Main Action Card */}
      <div className="card-gradient-border overflow-hidden">
        {/* Tabs */}
        <div className="flex border-b border-white/10">
          <button
            className={`relative flex-1 px-6 py-4 text-center text-sm font-semibold transition-all duration-300 ${tab === "stake" ? "text-white" : "text-gray-400 hover:text-white"}`}
            onClick={() => { setTab("stake"); setAmount(""); }}
          >
            <span className="relative z-10 flex items-center justify-center gap-2">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
              </svg>
              Stake mUSD → {info.symbol}
            </span>
            {tab === "stake" && <span className="absolute bottom-0 left-1/2 h-0.5 w-24 -translate-x-1/2 rounded-full bg-gradient-to-r from-emerald-500 to-teal-500" />}
          </button>
          <button
            className={`relative flex-1 px-6 py-4 text-center text-sm font-semibold transition-all duration-300 ${tab === "unstake" ? "text-white" : "text-gray-400 hover:text-white"}`}
            onClick={() => { setTab("unstake"); setAmount(""); }}
          >
            <span className="relative z-10 flex items-center justify-center gap-2">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Unstake {info.symbol}
            </span>
            {tab === "unstake" && <span className="absolute bottom-0 left-1/2 h-0.5 w-24 -translate-x-1/2 rounded-full bg-gradient-to-r from-emerald-500 to-teal-500" />}
          </button>
        </div>

        {/* Form */}
        <div className="space-y-6 p-6">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-gray-400">
                {tab === "stake" ? "You Stake" : "You Unstake"}
              </label>
              <span className="text-xs text-gray-500">
                Balance: {formatToken(tab === "stake" ? stats.musdBal : stats.sharesBal)}
              </span>
            </div>
            <div className="relative rounded-xl border border-white/10 bg-surface-800/50 p-4 transition-all duration-300 focus-within:border-emerald-500/50">
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
                    onClick={() => setAmount(ethers.formatUnits(tab === "stake" ? stats.musdBal : stats.sharesBal, MUSD_DECIMALS))}
                  >
                    MAX
                  </button>
                  <div className="flex items-center gap-2 rounded-full bg-surface-700/50 px-3 py-1.5">
                    <span className="font-semibold text-white">{tab === "stake" ? "mUSD" : info.symbol}</span>
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

          {/* Output */}
          <div className="space-y-3">
            <label className="text-sm font-medium text-gray-400">You Receive</label>
            <div className="rounded-xl border border-white/10 bg-surface-800/30 p-4">
              <div className="flex items-center justify-between">
                <span className="text-2xl font-semibold text-white">
                  {amount && parseFloat(amount) > 0
                    ? (tab === "stake" ? formatToken(stats.previewDeposit) : formatToken(stats.previewRedeem))
                    : "0.00"}
                </span>
                <div className="flex items-center gap-2 rounded-full bg-surface-700/50 px-3 py-1.5">
                  <span className="font-semibold text-white">{tab === "stake" ? info.symbol : "mUSD"}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Exchange Info */}
          {amount && parseFloat(amount) > 0 && (
            <div className="space-y-2 rounded-xl bg-surface-800/30 p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-400">Exchange Rate</span>
                <span className="font-medium text-white">1 {info.symbol} = {exchangeRate} mUSD</span>
              </div>
              <div className="divider my-2" />
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-400">Yield Source</span>
                <span className="text-gray-300">Yield Basis {activeVault === "ybBTC" ? "BTC" : "ETH"}/USDC Pool</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-400">Cooldown</span>
                <span className="text-gray-300">24 hours</span>
              </div>
            </div>
          )}

          {/* Cooldown Warning */}
          {tab === "unstake" && !stats.canWithdraw && stats.cooldownRemaining > 0n && (
            <div className="alert-warning flex items-center gap-3">
              <svg className="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-sm">Cooldown active — {cooldownHours.toFixed(1)}h remaining before withdrawal.</span>
            </div>
          )}

          {/* Action Button */}
          <TxButton
            onClick={tab === "stake" ? handleStake : handleUnstake}
            loading={tx.loading}
            disabled={!amount || parseFloat(amount) <= 0 || (tab === "unstake" && !stats.canWithdraw)}
            className="w-full"
          >
            <span className="flex items-center justify-center gap-2">
              {tab === "stake" ? `Stake mUSD → ${info.symbol}` : (stats.canWithdraw ? `Unstake ${info.symbol}` : "Cooldown Active")}
            </span>
          </TxButton>

          {tx.error && (
            <div className="alert-error flex items-center gap-3">
              <span className="text-sm">{tx.error}</span>
            </div>
          )}
          {tx.success && (
            <div className="alert-success flex items-center gap-3">
              <span className="text-sm">
                Transaction confirmed!{" "}
                {tx.hash && (
                  <a href={`https://etherscan.io/tx/${tx.hash}`} target="_blank" rel="noopener noreferrer" className="underline">
                    View on Etherscan
                  </a>
                )}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* How YB Staking Works */}
      <div className="card">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-orange-500/20">
            <span className="text-orange-400 font-bold">YB</span>
          </div>
          <h2 className="text-lg font-semibold text-white">How Yield Basis Staking Works</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-4">
          <div className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-500/20 text-brand-400 font-bold text-sm mb-3">1</div>
            <h3 className="font-medium text-white mb-1">Stake mUSD</h3>
            <p className="text-xs text-gray-400">Choose BTC or ETH vault and deposit your mUSD</p>
          </div>
          <div className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-orange-500/20 text-orange-400 font-bold text-sm mb-3">2</div>
            <h3 className="font-medium text-white mb-1">USDC → YB Pool</h3>
            <p className="text-xs text-gray-400">Backing USDC is deployed to Yield Basis lending pools</p>
          </div>
          <div className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400 font-bold text-sm mb-3">3</div>
            <h3 className="font-medium text-white mb-1">Earn Yield</h3>
            <p className="text-xs text-gray-400">Leveraged LPs borrow USDC and pay interest to you</p>
          </div>
          <div className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-500/20 text-purple-400 font-bold text-sm mb-3">4</div>
            <h3 className="font-medium text-white mb-1">Withdraw</h3>
            <p className="text-xs text-gray-400">Redeem shares for mUSD + earned yield after 24h cooldown</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default YBStakePage;
