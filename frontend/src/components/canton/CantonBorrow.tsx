import React, { useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { TxButton } from "@/components/TxButton";
import {
  useCantonLedger,
  cantonExercise,
  fetchFreshBalances,
  refreshPriceFeeds,
  type SimpleToken,
} from "@/hooks/useCantonLedger";

type LendingTab = "deposit" | "borrow" | "repay" | "withdraw";
type CollateralAsset = "CTN" | "smUSD" | "smUSD-E";

const COLLATERAL_ASSETS: { key: CollateralAsset; label: string; color: string; damlChoice: string; ltvDefault: number }[] = [
  { key: "CTN",     label: "Canton Coin",  color: "from-yellow-400 to-orange-500", damlChoice: "Lending_DepositCTN",   ltvDefault: 6500 },
  { key: "smUSD",   label: "smUSD",        color: "from-emerald-500 to-teal-500",  damlChoice: "Lending_DepositSMUSD", ltvDefault: 9000 },
  { key: "smUSD-E", label: "smUSD-E",      color: "from-blue-500 to-indigo-500",   damlChoice: "Lending_DepositSMUSD", ltvDefault: 8500 },
];

function fmtAmount(v: string | number, decimals = 2): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (isNaN(n)) return "0.00";
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function CantonBorrow() {
  const { data, loading, error, refresh } = useCantonLedger(15_000);

  const [tab, setTab] = useState<LendingTab>("deposit");
  const [collateralAsset, setCollateralAsset] = useState<CollateralAsset>("CTN");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [borrowAmount, setBorrowAmount] = useState("");
  const [repayIdx, setRepayIdx] = useState(0);
  const [txLoading, setTxLoading] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);
  const [txSuccess, setTxSuccess] = useState<string | null>(null);

  const lendingService = data?.lendingService || null;
  const escrowPositions = data?.escrowPositions || [];
  const debtPositions = data?.debtPositions || [];
  const coinTokens = data?.cantonCoinTokens || [];
  const smusdTokens = data?.smusdTokens || [];
  const smusdETokens = data?.smusdETokens || [];
  const tokens = data?.tokens || [];
  const totalMusd = data ? parseFloat(data.totalBalance) : 0;
  const totalCoin = data?.totalCoin ? parseFloat(data.totalCoin) : 0;
  const totalSmusd = data?.totalSmusd ? parseFloat(data.totalSmusd) : 0;
  const totalSmusdE = data?.totalSmusdE ? parseFloat(data.totalSmusdE) : 0;

  const totalBorrows = lendingService ? parseFloat(lendingService.totalBorrows) : 0;
  const interestRate = lendingService ? (lendingService.interestRateBps / 100) : 5.0;
  const totalDebt = debtPositions.reduce((s, d) => s + parseFloat(d.debtMusd), 0);
  const totalCollateralValue = escrowPositions.reduce((s, e) => s + parseFloat(e.amount), 0);

  function getCollateralTokens(): SimpleToken[] {
    if (collateralAsset === "CTN") return coinTokens;
    if (collateralAsset === "smUSD") return smusdTokens;
    return smusdETokens;
  }
  function getCollateralBalance(): number {
    if (collateralAsset === "CTN") return totalCoin;
    if (collateralAsset === "smUSD") return totalSmusd;
    return totalSmusdE;
  }

  async function handleDeposit() {
    if (!lendingService) return;
    setTxLoading(true); setTxError(null); setTxSuccess(null);
    try {
      const toks = getCollateralTokens();
      const token = toks[selectedIdx];
      if (!token) throw new Error(`No ${collateralAsset} token selected`);
      let choice = "";
      const args: Record<string, unknown> = { user: data!.party };
      if (collateralAsset === "CTN") {
        choice = "Lending_DepositCTN"; args.coinCid = token.contractId;
      } else if (collateralAsset === "smUSD") {
        choice = "Lending_DepositSMUSD"; args.smusdCid = token.contractId;
      } else {
        // smUSD-E uses its own choice with different arg name
        choice = "Lending_DepositSMUSDE"; args.smusdeCid = token.contractId;
      }
      const resp = await cantonExercise("CantonLendingService", lendingService.contractId, choice, args);
      if (!resp.success) throw new Error(resp.error || "Deposit failed");
      setTxSuccess(`Deposited ${fmtAmount(token.amount)} ${collateralAsset} as collateral`);
      await refresh();
    } catch (err: any) { setTxError(err.message); }
    finally { setTxLoading(false); }
  }

  async function handleBorrow() {
    if (!lendingService || escrowPositions.length === 0) return;
    setTxLoading(true); setTxError(null); setTxSuccess(null);
    try {
      const amt = parseFloat(borrowAmount);
      if (isNaN(amt) || amt <= 0) throw new Error("Enter a valid borrow amount");

      // 1. Refresh price feeds to prevent PRICE_STALE
      const priceResult = await refreshPriceFeeds();
      if (!priceResult.success) {
        console.warn("Price feed refresh warning:", priceResult.error);
      }

      // 2. Fetch fresh data after price refresh (price feeds get new CIDs)
      const fresh = await fetchFreshBalances();
      const freshService = fresh.lendingService;
      if (!freshService) throw new Error("Lending service not found");
      const freshEscrows = fresh.escrowPositions || [];
      const freshPF = fresh.priceFeeds || [];
      if (freshEscrows.length === 0) throw new Error("No collateral deposited");

      // Lending_Borrow needs ALL escrow positions + matching price feeds (1:1)
      const allEscrowCids = freshEscrows.map(e => e.contractId);
      const allPriceFeedCids = freshEscrows.map(e => {
        const sym = e.collateralType === "CTN_Coin" ? "CTN" : e.collateralType === "CTN_SMUSD" ? "sMUSD" : "sMUSD-E";
        return freshPF.find(p => p.asset === sym)?.contractId || "";
      });
      if (allPriceFeedCids.some(c => !c)) throw new Error("Missing price feed for one or more collateral types");
      const resp = await cantonExercise("CantonLendingService", freshService.contractId, "Lending_Borrow", {
        user: fresh.party, borrowAmount: String(amt), escrowCids: allEscrowCids, priceFeedCids: allPriceFeedCids,
      });
      if (!resp.success) throw new Error(resp.error || "Borrow failed");
      setTxSuccess(`Borrowed ${fmtAmount(amt)} mUSD against collateral`);
      setBorrowAmount(""); await refresh();
    } catch (err: any) { setTxError(err.message); }
    finally { setTxLoading(false); }
  }

  async function handleRepay() {
    if (!lendingService || debtPositions.length === 0 || tokens.length === 0) return;
    setTxLoading(true); setTxError(null); setTxSuccess(null);
    try {
      // Fetch fresh data (Lending_Repay is consuming)
      const fresh = await fetchFreshBalances();
      const freshService = fresh.lendingService;
      if (!freshService) throw new Error("Lending service not found");
      const freshDebts = fresh.debtPositions || [];
      const freshTokens = fresh.tokens || [];
      const debt = freshDebts[selectedIdx] || freshDebts[0];
      if (!debt) throw new Error("No debt position found");
      let musd = freshTokens[repayIdx] || freshTokens[0];
      if (!musd) throw new Error("No mUSD token available for repayment");

      const debtTotal = parseFloat(debt.debtMusd) + parseFloat(debt.interestAccrued || "0");
      const musdAmount = parseFloat(musd.amount);

      // If mUSD token amount > debt, split first to create exact-amount token
      let musdCidForRepay = musd.contractId;
      if (musdAmount > debtTotal && debtTotal > 0) {
        const splitResp = await cantonExercise("CantonMUSD", musd.contractId, "CantonMUSD_Split", {
          splitAmount: String(debtTotal),
        });
        if (!splitResp.success) throw new Error(splitResp.error || "Failed to split mUSD token");
        // After split, we need to refresh to get the new CID of the split portion
        const afterSplit = await fetchFreshBalances();
        const splitTokens = afterSplit.tokens || [];
        // Find the token with amount closest to debtTotal
        const exactToken = splitTokens.find(t => {
          const diff = Math.abs(parseFloat(t.amount) - debtTotal);
          return diff < 0.000001;
        });
        if (exactToken) {
          musdCidForRepay = exactToken.contractId;
        } else {
          // Fall back to smallest token that covers the debt
          const sorted = [...splitTokens].sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount));
          const viable = sorted.find(t => parseFloat(t.amount) >= debtTotal);
          if (viable) musdCidForRepay = viable.contractId;
        }
        // Re-fetch service CID (might have changed if concurrent ops)
        const fresh2 = afterSplit;
        const freshService2 = fresh2.lendingService;
        if (freshService2) {
          const resp = await cantonExercise("CantonLendingService", freshService2.contractId, "Lending_Repay", {
            user: fresh2.party, debtCid: debt.contractId, musdCid: musdCidForRepay,
          });
          if (!resp.success) throw new Error(resp.error || "Repay failed");
          setTxSuccess(`Repaid ${fmtAmount(debtTotal)} mUSD debt`);
          await refresh();
          return;
        }
      }

      const resp = await cantonExercise("CantonLendingService", freshService.contractId, "Lending_Repay", {
        user: fresh.party, debtCid: debt.contractId, musdCid: musdCidForRepay,
      });
      if (!resp.success) throw new Error(resp.error || "Repay failed");
      setTxSuccess(`Repaid debt position`);
      await refresh();
    } catch (err: any) { setTxError(err.message); }
    finally { setTxLoading(false); }
  }

  async function handleWithdraw() {
    if (!lendingService || escrowPositions.length === 0) return;
    setTxLoading(true); setTxError(null); setTxSuccess(null);
    try {
      // 1. Refresh price feeds (withdraw checks health factor which needs fresh prices)
      const priceResult = await refreshPriceFeeds();
      if (!priceResult.success) {
        console.warn("Price feed refresh warning:", priceResult.error);
      }

      // 2. Fetch fresh data after price refresh
      const fresh = await fetchFreshBalances();
      const freshService = fresh.lendingService;
      if (!freshService) throw new Error("Lending service not found");
      const freshEscrows = fresh.escrowPositions || [];
      const freshPF = fresh.priceFeeds || [];
      const escrow = freshEscrows[selectedIdx] || freshEscrows[0];
      if (!escrow) throw new Error("No collateral position found");

      // Pick correct withdraw choice per collateral type
      const choiceMap: Record<string, string> = {
        "CTN_Coin": "Lending_WithdrawCTN",
        "CTN_SMUSD": "Lending_WithdrawSMUSD",
        "CTN_SMUSDE": "Lending_WithdrawSMUSDE",
      };
      const choice = choiceMap[escrow.collateralType] || "Lending_WithdrawCTN";
      // Collect other escrow positions + price feeds for health check
      const otherEscrows = freshEscrows.filter((_, i) => i !== selectedIdx);
      const otherEscrowCids = otherEscrows.map(e => e.contractId);
      const priceFeedCids = otherEscrows.map(e => {
        const sym = e.collateralType === "CTN_Coin" ? "CTN" : e.collateralType === "CTN_SMUSD" ? "sMUSD" : "sMUSD-E";
        return freshPF.find(p => p.asset === sym)?.contractId || "";
      });
      const resp = await cantonExercise("CantonLendingService", freshService.contractId, choice, {
        user: fresh.party, escrowCid: escrow.contractId, withdrawAmount: escrow.amount,
        otherEscrowCids, priceFeedCids,
      });
      if (!resp.success) throw new Error(resp.error || "Withdraw failed");
      setTxSuccess(`Withdrew ${fmtAmount(escrow.amount)} ${escrow.collateralType} collateral`);
      await refresh();
    } catch (err: any) { setTxError(err.message); }
    finally { setTxLoading(false); }
  }

  if (loading && !data) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-4 border-emerald-500/20 border-t-emerald-500" />
          <p className="text-gray-400">Loading Canton ledger\u2026</p>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="max-w-md space-y-4 text-center">
          <h3 className="text-xl font-semibold text-white">Canton Unavailable</h3>
          <p className="text-sm text-gray-400">{error}</p>
          <button onClick={refresh} className="rounded-xl bg-emerald-600 px-6 py-2 font-medium text-white hover:bg-emerald-500">Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <PageHeader
        title="Borrow & Lend"
        subtitle="Deposit collateral and borrow mUSD at competitive rates on Canton"
        badge="Canton"
        badgeColor="warning"
        action={
          <button onClick={refresh} className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-400 hover:bg-emerald-500/20">
            <svg className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        }
      />

      {!lendingService ? (
        <div className="card-gradient-border p-8 text-center space-y-4">
          <div className="mx-auto h-16 w-16 rounded-2xl bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center">
            <svg className="h-8 w-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
            </svg>
          </div>
          <h3 className="text-2xl font-bold text-white">Canton Lending Service</h3>
          <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-5 max-w-lg mx-auto">
            <p className="text-sm text-gray-400">The lending service is not yet deployed on this Canton participant.</p>
          </div>
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            <StatCard label="Total Borrows" value={fmtAmount(totalBorrows) + " mUSD"} color="yellow" variant="glow" />
            <StatCard label="Interest Rate" value={`${interestRate.toFixed(2)}%`} subValue="annualized" color="blue" />
            <StatCard label="Your Debt" value={fmtAmount(totalDebt) + " mUSD"} subValue={`${debtPositions.length} positions`} color="red" />
            <StatCard label="Your Collateral" value={fmtAmount(totalCollateralValue)} subValue={`${escrowPositions.length} escrows`} color="green" />
          </div>

          <div className="grid gap-8 lg:grid-cols-2">
            <div>
              <div className="card-gradient-border overflow-hidden">
                <div className="flex border-b border-white/10">
                  {([
                    { key: "deposit" as LendingTab, label: "Deposit" },
                    { key: "borrow" as LendingTab, label: "Borrow" },
                    { key: "repay" as LendingTab, label: "Repay" },
                    { key: "withdraw" as LendingTab, label: "Withdraw" },
                  ]).map(({ key, label }) => (
                    <button key={key}
                      className={`relative flex-1 px-4 py-3 text-center text-sm font-semibold transition-all ${tab === key ? "text-white" : "text-gray-400 hover:text-white"}`}
                      onClick={() => { setTab(key); setSelectedIdx(0); setTxError(null); setTxSuccess(null); }}>
                      {label}
                      {tab === key && <span className="absolute bottom-0 left-1/2 h-0.5 w-12 -translate-x-1/2 rounded-full bg-gradient-to-r from-yellow-400 to-orange-500" />}
                    </button>
                  ))}
                </div>

                <div className="space-y-6 p-6">
                  {tab === "deposit" && (
                    <>
                      <div className="space-y-3">
                        <label className="text-sm font-medium text-gray-400">Collateral Type</label>
                        <div className="grid grid-cols-3 gap-2">
                          {COLLATERAL_ASSETS.map(({ key, label }) => (
                            <button key={key} onClick={() => { setCollateralAsset(key); setSelectedIdx(0); }}
                              className={`rounded-xl border px-3 py-3 text-sm font-semibold transition-all ${collateralAsset === key ? "border-yellow-500 bg-yellow-500/20 text-white" : "border-white/10 bg-surface-800/50 text-gray-400 hover:border-white/30 hover:text-white"}`}>
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                      {getCollateralTokens().length > 0 ? (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <label className="text-sm font-medium text-gray-400">Select {collateralAsset}</label>
                            <span className="text-xs text-gray-500">Balance: {fmtAmount(getCollateralBalance())} {collateralAsset}</span>
                          </div>
                          <select className="w-full rounded-xl border border-white/10 bg-surface-800/50 px-4 py-3 text-sm text-white focus:border-yellow-500/50 focus:outline-none"
                            value={selectedIdx} onChange={(e) => setSelectedIdx(Number(e.target.value))}>
                            {getCollateralTokens().map((t, i) => (
                              <option key={t.contractId} value={i}>{fmtAmount(t.amount)} {collateralAsset} \u2014 {t.contractId.slice(0, 12)}\u2026</option>
                            ))}
                          </select>
                          <div className="rounded-xl bg-surface-800/30 p-4 space-y-2">
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-gray-400">Max LTV</span>
                              <span className="text-white font-medium">{((COLLATERAL_ASSETS.find(c => c.key === collateralAsset)?.ltvDefault || 6500) / 100).toFixed(0)}%</span>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-gray-400">Interest Rate</span>
                              <span className="text-white font-medium">{interestRate.toFixed(2)}%</span>
                            </div>
                          </div>
                          <TxButton onClick={handleDeposit} loading={txLoading} disabled={getCollateralTokens().length === 0} className="w-full">
                            Deposit {collateralAsset} as Collateral
                          </TxButton>
                        </div>
                      ) : (
                        <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-4 text-center">
                          <p className="text-sm text-gray-400">No {collateralAsset} tokens available</p>
                        </div>
                      )}
                    </>
                  )}

                  {tab === "borrow" && (
                    escrowPositions.length === 0 ? (
                      <div className="text-center py-12">
                        <p className="text-gray-400 font-medium">No collateral deposited</p>
                        <p className="text-sm text-gray-500 mt-1">Deposit collateral first to borrow mUSD</p>
                      </div>
                    ) : (
                      <>
                        <div className="space-y-3">
                          <label className="text-sm font-medium text-gray-400">Select Collateral Position</label>
                          {escrowPositions.map((esc, idx) => (
                            <button key={esc.contractId} onClick={() => setSelectedIdx(idx)}
                              className={`w-full rounded-xl border p-4 text-left transition-all ${selectedIdx === idx ? "border-yellow-500 bg-yellow-500/10" : "border-white/10 bg-surface-800/50 hover:border-white/30"}`}>
                              <div className="flex items-center justify-between">
                                <div>
                                  <span className="font-semibold text-white">{fmtAmount(esc.amount, 4)} {esc.collateralType}</span>
                                  <p className="text-xs text-gray-500 mt-1">{esc.contractId.slice(0, 16)}\u2026</p>
                                </div>
                                <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs text-emerald-400">Escrowed</span>
                              </div>
                            </button>
                          ))}
                        </div>
                        <div className="space-y-3">
                          <label className="text-sm font-medium text-gray-400">Borrow Amount (mUSD)</label>
                          <input type="number" value={borrowAmount} onChange={(e) => setBorrowAmount(e.target.value)}
                            placeholder="0.00" min="0" step="0.01"
                            className="w-full rounded-xl border border-white/10 bg-surface-800/50 px-4 py-3 text-sm text-white placeholder-gray-500 focus:border-yellow-500/50 focus:outline-none" />
                          <p className="text-xs text-gray-500">Min borrow: {fmtAmount(lendingService.minBorrow)} mUSD</p>
                        </div>
                        <TxButton onClick={handleBorrow} loading={txLoading} disabled={!borrowAmount || parseFloat(borrowAmount) <= 0} className="w-full">
                          Borrow mUSD
                        </TxButton>
                      </>
                    )
                  )}

                  {tab === "repay" && (
                    debtPositions.length === 0 ? (
                      <div className="text-center py-12">
                        <p className="text-gray-400 font-medium">No outstanding debt</p>
                        <p className="text-sm text-gray-500 mt-1">Nothing to repay</p>
                      </div>
                    ) : (
                      <>
                        <div className="space-y-3">
                          <label className="text-sm font-medium text-gray-400">Select Debt Position</label>
                          {debtPositions.map((debt, idx) => (
                            <button key={debt.contractId} onClick={() => setSelectedIdx(idx)}
                              className={`w-full rounded-xl border p-4 text-left transition-all ${selectedIdx === idx ? "border-red-500 bg-red-500/10" : "border-white/10 bg-surface-800/50 hover:border-white/30"}`}>
                              <div className="flex items-center justify-between">
                                <div>
                                  <span className="font-semibold text-white">{fmtAmount(debt.debtMusd)} mUSD debt</span>
                                  <p className="text-xs text-gray-500 mt-1">{debt.collateralType} \u2022 Interest: {fmtAmount(debt.interestAccrued)} mUSD</p>
                                </div>
                                <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-xs text-red-400">Active</span>
                              </div>
                            </button>
                          ))}
                        </div>
                        {tokens.length > 0 ? (
                          <div className="space-y-3">
                            <label className="text-sm font-medium text-gray-400">Select mUSD for Repayment</label>
                            <select className="w-full rounded-xl border border-white/10 bg-surface-800/50 px-4 py-3 text-sm text-white focus:border-red-500/50 focus:outline-none"
                              value={repayIdx} onChange={(e) => setRepayIdx(Number(e.target.value))}>
                              {tokens.map((t, i) => (
                                <option key={t.contractId} value={i}>{fmtAmount(t.amount)} mUSD \u2014 nonce {t.nonce}</option>
                              ))}
                            </select>
                            <TxButton onClick={handleRepay} loading={txLoading} disabled={debtPositions.length === 0} className="w-full">
                              Repay Debt
                            </TxButton>
                          </div>
                        ) : (
                          <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-4 text-center">
                            <p className="text-sm text-gray-400">No mUSD available for repayment</p>
                          </div>
                        )}
                      </>
                    )
                  )}

                  {tab === "withdraw" && (
                    escrowPositions.length === 0 ? (
                      <div className="text-center py-12">
                        <p className="text-gray-400 font-medium">No collateral positions</p>
                        <p className="text-sm text-gray-500 mt-1">Deposit collateral first</p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <label className="text-sm font-medium text-gray-400">Select Collateral to Withdraw</label>
                        {escrowPositions.map((esc, idx) => (
                          <button key={esc.contractId} onClick={() => setSelectedIdx(idx)}
                            className={`w-full rounded-xl border p-4 text-left transition-all ${selectedIdx === idx ? "border-emerald-500 bg-emerald-500/10" : "border-white/10 bg-surface-800/50 hover:border-white/30"}`}>
                            <div className="flex items-center justify-between">
                              <div>
                                <span className="font-semibold text-white">{fmtAmount(esc.amount, 4)} {esc.collateralType}</span>
                                <p className="text-xs text-gray-500 mt-1">{esc.contractId.slice(0, 16)}\u2026</p>
                              </div>
                              <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs text-emerald-400">Escrowed</span>
                            </div>
                          </button>
                        ))}
                        <TxButton onClick={handleWithdraw} loading={txLoading} disabled={escrowPositions.length === 0} className="w-full">
                          Withdraw Collateral
                        </TxButton>
                      </div>
                    )
                  )}

                  {txError && <div className="alert-error flex items-center gap-3"><span className="text-sm">{txError}</span></div>}
                  {txSuccess && <div className="alert-success flex items-center gap-3"><span className="text-sm">{txSuccess}</span></div>}
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div className="grid gap-3">
                {COLLATERAL_ASSETS.map(({ key, label, color, ltvDefault }) => {
                  const cfgKey = key === "CTN" ? "CTN_Coin" : key === "smUSD" ? "CTN_SMUSD" : "CTN_SMUSDE";
                  const cfg = lendingService.configs?.[cfgKey];
                  const ltv = cfg ? (cfg.ltvBps / 100) : (ltvDefault / 100);
                  const liqThreshold = cfg ? (cfg.liqThresholdBps / 100) : ltv + 10;
                  const liqPenalty = cfg ? (cfg.liqPenaltyBps / 100) : (key === "CTN" ? 10 : 5);
                  return (
                    <div key={key} className="card group transition-all duration-300 hover:border-white/20">
                      <div className="flex items-center gap-4">
                        <div className={`h-10 w-10 rounded-xl bg-gradient-to-br ${color} flex items-center justify-center flex-shrink-0`}>
                          <span className="text-white font-bold text-sm">{label[0]}</span>
                        </div>
                        <div className="flex-1">
                          <h4 className="text-sm font-bold text-white">{label}</h4>
                          <div className="flex gap-4 mt-1">
                            <span className="text-xs text-gray-400">LTV <span className="text-white font-medium">{ltv.toFixed(0)}%</span></span>
                            <span className="text-xs text-gray-400">Liq <span className="text-yellow-400 font-medium">{liqThreshold.toFixed(0)}%</span></span>
                            <span className="text-xs text-gray-400">Penalty <span className="text-red-400 font-medium">{liqPenalty.toFixed(0)}%</span></span>
                          </div>
                        </div>
                        <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400">Live</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="card overflow-hidden">
                <h3 className="text-sm font-medium text-gray-400 mb-3">Protocol Stats</h3>
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm"><span className="text-gray-400">Total Borrows</span><span className="text-white font-medium">{fmtAmount(totalBorrows)} mUSD</span></div>
                  <div className="flex items-center justify-between text-sm"><span className="text-gray-400">Interest Rate</span><span className="text-white font-medium">{interestRate.toFixed(2)}%</span></div>
                  <div className="flex items-center justify-between text-sm"><span className="text-gray-400">Reserve Factor</span><span className="text-white font-medium">{lendingService.reserveFactorBps / 100}%</span></div>
                  <div className="flex items-center justify-between text-sm"><span className="text-gray-400">Min Borrow</span><span className="text-white font-medium">{fmtAmount(lendingService.minBorrow)} mUSD</span></div>
                  <div className="flex items-center justify-between text-sm"><span className="text-gray-400">Close Factor</span><span className="text-white font-medium">{lendingService.closeFactorBps / 100}%</span></div>
                </div>
              </div>

              <div className="card overflow-hidden">
                <h3 className="text-sm font-medium text-gray-400 mb-3">Your Assets</h3>
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm"><span className="text-gray-400">mUSD</span><span className="text-white font-medium">{fmtAmount(totalMusd)} ({tokens.length})</span></div>
                  <div className="flex items-center justify-between text-sm"><span className="text-gray-400">CTN</span><span className="text-white font-medium">{fmtAmount(totalCoin)} ({coinTokens.length})</span></div>
                  <div className="flex items-center justify-between text-sm"><span className="text-gray-400">smUSD</span><span className="text-white font-medium">{fmtAmount(totalSmusd, 4)} ({smusdTokens.length})</span></div>
                  <div className="flex items-center justify-between text-sm"><span className="text-gray-400">smUSD-E</span><span className="text-white font-medium">{fmtAmount(totalSmusdE, 4)} ({smusdETokens.length})</span></div>
                </div>
              </div>

              <div className="card overflow-hidden border-l-4 border-yellow-500">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-yellow-500/20 flex-shrink-0">
                    <svg className="h-5 w-5 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5" /></svg>
                  </div>
                  <div>
                    <h3 className="font-semibold text-white mb-1">Canton Lending \u2014 Live</h3>
                    <p className="text-sm text-gray-400">Over-collateralized lending on Canton. Deposit CTN, smUSD, or smUSD-E as collateral and borrow mUSD at {interestRate.toFixed(2)}% APR.</p>
                    <p className="text-xs text-gray-500 mt-2 font-mono">Service: {lendingService.contractId.slice(0, 24)}\u2026</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <h2 className="text-lg font-semibold text-white mb-5">How Canton Lending Works</h2>
            <div className="grid gap-4 sm:grid-cols-4">
              {[
                { step: "1", title: "Deposit Collateral", desc: "Deposit CTN, smUSD, or smUSD-E into a collateral escrow.", color: "emerald" },
                { step: "2", title: "Borrow mUSD", desc: "Borrow mUSD up to the LTV ratio of your collateral.", color: "blue" },
                { step: "3", title: "Repay Debt", desc: "Repay your mUSD debt plus accrued interest.", color: "purple" },
                { step: "4", title: "Withdraw", desc: "Reclaim your collateral once debt is cleared.", color: "yellow" },
              ].map(({ step, title, desc, color }) => (
                <div key={step} className="rounded-xl bg-surface-800/50 p-4 border border-white/5">
                  <div className={`flex h-8 w-8 items-center justify-center rounded-full bg-${color}-500/20 text-${color}-400 font-bold text-sm mb-3`}>{step}</div>
                  <h3 className="font-medium text-white mb-1">{title}</h3>
                  <p className="text-sm text-gray-400">{desc}</p>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
