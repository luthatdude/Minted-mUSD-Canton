import React, { useState } from "react";
import { StatCard } from "@/components/StatCard";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/Section";
import { useCantonLedger } from "@/hooks/useCantonLedger";
import { useLoopWallet } from "@/hooks/useLoopWallet";
import { CantonMint } from "./CantonMint";

function fmtAmount(value: number, digits = 2): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

function truncateMiddle(value: string, head = 18, tail = 8): string {
  if (!value || value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

export function CantonDashboard() {
  const loopWallet = useLoopWallet();
  const [activeTab, setActiveTab] = useState<"protocol" | "portfolio" | "mint">("protocol");
  const activeParty = loopWallet.partyId || null;
  const hasConnectedUserParty = Boolean(activeParty && activeParty.trim());
  const { data, loading, error, refresh } = useCantonLedger(15_000, activeParty);
  const { data: operatorData } = useCantonLedger(15_000);

  if (loading && !data) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-4 border-emerald-500/20 border-t-emerald-500" />
          <p className="text-gray-400">Loading protocol data...</p>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="card-gradient-border max-w-md p-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-red-500/10">
            <svg className="h-8 w-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <h3 className="mb-2 text-xl font-semibold text-white">Canton Ledger Unavailable</h3>
          <p className="mb-4 text-gray-400">{error}</p>
          <button
            onClick={refresh}
            className="rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-5 py-2 text-sm font-medium text-emerald-300 hover:bg-emerald-500/25"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const totalMusd = Number(data?.totalBalance ?? 0);
  const totalSmusd = Number(data?.totalSmusd ?? 0);
  const totalSmusdE = Number(data?.totalSmusdE ?? 0);
  const totalCoin = Number(data?.totalCoin ?? 0);
  const totalUsdc = Number(data?.totalUsdc ?? 0);
  const totalBoostLP = Number(data?.totalBoostLP ?? 0);
  const musdContracts = data?.tokenCount || 0;
  const pendingBridgeIns = data?.pendingBridgeIns || 0;
  const displayBridgeService = data?.bridgeService || operatorData?.bridgeService || null;
  const displayParty = data?.party || activeParty || "—";
  const displayPartyShort = displayParty === "—" ? displayParty : truncateMiddle(displayParty);

  const lendingService = data?.lendingService;
  const poolService = data?.ethPoolService;
  const borrowRateBps = lendingService?.interestRateBps ?? 0;
  const totalBorrows = Number(lendingService?.totalBorrows ?? 0);
  const protocolReserves = Number(lendingService?.protocolReserves ?? 0);

  const supplyCap = Number(lendingService?.cantonSupplyCap ?? 0);
  const currentSupply = Number(lendingService?.cantonCurrentSupply ?? totalMusd);
  const supplyUtilizationPct = supplyCap > 0 ? (currentSupply / supplyCap) * 100 : 0;
  const remainingMintable = supplyCap > currentSupply ? supplyCap - currentSupply : 0;

  const poolCap = Number(poolService?.poolCap ?? 0);
  const pooledUsdc = Number(poolService?.pooledUsdc ?? 0);
  const poolUtilizationPct = poolCap > 0 ? (pooledUsdc / poolCap) * 100 : 0;

  const portfolioTotal = totalMusd + totalSmusd + totalSmusdE + totalCoin + totalUsdc;
  const totalStaked = totalSmusd + totalSmusdE;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <PageHeader
          title="Dashboard"
          subtitle="Overview of the Minted Protocol"
          badge="Canton"
          badgeColor="emerald"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab("protocol")}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === "protocol"
                ? "bg-brand-500 text-white"
                : "bg-slate-800 text-gray-400 hover:text-white"
            }`}
          >
            Protocol Stats
          </button>
          <button
            onClick={() => setActiveTab("portfolio")}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === "portfolio"
                ? "bg-brand-500 text-white"
                : "bg-slate-800 text-gray-400 hover:text-white"
            }`}
          >
            Portfolio Stats
          </button>
          <button
            onClick={() => setActiveTab("mint")}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === "mint"
                ? "bg-brand-500 text-white"
                : "bg-slate-800 text-gray-400 hover:text-white"
            }`}
          >
            Mint & Redeem
          </button>
        </div>
      </div>

      {error && data && (
        <div className="rounded-lg border border-yellow-800 bg-yellow-900/20 p-3 text-sm text-yellow-400">
          Refresh failed: {error}. Showing cached data.
        </div>
      )}

      {!hasConnectedUserParty && (
        <div className="rounded-lg border border-purple-500/30 bg-purple-500/10 p-3 text-sm text-purple-200">
          Connect your Loop wallet to view user-scoped Canton balances. Protocol stats remain available.
        </div>
      )}

      {activeTab === "mint" && <CantonMint />}

      {activeTab === "portfolio" && (
        <>
          <div className="card-gradient-border p-8">
            <div className="grid gap-8 lg:grid-cols-4">
              <div className="space-y-2 lg:col-span-2">
                <p className="text-sm font-medium text-gray-400">Net Portfolio Value</p>
                <p className="text-5xl font-bold text-white">${fmtAmount(portfolioTotal)}</p>
                <p className="text-sm text-gray-500">Connected party: {displayPartyShort}</p>
              </div>
              <div className="space-y-4">
                <div>
                  <p className="text-xs uppercase tracking-wider text-gray-500">Total Assets</p>
                  <p className="text-2xl font-semibold text-emerald-400">${fmtAmount(portfolioTotal)}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wider text-gray-500">mUSD Contracts</p>
                  <p className="text-2xl font-semibold text-white">{musdContracts}</p>
                </div>
              </div>
              <div className="flex flex-col items-center justify-center rounded-xl bg-slate-800/50 p-4">
                <p className="mb-2 text-xs uppercase tracking-wider text-gray-500">Bridge Service</p>
                <p className={`text-4xl font-bold ${displayBridgeService ? "text-emerald-400" : "text-gray-500"}`}>
                  {displayBridgeService ? "Live" : "—"}
                </p>
                <p className="mt-1 text-xs text-gray-400">
                  {displayBridgeService ? `Last nonce ${displayBridgeService.lastNonce}` : "Unavailable"}
                </p>
              </div>
            </div>
          </div>

          <Section
            title="Your Balances"
            subtitle="Token holdings on Canton"
            icon={
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
                />
              </svg>
            }
          >
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <StatCard label="mUSD" value={fmtAmount(totalMusd)} color="purple" variant="glow" />
              <StatCard label="smUSD" value={fmtAmount(totalSmusd)} color="green" />
              <StatCard label="smUSD-E" value={fmtAmount(totalSmusdE)} color="blue" />
              <StatCard label="Canton Coin" value={fmtAmount(totalCoin)} color="yellow" />
              <StatCard label="USDC" value={fmtAmount(totalUsdc)} color="blue" />
            </div>
          </Section>

          {data && data.tokens.length > 0 && (
            <Section
              title="mUSD Holdings"
              subtitle={`${data.tokenCount} CantonMUSD contracts on the ledger`}
              icon={
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
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
                          <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/10 text-xs font-bold text-emerald-400">
                            {i + 1}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="font-semibold text-white">
                            {Number(token.amount).toLocaleString(undefined, {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                          </span>
                          <span className="ml-1 text-xs text-gray-500">mUSD</span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-xs text-gray-300">
                            {token.sourceChain === 11155111
                              ? "Sepolia"
                              : token.sourceChain === 1
                                ? "Ethereum"
                                : `Chain ${token.sourceChain}`}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {token.ethTxHash ? (
                            <a
                              href={`https://sepolia.etherscan.io/tx/${token.ethTxHash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-mono text-xs text-brand-400 hover:text-brand-300"
                            >
                              {token.ethTxHash.slice(0, 8)}…{token.ethTxHash.slice(-6)} ↗
                            </a>
                          ) : (
                            <span className="text-xs text-gray-600">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span className="font-mono text-xs text-gray-500" title={token.contractId}>
                            {token.contractId.slice(0, 10)}…{token.contractId.slice(-8)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-white/10">
                      <td className="px-4 py-3 text-sm font-medium text-gray-400">Total</td>
                      <td className="px-4 py-3">
                        <span className="text-lg font-bold text-emerald-400">{fmtAmount(totalMusd)}</span>
                        <span className="ml-1 text-xs text-gray-500">mUSD</span>
                      </td>
                      <td colSpan={3} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Section>
          )}

          <Section
            title="Quick Summary"
            subtitle="Connected party and relay state"
            icon={
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M12 4v16m8-8H4"
                />
              </svg>
            }
          >
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label="Active Party" value={displayPartyShort} color="blue" subValue="Loop wallet" />
              <StatCard label="Pending Bridge-Ins" value={pendingBridgeIns.toString()} color="yellow" />
              <StatCard
                label="Last Ledger Offset"
                value={data?.ledgerOffset ? data.ledgerOffset.toLocaleString() : "—"}
                color="green"
                subValue={data?.timestamp ? new Date(data.timestamp).toLocaleTimeString() : undefined}
              />
            </div>
          </Section>
        </>
      )}

      {activeTab === "protocol" && (
        <>
          <div className="card-gradient-border p-8">
            <div className="grid gap-8 lg:grid-cols-3">
              <div className="space-y-2">
                <p className="text-sm font-medium text-gray-400">Total Value Locked</p>
                <p className="text-4xl font-bold text-white">${fmtAmount(portfolioTotal)}</p>
                <p className="text-sm text-emerald-400">On-ledger Canton assets and balances</p>
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium text-gray-400">mUSD Supply</p>
                <p className="text-4xl font-bold text-gradient">{fmtAmount(totalMusd)}</p>
                <div className="mt-2">
                  <div className="mb-1 flex justify-between text-xs text-gray-500">
                    <span>Utilization</span>
                    <span>{supplyCap > 0 ? `${supplyUtilizationPct.toFixed(1)}%` : "—"}</span>
                  </div>
                  <div className="progress">
                    <div
                      className={`progress-bar ${
                        supplyUtilizationPct > 90 ? "!bg-red-500" : supplyUtilizationPct > 70 ? "!bg-yellow-500" : ""
                      }`}
                      style={{ width: `${Math.min(supplyUtilizationPct, 100)}%` }}
                    />
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium text-gray-400">Total Staked</p>
                <p className="text-4xl font-bold text-gradient-emerald">{fmtAmount(totalStaked)}</p>
                <p className="text-sm text-gray-500">smUSD + smUSD-E positions</p>
              </div>
            </div>
          </div>

          <Section
            title="mUSD Supply"
            subtitle="Canton issuance and pending inflows"
            icon={
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            }
          >
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Total Supply" value={fmtAmount(totalMusd)} color="blue" variant="glow" />
              <StatCard label="Token Contracts" value={musdContracts.toString()} color="purple" />
              <StatCard label="Pending Bridge-Ins" value={pendingBridgeIns.toString()} color="yellow" />
              <StatCard
                label="Remaining Mintable"
                value={supplyCap > 0 ? fmtAmount(remainingMintable) : "—"}
                color={supplyCap > 0 && remainingMintable < currentSupply * 0.1 ? "red" : "green"}
              />
            </div>
          </Section>

          <Section
            title="Canton Bridge"
            subtitle="Relay and sequencing status"
            icon={
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
                />
              </svg>
            }
          >
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Bridge Status" value={displayBridgeService ? "Active" : "Unavailable"} color={displayBridgeService ? "green" : "red"} />
              <StatCard label="Last Nonce" value={displayBridgeService ? String(displayBridgeService.lastNonce) : "—"} color="blue" />
              <StatCard label="Pending Transfers" value={pendingBridgeIns.toString()} color="yellow" />
              <StatCard label="Active Party" value={displayPartyShort} color="purple" />
            </div>
          </Section>

          <Section
            title="Lending & Pools"
            subtitle="Borrowing and pooled liquidity metrics"
            icon={
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5"
                />
              </svg>
            }
          >
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Borrow Rate (APR)" value={fmtBps(borrowRateBps)} color="yellow" />
              <StatCard label="Total Borrows" value={fmtAmount(totalBorrows)} color="red" />
              <StatCard label="Protocol Reserves" value={fmtAmount(protocolReserves)} color="blue" />
              <StatCard
                label="Pool Utilization"
                value={poolCap > 0 ? `${poolUtilizationPct.toFixed(1)}%` : "—"}
                color={poolUtilizationPct > 90 ? "red" : poolUtilizationPct > 70 ? "yellow" : "green"}
              />
            </div>
          </Section>

          <Section
            title="Protocol Services"
            subtitle="Deployed Canton service contracts"
            icon={
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0"
                />
              </svg>
            }
          >
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Bridge Service" value={displayBridgeService ? "Active" : "Inactive"} color={displayBridgeService ? "green" : "red"} />
              <StatCard label="Direct Mint" value={data?.directMintService ? "Active" : "Inactive"} color={data?.directMintService ? "green" : "red"} />
              <StatCard label="Lending" value={lendingService ? "Active" : "Inactive"} color={lendingService ? "green" : "red"} />
              <StatCard label="ETH Pool" value={poolService ? "Active" : "Inactive"} color={poolService ? "green" : "red"} />
            </div>
          </Section>

          <Section
            title="Extended Assets"
            subtitle="Additional balances tracked on Canton"
            icon={
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M3 7h18M3 12h18M3 17h18"
                />
              </svg>
            }
          >
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <StatCard label="Boost LP" value={fmtAmount(totalBoostLP)} color="purple" />
              <StatCard label="Price Feeds" value={String(data?.priceFeeds.length || 0)} color="blue" />
              <StatCard label="Ledger Offset" value={data?.ledgerOffset ? data.ledgerOffset.toLocaleString() : "—"} color="green" />
            </div>
          </Section>
        </>
      )}
    </div>
  );
}
