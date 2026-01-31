import React, { useState, useEffect } from "react";
import { ethers } from "ethers";
import { TxButton } from "@/components/TxButton";
import { StatCard } from "@/components/StatCard";
import { useTx } from "@/hooks/useTx";
import { formatToken, formatUSD, formatBps, formatHealthFactor } from "@/lib/format";
import { CONTRACTS, MUSD_DECIMALS } from "@/lib/config";
import { ERC20_ABI } from "@/abis/ERC20";
import { useWalletConnect } from "@/hooks/useWalletConnect";
import { useWCContracts } from "@/hooks/useWCContracts";
import WalletConnector from "@/components/WalletConnector";

interface CollateralInfo {
  token: string;
  symbol: string;
  decimals: number;
  deposited: bigint;
  price: bigint;
  valueUsd: bigint;
  factorBps: bigint;
  liqThreshold: bigint;
  liqPenalty: bigint;
}

type TabType = "deposit" | "borrow" | "repay" | "withdraw";

export function BorrowPage() {
  const { address, signer, isConnected } = useWalletConnect();
  const contracts = useWCContracts();
  const [action, setAction] = useState<TabType>("deposit");
  const [selectedToken, setSelectedToken] = useState("");
  const [amount, setAmount] = useState("");
  const [collaterals, setCollaterals] = useState<CollateralInfo[]>([]);
  const [debt, setDebt] = useState(0n);
  const [healthFactor, setHealthFactor] = useState(0n);
  const [maxBorrowable, setMaxBorrowable] = useState(0n);
  const [interestRate, setInterestRate] = useState(0n);
  const [isLiquidatable, setIsLiquidatable] = useState(false);
  const [musdBalance, setMusdBalance] = useState(0n);
  const tx = useTx();

  const { vault, borrow, oracle, musd, liquidation } = contracts;

  useEffect(() => {
    async function load() {
      if (!vault || !oracle || !borrow || !address || !signer) return;
      try {
        const tokens: string[] = await vault.getSupportedTokens();
        const infos: CollateralInfo[] = [];

        for (const token of tokens) {
          const erc20 = new ethers.Contract(token, ERC20_ABI, signer);
          const [symbol, dec, dep, prc, config] = await Promise.all([
            erc20.symbol(),
            erc20.decimals(),
            vault.getDeposit(address, token),
            oracle.getPrice(token).catch(() => 0n),
            vault.getConfig(token),
          ]);
          const decimals = Number(dec);
          const deposited = BigInt(dep);
          const price = BigInt(prc);
          const valueUsd = deposited > 0n && price > 0n
            ? (deposited * price) / (10n ** BigInt(decimals))
            : 0n;
          infos.push({
            token,
            symbol,
            decimals,
            deposited,
            price,
            valueUsd,
            factorBps: config[0],
            liqThreshold: config[1],
            liqPenalty: config[2],
          });
        }
        setCollaterals(infos);
        if (tokens.length > 0 && !selectedToken) setSelectedToken(tokens[0]);

        const [d, hf, mb, ir, bal] = await Promise.all([
          borrow.totalDebt(address),
          borrow.healthFactor(address).catch(() => ethers.MaxUint256),
          borrow.maxBorrow(address).catch(() => 0n),
          borrow.interestRateBps(),
          musd?.balanceOf(address) ?? 0n,
        ]);
        setDebt(d);
        setHealthFactor(hf);
        setMaxBorrowable(mb);
        setInterestRate(ir);
        setMusdBalance(bal);

        // Check liquidation status
        if (liquidation) {
          const liq = await liquidation.isLiquidatable(address).catch(() => false);
          setIsLiquidatable(liq);
        }
      } catch (err) {
        console.error("Borrow load error:", err);
      }
    }
    load();
  }, [vault, oracle, borrow, musd, liquidation, address, signer, tx.success]);

  async function handleDeposit() {
    if (!vault || !signer || !selectedToken) return;
    const info = collaterals.find((c) => c.token === selectedToken);
    if (!info) return;
    const parsed = ethers.parseUnits(amount, info.decimals);
    await tx.send(async () => {
      const erc20 = new ethers.Contract(selectedToken, ERC20_ABI, signer);
      const allowance = await erc20.allowance(address, CONTRACTS.CollateralVault);
      if (allowance < parsed) {
        const approveTx = await erc20.approve(CONTRACTS.CollateralVault, parsed);
        await approveTx.wait();
      }
      return vault.deposit(selectedToken, parsed);
    });
    setAmount("");
  }

  async function handleBorrow() {
    if (!borrow) return;
    const parsed = ethers.parseUnits(amount, MUSD_DECIMALS);
    await tx.send(() => borrow.borrow(parsed));
    setAmount("");
  }

  async function handleRepay() {
    if (!borrow || !musd || !address) return;
    const parsed = ethers.parseUnits(amount, MUSD_DECIMALS);
    await tx.send(async () => {
      const allowance = await musd.allowance(address, CONTRACTS.BorrowModule);
      if (allowance < parsed) {
        const approveTx = await musd.approve(CONTRACTS.BorrowModule, parsed);
        await approveTx.wait();
      }
      return borrow.repay(parsed);
    });
    setAmount("");
  }

  async function handleRepayMax() {
    if (!borrow || !musd || !address || debt === 0n) return;
    // Repay the minimum of debt or balance
    const repayAmount = musdBalance < debt ? musdBalance : debt;
    if (repayAmount === 0n) return;
    
    await tx.send(async () => {
      const allowance = await musd.allowance(address, CONTRACTS.BorrowModule);
      if (allowance < repayAmount) {
        const approveTx = await musd.approve(CONTRACTS.BorrowModule, repayAmount);
        await approveTx.wait();
      }
      return borrow.repay(repayAmount);
    });
  }

  async function handleWithdraw() {
    if (!borrow || !selectedToken) return;
    const info = collaterals.find((c) => c.token === selectedToken);
    if (!info) return;
    const parsed = ethers.parseUnits(amount, info.decimals);
    await tx.send(() => borrow.withdrawCollateral(selectedToken, parsed));
    setAmount("");
  }

  // Health factor thresholds
  const hfValue = Number(ethers.formatUnits(healthFactor, 18));
  const hfColor = hfValue < 1.0 ? "red" : hfValue < 1.2 ? "red" : hfValue < 1.5 ? "yellow" : "green";
  const isAtRisk = hfValue < 1.5 && debt > 0n;
  const isCritical = hfValue < 1.2 && debt > 0n;

  if (!address) {
    return <div className="text-center text-gray-400 py-20">Connect wallet to borrow mUSD</div>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-white">Borrow & Lend</h1>
      <p className="text-gray-400">Deposit collateral and borrow mUSD with overcollateralization</p>

      {/* Position Health Alert */}
      {isLiquidatable && (
        <div className="rounded-xl border-2 border-red-500 bg-red-900/30 p-6">
          <div className="flex items-start gap-4">
            <div className="rounded-full bg-red-500/20 p-3">
              <svg className="h-6 w-6 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-semibold text-red-300">Position At Risk</h3>
              <p className="mt-1 text-sm text-red-200/80">
                Your position is below the liquidation threshold. Repay debt or add collateral immediately to avoid liquidation.
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <TxButton
                  onClick={handleRepayMax}
                  loading={tx.loading}
                  disabled={musdBalance === 0n}
                  variant="danger"
                  className="!bg-red-600 hover:!bg-red-500"
                >
                  Repay Max ({formatUSD(musdBalance < debt ? musdBalance : debt)})
                </TxButton>
                <button
                  onClick={() => setAction("deposit")}
                  className="rounded-lg border border-red-500/50 px-4 py-2 text-sm text-red-300 hover:bg-red-500/10 transition-colors"
                >
                  Add Collateral
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Warning for at-risk but not yet liquidatable */}
      {!isLiquidatable && isCritical && (
        <div className="rounded-xl border border-yellow-500/50 bg-yellow-900/20 p-4">
          <div className="flex items-center gap-3">
            <svg className="h-5 w-5 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <p className="text-sm text-yellow-200">
              <span className="font-medium">Warning:</span> Your health factor is low. Consider adding collateral or repaying some debt.
            </p>
          </div>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Your Debt" value={formatUSD(debt)} color={debt > 0n ? "red" : "default"} />
        <StatCard 
          label="Health Factor" 
          value={formatHealthFactor(healthFactor)} 
          color={hfColor}
          subValue={debt > 0n ? (hfValue > 10 ? "Safe" : hfValue < 1.2 ? "At Risk" : hfValue < 1.5 ? "Caution" : "Healthy") : undefined}
        />
        <StatCard label="Available to Borrow" value={formatUSD(maxBorrowable)} color="blue" />
        <StatCard label="Interest Rate" value={formatBps(interestRate) + " APR"} />
      </div>

      {/* Your mUSD Balance */}
      {debt > 0n && (
        <div className="card bg-slate-800/40">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-400">Your mUSD Balance</p>
              <p className="text-xl font-semibold text-white">{formatUSD(musdBalance)}</p>
            </div>
            <TxButton
              onClick={handleRepayMax}
              loading={tx.loading}
              disabled={musdBalance === 0n || debt === 0n}
              variant="secondary"
              className="!py-2 !px-4 text-sm"
            >
              Close Position
            </TxButton>
          </div>
        </div>
      )}

      {/* Collateral positions */}
      {collaterals.length > 0 && (
        <div className="card">
          <h2 className="mb-4 text-lg font-semibold text-gray-300">Your Collateral</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700 text-gray-400">
                  <th className="pb-2 text-left">Token</th>
                  <th className="pb-2 text-right">Deposited</th>
                  <th className="pb-2 text-right">USD Value</th>
                  <th className="pb-2 text-right">LTV</th>
                  <th className="pb-2 text-right">Liq. Threshold</th>
                </tr>
              </thead>
              <tbody>
                {collaterals.map((c) => (
                  <tr key={c.token} className="border-b border-gray-800">
                    <td className="py-2 font-medium text-white">{c.symbol}</td>
                    <td className="py-2 text-right">{formatToken(c.deposited, c.decimals)}</td>
                    <td className="py-2 text-right">{formatUSD(c.valueUsd)}</td>
                    <td className="py-2 text-right">{formatBps(c.factorBps)}</td>
                    <td className="py-2 text-right">{formatBps(c.liqThreshold)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Action card */}
      <div className="card">
        <div className="mb-6 flex flex-wrap border-b border-gray-700">
          {(["deposit", "borrow", "repay", "withdraw"] as const).map((a) => (
            <button
              key={a}
              className={`tab capitalize ${action === a ? "tab-active" : ""}`}
              onClick={() => { setAction(a); setAmount(""); }}
            >
              {a}
            </button>
          ))}
        </div>

        <div className="space-y-4">
          {(action === "deposit" || action === "withdraw") && (
            <div>
              <label className="label">Collateral Token</label>
              <select
                className="input"
                value={selectedToken}
                onChange={(e) => setSelectedToken(e.target.value)}
              >
                {collaterals.map((c) => (
                  <option key={c.token} value={c.token}>
                    {c.symbol}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="label">
              {action === "deposit" || action === "withdraw"
                ? "Collateral Amount"
                : action === "borrow"
                ? "mUSD to Borrow"
                : "mUSD to Repay"}
            </label>
            <input
              type="number"
              className="input"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>

          <TxButton
            onClick={
              action === "deposit"
                ? handleDeposit
                : action === "borrow"
                ? handleBorrow
                : action === "repay"
                ? handleRepay
                : handleWithdraw
            }
            loading={tx.loading}
            disabled={!amount || parseFloat(amount) <= 0}
            variant={action === "repay" ? "secondary" : "primary"}
          >
            {action === "deposit"
              ? "Deposit Collateral"
              : action === "borrow"
              ? "Borrow mUSD"
              : action === "repay"
              ? "Repay Debt"
              : "Withdraw Collateral"}
          </TxButton>

          {tx.error && <p className="text-sm text-red-400">{tx.error}</p>}
          {tx.success && <p className="text-sm text-green-400">Transaction confirmed!</p>}
        </div>
      </div>
    </div>
  );
}

export default BorrowPage;
