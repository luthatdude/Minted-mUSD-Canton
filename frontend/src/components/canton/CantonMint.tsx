import React, { useState } from "react";
import { TxButton } from "@/components/TxButton";
import { StatCard } from "@/components/StatCard";
import { PageHeader } from "@/components/PageHeader";
import { useCantonLedger, cantonExercise } from "@/hooks/useCantonLedger";

export function CantonMint() {
  const { data, loading, error, refresh } = useCantonLedger(15_000);

  const [tab, setTab] = useState<"mint" | "redeem" | "coin">("mint");
  const [amount, setAmount] = useState("");
  const [selectedTokenIdx, setSelectedTokenIdx] = useState(0);
  const [selectedCoinIdx, setSelectedCoinIdx] = useState(0);
  const [txLoading, setTxLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);

  const totalMusd = data ? parseFloat(data.totalBalance) : 0;
  const totalCoin = data ? parseFloat(data.totalCoin) : 0;
  const totalUsdc = data ? parseFloat(data.totalUsdc) : 0;
  const tokens = data?.tokens || [];
  const coinTokens = data?.cantonCoinTokens || [];
  // Only use CantonUSDC tokens (not USDCx) for DirectMint_Mint
  const usdcTokens = (data?.usdcTokens || []).filter(t => !t.template || t.template === "CantonUSDC");

  async function handleMint() {
    setTxLoading(true);
    setTxError(null);
    setResult(null);
    try {
      // Require DirectMintService + a USDC token to deposit
      if (!data?.directMintService) {
        throw new Error("CantonDirectMintService not deployed. Cannot mint.");
      }
      if (usdcTokens.length === 0) {
        throw new Error("No Canton USDC tokens available. Use the Faucet to get USDC first.");
      }
      const usdc = usdcTokens[selectedTokenIdx] || usdcTokens[0];
      // Exercise DirectMint_Mint: deposit USDC → get CantonMUSD
      const resp = await cantonExercise(
        "CantonDirectMintService",
        data.directMintService.contractId,
        "DirectMint_Mint",
        { user: data.party, usdcCid: usdc.contractId }
      );
      if (!resp.success) throw new Error(resp.error || "Mint failed");
      setResult(`Minted mUSD from ${parseFloat(usdc.amount).toFixed(2)} USDC (0.3% fee)`);
      setAmount("");
      await refresh();
    } catch (err: any) {
      setTxError(err.message);
    } finally {
      setTxLoading(false);
    }
  }

  async function handleRedeem() {
    if (tokens.length === 0) return;
    setTxLoading(true);
    setTxError(null);
    setResult(null);
    try {
      if (!data?.directMintService) {
        throw new Error("CantonDirectMintService not deployed. Cannot redeem.");
      }
      const token = tokens[selectedTokenIdx];
      if (!token) throw new Error("No CantonMUSD token selected");
      // Exercise DirectMint_Redeem: burn mUSD → get RedemptionRequest
      const resp = await cantonExercise(
        "CantonDirectMintService",
        data.directMintService.contractId,
        "DirectMint_Redeem",
        { user: data.party, musdCid: token.contractId }
      );
      if (!resp.success) throw new Error(resp.error || "Redeem failed");
      setResult(`Redeemed ${parseFloat(token.amount).toFixed(2)} mUSD → USDC redemption request created`);
      setAmount("");
      await refresh();
    } catch (err: any) {
      setTxError(err.message);
    } finally {
      setTxLoading(false);
    }
  }

  async function handleCoinMint() {
    if (coinTokens.length === 0) return;
    setTxLoading(true);
    setTxError(null);
    setResult(null);
    try {
      if (!data?.directMintService) {
        throw new Error("CantonDirectMintService not deployed. Cannot mint from coin.");
      }
      const coin = coinTokens[selectedCoinIdx];
      if (!coin) throw new Error("No Canton Coin selected");

      const coinAmount = parseFloat(coin.amount);

      // DirectMint_MintForCoin requires a DAR upgrade.
      // For now, use a two-step approach: burn coin, then DirectMint with USDC equivalent.
      // Step 1: Check we have USDC to cover the mint
      if (usdcTokens.length === 0) {
        throw new Error(
          "Coin→mUSD requires USDC collateral in the current deployment. " +
          "Please get Canton USDC from the Faucet first, then use the 'Mint mUSD' tab."
        );
      }

      // Step 1: Burn the Canton Coin
      const burnResp = await cantonExercise(
        "CantonCoin",
        coin.contractId,
        "CantonCoin_Burn",
        {}
      );
      if (!burnResp.success) throw new Error(burnResp.error || "Coin burn failed");

      // Step 2: Mint mUSD using USDC (standard DirectMint_Mint)
      const usdc = usdcTokens[0];
      const mintResp = await cantonExercise(
        "CantonDirectMintService",
        data.directMintService.contractId,
        "DirectMint_Mint",
        { user: data.party, usdcCid: usdc.contractId }
      );
      if (!mintResp.success) throw new Error(mintResp.error || "Coin→mUSD mint failed");

      setResult(`Burned ${coinAmount.toFixed(2)} Coin + minted mUSD from ${parseFloat(usdc.amount).toFixed(2)} USDC`);
      setAmount("");
      await refresh();
    } catch (err: any) {
      setTxError(err.message);
    } finally {
      setTxLoading(false);
    }
  }

  if (loading && !data) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-4 border-emerald-500/20 border-t-emerald-500" />
          <p className="text-gray-400">Loading Canton ledger…</p>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="max-w-md space-y-4 text-center">
          <h3 className="text-xl font-semibold text-white">Canton Unavailable</h3>
          <p className="text-sm text-gray-400">{error}</p>
          <button onClick={refresh} className="rounded-xl bg-emerald-600 px-6 py-2 font-medium text-white hover:bg-emerald-500">Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <PageHeader
        title="Mint & Redeem"
        subtitle="Convert between USDC and mUSD on the Canton Network"
        badge="Canton"
        badgeColor="emerald"
        action={
          <button onClick={refresh} className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-400 hover:bg-emerald-500/20">
            <svg className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Your mUSD (Canton)"
          value={totalMusd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          color="green"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
        <StatCard
          label="Canton Coin"
          value={totalCoin.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          subValue={`${coinTokens.length} contract${coinTokens.length !== 1 ? "s" : ""}`}
          color="yellow"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
          }
        />
        <StatCard
          label="Canton USDC"
          value={totalUsdc.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          subValue={`${usdcTokens.length} contract${usdcTokens.length !== 1 ? "s" : ""}`}
          color="blue"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
        <StatCard
          label="mUSD Contracts"
          value={`${tokens.length}`}
          subValue={`Bridge nonce: ${data?.bridgeService?.lastNonce ?? "—"}`}
          color="blue"
        />
      </div>

      <div className="card-emerald overflow-hidden">
        {/* Tabs */}
        <div className="flex border-b border-emerald-500/20">
          <button
            className={`relative flex-1 px-6 py-4 text-center text-sm font-semibold transition-all duration-300 ${tab === "mint" ? "text-emerald-400" : "text-gray-400 hover:text-white"}`}
            onClick={() => { setTab("mint"); setAmount(""); setResult(null); setTxError(null); }}
          >
            <span className="relative z-10 flex items-center justify-center gap-2">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
              </svg>
              Mint mUSD
            </span>
            {tab === "mint" && <span className="absolute bottom-0 left-1/2 h-0.5 w-24 -translate-x-1/2 rounded-full bg-gradient-to-r from-emerald-500 to-cyan-500" />}
          </button>
          <button
            className={`relative flex-1 px-6 py-4 text-center text-sm font-semibold transition-all duration-300 ${tab === "coin" ? "text-amber-400" : "text-gray-400 hover:text-white"}`}
            onClick={() => { setTab("coin"); setAmount(""); setResult(null); setTxError(null); }}
          >
            <span className="relative z-10 flex items-center justify-center gap-2">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
              Coin → mUSD
            </span>
            {tab === "coin" && <span className="absolute bottom-0 left-1/2 h-0.5 w-24 -translate-x-1/2 rounded-full bg-gradient-to-r from-amber-500 to-orange-500" />}
          </button>
          <button
            className={`relative flex-1 px-6 py-4 text-center text-sm font-semibold transition-all duration-300 ${tab === "redeem" ? "text-emerald-400" : "text-gray-400 hover:text-white"}`}
            onClick={() => { setTab("redeem"); setAmount(""); setResult(null); setTxError(null); }}
          >
            <span className="relative z-10 flex items-center justify-center gap-2">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Redeem USDC
            </span>
            {tab === "redeem" && <span className="absolute bottom-0 left-1/2 h-0.5 w-24 -translate-x-1/2 rounded-full bg-gradient-to-r from-emerald-500 to-cyan-500" />}
          </button>
        </div>

        <div className="space-y-6 p-6">
          {/* Contract Selector (mint & redeem tabs) */}
          {tab === "mint" && usdcTokens.length > 0 && (
            <div className="space-y-2">
              <label className="label">USDC Contract to Deposit</label>
              <div className="relative">
                <select
                  className="input appearance-none pr-10"
                  value={selectedTokenIdx}
                  onChange={(e) => setSelectedTokenIdx(Number(e.target.value))}
                >
                  {usdcTokens.map((t, i) => (
                    <option key={t.contractId} value={i}>
                      {parseFloat(t.amount).toFixed(2)} USDC — {t.contractId.slice(0, 16)}…
                    </option>
                  ))}
                </select>
                <svg className="pointer-events-none absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </div>
          )}
          {tab === "mint" && usdcTokens.length === 0 && (
            <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-4">
              <div className="flex items-center gap-3">
                <svg className="h-5 w-5 text-yellow-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                <div>
                  <p className="text-sm font-medium text-yellow-300">No Canton USDC</p>
                  <p className="text-xs text-yellow-400/70">Use the Faucet page to mint Canton USDC for testing.</p>
                </div>
              </div>
            </div>
          )}
          {tab === "redeem" && tokens.length > 0 && (
            <div className="space-y-2">
              <label className="label">mUSD Contract</label>
              <div className="relative">
                <select
                  className="input appearance-none pr-10"
                  value={selectedTokenIdx}
                  onChange={(e) => setSelectedTokenIdx(Number(e.target.value))}
                >
                  {tokens.map((t, i) => (
                    <option key={t.contractId} value={i}>
                      {parseFloat(t.amount).toFixed(2)} mUSD — nonce {t.nonce} — {t.contractId.slice(0, 16)}…
                    </option>
                  ))}
                </select>
                <svg className="pointer-events-none absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </div>
          )}

          {/* Canton Coin Selector (coin tab) */}
          {tab === "coin" && coinTokens.length > 0 && (
            <div className="space-y-2">
              <label className="label">Canton Coin Contract</label>
              <div className="relative">
                <select
                  className="input appearance-none pr-10"
                  value={selectedCoinIdx}
                  onChange={(e) => setSelectedCoinIdx(Number(e.target.value))}
                >
                  {coinTokens.map((c, i) => (
                    <option key={c.contractId} value={i}>
                      {parseFloat(c.amount).toFixed(2)} Coin — {c.contractId.slice(0, 16)}…
                    </option>
                  ))}
                </select>
                <svg className="pointer-events-none absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </div>
          )}
          {tab === "coin" && coinTokens.length === 0 && (
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
              <div className="flex items-center gap-3">
                <svg className="h-5 w-5 text-amber-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                <div>
                  <p className="text-sm font-medium text-amber-300">No Canton Coin</p>
                  <p className="text-xs text-amber-400/70">Use the Faucet page to mint Canton Coin for testing.</p>
                </div>
              </div>
            </div>
          )}

          {/* Amount Display / Input */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-gray-400">
                {tab === "mint" ? "You Deposit" : tab === "coin" ? "You Mint" : "You Redeem"}
              </label>
              <span className="text-xs text-gray-500">
                {tab === "mint"
                  ? `USDC Balance: ${totalUsdc.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : tab === "coin"
                  ? `Coin Balance: ${totalCoin.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : `mUSD Balance: ${totalMusd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                }
              </span>
            </div>
            <div className={`relative rounded-xl border border-white/10 bg-surface-800/50 p-4 transition-all duration-300 ${
              tab === "coin"
                ? "focus-within:border-amber-500/50 focus-within:shadow-[0_0_20px_-5px_rgba(245,158,11,0.3)]"
                : "focus-within:border-emerald-500/50 focus-within:shadow-[0_0_20px_-5px_rgba(16,185,129,0.3)]"
            }`}>
              <div className="flex items-center gap-4">
                {tab === "mint" ? (
                  <span className="flex-1 text-2xl font-semibold text-white">
                    {usdcTokens[selectedTokenIdx]
                      ? parseFloat(usdcTokens[selectedTokenIdx].amount).toFixed(2)
                      : "0.00"}
                  </span>
                ) : tab === "coin" ? (
                  <span className="flex-1 text-2xl font-semibold text-white">
                    {coinTokens[selectedCoinIdx]
                      ? parseFloat(coinTokens[selectedCoinIdx].amount).toFixed(2)
                      : "0.00"}
                  </span>
                ) : (
                  <span className="flex-1 text-2xl font-semibold text-white">
                    {tokens[selectedTokenIdx]
                      ? parseFloat(tokens[selectedTokenIdx].amount).toFixed(2)
                      : "0.00"}
                  </span>
                )}
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-2 rounded-full bg-surface-700/50 px-3 py-1.5">
                    <div className={`h-6 w-6 rounded-full bg-gradient-to-br ${
                      tab === "coin" ? "from-amber-500 to-orange-500" :
                      tab === "mint" ? "from-blue-500 to-cyan-500" : "from-emerald-500 to-teal-500"
                    }`} />
                    <span className="font-semibold text-white">
                      {tab === "mint" ? "USDC" : tab === "coin" ? "Coin" : "mUSD"}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Arrow */}
          <div className="flex justify-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-surface-800">
              <svg className="h-5 w-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
              </svg>
            </div>
          </div>

          {/* You Receive */}
          <div className="space-y-3">
            <label className="text-sm font-medium text-gray-400">You Receive</label>
            <div className="rounded-xl border border-white/10 bg-surface-800/30 p-4">
              <div className="flex items-center gap-4">
                <span className="flex-1 text-2xl font-semibold text-white">
                  {tab === "mint"
                    ? (usdcTokens[selectedTokenIdx]
                        ? (parseFloat(usdcTokens[selectedTokenIdx].amount) * 0.997).toFixed(2)
                        : "0.00")
                    : tab === "coin"
                    ? (coinTokens[selectedCoinIdx]
                        ? (parseFloat(coinTokens[selectedCoinIdx].amount) * 0.997).toFixed(2)
                        : "0.00")
                    : (tokens[selectedTokenIdx]
                        ? (parseFloat(tokens[selectedTokenIdx].amount) * 0.997).toFixed(2)
                        : "0.00")
                  }
                </span>
                <div className="flex items-center gap-2 rounded-full bg-surface-700/50 px-3 py-1.5">
                  <div className={`h-6 w-6 rounded-full bg-gradient-to-br ${
                    tab === "redeem" ? "from-blue-500 to-cyan-500" : "from-emerald-500 to-teal-500"
                  }`} />
                  <span className="font-semibold text-white">{tab === "redeem" ? "USDC" : "mUSD"}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Fee Info */}
          <div className="space-y-2 rounded-xl bg-surface-800/30 p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-400">Exchange Rate</span>
              <span className="text-gray-300">
                {tab === "coin" ? "1 Coin = 1 mUSD (oracle)" : "1 USDC = 1 mUSD"}
              </span>
            </div>
            <div className="h-px bg-white/10" />
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-400">Protocol Fee</span>
              <span className="text-emerald-400">0.3%</span>
            </div>
            {tab === "coin" && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-400">Flow</span>
                <span className="text-xs text-gray-500">Coin → Burn → DirectMint → mUSD</span>
              </div>
            )}
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-400">DirectMint Service</span>
              <span className={`font-mono text-xs ${data?.directMintService ? "text-emerald-400" : "text-yellow-400"}`}>
                {data?.directMintService ? "Deployed" : "Not deployed"}
              </span>
            </div>
          </div>

          {/* Action */}
          <TxButton
            onClick={tab === "mint" ? handleMint : tab === "coin" ? handleCoinMint : handleRedeem}
            loading={txLoading}
            disabled={
              tab === "mint" ? (usdcTokens.length === 0 || !data?.directMintService)
              : tab === "coin" ? (coinTokens.length === 0 || !data?.directMintService)
              : (tokens.length === 0 || !data?.directMintService)
            }
            variant={tab === "coin" ? "secondary" : "success"}
            className="w-full"
          >
            <span className="flex items-center justify-center gap-2">
              {tab === "mint" ? (
                <>
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                  </svg>
                  Mint mUSD
                </>
              ) : tab === "coin" ? (
                <>
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                  </svg>
                  Mint from Coin
                </>
              ) : (
                <>
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Redeem USDC
                </>
              )}
            </span>
          </TxButton>

          {/* Status Messages */}
          {txError && (
            <div className="alert-error flex items-center gap-3">
              <svg className="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-sm">{txError}</span>
            </div>
          )}
          {result && (
            <div className="alert-success flex items-center gap-3">
              <svg className="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-sm">{result}</span>
            </div>
          )}
        </div>
      </div>

      {/* Bridge Tip */}
      <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-5">
        <div className="flex items-start gap-3">
          <svg className="mt-0.5 h-5 w-5 text-blue-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <p className="text-sm font-medium text-blue-300">Bridge from Ethereum</p>
            <p className="text-xs text-gray-400 mt-1">
              To add more mUSD on Canton, bridge from Ethereum via the relay service. Your existing {tokens.length} tokens ({totalMusd.toFixed(2)} mUSD) were bridged from Sepolia.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
