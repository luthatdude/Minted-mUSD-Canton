import React, { useState, useEffect } from "react";
import { ethers } from "ethers";
import { StatCard } from "@/components/StatCard";
import { formatUSD, formatBps, formatHealthFactor, formatTimestamp } from "@/lib/format";
import { useWalletConnect } from "@/hooks/useWalletConnect";
import { useWCContracts } from "@/hooks/useWCContracts";
import WalletConnector from "@/components/WalletConnector";

export function BridgePage() {
  const { isConnected } = useWalletConnect();
  const contracts = useWCContracts();
  const [data, setData] = useState({
    attestedAssets: 0n,
    supplyCap: 0n,
    remainingMintable: 0n,
    collateralRatio: 0n,
    healthRatio: 0n,
    minSigs: 0n,
    nonce: 0n,
    lastAttestation: 0n,
    paused: false,
  });
  const [events, setEvents] = useState<any[]>([]);

  const { bridge } = contracts;

  useEffect(() => {
    async function load() {
      if (!bridge) return;
      try {
        const [
          attestedAssets,
          supplyCap,
          remainingMintable,
          collateralRatio,
          healthRatio,
          minSigs,
          nonce,
          lastAttestation,
          paused,
        ] = await Promise.all([
          bridge.attestedCantonAssets(),
          bridge.getCurrentSupplyCap(),
          bridge.getRemainingMintable(),
          bridge.collateralRatioBps(),
          bridge.getHealthRatio(),
          bridge.minSignatures(),
          bridge.currentNonce(),
          bridge.lastAttestationTime(),
          bridge.paused(),
        ]);
        setData({
          attestedAssets,
          supplyCap,
          remainingMintable,
          collateralRatio,
          healthRatio,
          minSigs,
          nonce,
          lastAttestation,
          paused,
        });
      } catch (err) {
        console.error("Bridge load error:", err);
      }
    }
    load();
  }, [bridge]);

  // Load recent attestation events
  useEffect(() => {
    async function loadEvents() {
      if (!bridge) return;
      try {
        const filter = bridge.filters.AttestationReceived();
        const logs = await bridge.queryFilter(filter, -10000);
        const parsed = logs.slice(-20).reverse().map((log: any) => ({
          id: log.args.id,
          cantonAssets: log.args.cantonAssets,
          newSupplyCap: log.args.newSupplyCap,
          nonce: log.args.nonce,
          timestamp: log.args.timestamp,
          blockNumber: log.blockNumber,
        }));
        setEvents(parsed);
      } catch {}
    }
    loadEvents();
  }, [bridge]);

  if (!isConnected) {
    return <WalletConnector mode="ethereum" />;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-white">Canton Bridge</h1>
      <p className="text-gray-400">
        Real-time view of Canton Network attestations that govern mUSD supply cap on Ethereum
      </p>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Bridge Status"
          value={data.paused ? "PAUSED" : "Active"}
          color={data.paused ? "red" : "green"}
        />
        <StatCard label="Attested Canton Assets" value={formatUSD(data.attestedAssets)} color="blue" />
        <StatCard label="Current Supply Cap" value={formatUSD(data.supplyCap)} />
        <StatCard label="Remaining Mintable" value={formatUSD(data.remainingMintable)} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Collateral Ratio" value={formatBps(data.collateralRatio)} />
        <StatCard
          label="Health Ratio"
          value={formatHealthFactor(data.healthRatio)}
          color={data.healthRatio < ethers.parseUnits("1.1", 18) ? "red" : "green"}
        />
        <StatCard label="Required Signatures" value={data.minSigs.toString()} />
        <StatCard label="Current Nonce" value={data.nonce.toString()} />
      </div>

      {data.lastAttestation > 0n && (
        <div className="card">
          <p className="text-sm text-gray-400">
            Last attestation: {formatTimestamp(Number(data.lastAttestation))}
          </p>
        </div>
      )}

      {/* Attestation History */}
      <div className="card">
        <h2 className="mb-4 text-lg font-semibold text-gray-300">Recent Attestations</h2>
        {events.length === 0 ? (
          <p className="text-gray-500">No attestations found</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700 text-gray-400">
                  <th className="pb-2 text-left">Block</th>
                  <th className="pb-2 text-left">Attestation ID</th>
                  <th className="pb-2 text-right">Canton Assets</th>
                  <th className="pb-2 text-right">New Supply Cap</th>
                  <th className="pb-2 text-right">Nonce</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={i} className="border-b border-gray-800">
                    <td className="py-2 text-gray-300">{e.blockNumber}</td>
                    <td className="py-2 font-mono text-xs text-gray-400">
                      {e.id.slice(0, 10)}...{e.id.slice(-8)}
                    </td>
                    <td className="py-2 text-right">{formatUSD(e.cantonAssets)}</td>
                    <td className="py-2 text-right">{formatUSD(e.newSupplyCap)}</td>
                    <td className="py-2 text-right">{e.nonce.toString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* How it works */}
      <div className="card">
        <h2 className="mb-4 text-lg font-semibold text-gray-300">How the Bridge Works</h2>
        <ol className="list-decimal list-inside space-y-2 text-sm text-gray-400">
          <li>Canton validators observe tokenized RWA positions on Canton Network</li>
          <li>Each validator independently verifies asset values via Canton Asset API</li>
          <li>Validators sign ECDSA attestations (requires {data.minSigs.toString()} of N signatures)</li>
          <li>Aggregator submits multi-sig attestation to BLEBridgeV9 on Ethereum</li>
          <li>Bridge verifies signatures and updates mUSD supply cap based on attested assets / {formatBps(data.collateralRatio)} ratio</li>
          <li>DirectMint allows users to mint up to the supply cap using USDC</li>
        </ol>
      </div>
    </div>
  );
}
