import React, { useState, useEffect, useCallback } from "react";
import { StatCard } from "@/components/StatCard";
import { useLoopWallet, LoopContract } from "@/hooks/useLoopWallet";
import WalletConnector from "@/components/WalletConnector";

// DAML template IDs
const PACKAGE_ID = process.env.NEXT_PUBLIC_DAML_PACKAGE_ID || "";
const templates = {
  StakingService: `${PACKAGE_ID}:MintedProtocolV2Fixed:StakingService`,
  MUSD: `${PACKAGE_ID}:MintedProtocolV2Fixed:MUSD`,
};

export function CantonStake() {
  const loopWallet = useLoopWallet();
  
  const [tab, setTab] = useState<"stake" | "unstake">("stake");
  const [amount, setAmount] = useState("");
  const [musdContractId, setMusdContractId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [services, setServices] = useState<LoopContract[]>([]);
  const [musdContracts, setMusdContracts] = useState<LoopContract[]>([]);
  const [stakingInfo, setStakingInfo] = useState<any>(null);

  const loadContracts = useCallback(async () => {
    if (!loopWallet.isConnected) return;
    try {
      const [svc, musd] = await Promise.all([
        loopWallet.queryContracts(templates.StakingService).catch(() => []),
        loopWallet.queryContracts(templates.MUSD).catch(() => []),
      ]);
      setServices(svc);
      setMusdContracts(musd);
      if (svc.length > 0) {
        setServiceId(svc[0].contractId);
        setStakingInfo(svc[0].payload);
      }
      if (musd.length > 0) setMusdContractId(musd[0].contractId);
    } catch (err) {
      console.error("Failed to load contracts:", err);
    }
  }, [loopWallet.isConnected, loopWallet.queryContracts]);

  useEffect(() => {
    loadContracts();
  }, [loadContracts]);

  const totalMusd = musdContracts.reduce(
    (sum, c) => sum + parseFloat(c.payload?.amount || "0"), 0
  );

  async function handleStake() {
    if (!serviceId || !musdContractId) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      await loopWallet.exerciseChoice(
        templates.StakingService,
        serviceId,
        "Stake",
        { musdCid: musdContractId, amount }
      );
      setResult(`Staked ${amount} mUSD for smUSD on Canton`);
      setAmount("");
      await loadContracts();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleUnstake() {
    if (!serviceId) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      await loopWallet.exerciseChoice(
        templates.StakingService,
        serviceId,
        "Unstake",
        { amount }
      );
      setResult(`Unstaked ${amount} smUSD on Canton`);
      setAmount("");
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
            <p className="text-gray-400 mb-6">Connect your Loop Wallet to stake mUSD on Canton.</p>
          </div>
          <WalletConnector mode="canton" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-3xl font-bold text-white">Stake mUSD</h1>
      <p className="text-emerald-400 text-sm font-medium">Canton Network (Daml Ledger)</p>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Your mUSD (Canton)" value={totalMusd.toFixed(2)} />
        <StatCard
          label="Staking Rate"
          value={stakingInfo?.annualRateBps ? `${(Number(stakingInfo.annualRateBps) / 100).toFixed(2)}% APY` : "..."}
          color="green"
        />
        <StatCard
          label="Total Staked"
          value={stakingInfo?.totalStaked ? parseFloat(stakingInfo.totalStaked).toFixed(2) : "0"}
        />
      </div>

      <div className="card">
        <div className="mb-6 flex border-b border-gray-700">
          <button className={`tab ${tab === "stake" ? "tab-active" : ""}`} onClick={() => { setTab("stake"); setAmount(""); }}>
            Stake
          </button>
          <button className={`tab ${tab === "unstake" ? "tab-active" : ""}`} onClick={() => { setTab("unstake"); setAmount(""); }}>
            Unstake
          </button>
        </div>

        <div className="space-y-4">
          {tab === "stake" && (
            <div>
              <label className="label">mUSD Contract</label>
              <select
                className="input"
                value={musdContractId}
                onChange={(e) => setMusdContractId(e.target.value)}
              >
                {musdContracts.map((c) => (
                  <option key={c.contractId} value={c.contractId}>
                    {c.payload?.amount || "?"} mUSD - {c.contractId.slice(0, 16)}...
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="label">{tab === "stake" ? "mUSD Amount" : "smUSD Amount"}</label>
            <input
              type="number"
              className="input"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>

          <div className="rounded-lg bg-gray-800 p-4 text-sm text-gray-400">
            Time-based yield accrual on Canton. Interest calculated per-second based on staking duration.
          </div>

          <button
            onClick={tab === "stake" ? handleStake : handleUnstake}
            disabled={loading || !amount || parseFloat(amount) <= 0}
            className="btn-primary w-full"
          >
            {loading ? "Processing on Canton..." : tab === "stake" ? "Stake mUSD" : "Unstake smUSD"}
          </button>

          {error && <p className="text-sm text-red-400">{error}</p>}
          {result && <p className="text-sm text-green-400">{result}</p>}
        </div>
      </div>
    </div>
  );
}
