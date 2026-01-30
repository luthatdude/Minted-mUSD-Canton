import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { StatCard } from "@/components/StatCard";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/Section";
import { formatUSD, formatToken, formatBps, formatHealthFactor } from "@/lib/format";
import { useWalletConnect } from "@/hooks/useWalletConnect";
import { useWCContracts } from "@/hooks/useWCContracts";
import WalletConnector from "@/components/WalletConnector";

interface DashboardData {
  musdSupply: bigint;
  supplyCap: bigint;
  totalBacking: bigint;
  availableReserves: bigint;
  deployedToStrategies: bigint;
  smusdTotalAssets: bigint;
  smusdTotalSupply: bigint;
  attestedAssets: bigint;
  collateralRatio: bigint;
  bridgeHealthRatio: bigint;
  bridgePaused: boolean;
  mintFeeBps: bigint;
  redeemFeeBps: bigint;
  interestRateBps: bigint;
}

export function DashboardPage() {
  const { isConnected } = useWalletConnect();
  const contracts = useWCContracts();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const { musd, smusd, treasury, bridge, directMint, borrow } = contracts;
      if (!musd) return;

      try {
        const results = await Promise.allSettled([
          musd.totalSupply(),
          musd.supplyCap(),
          treasury?.totalBacking() ?? 0n,
          treasury?.availableReserves() ?? 0n,
          treasury?.deployedToStrategies() ?? 0n,
          smusd?.totalAssets() ?? 0n,
          smusd?.totalSupply() ?? 0n,
          bridge?.attestedCantonAssets() ?? 0n,
          bridge?.collateralRatioBps() ?? 0n,
          bridge?.getHealthRatio() ?? 0n,
          bridge?.paused() ?? false,
          directMint?.mintFeeBps() ?? 0n,
          directMint?.redeemFeeBps() ?? 0n,
          borrow?.interestRateBps() ?? 0n,
        ]);

        const val = (i: number) => results[i].status === "fulfilled" ? (results[i] as any).value : 0n;

        setData({
          musdSupply: val(0),
          supplyCap: val(1),
          totalBacking: val(2),
          availableReserves: val(3),
          deployedToStrategies: val(4),
          smusdTotalAssets: val(5),
          smusdTotalSupply: val(6),
          attestedAssets: val(7),
          collateralRatio: val(8),
          bridgeHealthRatio: val(9),
          bridgePaused: results[10].status === "fulfilled" ? (results[10] as any).value : false,
          mintFeeBps: val(11),
          redeemFeeBps: val(12),
          interestRateBps: val(13),
        });
      } catch (err) {
        console.error("Dashboard load error:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [contracts, isConnected]);

  if (!isConnected) {
    return <WalletConnector mode="ethereum" />;
  }

  if (loading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-4 border-brand-500/20 border-t-brand-500" />
          <p className="text-gray-400">Loading protocol data...</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="card-gradient-border max-w-md p-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-500/10">
            <svg className="h-8 w-8 text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h3 className="mb-2 text-xl font-semibold text-white">No Data Available</h3>
          <p className="text-gray-400">Unable to load protocol data. Please check your network connection.</p>
        </div>
      </div>
    );
  }

  const utilizationPct = data.supplyCap > 0n 
    ? (Number(data.musdSupply) / Number(data.supplyCap)) * 100 
    : 0;

  return (
    <div className="space-y-10">
      <PageHeader
        title="Protocol Dashboard"
        subtitle="Real-time overview of Minted Protocol across Ethereum and Canton"
        badge="Live"
        badgeColor="emerald"
      />

      {/* Hero Stats */}
      <div className="card-gradient-border p-8">
        <div className="grid gap-8 lg:grid-cols-3">
          <div className="space-y-2">
            <p className="text-sm font-medium text-gray-400">Total Value Locked</p>
            <p className="text-4xl font-bold text-white">{formatUSD(data.totalBacking, 6)}</p>
            <p className="flex items-center gap-2 text-sm text-emerald-400">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
              </svg>
              Fully backed by USDC
            </p>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-gray-400">mUSD Supply</p>
            <p className="text-4xl font-bold text-gradient">{formatUSD(data.musdSupply)}</p>
            <div className="mt-2">
              <div className="mb-1 flex justify-between text-xs text-gray-500">
                <span>Utilization</span>
                <span>{utilizationPct.toFixed(1)}%</span>
              </div>
              <div className="progress">
                <div 
                  className={`progress-bar ${utilizationPct > 90 ? "!bg-red-500" : utilizationPct > 70 ? "!bg-yellow-500" : ""}`}
                  style={{ width: `${Math.min(utilizationPct, 100)}%` }}
                />
              </div>
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-gray-400">Total Staked</p>
            <p className="text-4xl font-bold text-gradient-emerald">{formatToken(data.smusdTotalAssets)}</p>
            <p className="text-sm text-gray-500">
              {data.smusdTotalSupply > 0n 
                ? `Exchange Rate: 1 smUSD = ${(Number(data.smusdTotalAssets) / Number(data.smusdTotalSupply)).toFixed(4)} mUSD`
                : "1:1 Exchange Rate"
              }
            </p>
          </div>
        </div>
      </div>

      {/* mUSD Supply Section */}
      <Section 
        title="mUSD Supply" 
        subtitle="Stablecoin issuance metrics"
        icon={
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard 
            label="Total Supply" 
            value={formatUSD(data.musdSupply)} 
            color="blue" 
            variant="glow"
            icon={
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            }
          />
          <StatCard label="Supply Cap" value={formatUSD(data.supplyCap)} />
          <StatCard
            label="Utilization"
            value={`${utilizationPct.toFixed(1)}%`}
            color={utilizationPct > 90 ? "red" : utilizationPct > 70 ? "yellow" : "green"}
          />
          <StatCard
            label="Remaining Mintable"
            value={formatUSD(data.supplyCap > data.musdSupply ? data.supplyCap - data.musdSupply : 0n)}
          />
        </div>
      </Section>

      {/* Treasury Section */}
      <Section 
        title="Treasury" 
        subtitle="USDC backing and yield strategies"
        icon={
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
          </svg>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard 
            label="Total Backing" 
            value={formatUSD(data.totalBacking, 6)} 
            color="green" 
            variant="glow"
            icon={
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            }
          />
          <StatCard label="Available Reserves" value={formatUSD(data.availableReserves, 6)} />
          <StatCard label="Deployed to Strategies" value={formatUSD(data.deployedToStrategies, 6)} color="yellow" />
        </div>
      </Section>

      {/* Staking Section */}
      <Section 
        title="Staking Vault" 
        subtitle="smUSD yield-bearing staking"
        icon={
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
          </svg>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard label="Total Staked (mUSD)" value={formatToken(data.smusdTotalAssets)} />
          <StatCard label="smUSD Supply" value={formatToken(data.smusdTotalSupply)} />
          <StatCard
            label="Exchange Rate"
            value={
              data.smusdTotalSupply > 0n
                ? `1 smUSD = ${(Number(data.smusdTotalAssets) / Number(data.smusdTotalSupply)).toFixed(4)} mUSD`
                : "1:1"
            }
            color="green"
          />
        </div>
      </Section>

      {/* Canton Bridge Section */}
      <Section 
        title="Canton Bridge" 
        subtitle="Cross-chain asset attestation"
        icon={
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
          </svg>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Attested Assets" value={formatUSD(data.attestedAssets)} color="blue" />
          <StatCard label="Collateral Ratio" value={formatBps(data.collateralRatio)} />
          <StatCard
            label="Health Ratio"
            value={formatHealthFactor(data.bridgeHealthRatio)}
            color={data.bridgeHealthRatio < ethers.parseUnits("1.1", 18) ? "red" : "green"}
          />
          <StatCard
            label="Bridge Status"
            value={data.bridgePaused ? "PAUSED" : "Active"}
            color={data.bridgePaused ? "red" : "green"}
            icon={
              data.bridgePaused ? (
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              ) : (
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              )
            }
          />
        </div>
      </Section>

      {/* Fees & Rates Section */}
      <Section 
        title="Fees & Rates" 
        subtitle="Protocol fee structure"
        icon={
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard label="Mint Fee" value={formatBps(data.mintFeeBps)} color="purple" />
          <StatCard label="Redeem Fee" value={formatBps(data.redeemFeeBps)} color="purple" />
          <StatCard label="Borrow Rate (APR)" value={formatBps(data.interestRateBps)} color="yellow" />
        </div>
      </Section>
    </div>
  );
}
