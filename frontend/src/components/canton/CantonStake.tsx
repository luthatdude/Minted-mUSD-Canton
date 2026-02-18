import React, { useState, useEffect, useCallback } from "react";
import { TxButton } from "@/components/TxButton";
import { StatCard } from "@/components/StatCard";
import { PageHeader } from "@/components/PageHeader";
import { useLoopWallet, LoopContract } from "@/hooks/useLoopWallet";
import { useCantonBoostPool } from "@/hooks/useCantonBoostPool";
import WalletConnector from "@/components/WalletConnector";

// ─── DAML Template IDs ──────────────────────────────────────────────────────
const PACKAGE_ID = process.env.NEXT_PUBLIC_DAML_PACKAGE_ID || "";
const templates = {
  StakingService:  `${PACKAGE_ID}:CantonSMUSD:CantonStakingService`,
  SMUSD:           `${PACKAGE_ID}:CantonSMUSD:CantonSMUSD`,
  MUSD:            `${PACKAGE_ID}:CantonDirectMint:CantonMUSD`,
  ETHPoolService:  `${PACKAGE_ID}:CantonETHPool:CantonETHPoolService`,
  SMUSDE:          `${PACKAGE_ID}:CantonETHPool:CantonSMUSD_E`,
  ETHPosition:     `${PACKAGE_ID}:CantonETHPool:ETHPoolPosition`,
  BoostPoolService:`${PACKAGE_ID}:CantonBoostPool:BoostPoolService`,
  BoostLP:         `${PACKAGE_ID}:CantonBoostPool:BoostPoolLP`,
  CantonCoin:      `${PACKAGE_ID}:CantonCoinToken:CantonCoin`,
};

// ─── Types ──────────────────────────────────────────────────────────────────
type CantonPoolTab = "smusd" | "ethpool" | "boost";

const CANTON_POOL_CONFIG = [
  { key: "smusd" as CantonPoolTab, label: "smUSD", badge: "Global Yield", color: "from-emerald-500 to-teal-500" },
  { key: "ethpool" as CantonPoolTab, label: "ETH Pool", badge: "smUSD-E", color: "from-blue-500 to-indigo-500" },
  { key: "boost" as CantonPoolTab, label: "Boost Pool", badge: "Validator", color: "from-yellow-400 to-orange-500" },
];

const TIER_LABELS: Record<number, string> = {
  0: "No Lock (1.0×)",
  1: "30 Days (1.25×)",
  2: "90 Days (1.5×)",
  3: "180 Days (2.0×)",
};

// ─── Component ──────────────────────────────────────────────────────────────
export function CantonStake() {
  const loopWallet = useLoopWallet();
  const boostPool = useCantonBoostPool();

  const [pool, setPool] = useState<CantonPoolTab>("smusd");
  const [tab, setTab] = useState<"stake" | "unstake">("stake");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── smUSD state ──
  const [stakingServiceId, setStakingServiceId] = useState("");
  const [musdContracts, setMusdContracts] = useState<LoopContract[]>([]);
  const [smusdContracts, setSmusdContracts] = useState<LoopContract[]>([]);

  // ── ETH Pool state ──
  const [ethPoolServiceId, setEthPoolServiceId] = useState("");
  const [ethPositions, setEthPositions] = useState<LoopContract[]>([]);
  const [smusdeContracts, setSmusdeContracts] = useState<LoopContract[]>([]);
  const [lockTier, setLockTier] = useState(0);
  const [selectedPositionId, setSelectedPositionId] = useState<string | null>(null);

  // ── Boost Pool state ──
  const [boostServiceId, setBoostServiceId] = useState("");
  const [boostLPs, setBoostLPs] = useState<LoopContract[]>([]);
  const [cantonCoinContracts, setCantonCoinContracts] = useState<LoopContract[]>([]);

  // ═══════════════════════════════════════════════════════════════════════════
  //  Load Contracts
  // ═══════════════════════════════════════════════════════════════════════════
  const loadContracts = useCallback(async () => {
    if (!loopWallet.isConnected) return;
    try {
      const [stakingSvc, musd, smusd, ethSvc, smusde, ethPos, boostSvc, boostLp, cantonCoin] =
        await Promise.all([
          loopWallet.queryContracts(templates.StakingService).catch(() => []),
          loopWallet.queryContracts(templates.MUSD).catch(() => []),
          loopWallet.queryContracts(templates.SMUSD).catch(() => []),
          loopWallet.queryContracts(templates.ETHPoolService).catch(() => []),
          loopWallet.queryContracts(templates.SMUSDE).catch(() => []),
          loopWallet.queryContracts(templates.ETHPosition).catch(() => []),
          loopWallet.queryContracts(templates.BoostPoolService).catch(() => []),
          loopWallet.queryContracts(templates.BoostLP).catch(() => []),
          loopWallet.queryContracts(templates.CantonCoin).catch(() => []),
        ]);
      if (stakingSvc.length > 0) setStakingServiceId(stakingSvc[0].contractId);
      setMusdContracts(musd);
      setSmusdContracts(smusd);
      if (ethSvc.length > 0) setEthPoolServiceId(ethSvc[0].contractId);
      setSmusdeContracts(smusde);
      setEthPositions(ethPos);
      if (boostSvc.length > 0) setBoostServiceId(boostSvc[0].contractId);
      setBoostLPs(boostLp);
      setCantonCoinContracts(cantonCoin);
    } catch (err) {
      console.error("Failed to load Canton staking contracts:", err);
    }
  }, [loopWallet.isConnected, loopWallet.queryContracts]);

  useEffect(() => { loadContracts(); }, [loadContracts]);

  // ═══════════════════════════════════════════════════════════════════════════
  //  Derived Values
  // ═══════════════════════════════════════════════════════════════════════════
  const totalMusd = musdContracts.reduce((s, c) => s + parseFloat(c.payload?.amount || c.payload?.shares || "0"), 0);
  const totalSmusd = smusdContracts.reduce((s, c) => s + parseFloat(c.payload?.shares || "0"), 0);
  const totalSmusde = smusdeContracts.reduce((s, c) => s + parseFloat(c.payload?.shares || "0"), 0);
  const totalCantonCoin = cantonCoinContracts.reduce((s, c) => s + parseFloat(c.payload?.amount || "0"), 0);
  const totalBoostLP = boostLPs.reduce((s, c) => s + parseFloat(c.payload?.shares || "0"), 0);
  const maxBoostDeposit = totalSmusd * 0.25; // 80/20 rule

  // ═══════════════════════════════════════════════════════════════════════════
  //  Handlers
  // ═══════════════════════════════════════════════════════════════════════════
  async function handleSmusdStake() {
    if (!stakingServiceId || musdContracts.length === 0) return;
    setLoading(true); setError(null); setResult(null);
    try {
      await loopWallet.exerciseChoice(
        templates.StakingService, stakingServiceId,
        "StakingService_Stake",
        { musdCid: musdContracts[0].contractId, amount }
      );
      setResult(`Staked ${amount} mUSD → smUSD on Canton`);
      setAmount(""); await loadContracts();
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  }

  async function handleSmusdUnstake() {
    if (!stakingServiceId || smusdContracts.length === 0) return;
    setLoading(true); setError(null); setResult(null);
    try {
      await loopWallet.exerciseChoice(
        templates.StakingService, stakingServiceId,
        "StakingService_Unstake",
        { smusdCid: smusdContracts[0].contractId, sharesToRedeem: amount }
      );
      setResult(`Unstaked ${amount} smUSD → mUSD on Canton`);
      setAmount(""); await loadContracts();
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  }

  async function handleEthPoolStake() {
    if (!ethPoolServiceId || musdContracts.length === 0) return;
    setLoading(true); setError(null); setResult(null);
    try {
      await loopWallet.exerciseChoice(
        templates.ETHPoolService, ethPoolServiceId,
        "ETHPool_StakeWithMUSD",
        { musdCid: musdContracts[0].contractId, amount, tier: lockTier.toString() }
      );
      setResult(`Deposited ${amount} mUSD → smUSD-E on Canton (${TIER_LABELS[lockTier]})`);
      setAmount(""); await loadContracts();
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  }

  async function handleEthPoolUnstake() {
    if (!ethPoolServiceId || !selectedPositionId) return;
    setLoading(true); setError(null); setResult(null);
    try {
      await loopWallet.exerciseChoice(
        templates.ETHPoolService, ethPoolServiceId,
        "ETHPool_Unstake",
        { positionCid: selectedPositionId }
      );
      setResult("Unstaked ETH Pool position on Canton");
      setSelectedPositionId(null); await loadContracts();
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  }

  async function handleBoostDeposit() {
    if (!boostServiceId || cantonCoinContracts.length === 0) return;
    setLoading(true); setError(null); setResult(null);
    try {
      await loopWallet.exerciseChoice(
        templates.BoostPoolService, boostServiceId,
        "BoostPool_Deposit",
        { cantonCoinCid: cantonCoinContracts[0].contractId, amount }
      );
      setResult(`Deposited ${amount} CantonCoin into Boost Pool`);
      setAmount(""); await loadContracts();
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  }

  async function handleBoostWithdraw() {
    if (!boostServiceId || boostLPs.length === 0) return;
    setLoading(true); setError(null); setResult(null);
    try {
      await loopWallet.exerciseChoice(
        templates.BoostPoolService, boostServiceId,
        "BoostPool_Withdraw",
        { lpCid: boostLPs[0].contractId, shares: amount }
      );
      setResult(`Withdrew ${amount} LP from Boost Pool`);
      setAmount(""); await loadContracts();
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Render
  // ═══════════════════════════════════════════════════════════════════════════
  if (!loopWallet.isConnected) return <WalletConnector mode="canton" />;

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <PageHeader
        title="Canton Staking"
        subtitle="Stake through DAML smart contracts with privacy-preserving transactions"
        badge="Canton"
        badgeColor="purple"
      />

      {/* Pool Selector */}
      <div className="flex gap-2 rounded-xl bg-surface-800/50 p-1.5 border border-white/10">
        {CANTON_POOL_CONFIG.map(({ key, label, badge, color }) => (
          <button
            key={key}
            onClick={() => { setPool(key); setTab("stake"); setAmount(""); setError(null); setResult(null); }}
            className={`relative flex-1 rounded-lg px-4 py-3 text-sm font-semibold transition-all duration-300 ${
              pool === key
                ? "bg-surface-700 text-white shadow-lg"
                : "text-gray-400 hover:text-white hover:bg-surface-700/50"
            }`}
          >
            <span className="flex items-center justify-center gap-2">
              {label}
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                pool === key
                  ? `bg-gradient-to-r ${color} text-white`
                  : "bg-surface-600 text-gray-500"
              }`}>{badge}</span>
            </span>
            {pool === key && (
              <span className={`absolute bottom-0 left-1/2 h-0.5 w-16 -translate-x-1/2 rounded-full bg-gradient-to-r ${color}`} />
            )}
          </button>
        ))}
      </div>

      {/* ═══════════ CantonSMUSD ═══════════ */}
      {pool === "smusd" && (
        <>
          <div className="grid gap-8 lg:grid-cols-2">
            {/* LEFT column: Action Card */}
            <div>
              {/* Stake / Unstake Card */}
              <div className="card-gradient-border overflow-hidden">
                <div className="flex border-b border-white/10">
                  <button
                    className={`relative flex-1 px-6 py-4 text-center text-sm font-semibold transition-all ${tab === "stake" ? "text-white" : "text-gray-400 hover:text-white"}`}
                    onClick={() => { setTab("stake"); setAmount(""); }}
                  >
                    Stake mUSD
                    {tab === "stake" && <span className="absolute bottom-0 left-1/2 h-0.5 w-24 -translate-x-1/2 rounded-full bg-gradient-to-r from-emerald-500 to-teal-500" />}
                  </button>
                  <button
                    className={`relative flex-1 px-6 py-4 text-center text-sm font-semibold transition-all ${tab === "unstake" ? "text-white" : "text-gray-400 hover:text-white"}`}
                    onClick={() => { setTab("unstake"); setAmount(""); }}
                  >
                    Unstake smUSD
                    {tab === "unstake" && <span className="absolute bottom-0 left-1/2 h-0.5 w-24 -translate-x-1/2 rounded-full bg-gradient-to-r from-emerald-500 to-teal-500" />}
                  </button>
                </div>
                <div className="space-y-6 p-6">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium text-gray-400">{tab === "stake" ? "mUSD to Stake" : "smUSD to Unstake"}</label>
                      <span className="text-xs text-gray-500">Balance: {(tab === "stake" ? totalMusd : totalSmusd).toFixed(2)}</span>
                    </div>
                    <div className="relative rounded-xl border border-white/10 bg-surface-800/50 p-4 focus-within:border-emerald-500/50">
                      <div className="flex items-center gap-4">
                        <input
                          type="number"
                          className="flex-1 bg-transparent text-2xl font-semibold text-white placeholder-gray-600 focus:outline-none"
                          placeholder="0.00"
                          value={amount}
                          onChange={e => setAmount(e.target.value)}
                        />
                        <button
                          className="rounded-lg bg-emerald-500/20 px-3 py-1.5 text-xs font-semibold text-emerald-400 hover:bg-emerald-500/30"
                          onClick={() => setAmount((tab === "stake" ? totalMusd : totalSmusd).toString())}
                        >MAX</button>
                        <span className="font-semibold text-white">{tab === "stake" ? "mUSD" : "smUSD"}</span>
                      </div>
                    </div>
                  </div>
                  <TxButton
                    onClick={tab === "stake" ? handleSmusdStake : handleSmusdUnstake}
                    loading={loading}
                    disabled={!amount || parseFloat(amount) <= 0}
                    variant="primary"
                    className="w-full py-4 text-sm font-semibold"
                  >
                    {tab === "stake" ? "Stake mUSD → smUSD" : "Unstake smUSD → mUSD"}
                  </TxButton>
                  {error && <div className="alert-error text-sm">{error}</div>}
                  {result && <div className="alert-success text-sm">{result}</div>}
                </div>
              </div>
            </div>

            {/* RIGHT column: Stats + Info */}
            <div className="space-y-4">
              <div className="grid gap-4 grid-cols-2">
                <StatCard label="Your mUSD" value={totalMusd.toFixed(2)} color="blue" />
                <StatCard label="Your smUSD" value={totalSmusd.toFixed(2)} color="green" />
                <StatCard label="Yield Model" value="Global Share Price" color="purple" />
                <StatCard label="Cooldown" value="24 hours" color="yellow" />
              </div>

              <div className="card overflow-hidden border-l-4 border-emerald-500">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/20 flex-shrink-0">
                    <span className="text-emerald-400 font-bold">S</span>
                  </div>
                  <div>
                    <h3 className="font-semibold text-white mb-1">CantonSMUSD — Global Yield Staking</h3>
                    <p className="text-sm text-gray-400">
                      Stake mUSD → smUSD on Canton. Yield comes from a unified global share price synced from Ethereum,
                      ensuring equal yield distribution across both chains. smUSD is accepted as collateral (CTN_SMUSD) for lending.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ═══════════ CantonETHPool ═══════════ */}
      {pool === "ethpool" && (
        <>
          <div className="grid gap-8 lg:grid-cols-2">
            {/* LEFT column: Action Card */}
            <div>
              <div className="card-gradient-border overflow-hidden">
                <div className="flex border-b border-white/10">
                  <button
                    className={`relative flex-1 px-6 py-4 text-center text-sm font-semibold transition-all ${tab === "stake" ? "text-white" : "text-gray-400 hover:text-white"}`}
                    onClick={() => { setTab("stake"); setAmount(""); }}
                  >
                    Deposit
                    {tab === "stake" && <span className="absolute bottom-0 left-1/2 h-0.5 w-24 -translate-x-1/2 rounded-full bg-gradient-to-r from-blue-500 to-indigo-500" />}
                  </button>
                  <button
                    className={`relative flex-1 px-6 py-4 text-center text-sm font-semibold transition-all ${tab === "unstake" ? "text-white" : "text-gray-400 hover:text-white"}`}
                    onClick={() => { setTab("unstake"); setAmount(""); }}
                  >
                    Withdraw
                    {tab === "unstake" && <span className="absolute bottom-0 left-1/2 h-0.5 w-24 -translate-x-1/2 rounded-full bg-gradient-to-r from-blue-500 to-indigo-500" />}
                  </button>
                </div>
                <div className="space-y-6 p-6">
                  {tab === "stake" ? (
                    <>
                      {/* Lock Tier Selector */}
                      <div className="space-y-3">
                        <label className="text-sm font-medium text-gray-400">Time-Lock Boost</label>
                        <div className="grid grid-cols-2 gap-2">
                          {[0, 1, 2, 3].map(tier => (
                            <button
                              key={tier}
                              onClick={() => setLockTier(tier)}
                              className={`rounded-xl border px-4 py-3 text-sm font-semibold transition-all ${
                                lockTier === tier
                                  ? "border-blue-500 bg-blue-500/20 text-white"
                                  : "border-white/10 bg-surface-800/50 text-gray-400 hover:border-white/30"
                              }`}
                            >
                              {TIER_LABELS[tier]}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <label className="text-sm font-medium text-gray-400">mUSD Amount</label>
                          <span className="text-xs text-gray-500">Balance: {totalMusd.toFixed(2)}</span>
                        </div>
                        <div className="relative rounded-xl border border-white/10 bg-surface-800/50 p-4 focus-within:border-blue-500/50">
                          <div className="flex items-center gap-4">
                            <input
                              type="number"
                              className="flex-1 bg-transparent text-2xl font-semibold text-white placeholder-gray-600 focus:outline-none"
                              placeholder="0.00"
                              value={amount}
                              onChange={e => setAmount(e.target.value)}
                            />
                            <button
                              className="rounded-lg bg-blue-500/20 px-3 py-1.5 text-xs font-semibold text-blue-400 hover:bg-blue-500/30"
                              onClick={() => setAmount(totalMusd.toString())}
                            >MAX</button>
                            <span className="font-semibold text-white">mUSD</span>
                          </div>
                        </div>
                      </div>

                      <TxButton
                        onClick={handleEthPoolStake}
                        loading={loading}
                        disabled={!amount || parseFloat(amount) <= 0}
                        variant="primary"
                        className="w-full py-4 text-sm font-semibold"
                      >
                        {`Deposit mUSD → smUSD-E (${TIER_LABELS[lockTier]})`}
                      </TxButton>
                    </>
                  ) : (
                    <>
                      {ethPositions.length === 0 ? (
                        <div className="text-center py-12">
                          <p className="text-gray-400 font-medium">No active positions</p>
                          <p className="text-sm text-gray-500 mt-1">Switch to Deposit tab to create a staking position</p>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <label className="text-sm font-medium text-gray-400">Select Position</label>
                          {ethPositions.map(pos => (
                            <button
                              key={pos.contractId}
                              onClick={() => setSelectedPositionId(pos.contractId)}
                              className={`w-full rounded-xl border p-4 text-left transition-all ${
                                selectedPositionId === pos.contractId
                                  ? "border-blue-500 bg-blue-500/10"
                                  : "border-white/10 bg-surface-800/50 hover:border-white/30"
                              }`}
                            >
                              <div className="grid grid-cols-3 gap-4 text-sm">
                                <div>
                                  <p className="text-gray-500">mUSD Staked</p>
                                  <p className="text-white font-medium">{parseFloat(pos.payload?.musdStaked || "0").toFixed(2)}</p>
                                </div>
                                <div>
                                  <p className="text-gray-500">smUSD-E Shares</p>
                                  <p className="text-white font-medium">{parseFloat(pos.payload?.shares || "0").toFixed(2)}</p>
                                </div>
                                <div>
                                  <p className="text-gray-500">Tier</p>
                                  <p className="text-white font-medium">{TIER_LABELS[Number(pos.payload?.tier || 0)]}</p>
                                </div>
                              </div>
                            </button>
                          ))}
                          <TxButton
                            onClick={handleEthPoolUnstake}
                            loading={loading}
                            disabled={!selectedPositionId}
                            variant="primary"
                            className="w-full py-4 text-sm font-semibold"
                          >
                            Unstake Position
                          </TxButton>
                        </div>
                      )}
                    </>
                  )}
                  {error && <div className="alert-error text-sm">{error}</div>}
                  {result && <div className="alert-success text-sm">{result}</div>}
                </div>
              </div>
            </div>

            {/* RIGHT column: Stats + Info */}
            <div className="space-y-4">
              <div className="grid gap-4 grid-cols-2">
                <StatCard label="Your smUSD-E" value={totalSmusde.toFixed(2)} color="blue" />
                <StatCard label="Positions" value={ethPositions.length.toString()} color="green" />
                <StatCard label="Deposit Assets" value="mUSD, USDC, CTN" color="purple" />
                <StatCard label="Collateral" value="CTN_SMUSDE" color="yellow" />
              </div>

              <div className="card overflow-hidden border-l-4 border-blue-500">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-500/20 flex-shrink-0">
                    <span className="text-blue-400 font-bold">E</span>
                  </div>
                  <div>
                    <h3 className="font-semibold text-white mb-1">CantonETHPool — Fluid Strategy Yield</h3>
                    <p className="text-sm text-gray-400">
                      Deposit mUSD, USDC, or CantonCoin. Every deposit mints mUSD first, then stakes for smUSD-E shares.
                      Optional time-lock tiers (up to 2×) boost your yield. smUSD-E is accepted as collateral with 85% LTV.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ═══════════ CantonBoostPool ═══════════ */}
      {pool === "boost" && (
        <>
          <div className="grid gap-8 lg:grid-cols-2">
            {/* LEFT column: Action Card */}
            <div>
              <div className="card-gradient-border overflow-hidden">
                <div className="flex border-b border-white/10">
                  <button
                    className={`relative flex-1 px-6 py-4 text-center text-sm font-semibold transition-all ${tab === "stake" ? "text-white" : "text-gray-400 hover:text-white"}`}
                    onClick={() => { setTab("stake"); setAmount(""); }}
                  >
                    Deposit CantonCoin
                    {tab === "stake" && <span className="absolute bottom-0 left-1/2 h-0.5 w-24 -translate-x-1/2 rounded-full bg-gradient-to-r from-yellow-400 to-orange-500" />}
                  </button>
                  <button
                    className={`relative flex-1 px-6 py-4 text-center text-sm font-semibold transition-all ${tab === "unstake" ? "text-white" : "text-gray-400 hover:text-white"}`}
                    onClick={() => { setTab("unstake"); setAmount(""); }}
                  >
                    Withdraw
                    {tab === "unstake" && <span className="absolute bottom-0 left-1/2 h-0.5 w-24 -translate-x-1/2 rounded-full bg-gradient-to-r from-yellow-400 to-orange-500" />}
                  </button>
                </div>
                <div className="space-y-6 p-6">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium text-gray-400">
                        {tab === "stake" ? "CantonCoin to Deposit" : "LP Shares to Withdraw"}
                      </label>
                      <span className="text-xs text-gray-500">
                        {tab === "stake"
                          ? `Balance: ${totalCantonCoin.toFixed(2)} CTN | Max: ${maxBoostDeposit.toFixed(2)}`
                          : `LP Balance: ${totalBoostLP.toFixed(2)}`}
                      </span>
                    </div>
                    <div className="relative rounded-xl border border-white/10 bg-surface-800/50 p-4 focus-within:border-yellow-500/50">
                      <div className="flex items-center gap-4">
                        <input
                          type="number"
                          className="flex-1 bg-transparent text-2xl font-semibold text-white placeholder-gray-600 focus:outline-none"
                          placeholder="0.00"
                          value={amount}
                          onChange={e => setAmount(e.target.value)}
                        />
                        <button
                          className="rounded-lg bg-yellow-500/20 px-3 py-1.5 text-xs font-semibold text-yellow-400 hover:bg-yellow-500/30"
                          onClick={() => setAmount(
                            tab === "stake"
                              ? Math.min(totalCantonCoin, maxBoostDeposit).toString()
                              : totalBoostLP.toString()
                          )}
                        >MAX</button>
                        <span className="font-semibold text-white">{tab === "stake" ? "CTN" : "LP"}</span>
                      </div>
                    </div>
                  </div>

                  {/* Over-cap warning */}
                  {tab === "stake" && amount && parseFloat(amount) > maxBoostDeposit && (
                    <div className="alert-error text-sm">
                      Deposit exceeds your cap of {maxBoostDeposit.toFixed(2)} CTN (25% of your {totalSmusd.toFixed(2)} smUSD position).
                    </div>
                  )}

                  <TxButton
                    onClick={tab === "stake" ? handleBoostDeposit : handleBoostWithdraw}
                    loading={loading}
                    disabled={
                      !amount || parseFloat(amount) <= 0
                      || (tab === "stake" && totalSmusd <= 0)
                      || (tab === "stake" && parseFloat(amount) > maxBoostDeposit)
                    }
                    variant="primary"
                    className="w-full py-4 text-sm font-semibold"
                  >
                    {tab === "stake"
                      ? "Deposit CantonCoin → Boost Pool"
                      : "Withdraw from Boost Pool"}
                  </TxButton>

                  {error && <div className="alert-error text-sm">{error}</div>}
                  {result && <div className="alert-success text-sm">{result}</div>}
                </div>
              </div>
            </div>

            {/* RIGHT column: Stats + Info + Eligibility */}
            <div className="space-y-4">
              <div className="grid gap-4 grid-cols-2">
                <StatCard label="Your CantonCoin" value={totalCantonCoin.toFixed(2)} color="yellow" />
                <StatCard label="Your Boost LP" value={totalBoostLP.toFixed(2)} color="green" />
                <StatCard label="Max Deposit" value={maxBoostDeposit.toFixed(2)} subValue="25% of smUSD" color="purple" />
                <StatCard label="Yield Source" value="Validators (60%)" color="blue" />
              </div>

              <div className="card overflow-hidden border-l-4 border-yellow-500">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-yellow-500/20 flex-shrink-0">
                    <span className="text-yellow-400 font-bold">C</span>
                  </div>
                  <div>
                    <h3 className="font-semibold text-white mb-1">CantonBoostPool — Validator Rewards</h3>
                    <p className="text-sm text-gray-400 mb-2">
                      Deposit CantonCoin to earn validator rewards (60% of Canton validator revenue).
                      Your deposit cap is limited to 25% of your smUSD position value, enforcing an 80/20 ratio.
                      This is a Canton-native-only pool with no bridge integration.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <span className="rounded-full bg-yellow-500/20 px-3 py-1 text-xs font-semibold text-yellow-400">Canton-Only</span>
                      <span className="rounded-full bg-yellow-500/20 px-3 py-1 text-xs font-semibold text-yellow-400">Limited-Time</span>
                      <span className="rounded-full bg-yellow-500/20 px-3 py-1 text-xs font-semibold text-yellow-400">80/20 Ratio</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Eligibility Check */}
              {totalSmusd <= 0 && (
                <div className="alert-warning flex items-center gap-3">
                  <svg className="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z" />
                  </svg>
                  <span className="text-sm">
                    You need an smUSD staking position to be eligible for the Boost Pool.
                    Stake mUSD in the smUSD tab first.
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Revenue Model — FULL-WIDTH below the grid */}
          <div className="card">
            <div className="flex items-center gap-3 mb-5">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-yellow-500/20">
                <svg className="h-5 w-5 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-white">How Boost Pool Works</h2>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-yellow-500/20 text-yellow-400 font-bold text-sm mb-3">1</div>
                <h3 className="font-medium text-white mb-1">Stake smUSD First</h3>
                <p className="text-sm text-gray-400">Your smUSD position determines your CantonCoin deposit cap (25% of smUSD value).</p>
              </div>
              <div className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-orange-500/20 text-orange-400 font-bold text-sm mb-3">2</div>
                <h3 className="font-medium text-white mb-1">Deposit CantonCoin</h3>
                <p className="text-sm text-gray-400">Deposit CTN up to your cap. You receive Boost LP tokens representing your pool share.</p>
              </div>
              <div className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400 font-bold text-sm mb-3">3</div>
                <h3 className="font-medium text-white mb-1">Earn Dual Yield</h3>
                <p className="text-sm text-gray-400">Earn both smUSD yield (TreasuryV2 strategies) and 60% of Canton validator revenue.</p>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ═══════════ Canton Lending Table — FULL-WIDTH ═══════════ */}
      <div className="card">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-purple-500/20">
            <svg className="h-5 w-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-white">Canton Lending &amp; Borrowing</h2>
        </div>
        <p className="text-sm text-gray-400 mb-4">
          Both smUSD and smUSD-E are accepted as collateral in Canton&apos;s yield-bearing lending module.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10">
                <th className="text-left py-3 px-4 text-gray-400 font-medium">Token</th>
                <th className="text-right py-3 px-4 text-gray-400 font-medium">LTV</th>
                <th className="text-right py-3 px-4 text-gray-400 font-medium">Liq. Threshold</th>
                <th className="text-right py-3 px-4 text-gray-400 font-medium">Liq. Penalty</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-white/5">
                <td className="py-3 px-4">
                  <div className="flex items-center gap-2">
                    <div className="h-5 w-5 rounded-full bg-gradient-to-br from-emerald-500 to-teal-500" />
                    <span className="text-white font-medium">smUSD</span>
                  </div>
                </td>
                <td className="text-right py-3 px-4 text-white">85%</td>
                <td className="text-right py-3 px-4 text-white">90%</td>
                <td className="text-right py-3 px-4 text-white">5%</td>
              </tr>
              <tr>
                <td className="py-3 px-4">
                  <div className="flex items-center gap-2">
                    <div className="h-5 w-5 rounded-full bg-gradient-to-br from-blue-500 to-indigo-500" />
                    <span className="text-white font-medium">smUSD-E</span>
                  </div>
                </td>
                <td className="text-right py-3 px-4 text-white">85%</td>
                <td className="text-right py-3 px-4 text-white">90%</td>
                <td className="text-right py-3 px-4 text-white">5%</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default CantonStake;
