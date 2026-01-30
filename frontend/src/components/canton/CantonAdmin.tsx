import React, { useState, useEffect, useCallback } from "react";
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
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-white">Admin Panel</h1>
      <p className="text-emerald-400 text-sm font-medium">Canton Network (Daml Ledger)</p>

      <div className="flex flex-wrap gap-2 border-b border-gray-700 pb-4">
        {sections.map((s) => (
          <button
            key={s.key}
            onClick={() => { setSection(s.key); setError(null); setResult(null); }}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
              section === s.key ? "bg-emerald-600 text-white" : "bg-gray-800 text-gray-400 hover:text-white"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {error && <div className="rounded-lg border border-red-800 bg-red-900/20 p-4 text-sm text-red-400">{error}</div>}
      {result && <div className="rounded-lg border border-green-800 bg-green-900/20 p-4 text-sm text-green-400">{result}</div>}

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
                <button
                  onClick={() => handleExercise(
                    templates.IssuerRole,
                    issuerRoles[0].contractId,
                    "DirectMint",
                    { owner: mintOwner, amount: mintAmount }
                  )}
                  disabled={loading || !mintOwner || !mintAmount}
                  className="btn-primary mt-3 w-full"
                >
                  {loading ? "Minting..." : "Direct Mint"}
                </button>
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
                <button
                  onClick={() => handleExercise(
                    templates.PriceOracle,
                    oracleContracts[0].contractId,
                    "GetPrice",
                    { symbol: priceSymbol }
                  )}
                  disabled={loading}
                  className="btn-secondary mt-3 w-full"
                >
                  Query Price
                </button>
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
                <button
                  onClick={() => handleExercise(
                    templates.PriceOracle,
                    oracleContracts[0].contractId,
                    "UpdatePrices",
                    { updates: [{ symbol: priceSymbol, price: priceValue }] }
                  )}
                  disabled={loading || !priceValue}
                  className="btn-primary mt-3 w-full"
                >
                  Update Prices
                </button>
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
                <pre className="max-h-40 overflow-auto rounded bg-gray-800 p-3 text-xs text-gray-300">
                  {JSON.stringify(mintServices[0].payload, null, 2)}
                </pre>
              </div>
              <div className="card">
                <h3 className="mb-3 font-semibold text-gray-300">Update Supply Cap</h3>
                <input className="input" type="number" placeholder="10000000" value={newCap} onChange={(e) => setNewCap(e.target.value)} />
                <button
                  onClick={() => handleExercise(
                    templates.DirectMintService,
                    mintServices[0].contractId,
                    "DirectMint_UpdateSupplyCap",
                    { newSupplyCap: newCap }
                  )}
                  disabled={loading || !newCap}
                  className="btn-primary mt-3 w-full"
                >
                  Update Cap
                </button>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <button
                  onClick={() => handleExercise(
                    templates.DirectMintService,
                    mintServices[0].contractId,
                    "DirectMint_SetPaused",
                    { paused: true }
                  )}
                  disabled={loading}
                  className="btn-danger"
                >
                  Pause Service
                </button>
                <button
                  onClick={() => handleExercise(
                    templates.DirectMintService,
                    mintServices[0].contractId,
                    "DirectMint_SetPaused",
                    { paused: false }
                  )}
                  disabled={loading}
                  className="btn-secondary"
                >
                  Unpause Service
                </button>
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
                <pre className="max-h-40 overflow-auto rounded bg-gray-800 p-3 text-xs text-gray-300">
                  {JSON.stringify(pools[0].payload, null, 2)}
                </pre>
              </div>
              <div className="card">
                <h3 className="mb-3 font-semibold text-gray-300">Swap mUSD for Collateral</h3>
                <input className="input" type="number" placeholder="Amount" value={swapAmount} onChange={(e) => setSwapAmount(e.target.value)} />
                <button
                  onClick={() => handleExercise(
                    templates.LiquidityPool,
                    pools[0].contractId,
                    "Pool_SwapMUSDForCollateral",
                    { musdAmount: swapAmount }
                  )}
                  disabled={loading || !swapAmount}
                  className="btn-primary mt-3 w-full"
                >
                  Swap
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
