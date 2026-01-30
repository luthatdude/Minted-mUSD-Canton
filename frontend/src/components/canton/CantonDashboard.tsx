import React, { useState, useEffect, useCallback } from "react";
import { StatCard } from "@/components/StatCard";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/Section";
import { useLoopWallet, LoopContract } from "@/hooks/useLoopWallet";
import WalletConnector from "@/components/WalletConnector";

// DAML template IDs
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

export function CantonDashboard() {
  const loopWallet = useLoopWallet();
  
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
    } catch (err) {
      console.error("Canton dashboard load error:", err);
    } finally {
      setLoading(false);
    }
  }, [loopWallet.isConnected, loopWallet.queryContracts]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (!loopWallet.isConnected) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="max-w-md space-y-6">
          <div className="card-emerald p-8 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/10">
              <svg className="h-8 w-8 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
              </svg>
            </div>
            <h3 className="mb-2 text-xl font-semibold text-white">Connect to Canton Network</h3>
            <p className="text-gray-400 mb-6">Connect your Loop Wallet to view the Canton Network dashboard.</p>
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
          <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-4 border-emerald-500/20 border-t-emerald-500" />
          <p className="text-gray-400">Loading Canton contracts...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <PageHeader
        title="Canton Dashboard"
        subtitle="Real-time overview of Minted Protocol on the Canton Network"
        badge="Canton"
        badgeColor="emerald"
      />

      {/* Hero Stats */}
      <div className="card-emerald overflow-hidden p-8">
        <div className="grid gap-8 lg:grid-cols-3">
          <div className="space-y-2">
            <p className="text-sm font-medium text-gray-400">Total mUSD Supply</p>
            <p className="text-4xl font-bold text-gradient-emerald">{stats.musdTotal.toFixed(2)}</p>
            <p className="flex items-center gap-2 text-sm text-emerald-400">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              {stats.musdContracts} active contracts
            </p>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-gray-400">USDC Reserves</p>
            <p className="text-4xl font-bold text-white">{stats.usdcTotal.toFixed(2)}</p>
            <p className="text-sm text-gray-500">{stats.usdcContracts} contracts</p>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-gray-400">Collateral Locked</p>
            <p className="text-4xl font-bold text-white">{stats.collateralTotal.toFixed(2)}</p>
            <p className="text-sm text-gray-500">{stats.collateralContracts} contracts</p>
          </div>
        </div>
      </div>

      {/* Assets Section */}
      <Section 
        title="Canton Assets" 
        subtitle="Active token contracts on the ledger"
        icon={
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard
            label="mUSD Contracts"
            value={`${stats.musdContracts}`}
            subValue={`Total: ${stats.musdTotal.toFixed(2)} mUSD`}
            color="green"
            variant="glow"
          />
          <StatCard
            label="USDC Contracts"
            value={`${stats.usdcContracts}`}
            subValue={`Total: ${stats.usdcTotal.toFixed(2)} USDC`}
            color="blue"
          />
          <StatCard
            label="Collateral Contracts"
            value={`${stats.collateralContracts}`}
            subValue={`Total: ${stats.collateralTotal.toFixed(2)}`}
          />
        </div>
      </Section>

      {/* Positions Section */}
      <Section 
        title="Active Positions" 
        subtitle="Open vaults and pending proposals"
        icon={
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
          </svg>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard 
            label="Open Vaults (CDPs)" 
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
      </Section>

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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {[
            { label: "DirectMint", active: stats.mintService, icon: "M12 4v16m8-8H4" },
            { label: "Staking", active: stats.stakingService, icon: "M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" },
            { label: "Price Oracle", active: stats.oracle, icon: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" },
            { label: "Issuer Role", active: stats.issuerRole, icon: "M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" },
            { label: "Liquidity Pool", active: stats.pool, icon: "M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" },
          ].map((svc) => (
            <div 
              key={svc.label} 
              className={`card group text-center transition-all duration-300 ${
                svc.active 
                  ? "border-emerald-500/30 hover:border-emerald-500/50" 
                  : "opacity-60"
              }`}
            >
              <div className={`mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl ${
                svc.active 
                  ? "bg-emerald-500/10 text-emerald-400" 
                  : "bg-gray-800 text-gray-600"
              }`}>
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={svc.icon} />
                </svg>
              </div>
              <div className={`mb-1 text-sm font-bold ${svc.active ? "text-emerald-400" : "text-gray-600"}`}>
                {svc.active ? "Active" : "Inactive"}
              </div>
              <div className="text-xs text-gray-400">{svc.label}</div>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
