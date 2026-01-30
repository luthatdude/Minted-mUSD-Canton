import React, { useState, useEffect } from "react";
import { StatCard } from "@/components/StatCard";
import { PageHeader } from "@/components/PageHeader";
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
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="card-emerald max-w-md p-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/10">
            <svg className="h-8 w-8 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
            </svg>
          </div>
          <h3 className="mb-2 text-xl font-semibold text-white">Connect to Canton</h3>
          <p className="text-gray-400">Configure your Canton ledger connection to mint or redeem mUSD on the Canton Network.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <PageHeader
        title="Mint & Redeem"
        subtitle="Convert between USDC and mUSD on the Canton Network"
        badge="Canton"
        badgeColor="emerald"
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard 
          label="Your USDC (Canton)" 
          value={totalUsdc.toFixed(2)} 
          color="blue"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
        <StatCard 
          label="Your mUSD (Canton)" 
          value={totalMusd.toFixed(2)}
          color="green"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
            </svg>
          }
        />
      </div>

      <div className="card-emerald overflow-hidden">
        {/* Tabs */}
        <div className="flex border-b border-emerald-500/20">
          <button
            className={`relative flex-1 px-6 py-4 text-center text-sm font-semibold transition-all duration-300 ${
              tab === "mint" 
                ? "text-emerald-400" 
                : "text-gray-400 hover:text-white"
            }`}
            onClick={() => { setTab("mint"); setAmount(""); }}
          >
            <span className="relative z-10 flex items-center justify-center gap-2">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
              </svg>
              Mint mUSD
            </span>
            {tab === "mint" && (
              <span className="absolute bottom-0 left-1/2 h-0.5 w-24 -translate-x-1/2 rounded-full bg-gradient-to-r from-emerald-500 to-cyan-500" />
            )}
          </button>
          <button
            className={`relative flex-1 px-6 py-4 text-center text-sm font-semibold transition-all duration-300 ${
              tab === "redeem" 
                ? "text-emerald-400" 
                : "text-gray-400 hover:text-white"
            }`}
            onClick={() => { setTab("redeem"); setAmount(""); }}
          >
            <span className="relative z-10 flex items-center justify-center gap-2">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Redeem USDC
            </span>
            {tab === "redeem" && (
              <span className="absolute bottom-0 left-1/2 h-0.5 w-24 -translate-x-1/2 rounded-full bg-gradient-to-r from-emerald-500 to-cyan-500" />
            )}
          </button>
        </div>

        <div className="space-y-6 p-6">
          {/* Contract Selector */}
          <div className="space-y-2">
            <label className="label">
              {tab === "mint" ? "USDC Contract" : "mUSD Contract"}
            </label>
            <div className="relative">
              <select
                className="input appearance-none pr-10"
                value={tab === "mint" ? usdcContractId : musdContractId}
                onChange={(e) =>
                  tab === "mint"
                    ? setUsdcContractId(e.target.value)
                    : setMusdContractId(e.target.value)
                }
              >
                {(tab === "mint" ? usdcContracts : musdContracts).map((c) => (
                  <option key={c.contractId} value={c.contractId}>
                    {c.payload?.amount || "?"} - {c.contractId.slice(0, 20)}...
                  </option>
                ))}
              </select>
              <svg className="pointer-events-none absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </div>

          {/* Amount Input */}
          <div className="space-y-2">
            <label className="label">Amount</label>
            <div className="relative rounded-xl border border-white/10 bg-surface-800/50 p-4 transition-all duration-300 focus-within:border-emerald-500/50 focus-within:shadow-[0_0_20px_-5px_rgba(16,185,129,0.3)]">
              <input
                type="number"
                className="w-full bg-transparent text-2xl font-semibold text-white placeholder-gray-600 focus:outline-none"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </div>

          {/* Info Box */}
          <div className="space-y-2 rounded-xl bg-surface-800/30 p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-400">Mint Service</span>
              <span className="font-mono text-xs text-emerald-400">
                {serviceId ? `${serviceId.slice(0, 24)}...` : "No service found"}
              </span>
            </div>
            <div className="divider my-2" />
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-400">Pattern</span>
              <span className="text-gray-300">1:1 USDC → mUSD (Daml Ledger)</span>
            </div>
          </div>

          {/* Action Button */}
          <button
            onClick={tab === "mint" ? handleMint : handleRedeem}
            disabled={loading || !amount || parseFloat(amount) <= 0}
            className="btn-success w-full flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Processing on Canton...
              </>
            ) : (
              <>
                {tab === "mint" ? (
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                  </svg>
                ) : (
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                )}
                {tab === "mint" ? "Mint mUSD" : "Redeem USDC"}
              </>
            )}
          </button>

          {/* Status Messages */}
          {error && (
            <div className="alert-error flex items-center gap-3">
              <svg className="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-sm">{error}</span>
            </div>
          )}
          {result && (
            <div className="alert-success flex items-center gap-3">
              <svg className="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-sm">{result}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
