import React, { useState, useEffect } from "react";
import { StatCard } from "@/components/StatCard";
import { useCanton } from "@/hooks/useCanton";

interface Props {
  canton: ReturnType<typeof useCanton>;
}

export function CantonBridge({ canton }: Props) {
  const [tab, setTab] = useState<"lock" | "attest" | "claim">("lock");
  const [amount, setAmount] = useState("");
  const [musdCid, setMusdCid] = useState("");
  const [targetChain, setTargetChain] = useState("1"); // Ethereum mainnet
  const [targetAddress, setTargetAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [bridgeServices, setBridgeServices] = useState<any[]>([]);
  const [attestations, setAttestations] = useState<any[]>([]);
  const [claims, setClaims] = useState<any[]>([]);
  const [musdContracts, setMusdContracts] = useState<any[]>([]);

  useEffect(() => {
    if (!canton.connected) return;
    async function load() {
      const [svc, att, cl, musd] = await Promise.all([
        canton.query("MUSD_Protocol:BridgeService").catch(() => []),
        canton.query("MintedProtocolV2Fixed:AttestationRequest").catch(() => []),
        canton.query("MUSD_Protocol:BridgeClaim").catch(() => []),
        canton.query("MintedProtocolV2Fixed:MUSD"),
      ]);
      setBridgeServices(svc);
      setAttestations(att);
      setClaims(cl);
      setMusdContracts(musd);
      if (musd.length > 0) setMusdCid(musd[0].contractId);
    }
    load();
  }, [canton.connected]);

  async function handleLock() {
    if (!bridgeServices.length || !musdCid) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      await canton.exercise(
        "MUSD_Protocol:BridgeService",
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
      await canton.exercise(
        "MUSD_Protocol:BridgeClaim",
        claimCid,
        "Finalize_Bridge_Mint",
        {}
      );
      setResult("Bridge claim finalized - mUSD minted on Canton");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (!canton.connected) {
    return <div className="text-center text-gray-400 py-20">Connect to Canton Ledger for bridge operations</div>;
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
          <button className={`tab ${tab === "attest" ? "tab-active" : ""}`} onClick={() => setTab("attest")}>
            Attestations
          </button>
          <button className={`tab ${tab === "claim" ? "tab-active" : ""}`} onClick={() => setTab("claim")}>
            Claim
          </button>
        </div>

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
