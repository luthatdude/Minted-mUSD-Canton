import React, { useState, useEffect, useCallback } from "react";
import { StatCard } from "@/components/StatCard";
import { useLoopWallet, LoopContract } from "@/hooks/useLoopWallet";
import WalletConnector from "@/components/WalletConnector";

// DAML template IDs
const PACKAGE_ID = process.env.NEXT_PUBLIC_DAML_PACKAGE_ID || "";
const templates = {
  BridgeService: `${PACKAGE_ID}:MUSD_Protocol:BridgeService`,
  AttestationRequest: `${PACKAGE_ID}:MintedProtocolV2Fixed:AttestationRequest`,
  BridgeClaim: `${PACKAGE_ID}:MUSD_Protocol:BridgeClaim`,
  MUSD: `${PACKAGE_ID}:MintedProtocolV2Fixed:MUSD`,
};

export function CantonBridge() {
  const loopWallet = useLoopWallet();
  
  const [tab, setTab] = useState<"lock" | "attest" | "claim" | "usdc">("lock");
  const [amount, setAmount] = useState("");
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
        loopWallet.queryContracts(templates.BridgeClaim).catch(() => []),
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
        templates.BridgeClaim,
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
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-white">Canton Bridge</h1>
      <p className="text-emerald-400 text-sm font-medium">Canton Network (Daml Ledger)</p>
      <p className="text-gray-400">Lock mUSD on Canton for Ethereum bridging, or claim bridged assets</p>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Bridge Services" value={bridgeServices.length.toString()} />
        <StatCard label="Pending Attestations" value={attestations.length.toString()} color="yellow" />
        <StatCard label="Claimable" value={claims.length.toString()} color="green" />
      </div>

      <div className="card">
        <div className="mb-6 flex border-b border-gray-700">
          <button className={`tab ${tab === "lock" ? "tab-active" : ""}`} onClick={() => setTab("lock")}>
            Lock for Bridge
          </button>
          <button className={`tab ${tab === "usdc" ? "tab-active" : ""}`} onClick={() => setTab("usdc")}>
            USDC Bridge
          </button>
          <button className={`tab ${tab === "attest" ? "tab-active" : ""}`} onClick={() => setTab("attest")}>
            Attestations
          </button>
          <button className={`tab ${tab === "claim" ? "tab-active" : ""}`} onClick={() => setTab("claim")}>
            Claim
          </button>
        </div>

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
            <button
              onClick={handleUsdcBridge}
              disabled={loading || !amount || parseFloat(amount) <= 0}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Bridging...
                </>
              ) : (
                <>
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                  </svg>
                  Bridge USDC to Ethereum
                </>
              )}
            </button>
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
            <button
              onClick={handleLock}
              disabled={loading || !amount || parseFloat(amount) <= 0 || !targetAddress}
              className="btn-primary w-full"
            >
              {loading ? "Locking on Canton..." : "Lock mUSD for Bridge"}
            </button>
          </div>
        )}

        {/* Attestations Tab */}
        {tab === "attest" && (
          <div className="space-y-3">
            {attestations.length === 0 ? (
              <p className="text-gray-500">No pending attestations</p>
            ) : (
              attestations.map((att) => (
                <div key={att.contractId} className="rounded-lg border border-gray-700 bg-gray-800 p-4">
                  <p className="font-mono text-xs text-gray-400">{att.contractId}</p>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <span className="text-gray-500">Aggregator: </span>
                      <span className="text-gray-300">{att.payload?.aggregator?.slice(0, 20) || "?"}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Validators: </span>
                      <span className="text-gray-300">{att.payload?.validatorGroup?.length || 0}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Signatures: </span>
                      <span className="text-gray-300">{att.payload?.signatures?.length || 0}</span>
                    </div>
                  </div>
                  <pre className="mt-2 max-h-24 overflow-auto rounded bg-gray-900 p-2 text-xs text-gray-400">
                    {JSON.stringify(att.payload?.payload, null, 2)}
                  </pre>
                </div>
              ))
            )}
          </div>
        )}

        {/* Claim Tab */}
        {tab === "claim" && (
          <div className="space-y-3">
            {claims.length === 0 ? (
              <p className="text-gray-500">No pending claims</p>
            ) : (
              claims.map((cl) => (
                <div key={cl.contractId} className="rounded-lg border border-gray-700 bg-gray-800 p-4">
                  <p className="font-mono text-xs text-gray-400">{cl.contractId}</p>
                  <div className="mt-2 text-sm text-gray-300">
                    Amount: {cl.payload?.amount || "?"}
                  </div>
                  <button
                    onClick={() => handleFinalizeClaim(cl.contractId)}
                    disabled={loading}
                    className="btn-primary mt-3 text-sm"
                  >
                    {loading ? "Finalizing..." : "Finalize Claim"}
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
        {result && <p className="mt-4 text-sm text-green-400">{result}</p>}
      </div>
    </div>
  );
}
