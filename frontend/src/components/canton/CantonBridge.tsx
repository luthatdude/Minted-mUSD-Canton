import React, { useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { useCantonLedger } from "@/hooks/useCantonLedger";

export function CantonBridge() {
  const { data, loading, error, refresh } = useCantonLedger(15_000);

  const [tab, setTab] = useState<"status" | "lock">("status");
  const [txError, setTxError] = useState<string | null>(null);

  const totalMusd = data ? parseFloat(data.totalBalance) : 0;
  const tokens = data?.tokens || [];

  async function handleLockForBridge() {
    // In V3 protocol, bridge-out is automatic via BridgeOutRequest created during minting.
    // The Lock_Musd_For_Bridge choice doesn't exist on V3 BridgeService.
    setTxError(
      "Canton→Ethereum bridging is handled automatically. " +
      "When you mint mUSD via DirectMint, a BridgeOutRequest is created for relay settlement. " +
      "Use the Mint page to create mUSD — the bridge relay handles Ethereum settlement automatically."
    );
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

      {/* Primary Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="mUSD Balance" value={totalMusd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} color="green" variant="glow"
          icon={<svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>} />
        <StatCard label="Bridge Service" value={data?.bridgeService ? "Active" : "—"} color={data?.bridgeService ? "green" : "default"}
          icon={<svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>} />
        <StatCard label="Bridge Nonce" value={data?.bridgeService ? String(data.bridgeService.lastNonce) : "—"} color="blue"
          icon={<svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" /></svg>} />
        <StatCard label="Pending Bridge-Ins" value={String(data?.pendingBridgeIns || 0)} color={data?.pendingBridgeIns ? "yellow" : "default"}
          icon={<svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>} />
      </div>

      {/* Supply Overview & Protocol Parameters */}
      <div className="grid gap-6 sm:grid-cols-2">
        {/* Supply Overview Gauge */}
        <div className="card-gradient-border overflow-hidden">
          <div className="flex items-center gap-3 mb-5">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-purple-500">
              <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">Canton mUSD Supply</h2>
              <p className="text-sm text-gray-400">{tokens.length} contracts across Canton ledger</p>
            </div>
          </div>
          <div className="text-center mb-4">
            <p className="text-4xl font-bold text-emerald-400">{totalMusd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
            <p className="text-sm text-gray-400 mt-1">Total mUSD on Canton</p>
          </div>
          <div className="space-y-3">
            <div className="progress h-4 rounded-full">
              <div className="h-full rounded-full progress-bar transition-all duration-1000" style={{ width: `${Math.min(100, (totalMusd / 1_000_000) * 100)}%` }} />
            </div>
            <div className="flex justify-between text-sm">
              <div><p className="text-gray-400">Bridged</p><p className="font-semibold text-white">{tokens.length} tokens</p></div>
              <div className="text-right"><p className="text-gray-400">Supply Service</p><p className="font-semibold text-emerald-400">{data?.supplyService ? "Active" : "—"}</p></div>
            </div>
          </div>
        </div>

        {/* Protocol Parameters */}
        <div className="card-gradient-border overflow-hidden">
          <div className="flex items-center gap-3 mb-5">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-500/20">
              <svg className="h-5 w-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">Protocol Parameters</h2>
              <p className="text-sm text-gray-400">Canton bridge configuration</p>
            </div>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm rounded-lg bg-surface-800/30 px-4 py-3">
              <span className="text-gray-400">Bridge Service</span>
              <span className={`font-medium ${data?.bridgeService ? "text-emerald-400" : "text-yellow-400"}`}>{data?.bridgeService ? "Deployed" : "Not Deployed"}</span>
            </div>
            <div className="flex items-center justify-between text-sm rounded-lg bg-surface-800/30 px-4 py-3">
              <span className="text-gray-400">Supply Service</span>
              <span className={`font-medium ${data?.supplyService ? "text-emerald-400" : "text-yellow-400"}`}>{data?.supplyService ? "Deployed" : "Not Deployed"}</span>
            </div>
            <div className="flex items-center justify-between text-sm rounded-lg bg-surface-800/30 px-4 py-3">
              <span className="text-gray-400">Current Nonce</span>
              <span className="font-medium text-white font-mono">{data?.bridgeService?.lastNonce ?? "—"}</span>
            </div>
            <div className="flex items-center justify-between text-sm rounded-lg bg-surface-800/30 px-4 py-3">
              <span className="text-gray-400">Pending Requests</span>
              <span className={`font-medium ${(data?.pendingBridgeIns || 0) > 0 ? "text-yellow-400" : "text-gray-300"}`}>{data?.pendingBridgeIns || 0}</span>
            </div>
            {data?.bridgeService && (
              <div className="flex items-center justify-between text-sm rounded-lg bg-surface-800/30 px-4 py-3">
                <span className="text-gray-400">Contract ID</span>
                <span className="font-mono text-xs text-gray-500">{data.bridgeService.contractId.slice(0, 20)}…</span>
              </div>
            )}
          </div>
        </div>
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

          {/* Lock Tab — V3 protocol handles bridge-out automatically */}
          {tab === "lock" && (
            <div className="space-y-6">
              <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-purple-500/20 flex-shrink-0">
                    <svg className="h-6 w-6 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-white mb-2">Automatic Bridge Settlement</h3>
                    <p className="text-sm text-gray-300 mb-3">
                      In the V3 protocol, Canton→Ethereum bridging is handled automatically by the relay service.
                    </p>
                    <div className="space-y-2 text-sm text-gray-400">
                      <p>• When you <strong className="text-emerald-400">Mint mUSD</strong> via DirectMint, a <code className="text-purple-300">BridgeOutRequest</code> is created automatically.</p>
                      <p>• The <strong className="text-blue-400">relay service</strong> picks up pending BridgeOutRequests and settles them on Ethereum.</p>
                      <p>• No manual locking is needed — the bridge relay handles Ethereum settlement.</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Quick Stats */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
                  <p className="text-xs text-gray-500 mb-1">Your Canton mUSD</p>
                  <p className="text-2xl font-bold text-emerald-400">{totalMusd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                  <p className="text-xs text-gray-500 mt-1">{tokens.length} contract{tokens.length !== 1 ? "s" : ""}</p>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
                  <p className="text-xs text-gray-500 mb-1">Pending Bridge-Outs</p>
                  <p className="text-2xl font-bold text-yellow-400">{data?.pendingBridgeIns || 0}</p>
                  <p className="text-xs text-gray-500 mt-1">Awaiting relay settlement</p>
                </div>
              </div>

              <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4">
                <p className="text-sm text-blue-300 font-medium mb-1">Want to mint more mUSD?</p>
                <p className="text-xs text-gray-400">Go to the <strong className="text-white">Mint &amp; Redeem</strong> page to deposit USDC and receive mUSD. Bridge settlement happens automatically.</p>
              </div>
            </div>
          )}

          {txError && <div className="alert-error mt-4 text-sm">{txError}</div>}
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
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {[
            { step: "1", title: "Deposit on ETH", desc: "User deposits mUSD into the BLE Bridge contract on Ethereum.", color: "purple" },
            { step: "2", title: "Relay Detects", desc: "The relay service monitors for bridge events and fetches attestation data.", color: "blue" },
            { step: "3", title: "Canton Mint", desc: "Relay exercises BridgeService to mint CantonMUSD with full provenance.", color: "emerald" },
            { step: "4", title: "Hold & Earn", desc: "mUSD is held as CantonMUSD — stake into smUSD or ETH Pool for yield.", color: "green" },
            { step: "5", title: "Lock for Bridge", desc: "Lock CantonMUSD tokens to initiate bridging back to Ethereum.", color: "yellow" },
            { step: "6", title: "Claim on ETH", desc: "Multi-sig attestation completes, claim mUSD on the target chain.", color: "brand" },
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
