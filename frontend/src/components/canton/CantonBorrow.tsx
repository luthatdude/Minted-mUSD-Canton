import React, { useState, useEffect } from "react";
import { StatCard } from "@/components/StatCard";
import { useCanton } from "@/hooks/useCanton";

interface Props {
  canton: ReturnType<typeof useCanton>;
}

export function CantonBorrow({ canton }: Props) {
  const [action, setAction] = useState<"deposit" | "borrow" | "repay" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const [collateralCid, setCollateralCid] = useState("");
  const [musdCid, setMusdCid] = useState("");
  const [vaultCid, setVaultCid] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [vaults, setVaults] = useState<any[]>([]);
  const [collaterals, setCollaterals] = useState<any[]>([]);
  const [musdContracts, setMusdContracts] = useState<any[]>([]);

  useEffect(() => {
    if (!canton.connected) return;
    async function load() {
      const [v, c, m] = await Promise.all([
        canton.query("MintedProtocolV2Fixed:Vault"),
        canton.query("MintedProtocolV2Fixed:Collateral"),
        canton.query("MintedProtocolV2Fixed:MUSD"),
      ]);
      setVaults(v);
      setCollaterals(c);
      setMusdContracts(m);
      if (v.length > 0) setVaultCid(v[0].contractId);
      if (c.length > 0) setCollateralCid(c[0].contractId);
      if (m.length > 0) setMusdCid(m[0].contractId);
    }
    load();
  }, [canton.connected]);

  async function handleAction() {
    if (!vaultCid) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const choiceMap: Record<string, { choice: string; args: Record<string, any> }> = {
        deposit: {
          choice: "Vault_Deposit",
          args: { collateralCid, amount },
        },
        borrow: {
          choice: "Vault_Borrow",
          args: { amount },
        },
        repay: {
          choice: "Vault_Repay",
          args: { musdCid, amount },
        },
        withdraw: {
          choice: "Vault_WithdrawCollateral",
          args: { amount },
        },
      };

      const { choice, args } = choiceMap[action];
      await canton.exercise("MintedProtocolV2Fixed:Vault", vaultCid, choice, args);
      setResult(`${action.charAt(0).toUpperCase() + action.slice(1)} successful on Canton`);
      setAmount("");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Check health factor for selected vault
  async function checkHealth() {
    if (!vaultCid) return;
    try {
      const res = await canton.exercise(
        "MintedProtocolV2Fixed:Vault",
        vaultCid,
        "Vault_GetHealthFactor",
        {}
      );
      setResult(`Health Factor: ${JSON.stringify(res)}`);
    } catch (err: any) {
      setError(err.message);
    }
  }

  if (!canton.connected) {
    return <div className="text-center text-gray-400 py-20">Connect to Canton Ledger to borrow</div>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-white">Borrow mUSD</h1>
      <p className="text-emerald-400 text-sm font-medium">Canton Network (Daml Ledger)</p>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Your Vaults" value={vaults.length.toString()} />
        <StatCard label="Collateral Contracts" value={collaterals.length.toString()} />
        <StatCard label="mUSD Contracts" value={musdContracts.length.toString()} />
      </div>

      {/* Vault list */}
      {vaults.length > 0 && (
        <div className="card">
          <h2 className="mb-4 text-lg font-semibold text-gray-300">Your Vaults (CDPs)</h2>
          <div className="space-y-3">
            {vaults.map((v) => (
              <div
                key={v.contractId}
                className={`cursor-pointer rounded-lg border p-3 text-sm transition ${
                  vaultCid === v.contractId
                    ? "border-brand-500 bg-brand-600/10"
                    : "border-gray-700 bg-gray-800 hover:border-gray-600"
                }`}
                onClick={() => setVaultCid(v.contractId)}
              >
                <div className="flex justify-between">
                  <span className="font-mono text-xs text-gray-400">{v.contractId.slice(0, 24)}...</span>
                  {vaultCid === v.contractId && <span className="text-brand-400 text-xs">Selected</span>}
                </div>
                <div className="mt-1 grid grid-cols-3 gap-4 text-gray-300">
                  <div>
                    <span className="text-gray-500">Collateral: </span>
                    {v.payload?.collateralAmount || "0"}
                  </div>
                  <div>
                    <span className="text-gray-500">Debt: </span>
                    {v.payload?.debtAmount || "0"}
                  </div>
                  <div>
                    <span className="text-gray-500">Symbol: </span>
                    {v.payload?.collateralSymbol || v.payload?.collateralType || "?"}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="card">
        <div className="mb-6 flex flex-wrap border-b border-gray-700">
          {(["deposit", "borrow", "repay", "withdraw"] as const).map((a) => (
            <button
              key={a}
              className={`tab capitalize ${action === a ? "tab-active" : ""}`}
              onClick={() => { setAction(a); setAmount(""); setError(null); setResult(null); }}
            >
              {a}
            </button>
          ))}
        </div>

        <div className="space-y-4">
          {action === "deposit" && (
            <div>
              <label className="label">Collateral Contract</label>
              <select className="input" value={collateralCid} onChange={(e) => setCollateralCid(e.target.value)}>
                {collaterals.map((c) => (
                  <option key={c.contractId} value={c.contractId}>
                    {c.payload?.amount || "?"} {c.payload?.symbol || ""} - {c.contractId.slice(0, 16)}...
                  </option>
                ))}
              </select>
            </div>
          )}

          {action === "repay" && (
            <div>
              <label className="label">mUSD Contract</label>
              <select className="input" value={musdCid} onChange={(e) => setMusdCid(e.target.value)}>
                {musdContracts.map((c) => (
                  <option key={c.contractId} value={c.contractId}>
                    {c.payload?.amount || "?"} mUSD - {c.contractId.slice(0, 16)}...
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="label">Amount</label>
            <input
              type="number"
              className="input"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleAction}
              disabled={loading || !amount || parseFloat(amount) <= 0 || !vaultCid}
              className="btn-primary flex-1"
            >
              {loading
                ? "Processing on Canton..."
                : `${action.charAt(0).toUpperCase() + action.slice(1)}`}
            </button>
            <button onClick={checkHealth} className="btn-secondary" disabled={!vaultCid}>
              Check Health
            </button>
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}
          {result && <p className="text-sm text-green-400">{result}</p>}
        </div>
      </div>
    </div>
  );
}
