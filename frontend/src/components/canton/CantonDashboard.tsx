import React from "react";
import { StatCard } from "@/components/StatCard";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/Section";
import { useCantonLedger } from "@/hooks/useCantonLedger";

export function CantonDashboard() {
  const { data, loading, error, refresh } = useCantonLedger(15_000);

  if (loading && !data) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-4 border-emerald-500/20 border-t-emerald-500" />
          <p className="text-gray-400">Loading Canton ledger data…</p>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="max-w-md space-y-4 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-red-500/10">
            <svg className="h-8 w-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <h3 className="text-xl font-semibold text-white">Canton Ledger Unavailable</h3>
          <p className="text-sm text-gray-400">{error}</p>
          <button onClick={refresh} className="rounded-xl bg-emerald-600 px-6 py-2 font-medium text-white hover:bg-emerald-500">Retry</button>
        </div>
      </div>
    );
  }

  const totalMusd = data ? parseFloat(data.totalBalance) : 0;
  const musdContracts = data?.tokenCount || 0;

  return (
    <div className="space-y-10">
      <PageHeader
        title="Canton Dashboard"
        subtitle="Real-time overview of Minted Protocol on the Canton Network"
        badge="Live"
        badgeColor="emerald"
        action={
          <button
            onClick={refresh}
            className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-400 transition-all hover:bg-emerald-500/20"
          >
            <svg className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        }
      />

      {error && data && (
        <div className="rounded-lg border border-yellow-800 bg-yellow-900/20 p-3 text-sm text-yellow-400">
          ⚠ Refresh failed: {error}. Showing cached data.
        </div>
      )}

      {/* Portfolio Hero */}
      <div className="card-emerald overflow-hidden p-8">
        <div className="grid gap-8 lg:grid-cols-4">
          <div className="lg:col-span-2 space-y-2">
            <p className="text-sm font-medium text-gray-400">Net Portfolio Value</p>
            <p className="text-5xl font-bold text-gradient-emerald">
              ${totalMusd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
            <p className="flex items-center gap-2 text-sm text-emerald-400">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              {musdContracts} active contracts on Canton
            </p>
            <p className="text-xs text-gray-500">
              Ledger offset: {data?.ledgerOffset?.toLocaleString()} · Updated: {data?.timestamp ? new Date(data.timestamp).toLocaleTimeString() : "—"}
            </p>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-gray-400">mUSD Balance</p>
            <p className="text-3xl font-bold text-white">
              {totalMusd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
            <p className="text-sm text-gray-500">{musdContracts} contracts</p>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-gray-400">Bridge Status</p>
            <p className="text-3xl font-bold text-white">
              {data?.bridgeService ? data.bridgeService.lastNonce : "—"}
            </p>
            <p className="text-sm text-gray-500">
              {data?.pendingBridgeIns || 0} pending bridge-ins
            </p>
          </div>
        </div>
      </div>

      {/* Token Balance Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "mUSD", value: totalMusd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), color: "from-emerald-500 to-teal-500" },
          { label: "Bridge", value: data?.bridgeService ? "Active" : "—", color: "from-blue-500 to-cyan-500" },
          { label: "Supply Svc", value: data?.supplyService ? "Active" : "—", color: "from-purple-500 to-pink-500" },
          { label: "Pending", value: String(data?.pendingBridgeIns || 0), color: "from-yellow-400 to-orange-500" },
        ].map(({ label, value, color }) => (
          <div key={label} className="card group text-center transition-all duration-300 hover:border-white/20">
            <div className={`mx-auto mb-3 h-10 w-10 rounded-full bg-gradient-to-br ${color} flex items-center justify-center`}>
              <span className="text-white font-bold text-sm">{label[0]}</span>
            </div>
            <p className="text-2xl font-bold text-white">{value}</p>
            <p className="text-xs text-gray-400 mt-1">{label}</p>
          </div>
        ))}
      </div>

      {/* Quick Actions */}
      <div className="grid gap-4 sm:grid-cols-4">
        {[
          { label: "Mint", href: "#canton-mint", icon: "M12 4v16m8-8H4", color: "emerald" },
          { label: "Stake", href: "#canton-stake", icon: "M13 7h8m0 0v8m0-8l-8 8-4-4-6 6", color: "blue" },
          { label: "Bridge", href: "#canton-bridge", icon: "M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4", color: "purple" },
          { label: "Borrow", href: "#canton-borrow", icon: "M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5", color: "yellow" },
        ].map(({ label, href, icon, color }) => (
          <a
            key={label}
            href={href}
            className={`card group flex items-center gap-4 transition-all duration-300 hover:border-${color}-500/50 hover:bg-${color}-500/5`}
          >
            <div className={`flex h-12 w-12 items-center justify-center rounded-xl bg-${color}-500/10`}>
              <svg className={`h-6 w-6 text-${color}-400`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={icon} />
              </svg>
            </div>
            <div>
              <p className="font-semibold text-white">{label}</p>
              <p className="text-xs text-gray-400">Go to {label.toLowerCase()}</p>
            </div>
          </a>
        ))}
      </div>

      {/* Token Breakdown Table */}
      {data && data.tokens.length > 0 && (
        <Section
          title="mUSD Holdings"
          subtitle={`${data.tokenCount} CantonMUSD contracts on the ledger`}
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  <th className="px-4 py-3">#</th>
                  <th className="px-4 py-3">Amount</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">ETH Tx</th>
                  <th className="px-4 py-3">Contract ID</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {data.tokens.map((token, i) => (
                  <tr key={token.contractId} className="group transition-colors hover:bg-white/[0.02]">
                    <td className="px-4 py-3">
                      <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/10 text-xs font-bold text-emerald-400">{i + 1}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-semibold text-white">{parseFloat(token.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      <span className="ml-1 text-xs text-gray-500">mUSD</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-xs text-gray-300">
                        {token.sourceChain === 11155111 ? "Sepolia" : token.sourceChain === 1 ? "Ethereum" : `Chain ${token.sourceChain}`}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {token.ethTxHash ? (
                        <a href={`https://sepolia.etherscan.io/tx/${token.ethTxHash}`} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-brand-400 hover:text-brand-300">
                          {token.ethTxHash.slice(0, 8)}…{token.ethTxHash.slice(-6)} ↗
                        </a>
                      ) : (
                        <span className="text-xs text-gray-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-gray-500" title={token.contractId}>{token.contractId.slice(0, 10)}…{token.contractId.slice(-8)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-white/10">
                  <td className="px-4 py-3 text-sm font-medium text-gray-400">Total</td>
                  <td className="px-4 py-3">
                    <span className="text-lg font-bold text-emerald-400">{totalMusd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    <span className="ml-1 text-xs text-gray-500">mUSD</span>
                  </td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
          </div>
        </Section>
      )}

      {/* Protocol Services */}
      <Section
        title="Protocol Services"
        subtitle="Core infrastructure contracts on Canton"
        icon={
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0" />
          </svg>
        }
      >
        <div className="grid gap-4 sm:grid-cols-3">
          {[
            { label: "Bridge Service", active: !!data?.bridgeService, detail: data?.bridgeService ? `Nonce ${data.bridgeService.lastNonce}` : "Not deployed" },
            { label: "Supply Service", active: !!data?.supplyService, detail: data?.supplyService ? "Deployed" : "Not deployed" },
            { label: "Ledger API", active: true, detail: `Offset ${data?.ledgerOffset?.toLocaleString()}` },
          ].map((svc) => (
            <div
              key={svc.label}
              className={`card text-center transition-all duration-300 ${svc.active ? "border-emerald-500/30 hover:border-emerald-500/50" : "opacity-60"}`}
            >
              <div className={`mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl ${svc.active ? "bg-emerald-500/10 text-emerald-400" : "bg-gray-800 text-gray-600"}`}>
                <span className={`h-3 w-3 rounded-full ${svc.active ? "bg-emerald-400 animate-pulse" : "bg-gray-600"}`} />
              </div>
              <div className={`mb-1 text-sm font-bold ${svc.active ? "text-emerald-400" : "text-gray-600"}`}>{svc.active ? "Active" : "Inactive"}</div>
              <div className="text-xs text-gray-400">{svc.label}</div>
              <div className="mt-1 text-xs text-gray-500">{svc.detail}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* Party Info */}
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <p className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500">Canton Party</p>
        <p className="break-all font-mono text-sm text-gray-300">{data?.party}</p>
      </div>
    </div>
  );
}
