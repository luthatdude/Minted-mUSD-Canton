import React, { useState, useEffect, useCallback } from "react";
import { TxButton } from "@/components/TxButton";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { useLoopWallet, LoopContract } from "@/hooks/useLoopWallet";
import WalletConnector from "@/components/WalletConnector";

// DAML template IDs
const PACKAGE_ID = process.env.NEXT_PUBLIC_DAML_PACKAGE_ID || "";
const templates = {
  BridgeService: `${PACKAGE_ID}:Minted.Protocol.V3:BridgeService`,
  AttestationRequest: `${PACKAGE_ID}:Minted.Protocol.V3:AttestationRequest`,
  BridgeOutRequest: `${PACKAGE_ID}:Minted.Protocol.V3:BridgeOutRequest`,
  BridgeInRequest: `${PACKAGE_ID}:Minted.Protocol.V3:BridgeInRequest`,
  MUSD: `${PACKAGE_ID}:Minted.Protocol.V3:MintedMUSD`,
  CantonMUSD: `${PACKAGE_ID}:CantonDirectMint:CantonMUSD`,
};

export function CantonBridge() {
  const loopWallet = useLoopWallet();
  
  const [tab, setTab] = useState<"lock" | "attest" | "claim" | "usdc">("lock");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState("50"); // H-09: Default 0.5% slippage tolerance
  const [musdCid, setMusdCid] = useState("");
  const [targetChain, setTargetChain] = useState("1"); // Ethereum mainnet
  const [targetAddress, setTargetAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [bridgeServices, setBridgeServices] = useState<LoopContract[]>([]);
  const [attestations, setAttestations] = useState<LoopContract[]>([]);
  const [claims, setClaims] = useState<LoopContract[]>([]);
  const [musdContracts, setMusdContracts] = useState<LoopContract[]>([]);

  const loadContracts = useCallback(async () => {
    if (!loopWallet.isConnected) return;
    try {
      const [svc, att, cl, musd] = await Promise.all([
        loopWallet.queryContracts(templates.BridgeService).catch(() => []),
        loopWallet.queryContracts(templates.AttestationRequest).catch(() => []),
        loopWallet.queryContracts(templates.BridgeOutRequest).catch(() => []),
        loopWallet.queryContracts(templates.MUSD).catch(() => []),
      ]);
      setBridgeServices(svc);
      setAttestations(att);
      setClaims(cl);
      setMusdContracts(musd);
      if (musd.length > 0) setMusdCid(musd[0].contractId);
    } catch (err) {
      console.error("Failed to load contracts:", err);
    }
  }, [loopWallet.isConnected, loopWallet.queryContracts]);

  useEffect(() => {
    loadContracts();
  }, [loadContracts]);

  async function handleLock() {
    if (!bridgeServices.length || !musdCid) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      await loopWallet.exerciseChoice(
        templates.BridgeService,
        bridgeServices[0].contractId,
        "Lock_Musd_For_Bridge",
        {
          musdCid,
          amount,
          targetChainId: targetChain,
          targetAddress,
          slippageToleranceBps: parseInt(slippageBps) || 50, // H-09: Pass slippage tolerance
        }
      );
      setResult(`Locked ${amount} mUSD for bridge to chain ${targetChain}`);
      setAmount("");
      await loadContracts();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleFinalizeClaim(claimCid: string) {
    setLoading(true);
    setError(null);
    try {
      await loopWallet.exerciseChoice(
        templates.BridgeOutRequest,
        claimCid,
        "Finalize_Bridge_Mint",
        {}
      );
      setResult("Bridge claim finalized - mUSD minted on Canton");
      await loadContracts();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // USDC Bridge via Loop Wallet extension
  async function handleUsdcBridge() {
    if (!loopWallet.provider) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      // Access Loop Wallet's USDC bridge extension
      const { loop } = await import('@fivenorth/loop-sdk');
      await loop.wallet.extension.usdcBridge.withdrawalUSDCxToEthereum({
        amount,
        message: `Bridge ${amount} USDC to Ethereum`,
      });
      setResult(`Initiated USDC bridge to Ethereum for ${amount} USDC`);
      setAmount("");
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
            <p className="text-gray-400 mb-6">Connect your Loop Wallet for bridge operations.</p>
          </div>
          <WalletConnector mode="canton" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <PageHeader
        title="Canton Bridge"
        subtitle="Bridge mUSD between Canton Network and Ethereum with multi-sig attestation security"
        badge="Canton"
        badgeColor="purple"
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Bridge Services" value={bridgeServices.length.toString()} />
        <StatCard label="Pending Attestations" value={attestations.length.toString()} color="yellow" />
        <StatCard label="Claimable" value={claims.length.toString()} color="green" />
      </div>

      <div className="card-gradient-border overflow-hidden">
        <div className="flex border-b border-white/10">
          {[
            { key: "lock" as const, label: "Lock for Bridge", icon: "M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" },
            { key: "usdc" as const, label: "USDC Bridge", icon: "M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" },
            { key: "attest" as const, label: "Attestations", icon: "M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" },
            { key: "claim" as const, label: "Claim", icon: "M5 13l4 4L19 7" },
          ].map(({ key, label, icon }) => (
            <button
              key={key}
              className={`relative flex-1 px-6 py-4 text-center text-sm font-semibold transition-all ${tab === key ? "text-white" : "text-gray-400 hover:text-white"}`}
              onClick={() => setTab(key)}
            >
              <span className="flex items-center justify-center gap-2">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={icon} />
                </svg>
                {label}
              </span>
              {tab === key && <span className="absolute bottom-0 left-1/2 h-0.5 w-20 -translate-x-1/2 rounded-full bg-gradient-to-r from-purple-500 to-pink-500" />}
            </button>
          ))}
        </div>
        <div className="p-6">

        {/* USDC Bridge Tab - Loop Wallet Extension */}
        {tab === "usdc" && (
          <div className="space-y-4">
            <div className="rounded-lg bg-purple-900/20 border border-purple-500/30 p-4">
              <div className="flex items-center gap-3 mb-2">
                <svg className="h-5 w-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                <span className="font-semibold text-purple-300">Loop Wallet USDC Bridge</span>
              </div>
              <p className="text-sm text-gray-400">
                Bridge USDC directly to Ethereum using Loop Wallet's native bridge extension.
                Fast and secure cross-chain transfers.
              </p>
            </div>
            <div>
              <label className="label">USDC Amount</label>
              <input 
                type="number" 
                className="input" 
                placeholder="0.00" 
                value={amount} 
                onChange={(e) => setAmount(e.target.value)} 
              />
            </div>
            <TxButton
              onClick={handleUsdcBridge}
              loading={loading}
              disabled={!amount || parseFloat(amount) <= 0}
              variant="primary"
              className="w-full"
            >
              <span className="flex items-center justify-center gap-2">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
                Bridge USDC to Ethereum
              </span>
            </TxButton>
          </div>
        )}

        {/* Lock Tab */}
        {tab === "lock" && (
          <div className="space-y-4">
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
            <div>
              <label className="label">Amount to Lock</label>
              <input type="number" className="input" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            {/* H-09: Slippage tolerance input */}
            <div>
              <label className="label">Slippage Tolerance (bps)</label>
              <div className="flex gap-2 items-center">
                <input
                  type="number"
                  className="input w-24"
                  min="1"
                  max="500"
                  value={slippageBps}
                  onChange={(e) => setSlippageBps(e.target.value)}
                />
                <span className="text-gray-400 text-sm">
                  ({((parseInt(slippageBps) || 0) / 100).toFixed(2)}%)
                </span>
                <div className="flex gap-1 ml-2">
                  {[10, 50, 100].map((v) => (
                    <button
                      key={v}
                      onClick={() => setSlippageBps(v.toString())}
                      className={`px-2 py-1 text-xs rounded ${
                        slippageBps === v.toString()
                          ? "bg-emerald-600 text-white"
                          : "bg-gray-700 text-gray-300 hover:bg-gray-600"
                      }`}
                    >
                      {(v / 100).toFixed(1)}%
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Target Chain ID</label>
                <select className="input" value={targetChain} onChange={(e) => setTargetChain(e.target.value)}>
                  <option value="1">Ethereum Mainnet (1)</option>
                  <option value="137">Polygon (137)</option>
                  <option value="42161">Arbitrum (42161)</option>
                  <option value="10">Optimism (10)</option>
                </select>
              </div>
              <div>
                <label className="label">Target Address</label>
                <input type="text" className="input" placeholder="0x..." value={targetAddress} onChange={(e) => setTargetAddress(e.target.value)} />
              </div>
            </div>
            <TxButton
              onClick={handleLock}
              loading={loading}
              disabled={!amount || parseFloat(amount) <= 0 || !targetAddress}
              variant="primary"
              className="w-full"
            >
              Lock mUSD for Bridge
            </TxButton>
          </div>
        )}

        {/* Attestations Tab */}
        {tab === "attest" && (
          <div className="space-y-3">
            {attestations.length === 0 ? (
              <div className="text-center py-12">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-purple-500/10">
                  <svg className="h-8 w-8 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                </div>
                <p className="text-gray-400 font-medium">No pending attestations</p>
                <p className="text-sm text-gray-500 mt-1">Lock mUSD first to generate bridge attestations</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10">
                      <th className="text-left py-3 px-4 text-gray-400 font-medium">Contract ID</th>
                      <th className="text-left py-3 px-4 text-gray-400 font-medium">Aggregator</th>
                      <th className="text-right py-3 px-4 text-gray-400 font-medium">Validators</th>
                      <th className="text-right py-3 px-4 text-gray-400 font-medium">Signatures</th>
                      <th className="text-right py-3 px-4 text-gray-400 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attestations.map((att) => {
                      const sigs = att.payload?.signatures?.length || 0;
                      const validators = att.payload?.validatorGroup?.length || 0;
                      const progress = validators > 0 ? (sigs / validators) * 100 : 0;
                      return (
                        <tr key={att.contractId} className="border-b border-white/5 hover:bg-surface-800/50">
                          <td className="py-3 px-4 font-mono text-xs text-gray-400">{att.contractId.slice(0, 16)}...</td>
                          <td className="py-3 px-4 font-mono text-xs text-gray-300">{att.payload?.aggregator?.slice(0, 20) || "?"}</td>
                          <td className="text-right py-3 px-4 text-white">{validators}</td>
                          <td className="text-right py-3 px-4">
                            <span className={`font-semibold ${sigs >= validators ? "text-emerald-400" : "text-yellow-400"}`}>{sigs}</span>
                          </td>
                          <td className="text-right py-3 px-4">
                            <div className="flex items-center justify-end gap-2">
                              <div className="h-2 w-16 overflow-hidden rounded-full bg-surface-700">
                                <div className={`h-full rounded-full transition-all ${progress >= 100 ? "bg-emerald-500" : "bg-yellow-500"}`} style={{ width: `${Math.min(progress, 100)}%` }} />
                              </div>
                              <span className={`text-xs font-semibold ${progress >= 100 ? "text-emerald-400" : "text-yellow-400"}`}>
                                {progress >= 100 ? "Ready" : `${progress.toFixed(0)}%`}
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Claim Tab */}
        {tab === "claim" && (
          <div className="space-y-3">
            {claims.length === 0 ? (
              <div className="text-center py-12">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/10">
                  <svg className="h-8 w-8 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <p className="text-gray-400 font-medium">No pending claims</p>
                <p className="text-sm text-gray-500 mt-1">Bridge attestations need to finalize before claims appear</p>
              </div>
            ) : (
              claims.map((cl) => (
                <div key={cl.contractId} className="rounded-xl border border-white/10 bg-surface-800/50 p-5">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-full bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center">
                        <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      </div>
                      <div>
                        <p className="font-semibold text-white">{cl.payload?.amount || "?"} mUSD</p>
                        <p className="font-mono text-xs text-gray-500">{cl.contractId.slice(0, 24)}...</p>
                      </div>
                    </div>
                    <span className="rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-semibold text-emerald-400">Claimable</span>
                  </div>
                  <TxButton
                    onClick={() => handleFinalizeClaim(cl.contractId)}
                    loading={loading}
                    variant="success"
                    size="sm"
                    className="w-full"
                  >
                    Finalize Claim
                  </TxButton>
                </div>
              ))
            )}
          </div>
        )}

        {error && <div className="alert-error mt-4 text-sm">{error}</div>}
        {result && <div className="alert-success mt-4 text-sm">{result}</div>}
        </div>
      </div>

      {/* How Canton Bridge Works */}
      <div className="card">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-purple-500/20">
            <svg className="h-5 w-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-white">How Canton Bridge Works</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-4">
          {[
            { step: "1", title: "Lock mUSD", desc: "Lock mUSD on Canton Network for cross-chain bridging.", color: "purple" },
            { step: "2", title: "Attestation", desc: "Multi-sig validators verify the lock and generate attestations.", color: "blue" },
            { step: "3", title: "Claim", desc: "Finalize the bridge claim once attestation threshold is met.", color: "emerald" },
            { step: "4", title: "Receive", desc: "mUSD is minted on the target chain (Ethereum, Polygon, etc).", color: "yellow" },
          ].map(({ step, title, desc, color }) => (
            <div key={step} className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
              <div className={`flex h-8 w-8 items-center justify-center rounded-full bg-${color}-500/20 text-${color}-400 font-bold text-sm mb-3`}>{step}</div>
              <h3 className="font-medium text-white mb-1">{title}</h3>
              <p className="text-sm text-gray-400">{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
