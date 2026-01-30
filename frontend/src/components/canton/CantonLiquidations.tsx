import React, { useState, useEffect, useCallback } from "react";
import { StatCard } from "@/components/StatCard";
import { useLoopWallet, LoopContract } from "@/hooks/useLoopWallet";
import WalletConnector from "@/components/WalletConnector";

// DAML template IDs
const PACKAGE_ID = process.env.NEXT_PUBLIC_DAML_PACKAGE_ID || "";
const templates = {
  Vault: `${PACKAGE_ID}:MintedProtocolV2Fixed:Vault`,
  LiquidationEngine: `${PACKAGE_ID}:MintedProtocolV2Fixed:LiquidationEngine`,
};

export function CantonLiquidations() {
  const loopWallet = useLoopWallet();
  
  const [vaults, setVaults] = useState<LoopContract[]>([]);
  const [engines, setEngines] = useState<LoopContract[]>([]);
  const [selectedVault, setSelectedVault] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadContracts = useCallback(async () => {
    if (!loopWallet.isConnected) return;
    try {
      const [v, e] = await Promise.all([
        loopWallet.queryContracts(templates.Vault).catch(() => []),
        loopWallet.queryContracts(templates.LiquidationEngine).catch(() => []),
      ]);
      setVaults(v);
      setEngines(e);
    } catch (err) {
      console.error("Failed to load contracts:", err);
    }
  }, [loopWallet.isConnected, loopWallet.queryContracts]);

  useEffect(() => {
    loadContracts();
  }, [loadContracts]);

  async function handleLiquidate() {
    if (!engines.length || !selectedVault) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      await loopWallet.exerciseChoice(
        templates.LiquidationEngine,
        engines[0].contractId,
        "Liquidate",
        { vaultCid: selectedVault }
      );
      setResult("Liquidation executed on Canton");
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
            <p className="text-gray-400 mb-6">Connect your Loop Wallet to view and execute liquidations.</p>
          </div>
          <WalletConnector mode="canton" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-3xl font-bold text-white">Liquidations</h1>
      <p className="text-emerald-400 text-sm font-medium">Canton Network (Daml Ledger)</p>

      <StatCard label="Vaults to Check" value={vaults.length.toString()} />

      <div className="card space-y-4">
        <h2 className="text-lg font-semibold text-gray-300">All Vaults</h2>

        {vaults.length === 0 ? (
          <p className="text-gray-500">No vaults found</p>
        ) : (
          <div className="space-y-3">
            {vaults.map((v) => {
              const collateral = parseFloat(v.payload?.collateralAmount || "0");
              const debt = parseFloat(v.payload?.debtAmount || "0");
              const ratio = debt > 0 ? ((collateral / debt) * 100).toFixed(1) : "N/A";

              return (
                <div
                  key={v.contractId}
                  className={`cursor-pointer rounded-lg border p-4 transition ${
                    selectedVault === v.contractId
                      ? "border-red-500 bg-red-900/10"
                      : "border-gray-700 bg-gray-800 hover:border-gray-600"
                  }`}
                  onClick={() => setSelectedVault(v.contractId)}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs text-gray-400">{v.contractId.slice(0, 24)}...</span>
                    <span className="text-xs text-gray-500">
                      Owner: {(v.payload?.owner || "").slice(0, 16)}...
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-4 text-sm">
                    <div>
                      <span className="text-gray-500">Collateral: </span>
                      <span className="text-gray-300">{collateral.toFixed(2)}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Debt: </span>
                      <span className="text-gray-300">{debt.toFixed(2)}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Ratio: </span>
                      <span className={`font-medium ${parseFloat(ratio) < 110 ? "text-red-400" : "text-green-400"}`}>
                        {ratio}%
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <button
          onClick={handleLiquidate}
          disabled={loading || !selectedVault || !engines.length}
          className="btn-danger w-full"
        >
          {loading ? "Liquidating on Canton..." : "Execute Liquidation"}
        </button>

        {error && <p className="text-sm text-red-400">{error}</p>}
        {result && <p className="text-sm text-green-400">{result}</p>}
      </div>
    </div>
  );
}
