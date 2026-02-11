import React, { useState, useEffect } from "react";
import { ethers, Contract } from "ethers";
import { TxButton } from "@/components/TxButton";
import { StatCard } from "@/components/StatCard";
import { PageHeader } from "@/components/PageHeader";
import { useTx } from "@/hooks/useTx";
import { formatToken, formatUSD, formatBps, formatHealthFactor } from "@/lib/format";
import { CONTRACTS, MUSD_DECIMALS } from "@/lib/config";
import { ERC20_ABI } from "@/abis/ERC20";
import { useWalletConnect } from "@/hooks/useWalletConnect";
import { useWCContracts } from "@/hooks/useWCContracts";
import WalletConnector from "@/components/WalletConnector";
import { LeverageSlider } from "@/components/LeverageSlider";
import { LeverageVaultABI } from "@/abis/LeverageVault";

// Leverage vault addresses
const LEVERAGE_VAULT_ADDRESS = process.env.NEXT_PUBLIC_LEVERAGE_VAULT_ADDRESS || '';
const WETH_ADDRESS = process.env.NEXT_PUBLIC_WETH_ADDRESS || '';

// Collateral reference data
const COLLATERAL_INFO: Record<string, { ltv: string; liq: string }> = {
  ETH:   { ltv: "75%", liq: "80%" },
  WETH:  { ltv: "75%", liq: "80%" },
  WBTC:  { ltv: "75%", liq: "80%" },
  smUSD: { ltv: "90%", liq: "93%" },
  sMUSD: { ltv: "90%", liq: "93%" },
};

interface LeveragePosition {
  collateralToken: string;
  initialDeposit: bigint;
  totalCollateral: bigint;
  totalDebt: bigint;
  loopsExecuted: bigint;
  targetLeverageX10: bigint;
  openedAt: bigint;
}

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

type TabType = "deposit" | "borrow" | "repay" | "withdraw" | "loop";

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

  // Leverage state
  const [leverageVault, setLeverageVault] = useState<Contract | null>(null);
  const [wethContract, setWethContract] = useState<Contract | null>(null);
  const [leveragePosition, setLeveragePosition] = useState<LeveragePosition | null>(null);
  const [hasLeveragePosition, setHasLeveragePosition] = useState(false);
  const [levDepositAmount, setLevDepositAmount] = useState('');
  const [leverageX10, setLeverageX10] = useState(20);
  const [maxLoops, setMaxLoops] = useState(5);
  const [estimatedLoops, setEstimatedLoops] = useState(0);
  const [estimatedDebt, setEstimatedDebt] = useState(0n);
  const [maxLeverage, setMaxLeverage] = useState(50);
  const [wethBalance, setWethBalance] = useState(0n);
  const [wethAllowance, setWethAllowance] = useState(0n);
  const [leverageLoading, setLeverageLoading] = useState(false);
  const [leverageTxError, setLeverageTxError] = useState<string | null>(null);

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
            factorBps: config[1],
            liqThreshold: config[2],
            liqPenalty: config[3],
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

  // Initialize leverage contracts
  useEffect(() => {
    if (signer && LEVERAGE_VAULT_ADDRESS && WETH_ADDRESS) {
      setLeverageVault(new Contract(LEVERAGE_VAULT_ADDRESS, LeverageVaultABI, signer));
      setWethContract(new Contract(WETH_ADDRESS, ERC20_ABI, signer));
    }
  }, [signer]);

  // Fetch leverage data
  useEffect(() => {
    async function fetchLeverageData() {
      if (!leverageVault || !wethContract || !address) return;
      try {
        const [balance, allowance, pos, maxLev] = await Promise.all([
          wethContract.balanceOf(address),
          wethContract.allowance(address, LEVERAGE_VAULT_ADDRESS),
          leverageVault.getPosition(address),
          leverageVault.maxLeverageX10(),
        ]);
        setWethBalance(balance);
        setWethAllowance(allowance);
        setMaxLeverage(Number(maxLev));
        if (pos.totalCollateral > 0n) {
          setLeveragePosition(pos);
          setHasLeveragePosition(true);
        } else {
          setLeveragePosition(null);
          setHasLeveragePosition(false);
        }
      } catch (err) {
        console.error('Leverage data fetch error:', err);
      }
    }
    fetchLeverageData();
  }, [leverageVault, wethContract, address]);

  // Estimate loops when leverage inputs change
  useEffect(() => {
    async function estimate() {
      if (!leverageVault || !levDepositAmount || parseFloat(levDepositAmount) <= 0) {
        setEstimatedLoops(0);
        setEstimatedDebt(0n);
        return;
      }
      try {
        const amt = ethers.parseEther(levDepositAmount);
        const [loops, d] = await leverageVault.estimateLoops(WETH_ADDRESS, amt, leverageX10);
        setEstimatedLoops(Number(loops));
        setEstimatedDebt(d);
      } catch (err) {
        console.error('Estimate error:', err);
      }
    }
    estimate();
  }, [leverageVault, levDepositAmount, leverageX10]);

  // Leverage handlers
  const handleOpenLeveragePosition = async () => {
    if (!leverageVault || !wethContract || !levDepositAmount) return;
    setLeverageLoading(true);
    setLeverageTxError(null);
    try {
      const parsedAmount = ethers.parseEther(levDepositAmount);
      const currentAllowance = await wethContract.allowance(address, LEVERAGE_VAULT_ADDRESS);
      if (currentAllowance < parsedAmount) {
        const approveTx = await wethContract.approve(LEVERAGE_VAULT_ADDRESS, parsedAmount);
        await approveTx.wait();
        setWethAllowance(parsedAmount);
      }
      const openTx = await leverageVault.openLeveragedPosition(
        WETH_ADDRESS, parsedAmount, leverageX10, maxLoops
      );
      await openTx.wait();
      const pos = await leverageVault.getPosition(address);
      setLeveragePosition(pos);
      setHasLeveragePosition(true);
      setLevDepositAmount('');
    } catch (err: any) {
      console.error('Open position error:', err);
      setLeverageTxError(err?.reason || err?.shortMessage || err?.message || 'Failed to open position');
    }
    setLeverageLoading(false);
  };

  const handleCloseLeveragePosition = async () => {
    if (!leverageVault || !leveragePosition) return;
    setLeverageLoading(true);
    setLeverageTxError(null);
    try {
      const minOut = (leveragePosition.initialDeposit * 95n) / 100n;
      const closeTx = await leverageVault.closeLeveragedPosition(minOut);
      await closeTx.wait();
      setLeveragePosition(null);
      setHasLeveragePosition(false);
    } catch (err: any) {
      console.error('Close position error:', err);
      setLeverageTxError(err?.reason || err?.shortMessage || err?.message || 'Failed to close position');
    }
    setLeverageLoading(false);
  };

  const effectiveLeverage = leveragePosition
    ? (Number(leveragePosition.totalCollateral) / Number(leveragePosition.initialDeposit)).toFixed(2)
    : '0';

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

  // Health factor calculations
  const hfValue = Number(ethers.formatUnits(healthFactor, 18));
  const hfColor = hfValue < 1.2 ? "red" : hfValue < 1.5 ? "yellow" : "green";
  const isCritical = hfValue < 1.2 && debt > 0n;
  const totalCollateralUsd = collaterals.reduce((sum, c) => sum + c.valueUsd, 0n);

  if (!isConnected) {
    return <WalletConnector mode="ethereum" />;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <PageHeader
        title="Borrow & Lend"
        subtitle="Deposit collateral to borrow mUSD — mUSD stakers earn the interest"
        badge={debt > 0n ? "Active Position" : "No Position"}
        badgeColor={debt > 0n ? "warning" : "brand"}
      />

      {/* Liquidation Alert */}
      {isLiquidatable && (
        <div className="rounded-2xl border-2 border-red-500/60 bg-red-900/20 p-6 backdrop-blur-sm">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/20 ring-4 ring-red-500/10">
              <svg className="h-6 w-6 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-semibold text-red-300">⚠ Position At Risk of Liquidation</h3>
              <p className="mt-1 text-sm text-red-200/80">
                Your health factor has dropped below the liquidation threshold. Add collateral or repay debt immediately.
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <TxButton onClick={handleRepayMax} loading={tx.loading} disabled={musdBalance === 0n} variant="danger">
                  Emergency Repay ({formatUSD(musdBalance < debt ? musdBalance : debt)})
                </TxButton>
                <button onClick={() => setAction("deposit")} className="btn-secondary !border-red-500/50 !text-red-300 hover:!bg-red-500/10">
                  Add Collateral
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Critical Warning */}
      {!isLiquidatable && isCritical && (
        <div className="alert-warning flex items-center gap-3">
          <svg className="h-5 w-5 flex-shrink-0 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span className="text-sm">
            <span className="font-semibold">Caution:</span> Health factor is low ({hfValue.toFixed(2)}). Add collateral or repay debt to avoid liquidation.
          </span>
        </div>
      )}

      {/* Collateral Reference Table */}
      <div className="card">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-purple-500/20">
            <svg className="h-5 w-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Supported Collateral</h2>
            <p className="text-sm text-gray-400">Ethereum chain collateral assets</p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-gray-400">
                <th className="pb-3 text-left font-medium">Asset</th>
                <th className="pb-3 text-right font-medium">Max LTV</th>
                <th className="pb-3 text-right font-medium">Liquidation Threshold</th>
                <th className="pb-3 text-right font-medium">Your Deposit</th>
              </tr>
            </thead>
            <tbody>
              {collaterals.length > 0 ? collaterals.map((c) => {
                const ref = COLLATERAL_INFO[c.symbol] || { ltv: formatBps(c.factorBps), liq: formatBps(c.liqThreshold) };
                return (
                  <tr key={c.token} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
                    <td className="py-3">
                      <div className="flex items-center gap-2">
                        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-purple-500 text-xs font-bold text-white">
                          {c.symbol[0]}
                        </div>
                        <span className="font-medium text-white">{c.symbol}</span>
                      </div>
                    </td>
                    <td className="py-3 text-right">
                      <span className="rounded-full bg-brand-500/10 px-2 py-0.5 text-xs font-medium text-brand-400">{ref.ltv}</span>
                    </td>
                    <td className="py-3 text-right">
                      <span className="rounded-full bg-yellow-500/10 px-2 py-0.5 text-xs font-medium text-yellow-400">{ref.liq}</span>
                    </td>
                    <td className="py-3 text-right text-gray-300">
                      {c.deposited > 0n ? formatToken(c.deposited, c.decimals) : "—"}
                    </td>
                  </tr>
                );
              }) : (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-gray-500">
                    <div className="space-y-2">
                      <div className="text-sm">Default collateral parameters:</div>
                      <div className="grid grid-cols-3 gap-2 max-w-md mx-auto text-xs">
                        <div className="rounded-lg bg-surface-800/50 p-2">
                          <span className="text-white font-medium">ETH</span>
                          <div className="text-gray-400 mt-0.5">75% LTV · 80% Liq</div>
                        </div>
                        <div className="rounded-lg bg-surface-800/50 p-2">
                          <span className="text-white font-medium">WBTC</span>
                          <div className="text-gray-400 mt-0.5">75% LTV · 80% Liq</div>
                        </div>
                        <div className="rounded-lg bg-surface-800/50 p-2">
                          <span className="text-white font-medium">smUSD</span>
                          <div className="text-gray-400 mt-0.5">90% LTV · 93% Liq</div>
                        </div>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Health Factor & Stats (only if active position) */}
      {debt > 0n && (
        <div className="card-gradient-border overflow-hidden">
          <div className="grid gap-6 sm:grid-cols-2">
            {/* Health Factor */}
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className={`flex h-10 w-10 items-center justify-center rounded-full ${
                  hfValue < 1.2 ? "bg-red-500/20" : hfValue < 1.5 ? "bg-yellow-500/20" : "bg-emerald-500/20"
                }`}>
                  <svg className={`h-5 w-5 ${
                    hfValue < 1.2 ? "text-red-400" : hfValue < 1.5 ? "text-yellow-400" : "text-emerald-400"
                  }`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm text-gray-400">Health Factor</p>
                  <p className={`text-3xl font-bold ${
                    hfValue < 1.2 ? "text-red-400" : hfValue < 1.5 ? "text-yellow-400" : "text-emerald-400"
                  }`}>{formatHealthFactor(healthFactor)}</p>
                </div>
              </div>
            </div>
            {/* Position Summary */}
            <div className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-400">Collateral Value</span>
                <span className="font-medium text-white">{formatUSD(totalCollateralUsd)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Outstanding Debt</span>
                <span className="font-medium text-red-400">{formatUSD(debt)}</span>
              </div>
              <div className="divider" />
              <div className="flex justify-between">
                <span className="text-gray-400">Available to Borrow</span>
                <span className="font-medium text-emerald-400">{formatUSD(maxBorrowable)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Interest Rate</span>
                <span className="font-medium text-white">{formatBps(interestRate)} APR</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Deposit / Borrow / Repay / Withdraw Action Card */}
      <div className="card-gradient-border overflow-hidden">
        <div className="flex border-b border-white/10 overflow-x-auto">
          {(["deposit", "borrow", "repay", "withdraw", "loop"] as const).map((a) => (
            <button
              key={a}
              className={`relative flex-1 min-w-[80px] px-4 py-4 text-center text-sm font-semibold transition-all duration-300 ${
                action === a ? "text-white" : "text-gray-400 hover:text-white"
              }`}
              onClick={() => { setAction(a); setAmount(""); }}
            >
              <span className="relative z-10 capitalize">{a === "loop" ? "⚡ Loop" : a}</span>
              {action === a && (
                <span className="absolute bottom-0 left-1/2 h-0.5 w-16 -translate-x-1/2 rounded-full bg-gradient-to-r from-brand-500 to-purple-500" />
              )}
            </button>
          ))}
        </div>

        <div className="space-y-6 p-6">
          {/* Standard Actions */}
          {action !== "loop" && (
            <>
              {/* Collateral Dropdown for deposit/withdraw */}
              {(action === "deposit" || action === "withdraw") && (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-400">Collateral Token</label>
                  <div className="relative">
                    <select
                      className="input appearance-none pr-10"
                      value={selectedToken}
                      onChange={(e) => setSelectedToken(e.target.value)}
                    >
                      {collaterals.map((c) => (
                        <option key={c.token} value={c.token}>
                          {c.symbol} {c.deposited > 0n ? `(${formatToken(c.deposited, c.decimals)} deposited)` : ""}
                        </option>
                      ))}
                    </select>
                    <svg className="absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>
              )}

              {/* Amount Input */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-gray-400">
                    {action === "deposit" ? "Deposit Amount" : action === "borrow" ? "Borrow Amount (mUSD)" : action === "repay" ? "Repay Amount (mUSD)" : "Withdraw Amount"}
                  </label>
                  {action === "borrow" && <span className="text-xs text-gray-500">Max: {formatUSD(maxBorrowable)}</span>}
                  {action === "repay" && <span className="text-xs text-gray-500">Debt: {formatUSD(debt)}</span>}
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
                      {action === "borrow" && maxBorrowable > 0n && (
                        <button className="rounded-lg bg-brand-500/20 px-3 py-1.5 text-xs font-semibold text-brand-400 transition-colors hover:bg-brand-500/30"
                          onClick={() => setAmount(ethers.formatUnits(maxBorrowable, MUSD_DECIMALS))}>MAX</button>
                      )}
                      {action === "repay" && debt > 0n && (
                        <button className="rounded-lg bg-brand-500/20 px-3 py-1.5 text-xs font-semibold text-brand-400 transition-colors hover:bg-brand-500/30"
                          onClick={() => setAmount(ethers.formatUnits(musdBalance < debt ? musdBalance : debt, MUSD_DECIMALS))}>MAX</button>
                      )}
                      <div className="flex items-center gap-2 rounded-full bg-surface-700/50 px-3 py-1.5">
                        <div className={`h-6 w-6 rounded-full ${
                          action === "borrow" || action === "repay"
                            ? "bg-gradient-to-br from-brand-500 to-purple-500"
                            : "bg-gradient-to-br from-blue-500 to-cyan-500"
                        }`} />
                        <span className="font-semibold text-white">
                          {action === "borrow" || action === "repay" ? "mUSD" : collaterals.find(c => c.token === selectedToken)?.symbol || "Token"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Action Button */}
              <TxButton
                onClick={action === "deposit" ? handleDeposit : action === "borrow" ? handleBorrow : action === "repay" ? handleRepay : handleWithdraw}
                loading={tx.loading}
                disabled={!amount || parseFloat(amount) <= 0}
                variant={action === "repay" ? "secondary" : "primary"}
                className="w-full"
              >
                <span className="capitalize">{action === "deposit" ? "Deposit Collateral" : action === "borrow" ? "Borrow mUSD" : action === "repay" ? "Repay Debt" : "Withdraw Collateral"}</span>
              </TxButton>

              {tx.error && (
                <div className="alert-error flex items-center gap-3">
                  <svg className="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className="text-sm">{tx.error}</span>
                </div>
              )}
              {tx.success && (
                <div className="alert-success flex items-center gap-3">
                  <svg className="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className="text-sm">
                    Transaction confirmed! {tx.hash && (
                      <a href={`https://etherscan.io/tx/${tx.hash}`} target="_blank" rel="noopener noreferrer" className="underline">View on Etherscan</a>
                    )}
                  </span>
                </div>
              )}
            </>
          )}

          {/* ⚡ Loop Tab */}
          {action === "loop" && (
            <div className="space-y-6">
              {leverageTxError && (
                <div className="rounded-lg border border-red-800 bg-red-900/20 p-4 text-sm text-red-400 flex justify-between items-center">
                  <span>{leverageTxError}</span>
                  <button onClick={() => setLeverageTxError(null)} className="ml-4 text-red-500 hover:text-red-300">&times;</button>
                </div>
              )}

              {!hasLeveragePosition ? (
                <div className="space-y-6">
                  {/* Deposit Amount */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-gray-400">Collateral Deposit</label>
                    <div className="relative rounded-xl border border-white/10 bg-surface-800/50 p-4 transition-all duration-300 focus-within:border-brand-500/50">
                      <div className="flex items-center gap-4">
                        <input
                          type="number"
                          value={levDepositAmount}
                          onChange={(e) => setLevDepositAmount(e.target.value)}
                          placeholder="0.0"
                          className="flex-1 bg-transparent text-2xl font-semibold text-white placeholder-gray-600 focus:outline-none"
                        />
                        <div className="flex items-center gap-2">
                          <button onClick={() => setLevDepositAmount(ethers.formatEther(wethBalance))}
                            className="rounded-lg bg-brand-500/20 px-3 py-1.5 text-xs font-semibold text-brand-400 transition-colors hover:bg-brand-500/30">MAX</button>
                          <div className="flex items-center gap-2 rounded-full bg-surface-700/50 px-3 py-1.5">
                            <div className="h-6 w-6 rounded-full bg-gradient-to-br from-blue-500 to-cyan-500" />
                            <span className="font-semibold text-white">WETH</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Leverage Drag Slider 2x–5x */}
                  <div className="space-y-3">
                    <label className="text-sm font-medium text-gray-400">Leverage Multiplier</label>
                    <div className="rounded-xl bg-surface-800/50 p-5 border border-white/5">
                      <div className="flex items-center justify-between mb-4">
                        <span className="text-3xl font-bold text-white">{(leverageX10 / 10).toFixed(1)}x</span>
                        <span className="text-sm text-gray-400">Drag to select</span>
                      </div>
                      <input
                        type="range"
                        min={20}
                        max={Math.min(50, maxLeverage)}
                        step={10}
                        value={leverageX10}
                        onChange={(e) => setLeverageX10(Number(e.target.value))}
                        className="w-full h-2 bg-surface-700 rounded-full appearance-none cursor-pointer accent-brand-500"
                        disabled={leverageLoading}
                      />
                      <div className="flex justify-between mt-2 text-xs text-gray-500">
                        <span>2x</span>
                        <span>3x</span>
                        <span>4x</span>
                        <span>5x</span>
                      </div>
                    </div>
                  </div>

                  {/* Position Preview */}
                  {levDepositAmount && parseFloat(levDepositAmount) > 0 && (
                    <div className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
                      <h4 className="text-sm font-medium text-gray-400 mb-3">Position Preview</h4>
                      <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                          <span className="text-gray-500">Total Collateral:</span>
                          <span className="text-white ml-2">~{(parseFloat(levDepositAmount) * leverageX10 / 10).toFixed(4)} WETH</span>
                        </div>
                        <div>
                          <span className="text-gray-500">Estimated Debt:</span>
                          <span className="text-white ml-2">~{formatToken(estimatedDebt, 18, 2)} mUSD</span>
                        </div>
                        <div>
                          <span className="text-gray-500">Loop Iterations:</span>
                          <span className="text-white ml-2">{estimatedLoops}</span>
                        </div>
                        <div>
                          <span className="text-gray-500">Effective Leverage:</span>
                          <span className="text-white ml-2">{(leverageX10 / 10).toFixed(1)}x</span>
                        </div>
                      </div>
                    </div>
                  )}

                  <TxButton
                    onClick={handleOpenLeveragePosition}
                    loading={leverageLoading}
                    disabled={!isConnected || !levDepositAmount || parseFloat(levDepositAmount) <= 0}
                    className="w-full"
                  >
                    <span className="flex items-center justify-center gap-2">
                      ⚡ Open {(leverageX10 / 10).toFixed(1)}x Leveraged Position
                    </span>
                  </TxButton>
                </div>
              ) : (
                /* Active Leverage Position */
                <div className="space-y-6">
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    <div className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
                      <p className="text-sm text-gray-400">Initial Deposit</p>
                      <p className="text-xl font-bold text-white">{formatToken(leveragePosition!.initialDeposit, 18, 4)} WETH</p>
                    </div>
                    <div className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
                      <p className="text-sm text-gray-400">Total Collateral</p>
                      <p className="text-xl font-bold text-white">{formatToken(leveragePosition!.totalCollateral, 18, 4)} WETH</p>
                    </div>
                    <div className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
                      <p className="text-sm text-gray-400">Debt Owed</p>
                      <p className="text-xl font-bold text-white">{formatToken(leveragePosition!.totalDebt, 18, 2)} mUSD</p>
                    </div>
                    <div className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
                      <p className="text-sm text-gray-400">Effective Leverage</p>
                      <p className="text-xl font-bold text-brand-400">{effectiveLeverage}x</p>
                    </div>
                    <div className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
                      <p className="text-sm text-gray-400">Loops Executed</p>
                      <p className="text-xl font-bold text-white">{leveragePosition!.loopsExecuted.toString()}</p>
                    </div>
                    <div className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
                      <p className="text-sm text-gray-400">Opened</p>
                      <p className="text-xl font-bold text-white">{new Date(Number(leveragePosition!.openedAt) * 1000).toLocaleDateString()}</p>
                    </div>
                  </div>
                  <TxButton onClick={handleCloseLeveragePosition} loading={leverageLoading} variant="danger" className="w-full">
                    Close Position &amp; Repay Debt
                  </TxButton>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* How It Works */}
      <div className="card">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-500/20">
            <svg className="h-5 w-5 text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-white">How Borrowing Works</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-5">
          {[
            { n: "1", color: "blue", title: "Choose Collateral", desc: "Select from ETH, WBTC, or smUSD" },
            { n: "2", color: "brand", title: "Deposit", desc: "Lock collateral in the vault" },
            { n: "3", color: "emerald", title: "Borrow", desc: "Mint mUSD up to your LTV" },
            { n: "4", color: "purple", title: "Repay", desc: "Return mUSD + accrued interest" },
            { n: "5", color: "green", title: "Stakers Earn", desc: "mUSD stakers earn the interest you pay" },
          ].map((step) => (
            <div key={step.n} className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
              <div className={`flex h-8 w-8 items-center justify-center rounded-full bg-${step.color}-500/20 text-${step.color}-400 font-bold text-sm mb-3`}>{step.n}</div>
              <h3 className="font-medium text-white mb-1">{step.title}</h3>
              <p className="text-xs text-gray-400">{step.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Loop Explainer */}
      <div className="card border border-brand-500/20">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-purple-500">
            <span className="text-lg">⚡</span>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Multiply your sMUSD yield in one click</h2>
            <p className="text-sm text-gray-400">Automated leverage looping</p>
          </div>
        </div>
        <div className="space-y-4 text-sm text-gray-300 leading-relaxed">
          <p>
            Deposit your collateral → automatically borrow mUSD, stake it to sMUSD, redeposit, and repeat up to your
            target leverage. No DEX swaps, no manual steps.
          </p>
          <p>
            <span className="text-white font-medium">How it works:</span> Your collateral earns leveraged sMUSD staking yield
            (6-14% base × your loop multiplier), while your borrow cost is offset by the yield itself.
            Choose <span className="text-white font-medium">2x–5x</span> and let the vault handle the rest.
          </p>
        </div>
      </div>

      {/* Strategies */}
      <div className="card">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-purple-500/20">
            <svg className="h-5 w-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Looping Strategies</h2>
            <p className="text-sm text-gray-400">Multiply your yield with automated leverage loops</p>
          </div>
        </div>
        <div className="grid gap-6 sm:grid-cols-2">
          {/* sMUSD Maxi */}
          <div className="rounded-2xl bg-surface-800/50 p-6 border border-white/5 hover:border-brand-500/30 transition-colors">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-purple-500">
                <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8V7m0 1v8m0 0v1" />
                </svg>
              </div>
              <div>
                <h3 className="font-semibold text-white">sMUSD Maxi</h3>
                <span className="rounded-full bg-brand-500/10 px-2 py-0.5 text-xs font-medium text-brand-400">Low-Medium Risk</span>
              </div>
            </div>
            <p className="text-sm text-gray-400 mb-4">
              Multiply your stablecoin yield. Deposit USDCx → DirectMint mUSD → stake to sMUSD → borrow against it → re-stake — automatically.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-white/10 text-gray-400">
                    <th className="pb-2 text-left font-medium">Loops</th>
                    <th className="pb-2 text-right font-medium">You Earn On</th>
                    <th className="pb-2 text-right font-medium">Total APY</th>
                  </tr>
                </thead>
                <tbody className="text-gray-300">
                  {[
                    { loops: "2×", earn: "$19,000", apy: "12-28%" },
                    { loops: "3×", earn: "$27,100", apy: "18-42%" },
                    { loops: "4×", earn: "$34,390", apy: "24-56%" },
                    { loops: "5×", earn: "$40,951", apy: "30-70%" },
                  ].map((r) => (
                    <tr key={r.loops} className="border-b border-white/5">
                      <td className="py-1.5">{r.loops}</td>
                      <td className="py-1.5 text-right">{r.earn}</td>
                      <td className="py-1.5 text-right font-medium text-emerald-400">{r.apy}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-gray-500 mt-3">Based on $10k deposit. sMUSD staking yield minus borrow cost.</p>
          </div>

          {/* Canton Maxi */}
          <div className="rounded-2xl bg-surface-800/50 p-6 border border-white/5 hover:border-amber-500/30 transition-colors">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-amber-500 to-yellow-500">
                <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
                </svg>
              </div>
              <div>
                <h3 className="font-semibold text-white">Canton Maxi</h3>
                <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-400">Medium Risk</span>
              </div>
            </div>
            <p className="text-sm text-gray-400 mb-4">
              Stack every yield source. Canton-native. Deposit → Mint → Stake → Loop → Deposit CTN into Boost Pool. Earn staking yield, validator rewards &amp; Minted Points.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-white/10 text-gray-400">
                    <th className="pb-2 text-left font-medium">Loops</th>
                    <th className="pb-2 text-right font-medium">You Earn On</th>
                    <th className="pb-2 text-right font-medium">Total APY</th>
                  </tr>
                </thead>
                <tbody className="text-gray-300">
                  {[
                    { loops: "2×", earn: "$19,000", apy: "12-28%" },
                    { loops: "3×", earn: "$27,100", apy: "18-42%" },
                    { loops: "4×", earn: "$34,390", apy: "24-56%" },
                    { loops: "5× + Boost", earn: "$40.9k + $8.2k CTN", apy: "36-82%" },
                  ].map((r) => (
                    <tr key={r.loops} className="border-b border-white/5">
                      <td className="py-1.5">{r.loops}</td>
                      <td className="py-1.5 text-right">{r.earn}</td>
                      <td className="py-1.5 text-right font-medium text-emerald-400">{r.apy}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-gray-500 mt-3">Canton-native. Includes validator rewards &amp; Minted Points.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default BorrowPage;
