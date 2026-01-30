import React, { useState, useEffect } from "react";
import { StatCard } from "@/components/StatCard";
import { useCanton } from "@/hooks/useCanton";

interface Props {
  canton: ReturnType<typeof useCanton>;
}

export function CantonDashboard({ canton }: Props) {
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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!canton.connected) return;
    async function load() {
      setLoading(true);
      try {
        const [musd, usdc, collateral, vaults, proposals, attestations, mintSvc, stakeSvc, oracleSvc, issuer, pool] =
          await Promise.all([
            canton.query("MintedProtocolV2Fixed:MUSD"),
            canton.query("MintedProtocolV2Fixed:USDC"),
            canton.query("MintedProtocolV2Fixed:Collateral"),
            canton.query("MintedProtocolV2Fixed:Vault"),
            canton.query("MintedProtocolV2Fixed:TransferProposal"),
            canton.query("MintedProtocolV2Fixed:AttestationRequest"),
            canton.query("MintedProtocolV2Fixed:DirectMintService"),
            canton.query("MintedProtocolV2Fixed:StakingService"),
            canton.query("MintedProtocolV2Fixed:PriceOracle"),
            canton.query("MintedProtocolV2Fixed:IssuerRole"),
            canton.query("MintedProtocolV2Fixed:LiquidityPool"),
          ]);

        setStats({
          musdContracts: musd.length,
          musdTotal: musd.reduce((s, c) => s + parseFloat(c.payload?.amount || "0"), 0),
          usdcContracts: usdc.length,
          usdcTotal: usdc.reduce((s, c) => s + parseFloat(c.payload?.amount || "0"), 0),
          collateralContracts: collateral.length,
          collateralTotal: collateral.reduce((s, c) => s + parseFloat(c.payload?.amount || "0"), 0),
          vaults: vaults.length,
          proposals: proposals.length,
          attestations: attestations.length,
          mintService: mintSvc.length > 0,
          stakingService: stakeSvc.length > 0,
          oracle: oracleSvc.length > 0,
          issuerRole: issuer.length > 0,
          pool: pool.length > 0,
        });
      } catch (err) {
        console.error("Canton dashboard load error:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [canton.connected]);

  if (!canton.connected) {
    return (
      <div className="text-center text-gray-400 py-20">
        Connect to Canton Ledger to view Canton dashboard
      </div>
    );
  }

  if (loading) {
    return <div className="text-center text-gray-400 py-20">Loading Canton contracts...</div>;
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-white">Protocol Dashboard</h1>
        <p className="text-emerald-400 text-sm font-medium mt-1">Canton Network (Daml Ledger)</p>
      </div>

      {/* Assets */}
      <section>
        <h2 className="mb-4 text-lg font-semibold text-gray-300">Canton Assets</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard
            label="mUSD Contracts"
            value={`${stats.musdContracts}`}
            subValue={`Total: ${stats.musdTotal.toFixed(2)} mUSD`}
            color="blue"
          />
          <StatCard
            label="USDC Contracts"
            value={`${stats.usdcContracts}`}
            subValue={`Total: ${stats.usdcTotal.toFixed(2)} USDC`}
          />
          <StatCard
            label="Collateral Contracts"
            value={`${stats.collateralContracts}`}
            subValue={`Total: ${stats.collateralTotal.toFixed(2)}`}
          />
        </div>
      </section>

      {/* Positions */}
      <section>
        <h2 className="mb-4 text-lg font-semibold text-gray-300">Active Positions</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard label="Open Vaults (CDPs)" value={stats.vaults.toString()} color={stats.vaults > 0 ? "yellow" : "default"} />
          <StatCard label="Transfer Proposals" value={stats.proposals.toString()} />
          <StatCard label="Pending Attestations" value={stats.attestations.toString()} color={stats.attestations > 0 ? "yellow" : "default"} />
        </div>
      </section>

      {/* Services */}
      <section>
        <h2 className="mb-4 text-lg font-semibold text-gray-300">Protocol Services</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {[
            { label: "DirectMint", active: stats.mintService },
            { label: "Staking", active: stats.stakingService },
            { label: "Price Oracle", active: stats.oracle },
            { label: "Issuer Role", active: stats.issuerRole },
            { label: "Liquidity Pool", active: stats.pool },
          ].map((svc) => (
            <div key={svc.label} className="card text-center">
              <div className={`mb-1 text-lg font-bold ${svc.active ? "text-green-400" : "text-gray-600"}`}>
                {svc.active ? "Active" : "Inactive"}
              </div>
              <div className="text-sm text-gray-400">{svc.label}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
