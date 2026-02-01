import React, { useState, useMemo } from "react";
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

  // FIX FE-H02: Validate addresses before use
  const isValidBorrower = useMemo(() => {
    return borrower.length > 0 && ethers.isAddress(borrower);
  }, [borrower]);

  const isValidCollateral = useMemo(() => {
    return collateralToken.length > 0 && ethers.isAddress(collateralToken);
  }, [collateralToken]);

  const borrowerError = borrower.length > 0 && !isValidBorrower ? "Invalid address format" : null;
  const collateralError = collateralToken.length > 0 && !isValidCollateral ? "Invalid address format" : null;

  async function handleCheck() {
    // FIX FE-H02: Validate addresses before contract calls
    if (!liquidation || !borrow || !isValidBorrower) {
      return;
    }
    try {
      const [liquidatable, hf] = await Promise.all([
        liquidation.isLiquidatable(borrower),
        borrow.healthFactor(borrower).catch(() => ethers.MaxUint256),
      ]);
      let seizeEstimate = 0n;
      if (liquidatable && isValidCollateral && debtAmount && parseFloat(debtAmount) > 0) {
        const parsed = ethers.parseUnits(debtAmount, MUSD_DECIMALS);
        seizeEstimate = await liquidation.estimateSeize(borrower, collateralToken, parsed);
      }
      setCheckResult({ liquidatable, healthFactor: hf, seizeEstimate });
    } catch (err: any) {
      console.error("Check failed:", err);
    }
  }

  async function handleLiquidate() {
    // FIX FE-H02: Validate all addresses before contract calls
    if (!liquidation || !musd || !address || !isValidBorrower || !isValidCollateral) {
      return;
    }
    const parsed = ethers.parseUnits(debtAmount, MUSD_DECIMALS);
    
    // FIX FE-H01: Use simulation before actual transaction
    await tx.send(
      async () => {
        const allowance = await musd.allowance(address, CONTRACTS.LiquidationEngine);
        if (allowance < parsed) {
          const approveTx = await musd.approve(CONTRACTS.LiquidationEngine, parsed);
          await approveTx.wait();
        }
        return liquidation.liquidate(borrower, collateralToken, parsed);
      },
      // Simulation function to check if liquidation would succeed
      async () => {
        await liquidation.liquidate.staticCall(borrower, collateralToken, parsed);
      }
    );
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
            className={`input ${borrowerError ? 'border-red-500' : ''}`}
            placeholder="0x..."
            value={borrower}
            onChange={(e) => setBorrower(e.target.value)}
          />
          {borrowerError && <p className="text-xs text-red-400 mt-1">{borrowerError}</p>}
        </div>

        <div>
          <label className="label">Collateral Token Address</label>
          <input
            type="text"
            className={`input ${collateralError ? 'border-red-500' : ''}`}
            placeholder="0x... (WETH, WBTC, etc.)"
            value={collateralToken}
            onChange={(e) => setCollateralToken(e.target.value)}
          />
          {collateralError && <p className="text-xs text-red-400 mt-1">{collateralError}</p>}
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

        <button 
          onClick={handleCheck} 
          className="btn-secondary w-full"
          disabled={!isValidBorrower}
        >
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

export default LiquidationsPage;
