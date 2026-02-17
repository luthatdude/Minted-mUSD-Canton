import React, { useState, useEffect, useCallback, useMemo } from "react";
import { StatCard } from "@/components/StatCard";
import LeverageSlider from "@/components/LeverageSlider";
import { useLoopWallet, LoopContract } from "@/hooks/useLoopWallet";
import WalletConnector from "@/components/WalletConnector";

// ---------------------------------------------------------------------------
//  DAML template IDs — CantonLoopStrategy module
// ---------------------------------------------------------------------------
const PACKAGE_ID = process.env.NEXT_PUBLIC_DAML_PACKAGE_ID || "your-package-id";
const LOOP_SERVICE_TEMPLATE  = `${PACKAGE_ID}:CantonLoopStrategy:CantonLoopStrategyService`;
const LOOP_REQUEST_TEMPLATE  = `${PACKAGE_ID}:CantonLoopStrategy:CantonLoopRequest`;
const LOOP_POSITION_TEMPLATE = `${PACKAGE_ID}:CantonLoopStrategy:CantonLoopPosition`;
const LOOP_CONFIG_TEMPLATE   = `${PACKAGE_ID}:CantonLoopStrategy:CantonLoopStrategyConfig`;
const USDC_TEMPLATE   = `${PACKAGE_ID}:CantonDirectMint:CantonUSDC`;
const USDCX_TEMPLATE  = `${PACKAGE_ID}:CantonDirectMint:USDCx`;
const CTN_TEMPLATE     = `${PACKAGE_ID}:CantonCoinToken:CantonCoin`;

// ---------------------------------------------------------------------------
//  Collateral type config  (mirrors DAML LoopDepositType)
// ---------------------------------------------------------------------------
type DepositType = "LoopDeposit_USDC" | "LoopDeposit_USDCx" | "LoopDeposit_CTN";

interface CollateralOption {
  depositType: DepositType;
  label: string;
  symbol: string;
  icon: string;
  templateId: string;
  ltvBps: number;        // target LTV in bps (from LoopConfig)
  maxLeverageX10: number; // hard UI cap: slider max = f(LTV, maxLoops)
}

/** Geometric leverage for N loops at a given LTV ratio */
function calcLeverage(ltv: number, loops: number): number {
  if (loops <= 1) return 1;
  let acc = 1;
  let power = 1;
  for (let i = 1; i < loops; i++) {
    power *= ltv;
    acc += power;
  }
  return acc;
}

/** Inverse: how many loops to reach a target leverage */
function loopsForLeverage(ltv: number, target: number, maxLoops: number): number {
  for (let n = 1; n <= maxLoops; n++) {
    if (calcLeverage(ltv, n) >= target) return n;
  }
  return maxLoops;
}

// ---------------------------------------------------------------------------
//  Component
// ---------------------------------------------------------------------------
export function CantonLeverage() {
  const loopWallet = useLoopWallet();

  // ---- form state ----
  const [depositType, setDepositType] = useState<DepositType>("LoopDeposit_USDC");
  const [depositAmount, setDepositAmount] = useState("");
  const [leverageX10, setLeverageX10] = useState(20); // 2.0x
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ---- on-ledger contracts ----
  const [usdcTokens, setUsdcTokens]   = useState<LoopContract[]>([]);
  const [usdcxTokens, setUsdcxTokens] = useState<LoopContract[]>([]);
  const [ctnTokens, setCtnTokens]     = useState<LoopContract[]>([]);
  const [positions, setPositions]      = useState<LoopContract[]>([]);
  const [serviceCid, setServiceCid]    = useState<string | null>(null);
  const [configCid, setConfigCid]      = useState<string | null>(null);
  const [loopConfig, setLoopConfig]    = useState<{ maxLoops: number; targetLtvBps: number; ctnTargetLtvBps: number; minHealthFactorBps: number } | null>(null);

  // ---- collateral options (derived from on-chain config) ----
  const collateralOptions: CollateralOption[] = useMemo(() => {
    const maxLoops = loopConfig?.maxLoops ?? 5;
    const stableLtv = loopConfig?.targetLtvBps ?? 9000;
    const ctnLtv = loopConfig?.ctnTargetLtvBps ?? 6000;
    const stableMaxLev = Math.floor(calcLeverage(stableLtv / 10000, maxLoops) * 10);
    const ctnMaxLev = Math.floor(calcLeverage(ctnLtv / 10000, maxLoops) * 10);
    return [
      { depositType: "LoopDeposit_USDC",  label: "USDC",       symbol: "USDC",  icon: "💵", templateId: USDC_TEMPLATE,  ltvBps: stableLtv, maxLeverageX10: stableMaxLev },
      { depositType: "LoopDeposit_USDCx", label: "USDCx (Bridged)", symbol: "USDCx", icon: "🌉", templateId: USDCX_TEMPLATE, ltvBps: stableLtv, maxLeverageX10: stableMaxLev },
      { depositType: "LoopDeposit_CTN",   label: "CantonCoin",  symbol: "CTN",   icon: "🪙", templateId: CTN_TEMPLATE,   ltvBps: ctnLtv,    maxLeverageX10: ctnMaxLev },
    ];
  }, [loopConfig]);

  const selectedOption = collateralOptions.find(o => o.depositType === depositType)!;

  // ---- available tokens for the selected deposit type ----
  const tokensForType = useMemo(() => {
    switch (depositType) {
      case "LoopDeposit_USDC":  return usdcTokens;
      case "LoopDeposit_USDCx": return usdcxTokens;
      case "LoopDeposit_CTN":   return ctnTokens;
    }
  }, [depositType, usdcTokens, usdcxTokens, ctnTokens]);

  const [selectedTokenCid, setSelectedTokenCid] = useState("");

  // auto-select first token when type changes
  useEffect(() => {
    setSelectedTokenCid(tokensForType[0]?.contractId ?? "");
    setDepositAmount(tokensForType[0]?.payload?.amount?.toString() ?? "");
  }, [tokensForType]);

  // clamp leverage when switching collateral type
  useEffect(() => {
    if (leverageX10 > selectedOption.maxLeverageX10) {
      setLeverageX10(selectedOption.maxLeverageX10);
    }
  }, [selectedOption.maxLeverageX10]);

  // ---- load ledger data ----
  const loadContracts = useCallback(async () => {
    if (!loopWallet.isConnected) return;
    try {
      const [usdc, usdcx, ctn, pos, svc, cfg] = await Promise.all([
        loopWallet.queryContracts(USDC_TEMPLATE),
        loopWallet.queryContracts(USDCX_TEMPLATE),
        loopWallet.queryContracts(CTN_TEMPLATE),
        loopWallet.queryContracts(LOOP_POSITION_TEMPLATE),
        loopWallet.queryContracts(LOOP_SERVICE_TEMPLATE),
        loopWallet.queryContracts(LOOP_CONFIG_TEMPLATE),
      ]);
      setUsdcTokens(usdc.filter(t => t.payload.owner === loopWallet.partyId));
      setUsdcxTokens(usdcx.filter(t => t.payload.owner === loopWallet.partyId));
      setCtnTokens(ctn.filter(t => t.payload.owner === loopWallet.partyId));
      setPositions(pos.filter(p => p.payload.user === loopWallet.partyId));
      if (svc.length > 0) setServiceCid(svc[0].contractId);
      if (cfg.length > 0) {
        setConfigCid(cfg[0].contractId);
        setLoopConfig(cfg[0].payload.config);
      }
    } catch (err: any) {
      console.error("Failed to load contracts:", err);
      setError(err.message);
    }
  }, [loopWallet.isConnected, loopWallet.partyId, loopWallet.queryContracts]);

  useEffect(() => { loadContracts(); }, [loadContracts]);

  // ---- derived estimates ----
  const ltv = selectedOption.ltvBps / 10000;
  const maxLoops = loopConfig?.maxLoops ?? 5;
  const estimatedLoops = loopsForLeverage(ltv, leverageX10 / 10, maxLoops);
  const effectiveLeverage = calcLeverage(ltv, estimatedLoops);
  const totalStaked = parseFloat(depositAmount || "0") * effectiveLeverage;
  const totalBorrowed = totalStaked - parseFloat(depositAmount || "0");
  const healthFactor = totalBorrowed > 0
    ? (totalStaked * (selectedOption.ltvBps + 300) / 10000) / totalBorrowed
    : 999;

  // ---- one-click loop ----
  async function handleLoop() {
    if (!serviceCid || !configCid || !selectedTokenCid) {
      setError("Missing service or token. Refresh and try again.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      // Exercise Loop_Open on the service — creates position directly
      await loopWallet.exerciseChoice(
        LOOP_SERVICE_TEMPLATE,
        serviceCid,
        "Loop_Open",
        {
          user: loopWallet.partyId,
          depositAmount: parseFloat(depositAmount),
          depositType,
          requestedLoops: estimatedLoops,
          loopConfigCid: configCid,
        }
      );

      setResult(
        `Opened ${effectiveLeverage.toFixed(1)}x ${selectedOption.symbol} loop with ${estimatedLoops} loops`
      );
      setDepositAmount("");
      await loadContracts();
    } catch (err: any) {
      setError(err.message || "Failed to open loop position");
    } finally {
      setLoading(false);
    }
  }

  // ---- unwind ----
  async function handleUnwind(positionCid: string) {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      await loopWallet.exerciseChoice(
        LOOP_POSITION_TEMPLATE,
        positionCid,
        "LoopPosition_Unwind",
        {}
      );
      setResult("Unwind initiated — operator will finalize shortly.");
      await loadContracts();
    } catch (err: any) {
      setError(err.message || "Failed to unwind");
    } finally {
      setLoading(false);
    }
  }

  // ---- not connected ----
  if (!loopWallet.isConnected) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold text-white">sMUSD Maxi Loop</h1>
        <p className="text-emerald-400 text-sm font-medium">Canton Network · Leveraged sMUSD Strategy</p>
        <div className="max-w-md mx-auto"><WalletConnector mode="canton" /></div>
        <div className="text-center text-gray-400 py-8">Connect your Loop Wallet to start</div>
      </div>
    );
  }

  // ---- total balances ----
  const totalUsdc  = usdcTokens.reduce((s, t) => s + (t.payload.amount ?? 0), 0);
  const totalUsdcx = usdcxTokens.reduce((s, t) => s + (t.payload.amount ?? 0), 0);
  const totalCtn   = ctnTokens.reduce((s, t) => s + (t.payload.amount ?? 0), 0);

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-white">sMUSD Maxi Loop</h1>
      <p className="text-emerald-400 text-sm font-medium">Canton Network · Leveraged sMUSD Strategy</p>

      {/* Wallet balances */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard label="USDC Balance"  value={totalUsdc.toFixed(2)}  subValue="USDC" />
        <StatCard label="USDCx Balance" value={totalUsdcx.toFixed(2)} subValue="USDCx" />
        <StatCard label="CTN Balance"   value={totalCtn.toFixed(2)}   subValue="CTN" />
        <StatCard label="Active Positions" value={positions.length.toString()} />
      </div>

      {/* ================================================================ */}
      {/*  OPEN POSITION — collateral dropdown + leverage slider + button  */}
      {/* ================================================================ */}
      <div className="bg-gray-900 rounded-2xl p-6 border border-gray-800">
        <h2 className="text-xl font-semibold text-white mb-6">Open Leveraged Loop</h2>

        {/* ---- 1. Collateral Type Dropdown ---- */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-400 mb-2">
            Collateral Asset
          </label>
          <div className="relative">
            <select
              value={depositType}
              onChange={(e) => setDepositType(e.target.value as DepositType)}
              className="w-full bg-gray-800 text-white rounded-xl px-4 py-3 pr-10 border border-gray-700 
                focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 outline-none appearance-none"
            >
              {collateralOptions.map((opt) => (
                <option key={opt.depositType} value={opt.depositType}>
                  {opt.icon}  {opt.label}  —  Target LTV {(opt.ltvBps / 100).toFixed(0)}%  ·  Max {(opt.maxLeverageX10 / 10).toFixed(1)}x
                </option>
              ))}
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-gray-400">
              ▾
            </div>
          </div>

          {/* Per-type info pill */}
          <div className={`mt-2 inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium
            ${depositType === "LoopDeposit_CTN"
              ? "bg-amber-900/40 text-amber-300 border border-amber-700"
              : "bg-emerald-900/40 text-emerald-300 border border-emerald-700"}`}
          >
            {depositType === "LoopDeposit_CTN"
              ? "⚠ Volatile asset — 60% LTV, lower max leverage"
              : "✓ Stablecoin — 90% LTV, up to ~4.1x leverage"}
          </div>
        </div>

        {/* ---- Token + Amount ---- */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-400 mb-2">
            Token to Deposit
          </label>
          {tokensForType.length > 0 ? (
            <div className="flex gap-3">
              <select
                value={selectedTokenCid}
                onChange={(e) => {
                  setSelectedTokenCid(e.target.value);
                  const tok = tokensForType.find(t => t.contractId === e.target.value);
                  setDepositAmount(tok?.payload?.amount?.toString() ?? "");
                }}
                className="flex-1 bg-gray-800 text-white rounded-xl px-4 py-3 border border-gray-700 
                  focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 outline-none"
              >
                {tokensForType.map((t) => (
                  <option key={t.contractId} value={t.contractId}>
                    {selectedOption.symbol}: {t.payload.amount?.toFixed(4)}
                  </option>
                ))}
              </select>
              <input
                type="number"
                placeholder="Amount"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                className="w-36 bg-gray-800 text-white rounded-xl px-4 py-3 border border-gray-700 
                  focus:border-emerald-500 outline-none text-right"
              />
            </div>
          ) : (
            <div className="bg-gray-800 rounded-xl px-4 py-3 text-gray-500 border border-gray-700">
              No {selectedOption.symbol} tokens available — mint or bridge first
            </div>
          )}
        </div>

        {/* ---- 2. Leverage Slider ---- */}
        <div className="mb-6">
          <LeverageSlider
            value={leverageX10}
            onChange={setLeverageX10}
            maxLeverage={selectedOption.maxLeverageX10}
            disabled={loading}
          />
        </div>

        {/* ---- Position Preview ---- */}
        <div className="bg-gray-800 rounded-xl p-4 mb-6">
          <h4 className="text-sm font-medium text-gray-400 mb-3">Position Preview</h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-gray-500">Collateral</span>
              <p className="text-white font-medium">{selectedOption.symbol}</p>
            </div>
            <div>
              <span className="text-gray-500">Effective Leverage</span>
              <p className="text-white font-medium">{effectiveLeverage.toFixed(2)}x</p>
            </div>
            <div>
              <span className="text-gray-500">Loops</span>
              <p className="text-white font-medium">{estimatedLoops} / {maxLoops}</p>
            </div>
            <div>
              <span className="text-gray-500">Target LTV</span>
              <p className="text-white font-medium">{(selectedOption.ltvBps / 100).toFixed(0)}%</p>
            </div>
            <div>
              <span className="text-gray-500">Total Staked (est.)</span>
              <p className="text-emerald-400 font-medium">{totalStaked.toFixed(2)} mUSD</p>
            </div>
            <div>
              <span className="text-gray-500">Total Borrowed (est.)</span>
              <p className="text-yellow-400 font-medium">{totalBorrowed.toFixed(2)} mUSD</p>
            </div>
            <div>
              <span className="text-gray-500">Health Factor</span>
              <p className={`font-medium ${healthFactor > 1.5 ? 'text-green-400' : healthFactor > 1.2 ? 'text-yellow-400' : 'text-red-400'}`}>
                {healthFactor >= 999 ? "∞" : healthFactor.toFixed(2)}
              </p>
            </div>
            <div>
              <span className="text-gray-500">Liquidation Risk</span>
              <p className={`font-medium ${leverageX10 > selectedOption.maxLeverageX10 * 0.8 ? 'text-red-400' : leverageX10 > selectedOption.maxLeverageX10 * 0.5 ? 'text-yellow-400' : 'text-green-400'}`}>
                {leverageX10 > selectedOption.maxLeverageX10 * 0.8 ? 'High' : leverageX10 > selectedOption.maxLeverageX10 * 0.5 ? 'Medium' : 'Low'}
              </p>
            </div>
          </div>
        </div>

        {/* ---- 3. One-Click Loop Button ---- */}
        <button
          onClick={handleLoop}
          disabled={loading || !selectedTokenCid || !depositAmount || parseFloat(depositAmount) <= 0}
          className={`w-full py-4 rounded-xl font-semibold text-lg transition-all
            ${loading || !selectedTokenCid
              ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
              : 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white shadow-lg shadow-emerald-900/30'
            }`}
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Opening Loop...
            </span>
          ) : (
            `🔄 Loop ${effectiveLeverage.toFixed(1)}x ${selectedOption.symbol} → sMUSD`
          )}
        </button>
      </div>

      {/* ================================================================ */}
      {/*  ACTIVE POSITIONS                                                */}
      {/* ================================================================ */}
      {positions.length > 0 && (
        <div className="bg-gray-900 rounded-2xl p-6 border border-gray-800">
          <h2 className="text-xl font-semibold text-white mb-4">Your Positions</h2>
          <div className="space-y-4">
            {positions.map((pos) => {
              const p = pos.payload;
              const depTypeLabel =
                p.depositType === "LoopDeposit_USDC" ? "USDC" :
                p.depositType === "LoopDeposit_USDCx" ? "USDCx" : "CTN";
              const posHF = p.totalBorrowed > 0
                ? ((p.totalStaked * 0.93) / p.totalBorrowed).toFixed(2)
                : "∞";

              return (
                <div key={pos.contractId} className="bg-gray-800 rounded-xl p-4 flex flex-col md:flex-row md:items-center gap-4">
                  <div className="flex-1 grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
                    <div>
                      <span className="text-gray-500">Asset</span>
                      <p className="text-white font-medium">{depTypeLabel}</p>
                    </div>
                    <div>
                      <span className="text-gray-500">Deposited</span>
                      <p className="text-white font-medium">{p.totalDeposited?.toFixed(2)}</p>
                    </div>
                    <div>
                      <span className="text-gray-500">Leverage</span>
                      <p className="text-emerald-400 font-medium">{p.leverageMultiplier?.toFixed(1)}x</p>
                    </div>
                    <div>
                      <span className="text-gray-500">Health Factor</span>
                      <p className={`font-medium ${parseFloat(posHF) > 1.3 ? 'text-green-400' : 'text-red-400'}`}>{posHF}</p>
                    </div>
                    <div>
                      <span className="text-gray-500">Status</span>
                      <p className={`font-medium ${p.status === 'active' ? 'text-emerald-400' : 'text-yellow-400'}`}>
                        {p.status}
                      </p>
                    </div>
                  </div>
                  {p.status === "active" && (
                    <button
                      onClick={() => handleUnwind(pos.contractId)}
                      disabled={loading}
                      className="px-6 py-2 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-500 text-white transition-colors disabled:opacity-50"
                    >
                      Unwind
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Result / Error feedback */}
      {result && (
        <div className="bg-emerald-900/30 border border-emerald-700 rounded-xl p-4 text-emerald-300">
          ✓ {result}
        </div>
      )}
      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-xl p-4 text-red-300">
          ✕ {error}
        </div>
      )}
    </div>
  );
}

export default CantonLeverage;
