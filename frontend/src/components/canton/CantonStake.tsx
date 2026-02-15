import React, { useState, useEffect, useCallback, useMemo } from "react";
import { ethers } from "ethers";
import { StatCard } from "@/components/StatCard";
import { useLoopWallet, LoopContract } from "@/hooks/useLoopWallet";
import { useWalletConnect } from "@/hooks/useWalletConnect";
import { useWCContracts } from "@/hooks/useWCContracts";
import { useTx } from "@/hooks/useTx";
import { useCryptoPrices, formatPrice, formatLargeNumber, MiniSparkline } from "@/hooks/useCryptoPrices";
import { CONTRACTS, USDC_DECIMALS, MUSD_DECIMALS } from "@/lib/config";
import { formatToken } from "@/lib/format";
import WalletConnector from "@/components/WalletConnector";

// ── DAML template IDs ────────────────────────────────────────────
const PACKAGE_ID = process.env.NEXT_PUBLIC_DAML_PACKAGE_ID || "";
const templates = {
  StakingService: `${PACKAGE_ID}:MintedProtocolV2Fixed:StakingService`,
  YBStakingService: `${PACKAGE_ID}:CantonYBStaking:CantonYBStakingService`,
  StrategySMUSD: `${PACKAGE_ID}:CantonYBStaking:CantonStrategySMUSD`,
  MUSD: `${PACKAGE_ID}:MintedProtocolV2Fixed:MUSD`,
};

// ── Pool Configuration ───────────────────────────────────────────
type PoolId = "btcPool" | "ethPool";

interface PoolConfig {
  id: PoolId;
  name: string;
  asset: string;
  symbol: string;
  description: string;
  baseApy: number;
  boostApy: number;
  tvl: number;
  gradient: string;
  iconBg: string;
  accentColor: string;
  leverageDisplay: string;
}

const POOLS: PoolConfig[] = [
  {
    id: "btcPool",
    name: "BTC Pool",
    asset: "Bitcoin",
    symbol: "BTC",
    description: "Mint mUSD → auto-stake → receive sMUSD-BTC. Dedicated yield from 2x leveraged BTC/USDC LP.",
    baseApy: 8.4,
    boostApy: 12.6,
    tvl: 0,
    gradient: "from-orange-500 to-amber-600",
    iconBg: "bg-gradient-to-br from-orange-500 to-amber-600",
    accentColor: "text-orange-400",
    leverageDisplay: "2x",
  },
  {
    id: "ethPool",
    name: "ETH Pool",
    asset: "Ethereum",
    symbol: "ETH",
    description: "Mint mUSD → auto-stake → receive sMUSD-ETH. Dedicated yield from 2x leveraged ETH/USDC LP.",
    baseApy: 6.2,
    boostApy: 9.8,
    tvl: 0,
    gradient: "from-blue-500 to-indigo-600",
    iconBg: "bg-gradient-to-br from-blue-500 to-indigo-600",
    accentColor: "text-blue-400",
    leverageDisplay: "2x",
  },
];

// ── Step Definitions ─────────────────────────────────────────────
type FlowStep = "idle" | "approve" | "mint" | "bridge" | "stake" | "done";

const STEP_META: Record<FlowStep, { label: string; num: number }> = {
  idle:    { label: "Enter Amount", num: 0 },
  approve: { label: "Approve USDC", num: 1 },
  mint:    { label: "Mint mUSD",    num: 2 },
  bridge:  { label: "Bridge",       num: 3 },
  stake:   { label: "Auto-Stake",   num: 4 },
  done:    { label: "Complete",     num: 5 },
};

// ── Helpers ──────────────────────────────────────────────────────
function changeColor(pct: number): string {
  if (pct > 0) return "text-emerald-400";
  if (pct < 0) return "text-red-400";
  return "text-gray-400";
}
function changeArrow(pct: number): string {
  if (pct > 0) return "↑";
  if (pct < 0) return "↓";
  return "—";
}

// ═════════════════════════════════════════════════════════════════
//  MAIN COMPONENT
// ═════════════════════════════════════════════════════════════════
export function CantonStake() {
  // ── Wallets & contracts ──────────────────────────────────────
  const loopWallet = useLoopWallet();
  const ethWallet  = useWalletConnect();
  const contracts  = useWCContracts();
  const tx         = useTx();
  const prices     = useCryptoPrices(30_000);

  // ── Local state ──────────────────────────────────────────────
  const [selectedPool, setSelectedPool] = useState<PoolId | null>(null);
  const [action, setAction]   = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount]   = useState("");
  const [flowStep, setFlowStep] = useState<FlowStep>("idle");
  const [flowError, setFlowError] = useState<string | null>(null);
  const [flowTxHash, setFlowTxHash] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Canton state
  const [services, setServices]         = useState<LoopContract[]>([]);
  const [musdContracts, setMusdContracts] = useState<LoopContract[]>([]);
  const [positions, setPositions]       = useState<Record<PoolId, number>>({ btcPool: 0, ethPool: 0 });

  // Ethereum balances
  const [usdcBal, setUsdcBal] = useState(0n);
  const [musdBal, setMusdBal] = useState(0n);

  // ── Load Ethereum balances ───────────────────────────────────
  useEffect(() => {
    async function load() {
      if (!ethWallet.address || !contracts.usdc || !contracts.musd) return;
      const [u, m] = await Promise.all([
        contracts.usdc.balanceOf(ethWallet.address),
        contracts.musd.balanceOf(ethWallet.address),
      ]);
      setUsdcBal(u); setMusdBal(m);
    }
    load();
  }, [ethWallet.address, contracts.usdc, contracts.musd, tx.success, flowStep]);

  // ── Load Canton contracts ────────────────────────────────────
  const loadCantonContracts = useCallback(async () => {
    if (!loopWallet.isConnected) return;
    try {
      const [svc, musd, strategyPositions] = await Promise.all([
        loopWallet.queryContracts(templates.YBStakingService).catch(() => []),
        loopWallet.queryContracts(templates.MUSD).catch(() => []),
        loopWallet.queryContracts(templates.StrategySMUSD).catch(() => []),
      ]);
      setServices(svc);
      setMusdContracts(musd);
      const pos: Record<PoolId, number> = { btcPool: 0, ethPool: 0 };
      strategyPositions.forEach((v) => {
        const strategy = v.payload?.strategy as string;
        const poolId = strategy === "BTC" ? "btcPool" : strategy === "ETH" ? "ethPool" : null;
        if (poolId && pos[poolId] !== undefined) pos[poolId] += parseFloat(v.payload?.shares || "0");
      });
      setPositions(pos);
    } catch (err) { console.error("Failed to load Canton contracts:", err); }
  }, [loopWallet.isConnected, loopWallet.queryContracts]);

  useEffect(() => { loadCantonContracts(); }, [loadCantonContracts]);

  const totalMusdCanton = musdContracts.reduce(
    (sum, c) => sum + parseFloat(c.payload?.amount || "0"), 0
  );

  // ── Merge pool config with live prices ───────────────────────
  const poolsWithPrices = useMemo(() => {
    return POOLS.map((pool) => {
      const priceData = pool.symbol === "BTC" ? prices.btc : prices.eth;
      return {
        ...pool,
        livePrice: priceData?.price ?? 0,
        change24h: priceData?.change24h ?? 0,
        sparkline: priceData?.sparkline7d ?? [],
        marketCap: priceData?.marketCap ?? 0,
        volume:    priceData?.volume24h ?? 0,
        position:  positions[pool.id],
      };
    });
  }, [prices.btc, prices.eth, positions]);

  const selectedPoolData = poolsWithPrices.find((p) => p.id === selectedPool) ?? null;

  // ── Full deposit flow: USDC → Mint mUSD → Bridge → Deposit ──
  async function handleDeposit() {
    if (!amount || parseFloat(amount) <= 0 || !selectedPool) return;
    setLoading(true); setFlowError(null); setFlowTxHash(null);

    const parsed = ethers.parseUnits(amount, USDC_DECIMALS);

    try {
      // Step 1: Approve USDC
      setFlowStep("approve");
      if (contracts.usdc && contracts.directMint && ethWallet.address) {
        const allowance = await contracts.usdc.allowance(ethWallet.address, CONTRACTS.DirectMint);
        if (allowance < parsed) {
          if (allowance > 0n) {
            const resetTx = await contracts.usdc.approve(CONTRACTS.DirectMint, 0n);
            await resetTx.wait();
          }
          const approveTx = await contracts.usdc.approve(CONTRACTS.DirectMint, parsed);
          await approveTx.wait();
        }
      }

      // Step 2: Mint mUSD
      setFlowStep("mint");
      if (contracts.directMint) {
        const mintTx = await contracts.directMint.mint(parsed);
        const receipt = await mintTx.wait();
        setFlowTxHash(receipt?.hash || mintTx.hash);
      }

      // Step 3: Bridge to Canton
      setFlowStep("bridge");
      if (contracts.bridge && contracts.musd && ethWallet.address) {
        const musdAmount = parsed * (10n ** 12n); // USDC 6 dec → mUSD 18 dec
        const bridgeAllowance = await contracts.musd.allowance(ethWallet.address, CONTRACTS.BLEBridgeV9);
        if (bridgeAllowance < musdAmount) {
          const approveTx = await contracts.musd.approve(CONTRACTS.BLEBridgeV9, musdAmount);
          await approveTx.wait();
        }
        try {
          const bridgeTx = await contracts.bridge.initiateTransfer(
            musdAmount, loopWallet.partyId || ethWallet.address
          );
          await bridgeTx.wait();
        } catch { /* Bridge may not be deployed in dev — continue */ }
      }
      await new Promise((r) => setTimeout(r, 2000)); // attestation propagation

      // Step 4: Auto-stake mUSD → sMUSD-BTC or sMUSD-ETH on Canton
      setFlowStep("stake");
      if (loopWallet.isConnected && services.length > 0) {
        const musdCid = musdContracts[0]?.contractId;
        if (musdCid) {
          const strategy = selectedPool === "btcPool" ? "BTC" : "ETH";
          const service = services.find((s) => s.payload?.poolType === strategy) || services[0];
          // Exercise YB_Stake: burns mUSD, issues strategy-dedicated sMUSD
          await loopWallet.exerciseChoice(
            templates.YBStakingService, service.contractId,
            "YB_Stake", { user: loopWallet.partyId, musdCid }
          );
        }
      }

      setFlowStep("done");
      setAmount("");
      await loadCantonContracts();
    } catch (err: any) {
      setFlowError(err.reason || err.shortMessage || err.message || "Transaction failed");
    } finally { setLoading(false); }
  }

  // ── Withdraw from Vault ──────────────────────────────────────
  async function handleWithdraw() {
    if (!selectedPool) return;
    setLoading(true); setFlowError(null);
    try {
      if (loopWallet.isConnected && services.length > 0) {
        // Find the user's sMUSD position for this strategy
        const allPositions = await loopWallet.queryContracts(templates.StrategySMUSD).catch(() => []);
        const strategy = selectedPool === "btcPool" ? "BTC" : "ETH";
        const position = allPositions.find((p) => p.payload?.strategy === strategy);
        if (!position) throw new Error(`No sMUSD-${strategy} position found`);

        const service = services.find((s) => s.payload?.poolType === strategy) || services[0];
        // Exercise YB_Unstake: burns sMUSD-BTC/ETH → returns mUSD with yield
        await loopWallet.exerciseChoice(
          templates.YBStakingService, service.contractId,
          "YB_Unstake", { user: loopWallet.partyId, positionCid: position.contractId }
        );
      }
      setAmount("");
      await loadCantonContracts();
    } catch (err: any) {
      setFlowError(err.reason || err.message || "Unstake failed");
    } finally { setLoading(false); }
  }

  // ═══════════════════════════════════════════════════════════════
  //  RENDER
  // ═══════════════════════════════════════════════════════════════

  if (!ethWallet.isConnected && !loopWallet.isConnected) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="max-w-md space-y-6 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-orange-500 to-blue-500">
            <svg className="h-8 w-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <h3 className="text-xl font-semibold text-white">Connect Your Wallets</h3>
          <p className="text-gray-400">
            Connect both your Ethereum wallet (for USDC) and Canton wallet (for BTC &amp; ETH vaults).
          </p>
          <div className="space-y-3">
            <WalletConnector mode="ethereum" />
            <WalletConnector mode="canton" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8">

      {/* ── Header ────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-3xl font-bold text-white">BTC &amp; ETH Pools</h1>
            <span className="rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-semibold text-emerald-400">
              Canton Network
            </span>
          </div>
          <p className="text-gray-400 max-w-xl">
            Mint mUSD from USDC, bridge to Canton, and auto-stake into strategy-dedicated
            sMUSD pools. Each pool&apos;s yield is isolated — sMUSD-BTC and sMUSD-ETH earn independently.
          </p>
        </div>
        {prices.updatedAt && (
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            Live prices · {new Date(prices.updatedAt).toLocaleTimeString()}
          </div>
        )}
      </div>

      {/* ── Live Price Ticker ─────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2">
        {[prices.btc, prices.eth].map((coin) =>
          coin ? (
            <div key={coin.id} className="relative overflow-hidden rounded-2xl border border-white/10 bg-surface-800/60 p-5 backdrop-blur-sm">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${
                    coin.symbol === "btc" ? "bg-gradient-to-br from-orange-500 to-amber-600" : "bg-gradient-to-br from-blue-500 to-indigo-600"
                  }`}>
                    <span className="text-lg font-bold text-white">{coin.symbol === "btc" ? "₿" : "Ξ"}</span>
                  </div>
                  <div>
                    <p className="font-semibold text-white">{coin.name}</p>
                    <p className="text-xs uppercase text-gray-500">{coin.symbol}</p>
                  </div>
                </div>
                <MiniSparkline
                  data={coin.sparkline7d}
                  width={80} height={28}
                  color={coin.change24h >= 0 ? "#10b981" : "#ef4444"}
                />
              </div>
              <div className="mt-4 flex items-end justify-between">
                <div>
                  <p className="text-2xl font-bold text-white">{formatPrice(coin.price)}</p>
                  <p className={`text-sm font-medium ${changeColor(coin.change24h)}`}>
                    {changeArrow(coin.change24h)} {Math.abs(coin.change24h).toFixed(2)}% (24h)
                  </p>
                </div>
                <div className="text-right text-xs text-gray-500">
                  <p>MCap: {formatLargeNumber(coin.marketCap)}</p>
                  <p>Vol: {formatLargeNumber(coin.volume24h)}</p>
                </div>
              </div>
            </div>
          ) : (
            <div key={Math.random()} className="animate-pulse rounded-2xl bg-surface-800/40 h-32" />
          )
        )}
      </div>

      {/* ── How It Works — Flow Diagram ───────────────────────── */}
      <div className="rounded-2xl border border-white/10 bg-surface-800/40 p-6">
        <h2 className="mb-5 text-lg font-semibold text-white">How It Works</h2>
        <div className="flex flex-col items-center gap-2 sm:flex-row sm:gap-0">
          {[
            { icon: "💵", label: "USDC", sub: "Your stablecoin" },
            null,
            { icon: "🏦", label: "Mint mUSD", sub: "1:1 mint" },
            null,
            { icon: "🌉", label: "Bridge", sub: "Canton Network" },
            null,
            { icon: "�", label: "Auto-Stake", sub: "sMUSD-BTC / ETH" },
            null,
            { icon: "💰", label: "Earn Yield", sub: "Strategy-dedicated" },
          ].map((step, i) =>
            step === null ? (
              <svg key={`arrow-${i}`} className="hidden h-4 w-8 text-gray-600 sm:block" fill="none" viewBox="0 0 32 16">
                <path d="M0 8h28m0 0l-6-6m6 6l-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <div key={`step-${i}`} className="flex flex-col items-center gap-1 px-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-700/80 text-xl">{step.icon}</div>
                <p className="text-sm font-medium text-white">{step.label}</p>
                <p className="text-[10px] text-gray-500">{step.sub}</p>
              </div>
            )
          )}
        </div>
      </div>

      {/* ── Wallet Status Bar ─────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-surface-800/40 px-4 py-3">
          <span className={`h-2 w-2 rounded-full ${ethWallet.isConnected ? "bg-emerald-500" : "bg-red-500"}`} />
          <div className="min-w-0">
            <p className="truncate text-xs text-gray-500">Ethereum Wallet</p>
            <p className="truncate text-sm font-medium text-white">
              {ethWallet.isConnected ? `${ethWallet.address?.slice(0, 6)}...${ethWallet.address?.slice(-4)}` : "Not connected"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-surface-800/40 px-4 py-3">
          <span className={`h-2 w-2 rounded-full ${loopWallet.isConnected ? "bg-emerald-500" : "bg-yellow-500"}`} />
          <div className="min-w-0">
            <p className="truncate text-xs text-gray-500">Canton Wallet</p>
            <p className="truncate text-sm font-medium text-white">
              {loopWallet.isConnected ? `${loopWallet.partyId?.slice(0, 12)}...` : "Not connected"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-surface-800/40 px-4 py-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-500/20">
            <span className="text-xs">💲</span>
          </div>
          <div>
            <p className="text-xs text-gray-500">USDC Balance</p>
            <p className="text-sm font-semibold text-white">{formatToken(usdcBal, 6)}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-surface-800/40 px-4 py-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-purple-500/20">
            <span className="text-xs">Ⓜ</span>
          </div>
          <div>
            <p className="text-xs text-gray-500">mUSD (Canton)</p>
            <p className="text-sm font-semibold text-white">{totalMusdCanton.toFixed(2)}</p>
          </div>
        </div>
      </div>

      {/* ── Pool Cards ────────────────────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-2">
        {poolsWithPrices.map((pool) => (
          <div
            key={pool.id}
            className={`group relative overflow-hidden rounded-2xl border transition-all duration-300 ${
              selectedPool === pool.id
                ? "border-white/30 bg-surface-800/80 shadow-lg shadow-white/5"
                : "border-white/10 bg-surface-800/50 hover:border-white/20 hover:bg-surface-800/70"
            }`}
          >
            {/* Pool Header */}
            <div className="p-6 pb-4">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className={`flex h-12 w-12 items-center justify-center rounded-xl ${pool.iconBg}`}>
                    <span className="text-xl font-bold text-white">{pool.symbol === "BTC" ? "₿" : "Ξ"}</span>
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-white">{pool.name}</h3>
                    <p className="text-xs text-gray-500 max-w-[220px]">{pool.description}</p>
                  </div>
                </div>
                <span className={`rounded-full bg-white/10 px-2.5 py-1 text-xs font-bold ${pool.accentColor}`}>
                  {pool.leverageDisplay} Leverage
                </span>
              </div>
            </div>

            {/* Live Price Row */}
            <div className="mx-6 mb-4 flex items-center justify-between rounded-xl bg-surface-900/50 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-400">{pool.symbol} Price</span>
                <MiniSparkline data={pool.sparkline} width={60} height={20} color={pool.change24h >= 0 ? "#10b981" : "#ef4444"} />
              </div>
              <div className="text-right">
                <span className="font-semibold text-white">{pool.livePrice > 0 ? formatPrice(pool.livePrice) : "..."}</span>
                <span className={`ml-2 text-xs font-medium ${changeColor(pool.change24h)}`}>
                  {changeArrow(pool.change24h)} {Math.abs(pool.change24h).toFixed(2)}%
                </span>
              </div>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-3 gap-px bg-white/5 mx-6 mb-4 rounded-xl overflow-hidden">
              <div className="bg-surface-800/80 p-3 text-center">
                <p className="text-[10px] uppercase tracking-wide text-gray-500">Base APY</p>
                <p className="text-lg font-bold text-emerald-400">{pool.baseApy}%</p>
              </div>
              <div className="bg-surface-800/80 p-3 text-center">
                <p className="text-[10px] uppercase tracking-wide text-gray-500">Boosted APY</p>
                <p className="text-lg font-bold text-yellow-400">{pool.boostApy}%</p>
              </div>
              <div className="bg-surface-800/80 p-3 text-center">
                <p className="text-[10px] uppercase tracking-wide text-gray-500">sMUSD-{pool.symbol}</p>
                <p className="text-lg font-bold text-white">{pool.position > 0 ? pool.position.toFixed(4) : "—"}</p>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-3 px-6 pb-6">
              <button
                onClick={() => { setSelectedPool(pool.id); setAction("deposit"); setFlowStep("idle"); setFlowError(null); setAmount(""); }}
                className={`flex-1 rounded-xl py-3 text-sm font-semibold transition-all ${
                  selectedPool === pool.id && action === "deposit"
                    ? `bg-gradient-to-r ${pool.gradient} text-white shadow-lg`
                    : "bg-white/10 text-white hover:bg-white/20"
                }`}
              >
                Deposit
              </button>
              <button
                onClick={() => { setSelectedPool(pool.id); setAction("withdraw"); setFlowStep("idle"); setFlowError(null); setAmount(""); }}
                className={`flex-1 rounded-xl py-3 text-sm font-semibold transition-all ${
                  selectedPool === pool.id && action === "withdraw"
                    ? "bg-white/20 text-white ring-1 ring-white/30"
                    : "bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white"
                }`}
                disabled={pool.position <= 0}
              >
                Withdraw
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* ── Deposit / Withdraw Panel ──────────────────────────── */}
      {selectedPool && selectedPoolData && (
        <div className="rounded-2xl border border-white/10 bg-surface-800/60 overflow-hidden">
          {/* Panel Header */}
          <div className={`flex items-center gap-4 p-6 bg-gradient-to-r ${selectedPoolData.gradient}`}>
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/20">
              <span className="text-xl font-bold text-white">{selectedPoolData.symbol === "BTC" ? "₿" : "Ξ"}</span>
            </div>
            <div>
              <h3 className="text-lg font-bold text-white">
                {action === "deposit" ? "Deposit to" : "Withdraw from"} {selectedPoolData.name}
              </h3>
              <p className="text-sm text-white/70">
                {action === "deposit"
                  ? `Enter USDC amount → mint mUSD → bridge to Canton → auto-stake → receive sMUSD-${selectedPoolData?.symbol}`
                  : `Unstake your sMUSD-${selectedPoolData?.symbol} position to receive mUSD`}
              </p>
            </div>
          </div>

          <div className="p-6 space-y-6">
            {/* Progress Steps (deposit only) */}
            {action === "deposit" && flowStep !== "idle" && (
              <div className="flex items-center justify-between rounded-xl bg-surface-900/50 p-4">
                {(["approve", "mint", "bridge", "stake", "done"] as FlowStep[]).map((step, i) => {
                  const meta = STEP_META[step];
                  const currentIdx = STEP_META[flowStep].num;
                  const isActive = meta.num === currentIdx;
                  const isDone   = meta.num < currentIdx;
                  return (
                    <React.Fragment key={step}>
                      {i > 0 && (
                        <div className={`h-0.5 flex-1 mx-1 rounded-full transition-colors ${isDone ? "bg-emerald-500" : "bg-white/10"}`} />
                      )}
                      <div className="flex flex-col items-center gap-1">
                        <div className={`flex h-8 w-8 items-center justify-center rounded-full text-sm transition-all ${
                          isDone ? "bg-emerald-500 text-white"
                            : isActive ? "bg-brand-500 text-white ring-2 ring-brand-500/50 animate-pulse"
                            : "bg-white/10 text-gray-500"
                        }`}>
                          {isDone ? "✓" : meta.num}
                        </div>
                        <span className={`text-[10px] ${isActive ? "text-white font-medium" : "text-gray-500"}`}>{meta.label}</span>
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>
            )}

            {/* Amount Input */}
            {flowStep !== "done" && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-gray-400">
                    {action === "deposit" ? "USDC Amount" : `sMUSD-${selectedPoolData?.symbol} to Unstake`}
                  </label>
                  <span className="text-xs text-gray-500">
                    Balance: {action === "deposit" ? formatToken(usdcBal, 6) : positions[selectedPool].toFixed(4)}
                  </span>
                </div>
                <div className="relative rounded-xl border border-white/10 bg-surface-900/50 p-4 transition-all focus-within:border-emerald-500/50 focus-within:shadow-[0_0_20px_-5px_rgba(16,185,129,0.2)]">
                  <div className="flex items-center gap-4">
                    <input
                      type="number"
                      className="flex-1 bg-transparent text-2xl font-semibold text-white placeholder-gray-600 focus:outline-none"
                      placeholder="0.00"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      disabled={loading && flowStep !== "idle"}
                    />
                    <div className="flex items-center gap-2">
                      <button
                        className="rounded-lg bg-emerald-500/20 px-3 py-1.5 text-xs font-semibold text-emerald-400 transition-colors hover:bg-emerald-500/30"
                        onClick={() => setAmount(action === "deposit" ? ethers.formatUnits(usdcBal, USDC_DECIMALS) : positions[selectedPool].toString())}
                      >
                        MAX
                      </button>
                      <div className="flex items-center gap-2 rounded-full bg-surface-700/50 px-3 py-1.5">
                        <div className={`h-5 w-5 rounded-full ${
                          action === "deposit" ? "bg-gradient-to-br from-blue-400 to-blue-600" : selectedPoolData.iconBg
                        }`} />
                        <span className="text-sm font-semibold text-white">
                          {action === "deposit" ? "USDC" : selectedPoolData.id}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Deposit Details */}
            {action === "deposit" && amount && parseFloat(amount) > 0 && flowStep === "idle" && (
              <div className="space-y-2 rounded-xl bg-surface-900/40 p-4">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">You Deposit</span>
                  <span className="text-white font-medium">{parseFloat(amount).toLocaleString()} USDC</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">mUSD Minted</span>
                  <span className="text-white">≈ {parseFloat(amount).toLocaleString()} mUSD</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Mint Fee</span>
                  <span className="text-emerald-400 font-medium">~0.1%</span>
                </div>
                <div className="border-t border-white/5 my-2" />
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Bridge</span>
                  <span className="text-gray-300">Ethereum → Canton (~15s)</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">You Receive</span>
                  <span className="text-white font-medium">sMUSD-{selectedPoolData.symbol} (strategy-dedicated)</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Yield Strategy</span>
                  <span className={selectedPoolData.accentColor}>
                    {selectedPoolData.leverageDisplay} Leveraged {selectedPoolData.symbol} LP
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Yield Isolation</span>
                  <span className="text-yellow-400 font-medium">Dedicated — NOT pooled with other strategies</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Est. APY</span>
                  <span className="text-emerald-400 font-bold">{selectedPoolData.baseApy}% – {selectedPoolData.boostApy}%</span>
                </div>
              </div>
            )}

            {/* Done State */}
            {flowStep === "done" && (
              <div className="flex flex-col items-center gap-4 py-8">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/20">
                  <svg className="h-8 w-8 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold text-white">Auto-Stake Complete!</h3>
                <p className="text-sm text-gray-400 text-center max-w-sm">
                  Your USDC has been minted to mUSD, bridged to Canton, and auto-staked into
                  sMUSD-{selectedPoolData.symbol}. You&apos;re now earning dedicated {selectedPoolData.symbol} strategy yield.
                </p>
                {flowTxHash && (
                  <a href={`https://etherscan.io/tx/${flowTxHash}`} target="_blank" rel="noopener noreferrer"
                    className="text-sm text-brand-400 hover:underline">
                    View Mint Transaction ↗
                  </a>
                )}
                <button
                  onClick={() => { setFlowStep("idle"); setSelectedPool(null); }}
                  className="mt-2 rounded-xl bg-white/10 px-6 py-2.5 text-sm font-medium text-white hover:bg-white/20"
                >
                  Back to Pools
                </button>
              </div>
            )}

            {/* Action Button */}
            {flowStep !== "done" && (
              <button
                onClick={action === "deposit" ? handleDeposit : handleWithdraw}
                disabled={loading || !amount || parseFloat(amount) <= 0}
                className={`w-full rounded-xl py-4 text-base font-semibold transition-all ${
                  loading ? "bg-white/10 text-gray-400 cursor-wait"
                    : `bg-gradient-to-r ${selectedPoolData.gradient} text-white shadow-lg hover:shadow-xl hover:brightness-110`
                }`}
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-3">
                    <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    {STEP_META[flowStep].label}...
                  </span>
                ) : action === "deposit" ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    Mint &amp; Stake → sMUSD-{selectedPoolData.symbol}
                  </span>
                ) : (
                  <span>Unstake sMUSD-{selectedPoolData.symbol} → mUSD</span>
                )}
              </button>
            )}

            {/* Error Feedback */}
            {flowError && (
              <div className="flex items-center gap-3 rounded-xl bg-red-500/10 border border-red-500/20 p-4">
                <svg className="h-5 w-5 flex-shrink-0 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-sm text-red-400">{flowError}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Your Positions Summary ────────────────────────────── */}
      {(positions.btcPool > 0 || positions.ethPool > 0) && (
        <div className="rounded-2xl border border-white/10 bg-surface-800/50 p-6">
          <h2 className="mb-4 text-lg font-semibold text-white">Your Strategy Positions</h2>
          <div className="space-y-3">
            {poolsWithPrices.filter((p) => p.position > 0).map((pool) => (
              <div key={pool.id} className="flex items-center justify-between rounded-xl bg-surface-900/40 p-4">
                <div className="flex items-center gap-3">
                  <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${pool.iconBg}`}>
                    <span className="text-sm font-bold text-white">{pool.symbol === "BTC" ? "₿" : "Ξ"}</span>
                  </div>
                  <div>
                    <p className="font-medium text-white">sMUSD-{pool.symbol}</p>
                    <p className="text-xs text-gray-500">{pool.name} · {pool.leverageDisplay} leverage · {pool.baseApy}% APY</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="font-semibold text-white">${pool.position.toFixed(2)}</p>
                  <p className="text-xs text-emerald-400">sMUSD-{pool.symbol} · Earning yield</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── How It Works ───────────────────────────────────────── */}
      <div className="rounded-2xl border border-white/5 bg-surface-800/30 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">How Strategy-Dedicated sMUSD Works</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl bg-surface-900/40 p-4 border border-white/5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-orange-500/20 text-orange-400 font-bold text-sm mb-3">1</div>
            <h3 className="font-medium text-white mb-1">Strategy-Dedicated sMUSD</h3>
            <p className="text-xs text-gray-400">
              Your mUSD is auto-staked into sMUSD-BTC or sMUSD-ETH. Each variant is isolated —
              your yield comes exclusively from that strategy&apos;s 2x leveraged Curve LP.
            </p>
          </div>
          <div className="rounded-xl bg-surface-900/40 p-4 border border-white/5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-500/20 text-blue-400 font-bold text-sm mb-3">2</div>
            <h3 className="font-medium text-white mb-1">Isolated Yield Pools</h3>
            <p className="text-xs text-gray-400">
              sMUSD-BTC and sMUSD-ETH are NOT pooled with each other or general sMUSD.
              Each pool has its own share price, yield rate, and deposit cap.
            </p>
          </div>
          <div className="rounded-xl bg-surface-900/40 p-4 border border-white/5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400 font-bold text-sm mb-3">3</div>
            <h3 className="font-medium text-white mb-1">Canton Settlement</h3>
            <p className="text-xs text-gray-400">
              All vault operations are settled on Canton Network via DAML smart contracts,
              providing atomic composability and privacy-preserving execution.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
