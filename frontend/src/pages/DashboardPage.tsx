import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { StatCard } from "@/components/StatCard";
import { formatUSD, formatToken, formatBps, formatHealthFactor } from "@/lib/format";

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

interface Props {
  contracts: Record<string, ethers.Contract | null>;
}

export function DashboardPage({ contracts }: Props) {
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
  }, [contracts]);

  if (loading) {
    return <div className="text-center text-gray-400 py-20">Loading protocol data...</div>;
  }

  if (!data) {
    return <div className="text-center text-gray-400 py-20">Connect wallet to view dashboard</div>;
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-white">Protocol Dashboard</h1>
        <p className="mt-1 text-gray-400">Minted Protocol overview across Ethereum and Canton</p>
      </div>

      {/* mUSD Supply */}
      <section>
        <h2 className="mb-4 text-lg font-semibold text-gray-300">mUSD Supply</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Total Supply" value={formatUSD(data.musdSupply)} color="blue" />
          <StatCard label="Supply Cap" value={formatUSD(data.supplyCap)} />
          <StatCard
            label="Utilization"
            value={
              data.supplyCap > 0n
                ? `${((Number(data.musdSupply) / Number(data.supplyCap)) * 100).toFixed(1)}%`
                : "N/A"
            }
            color={data.musdSupply > (data.supplyCap * 9n) / 10n ? "red" : "green"}
          />
          <StatCard
            label="Remaining Mintable"
            value={formatUSD(data.supplyCap > data.musdSupply ? data.supplyCap - data.musdSupply : 0n)}
          />
        </div>
      </section>

      {/* Treasury */}
      <section>
        <h2 className="mb-4 text-lg font-semibold text-gray-300">Treasury (USDC Backing)</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard label="Total Backing" value={formatUSD(data.totalBacking, 6)} color="green" />
          <StatCard label="Available Reserves" value={formatUSD(data.availableReserves, 6)} />
          <StatCard label="Deployed to Strategies" value={formatUSD(data.deployedToStrategies, 6)} color="yellow" />
        </div>
      </section>

      {/* Staking */}
      <section>
        <h2 className="mb-4 text-lg font-semibold text-gray-300">Staking Vault (smUSD)</h2>
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
      </section>

      {/* Canton Bridge */}
      <section>
        <h2 className="mb-4 text-lg font-semibold text-gray-300">Canton Bridge</h2>
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
          />
        </div>
      </section>

      {/* Fees & Rates */}
      <section>
        <h2 className="mb-4 text-lg font-semibold text-gray-300">Fees & Rates</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard label="Mint Fee" value={formatBps(data.mintFeeBps)} />
          <StatCard label="Redeem Fee" value={formatBps(data.redeemFeeBps)} />
          <StatCard label="Borrow Rate (APR)" value={formatBps(data.interestRateBps)} />
        </div>
      </section>
    </div>
  );
}
