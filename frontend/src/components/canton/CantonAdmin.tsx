import React, { useState, useEffect, useCallback } from "react";
import { TxButton } from "@/components/TxButton";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/Section";
import { StatCard } from "@/components/StatCard";
import { useLoopWallet, LoopContract } from "@/hooks/useLoopWallet";
import WalletConnector from "@/components/WalletConnector";

// DAML template IDs
const PACKAGE_ID = process.env.NEXT_PUBLIC_DAML_PACKAGE_ID || "";
const templates = {
  IssuerRole: `${PACKAGE_ID}:MintedProtocolV2Fixed:IssuerRole`,
  PriceOracle: `${PACKAGE_ID}:MintedProtocolV2Fixed:PriceOracle`,
  DirectMintService: `${PACKAGE_ID}:MintedProtocolV2Fixed:DirectMintService`,
  LiquidityPool: `${PACKAGE_ID}:MintedProtocolV2Fixed:LiquidityPool`,
};

export function CantonAdmin() {
  const loopWallet = useLoopWallet();
  
  const [section, setSection] = useState<"issuer" | "oracle" | "mint" | "pool">("issuer");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Issuer
  const [issuerRoles, setIssuerRoles] = useState<LoopContract[]>([]);
  const [mintOwner, setMintOwner] = useState("");
  const [mintAmount, setMintAmount] = useState("");

  // Oracle
  const [oracleContracts, setOracleContracts] = useState<LoopContract[]>([]);
  const [priceSymbol, setPriceSymbol] = useState("ETH");
  const [priceValue, setPriceValue] = useState("");

  // DirectMintService
  const [mintServices, setMintServices] = useState<LoopContract[]>([]);
  const [newCap, setNewCap] = useState("");
  const [pauseState, setPauseState] = useState(false);

  // Pool
  const [pools, setPools] = useState<LoopContract[]>([]);
  const [swapAmount, setSwapAmount] = useState("");

  const loadContracts = useCallback(async () => {
    if (!loopWallet.isConnected) return;
    try {
      const [ir, oc, ms, pl] = await Promise.all([
        loopWallet.queryContracts(templates.IssuerRole).catch(() => []),
        loopWallet.queryContracts(templates.PriceOracle).catch(() => []),
        loopWallet.queryContracts(templates.DirectMintService).catch(() => []),
        loopWallet.queryContracts(templates.LiquidityPool).catch(() => []),
      ]);
      setIssuerRoles(ir);
      setOracleContracts(oc);
      setMintServices(ms);
      setPools(pl);
    } catch (err) {
      console.error("Failed to load contracts:", err);
    }
  }, [loopWallet.isConnected, loopWallet.queryContracts]);

  useEffect(() => {
    loadContracts();
  }, [loadContracts]);

  async function handleExercise(templateId: string, cid: string, choice: string, args: any) {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await loopWallet.exerciseChoice(templateId, cid, choice, args);
      setResult(`${choice} executed successfully: ${JSON.stringify(res).slice(0, 200)}`);
      await loadContracts();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (!loopWallet.isConnected) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="max-w-md space-y-6">
          <div className="text-center">
            <h3 className="mb-2 text-xl font-semibold text-white">Connect to Canton</h3>
            <p className="text-gray-400 mb-6">Connect your Loop Wallet to access admin functions.</p>
          </div>
          <WalletConnector mode="canton" />
        </div>
      </div>
    );
  }

  const sections = [
    { key: "issuer" as const, label: "Issuer Role" },
    { key: "oracle" as const, label: "Price Oracle" },
    { key: "mint" as const, label: "Mint Service" },
    { key: "pool" as const, label: "Liquidity Pool" },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <PageHeader
        title="Admin Panel"
        subtitle="Manage Canton DAML protocol contracts and services"
        badge="Admin"
        badgeColor="warning"
      />

      <div className="flex gap-2 rounded-xl bg-surface-800/50 p-1.5 border border-white/10">
        {sections.map((s) => (
          <button
            key={s.key}
            onClick={() => { setSection(s.key); setError(null); setResult(null); }}
            className={`relative flex-1 rounded-lg px-4 py-3 text-sm font-semibold transition-all duration-300 ${
              section === s.key
                ? "bg-surface-700 text-white shadow-lg"
                : "text-gray-400 hover:text-white hover:bg-surface-700/50"
            }`}
          >
            {s.label}
            {section === s.key && (
              <span className="absolute bottom-0 left-1/2 h-0.5 w-16 -translate-x-1/2 rounded-full bg-gradient-to-r from-yellow-400 to-orange-500" />
            )}
          </button>
        ))}
      </div>

      {error && <div className="alert-error text-sm">{error}</div>}
      {result && <div className="alert-success text-sm">{result}</div>}

      {/* Issuer Role */}
      {section === "issuer" && (
        <div className="space-y-4">
          <StatCard label="Issuer Roles" value={issuerRoles.length.toString()} />
          {issuerRoles.length > 0 && (
            <>
              <div className="card">
                <h3 className="mb-3 font-semibold text-gray-300">Direct Mint (Admin)</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="label">Owner Party</label>
                    <input className="input" type="text" placeholder="Alice::1234..." value={mintOwner} onChange={(e) => setMintOwner(e.target.value)} />
                  </div>
                  <div>
                    <label className="label">Amount</label>
                    <input className="input" type="number" placeholder="1000.0" value={mintAmount} onChange={(e) => setMintAmount(e.target.value)} />
                  </div>
                </div>
                <TxButton
                  onClick={() => handleExercise(
                    templates.IssuerRole,
                    issuerRoles[0].contractId,
                    "DirectMint",
                    { owner: mintOwner, amount: mintAmount }
                  )}
                  loading={loading}
                  disabled={!mintOwner || !mintAmount}
                  variant="primary"
                  className="mt-3 w-full"
                >
                  Direct Mint
                </TxButton>
              </div>
              <div className="card">
                <h3 className="mb-3 font-semibold text-gray-300">Mint From Attestation</h3>
                <p className="text-sm text-gray-400">
                  Use this to mint mUSD backed by validated Canton attestations with multi-sig verification.
                  Requires a finalized AttestationRequest contract ID.
                </p>
              </div>
            </>
          )}
        </div>
      )}

      {/* Price Oracle */}
      {section === "oracle" && (
        <div className="space-y-4">
          <StatCard label="Oracle Contracts" value={oracleContracts.length.toString()} />
          {oracleContracts.length > 0 && (
            <>
              <div className="card">
                <h3 className="mb-3 font-semibold text-gray-300">Get Price</h3>
                <div>
                  <label className="label">Symbol</label>
                  <input className="input" type="text" placeholder="ETH" value={priceSymbol} onChange={(e) => setPriceSymbol(e.target.value)} />
                </div>
                <TxButton
                  onClick={() => handleExercise(
                    templates.PriceOracle,
                    oracleContracts[0].contractId,
                    "GetPrice",
                    { symbol: priceSymbol }
                  )}
                  loading={loading}
                  variant="secondary"
                  className="mt-3 w-full"
                >
                  Query Price
                </TxButton>
              </div>
              <div className="card">
                <h3 className="mb-3 font-semibold text-gray-300">Update Prices</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="label">Symbol</label>
                    <input className="input" type="text" value={priceSymbol} onChange={(e) => setPriceSymbol(e.target.value)} />
                  </div>
                  <div>
                    <label className="label">Price (USD)</label>
                    <input className="input" type="number" placeholder="3500.00" value={priceValue} onChange={(e) => setPriceValue(e.target.value)} />
                  </div>
                </div>
                <TxButton
                  onClick={() => handleExercise(
                    templates.PriceOracle,
                    oracleContracts[0].contractId,
                    "UpdatePrices",
                    { updates: [{ symbol: priceSymbol, price: priceValue }] }
                  )}
                  loading={loading}
                  disabled={!priceValue}
                  variant="primary"
                  className="mt-3 w-full"
                >
                  Update Prices
                </TxButton>
              </div>
            </>
          )}
        </div>
      )}

      {/* Mint Service */}
      {section === "mint" && (
        <div className="space-y-4">
          <StatCard label="Mint Services" value={mintServices.length.toString()} />
          {mintServices.length > 0 && (
            <>
              <div className="card">
                <h3 className="mb-3 font-semibold text-gray-300">Current Config</h3>
                <div className="space-y-2 rounded-xl bg-surface-800/30 p-4">
                  {mintServices[0].payload && Object.entries(mintServices[0].payload).slice(0, 8).map(([key, val]) => (
                    <div key={key} className="flex items-center justify-between text-sm">
                      <span className="text-gray-400">{key}</span>
                      <span className="font-mono text-xs text-gray-300">{String(val).slice(0, 40)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="card">
                <h3 className="mb-3 font-semibold text-gray-300">Update Supply Cap</h3>
                <input className="input" type="number" placeholder="10000000" value={newCap} onChange={(e) => setNewCap(e.target.value)} />
                <TxButton
                  onClick={() => handleExercise(
                    templates.DirectMintService,
                    mintServices[0].contractId,
                    "DirectMint_UpdateSupplyCap",
                    { newSupplyCap: newCap }
                  )}
                  loading={loading}
                  disabled={!newCap}
                  variant="primary"
                  className="mt-3 w-full"
                >
                  Update Cap
                </TxButton>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <TxButton
                  onClick={() => handleExercise(
                    templates.DirectMintService,
                    mintServices[0].contractId,
                    "DirectMint_SetPaused",
                    { paused: true }
                  )}
                  loading={loading}
                  variant="danger"
                  className="w-full"
                >
                  Pause Service
                </TxButton>
                <TxButton
                  onClick={() => handleExercise(
                    templates.DirectMintService,
                    mintServices[0].contractId,
                    "DirectMint_SetPaused",
                    { paused: false }
                  )}
                  loading={loading}
                  variant="secondary"
                  className="w-full"
                >
                  Unpause Service
                </TxButton>
              </div>
            </>
          )}
        </div>
      )}

      {/* Liquidity Pool */}
      {section === "pool" && (
        <div className="space-y-4">
          <StatCard label="Pools" value={pools.length.toString()} />
          {pools.length > 0 && (
            <>
              <div className="card">
                <h3 className="mb-3 font-semibold text-gray-300">Pool State</h3>
                <div className="space-y-2 rounded-xl bg-surface-800/30 p-4">
                  {pools[0].payload && Object.entries(pools[0].payload).slice(0, 8).map(([key, val]) => (
                    <div key={key} className="flex items-center justify-between text-sm">
                      <span className="text-gray-400">{key}</span>
                      <span className="font-mono text-xs text-gray-300">{String(val).slice(0, 40)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="card">
                <h3 className="mb-3 font-semibold text-gray-300">Swap mUSD for Collateral</h3>
                <input className="input" type="number" placeholder="Amount" value={swapAmount} onChange={(e) => setSwapAmount(e.target.value)} />
                <TxButton
                  onClick={() => handleExercise(
                    templates.LiquidityPool,
                    pools[0].contractId,
                    "Pool_SwapMUSDForCollateral",
                    { musdAmount: swapAmount }
                  )}
                  loading={loading}
                  disabled={!swapAmount}
                  variant="primary"
                  className="mt-3 w-full"
                >
                  Swap
                </TxButton>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
