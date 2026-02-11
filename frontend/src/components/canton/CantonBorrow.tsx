import React, { useState, useEffect, useCallback } from "react";
import { StatCard } from "@/components/StatCard";
import { useLoopWallet, LoopContract } from "@/hooks/useLoopWallet";
import WalletConnector from "@/components/WalletConnector";

// DAML template IDs
const PACKAGE_ID = process.env.NEXT_PUBLIC_DAML_PACKAGE_ID || "";
const templates = {
  Vault: `${PACKAGE_ID}:MintedProtocolV2Fixed:Vault`,
  Collateral: `${PACKAGE_ID}:MintedProtocolV2Fixed:Collateral`,
  MUSD: `${PACKAGE_ID}:MintedProtocolV2Fixed:MUSD`,
};

// Canton collateral reference data
const CANTON_COLLATERALS = [
  { symbol: "Canton Coin", ltv: "65%", liq: "75%" },
  { symbol: "smUSD", ltv: "90%", liq: "93%" },
];

export function CantonBorrow() {
  const loopWallet = useLoopWallet();

  const [action, setAction] = useState<"deposit" | "borrow" | "repay" | "withdraw" | "loop">("deposit");
  const [amount, setAmount] = useState("");
  const [collateralCid, setCollateralCid] = useState("");
  const [musdCid, setMusdCid] = useState("");
  const [vaultCid, setVaultCid] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Loop state
  const [loopMultiplier, setLoopMultiplier] = useState(2);

  const [vaults, setVaults] = useState<LoopContract[]>([]);
  const [collaterals, setCollaterals] = useState<LoopContract[]>([]);
  const [musdContracts, setMusdContracts] = useState<LoopContract[]>([]);

  const loadContracts = useCallback(async () => {
    if (!loopWallet.isConnected) return;
    try {
      const [v, c, m] = await Promise.all([
        loopWallet.queryContracts(templates.Vault).catch(() => []),
        loopWallet.queryContracts(templates.Collateral).catch(() => []),
        loopWallet.queryContracts(templates.MUSD).catch(() => []),
      ]);
      setVaults(v);
      setCollaterals(c);
      setMusdContracts(m);
      if (v.length > 0) setVaultCid(v[0].contractId);
      if (c.length > 0) setCollateralCid(c[0].contractId);
      if (m.length > 0) setMusdCid(m[0].contractId);
    } catch (err) {
      console.error("Failed to load contracts:", err);
    }
  }, [loopWallet.isConnected, loopWallet.queryContracts]);

  useEffect(() => {
    loadContracts();
  }, [loadContracts]);

  async function handleAction() {
    if (!vaultCid) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const choiceMap: Record<string, { choice: string; args: Record<string, any> }> = {
        deposit: { choice: "Vault_Deposit", args: { collateralCid, amount } },
        borrow: { choice: "Vault_Borrow", args: { amount } },
        repay: { choice: "Vault_Repay", args: { musdCid, amount } },
        withdraw: { choice: "Vault_WithdrawCollateral", args: { amount } },
      };
      const { choice, args } = choiceMap[action];
      await loopWallet.exerciseChoice(templates.Vault, vaultCid, choice, args);
      setResult(`${action.charAt(0).toUpperCase() + action.slice(1)} successful on Canton`);
      setAmount("");
      await loadContracts();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function checkHealth() {
    if (!vaultCid) return;
    try {
      const res = await loopWallet.exerciseChoice(templates.Vault, vaultCid, "Vault_GetHealthFactor", {});
      setResult(`Health Factor: ${JSON.stringify(res)}`);
    } catch (err: any) {
      setError(err.message);
    }
  }

  if (!loopWallet.isConnected) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="max-w-md space-y-6">
          <div className="text-center">
            <h3 className="mb-2 text-xl font-semibold text-white">Connect to Canton</h3>
            <p className="text-gray-400 mb-6">Connect your Loop Wallet to borrow mUSD on Canton.</p>
          </div>
          <WalletConnector mode="canton" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-white">Borrow &amp; Lend</h1>
        <p className="text-amber-400 text-sm font-medium mt-1">Canton Network (Daml Ledger) — mUSD stakers earn the interest</p>
      </div>

      {/* Collateral Reference Table */}
      <div className="card">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-500/20">
            <svg className="h-5 w-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Supported Collateral</h2>
            <p className="text-sm text-gray-400">Canton chain collateral assets</p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-gray-400">
                <th className="pb-3 text-left font-medium">Asset</th>
                <th className="pb-3 text-right font-medium">Max LTV</th>
                <th className="pb-3 text-right font-medium">Liquidation Threshold</th>
              </tr>
            </thead>
            <tbody>
              {CANTON_COLLATERALS.map((c) => (
                <tr key={c.symbol} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
                  <td className="py-3">
                    <div className="flex items-center gap-2">
                      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-amber-500 to-yellow-500 text-xs font-bold text-white">
                        {c.symbol[0]}
                      </div>
                      <span className="font-medium text-white">{c.symbol}</span>
                    </div>
                  </td>
                  <td className="py-3 text-right">
                    <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-400">{c.ltv}</span>
                  </td>
                  <td className="py-3 text-right">
                    <span className="rounded-full bg-yellow-500/10 px-2 py-0.5 text-xs font-medium text-yellow-400">{c.liq}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Vault Summary */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Your Vaults" value={vaults.length.toString()} />
        <StatCard label="Collateral Contracts" value={collaterals.length.toString()} />
        <StatCard label="mUSD Contracts" value={musdContracts.length.toString()} />
      </div>

      {/* Vault List */}
      {vaults.length > 0 && (
        <div className="card">
          <h2 className="mb-4 text-lg font-semibold text-white">Your Vaults (CDPs)</h2>
          <div className="space-y-3">
            {vaults.map((v) => (
              <div
                key={v.contractId}
                className={`cursor-pointer rounded-lg border p-3 text-sm transition ${
                  vaultCid === v.contractId
                    ? "border-amber-500 bg-amber-600/10"
                    : "border-gray-700 bg-gray-800 hover:border-gray-600"
                }`}
                onClick={() => setVaultCid(v.contractId)}
              >
                <div className="flex justify-between">
                  <span className="font-mono text-xs text-gray-400">{v.contractId.slice(0, 24)}...</span>
                  {vaultCid === v.contractId && <span className="text-amber-400 text-xs">Selected</span>}
                </div>
                <div className="mt-1 grid grid-cols-3 gap-4 text-gray-300">
                  <div><span className="text-gray-500">Collateral: </span>{v.payload?.collateralAmount || "0"}</div>
                  <div><span className="text-gray-500">Debt: </span>{v.payload?.debtAmount || "0"}</div>
                  <div><span className="text-gray-500">Symbol: </span>{v.payload?.collateralSymbol || v.payload?.collateralType || "?"}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Action Card */}
      <div className="card-gradient-border overflow-hidden border-amber-500/20">
        {/* Tabs */}
        <div className="flex border-b border-white/10 overflow-x-auto">
          {(["deposit", "borrow", "repay", "withdraw", "loop"] as const).map((a) => (
            <button
              key={a}
              className={`relative flex-1 min-w-[80px] px-4 py-4 text-center text-sm font-semibold transition-all duration-300 ${
                action === a ? "text-white" : "text-gray-400 hover:text-white"
              }`}
              onClick={() => { setAction(a); setAmount(""); setError(null); setResult(null); }}
            >
              <span className="relative z-10 capitalize">{a === "loop" ? "⚡ Loop" : a}</span>
              {action === a && (
                <span className="absolute bottom-0 left-1/2 h-0.5 w-16 -translate-x-1/2 rounded-full bg-gradient-to-r from-amber-500 to-yellow-500" />
              )}
            </button>
          ))}
        </div>

        <div className="space-y-6 p-6">
          {/* Standard Actions */}
          {action !== "loop" && (
            <>
              {action === "deposit" && (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-400">Collateral Contract</label>
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
                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-400">mUSD Contract</label>
                  <select className="input" value={musdCid} onChange={(e) => setMusdCid(e.target.value)}>
                    {musdContracts.map((c) => (
                      <option key={c.contractId} value={c.contractId}>
                        {c.payload?.amount || "?"} mUSD - {c.contractId.slice(0, 16)}...
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Amount Input */}
              <div className="space-y-3">
                <label className="text-sm font-medium text-gray-400">Amount</label>
                <div className="relative rounded-xl border border-white/10 bg-surface-800/50 p-4 transition-all duration-300 focus-within:border-amber-500/50 focus-within:shadow-[0_0_20px_-5px_rgba(245,158,11,0.3)]">
                  <input
                    type="number"
                    className="w-full bg-transparent text-2xl font-semibold text-white placeholder-gray-600 focus:outline-none"
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={handleAction}
                  disabled={loading || !amount || parseFloat(amount) <= 0 || !vaultCid}
                  className="btn-primary flex-1"
                >
                  {loading ? "Processing on Canton..." : `${action.charAt(0).toUpperCase() + action.slice(1)}`}
                </button>
                <button onClick={checkHealth} className="btn-secondary" disabled={!vaultCid}>
                  Check Health
                </button>
              </div>

              {error && <p className="text-sm text-red-400">{error}</p>}
              {result && <p className="text-sm text-green-400">{result}</p>}
            </>
          )}

          {/* ⚡ Loop Tab */}
          {action === "loop" && (
            <div className="space-y-6">
              {/* Leverage Drag Slider 2x–5x */}
              <div className="space-y-3">
                <label className="text-sm font-medium text-gray-400">Leverage Multiplier</label>
                <div className="rounded-xl bg-surface-800/50 p-5 border border-amber-500/10">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-3xl font-bold text-white">{loopMultiplier}x</span>
                    <span className="text-sm text-gray-400">Drag to select</span>
                  </div>
                  <input
                    type="range"
                    min={2}
                    max={5}
                    step={1}
                    value={loopMultiplier}
                    onChange={(e) => setLoopMultiplier(Number(e.target.value))}
                    className="w-full h-2 bg-surface-700 rounded-full appearance-none cursor-pointer accent-amber-500"
                  />
                  <div className="flex justify-between mt-2 text-xs text-gray-500">
                    <span>2x</span>
                    <span>3x</span>
                    <span>4x</span>
                    <span>5x</span>
                  </div>
                </div>
              </div>

              {/* Amount Input */}
              <div className="space-y-3">
                <label className="text-sm font-medium text-gray-400">Collateral Amount</label>
                <div className="relative rounded-xl border border-amber-500/20 bg-surface-800/50 p-4">
                  <input
                    type="number"
                    className="w-full bg-transparent text-2xl font-semibold text-white placeholder-gray-600 focus:outline-none"
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </div>
              </div>

              {/* Preview */}
              {amount && parseFloat(amount) > 0 && (
                <div className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
                  <h4 className="text-sm font-medium text-gray-400 mb-3">Position Preview</h4>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-gray-500">Total Exposure:</span>
                      <span className="text-white ml-2">~{(parseFloat(amount) * loopMultiplier).toFixed(2)}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Leverage:</span>
                      <span className="text-white ml-2">{loopMultiplier}x</span>
                    </div>
                  </div>
                </div>
              )}

              <button
                disabled
                className="w-full rounded-xl bg-amber-500/20 py-4 text-amber-400 font-semibold opacity-60 cursor-not-allowed"
              >
                ⚡ Open {loopMultiplier}x Loop Position (Coming Soon)
              </button>
              <p className="text-xs text-gray-500 text-center">Canton looping will be available after LeverageVault deployment on Canton.</p>
            </div>
          )}
        </div>
      </div>

      {/* How It Works */}
      <div className="card">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-500/20">
            <svg className="h-5 w-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-white">How Borrowing Works</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-5">
          {[
            { n: "1", title: "Choose Collateral", desc: "Canton Coin or smUSD" },
            { n: "2", title: "Deposit", desc: "Lock collateral in your vault" },
            { n: "3", title: "Borrow", desc: "Mint mUSD up to your LTV" },
            { n: "4", title: "Repay", desc: "Return mUSD + interest" },
            { n: "5", title: "Stakers Earn", desc: "Interest flows to mUSD stakers" },
          ].map((step) => (
            <div key={step.n} className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-500/20 text-amber-400 font-bold text-sm mb-3">{step.n}</div>
              <h3 className="font-medium text-white mb-1">{step.title}</h3>
              <p className="text-xs text-gray-400">{step.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Loop Explainer */}
      <div className="card border border-amber-500/20">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-amber-500 to-yellow-500">
            <span className="text-lg">⚡</span>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Multiply your sMUSD yield in one click</h2>
            <p className="text-sm text-gray-400">Automated leverage looping</p>
          </div>
        </div>
        <div className="space-y-4 text-sm text-gray-300 leading-relaxed">
          <p>
            Deposit your collateral → automatically borrow mUSD, stake it to sMUSD, redeposit, and repeat up to your
            target leverage. No DEX swaps, no manual steps.
          </p>
          <p>
            <span className="text-white font-medium">How it works:</span> Your collateral earns leveraged sMUSD staking yield
            (6-14% base × your loop multiplier), while your borrow cost is offset by the yield itself.
            Choose <span className="text-white font-medium">2x–5x</span> and let the vault handle the rest.
          </p>
        </div>
      </div>
    </div>
  );
}

export default CantonBorrow;
