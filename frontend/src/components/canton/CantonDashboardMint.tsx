import React, { useState, useEffect, useCallback } from "react";
import { StatCard } from "@/components/StatCard";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/Section";
import { useLoopWallet, LoopContract } from "@/hooks/useLoopWallet";
import WalletConnector from "@/components/WalletConnector";

// ════════════════════════════════════════════════════════════════
// DAML Templates
// ════════════════════════════════════════════════════════════════

const PACKAGE_ID = process.env.NEXT_PUBLIC_DAML_PACKAGE_ID || "";
const templates = {
  MUSD: `${PACKAGE_ID}:MintedProtocolV2Fixed:MUSD`,
  USDC: `${PACKAGE_ID}:MintedProtocolV2Fixed:USDC`,
  Collateral: `${PACKAGE_ID}:MintedProtocolV2Fixed:Collateral`,
  Vault: `${PACKAGE_ID}:MintedProtocolV2Fixed:Vault`,
  TransferProposal: `${PACKAGE_ID}:MintedProtocolV2Fixed:TransferProposal`,
  AttestationRequest: `${PACKAGE_ID}:MintedProtocolV2Fixed:AttestationRequest`,
  DirectMintService: `${PACKAGE_ID}:MintedProtocolV2Fixed:DirectMintService`,
  StakingService: `${PACKAGE_ID}:MintedProtocolV2Fixed:StakingService`,
  PriceOracle: `${PACKAGE_ID}:MintedProtocolV2Fixed:PriceOracle`,
  IssuerRole: `${PACKAGE_ID}:MintedProtocolV2Fixed:IssuerRole`,
  LiquidityPool: `${PACKAGE_ID}:MintedProtocolV2Fixed:LiquidityPool`,
};

// ════════════════════════════════════════════════════════════════
// Component
// ════════════════════════════════════════════════════════════════

export function CantonDashboardMint() {
  const loopWallet = useLoopWallet();

  // ─── Dashboard stats ────────────────────────────────────────
  const [stats, setStats] = useState({
    musdContracts: 0,
    musdTotal: 0,
    usdcContracts: 0,
    usdcTotal: 0,
    collateralContracts: 0,
    collateralTotal: 0,
    vaults: 0,
    proposals: 0,
    attestations: 0,
    mintService: false,
    stakingService: false,
    oracle: false,
    issuerRole: false,
    pool: false,
  });

  // ─── Mint state ─────────────────────────────────────────────
  const [tab, setTab] = useState<"mint" | "redeem">("mint");
  const [amount, setAmount] = useState("");
  const [usdcContractId, setUsdcContractId] = useState("");
  const [musdContractId, setMusdContractId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [txLoading, setTxLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ─── Contract lists ─────────────────────────────────────────
  const [services, setServices] = useState<LoopContract[]>([]);
  const [usdcContracts, setUsdcContracts] = useState<LoopContract[]>([]);
  const [musdContracts, setMusdContracts] = useState<LoopContract[]>([]);

  const [loading, setLoading] = useState(true);

  // ─── Load all data ──────────────────────────────────────────
  const loadData = useCallback(async () => {
    if (!loopWallet.isConnected) return;
    setLoading(true);
    try {
      const [musd, usdc, collateral, vaults, proposals, attestations, mintSvc, stakeSvc, oracleSvc, issuer, pool] =
        await Promise.all([
          loopWallet.queryContracts(templates.MUSD).catch(() => []),
          loopWallet.queryContracts(templates.USDC).catch(() => []),
          loopWallet.queryContracts(templates.Collateral).catch(() => []),
          loopWallet.queryContracts(templates.Vault).catch(() => []),
          loopWallet.queryContracts(templates.TransferProposal).catch(() => []),
          loopWallet.queryContracts(templates.AttestationRequest).catch(() => []),
          loopWallet.queryContracts(templates.DirectMintService).catch(() => []),
          loopWallet.queryContracts(templates.StakingService).catch(() => []),
          loopWallet.queryContracts(templates.PriceOracle).catch(() => []),
          loopWallet.queryContracts(templates.IssuerRole).catch(() => []),
          loopWallet.queryContracts(templates.LiquidityPool).catch(() => []),
        ]);

      setStats({
        musdContracts: musd.length,
        musdTotal: musd.reduce((s: number, c: LoopContract) => s + parseFloat(c.payload?.amount || "0"), 0),
        usdcContracts: usdc.length,
        usdcTotal: usdc.reduce((s: number, c: LoopContract) => s + parseFloat(c.payload?.amount || "0"), 0),
        collateralContracts: collateral.length,
        collateralTotal: collateral.reduce((s: number, c: LoopContract) => s + parseFloat(c.payload?.amount || "0"), 0),
        vaults: vaults.length,
        proposals: proposals.length,
        attestations: attestations.length,
        mintService: mintSvc.length > 0,
        stakingService: stakeSvc.length > 0,
        oracle: oracleSvc.length > 0,
        issuerRole: issuer.length > 0,
        pool: pool.length > 0,
      });

      // Mint contract lists
      setServices(mintSvc);
      setUsdcContracts(usdc);
      setMusdContracts(musd);
      if (mintSvc.length > 0) setServiceId(mintSvc[0].contractId);
      if (usdc.length > 0) setUsdcContractId(usdc[0].contractId);
      if (musd.length > 0) setMusdContractId(musd[0].contractId);
    } catch (err) {
      console.error("Canton dashboard load error:", err);
    } finally {
      setLoading(false);
    }
  }, [loopWallet.isConnected, loopWallet.queryContracts]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ─── Computed ───────────────────────────────────────────────
  const totalUsdc = usdcContracts.reduce((s, c) => s + parseFloat(c.payload?.amount || "0"), 0);
  const totalMusd = musdContracts.reduce((s, c) => s + parseFloat(c.payload?.amount || "0"), 0);

  // ─── Mint handler ──────────────────────────────────────────
  async function handleMint() {
    if (!serviceId || !usdcContractId) return;
    setTxLoading(true);
    setError(null);
    setResult(null);
    try {
      await loopWallet.exerciseChoice(
        templates.DirectMintService,
        serviceId,
        "DirectMint_Mint",
        { usdcCid: usdcContractId, amount }
      );
      setResult(`Minted ${amount} mUSD on Canton`);
      setAmount("");
      await loadData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setTxLoading(false);
    }
  }

  // ─── Redeem handler ────────────────────────────────────────
  async function handleRedeem() {
    if (!serviceId || !musdContractId) return;
    setTxLoading(true);
    setError(null);
    setResult(null);
    try {
      await loopWallet.exerciseChoice(
        templates.DirectMintService,
        serviceId,
        "DirectMint_Redeem",
        { musdCid: musdContractId, amount }
      );
      setResult(`Redeemed ${amount} mUSD for USDC on Canton`);
      setAmount("");
      await loadData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setTxLoading(false);
    }
  }

  // ─── Connect prompt ────────────────────────────────────────
  if (!loopWallet.isConnected) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="max-w-md space-y-6">
          <div className="rounded-2xl border border-amber-500/20 bg-surface-800/90 p-8 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-500/10">
              <svg className="h-8 w-8 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
              </svg>
            </div>
            <h3 className="mb-2 text-xl font-semibold text-white">Connect to Canton Network</h3>
            <p className="text-gray-400 mb-6">Connect your Loop Wallet to access the Canton Dashboard & Mint.</p>
          </div>
          <WalletConnector mode="canton" />
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-4 border-amber-500/20 border-t-amber-500" />
          <p className="text-gray-400">Loading Canton contracts...</p>
        </div>
      </div>
    );
  }

  // ─── Render ────────────────────────────────────────────────
  return (
    <div className="space-y-8">
      {/* ═══════ HEADER ═══════ */}
      <PageHeader
        title="Dashboard"
        subtitle="Mint mUSD and monitor the Minted Protocol on Canton Network"
        badge="Canton"
        badgeColor="yellow"
      />

      {/* ═══════ KEY METRICS ═══════ */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Your mUSD Balance"
          value={totalMusd.toFixed(2)}
          subValue={`${stats.musdContracts} contracts`}
          color="yellow"
          variant="glow"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
            </svg>
          }
        />
        <StatCard
          label="Your USDC Balance"
          value={totalUsdc.toFixed(2)}
          subValue={`${stats.usdcContracts} contracts`}
          color="blue"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
        <StatCard
          label="Total mUSD Supply"
          value={stats.musdTotal.toFixed(2)}
          subValue="on Canton"
          color="green"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          }
        />
        <StatCard
          label="Collateral Locked"
          value={stats.collateralTotal.toFixed(2)}
          subValue={`${stats.collateralContracts} contracts`}
          color="default"
        />
      </div>

      {/* ═══════ MAIN 2-COL LAYOUT ═══════ */}
      <div className="grid gap-8 lg:grid-cols-5">
        {/* ─── LEFT: Mint Widget (2/5) ─── */}
        <div className="lg:col-span-2 space-y-6">
          <div className="rounded-2xl border border-amber-500/20 bg-surface-800/90 overflow-hidden">
            <div className="border-b border-amber-500/20 px-6 py-4">
              <h2 className="text-lg font-bold text-white">Mint mUSD</h2>
              <p className="text-xs text-gray-400 mt-0.5">1:1 via Canton Ledger</p>
            </div>

            {/* Mint / Redeem tabs */}
            <div className="flex border-b border-amber-500/20">
              <button
                className={`relative flex-1 px-4 py-3 text-center text-sm font-semibold transition-all ${
                  tab === "mint" ? "text-amber-400" : "text-gray-500 hover:text-white"
                }`}
                onClick={() => { setTab("mint"); setAmount(""); }}
              >
                <span className="flex items-center justify-center gap-2">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Mint
                </span>
                {tab === "mint" && (
                  <span className="absolute bottom-0 left-1/2 h-0.5 w-16 -translate-x-1/2 rounded-full bg-gradient-to-r from-amber-500 to-yellow-400" />
                )}
              </button>
              <button
                className={`relative flex-1 px-4 py-3 text-center text-sm font-semibold transition-all ${
                  tab === "redeem" ? "text-amber-400" : "text-gray-500 hover:text-white"
                }`}
                onClick={() => { setTab("redeem"); setAmount(""); }}
              >
                <span className="flex items-center justify-center gap-2">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Redeem
                </span>
                {tab === "redeem" && (
                  <span className="absolute bottom-0 left-1/2 h-0.5 w-16 -translate-x-1/2 rounded-full bg-gradient-to-r from-amber-500 to-yellow-400" />
                )}
              </button>
            </div>

            <div className="space-y-5 p-5">
              {/* Contract selector */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-gray-400">
                  {tab === "mint" ? "USDC Contract" : "mUSD Contract"}
                </label>
                <div className="relative">
                  <select
                    className="input appearance-none pr-10 text-sm"
                    value={tab === "mint" ? usdcContractId : musdContractId}
                    onChange={(e) =>
                      tab === "mint"
                        ? setUsdcContractId(e.target.value)
                        : setMusdContractId(e.target.value)
                    }
                  >
                    {(tab === "mint" ? usdcContracts : musdContracts).map((c) => (
                      <option key={c.contractId} value={c.contractId}>
                        {c.payload?.amount || "?"} - {c.contractId.slice(0, 20)}...
                      </option>
                    ))}
                  </select>
                  <svg className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>

              {/* Amount input */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-gray-400">Amount</label>
                <div className="relative rounded-xl border border-white/10 bg-surface-800/50 p-3 transition-all focus-within:border-amber-500/50 focus-within:shadow-[0_0_20px_-5px_rgba(245,158,11,0.3)]">
                  <input
                    type="number"
                    className="w-full bg-transparent text-xl font-semibold text-white placeholder-gray-600 focus:outline-none"
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </div>
              </div>

              {/* Info */}
              <div className="space-y-2 rounded-xl bg-surface-800/30 p-3 text-xs">
                <div className="flex justify-between">
                  <span className="text-gray-500">Mint Service</span>
                  <span className="font-mono text-amber-400">
                    {serviceId ? `${serviceId.slice(0, 16)}...` : "Not found"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Rate</span>
                  <span className="text-gray-300">1:1 USDC → mUSD</span>
                </div>
              </div>

              {/* Action button */}
              <button
                onClick={tab === "mint" ? handleMint : handleRedeem}
                disabled={txLoading || !amount || parseFloat(amount) <= 0}
                className="w-full rounded-xl bg-gradient-to-r from-amber-500 to-yellow-500 px-6 py-3 text-sm font-bold text-black transition-all hover:from-amber-400 hover:to-yellow-400 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {txLoading ? (
                  <>
                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Processing on Canton...
                  </>
                ) : (
                  <>
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={tab === "mint" ? "M12 4v16m8-8H4" : "M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"} />
                    </svg>
                    {tab === "mint" ? "Mint mUSD" : "Redeem USDC"}
                  </>
                )}
              </button>

              {/* Status */}
              {error && (
                <div className="rounded-lg border border-red-800 bg-red-900/20 p-3 text-xs text-red-400">
                  {error}
                </div>
              )}
              {result && (
                <div className="rounded-lg border border-amber-800 bg-amber-900/20 p-3 text-xs text-amber-400">
                  ✓ {result}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ─── RIGHT: Data panels (3/5) ─── */}
        <div className="lg:col-span-3 space-y-6">
          {/* Hero Stats Card */}
          <div className="rounded-2xl border border-amber-500/20 bg-surface-800/90 overflow-hidden p-6">
            <div className="grid gap-6 lg:grid-cols-3">
              <div className="space-y-2">
                <p className="text-sm font-medium text-gray-400">Total mUSD Supply</p>
                <p className="text-3xl font-bold text-amber-400">{stats.musdTotal.toFixed(2)}</p>
                <p className="flex items-center gap-2 text-sm text-amber-400/70">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                  {stats.musdContracts} active contracts
                </p>
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium text-gray-400">USDC Reserves</p>
                <p className="text-3xl font-bold text-white">{stats.usdcTotal.toFixed(2)}</p>
                <p className="text-sm text-gray-500">{stats.usdcContracts} contracts</p>
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium text-gray-400">Collateral Locked</p>
                <p className="text-3xl font-bold text-white">{stats.collateralTotal.toFixed(2)}</p>
                <p className="text-sm text-gray-500">{stats.collateralContracts} contracts</p>
              </div>
            </div>
          </div>

          {/* Active Positions */}
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard
              label="Open Vaults"
              value={stats.vaults.toString()}
              color={stats.vaults > 0 ? "yellow" : "default"}
            />
            <StatCard
              label="Transfer Proposals"
              value={stats.proposals.toString()}
            />
            <StatCard
              label="Pending Attestations"
              value={stats.attestations.toString()}
              color={stats.attestations > 0 ? "yellow" : "default"}
            />
          </div>

          {/* Protocol Services */}
          <Section
            title="Protocol Services"
            subtitle="Core infrastructure contracts"
            icon={
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            }
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {[
                { label: "DirectMint", active: stats.mintService },
                { label: "Staking", active: stats.stakingService },
                { label: "Price Oracle", active: stats.oracle },
                { label: "Issuer Role", active: stats.issuerRole },
                { label: "Liquidity Pool", active: stats.pool },
              ].map((svc) => (
                <div
                  key={svc.label}
                  className={`rounded-xl border p-3 text-center transition-all ${
                    svc.active
                      ? "border-amber-500/30 bg-amber-500/5"
                      : "border-white/5 bg-surface-800/30 opacity-60"
                  }`}
                >
                  <div className={`mb-1 text-sm font-bold ${svc.active ? "text-amber-400" : "text-gray-600"}`}>
                    {svc.active ? "Active" : "Inactive"}
                  </div>
                  <div className="text-xs text-gray-400">{svc.label}</div>
                </div>
              ))}
            </div>
          </Section>
        </div>
      </div>

      {/* ═══════ EXPLAINER BOX ═══════ */}
      <div className="card">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-500/20">
            <svg className="h-5 w-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-white">How It Works</h2>
        </div>
        <p className="text-sm text-gray-400 leading-relaxed">
          Mint mUSD 1:1 against selected collateral, validated in real time by attestations on the Canton Network, then stake to begin earning.
          On the Canton Network, every mint is recorded as a Daml contract — providing full auditability and atomic settlement guarantees.
        </p>
      </div>
    </div>
  );
}

export default CantonDashboardMint;
