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

export function BorrowPage() {
  const { address, signer, isConnected } = useWalletConnect();
  const contracts = useWCContracts();
  const [action, setAction] = useState<"deposit" | "borrow" | "repay" | "withdraw">("deposit");
  const [selectedToken, setSelectedToken] = useState("");
  const [amount, setAmount] = useState("");
  const [collaterals, setCollaterals] = useState<CollateralInfo[]>([]);
  const [debt, setDebt] = useState(0n);
  const [healthFactor, setHealthFactor] = useState(0n);
  const [maxBorrowable, setMaxBorrowable] = useState(0n);
  const [interestRate, setInterestRate] = useState(0n);
  const tx = useTx();

  const { vault, borrow, oracle, musd } = contracts;

  useEffect(() => {
    async function load() {
      if (!vault || !oracle || !borrow || !address || !signer) return;
      try {
        const tokens: string[] = await vault.getSupportedTokens();
        const infos: CollateralInfo[] = [];

        for (const token of tokens) {
          const erc20 = new ethers.Contract(token, ERC20_ABI, signer);
          const [symbol, decimals, deposited, price, config] = await Promise.all([
            erc20.symbol(),
            erc20.decimals(),
            vault.getDeposit(address, token),
            oracle.getPrice(token).catch(() => 0n),
            vault.getConfig(token),
          ]);
          const valueUsd = deposited > 0n && price > 0n
            ? (deposited * price) / (10n ** BigInt(decimals))
            : 0n;
          infos.push({
            token,
            symbol,
            decimals: Number(decimals),
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

        const [d, hf, mb, ir] = await Promise.all([
          borrow.totalDebt(address),
          borrow.healthFactor(address).catch(() => ethers.MaxUint256),
          borrow.maxBorrow(address).catch(() => 0n),
          borrow.interestRateBps(),
        ]);
        setDebt(d);
        setHealthFactor(hf);
        setMaxBorrowable(mb);
        setInterestRate(ir);
      } catch (err) {
        console.error("Borrow load error:", err);
      }
    }
    load();
  }, [vault, oracle, borrow, address, signer, tx.success]);

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

  async function handleWithdraw() {
    if (!borrow || !selectedToken) return;
    const info = collaterals.find((c) => c.token === selectedToken);
    if (!info) return;
    const parsed = ethers.parseUnits(amount, info.decimals);
    await tx.send(() => borrow.withdrawCollateral(selectedToken, parsed));
    setAmount("");
  }

  const hfColor = healthFactor < ethers.parseUnits("1.2", 18) ? "red" : healthFactor < ethers.parseUnits("1.5", 18) ? "yellow" : "green";

  if (!address) {
    return <div className="text-center text-gray-400 py-20">Connect wallet to borrow mUSD</div>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-white">Borrow mUSD</h1>
      <p className="text-gray-400">Deposit collateral and borrow mUSD with overcollateralization</p>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Your Debt" value={formatUSD(debt)} color="red" />
        <StatCard label="Health Factor" value={formatHealthFactor(healthFactor)} color={hfColor} />
        <StatCard label="Max Borrowable" value={formatUSD(maxBorrowable)} color="blue" />
        <StatCard label="Interest Rate" value={formatBps(interestRate) + " APR"} />
      </div>

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
