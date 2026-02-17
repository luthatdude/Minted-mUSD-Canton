import React, { useState, useEffect } from "react";
import { ethers } from "ethers";
import { TxButton } from "@/components/TxButton";
import { StatCard } from "@/components/StatCard";
import { PageHeader } from "@/components/PageHeader";
import { useTx } from "@/hooks/useTx";
import { formatUSD, formatToken, formatBps } from "@/lib/format";
import { CONTRACTS, USDC_DECIMALS, MUSD_DECIMALS } from "@/lib/config";
import { useWalletConnect } from "@/hooks/useWalletConnect";
import { useWCContracts } from "@/hooks/useWCContracts";
import WalletConnector from "@/components/WalletConnector";
import ChainSelector from "@/components/ChainSelector";
import { useMultiChainDeposit, DepositQuote } from "@/hooks/useMultiChainDeposit";
import { ChainConfig, requiresBridging, estimateBridgeTime, getUSDCDecimals, USDC_DECIMALS_BY_CHAIN } from "@/lib/chains";

export function MintPage() {
  const { address, isConnected } = useWalletConnect();
  const contracts = useWCContracts();
  const multiChain = useMultiChainDeposit();
  
  const [tab, setTab] = useState<"mint" | "redeem">("mint");
  const [amount, setAmount] = useState("");
  const [preview, setPreview] = useState<{ output: bigint; fee: bigint } | null>(null);
  const [depositQuote, setDepositQuote] = useState<DepositQuote | null>(null);
  const [showCrossChain, setShowCrossChain] = useState(false);
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
        setDepositQuote(null);
        return;
      }
      try {
        if (tab === "mint") {
          const parsed = ethers.parseUnits(amount, USDC_DECIMALS);
          const [output, fee] = await directMint.previewMint(parsed);
          setPreview({ output, fee });
          
          // Also get cross-chain quote if on non-treasury chain
          if (showCrossChain && multiChain.selectedChain) {
            const quote = await multiChain.getDepositQuote(parsed);
            setDepositQuote(quote);
          }
        } else {
          const parsed = ethers.parseUnits(amount, MUSD_DECIMALS);
          const [output, fee] = await directMint.previewRedeem(parsed);
          setPreview({ output, fee });
          setDepositQuote(null);
        }
      } catch {
        setPreview(null);
        setDepositQuote(null);
      }
    }
    const timer = setTimeout(loadPreview, 300);
    return () => clearTimeout(timer);
  }, [directMint, amount, tab, showCrossChain, multiChain]);

  async function handleMint() {
    const parsed = ethers.parseUnits(amount, USDC_DECIMALS);
    
    // Cross-chain deposit
    if (showCrossChain && multiChain.selectedChain && requiresBridging(multiChain.selectedChain)) {
      const txHash = await multiChain.deposit(parsed);
      if (txHash) {
        setAmount("");
      }
      return;
    }
    
    // Direct mint on treasury chain
    if (!directMint || !usdc) return;
    await tx.send(async () => {
      const allowance = await usdc.allowance(address, CONTRACTS.DirectMint);
      if (allowance < parsed) {
        // Reset allowance to 0 first for non-standard tokens (USDT)
        // that revert on non-zero to non-zero approval changes
        if (allowance > 0n) {
          const resetTx = await usdc.approve(CONTRACTS.DirectMint, 0n);
          await resetTx.wait();
        }
        const approveTx = await usdc.approve(CONTRACTS.DirectMint, parsed);
        await approveTx.wait();
      }
      return directMint.mint(parsed);
    });
    setAmount("");
  }

  async function handleCrossChainMint() {
    if (!multiChain.selectedChain || !amount) return;
    const decimals = getUSDCDecimals(multiChain.selectedChain.id);
    const parsed = ethers.parseUnits(amount, decimals);
    const txHash = await multiChain.deposit(parsed);
    if (txHash) {
      setAmount("");
    }
  }

  async function handleRedeem() {
    if (!directMint || !musd) return;
    const parsed = ethers.parseUnits(amount, MUSD_DECIMALS);
    await tx.send(async () => {
      const allowance = await musd.allowance(address, CONTRACTS.DirectMint);
      if (allowance < parsed) {
        // Reset allowance to 0 first for non-standard tokens (USDT)
        // that revert on non-zero to non-zero approval changes
        if (allowance > 0n) {
          const resetTx = await musd.approve(CONTRACTS.DirectMint, 0n);
          await resetTx.wait();
        }
        const approveTx = await musd.approve(CONTRACTS.DirectMint, parsed);
        await approveTx.wait();
      }
      return directMint.redeem(parsed);
    });
    setAmount("");
  }

  if (!isConnected) {
    return <WalletConnector mode="ethereum" />;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <PageHeader
        title="Mint & Redeem"
        subtitle="Convert between USDC and mUSD at 1:1 ratio (minus protocol fees)"
        badge={showCrossChain ? (multiChain.selectedChain?.name || "Select Chain") : "Ethereum"}
        badgeColor="brand"
      />

      {/* Cross-Chain Toggle */}
      <div className="flex items-center justify-between rounded-xl bg-surface-800/50 p-4 border border-white/10">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-purple-500">
            <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
          </div>
          <div>
            <h3 className="font-medium text-white">Multi-Chain Deposits</h3>
            <p className="text-sm text-gray-400">Deposit from Base, Arbitrum, or Solana</p>
          </div>
        </div>
        <button
          onClick={() => setShowCrossChain(!showCrossChain)}
          className={`relative h-6 w-11 rounded-full transition-colors ${
            showCrossChain ? 'bg-brand-500' : 'bg-surface-600'
          }`}
        >
          <span
            className={`absolute top-1 left-1 h-4 w-4 rounded-full bg-white transition-transform ${
              showCrossChain ? 'translate-x-5' : ''
            }`}
          />
        </button>
      </div>

      {/* Chain Selector (when cross-chain is enabled) */}
      {showCrossChain && tab === "mint" && (
        <div className="space-y-3">
          <label className="text-sm font-medium text-gray-400">Deposit Chain</label>
          <ChainSelector showTestnets={false} />
          
          {/* Bridge Info */}
          {multiChain.selectedChain && requiresBridging(multiChain.selectedChain) && (
            <div className="flex items-center gap-2 rounded-lg bg-blue-500/10 px-4 py-3 text-sm">
              <svg className="h-5 w-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-blue-300">
                Deposits from {multiChain.selectedChain.name} are bridged to Ethereum (~{estimateBridgeTime(multiChain.selectedChain)}s)
              </span>
            </div>
          )}
          
          {/* Cross-chain USDC Balance */}
          {multiChain.isConnected && (
            <div className="text-sm text-gray-400">
              Your USDC on {multiChain.selectedChain?.name}: {formatToken(multiChain.usdcBalance, 6)}
            </div>
          )}
        </div>
      )}

      {/* Balance Cards */}
      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard 
          label="Your USDC Balance" 
          value={formatToken(stats.usdcBal, 6)} 
          color="blue"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
        <StatCard 
          label="Your mUSD Balance" 
          value={formatToken(stats.musdBal)}
          color="purple"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
            </svg>
          }
        />
      </div>

      {/* Main Card */}
      <div className="card-gradient-border overflow-hidden">
        {/* Tabs */}
        <div className="flex border-b border-white/10">
          <button
            className={`relative flex-1 px-6 py-4 text-center text-sm font-semibold transition-all duration-300 ${
              tab === "mint" 
                ? "text-white" 
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
              <span className="absolute bottom-0 left-1/2 h-0.5 w-24 -translate-x-1/2 rounded-full bg-gradient-to-r from-brand-500 to-purple-500" />
            )}
          </button>
          <button
            className={`relative flex-1 px-6 py-4 text-center text-sm font-semibold transition-all duration-300 ${
              tab === "redeem" 
                ? "text-white" 
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
              <span className="absolute bottom-0 left-1/2 h-0.5 w-24 -translate-x-1/2 rounded-full bg-gradient-to-r from-brand-500 to-purple-500" />
            )}
          </button>
        </div>

        {/* Form Content */}
        <div className="space-y-6 p-6">
          {/* Input Section */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-gray-400">
                {tab === "mint" ? "You Pay" : "You Redeem"}
              </label>
              <span className="text-xs text-gray-500">
                Balance: {tab === "mint" 
                  ? formatToken(stats.usdcBal, 6) 
                  : formatToken(stats.musdBal)
                }
              </span>
            </div>
            <div className="relative rounded-xl border border-white/10 bg-surface-800/50 p-4 transition-all duration-300 focus-within:border-brand-500/50 focus-within:shadow-[0_0_20px_-5px_rgba(51,139,255,0.3)]">
              <div className="flex items-center gap-4">
                <input
                  type="number"
                  className="flex-1 bg-transparent text-2xl font-semibold text-white placeholder-gray-600 focus:outline-none"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <div className="flex items-center gap-2">
                  <button
                    className="rounded-lg bg-brand-500/20 px-3 py-1.5 text-xs font-semibold text-brand-400 transition-colors hover:bg-brand-500/30"
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
                  <div className="flex items-center gap-2 rounded-full bg-surface-700/50 px-3 py-1.5">
                    <div className={`h-6 w-6 rounded-full ${tab === "mint" ? "bg-blue-500" : "bg-gradient-to-br from-brand-500 to-purple-500"}`} />
                    <span className="font-semibold text-white">{tab === "mint" ? "USDC" : "mUSD"}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Arrow */}
          <div className="flex justify-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-surface-800">
              <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
              </svg>
            </div>
          </div>

          {/* Output Section */}
          <div className="space-y-3">
            <label className="text-sm font-medium text-gray-400">You Receive</label>
            <div className="rounded-xl border border-white/10 bg-surface-800/30 p-4">
              <div className="flex items-center justify-between">
                <span className="text-2xl font-semibold text-white">
                  {preview ? (tab === "mint" 
                    ? formatToken(preview.output) 
                    : formatToken(preview.output, 6)
                  ) : "0.00"}
                </span>
                <div className="flex items-center gap-2 rounded-full bg-surface-700/50 px-3 py-1.5">
                  <div className={`h-6 w-6 rounded-full ${tab === "mint" ? "bg-gradient-to-br from-brand-500 to-purple-500" : "bg-blue-500"}`} />
                  <span className="font-semibold text-white">{tab === "mint" ? "mUSD" : "USDC"}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Fee Details */}
          {preview && (
            <div className="space-y-2 rounded-xl bg-surface-800/30 p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-400">Protocol Fee</span>
                <span className="font-medium text-yellow-400">
                  {formatBps(tab === "mint" ? stats.mintFee : stats.redeemFee)}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-400">Fee Amount</span>
                <span className="text-gray-300">
                  {formatToken(preview.fee, 6)} USDC
                </span>
              </div>
              {showCrossChain && depositQuote && (
                <>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-400">Bridge Fee</span>
                    <span className="text-gray-300">
                      ~{depositQuote.feePercentage.toFixed(2)}%
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-400">Est. Time</span>
                    <span className="text-gray-300">
                      ~{Math.round(depositQuote.bridgeTime / 60)} min
                    </span>
                  </div>
                </>
              )}
              <div className="divider my-2" />
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-400">Exchange Rate</span>
                <span className="text-gray-300">1 USDC = 1 mUSD</span>
              </div>
            </div>
          )}

          {/* Action Button */}
          <TxButton
            onClick={showCrossChain && multiChain.selectedChain && requiresBridging(multiChain.selectedChain) 
              ? handleCrossChainMint 
              : (tab === "mint" ? handleMint : handleRedeem)}
            loading={tx.loading || multiChain.isLoading}
            disabled={!amount || parseFloat(amount) <= 0}
            className="w-full"
          >
            <span className="flex items-center justify-center gap-2">
              {tab === "mint" ? (
                <>
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                  </svg>
                  {showCrossChain && multiChain.selectedChain && requiresBridging(multiChain.selectedChain)
                    ? `Deposit from ${multiChain.selectedChain.name}`
                    : 'Mint mUSD'}
                </>
              ) : (
                <>
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Redeem USDC
                </>
              )}
            </span>
          </TxButton>

          {/* Transaction Status */}
          {(tx.error || multiChain.error) && (
            <div className="alert-error flex items-center gap-3">
              <svg className="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-sm">{tx.error || multiChain.error}</span>
            </div>
          )}
          {tx.success && (
            <div className="alert-success flex items-center gap-3">
              <svg className="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-sm">
                Transaction confirmed! {tx.hash && (
                  <a href={`https://etherscan.io/tx/${tx.hash}`} target="_blank" rel="noopener noreferrer" className="underline">
                    View on Etherscan
                  </a>
                )}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Info Cards */}
      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard 
          label="Remaining Mintable" 
          value={formatUSD(stats.remaining)}
          subValue={`Max: ${formatToken(stats.maxMint, 6)} per tx`}
        />
        <StatCard 
          label="Available for Redemption" 
          value={formatUSD(stats.available, 6)}
          subValue={`Max: ${formatToken(stats.maxRedeem)} per tx`}
        />
      </div>
    </div>
  );
}

export default MintPage;
