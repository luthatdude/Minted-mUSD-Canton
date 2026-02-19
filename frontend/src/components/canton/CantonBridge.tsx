import React, { useState } from "react";
import { TxButton } from "@/components/TxButton";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { useCantonLedger, cantonExercise } from "@/hooks/useCantonLedger";

export function CantonBridge() {
  const { data, loading, error, refresh } = useCantonLedger(15_000);

  const [tab, setTab] = useState<"status" | "lock">("status");
  const [amount, setAmount] = useState("");
  const [selectedTokenIdx, setSelectedTokenIdx] = useState(0);
  const [targetChain, setTargetChain] = useState("1");
  const [targetAddress, setTargetAddress] = useState("");
  const [slippageBps, setSlippageBps] = useState("50");
  const [txLoading, setTxLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);

  const totalMusd = data ? parseFloat(data.totalBalance) : 0;
  const tokens = data?.tokens || [];

  async function handleLockForBridge() {
    if (!amount || parseFloat(amount) <= 0 || !targetAddress) return;
    setTxLoading(true);
    setTxError(null);
    setResult(null);
    try {
      if (!data?.bridgeService) throw new Error("BridgeService not deployed on Canton");
      const token = tokens[selectedTokenIdx];
      if (!token) throw new Error("No CantonMUSD token selected");
      const resp = await cantonExercise(
        "BridgeService",
        data.bridgeService.contractId,
        "Lock_Musd_For_Bridge",
        {
          musdCid: token.contractId,
          amount,
          targetChainId: targetChain,
          targetAddress,
          slippageToleranceBps: parseInt(slippageBps) || 50,
        }
      );
      if (!resp.success) throw new Error(resp.error || "Lock failed");
      setResult(`Locked ${amount} mUSD for bridge to chain ${targetChain}`);
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
        subtitle="Bridge mUSD between Canton Network and Ethereum with multi-sig attestation security"
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

      <div className="grid gap-4 sm:grid-cols-4">
        <StatCard label="mUSD Balance" value={totalMusd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} color="green" />
        <StatCard label="Bridge Service" value={data?.bridgeService ? "Active" : "—"} color={data?.bridgeService ? "green" : "default"} />
        <StatCard label="Last Nonce" value={data?.bridgeService ? String(data.bridgeService.lastNonce) : "—"} color="blue" />
        <StatCard label="Pending Bridge-Ins" value={String(data?.pendingBridgeIns || 0)} color={data?.pendingBridgeIns ? "yellow" : "default"} />
      </div>

      <div className="card-gradient-border overflow-hidden">
        <div className="flex border-b border-white/10">
          {[
            { key: "status" as const, label: "Bridge Status", icon: "M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" },
            { key: "lock" as const, label: "Lock for Bridge", icon: "M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" },
          ].map(({ key, label, icon }) => (
            <button
              key={key}
              className={`relative flex-1 px-6 py-4 text-center text-sm font-semibold transition-all ${tab === key ? "text-white" : "text-gray-400 hover:text-white"}`}
              onClick={() => setTab(key)}
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
          {/* Status Tab */}
          {tab === "status" && (
            <div className="space-y-6">
              {/* Bridged Tokens Table */}
              {tokens.length > 0 ? (
                <div className="space-y-4">
                  <h3 className="text-lg font-semibold text-white">Bridged mUSD Tokens</h3>
                  <p className="text-sm text-gray-400">
                    {tokens.length} tokens bridged from Ethereum, totaling {totalMusd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} mUSD
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-white/10">
                          <th className="text-left py-3 px-4 text-gray-400 font-medium">Nonce</th>
                          <th className="text-left py-3 px-4 text-gray-400 font-medium">Amount</th>
                          <th className="text-left py-3 px-4 text-gray-400 font-medium">Source</th>
                          <th className="text-left py-3 px-4 text-gray-400 font-medium">ETH Tx</th>
                          <th className="text-left py-3 px-4 text-gray-400 font-medium">Contract</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tokens.map((token) => (
                          <tr key={token.contractId} className="border-b border-white/5 hover:bg-surface-800/50">
                            <td className="py-3 px-4">
                              <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-purple-500/10 text-xs font-bold text-purple-400">{token.nonce}</span>
                            </td>
                            <td className="py-3 px-4 font-semibold text-white">
                              {parseFloat(token.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} mUSD
                            </td>
                            <td className="py-3 px-4">
                              <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-xs text-gray-300">
                                {token.sourceChain === 11155111 ? "Sepolia" : token.sourceChain === 1 ? "Ethereum" : `Chain ${token.sourceChain}`}
                              </span>
                            </td>
                            <td className="py-3 px-4">
                              {token.ethTxHash ? (
                                <a href={`https://sepolia.etherscan.io/tx/${token.ethTxHash}`} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-brand-400 hover:text-brand-300">
                                  {token.ethTxHash.slice(0, 8)}…{token.ethTxHash.slice(-6)} ↗
                                </a>
                              ) : <span className="text-xs text-gray-600">—</span>}
                            </td>
                            <td className="py-3 px-4">
                              <span className="font-mono text-xs text-gray-500">{token.contractId.slice(0, 12)}…</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="text-center py-12">
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-purple-500/10">
                    <svg className="h-8 w-8 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                    </svg>
                  </div>
                  <p className="text-gray-400 font-medium">No bridged tokens yet</p>
                  <p className="text-sm text-gray-500 mt-1">Bridge mUSD from Ethereum to see tokens here</p>
                </div>
              )}

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
            </div>
          )}

          {/* Lock Tab */}
          {tab === "lock" && (
            <div className="space-y-4">
              {tokens.length > 0 ? (
                <>
                  <div>
                    <label className="label">mUSD Contract</label>
                    <select className="input" value={selectedTokenIdx} onChange={(e) => setSelectedTokenIdx(Number(e.target.value))}>
                      {tokens.map((t, i) => (
                        <option key={t.contractId} value={i}>
                          {parseFloat(t.amount).toFixed(2)} mUSD — nonce {t.nonce} — {t.contractId.slice(0, 16)}…
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label">Amount to Lock</label>
                    <input type="number" className="input" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
                  </div>
                  <div>
                    <label className="label">Slippage Tolerance (bps)</label>
                    <div className="flex gap-2 items-center">
                      <input type="number" className="input w-24" min="1" max="500" value={slippageBps} onChange={(e) => setSlippageBps(e.target.value)} />
                      <span className="text-gray-400 text-sm">({((parseInt(slippageBps) || 0) / 100).toFixed(2)}%)</span>
                      <div className="flex gap-1 ml-2">
                        {[10, 50, 100].map((v) => (
                          <button key={v} onClick={() => setSlippageBps(v.toString())} className={`px-2 py-1 text-xs rounded ${slippageBps === v.toString() ? "bg-emerald-600 text-white" : "bg-gray-700 text-gray-300 hover:bg-gray-600"}`}>
                            {(v / 100).toFixed(1)}%
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="label">Target Chain ID</label>
                      <select className="input" value={targetChain} onChange={(e) => setTargetChain(e.target.value)}>
                        <option value="1">Ethereum Mainnet (1)</option>
                        <option value="11155111">Sepolia Testnet (11155111)</option>
                        <option value="137">Polygon (137)</option>
                        <option value="42161">Arbitrum (42161)</option>
                      </select>
                    </div>
                    <div>
                      <label className="label">Target Address</label>
                      <input type="text" className="input" placeholder="0x..." value={targetAddress} onChange={(e) => setTargetAddress(e.target.value)} />
                    </div>
                  </div>
                  <TxButton onClick={handleLockForBridge} loading={txLoading} disabled={!amount || parseFloat(amount) <= 0 || !targetAddress} variant="primary" className="w-full">
                    Lock mUSD for Bridge
                  </TxButton>
                </>
              ) : (
                <div className="text-center py-12">
                  <p className="text-gray-400">No mUSD tokens available to lock.</p>
                  <p className="text-sm text-gray-500 mt-1">Bridge mUSD from Ethereum first.</p>
                </div>
              )}
            </div>
          )}

          {txError && <div className="alert-error mt-4 text-sm">{txError}</div>}
          {result && <div className="alert-success mt-4 text-sm">{result}</div>}
        </div>
      </div>

      {/* How Canton Bridge Works */}
      <div className="card">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-purple-500/20">
            <svg className="h-5 w-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-white">How Canton Bridge Works</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-4">
          {[
            { step: "1", title: "Bridge In", desc: "Deposit mUSD on Ethereum — relay mints CantonMUSD on Canton.", color: "purple" },
            { step: "2", title: "Hold on Canton", desc: "mUSD is held as CantonMUSD tokens with full provenance.", color: "blue" },
            { step: "3", title: "Lock to Bridge Out", desc: "Lock CantonMUSD to begin bridging back to Ethereum.", color: "emerald" },
            { step: "4", title: "Claim on Ethereum", desc: "Attestation completes, claim mUSD on the target chain.", color: "yellow" },
          ].map(({ step, title, desc, color }) => (
            <div key={step} className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
              <div className={`flex h-8 w-8 items-center justify-center rounded-full bg-${color}-500/20 text-${color}-400 font-bold text-sm mb-3`}>{step}</div>
              <h3 className="font-medium text-white mb-1">{title}</h3>
              <p className="text-sm text-gray-400">{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
