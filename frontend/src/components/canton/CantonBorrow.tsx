import React, { useState, useEffect, useCallback } from "react";
import { TxButton } from "@/components/TxButton";
import { StatCard } from "@/components/StatCard";
import { PageHeader } from "@/components/PageHeader";
import { useLoopWallet, LoopContract } from "@/hooks/useLoopWallet";
import WalletConnector from "@/components/WalletConnector";

// DAML template IDs
const PACKAGE_ID = process.env.NEXT_PUBLIC_DAML_PACKAGE_ID || "";
const templates = {
  LendingService: `${PACKAGE_ID}:CantonLending:CantonLendingService`,
  Escrow:         `${PACKAGE_ID}:CantonLending:CollateralEscrow`,
  Debt:           `${PACKAGE_ID}:CantonLending:DebtPosition`,
  MUSD:           `${PACKAGE_ID}:CantonDirectMint:CantonMUSD`,
  SMUSD:          `${PACKAGE_ID}:CantonSMUSD:CantonSMUSD`,
  SMUSDE:         `${PACKAGE_ID}:CantonETHPool:CantonSMUSD_E`,
  CantonCoin:     `${PACKAGE_ID}:CantonCoinToken:CantonCoin`,
};

type TabType = "deposit" | "borrow" | "repay" | "withdraw";

interface CollateralPosition {
  contractId: string;
  token: string;
  amount: number;
  ltv: number;
  liqThreshold: number;
  liqPenalty: number;
}

const COLLATERAL_TOKENS = [
  { key: "smusd",  label: "smUSD",   template: "SMUSD",      color: "from-emerald-500 to-teal-500",  ltv: 85, liqThreshold: 90, liqPenalty: 5 },
  { key: "smusde", label: "smUSD-E", template: "SMUSDE",     color: "from-blue-500 to-indigo-500",   ltv: 85, liqThreshold: 90, liqPenalty: 5 },
  { key: "ctn",    label: "CTN",     template: "CantonCoin",  color: "from-yellow-400 to-orange-500", ltv: 65, liqThreshold: 75, liqPenalty: 10 },
];

export function CantonBorrow() {
  const loopWallet = useLoopWallet();

  const [action, setAction] = useState<TabType>("deposit");
  const [selectedToken, setSelectedToken] = useState("smusd");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Contract state
  const [lendingServiceId, setLendingServiceId] = useState("");
  const [escrows, setEscrows] = useState<LoopContract[]>([]);
  const [debts, setDebts] = useState<LoopContract[]>([]);
  const [musdContracts, setMusdContracts] = useState<LoopContract[]>([]);
  const [smusdContracts, setSmusdContracts] = useState<LoopContract[]>([]);
  const [smusdeContracts, setSmusdeContracts] = useState<LoopContract[]>([]);
  const [ctnContracts, setCtnContracts] = useState<LoopContract[]>([]);

  const loadContracts = useCallback(async () => {
    if (!loopWallet.isConnected) return;
    try {
      const [svc, esc, dbt, musd, smusd, smusde, ctn] = await Promise.all([
        loopWallet.queryContracts(templates.LendingService).catch(() => []),
        loopWallet.queryContracts(templates.Escrow).catch(() => []),
        loopWallet.queryContracts(templates.Debt).catch(() => []),
        loopWallet.queryContracts(templates.MUSD).catch(() => []),
        loopWallet.queryContracts(templates.SMUSD).catch(() => []),
        loopWallet.queryContracts(templates.SMUSDE).catch(() => []),
        loopWallet.queryContracts(templates.CantonCoin).catch(() => []),
      ]);
      if (svc.length > 0) setLendingServiceId(svc[0].contractId);
      setEscrows(esc);
      setDebts(dbt);
      setMusdContracts(musd);
      setSmusdContracts(smusd);
      setSmusdeContracts(smusde);
      setCtnContracts(ctn);
    } catch (err) {
      console.error("Failed to load lending contracts:", err);
    }
  }, [loopWallet.isConnected, loopWallet.queryContracts]);

  useEffect(() => { loadContracts(); }, [loadContracts]);

  // ── Derived Values ──
  const totalMusd = musdContracts.reduce((s, c) => s + parseFloat(c.payload?.amount || "0"), 0);
  const totalSmusd = smusdContracts.reduce((s, c) => s + parseFloat(c.payload?.shares || "0"), 0);
  const totalSmusde = smusdeContracts.reduce((s, c) => s + parseFloat(c.payload?.shares || "0"), 0);
  const totalCtn = ctnContracts.reduce((s, c) => s + parseFloat(c.payload?.amount || "0"), 0);

  const balanceMap: Record<string, number> = { smusd: totalSmusd, smusde: totalSmusde, ctn: totalCtn };
  const contractMap: Record<string, LoopContract[]> = { smusd: smusdContracts, smusde: smusdeContracts, ctn: ctnContracts };

  const escrowPositions: CollateralPosition[] = escrows.map(e => ({
    contractId: e.contractId,
    token: e.payload?.collateralType || "smUSD",
    amount: parseFloat(e.payload?.amount || "0"),
    ltv: parseFloat(e.payload?.ltvBps || "8500") / 100,
    liqThreshold: parseFloat(e.payload?.liqThresholdBps || "9000") / 100,
    liqPenalty: parseFloat(e.payload?.liqPenaltyBps || "500") / 100,
  }));
  const totalCollateralUsd = escrowPositions.reduce((s, p) => s + p.amount, 0);
  const totalDebt = debts.reduce((s, c) => s + parseFloat(c.payload?.amount || c.payload?.principal || "0"), 0);
  const maxBorrowable = escrowPositions.reduce((s, p) => s + (p.amount * p.ltv / 100), 0) - totalDebt;
  const healthFactor = totalDebt > 0
    ? escrowPositions.reduce((s, p) => s + (p.amount * p.liqThreshold / 100), 0) / totalDebt
    : 999;
  const utilizationPct = totalCollateralUsd > 0 && totalDebt > 0
    ? Math.min(100, (totalDebt / totalCollateralUsd) * 100)
    : 0;

  const hfColor = healthFactor < 1.2 ? "red" : healthFactor < 1.5 ? "yellow" : "emerald";
  const hfGaugePct = totalDebt > 0
    ? Math.min(100, Math.max(0, ((Math.min(healthFactor, 3) - 1) / 2) * 100))
    : 100;
  const hfGaugeColor = healthFactor < 1.2
    ? "from-red-500 to-red-400"
    : healthFactor < 1.5
    ? "from-yellow-500 to-yellow-400"
    : "from-emerald-500 to-teal-400";

  // ── Handlers ──
  async function handleDeposit() {
    const tokenContracts = contractMap[selectedToken];
    if (!lendingServiceId || !tokenContracts?.length) return;
    setLoading(true); setError(null); setResult(null);
    try {
      const tokenInfo = COLLATERAL_TOKENS.find(t => t.key === selectedToken);
      const choiceName = selectedToken === "smusd" ? "Lending_DepositSMUSD"
        : selectedToken === "smusde" ? "Lending_DepositSMUSDE"
        : "Lending_DepositCTN";
      await loopWallet.exerciseChoice(
        templates.LendingService, lendingServiceId,
        choiceName,
        { collateralCid: tokenContracts[0].contractId, amount }
      );
      setResult(`Deposited ${amount} ${tokenInfo?.label || selectedToken} as collateral`);
      setAmount(""); await loadContracts();
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  }

  async function handleBorrow() {
    if (!lendingServiceId) return;
    setLoading(true); setError(null); setResult(null);
    try {
      await loopWallet.exerciseChoice(
        templates.LendingService, lendingServiceId,
        "Lending_Borrow",
        { amount }
      );
      setResult(`Borrowed ${amount} mUSD against your collateral`);
      setAmount(""); await loadContracts();
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  }

  async function handleRepay() {
    if (!lendingServiceId || !musdContracts.length || !debts.length) return;
    setLoading(true); setError(null); setResult(null);
    try {
      await loopWallet.exerciseChoice(
        templates.LendingService, lendingServiceId,
        "Lending_Repay",
        { musdCid: musdContracts[0].contractId, debtCid: debts[0].contractId, amount }
      );
      setResult(`Repaid ${amount} mUSD of debt`);
      setAmount(""); await loadContracts();
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  }

  async function handleWithdraw() {
    if (!lendingServiceId || !escrows.length) return;
    setLoading(true); setError(null); setResult(null);
    try {
      const tokenInfo = COLLATERAL_TOKENS.find(t => t.key === selectedToken);
      const choiceName = selectedToken === "smusd" ? "Lending_WithdrawSMUSD"
        : selectedToken === "smusde" ? "Lending_WithdrawSMUSDE"
        : "Lending_WithdrawCTN";
      await loopWallet.exerciseChoice(
        templates.LendingService, lendingServiceId,
        choiceName,
        { escrowCid: escrows[0].contractId, amount }
      );
      setResult(`Withdrew ${amount} ${tokenInfo?.label || selectedToken} collateral`);
      setAmount(""); await loadContracts();
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  }

  async function handleRepayMax() {
    if (!lendingServiceId || !musdContracts.length || !debts.length || totalDebt <= 0) return;
    const repayAmount = Math.min(totalMusd, totalDebt);
    if (repayAmount <= 0) return;
    setLoading(true); setError(null); setResult(null);
    try {
      await loopWallet.exerciseChoice(
        templates.LendingService, lendingServiceId,
        "Lending_Repay",
        { musdCid: musdContracts[0].contractId, debtCid: debts[0].contractId, amount: repayAmount.toString() }
      );
      setResult(`Repaid ${repayAmount.toFixed(2)} mUSD — position closed`);
      await loadContracts();
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  }

  // ── Render ──
  if (!loopWallet.isConnected) {
    return (
      <div className="mx-auto max-w-6xl space-y-8">
        <PageHeader title="Borrow & Lend" subtitle="Deposit collateral to borrow mUSD on the Canton Network" badge="Canton" badgeColor="emerald" />
        <div className="flex min-h-[300px] items-center justify-center">
          <div className="max-w-md space-y-6">
            <div className="card-emerald p-8 text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/10">
                <svg className="h-8 w-8 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <h3 className="mb-2 text-xl font-semibold text-white">Connect to Canton</h3>
              <p className="text-gray-400 mb-6">Connect your Loop Wallet to borrow mUSD against Canton collateral.</p>
            </div>
            <WalletConnector mode="canton" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <PageHeader
        title="Borrow & Lend"
        subtitle="Deposit collateral to borrow mUSD on the Canton Network"
        badge={totalDebt > 0 ? "Active Position" : "No Position"}
        badgeColor={totalDebt > 0 ? "warning" : "emerald"}
      />

      {/* Liquidation Alert */}
      {healthFactor < 1.0 && totalDebt > 0 && (
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
                <TxButton onClick={handleRepayMax} loading={loading} disabled={totalMusd <= 0} variant="danger">
                  Emergency Repay ({Math.min(totalMusd, totalDebt).toFixed(2)} mUSD)
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
      {healthFactor >= 1.0 && healthFactor < 1.5 && totalDebt > 0 && (
        <div className="alert-warning flex items-center gap-3">
          <svg className="h-5 w-5 flex-shrink-0 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span className="text-sm">
            <span className="font-semibold">Caution:</span> Health factor is low ({healthFactor.toFixed(2)}). Add collateral or repay debt to avoid liquidation.
          </span>
        </div>
      )}

      {/* Two-Column Grid */}
      <div className="grid gap-8 lg:grid-cols-2">
        {/* LEFT column: Action Card */}
        <div>
          <div className="card-gradient-border overflow-hidden">
            {/* Tabs */}
            <div className="flex border-b border-white/10">
              {(["deposit", "borrow", "repay", "withdraw"] as const).map((a) => {
                const tabIcons: Record<TabType, JSX.Element> = {
                  deposit: (
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                    </svg>
                  ),
                  borrow: (
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8V7m0 1v8m0 0v1" />
                    </svg>
                  ),
                  repay: (
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  ),
                  withdraw: (
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                    </svg>
                  ),
                };
                return (
                  <button
                    key={a}
                    className={`relative flex-1 px-4 py-4 text-center text-sm font-semibold transition-all duration-300 ${
                      action === a ? "text-white" : "text-gray-400 hover:text-white"
                    }`}
                    onClick={() => { setAction(a); setAmount(""); setError(null); setResult(null); }}
                  >
                    <span className="relative z-10 flex items-center justify-center gap-2 capitalize">
                      {tabIcons[a]}
                      {a}
                    </span>
                    {action === a && (
                      <span className="absolute bottom-0 left-1/2 h-0.5 w-16 -translate-x-1/2 rounded-full bg-gradient-to-r from-emerald-500 to-cyan-500" />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Form Content */}
            <div className="space-y-6 p-6">
              {/* Token Selector for deposit/withdraw */}
              {(action === "deposit" || action === "withdraw") && (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-400">Collateral Token</label>
                  <div className="grid grid-cols-3 gap-2">
                    {COLLATERAL_TOKENS.map(t => (
                      <button
                        key={t.key}
                        onClick={() => setSelectedToken(t.key)}
                        className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-3 text-sm font-semibold transition-all ${
                          selectedToken === t.key
                            ? "border-emerald-500 bg-emerald-500/10 text-white"
                            : "border-white/10 bg-surface-800/50 text-gray-400 hover:border-white/30"
                        }`}
                      >
                        <div className={`h-5 w-5 rounded-full bg-gradient-to-br ${t.color}`} />
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Amount Input */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-gray-400">
                    {action === "deposit" ? "Deposit Amount" : action === "borrow" ? "Borrow Amount (mUSD)" : action === "repay" ? "Repay Amount (mUSD)" : "Withdraw Amount"}
                  </label>
                  {action === "borrow" && (
                    <span className="text-xs text-gray-500">Max: {Math.max(0, maxBorrowable).toFixed(2)} mUSD</span>
                  )}
                  {action === "repay" && (
                    <span className="text-xs text-gray-500">Debt: {totalDebt.toFixed(2)} mUSD</span>
                  )}
                  {(action === "deposit" || action === "withdraw") && (
                    <span className="text-xs text-gray-500">
                      Balance: {(balanceMap[selectedToken] || 0).toFixed(2)}
                    </span>
                  )}
                </div>
                <div className="relative rounded-xl border border-white/10 bg-surface-800/50 p-4 transition-all duration-300 focus-within:border-emerald-500/50 focus-within:shadow-[0_0_20px_-5px_rgba(16,185,129,0.3)]">
                  <div className="flex items-center gap-4">
                    <input
                      type="number"
                      className="flex-1 bg-transparent text-2xl font-semibold text-white placeholder-gray-600 focus:outline-none"
                      placeholder="0.00"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                    <div className="flex items-center gap-2">
                      {action === "borrow" && maxBorrowable > 0 && (
                        <button
                          className="rounded-lg bg-emerald-500/20 px-3 py-1.5 text-xs font-semibold text-emerald-400 transition-colors hover:bg-emerald-500/30"
                          onClick={() => setAmount(Math.max(0, maxBorrowable).toFixed(2))}
                        >MAX</button>
                      )}
                      {action === "repay" && totalDebt > 0 && (
                        <button
                          className="rounded-lg bg-emerald-500/20 px-3 py-1.5 text-xs font-semibold text-emerald-400 transition-colors hover:bg-emerald-500/30"
                          onClick={() => setAmount(Math.min(totalMusd, totalDebt).toFixed(2))}
                        >MAX</button>
                      )}
                      {(action === "deposit" || action === "withdraw") && (balanceMap[selectedToken] || 0) > 0 && (
                        <button
                          className="rounded-lg bg-emerald-500/20 px-3 py-1.5 text-xs font-semibold text-emerald-400 transition-colors hover:bg-emerald-500/30"
                          onClick={() => setAmount((balanceMap[selectedToken] || 0).toString())}
                        >MAX</button>
                      )}
                      <div className="flex items-center gap-2 rounded-full bg-surface-700/50 px-3 py-1.5">
                        <div className={`h-6 w-6 rounded-full bg-gradient-to-br ${
                          action === "borrow" || action === "repay"
                            ? "from-emerald-500 to-teal-500"
                            : (COLLATERAL_TOKENS.find(t => t.key === selectedToken)?.color || "from-gray-500 to-gray-600")
                        }`} />
                        <span className="font-semibold text-white">
                          {action === "borrow" || action === "repay"
                            ? "mUSD"
                            : COLLATERAL_TOKENS.find(t => t.key === selectedToken)?.label || "Token"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Action Button */}
              <TxButton
                onClick={
                  action === "deposit" ? handleDeposit
                  : action === "borrow" ? handleBorrow
                  : action === "repay" ? handleRepay
                  : handleWithdraw
                }
                loading={loading}
                disabled={!amount || parseFloat(amount) <= 0}
                variant={action === "repay" ? "secondary" : "primary"}
                className="w-full"
              >
                <span className="flex items-center justify-center gap-2">
                  {action === "deposit" && (
                    <>
                      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                      </svg>
                      Deposit Collateral
                    </>
                  )}
                  {action === "borrow" && (
                    <>
                      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8V7m0 1v8m0 0v1" />
                      </svg>
                      Borrow mUSD
                    </>
                  )}
                  {action === "repay" && (
                    <>
                      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      Repay Debt
                    </>
                  )}
                  {action === "withdraw" && (
                    <>
                      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                      </svg>
                      Withdraw Collateral
                    </>
                  )}
                </span>
              </TxButton>

              {/* Status Messages */}
              {error && (
                <div className="alert-error flex items-center gap-3">
                  <svg className="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className="text-sm">{error}</span>
                </div>
              )}
              {result && (
                <div className="alert-success flex items-center gap-3">
                  <svg className="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className="text-sm">{result}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* RIGHT column: Stats + Health Factor + Positions */}
        <div className="space-y-4">
          {/* Stats Dashboard */}
          <div className="grid gap-4 grid-cols-2">
            <StatCard
              label="Total Collateral"
              value={`$${totalCollateralUsd.toFixed(2)}`}
              color="blue"
              icon={
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              }
            />
            <StatCard
              label="Outstanding Debt"
              value={`$${totalDebt.toFixed(2)}`}
              color={totalDebt > 0 ? "red" : "default"}
              icon={
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
                </svg>
              }
            />
            <StatCard
              label="Available to Borrow"
              value={`$${Math.max(0, maxBorrowable).toFixed(2)}`}
              color="green"
              icon={
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              }
            />
            <StatCard
              label="Your mUSD"
              value={totalMusd.toFixed(2)}
              icon={
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                </svg>
              }
            />
          </div>

          {/* Health Factor & Position Overview */}
          {totalDebt > 0 && (
            <div className="card-gradient-border overflow-hidden">
              <div className="grid gap-6 sm:grid-cols-2">
                {/* Health Factor Gauge */}
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <div className={`flex h-10 w-10 items-center justify-center rounded-full ${
                      hfColor === "red" ? "bg-red-500/20" : hfColor === "yellow" ? "bg-yellow-500/20" : "bg-emerald-500/20"
                    }`}>
                      <svg className={`h-5 w-5 ${
                        hfColor === "red" ? "text-red-400" : hfColor === "yellow" ? "text-yellow-400" : "text-emerald-400"
                      }`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm text-gray-400">Health Factor</p>
                      <p className={`text-3xl font-bold ${
                        hfColor === "red" ? "text-red-400" : hfColor === "yellow" ? "text-yellow-400" : "text-emerald-400"
                      }`}>
                        {healthFactor > 10 ? "∞" : healthFactor.toFixed(2)}
                      </p>
                    </div>
                  </div>

                  {/* Gauge Bar */}
                  <div className="space-y-2">
                    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-800">
                      <div
                        className={`h-full rounded-full bg-gradient-to-r ${hfGaugeColor} transition-all duration-1000`}
                        style={{ width: `${hfGaugePct}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-xs text-gray-500">
                      <span className="text-red-400">Liquidation (1.0)</span>
                      <span>Caution (1.5)</span>
                      <span className="text-emerald-400">Safe (3.0+)</span>
                    </div>
                  </div>

                  <div className="rounded-lg bg-surface-800/50 px-3 py-2 text-sm">
                    <span className="text-gray-400">Status: </span>
                    <span className={`font-semibold ${
                      hfColor === "red" ? "text-red-400" : hfColor === "yellow" ? "text-yellow-400" : "text-emerald-400"
                    }`}>
                      {healthFactor < 1.0 ? "Liquidatable" : healthFactor < 1.2 ? "Critical" : healthFactor < 1.5 ? "Caution" : healthFactor > 10 ? "Very Safe" : "Healthy"}
                    </span>
                  </div>
                </div>

                {/* Position Summary */}
                <div className="space-y-4">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/20">
                      <svg className="h-5 w-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 8v8m-4-5v5m-4-2v2m-2 4h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                    </div>
                    <p className="text-sm text-gray-400">Position Summary</p>
                  </div>

                  <div className="space-y-3">
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Collateral Value</span>
                      <span className="font-medium text-white">${totalCollateralUsd.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Outstanding Debt</span>
                      <span className="font-medium text-red-400">${totalDebt.toFixed(2)}</span>
                    </div>
                    <div className="h-px bg-white/10" />
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Net Position</span>
                      <span className="font-medium text-white">${Math.max(0, totalCollateralUsd - totalDebt).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Utilization</span>
                      <span className={`font-medium ${utilizationPct > 80 ? "text-red-400" : utilizationPct > 60 ? "text-yellow-400" : "text-emerald-400"}`}>
                        {utilizationPct.toFixed(1)}%
                      </span>
                    </div>
                  </div>

                  {/* Quick repay */}
                  <div className="flex items-center justify-between rounded-lg bg-surface-800/50 px-4 py-3">
                    <div>
                      <p className="text-xs text-gray-400">Your mUSD</p>
                      <p className="font-semibold text-white">{totalMusd.toFixed(2)}</p>
                    </div>
                    <TxButton
                      onClick={handleRepayMax}
                      loading={loading}
                      disabled={totalMusd <= 0 || totalDebt <= 0}
                      variant="secondary"
                      size="sm"
                      className="!py-2 !px-4"
                    >
                      Close Position
                    </TxButton>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Collateral Positions Table */}
          <div className="card overflow-hidden">
            <div className="flex items-center gap-3 mb-5">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-purple-500/20">
                <svg className="h-5 w-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">Collateral Positions</h2>
                <p className="text-sm text-gray-400">{escrowPositions.length} active position{escrowPositions.length !== 1 ? "s" : ""}</p>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-gray-400">
                    <th className="pb-3 text-left font-medium">Token</th>
                    <th className="pb-3 text-right font-medium">Deposited</th>
                    <th className="pb-3 text-right font-medium">LTV</th>
                    <th className="pb-3 text-right font-medium">Liq. Threshold</th>
                    <th className="pb-3 text-right font-medium">Penalty</th>
                  </tr>
                </thead>
                <tbody>
                  {escrowPositions.length > 0 ? (
                    escrowPositions.map((p, i) => (
                      <tr key={i} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
                        <td className="py-3">
                          <div className="flex items-center gap-2">
                            <div className="h-7 w-7 rounded-full bg-gradient-to-br from-emerald-500 to-teal-500" />
                            <span className="font-medium text-white">{p.token}</span>
                          </div>
                        </td>
                        <td className="py-3 text-right text-gray-300">{p.amount.toFixed(2)}</td>
                        <td className="py-3 text-right">
                          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400">{p.ltv.toFixed(0)}%</span>
                        </td>
                        <td className="py-3 text-right">
                          <span className="rounded-full bg-yellow-500/10 px-2 py-0.5 text-xs font-medium text-yellow-400">{p.liqThreshold.toFixed(0)}%</span>
                        </td>
                        <td className="py-3 text-right">
                          <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-400">{p.liqPenalty.toFixed(0)}%</span>
                        </td>
                      </tr>
                    ))
                  ) : (
                    COLLATERAL_TOKENS.map(t => (
                      <tr key={t.key} className="border-b border-white/5">
                        <td className="py-3">
                          <div className="flex items-center gap-2">
                            <div className={`h-7 w-7 rounded-full bg-gradient-to-br ${t.color}`} />
                            <span className="font-medium text-gray-500">{t.label}</span>
                          </div>
                        </td>
                        <td className="py-3 text-right text-gray-600">0.00</td>
                        <td className="py-3 text-right">
                          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400/50">{t.ltv}%</span>
                        </td>
                        <td className="py-3 text-right">
                          <span className="rounded-full bg-yellow-500/10 px-2 py-0.5 text-xs font-medium text-yellow-400/50">{t.liqThreshold}%</span>
                        </td>
                        <td className="py-3 text-right">
                          <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-400/50">{t.liqPenalty}%</span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* How Borrowing Works */}
      <div className="card">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500/20">
            <svg className="h-5 w-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-white">How Canton Borrowing Works</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-4">
          <div className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-500/20 text-blue-400 font-bold text-sm mb-3">1</div>
            <h3 className="font-medium text-white mb-1">Deposit</h3>
            <p className="text-sm text-gray-400">Lock smUSD, smUSD-E, or CTN as collateral via DAML escrow.</p>
          </div>
          <div className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400 font-bold text-sm mb-3">2</div>
            <h3 className="font-medium text-white mb-1">Borrow</h3>
            <p className="text-sm text-gray-400">Mint mUSD up to your collateral&apos;s LTV ratio on Canton.</p>
          </div>
          <div className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-yellow-500/20 text-yellow-400 font-bold text-sm mb-3">3</div>
            <h3 className="font-medium text-white mb-1">Repay</h3>
            <p className="text-sm text-gray-400">Return mUSD + accrued interest to close your debt position.</p>
          </div>
          <div className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-500/20 text-purple-400 font-bold text-sm mb-3">4</div>
            <h3 className="font-medium text-white mb-1">Withdraw</h3>
            <p className="text-sm text-gray-400">Reclaim your collateral once debt is cleared.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
