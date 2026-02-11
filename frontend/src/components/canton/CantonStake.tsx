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

      {/* Canton Coin Staking Widget — Canton Only */}
      <div className="card border border-emerald-500/20">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500 to-teal-500">
            <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Stake Canton Coin</h2>
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400">Canton Only — Boost Pool</span>
          </div>
        </div>
        <div className="rounded-xl bg-emerald-900/20 border border-emerald-500/10 p-4 mb-4">
          <p className="text-sm text-emerald-300/90 leading-relaxed">
            Stake 20% of your mUSD stake in Canton Coin to receive <span className="font-semibold text-emerald-200">boosted yield of 2-4%</span> PLUS{" "}
            <span className="font-semibold text-emerald-200">60% of all validator rewards</span> mUSD generates. You&apos;ll also earn exclusive Minted Points
            which earn you an airdrop for the $MINT TGE.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3 mb-4">
          <StatCard label="Boost Pool APY" value="2-4%" color="green" />
          <StatCard label="Validator Rewards" value="60% share" color="green" />
          <StatCard label="Points Multiplier" value="10× (Season 1)" color="green" />
        </div>
        <div className="space-y-4">
          <div>
            <label className="label">Canton Coin Amount</label>
            <input
              type="number"
              className="input"
              placeholder="0.00"
              disabled
            />
          </div>
          <button
            disabled
            className="btn-primary w-full opacity-60 cursor-not-allowed"
          >
            Stake Canton Coin (Coming Soon)
          </button>
          <p className="text-xs text-gray-500 text-center">Canton Coin staking activates when the Boost Pool launches.</p>
        </div>
      </div>
    </div>
  );
}
