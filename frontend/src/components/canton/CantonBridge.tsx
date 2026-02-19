import React, { useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { useCantonLedger, cantonExercise, fetchFreshBalances } from "@/hooks/useCantonLedger";

export function CantonBridge() {
  const { data, loading, error, refresh } = useCantonLedger(15_000);

  const [tab, setTab] = useState<"bridge-to-eth" | "status">("bridge-to-eth");
  const [bridgeAmount, setBridgeAmount] = useState("");
  const [txStatus, setTxStatus] = useState<"idle" | "processing" | "success" | "error">("idle");
  const [txError, setTxError] = useState<string | null>(null);

  const totalMusd = data ? parseFloat(data.totalBalance) : 0;
  const tokens = data?.tokens || [];

  // ── Bridge Canton → Ethereum ──────────────────────────────
  async function handleBridgeToEthereum() {
    if (!bridgeAmount || parseFloat(bridgeAmount) <= 0) {
      setTxError("Enter a valid amount to bridge");
      return;
    }
    if (parseFloat(bridgeAmount) > totalMusd) {
      setTxError("Insufficient CantonMUSD balance");
      return;
    }

    setTxStatus("processing");
    setTxError(null);

    try {
      // Fetch fresh balances to get current contract IDs
      const fresh = await fetchFreshBalances();
      const freshTokens = fresh.tokens || [];

      if (freshTokens.length === 0) {
        throw new Error("No CantonMUSD tokens available");
      }
      if (!fresh.directMintService) {
        throw new Error("DirectMintService not deployed — cannot redeem");
      }

      const targetAmount = parseFloat(bridgeAmount);

      // Find a token with enough balance
      let selectedToken = freshTokens.find((t: any) => parseFloat(t.amount) >= targetAmount);
      if (!selectedToken) {
        throw new Error(`No single token has ${bridgeAmount} mUSD. Largest token has ${Math.max(...freshTokens.map((t: any) => parseFloat(t.amount)))} mUSD.`);
      }

      let cidToBridge = selectedToken.contractId;
      const tokenAmount = parseFloat(selectedToken.amount);

      // If the token has more than we need, split first to get exact amount
      if (tokenAmount > targetAmount + 0.001) {
        const splitResp = await cantonExercise(
          "CantonMUSD",
          selectedToken.contractId,
          "CantonMUSD_Split",
          { splitAmount: bridgeAmount }
        );
        if (!splitResp.success) {
          throw new Error(splitResp.error || "Failed to split token");
        }
        // After split, refetch to get new CIDs
        const afterSplit = await fetchFreshBalances();
        const exactToken = (afterSplit.tokens || []).find(
          (t: any) => Math.abs(parseFloat(t.amount) - targetAmount) < 0.01
        );
        if (exactToken) {
          cidToBridge = exactToken.contractId;
        }
      }

      // Exercise DirectMint_Redeem — burns CantonMUSD and creates RedemptionRequest
      // The relay service picks up the redemption and settles on Ethereum automatically
      const redeemResp = await cantonExercise(
        "CantonDirectMintService",
        fresh.directMintService.contractId,
        "DirectMint_Redeem",
        {
          user: fresh.party || "",
          musdCid: cidToBridge,
        }
      );

      if (!redeemResp.success) {
        throw new Error(redeemResp.error || "Redemption failed");
      }

      setTxStatus("success");
      setBridgeAmount("");
      setTimeout(() => {
        refresh();
        setTxStatus("idle");
      }, 4000);
    } catch (err: any) {
      console.error("[CantonBridge] Bridge to ETH failed:", err);
      setTxError(err.message || "Bridge transaction failed");
      setTxStatus("error");
    }
  }

  if (loading && !data) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-4 border-purple-500/20 border-t-purple-500" />
          <p className="text-gray-400">Loading Canton bridge data…</p>
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
          <button onClick={refresh} className="rounded-xl bg-purple-600 px-6 py-2 font-medium text-white hover:bg-purple-500">Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <PageHeader
        title="Canton Bridge"
        subtitle="Bridge mUSD seamlessly between Canton Network and Ethereum"
        badge="Canton"
        badgeColor="purple"
        action={
          <button onClick={refresh} className="flex items-center gap-2 rounded-xl border border-purple-500/30 bg-purple-500/10 px-4 py-2 text-sm font-medium text-purple-400 hover:bg-purple-500/20">
            <svg className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        }
      />

      {/* Primary Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Canton mUSD Balance" value={totalMusd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} color="green" variant="glow"
          icon={<svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>} />
        <StatCard label="Token Contracts" value={String(tokens.length)} color="purple"
          icon={<svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>} />
        <StatCard label="Bridge Service" value={data?.bridgeService ? "Active" : "—"} color={data?.bridgeService ? "green" : "default"}
          icon={<svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>} />
        <StatCard label="Pending Transfers" value={String(data?.pendingBridgeIns || 0)} color={data?.pendingBridgeIns ? "yellow" : "default"}
          icon={<svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>} />
      </div>

      {/* Tabs */}
      <div className="card-gradient-border overflow-hidden">
        <div className="flex border-b border-white/10">
          {[
            { key: "bridge-to-eth" as const, label: "Bridge to Ethereum", icon: "M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" },
            { key: "status" as const, label: "Bridge Status", icon: "M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" },
          ].map(({ key, label, icon }) => (
            <button
              key={key}
              className={`relative flex-1 px-6 py-4 text-center text-sm font-semibold transition-all ${tab === key ? "text-white" : "text-gray-400 hover:text-white"}`}
              onClick={() => { setTab(key); setTxError(null); }}
            >
              <span className="flex items-center justify-center gap-2">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={icon} />
                </svg>
                {label}
              </span>
              {tab === key && <span className="absolute bottom-0 left-1/2 h-0.5 w-20 -translate-x-1/2 rounded-full bg-gradient-to-r from-purple-500 to-pink-500" />}
            </button>
          ))}
        </div>

        <div className="p-6">
          {/* Bridge to Ethereum Tab */}
          {tab === "bridge-to-eth" && (
            <div className="space-y-6">
              <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-purple-500/20 flex-shrink-0">
                    <svg className="h-6 w-6 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                    </svg>
                  </div>
                  <div className="flex-1">
                    <h3 className="text-lg font-semibold text-white mb-2">Bridge mUSD to Ethereum</h3>
                    <p className="text-sm text-gray-300 mb-4">
                      Redeem your CantonMUSD to receive mUSD directly in your Ethereum wallet. The relay service handles settlement automatically — no manual claiming needed.
                    </p>

                    {/* Amount Input */}
                    <div className="space-y-3">
                      <div className="flex items-center gap-3">
                        <div className="relative flex-1">
                          <input
                            type="number"
                            placeholder="0.00"
                            value={bridgeAmount}
                            onChange={(e) => setBridgeAmount(e.target.value)}
                            className="w-full rounded-xl border border-white/10 bg-surface-800/80 px-4 py-3 text-white placeholder-gray-500 focus:border-purple-500/50 focus:outline-none focus:ring-1 focus:ring-purple-500/50"
                            disabled={txStatus === "processing"}
                          />
                          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm text-gray-400">mUSD</span>
                        </div>
                        <button
                          onClick={() => setBridgeAmount(totalMusd.toString())}
                          className="rounded-lg border border-purple-500/30 bg-purple-500/10 px-3 py-3 text-xs font-medium text-purple-400 hover:bg-purple-500/20"
                        >
                          MAX
                        </button>
                      </div>

                      <div className="flex items-center justify-between text-sm">
                        <span className="text-gray-400">Available: {totalMusd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} mUSD</span>
                        {bridgeAmount && parseFloat(bridgeAmount) > totalMusd && (
                          <span className="text-red-400">Insufficient balance</span>
                        )}
                      </div>

                      {/* Bridge Button */}
                      <button
                        onClick={handleBridgeToEthereum}
                        disabled={txStatus === "processing" || !bridgeAmount || parseFloat(bridgeAmount) <= 0 || parseFloat(bridgeAmount) > totalMusd}
                        className={`w-full rounded-xl py-3 font-semibold transition-all ${
                          txStatus === "processing"
                            ? "bg-purple-500/50 text-purple-200 cursor-wait"
                            : txStatus === "success"
                            ? "bg-emerald-600 text-white"
                            : "bg-gradient-to-r from-purple-600 to-pink-600 text-white hover:from-purple-500 hover:to-pink-500 disabled:opacity-40 disabled:cursor-not-allowed"
                        }`}
                      >
                        {txStatus === "processing" ? (
                          <span className="flex items-center justify-center gap-2">
                            <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                            Bridging to Ethereum…
                          </span>
                        ) : txStatus === "success" ? (
                          "✅ Bridge initiated — mUSD will arrive in your ETH wallet"
                        ) : (
                          "Bridge to Ethereum"
                        )}
                      </button>

                      {!data?.directMintService && (
                        <p className="text-xs text-yellow-400 text-center">DirectMint service not available — cannot bridge</p>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Info Card */}
              <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4">
                <p className="text-sm text-blue-300 font-medium mb-1">Seamless bridging</p>
                <p className="text-xs text-gray-400">
                  When you bridge, your CantonMUSD is redeemed and a RedemptionRequest is created on Canton. The relay service automatically settles it on Ethereum —
                  mUSD appears directly in your connected wallet. No locking or claiming steps required.
                </p>
              </div>
            </div>
          )}

          {/* Status Tab */}
          {tab === "status" && (
            <div className="space-y-6">
              {/* Current Holdings Summary */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
                  <p className="text-xs text-gray-500 mb-1">Canton mUSD Balance</p>
                  <p className="text-2xl font-bold text-emerald-400">{totalMusd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                  <p className="text-xs text-gray-500 mt-1">{tokens.length} contract{tokens.length !== 1 ? "s" : ""}</p>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
                  <p className="text-xs text-gray-500 mb-1">Pending Transfers</p>
                  <p className="text-2xl font-bold text-yellow-400">{data?.pendingBridgeIns || 0}</p>
                  <p className="text-xs text-gray-500 mt-1">Awaiting relay settlement</p>
                </div>
              </div>

              {/* Bridge Service Info */}
              {data?.bridgeService && (
                <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-2">
                  <h4 className="text-sm font-medium text-gray-400">Bridge Service</h4>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div>
                      <p className="text-xs text-gray-500">Status</p>
                      <p className="text-sm font-medium text-emerald-400">Active</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Last Nonce</p>
                      <p className="text-sm font-medium text-white">{data.bridgeService.lastNonce}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Contract ID</p>
                      <p className="font-mono text-xs text-gray-400">{data.bridgeService.contractId.slice(0, 24)}…</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Staking Info */}
              {data?.stakingService && (
                <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                  <p className="text-sm text-emerald-300 font-medium mb-1">Earn yield on Canton</p>
                  <p className="text-xs text-gray-400">
                    Stake your CantonMUSD into smUSD for yield,
                    or deposit into the ETH Pool. Visit the <strong className="text-white">Stake</strong> page to get started.
                  </p>
                </div>
              )}
            </div>
          )}

          {txError && (
            <div className="alert-error mt-4 text-sm flex items-center justify-between">
              <span>{txError}</span>
              <button onClick={() => { setTxError(null); setTxStatus("idle"); }} className="text-xs underline opacity-70 hover:opacity-100">Dismiss</button>
            </div>
          )}
        </div>
      </div>

      {/* How Canton Bridge Works — seamless 4-step flow */}
      <div className="card">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-purple-500/20">
            <svg className="h-5 w-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-white">How Canton Bridge Works</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { step: "1", title: "Bridge from Ethereum", desc: "Deposit mUSD into the BLE Bridge contract on Ethereum. The relay detects the event automatically.", color: "purple" },
            { step: "2", title: "Instant Canton Mint", desc: "The relay service creates CantonMUSD on the Canton ledger — no manual steps needed.", color: "emerald" },
            { step: "3", title: "Hold & Earn", desc: "Your mUSD lives on Canton as CantonMUSD. Stake into smUSD or ETH Pool for yield.", color: "green" },
            { step: "4", title: "Bridge Back Seamlessly", desc: "Redeem CantonMUSD to bridge back. mUSD arrives directly in your Ethereum wallet.", color: "blue" },
          ].map(({ step, title, desc, color }) => (
            <div key={step} className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
              <div className={`flex h-8 w-8 items-center justify-center rounded-full bg-${color}-500/20 text-${color}-400 font-bold text-sm mb-3`}>{step}</div>
              <h3 className="font-medium text-white mb-1 text-sm">{title}</h3>
              <p className="text-xs text-gray-400">{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
