import React, { useState, useEffect } from "react";
import { StatCard } from "@/components/StatCard";
import { useCanton } from "@/hooks/useCanton";

interface Props {
  canton: ReturnType<typeof useCanton>;
}

export function CantonMint({ canton }: Props) {
  const [tab, setTab] = useState<"mint" | "redeem">("mint");
  const [amount, setAmount] = useState("");
  const [usdcContractId, setUsdcContractId] = useState("");
  const [musdContractId, setMusdContractId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Stats
  const [services, setServices] = useState<any[]>([]);
  const [usdcContracts, setUsdcContracts] = useState<any[]>([]);
  const [musdContracts, setMusdContracts] = useState<any[]>([]);

  useEffect(() => {
    if (!canton.connected) return;
    async function load() {
      const [svc, usdc, musd] = await Promise.all([
        canton.query("MintedProtocolV2Fixed:DirectMintService"),
        canton.query("MintedProtocolV2Fixed:USDC"),
        canton.query("MintedProtocolV2Fixed:MUSD"),
      ]);
      setServices(svc);
      setUsdcContracts(usdc);
      setMusdContracts(musd);
      if (svc.length > 0) setServiceId(svc[0].contractId);
      if (usdc.length > 0) setUsdcContractId(usdc[0].contractId);
      if (musd.length > 0) setMusdContractId(musd[0].contractId);
    }
    load();
  }, [canton.connected]);

  const totalUsdc = usdcContracts.reduce(
    (sum, c) => sum + parseFloat(c.payload?.amount || "0"), 0
  );
  const totalMusd = musdContracts.reduce(
    (sum, c) => sum + parseFloat(c.payload?.amount || "0"), 0
  );

  async function handleMint() {
    if (!serviceId || !usdcContractId) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await canton.exercise(
        "MintedProtocolV2Fixed:DirectMintService",
        serviceId,
        "DirectMint_Mint",
        { usdcCid: usdcContractId, amount }
      );
      setResult(`Minted ${amount} mUSD on Canton`);
      setAmount("");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRedeem() {
    if (!serviceId || !musdContractId) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await canton.exercise(
        "MintedProtocolV2Fixed:DirectMintService",
        serviceId,
        "DirectMint_Redeem",
        { musdCid: musdContractId, amount }
      );
      setResult(`Redeemed ${amount} mUSD for USDC on Canton`);
      setAmount("");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (!canton.connected) {
    return (
      <div className="text-center text-gray-400 py-20">
        Connect to Canton Ledger to mint or redeem mUSD
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-3xl font-bold text-white">Mint / Redeem mUSD</h1>
      <p className="text-emerald-400 text-sm font-medium">Canton Network (Daml Ledger)</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard label="Your USDC (Canton)" value={totalUsdc.toFixed(2)} />
        <StatCard label="Your mUSD (Canton)" value={totalMusd.toFixed(2)} />
      </div>

      <div className="card">
        <div className="mb-6 flex border-b border-gray-700">
          <button
            className={`tab ${tab === "mint" ? "tab-active" : ""}`}
            onClick={() => { setTab("mint"); setAmount(""); }}
          >
            Mint mUSD
          </button>
          <button
            className={`tab ${tab === "redeem" ? "tab-active" : ""}`}
            onClick={() => { setTab("redeem"); setAmount(""); }}
          >
            Redeem USDC
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="label">
              {tab === "mint" ? "USDC Contract" : "mUSD Contract"}
            </label>
            <select
              className="input"
              value={tab === "mint" ? usdcContractId : musdContractId}
              onChange={(e) =>
                tab === "mint"
                  ? setUsdcContractId(e.target.value)
                  : setMusdContractId(e.target.value)
              }
            >
              {(tab === "mint" ? usdcContracts : musdContracts).map((c) => (
                <option key={c.contractId} value={c.contractId}>
                  {c.payload?.amount || "?"} - {c.contractId.slice(0, 16)}...
                </option>
              ))}
            </select>
          </div>

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

          <div className="rounded-lg bg-gray-800 p-4 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-400">Mint Service</span>
              <span className="font-mono text-xs text-gray-300">
                {serviceId ? `${serviceId.slice(0, 20)}...` : "No service found"}
              </span>
            </div>
            <div className="mt-2 flex justify-between">
              <span className="text-gray-400">Pattern</span>
              <span className="text-gray-300">1:1 USDC to mUSD (via Daml ledger)</span>
            </div>
          </div>

          <button
            onClick={tab === "mint" ? handleMint : handleRedeem}
            disabled={loading || !amount || parseFloat(amount) <= 0}
            className="btn-primary w-full flex items-center justify-center gap-2"
          >
            {loading ? "Processing on Canton..." : tab === "mint" ? "Mint mUSD" : "Redeem USDC"}
          </button>

          {error && <p className="text-sm text-red-400">{error}</p>}
          {result && <p className="text-sm text-green-400">{result}</p>}
        </div>
      </div>
    </div>
  );
}
