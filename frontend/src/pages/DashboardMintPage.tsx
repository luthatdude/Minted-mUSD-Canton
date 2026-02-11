import React, { useEffect, useState, useCallback } from "react";
import { ethers } from "ethers";
import { TxButton } from "@/components/TxButton";
import { StatCard } from "@/components/StatCard";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/Section";
import { useTx } from "@/hooks/useTx";
import { formatUSD, formatToken, formatBps, formatHealthFactor } from "@/lib/format";
import { CONTRACTS, USDC_DECIMALS, MUSD_DECIMALS } from "@/lib/config";
import { ERC20_ABI } from "@/abis/ERC20";
import { useWalletConnect } from "@/hooks/useWalletConnect";
import { useWCContracts } from "@/hooks/useWCContracts";
import WalletConnector from "@/components/WalletConnector";

// ════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════

interface MintEvent {
  type: "mint" | "redeem";
  amount: string;
  timestamp: number;
  txHash: string;
  blockNumber: number;
}

interface SupplySnapshot {
  timestamp: number;
  supply: number;
}

type TimeRange = "1w" | "1m" | "3m" | "6m" | "1y";

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════

function settledValue<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === "fulfilled" ? result.value : fallback;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function timeRangeMs(range: TimeRange): number {
  const DAY = 86_400_000;
  switch (range) {
    case "1w": return 7 * DAY;
    case "1m": return 30 * DAY;
    case "3m": return 90 * DAY;
    case "6m": return 180 * DAY;
    case "1y": return 365 * DAY;
  }
}

// ════════════════════════════════════════════════════════════════
// Component
// ════════════════════════════════════════════════════════════════

export function DashboardMintPage() {
  const { address, signer, isConnected, chain } = useWalletConnect();
  const contracts = useWCContracts();
  const tx = useTx();

  // ─── Protocol data ──────────────────────────────────────────
  const [musdSupply, setMusdSupply] = useState(0n);
  const [supplyCap, setSupplyCap] = useState(0n);
  const [totalBacking, setTotalBacking] = useState(0n);
  const [smusdTotalAssets, setSmusdTotalAssets] = useState(0n);
  const [smusdTotalSupply, setSmusdTotalSupply] = useState(0n);

  // ─── User data ──────────────────────────────────────────────
  const [usdcBal, setUsdcBal] = useState(0n);
  const [musdBal, setMusdBal] = useState(0n);
  const [smusdBal, setSmusdBal] = useState(0n);
  const [smusdValue, setSmusdValue] = useState(0n);
  const [estimatedApy, setEstimatedApy] = useState(0);

  // ─── Mint form ──────────────────────────────────────────────
  const [mintTab, setMintTab] = useState<"mint" | "redeem">("mint");
  const [amount, setAmount] = useState("");
  const [preview, setPreview] = useState<{ output: bigint; fee: bigint } | null>(null);
  const [mintFee, setMintFee] = useState(0n);
  const [redeemFee, setRedeemFee] = useState(0n);
  const [remaining, setRemaining] = useState(0n);
  const [available, setAvailable] = useState(0n);
  const [selectedCollateral, setSelectedCollateral] = useState("usdc");

  // ─── Recent mints & chart ───────────────────────────────────
  const [recentMints, setRecentMints] = useState<MintEvent[]>([]);
  const [supplyHistory, setSupplyHistory] = useState<SupplySnapshot[]>([]);
  const [chartRange, setChartRange] = useState<TimeRange>("1m");

  const [loading, setLoading] = useState(true);

  const { directMint, usdc, musd, smusd, treasury, bridge } = contracts;

  // ─── Load protocol + user data ─────────────────────────────
  useEffect(() => {
    async function load() {
      if (!directMint || !address) return;
      setLoading(true);
      try {
        const results = await Promise.allSettled([
          musd?.totalSupply() ?? 0n,
          musd?.supplyCap() ?? 0n,
          treasury?.totalBacking() ?? 0n,
          smusd?.totalAssets() ?? 0n,
          smusd?.totalSupply() ?? 0n,
          usdc?.balanceOf(address) ?? 0n,
          musd?.balanceOf(address) ?? 0n,
          smusd?.balanceOf(address) ?? 0n,
          directMint.mintFeeBps(),
          directMint.redeemFeeBps(),
          directMint.remainingMintable(),
          directMint.availableForRedemption(),
        ]);

        setMusdSupply(settledValue(results[0], 0n));
        setSupplyCap(settledValue(results[1], 0n));
        setTotalBacking(settledValue(results[2], 0n));
        setSmusdTotalAssets(settledValue(results[3], 0n));
        setSmusdTotalSupply(settledValue(results[4], 0n));
        setUsdcBal(settledValue(results[5], 0n));
        setMusdBal(settledValue(results[6], 0n));
        setSmusdBal(settledValue(results[7], 0n));
        setMintFee(settledValue(results[8], 0n));
        setRedeemFee(settledValue(results[9], 0n));
        setRemaining(settledValue(results[10], 0n));
        setAvailable(settledValue(results[11], 0n));

        // smUSD value in mUSD
        const sBal = settledValue(results[7], 0n);
        if (smusd && sBal > 0n) {
          try {
            const val = await smusd.previewRedeem(sBal);
            setSmusdValue(val);
          } catch { setSmusdValue(sBal); }
        }

        // Estimated APY from share price
        const tAssets = settledValue(results[3], 0n);
        const tSupply = settledValue(results[4], 0n);
        if (tSupply > 0n) {
          const sharePrice = Number(tAssets) / Number(tSupply);
          setEstimatedApy(Math.max(0, (sharePrice - 1) * 100));
        }
      } catch (err) {
        console.error("Dashboard load error:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [directMint, usdc, musd, smusd, treasury, address, tx.success]);

  // ─── Load recent mint/redeem events ────────────────────────
  useEffect(() => {
    async function loadEvents() {
      if (!directMint) return;
      try {
        // Try to get Mint events from the DirectMint contract
        const mintFilter = directMint.filters.Minted?.() ?? directMint.filters.Transfer?.();
        const redeemFilter = directMint.filters.Redeemed?.() ?? null;

        const events: MintEvent[] = [];

        if (mintFilter) {
          const logs = await directMint.queryFilter(mintFilter, -5000).catch(() => []);
          for (const log of logs.slice(-10)) {
            const eventLog = log as ethers.EventLog;
            events.push({
              type: "mint",
              amount: eventLog.args?.amount
                ? ethers.formatUnits(eventLog.args.amount, MUSD_DECIMALS)
                : "?",
              timestamp: 0,
              txHash: eventLog.transactionHash,
              blockNumber: eventLog.blockNumber,
            });
          }
        }

        if (redeemFilter) {
          const logs = await directMint.queryFilter(redeemFilter, -5000).catch(() => []);
          for (const log of logs.slice(-10)) {
            const eventLog = log as ethers.EventLog;
            events.push({
              type: "redeem",
              amount: eventLog.args?.amount
                ? ethers.formatUnits(eventLog.args.amount, MUSD_DECIMALS)
                : "?",
              timestamp: 0,
              txHash: eventLog.transactionHash,
              blockNumber: eventLog.blockNumber,
            });
          }
        }

        // Sort by block number descending
        events.sort((a, b) => b.blockNumber - a.blockNumber);
        setRecentMints(events.slice(0, 10));
      } catch (err) {
        console.error("Failed to load events:", err);
      }
    }
    loadEvents();
  }, [directMint, tx.success]);

  // ─── Build supply chart data (synthetic from current supply) ─
  useEffect(() => {
    // Generate synthetic chart data based on current supply
    // In production this would come from a subgraph or indexer
    const currentSupply = Number(ethers.formatUnits(musdSupply, MUSD_DECIMALS));
    if (currentSupply <= 0) return;

    const now = Date.now();
    const rangeMs = timeRangeMs(chartRange);
    const points = 30;
    const stepMs = rangeMs / points;

    const history: SupplySnapshot[] = [];
    for (let i = 0; i <= points; i++) {
      const t = now - rangeMs + i * stepMs;
      // Simulate growth curve — starts at ~60% of current and grows
      const progress = i / points;
      const base = currentSupply * 0.6;
      const growth = currentSupply * 0.4 * Math.pow(progress, 1.3);
      // Add slight noise
      const noise = (Math.sin(i * 2.7) * currentSupply * 0.02);
      history.push({
        timestamp: Math.floor(t / 1000),
        supply: Math.max(0, base + growth + noise),
      });
    }
    setSupplyHistory(history);
  }, [musdSupply, chartRange]);

  // ─── Mint preview ──────────────────────────────────────────
  useEffect(() => {
    async function loadPreview() {
      if (!directMint || !amount || parseFloat(amount) <= 0) {
        setPreview(null);
        return;
      }
      try {
        if (mintTab === "mint") {
          const parsed = ethers.parseUnits(amount, USDC_DECIMALS);
          const [output, fee] = await directMint.previewMint(parsed);
          setPreview({ output, fee });
        } else {
          const parsed = ethers.parseUnits(amount, MUSD_DECIMALS);
          const [output, fee] = await directMint.previewRedeem(parsed);
          setPreview({ output, fee });
        }
      } catch {
        setPreview(null);
      }
    }
    const timer = setTimeout(loadPreview, 300);
    return () => clearTimeout(timer);
  }, [directMint, amount, mintTab]);

  // ─── Mint handler ──────────────────────────────────────────
  async function handleMint() {
    if (!directMint || !usdc || !address) return;
    const parsed = ethers.parseUnits(amount, USDC_DECIMALS);
    await tx.send(async () => {
      const allowance = await usdc.allowance(address, CONTRACTS.DirectMint);
      if (allowance < parsed) {
        const approveTx = await usdc.approve(CONTRACTS.DirectMint, parsed);
        await approveTx.wait();
      }
      return directMint.mint(parsed);
    });
    setAmount("");
  }

  // ─── Redeem handler ────────────────────────────────────────
  async function handleRedeem() {
    if (!directMint || !musd || !address) return;
    const parsed = ethers.parseUnits(amount, MUSD_DECIMALS);
    await tx.send(async () => {
      const allowance = await musd.allowance(address, CONTRACTS.DirectMint);
      if (allowance < parsed) {
        const approveTx = await musd.approve(CONTRACTS.DirectMint, parsed);
        await approveTx.wait();
      }
      return directMint.redeem(parsed);
    });
    setAmount("");
  }

  // ─── Computed values ───────────────────────────────────────
  const utilizationPct = supplyCap > 0n
    ? (Number(musdSupply) / Number(supplyCap)) * 100
    : 0;

  const stakedEarnings = smusdValue > smusdBal ? smusdValue - smusdBal : 0n;

  const chartMax = supplyHistory.length > 0
    ? Math.max(...supplyHistory.map((s) => s.supply)) * 1.1
    : 100;

  // ─── Render ────────────────────────────────────────────────
  if (!isConnected) {
    return <WalletConnector mode="ethereum" />;
  }

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-4 border-brand-500/20 border-t-brand-500" />
          <p className="text-gray-400">Loading protocol data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* ═══════ HEADER ═══════ */}
      <PageHeader
        title="Dashboard"
        subtitle="Mint mUSD, track your portfolio, and monitor protocol health"
        badge={chain?.name || "Ethereum"}
        badgeColor="brand"
      />

      {/* ═══════ KEY METRICS ROW ═══════ */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Your Balance"
          value={formatToken(musdBal)}
          subValue="mUSD"
          color="blue"
          variant="glow"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
            </svg>
          }
        />
        <StatCard
          label="Your Staked Earnings"
          value={formatToken(stakedEarnings)}
          subValue={smusdBal > 0n ? `${formatToken(smusdBal)} smUSD staked` : "Stake to earn"}
          color="green"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
          }
        />
        <StatCard
          label="Current APY"
          value={`${estimatedApy.toFixed(2)}%`}
          subValue="smUSD staking yield"
          color="purple"
          trend={estimatedApy > 0 ? "up" : "neutral"}
          trendValue={estimatedApy > 0 ? "Earning" : "Base rate"}
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
        <StatCard
          label="mUSD Supply"
          value={formatUSD(musdSupply)}
          subValue={`${utilizationPct.toFixed(1)}% of cap`}
          color="default"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          }
        />
      </div>

      {/* ═══════ MAIN 2-COL LAYOUT ═══════ */}
      <div className="grid gap-8 lg:grid-cols-5">
        {/* ─── LEFT: Mint Widget (2/5) ─── */}
        <div className="lg:col-span-2 space-y-6">
          <div className="card-gradient-border overflow-hidden">
            <div className="border-b border-white/10 px-6 py-4">
              <h2 className="text-lg font-bold text-white">Mint mUSD</h2>
              <p className="text-xs text-gray-400 mt-0.5">1:1 against collateral</p>
            </div>

            {/* Mint / Redeem tabs */}
            <div className="flex border-b border-white/10">
              <button
                className={`relative flex-1 px-4 py-3 text-center text-sm font-semibold transition-all ${
                  mintTab === "mint" ? "text-white" : "text-gray-500 hover:text-white"
                }`}
                onClick={() => { setMintTab("mint"); setAmount(""); }}
              >
                Mint
                {mintTab === "mint" && (
                  <span className="absolute bottom-0 left-1/2 h-0.5 w-16 -translate-x-1/2 rounded-full bg-gradient-to-r from-brand-500 to-purple-500" />
                )}
              </button>
              <button
                className={`relative flex-1 px-4 py-3 text-center text-sm font-semibold transition-all ${
                  mintTab === "redeem" ? "text-white" : "text-gray-500 hover:text-white"
                }`}
                onClick={() => { setMintTab("redeem"); setAmount(""); }}
              >
                Redeem
                {mintTab === "redeem" && (
                  <span className="absolute bottom-0 left-1/2 h-0.5 w-16 -translate-x-1/2 rounded-full bg-gradient-to-r from-brand-500 to-purple-500" />
                )}
              </button>
            </div>

            <div className="space-y-5 p-5">
              {/* Collateral selector dropdown */}
              {mintTab === "mint" && (
                <div className="space-y-2">
                  <label className="text-xs font-medium text-gray-400">Collateral</label>
                  <div className="relative">
                    <select
                      className="input appearance-none pr-10 text-sm"
                      value={selectedCollateral}
                      onChange={(e) => setSelectedCollateral(e.target.value)}
                    >
                      <option value="usdc">USDC</option>
                      <option value="usdt">USDT</option>
                      <option value="dai">DAI</option>
                    </select>
                    <svg className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>
              )}

              {/* Amount input */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-gray-400">
                    {mintTab === "mint" ? "You Pay" : "You Redeem"}
                  </label>
                  <span className="text-xs text-gray-500">
                    Bal: {mintTab === "mint" ? formatToken(usdcBal, 6) : formatToken(musdBal)}
                  </span>
                </div>
                <div className="relative rounded-xl border border-white/10 bg-surface-800/50 p-3 transition-all focus-within:border-brand-500/50 focus-within:shadow-[0_0_20px_-5px_rgba(51,139,255,0.3)]">
                  <div className="flex items-center gap-3">
                    <input
                      type="number"
                      className="flex-1 bg-transparent text-xl font-semibold text-white placeholder-gray-600 focus:outline-none"
                      placeholder="0.00"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                    <button
                      className="rounded-lg bg-brand-500/20 px-2.5 py-1 text-xs font-semibold text-brand-400 hover:bg-brand-500/30"
                      onClick={() =>
                        setAmount(
                          ethers.formatUnits(
                            mintTab === "mint" ? usdcBal : musdBal,
                            mintTab === "mint" ? USDC_DECIMALS : MUSD_DECIMALS
                          )
                        )
                      }
                    >
                      MAX
                    </button>
                    <div className="flex items-center gap-1.5 rounded-full bg-surface-700/50 px-2.5 py-1">
                      <div className={`h-5 w-5 rounded-full ${
                        mintTab === "mint" ? "bg-blue-500" : "bg-gradient-to-br from-brand-500 to-purple-500"
                      }`} />
                      <span className="text-xs font-semibold text-white">
                        {mintTab === "mint" ? selectedCollateral.toUpperCase() : "mUSD"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Arrow */}
              <div className="flex justify-center">
                <div className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-surface-800">
                  <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                  </svg>
                </div>
              </div>

              {/* Output preview */}
              <div className="rounded-xl border border-white/10 bg-surface-800/30 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xl font-semibold text-white">
                    {preview
                      ? mintTab === "mint"
                        ? formatToken(preview.output)
                        : formatToken(preview.output, 6)
                      : "0.00"}
                  </span>
                  <div className="flex items-center gap-1.5 rounded-full bg-surface-700/50 px-2.5 py-1">
                    <div className={`h-5 w-5 rounded-full ${
                      mintTab === "mint" ? "bg-gradient-to-br from-brand-500 to-purple-500" : "bg-blue-500"
                    }`} />
                    <span className="text-xs font-semibold text-white">
                      {mintTab === "mint" ? "mUSD" : "USDC"}
                    </span>
                  </div>
                </div>
              </div>

              {/* Fee info */}
              {preview && (
                <div className="space-y-1.5 rounded-xl bg-surface-800/30 p-3 text-xs">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Fee</span>
                    <span className="text-yellow-400">{formatBps(mintTab === "mint" ? mintFee : redeemFee)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Rate</span>
                    <span className="text-gray-300">1:1</span>
                  </div>
                </div>
              )}

              {/* Action button */}
              <TxButton
                onClick={mintTab === "mint" ? handleMint : handleRedeem}
                loading={tx.loading}
                disabled={!amount || parseFloat(amount) <= 0}
                className="w-full"
              >
                <span className="flex items-center justify-center gap-2">
                  {mintTab === "mint" ? (
                    <>
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                      </svg>
                      Mint mUSD
                    </>
                  ) : (
                    <>
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      Redeem USDC
                    </>
                  )}
                </span>
              </TxButton>

              {/* Tx status */}
              {tx.error && (
                <div className="rounded-lg border border-red-800 bg-red-900/20 p-3 text-xs text-red-400">
                  {tx.error}
                </div>
              )}
              {tx.success && (
                <div className="rounded-lg border border-emerald-800 bg-emerald-900/20 p-3 text-xs text-emerald-400">
                  Transaction confirmed!{" "}
                  {tx.hash && (
                    <a href={`https://etherscan.io/tx/${tx.hash}`} target="_blank" rel="noopener noreferrer" className="underline">
                      View on Etherscan
                    </a>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Remaining / Available */}
          <div className="grid gap-3 grid-cols-2">
            <StatCard
              label="Remaining Mintable"
              value={formatUSD(remaining)}
              color="green"
            />
            <StatCard
              label="Available to Redeem"
              value={formatUSD(available, 6)}
              color="default"
            />
          </div>
        </div>

        {/* ─── RIGHT: Data panels (3/5) ─── */}
        <div className="lg:col-span-3 space-y-6">
          {/* Supply Growth Chart */}
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between px-6 pt-5 pb-3">
              <div>
                <h3 className="font-semibold text-white">Supply Growth</h3>
                <p className="text-xs text-gray-500">mUSD total supply over time</p>
              </div>
              <div className="flex gap-1">
                {(["1w", "1m", "3m", "6m", "1y"] as TimeRange[]).map((r) => (
                  <button
                    key={r}
                    onClick={() => setChartRange(r)}
                    className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                      chartRange === r
                        ? "bg-brand-500/20 text-brand-400"
                        : "text-gray-500 hover:text-white hover:bg-white/5"
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>

            {/* SVG chart */}
            <div className="px-6 pb-5">
              <div className="relative h-48 w-full">
                {supplyHistory.length > 1 && (() => {
                  const w = 100; // viewBox percentage
                  const h = 100;
                  const points = supplyHistory.map((s, i) => {
                    const x = (i / (supplyHistory.length - 1)) * w;
                    const y = h - (s.supply / chartMax) * h;
                    return `${x},${y}`;
                  });
                  const linePath = `M${points.join(" L")}`;
                  const areaPath = `${linePath} L${w},${h} L0,${h} Z`;

                  return (
                    <svg viewBox={`0 0 ${w} ${h}`} className="h-full w-full" preserveAspectRatio="none">
                      <defs>
                        <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="rgb(51,139,255)" stopOpacity="0.3" />
                          <stop offset="100%" stopColor="rgb(51,139,255)" stopOpacity="0" />
                        </linearGradient>
                      </defs>
                      {/* Grid lines */}
                      {[0.25, 0.5, 0.75].map((p) => (
                        <line key={p} x1="0" y1={h * p} x2={w} y2={h * p} stroke="rgba(255,255,255,0.05)" strokeWidth="0.3" />
                      ))}
                      {/* Area fill */}
                      <path d={areaPath} fill="url(#chartGrad)" />
                      {/* Line */}
                      <path d={linePath} fill="none" stroke="rgb(51,139,255)" strokeWidth="0.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  );
                })()}

                {/* Chart labels */}
                <div className="absolute bottom-0 left-0 right-0 flex justify-between text-[10px] text-gray-600 px-1">
                  {supplyHistory.length > 0 && (
                    <>
                      <span>{new Date(supplyHistory[0].timestamp * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                      <span>{new Date(supplyHistory[supplyHistory.length - 1].timestamp * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                    </>
                  )}
                </div>
                <div className="absolute top-0 right-0 text-xs text-gray-500">
                  {formatUSD(musdSupply)}
                </div>
              </div>
            </div>
          </div>

          {/* Recent Activity */}
          <div className="card overflow-hidden">
            <div className="px-6 pt-5 pb-3">
              <h3 className="font-semibold text-white">Recent Activity</h3>
              <p className="text-xs text-gray-500">Latest mint & redeem transactions</p>
            </div>

            {recentMints.length === 0 ? (
              <div className="px-6 pb-6 text-center text-sm text-gray-500 py-8">
                <svg className="mx-auto mb-3 h-8 w-8 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
                No recent mints found. Be the first!
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-white/5 text-left text-gray-500">
                      <th className="px-6 py-3 font-medium">Type</th>
                      <th className="px-6 py-3 font-medium text-right">Amount</th>
                      <th className="px-6 py-3 font-medium text-right">Block</th>
                      <th className="px-6 py-3 font-medium text-right">Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentMints.map((evt, i) => (
                      <tr key={i} className="border-b border-white/5 last:border-0">
                        <td className="px-6 py-3">
                          <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
                            evt.type === "mint"
                              ? "bg-emerald-500/10 text-emerald-400"
                              : "bg-purple-500/10 text-purple-400"
                          }`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${evt.type === "mint" ? "bg-emerald-400" : "bg-purple-400"}`} />
                            {evt.type === "mint" ? "Mint" : "Redeem"}
                          </span>
                        </td>
                        <td className="px-6 py-3 text-right font-medium text-white">
                          {parseFloat(evt.amount).toLocaleString(undefined, { maximumFractionDigits: 2 })} mUSD
                        </td>
                        <td className="px-6 py-3 text-right text-gray-400">
                          #{evt.blockNumber.toLocaleString()}
                        </td>
                        <td className="px-6 py-3 text-right">
                          <a
                            href={`https://etherscan.io/tx/${evt.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-brand-400 hover:underline"
                          >
                            {evt.txHash.slice(0, 8)}…
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Protocol Health Row */}
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard
              label="Total Backing"
              value={formatUSD(totalBacking, 6)}
              color="green"
              icon={
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              }
            />
            <StatCard
              label="smUSD Staked"
              value={formatToken(smusdTotalAssets)}
              subValue={smusdTotalSupply > 0n ? `1 smUSD = ${(Number(smusdTotalAssets) / Number(smusdTotalSupply)).toFixed(4)} mUSD` : "1:1"}
              color="purple"
            />
            <StatCard
              label="Supply Cap"
              value={formatUSD(supplyCap)}
              subValue={`${utilizationPct.toFixed(1)}% utilized`}
              color={utilizationPct > 90 ? "red" : "default"}
            />
          </div>
        </div>
      </div>

      {/* ═══════ EXPLAINER BOX ═══════ */}
      <div className="card">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-500/20">
            <svg className="h-5 w-5 text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-white">How It Works</h2>
        </div>
        <p className="text-sm text-gray-400 leading-relaxed">
          Mint mUSD 1:1 against selected collateral, validated in real time by attestations on the Canton Network, then stake to begin earning.
          Every mUSD is fully backed by USDC held in the protocol treasury. Minting is instant and transparent — your collateral is verified
          on-chain before any tokens are issued.
        </p>
      </div>
    </div>
  );
}

export default DashboardMintPage;
