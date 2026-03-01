import React, { useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { useLoopWallet } from "@/hooks/useLoopWallet";
import {
  useCantonLedger,
  cantonExercise,
  fetchFreshBalances,
  type CantonBalancesData,
  type SimpleToken,
} from "@/hooks/useCantonLedger";
import WalletConnector from "@/components/WalletConnector";
import { sanitizeCantonError } from "@/lib/canton-error";

type CantonMintAsset = "USDC" | "USDCX" | "CANTON_COIN";

function pickCoveringToken(tokens: SimpleToken[], requested: number): SimpleToken | null {
  if (tokens.length === 0) return null;
  const sorted = [...tokens].sort((a, b) => parseFloat(a.amount || "0") - parseFloat(b.amount || "0"));
  return sorted.find((t) => parseFloat(t.amount || "0") + 0.000000001 >= requested) || null;
}

async function selectTokenForAmount(
  party: string,
  templateId: string,
  splitChoice: string,
  tokensList: SimpleToken[],
  requested: number,
  getTokens: (fresh: CantonBalancesData) => SimpleToken[],
  symbol: string
): Promise<SimpleToken> {
  const covering = pickCoveringToken(tokensList, requested);
  if (!covering) {
    const largest = tokensList.reduce((max, t) => Math.max(max, parseFloat(t.amount || "0")), 0);
    throw new Error(
      largest > 0
        ? `No single ${symbol} contract covers ${requested.toFixed(2)} ${symbol}. Largest single contract: ${largest.toFixed(2)} ${symbol}. Use an amount <= ${largest.toFixed(2)} or consolidate your ${symbol} tokens first.`
        : `No ${symbol} token available.`
    );
  }
  const coveringAmt = parseFloat(covering.amount || "0");
  if (coveringAmt <= requested + 0.000000001) return covering;

  const splitResp = await cantonExercise(templateId, covering.contractId, splitChoice, { splitAmount: requested.toString() }, { party });
  if (!splitResp.success) throw new Error(splitResp.error || `Failed to split ${symbol} token.`);
  const refreshed = await fetchFreshBalances(party);
  const refreshedTokens = getTokens(refreshed);
  const exact = refreshedTokens.find((t) => Math.abs(parseFloat(t.amount || "0") - requested) < 0.000001);
  const fallback = pickCoveringToken(refreshedTokens, requested);
  const selected = exact || fallback;
  if (!selected) throw new Error(`Unable to select ${symbol} token after split.`);
  return selected;
}

export function CantonMint() {
  const loopWallet = useLoopWallet();
  const activeParty = loopWallet.partyId || null;
  const { data, loading: ledgerLoading, refresh } = useCantonLedger(15_000, activeParty);

  const [tab, setTab] = useState<"mint" | "redeem">("mint");
  const [mintAsset, setMintAsset] = useState<CantonMintAsset>("USDC");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Backend-driven data (no Loop SDK queries needed for reads)
  const directMintService = data?.directMintService || null;
  const serviceId = directMintService?.contractId || "";
  const usdcTokens = data?.usdcTokens?.filter(t => t.template !== "USDCx") || [];
  const usdcxTokens = data?.usdcTokens?.filter(t => t.template === "USDCx") || [];
  const musdTokens = data?.tokens || [];
  const cantonCoinTokens = data?.cantonCoinTokens || [];
  const totalUsdc = usdcTokens.reduce((s, t) => s + parseFloat(t.amount || "0"), 0);
  const totalUsdcx = usdcxTokens.reduce((s, t) => s + parseFloat(t.amount || "0"), 0);
  const totalMusd = data ? parseFloat(data.totalBalance || "0") : 0;
  const totalCantonCoin = data?.totalCoin ? parseFloat(data.totalCoin) : 0;

  async function handleMint() {
    if (!serviceId && mintAsset !== "CANTON_COIN") return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const parsed = parseFloat(amount);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("Enter a valid amount");
      if (!activeParty) throw new Error("Connect your Loop wallet first.");

      const fresh = await fetchFreshBalances(activeParty);
      const freshService = fresh.directMintService;
      if (!freshService && mintAsset !== "CANTON_COIN") throw new Error("Direct mint service not found on ledger.");

      if (mintAsset === "USDC") {
        const freshUsdc = (fresh.usdcTokens || []).filter(t => t.template !== "USDCx");
        const token = await selectTokenForAmount(
          fresh.party, "CantonUSDC", "CantonUSDC_Split", freshUsdc, parsed,
          (r) => (r.usdcTokens || []).filter(t => t.template !== "USDCx"), "USDC"
        );
        const resp = await cantonExercise("CantonDirectMintService", freshService!.contractId, "DirectMint_Mint", {
          user: fresh.party, usdcCid: token.contractId,
        }, { party: fresh.party });
        if (!resp.success) throw new Error(resp.error || "Mint failed");
      } else if (mintAsset === "USDCX") {
        const freshUsdcx = (fresh.usdcTokens || []).filter(t => t.template === "USDCx");
        const token = await selectTokenForAmount(
          fresh.party, "USDCx", "USDCx_Split", freshUsdcx, parsed,
          (r) => (r.usdcTokens || []).filter(t => t.template === "USDCx"), "USDCx"
        );
        const resp = await cantonExercise("CantonDirectMintService", freshService!.contractId, "DirectMint_MintWithUSDCx", {
          user: fresh.party, usdcxCid: token.contractId,
        }, { party: fresh.party });
        if (!resp.success) throw new Error(resp.error || "Mint failed");
      } else {
        const freshCoins = fresh.cantonCoinTokens || [];
        const token = await selectTokenForAmount(
          fresh.party, "CantonCoin", "CantonCoin_Split", freshCoins, parsed,
          (r) => r.cantonCoinTokens || [], "CantonCoin"
        );
        // CoinMintService — source from operator data (operator-deployed service)
        const operatorFresh = await fetchFreshBalances(null).catch(() => null);
        const coinSvc = fresh.coinMintService || operatorFresh?.coinMintService || null;
        if (!coinSvc) throw new Error("CoinMintService is not deployed on this Canton network. Contact the operator.");

        // Operator must provide USDCx backing for the coin swap
        const operatorUsdcx = (operatorFresh?.usdcTokens || []).filter(t => t.template === "USDCx");
        const largestUsdcx = operatorUsdcx.sort((a, b) => parseFloat(b.amount || "0") - parseFloat(a.amount || "0"))[0];
        if (!largestUsdcx) throw new Error("No operator USDCx backing available for CantonCoin mint. The operator must maintain a USDCx pool.");

        const resp = await cantonExercise("CoinMintService", coinSvc.contractId, "MintMusdWithCoin", {
          user: fresh.party, coinCid: token.contractId, operatorUsdcxCid: largestUsdcx.contractId,
        }, { party: fresh.party });
        if (!resp.success) throw new Error(resp.error || "Coin mint failed");
      }

      setResult(`Minted ${amount} mUSD on Canton`);
      setAmount("");
      await refresh();
    } catch (err: any) {
      const { message } = sanitizeCantonError(err.message || "");
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRedeem() {
    if (!serviceId) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const parsed = parseFloat(amount);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("Enter a valid amount");
      if (!activeParty) throw new Error("Connect your Loop wallet first.");

      const fresh = await fetchFreshBalances(activeParty);
      const freshService = fresh.directMintService;
      if (!freshService) throw new Error("Direct mint service not found on ledger.");

      const freshMusd = fresh.tokens || [];
      const token = await selectTokenForAmount(
        fresh.party, "CantonMUSD", "CantonMUSD_Split", freshMusd, parsed,
        (r) => r.tokens || [], "mUSD"
      );
      const resp = await cantonExercise("CantonDirectMintService", freshService.contractId, "DirectMint_Redeem", {
        user: fresh.party, musdCid: token.contractId,
      }, { party: fresh.party });
      if (!resp.success) throw new Error(resp.error || "Redeem failed");

      setResult(`Redeemed ${amount} mUSD for USDC on Canton`);
      setAmount("");
      await refresh();
    } catch (err: any) {
      const { message } = sanitizeCantonError(err.message || "");
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  const currentMintBalance =
    mintAsset === "USDC" ? totalUsdc : mintAsset === "USDCX" ? totalUsdcx : totalCantonCoin;
  const currentMintAssetLabel =
    mintAsset === "USDC" ? "USDC" : mintAsset === "USDCX" ? "USDCx" : "CantonCoin";
  const mintInputUnavailable =
    mintAsset === "USDC"
      ? usdcTokens.length === 0
      : mintAsset === "USDCX"
        ? usdcxTokens.length === 0
        : cantonCoinTokens.length === 0;

  if (!activeParty) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="max-w-md space-y-6">
          <div className="card-emerald p-8 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/10">
              <svg className="h-8 w-8 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
              </svg>
            </div>
            <h3 className="mb-2 text-xl font-semibold text-white">Connect to Canton</h3>
            <p className="text-gray-400 mb-6">Connect your Loop Wallet to mint or redeem mUSD on the Canton Network.</p>
          </div>
          <WalletConnector mode="canton" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <PageHeader
        title="Mint & Redeem"
        subtitle="Mint with USDC, USDCx, or CantonCoin and redeem mUSD on Canton"
        badge="Canton"
        badgeColor="emerald"
      />

      <div className="card-emerald overflow-hidden">
        {/* Tabs */}
        <div className="flex border-b border-emerald-500/20">
          <button
            className={`relative flex-1 px-6 py-4 text-center text-sm font-semibold transition-all duration-300 ${
              tab === "mint" 
                ? "text-emerald-400" 
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
              <span className="absolute bottom-0 left-1/2 h-0.5 w-24 -translate-x-1/2 rounded-full bg-gradient-to-r from-emerald-500 to-cyan-500" />
            )}
          </button>
          <button
            className={`relative flex-1 px-6 py-4 text-center text-sm font-semibold transition-all duration-300 ${
              tab === "redeem" 
                ? "text-emerald-400" 
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
              <span className="absolute bottom-0 left-1/2 h-0.5 w-24 -translate-x-1/2 rounded-full bg-gradient-to-r from-emerald-500 to-cyan-500" />
            )}
          </button>
        </div>

        <div className="space-y-6 p-6">
          {/* Amount Input */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="label">Amount</label>
              <span className="text-xs text-gray-500">
                Balance: {(tab === "mint" ? currentMintBalance : totalMusd).toFixed(2)} {tab === "mint" ? currentMintAssetLabel : "mUSD"}
              </span>
            </div>
            {tab === "mint" && (
              <div className="grid gap-2">
                <label className="text-xs font-medium uppercase tracking-wider text-gray-500">Mint Asset</label>
                <select
                  className="input"
                  value={mintAsset}
                  onChange={(e) => setMintAsset(e.target.value as CantonMintAsset)}
                >
                  <option value="USDC">USDC</option>
                  <option value="USDCX">USDCx</option>
                  <option value="CANTON_COIN">Canton Coin</option>
                </select>
              </div>
            )}
            <div className="relative rounded-xl border border-white/10 bg-surface-800/50 p-4 transition-all duration-300 focus-within:border-emerald-500/50 focus-within:shadow-[0_0_20px_-5px_rgba(16,185,129,0.3)]">
              <div className="flex items-center gap-4">
                <input
                  type="number"
                  className="flex-1 bg-transparent text-2xl font-semibold text-white placeholder-gray-600 focus:outline-none"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <button
                  className="rounded-lg bg-emerald-500/20 px-3 py-1.5 text-xs font-semibold text-emerald-400 hover:bg-emerald-500/30"
                  onClick={() => setAmount((tab === "mint" ? currentMintBalance : totalMusd).toString())}
                >
                  MAX
                </button>
                <span className="font-semibold text-white">{tab === "mint" ? currentMintAssetLabel : "mUSD"}</span>
              </div>
            </div>
          </div>

          {/* Info Box */}
          <div className="space-y-2 rounded-xl bg-surface-800/30 p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-400">Mint Service</span>
              <span className="font-mono text-xs text-emerald-400">
                {serviceId ? `${serviceId.slice(0, 24)}...` : ledgerLoading ? "Loading…" : "Not deployed on this participant"}
              </span>
            </div>
            <div className="divider my-2" />
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-400">Pattern</span>
              <span className="text-gray-300">
                {tab === "mint"
                  ? "1:1 USDC → mUSD (Daml Ledger)"
                  : "Burn mUSD → RedemptionRequest (Canton USDC payout)"}
              </span>
            </div>
            <div className="divider my-2" />
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-400">Token Selection</span>
              <span className="text-gray-300">
                Auto-select from {tab === "mint"
                  ? (mintAsset === "USDC" ? usdcTokens.length : mintAsset === "USDCX" ? usdcxTokens.length : cantonCoinTokens.length)
                  : musdTokens.length} contracts
              </span>
            </div>
            {tab === "mint" && mintAsset === "CANTON_COIN" && !data?.coinMintService && (
              <>
                <div className="divider my-2" />
                <p className="text-xs text-amber-300">
                  CantonCoin minting requires an active `CoinMintService` on this Canton network.
                </p>
              </>
            )}
            {tab === "redeem" && (
              <>
                <div className="divider my-2" />
                <p className="text-xs text-amber-300">
                  This action creates a Canton redemption request. It does not send funds directly to an Ethereum wallet.
                </p>
              </>
            )}
          </div>

          {/* Action Button */}
          <button
            onClick={tab === "mint" ? handleMint : handleRedeem}
            disabled={loading || !amount || parseFloat(amount) <= 0 || (tab === "mint" && mintInputUnavailable)}
            className="btn-success w-full flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Processing on Canton...
              </>
            ) : (
              <>
                {tab === "mint" ? (
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                  </svg>
                ) : (
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                )}
                {tab === "mint"
                  ? `Mint mUSD with ${currentMintAssetLabel}`
                  : "Redeem USDC"}
              </>
            )}
          </button>

          {tab === "mint" && mintInputUnavailable && (
            <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-200">
              {mintAsset === "USDC"
                ? "No Canton USDC contracts found for this wallet."
                : mintAsset === "USDCX"
                  ? "No USDCx contracts found for this wallet."
                  : "CantonCoin mint requires both CoinMintService and visible operator USDCx backing."}
            </div>
          )}

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
  );
}
