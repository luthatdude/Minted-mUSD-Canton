import React, { useState, useEffect } from "react";
import { ethers } from "ethers";
import { TxButton } from "@/components/TxButton";
import { StatCard } from "@/components/StatCard";
import { useTx } from "@/hooks/useTx";
import { formatUSD, formatToken, formatBps } from "@/lib/format";
import { CONTRACTS, USDC_DECIMALS, MUSD_DECIMALS } from "@/lib/config";

interface Props {
  contracts: Record<string, ethers.Contract | null>;
  address: string | null;
}

export function MintPage({ contracts, address }: Props) {
  const [tab, setTab] = useState<"mint" | "redeem">("mint");
  const [amount, setAmount] = useState("");
  const [preview, setPreview] = useState<{ output: bigint; fee: bigint } | null>(null);
  const [stats, setStats] = useState({
    mintFee: 0n,
    redeemFee: 0n,
    remaining: 0n,
    available: 0n,
    usdcBal: 0n,
    musdBal: 0n,
    minMint: 0n,
    maxMint: 0n,
    minRedeem: 0n,
    maxRedeem: 0n,
  });
  const tx = useTx();

  const { directMint, usdc, musd } = contracts;

  useEffect(() => {
    async function load() {
      if (!directMint || !address) return;
      const [mintFee, redeemFee, remaining, available, minMint, maxMint, minRedeem, maxRedeem, usdcBal, musdBal] =
        await Promise.all([
          directMint.mintFeeBps(),
          directMint.redeemFeeBps(),
          directMint.remainingMintable(),
          directMint.availableForRedemption(),
          directMint.minMintAmount(),
          directMint.maxMintAmount(),
          directMint.minRedeemAmount(),
          directMint.maxRedeemAmount(),
          usdc?.balanceOf(address) ?? 0n,
          musd?.balanceOf(address) ?? 0n,
        ]);
      setStats({ mintFee, redeemFee, remaining, available, usdcBal, musdBal, minMint, maxMint, minRedeem, maxRedeem });
    }
    load();
  }, [directMint, usdc, musd, address, tx.success]);

  useEffect(() => {
    async function loadPreview() {
      if (!directMint || !amount || parseFloat(amount) <= 0) {
        setPreview(null);
        return;
      }
      try {
        if (tab === "mint") {
          const parsed = ethers.parseUnits(amount, USDC_DECIMALS);
          const [output, fee] = await directMint.previewMint(parsed);
          setPreview({ output, fee });
        } else {
          const parsed = ethers.parseUnits(amount, MUSD_DECIMALS);
          const [output, fee] = await directMint.previewRedeem(parsed);
          setPreview({ output, fee });
        }
      } catch {
        setPreview(null);
      }
    }
    const timer = setTimeout(loadPreview, 300);
    return () => clearTimeout(timer);
  }, [directMint, amount, tab]);

  async function handleMint() {
    if (!directMint || !usdc) return;
    const parsed = ethers.parseUnits(amount, USDC_DECIMALS);
    // Approve USDC first
    await tx.send(async () => {
      const allowance = await usdc.allowance(address, CONTRACTS.DirectMint);
      if (allowance < parsed) {
        const approveTx = await usdc.approve(CONTRACTS.DirectMint, parsed);
        await approveTx.wait();
      }
      return directMint.mint(parsed);
    });
    setAmount("");
  }

  async function handleRedeem() {
    if (!directMint || !musd) return;
    const parsed = ethers.parseUnits(amount, MUSD_DECIMALS);
    await tx.send(async () => {
      const allowance = await musd.allowance(address, CONTRACTS.DirectMint);
      if (allowance < parsed) {
        const approveTx = await musd.approve(CONTRACTS.DirectMint, parsed);
        await approveTx.wait();
      }
      return directMint.redeem(parsed);
    });
    setAmount("");
  }

  if (!address) {
    return <div className="text-center text-gray-400 py-20">Connect wallet to mint or redeem mUSD</div>;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-3xl font-bold text-white">Mint / Redeem mUSD</h1>
      <p className="text-gray-400">Convert between USDC and mUSD at 1:1 ratio (minus fees)</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard label="Your USDC" value={formatToken(stats.usdcBal, 6)} />
        <StatCard label="Your mUSD" value={formatToken(stats.musdBal)} />
      </div>

      {/* Tabs */}
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
            <label className="label">{tab === "mint" ? "USDC Amount" : "mUSD Amount"}</label>
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
                    ethers.formatUnits(
                      tab === "mint" ? stats.usdcBal : stats.musdBal,
                      tab === "mint" ? USDC_DECIMALS : MUSD_DECIMALS
                    )
                  )
                }
              >
                MAX
              </button>
            </div>
          </div>

          {preview && (
            <div className="rounded-lg bg-gray-800 p-4 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-400">You receive</span>
                <span className="font-medium text-white">
                  {tab === "mint"
                    ? `${formatToken(preview.output)} mUSD`
                    : `${formatToken(preview.output, 6)} USDC`}
                </span>
              </div>
              <div className="mt-2 flex justify-between">
                <span className="text-gray-400">Fee</span>
                <span className="text-yellow-400">
                  {tab === "mint"
                    ? `${formatToken(preview.fee, 6)} USDC`
                    : `${formatToken(preview.fee, 6)} USDC`}
                </span>
              </div>
              <div className="mt-2 flex justify-between">
                <span className="text-gray-400">Fee rate</span>
                <span className="text-gray-300">
                  {formatBps(tab === "mint" ? stats.mintFee : stats.redeemFee)}
                </span>
              </div>
            </div>
          )}

          <TxButton
            onClick={tab === "mint" ? handleMint : handleRedeem}
            loading={tx.loading}
            disabled={!amount || parseFloat(amount) <= 0}
          >
            {tab === "mint" ? "Mint mUSD" : "Redeem USDC"}
          </TxButton>

          {tx.error && <p className="text-sm text-red-400">{tx.error}</p>}
          {tx.success && (
            <p className="text-sm text-green-400">
              Transaction confirmed! {tx.hash && `Hash: ${tx.hash.slice(0, 10)}...`}
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard label="Remaining Mintable" value={formatUSD(stats.remaining)} />
        <StatCard label="Available for Redemption" value={formatUSD(stats.available, 6)} />
      </div>
    </div>
  );
}
