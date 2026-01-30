import React, { useState } from "react";
import { ethers } from "ethers";
import { TxButton } from "@/components/TxButton";
import { StatCard } from "@/components/StatCard";
import { useTx } from "@/hooks/useTx";
import { formatUSD, formatToken, formatBps, formatHealthFactor } from "@/lib/format";
import { CONTRACTS, MUSD_DECIMALS } from "@/lib/config";
import { useWalletConnect } from "@/hooks/useWalletConnect";
import { useWCContracts } from "@/hooks/useWCContracts";
import WalletConnector from "@/components/WalletConnector";

export function LiquidationsPage() {
  const { address, isConnected } = useWalletConnect();
  const contracts = useWCContracts();
  const [borrower, setBorrower] = useState("");
  const [collateralToken, setCollateralToken] = useState("");
  const [debtAmount, setDebtAmount] = useState("");
  const [checkResult, setCheckResult] = useState<{
    liquidatable: boolean;
    healthFactor: bigint;
    seizeEstimate: bigint;
  } | null>(null);
  const tx = useTx();

  const { liquidation, borrow, musd } = contracts;

  async function handleCheck() {
    if (!liquidation || !borrow || !borrower) return;
    try {
      const [liquidatable, hf] = await Promise.all([
        liquidation.isLiquidatable(borrower),
        borrow.healthFactor(borrower).catch(() => ethers.MaxUint256),
      ]);
      let seizeEstimate = 0n;
      if (liquidatable && collateralToken && debtAmount && parseFloat(debtAmount) > 0) {
        const parsed = ethers.parseUnits(debtAmount, MUSD_DECIMALS);
        seizeEstimate = await liquidation.estimateSeize(borrower, collateralToken, parsed);
      }
      setCheckResult({ liquidatable, healthFactor: hf, seizeEstimate });
    } catch (err: any) {
      console.error("Check failed:", err);
    }
  }

  async function handleLiquidate() {
    if (!liquidation || !musd || !address || !borrower || !collateralToken) return;
    const parsed = ethers.parseUnits(debtAmount, MUSD_DECIMALS);
    await tx.send(async () => {
      const allowance = await musd.allowance(address, CONTRACTS.LiquidationEngine);
      if (allowance < parsed) {
        const approveTx = await musd.approve(CONTRACTS.LiquidationEngine, parsed);
        await approveTx.wait();
      }
      return liquidation.liquidate(borrower, collateralToken, parsed);
    });
  }

  if (!isConnected) {
    return <WalletConnector mode="ethereum" />;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-3xl font-bold text-white">Liquidations</h1>
      <p className="text-gray-400">
        Liquidate undercollateralized positions. Repay mUSD debt and receive collateral at a discount.
      </p>

      <div className="card space-y-4">
        <h2 className="text-lg font-semibold text-gray-300">Check Position</h2>

        <div>
          <label className="label">Borrower Address</label>
          <input
            type="text"
            className="input"
            placeholder="0x..."
            value={borrower}
            onChange={(e) => setBorrower(e.target.value)}
          />
        </div>

        <div>
          <label className="label">Collateral Token Address</label>
          <input
            type="text"
            className="input"
            placeholder="0x... (WETH, WBTC, etc.)"
            value={collateralToken}
            onChange={(e) => setCollateralToken(e.target.value)}
          />
        </div>

        <div>
          <label className="label">mUSD Debt to Repay</label>
          <input
            type="number"
            className="input"
            placeholder="0.00"
            value={debtAmount}
            onChange={(e) => setDebtAmount(e.target.value)}
          />
        </div>

        <button onClick={handleCheck} className="btn-secondary w-full">
          Check Liquidation
        </button>

        {checkResult && (
          <div className="mt-4 space-y-3">
            <div className="grid gap-4 sm:grid-cols-2">
              <StatCard
                label="Status"
                value={checkResult.liquidatable ? "LIQUIDATABLE" : "Healthy"}
                color={checkResult.liquidatable ? "red" : "green"}
              />
              <StatCard
                label="Health Factor"
                value={formatHealthFactor(checkResult.healthFactor)}
                color={checkResult.healthFactor < ethers.parseUnits("1", 18) ? "red" : "green"}
              />
            </div>

            {checkResult.liquidatable && checkResult.seizeEstimate > 0n && (
              <div className="rounded-lg bg-gray-800 p-4">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Estimated collateral received</span>
                  <span className="font-medium text-green-400">
                    {formatToken(checkResult.seizeEstimate)} tokens
                  </span>
                </div>
              </div>
            )}

            {checkResult.liquidatable && (
              <TxButton
                onClick={handleLiquidate}
                loading={tx.loading}
                disabled={!debtAmount || parseFloat(debtAmount) <= 0}
                variant="danger"
              >
                Execute Liquidation
              </TxButton>
            )}
          </div>
        )}

        {tx.error && <p className="text-sm text-red-400">{tx.error}</p>}
        {tx.success && <p className="text-sm text-green-400">Liquidation executed!</p>}
      </div>
    </div>
  );
}
