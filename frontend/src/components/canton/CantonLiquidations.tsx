import React, { useState, useEffect } from "react";
import { StatCard } from "@/components/StatCard";
import { useCanton } from "@/hooks/useCanton";

interface Props {
  canton: ReturnType<typeof useCanton>;
}

export function CantonLiquidations({ canton }: Props) {
  const [vaults, setVaults] = useState<any[]>([]);
  const [engines, setEngines] = useState<any[]>([]);
  const [selectedVault, setSelectedVault] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canton.connected) return;
    async function load() {
      const [v, e] = await Promise.all([
        canton.query("MintedProtocolV2Fixed:Vault"),
        canton.query("MintedProtocolV2Fixed:LiquidationEngine").catch(() => []),
      ]);
      setVaults(v);
      setEngines(e);
    }
    load();
  }, [canton.connected]);

  async function handleLiquidate() {
    if (!engines.length || !selectedVault) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      await canton.exercise(
        "MintedProtocolV2Fixed:LiquidationEngine",
        engines[0].contractId,
        "Liquidate",
        { vaultCid: selectedVault }
      );
      setResult("Liquidation executed on Canton");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (!canton.connected) {
    return <div className="text-center text-gray-400 py-20">Connect to Canton Ledger for liquidations</div>;
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
