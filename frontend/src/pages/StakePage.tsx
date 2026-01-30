import React, { useState, useEffect } from "react";
import { ethers } from "ethers";
import { TxButton } from "@/components/TxButton";
import { StatCard } from "@/components/StatCard";
import { useTx } from "@/hooks/useTx";
import { formatToken } from "@/lib/format";
import { CONTRACTS, MUSD_DECIMALS } from "@/lib/config";

interface Props {
  contracts: Record<string, ethers.Contract | null>;
  address: string | null;
}

export function StakePage({ contracts, address }: Props) {
  const [tab, setTab] = useState<"stake" | "unstake">("stake");
  const [amount, setAmount] = useState("");
  const [stats, setStats] = useState({
    musdBal: 0n,
    smusdBal: 0n,
    totalAssets: 0n,
    totalSupply: 0n,
    canWithdraw: false,
    cooldownRemaining: 0n,
    previewDeposit: 0n,
    previewRedeem: 0n,
  });
  const tx = useTx();
  const { musd, smusd } = contracts;

  useEffect(() => {
    async function load() {
      if (!smusd || !musd || !address) return;
      const [musdBal, smusdBal, totalAssets, totalSupply, canWithdraw, cooldownRemaining] = await Promise.all([
        musd.balanceOf(address),
        smusd.balanceOf(address),
        smusd.totalAssets(),
        smusd.totalSupply(),
        smusd.canWithdraw(address),
        smusd.getRemainingCooldown(address),
      ]);
      setStats((s) => ({ ...s, musdBal, smusdBal, totalAssets, totalSupply, canWithdraw, cooldownRemaining }));
    }
    load();
  }, [musd, smusd, address, tx.success]);

  useEffect(() => {
    async function loadPreview() {
      if (!smusd || !amount || parseFloat(amount) <= 0) return;
      try {
        const parsed = ethers.parseUnits(amount, MUSD_DECIMALS);
        if (tab === "stake") {
          const shares = await smusd.previewDeposit(parsed);
          setStats((s) => ({ ...s, previewDeposit: shares }));
        } else {
          const assets = await smusd.previewRedeem(parsed);
          setStats((s) => ({ ...s, previewRedeem: assets }));
        }
      } catch {}
    }
    const timer = setTimeout(loadPreview, 300);
    return () => clearTimeout(timer);
  }, [smusd, amount, tab]);

  async function handleStake() {
    if (!smusd || !musd || !address) return;
    const parsed = ethers.parseUnits(amount, MUSD_DECIMALS);
    await tx.send(async () => {
      const allowance = await musd.allowance(address, CONTRACTS.SMUSD);
      if (allowance < parsed) {
        const approveTx = await musd.approve(CONTRACTS.SMUSD, parsed);
        await approveTx.wait();
      }
      return smusd.deposit(parsed, address);
    });
    setAmount("");
  }

  async function handleUnstake() {
    if (!smusd || !address) return;
    const parsed = ethers.parseUnits(amount, MUSD_DECIMALS);
    await tx.send(() => smusd.redeem(parsed, address, address));
    setAmount("");
  }

  const exchangeRate =
    stats.totalSupply > 0n
      ? (Number(stats.totalAssets) / Number(stats.totalSupply)).toFixed(4)
      : "1.0000";

  const cooldownHours = Number(stats.cooldownRemaining) / 3600;

  if (!address) {
    return <div className="text-center text-gray-400 py-20">Connect wallet to stake mUSD</div>;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-3xl font-bold text-white">Stake mUSD</h1>
      <p className="text-gray-400">Stake mUSD to receive smUSD and earn yield. 24-hour withdrawal cooldown.</p>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Your mUSD" value={formatToken(stats.musdBal)} />
        <StatCard label="Your smUSD" value={formatToken(stats.smusdBal)} />
        <StatCard label="Exchange Rate" value={`1 smUSD = ${exchangeRate} mUSD`} color="green" />
        <StatCard
          label="Withdrawal"
          value={stats.canWithdraw ? "Ready" : `${cooldownHours.toFixed(1)}h remaining`}
          color={stats.canWithdraw ? "green" : "yellow"}
        />
      </div>

      <div className="card">
        <div className="mb-6 flex border-b border-gray-700">
          <button
            className={`tab ${tab === "stake" ? "tab-active" : ""}`}
            onClick={() => { setTab("stake"); setAmount(""); }}
          >
            Stake
          </button>
          <button
            className={`tab ${tab === "unstake" ? "tab-active" : ""}`}
            onClick={() => { setTab("unstake"); setAmount(""); }}
          >
            Unstake
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="label">{tab === "stake" ? "mUSD Amount" : "smUSD Amount"}</label>
            <div className="flex gap-2">
              <input
                type="number"
                className="input"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <button
                className="btn-secondary text-sm whitespace-nowrap"
                onClick={() =>
                  setAmount(
                    ethers.formatUnits(tab === "stake" ? stats.musdBal : stats.smusdBal, MUSD_DECIMALS)
                  )
                }
              >
                MAX
              </button>
            </div>
          </div>

          {amount && parseFloat(amount) > 0 && (
            <div className="rounded-lg bg-gray-800 p-4 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-400">You receive</span>
                <span className="font-medium text-white">
                  {tab === "stake"
                    ? `${formatToken(stats.previewDeposit)} smUSD`
                    : `${formatToken(stats.previewRedeem)} mUSD`}
                </span>
              </div>
            </div>
          )}

          <TxButton
            onClick={tab === "stake" ? handleStake : handleUnstake}
            loading={tx.loading}
            disabled={
              !amount ||
              parseFloat(amount) <= 0 ||
              (tab === "unstake" && !stats.canWithdraw)
            }
          >
            {tab === "stake" ? "Stake mUSD" : stats.canWithdraw ? "Unstake" : "Cooldown active"}
          </TxButton>

          {tx.error && <p className="text-sm text-red-400">{tx.error}</p>}
          {tx.success && <p className="text-sm text-green-400">Transaction confirmed!</p>}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard label="Total Staked" value={formatToken(stats.totalAssets) + " mUSD"} />
        <StatCard label="Total smUSD" value={formatToken(stats.totalSupply)} />
      </div>
    </div>
  );
}
