import React, { useState, useEffect, useCallback } from "react";
import { StatCard } from "@/components/StatCard";
import { PageHeader } from "@/components/PageHeader";
import { useLoopWallet, LoopContract } from "@/hooks/useLoopWallet";
import WalletConnector from "@/components/WalletConnector";

const PACKAGE_ID = process.env.NEXT_PUBLIC_DAML_PACKAGE_ID || "";
type CantonMintAsset = "USDC" | "USDCX" | "CANTON_COIN";

const templateCandidates = {
  DirectMintService: [
    `${PACKAGE_ID}:CantonDirectMint:CantonDirectMintService`,
    `${PACKAGE_ID}:MintedProtocolV2Fixed:DirectMintService`,
  ],
  USDC: [
    `${PACKAGE_ID}:CantonDirectMint:CantonUSDC`,
    `${PACKAGE_ID}:MintedProtocolV2Fixed:USDC`,
  ],
  USDCx: [
    `${PACKAGE_ID}:CantonDirectMint:USDCx`,
  ],
  MUSD: [
    `${PACKAGE_ID}:CantonDirectMint:CantonMUSD`,
    `${PACKAGE_ID}:MintedProtocolV2Fixed:MUSD`,
  ],
  CantonCoin: [
    `${PACKAGE_ID}:CantonCoinToken:CantonCoin`,
  ],
  CoinMintService: [
    `${PACKAGE_ID}:CantonCoinMint:CoinMintService`,
  ],
};

export function CantonMint() {
  const loopWallet = useLoopWallet();
  
  const [tab, setTab] = useState<"mint" | "redeem">("mint");
  const [mintAsset, setMintAsset] = useState<CantonMintAsset>("USDC");
  const [amount, setAmount] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Stats
  const [services, setServices] = useState<LoopContract[]>([]);
  const [usdcContracts, setUsdcContracts] = useState<LoopContract[]>([]);
  const [usdcxContracts, setUsdcxContracts] = useState<LoopContract[]>([]);
  const [musdContracts, setMusdContracts] = useState<LoopContract[]>([]);
  const [cantonCoinContracts, setCantonCoinContracts] = useState<LoopContract[]>([]);
  const [coinMintServices, setCoinMintServices] = useState<LoopContract[]>([]);

  const queryWithCandidates = useCallback(async (candidates: string[]): Promise<LoopContract[]> => {
    const merged = new Map<string, LoopContract>();

    for (const templateId of candidates) {
      if (!templateId) continue;
      try {
        const contracts = await loopWallet.queryContracts(templateId);
        contracts.forEach((c) => merged.set(c.contractId, c));
      } catch {
        // Ignore missing template versions and continue to the next candidate.
      }
    }

    return Array.from(merged.values());
  }, [loopWallet]);

  const findServiceContract = useCallback((id: string) => {
    return services.find((svc) => svc.contractId === id) ?? null;
  }, [services]);

  const loadContracts = useCallback(async () => {
    if (!loopWallet.isConnected) return;
    try {
      const [svc, usdc, usdcx, musd, ctn, coinMint] = await Promise.all([
        queryWithCandidates(templateCandidates.DirectMintService),
        queryWithCandidates(templateCandidates.USDC),
        queryWithCandidates(templateCandidates.USDCx),
        queryWithCandidates(templateCandidates.MUSD),
        queryWithCandidates(templateCandidates.CantonCoin),
        queryWithCandidates(templateCandidates.CoinMintService),
      ]);

      setServices(svc);
      setUsdcContracts(usdc);
      setUsdcxContracts(usdcx);
      setMusdContracts(musd);
      setCantonCoinContracts(ctn);
      setCoinMintServices(coinMint);
      setServiceId(svc.length > 0 ? svc[0].contractId : "");
    } catch (err) {
      console.error("Failed to load contracts:", err);
    }
  }, [loopWallet.isConnected, queryWithCandidates]);

  useEffect(() => {
    loadContracts();
  }, [loadContracts]);

  const totalUsdc = usdcContracts.reduce(
    (sum, c) => sum + parseFloat(c.payload?.amount || "0"), 0
  );
  const totalUsdcx = usdcxContracts.reduce(
    (sum, c) => sum + parseFloat(c.payload?.amount || "0"), 0
  );
  const totalMusd = musdContracts.reduce(
    (sum, c) => sum + parseFloat(c.payload?.amount || "0"), 0
  );
  const totalCantonCoin = cantonCoinContracts.reduce(
    (sum, c) => sum + parseFloat(c.payload?.amount || "0"), 0
  );

  function pickContractForAmount(contracts: LoopContract[], requestedAmount: number): string {
    const eligible = contracts
      .map((contract) => ({ contractId: contract.contractId, amount: parseFloat(contract.payload?.amount || "0") }))
      .filter((entry) => Number.isFinite(entry.amount) && entry.amount > 0)
      .sort((a, b) => b.amount - a.amount);

    if (eligible.length === 0) {
      return "";
    }

    const withEnough = eligible.find((entry) => entry.amount >= requestedAmount);
    return withEnough ? withEnough.contractId : "";
  }

  async function exerciseWithArgFallback(
    templateId: string,
    contractId: string,
    choice: string,
    argsCandidates: Array<Record<string, any>>
  ) {
    let lastError: any = null;
    for (const args of argsCandidates) {
      try {
        return await loopWallet.exerciseChoice(templateId, contractId, choice, args);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError ?? new Error(`Failed to exercise ${choice}`);
  }

  async function handleMint() {
    if (!serviceId && mintAsset !== "CANTON_COIN") return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const parsed = parseFloat(amount);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("Enter a valid amount");
      }

      if (mintAsset === "USDC") {
        const selectedUsdcContractId = pickContractForAmount(usdcContracts, parsed);
        if (!selectedUsdcContractId) {
          throw new Error("No single USDC token has enough balance for this amount");
        }

        const service = findServiceContract(serviceId);
        if (!service) throw new Error("Direct mint service unavailable");

        await exerciseWithArgFallback(
          service.templateId,
          service.contractId,
          "DirectMint_Mint",
          [
            { usdcCid: selectedUsdcContractId, amount },
            { user: loopWallet.partyId, usdcCid: selectedUsdcContractId },
            { usdcCid: selectedUsdcContractId },
          ]
        );
      } else if (mintAsset === "USDCX") {
        const selectedUsdcxContractId = pickContractForAmount(usdcxContracts, parsed);
        if (!selectedUsdcxContractId) {
          throw new Error("No single USDCx token has enough balance for this amount");
        }

        const service = findServiceContract(serviceId);
        if (!service) throw new Error("Direct mint service unavailable");

        await exerciseWithArgFallback(
          service.templateId,
          service.contractId,
          "DirectMint_MintWithUSDCx",
          [
            { usdcxCid: selectedUsdcxContractId, amount },
            { user: loopWallet.partyId, usdcxCid: selectedUsdcxContractId },
            { usdcxCid: selectedUsdcxContractId },
          ]
        );
      } else {
        const selectedCoinContractId = pickContractForAmount(cantonCoinContracts, parsed);
        if (!selectedCoinContractId) {
          throw new Error("No single CantonCoin token has enough balance for this amount");
        }
        const coinService = coinMintServices[0];
        if (!coinService) {
          throw new Error("CantonCoin minting service is not configured on this network");
        }

        // CoinMintService requires an operator-owned USDCx contract as bridge backing.
        const operatorUsdcx = usdcxContracts.find(
          (c) => (c.payload?.owner || "") !== (loopWallet.partyId || "")
        );
        if (!operatorUsdcx) {
          throw new Error("Operator USDCx backing is not visible for CantonCoin minting");
        }

        await loopWallet.exerciseChoice(
          coinService.templateId,
          coinService.contractId,
          "MintMusdWithCoin",
          {
            user: loopWallet.partyId,
            coinCid: selectedCoinContractId,
            operatorUsdcxCid: operatorUsdcx.contractId,
          }
        );
      }

      setResult(`Minted ${amount} mUSD on Canton`);
      setAmount("");
      await loadContracts(); // Refresh
    } catch (err: any) {
      setError(err.message);
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
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("Enter a valid amount");
      }
      const selectedMusdContractId = pickContractForAmount(musdContracts, parsed);
      if (!selectedMusdContractId) {
        throw new Error("No single mUSD token has enough balance for this amount");
      }
      const service = findServiceContract(serviceId);
      if (!service) throw new Error("Direct mint service unavailable");

      await exerciseWithArgFallback(
        service.templateId,
        service.contractId,
        "DirectMint_Redeem",
        [
          { musdCid: selectedMusdContractId, amount },
          { user: loopWallet.partyId, musdCid: selectedMusdContractId },
          { musdCid: selectedMusdContractId },
        ]
      );
      setResult(`Redeemed ${amount} mUSD for USDC on Canton`);
      setAmount("");
      await loadContracts(); // Refresh
    } catch (err: any) {
      setError(err.message);
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
      ? usdcContracts.length === 0
      : mintAsset === "USDCX"
        ? usdcxContracts.length === 0
        : cantonCoinContracts.length === 0 || coinMintServices.length === 0;

  if (!loopWallet.isConnected) {
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

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard 
          label="Your USDC (Canton)" 
          value={totalUsdc.toFixed(2)} 
          color="blue"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
        <StatCard 
          label="Your USDCx (Canton)" 
          value={totalUsdcx.toFixed(2)} 
          color="purple"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 8h10M7 12h10M7 16h6" />
            </svg>
          }
        />
        <StatCard 
          label="Your CantonCoin" 
          value={totalCantonCoin.toFixed(2)} 
          color="yellow"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4l7 4v8l-7 4-7-4V8l7-4z" />
            </svg>
          }
        />
        <StatCard 
          label="Your mUSD (Canton)" 
          value={totalMusd.toFixed(2)}
          color="green"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
            </svg>
          }
        />
      </div>

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
                {serviceId ? `${serviceId.slice(0, 24)}...` : "No service found"}
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
                  ? (mintAsset === "USDC" ? usdcContracts.length : mintAsset === "USDCX" ? usdcxContracts.length : cantonCoinContracts.length)
                  : musdContracts.length} contracts
              </span>
            </div>
            {tab === "mint" && mintAsset === "CANTON_COIN" && coinMintServices.length === 0 && (
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
