import React, { useState, useEffect } from "react";
import { ethers } from "ethers";
import { TxButton } from "@/components/TxButton";
import { StatCard } from "@/components/StatCard";
import { useTx } from "@/hooks/useTx";
import { formatUSD, formatBps, formatToken } from "@/lib/format";
import { USDC_DECIMALS, MUSD_DECIMALS, CONTRACTS } from "@/lib/config";
import { useWalletConnect } from "@/hooks/useWalletConnect";
import { useWCContracts } from "@/hooks/useWCContracts";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import WalletConnector from "@/components/WalletConnector";

type AdminSection = "musd" | "directmint" | "treasury" | "bridge" | "borrow" | "oracle" | "pendle" | "morpho" | "yield";

export function AdminPage() {
  const { address, isConnected } = useWalletConnect();
  const contracts = useWCContracts();
  const { isAdmin, isLoading: isAdminLoading } = useIsAdmin();
  const [section, setSection] = useState<AdminSection>("musd");
  const tx = useTx();

  // H-08: Role gate — only render admin controls if wallet has admin/timelock role
  if (!isConnected) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <h2 className="text-xl font-semibold text-gray-300">Admin Panel</h2>
        <p className="text-gray-400">Connect your wallet to access admin functions.</p>
        <WalletConnector />
      </div>
    );
  }

  if (isAdminLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <p className="text-gray-400">Verifying admin role…</p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <h2 className="text-xl font-semibold text-red-400">Access Denied</h2>
        <p className="text-gray-400">
          Connected wallet <span className="font-mono text-sm">{address}</span> does not
          hold an admin role on this protocol.
        </p>
        <p className="text-gray-500 text-sm">
          Required: DEFAULT_ADMIN_ROLE or TIMELOCK_ROLE on the MUSD contract.
        </p>
      </div>
    );
  }

  // MUSD Admin
  const [newSupplyCap, setNewSupplyCap] = useState("");
  const [blacklistAddr, setBlacklistAddr] = useState("");
  const [blacklistStatus, setBlacklistStatus] = useState(true);

  // DirectMint Admin
  const [mintFeeBps, setMintFeeBps] = useState("");
  const [redeemFeeBps, setRedeemFeeBps] = useState("");
  const [newFeeRecipient, setNewFeeRecipient] = useState("");
  const [minMint, setMinMint] = useState("");
  const [maxMint, setMaxMint] = useState("");
  const [minRedeem, setMinRedeem] = useState("");
  const [maxRedeem, setMaxRedeem] = useState("");

  // Treasury Admin
  const [strategyAddr, setStrategyAddr] = useState("");
  const [targetBps, setTargetBps] = useState("");
  const [minBps, setMinBps] = useState("");
  const [maxBps, setMaxBps] = useState("");
  const [reserveBps, setReserveBps] = useState("");

  // Treasury strategy deployment state
  interface StrategyInfo {
    address: string;
    targetBps: number;
    minBps: number;
    maxBps: number;
    active: boolean;
    autoAllocate: boolean;
    currentValue: bigint;
    currentBps: number;
  }
  const [registeredStrategies, setRegisteredStrategies] = useState<StrategyInfo[]>([]);
  const [strategyDeployAmounts, setStrategyDeployAmounts] = useState<Record<string, string>>({});
  const [strategyWithdrawAmounts, setStrategyWithdrawAmounts] = useState<Record<string, string>>({});

  // Bridge Admin
  const [bridgeMinSigs, setBridgeMinSigs] = useState("");
  const [bridgeRatio, setBridgeRatio] = useState("");
  const [emergencyCap, setEmergencyCap] = useState("");
  const [emergencyReason, setEmergencyReason] = useState("");

  // Borrow Admin
  const [newInterestRate, setNewInterestRate] = useState("");
  const [newMinDebt, setNewMinDebt] = useState("");

  // Oracle Admin
  const [oracleToken, setOracleToken] = useState("");
  const [oracleFeed, setOracleFeed] = useState("");
  const [oracleStale, setOracleStale] = useState("3600");
  const [oracleDecimals, setOracleDecimals] = useState("18");

  // Pendle Strategy Admin
  const [pendleMarketAddr, setPendleMarketAddr] = useState("");
  const [pendleSlippage, setPendleSlippage] = useState("");
  const [pendleDiscount, setPendleDiscount] = useState("");
  const [pendleRollover, setPendleRollover] = useState("");

  // Pool browser state
  interface PoolInfo {
    market: string;
    pt: string;
    expiry: number;
    timeToExpiry: number;
    tvlSy: bigint;
    impliedAPY: number;
    score: number;
    category: string;
  }
  const [availablePools, setAvailablePools] = useState<PoolInfo[]>([]);
  const [poolsLoading, setPoolsLoading] = useState(false);
  const [poolCategory, setPoolCategory] = useState("USD");

  // Multi-pool allocation state
  interface ActivePosition {
    market: string;
    ptBalance: bigint;
    expiry: number;
    usdcValue: bigint;
  }
  const [activePositions, setActivePositions] = useState<ActivePosition[]>([]);
  const [idleUSDC, setIdleUSDC] = useState<bigint>(0n);
  const [allocAmounts, setAllocAmounts] = useState<Record<string, string>>({});
  const [deallocAmounts, setDeallocAmounts] = useState<Record<string, string>>({});

  // Morpho state
  interface MorphoMarketInfo {
    marketId: string;
    label: string;
    loanToken: string;
    collateralToken: string;
    lltv: bigint;
    totalSupplyAssets: bigint;
    totalBorrowAssets: bigint;
    utilizationBps: number;
    borrowRateAnnualized: bigint;
    supplyRateAnnualized: bigint;
  }
  const [morphoMarkets, setMorphoMarkets] = useState<MorphoMarketInfo[]>([]);
  const [morphoMarketsLoading, setMorphoMarketsLoading] = useState(false);
  const [morphoLtvInput, setMorphoLtvInput] = useState("");
  const [morphoLoopsInput, setMorphoLoopsInput] = useState("");
  const [morphoSafetyInput, setMorphoSafetyInput] = useState("");
  const [morphoMaxBorrowInput, setMorphoMaxBorrowInput] = useState("");
  const [morphoMinSupplyInput, setMorphoMinSupplyInput] = useState("");
  const [morphoAddMarketId, setMorphoAddMarketId] = useState("");
  const [morphoAddLabel, setMorphoAddLabel] = useState("");

  // Yield Scanner state
  interface YieldOpportunity {
    protocol: number;
    risk: number;
    label: string;
    venue: string;
    marketId: string;
    supplyApyBps: bigint;
    borrowApyBps: bigint;
    tvlUsd6: bigint;
    utilizationBps: bigint;
    extraData: bigint;
    available: boolean;
    // ── Leverage loop fields ──
    isLeveraged?: boolean;
    leverageMultiplier?: number;
    effectiveApyBps?: number;
    merklApyBps?: number;
    leverageStrategy?: string;
    baseProtocol?: string;
  }
  interface YieldSuggestion {
    rank: number;
    protocol: number;
    label: string;
    venue: string;
    marketId: string;
    supplyApyBps: bigint;
    risk: number;
    reason: string;
  }
  interface TrancheSuggestion {
    rank: number;
    tranche: number;
    protocol: number;
    label: string;
    venue: string;
    marketId: string;
    supplyApyBps: bigint;
    borrowApyBps: bigint;
    tvlUsd6: bigint;
    utilizationBps: bigint;
    risk: number;
    compositeScore: bigint;
    reason: string;
  }
  const PROTOCOL_NAMES: Record<number, string> = {
    0: "Aave V3", 1: "Compound V3", 2: "Morpho Blue", 3: "Pendle", 4: "Sky sUSDS",
    5: "Ethena sUSDe", 6: "Spark", 7: "Curve/Convex", 8: "Yearn V3",
    9: "Lido", 10: "Rocket Pool", 11: "Frax", 12: "Fluid", 13: "Euler",
    14: "Maker DSR", 15: "Gearbox", 16: "Silo", 17: "Radiant", 18: "Sturdy",
    19: "Notional", 20: "Exactly", 21: "Sommelier", 22: "Harvest", 23: "Beefy",
    24: "Convex", 25: "Stake DAO", 26: "Angle", 27: "Mountain USDM", 28: "Usual",
    29: "Resolv", 30: "Origin", 31: "Prisma", 32: "crvUSD", 33: "Tokemak",
    34: "Ondo", 35: "Maple", 36: "Clearpool", 37: "TrueFi", 38: "Goldfinch",
    39: "Centrifuge", 40: "Ribbon", 41: "Idle", 42: "Instadapp", 43: "dForce",
    44: "Benqi", 45: "Venus", 46: "Aura", 47: "Balancer", 48: "Yearn", 49: "Generic",
  };
  const PROTOCOL_COLOR_LIST = [
    "text-blue-400", "text-green-400", "text-purple-400", "text-cyan-400", "text-yellow-400",
    "text-orange-400", "text-indigo-400", "text-red-400", "text-emerald-400", "text-sky-400",
    "text-rose-400", "text-violet-400", "text-lime-400", "text-amber-400", "text-teal-400",
    "text-pink-400", "text-fuchsia-400", "text-stone-400", "text-slate-400", "text-zinc-400",
  ];
  const getProtocolColor = (id: number) => PROTOCOL_COLOR_LIST[id % PROTOCOL_COLOR_LIST.length];
  const getProtocolName = (id: number, fallback?: string) => PROTOCOL_NAMES[id] || fallback || `Protocol #${id}`;
  const RISK_LABELS = ["Low", "Medium", "High", "Unclassified"];
  const RISK_COLORS = ["text-green-400", "text-yellow-400", "text-red-400", "text-gray-400"];
  const TRANCHE_NAMES = ["Senior", "Mezzanine", "Junior"] as const;
  // Protocol enum → config key for strategy address lookup
  const PROTOCOL_STRATEGY_KEYS: Record<number, string> = {
    0: "PendleStrategy",   // Aave V3 — no dedicated strategy yet, but could route through a future AaveStrategy
    3: "PendleStrategy",   // Pendle
    2: "MorphoStrategy",   // Morpho Blue
  };
  const [yieldOpportunities, setYieldOpportunities] = useState<YieldOpportunity[]>([]);
  const [yieldSuggestions, setYieldSuggestions] = useState<YieldSuggestion[]>([]);
  const [trancheSenior, setTrancheSenior] = useState<TrancheSuggestion[]>([]);
  const [trancheMezzanine, setTrancheMezzanine] = useState<TrancheSuggestion[]>([]);
  const [trancheJunior, setTrancheJunior] = useState<TrancheSuggestion[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState<TrancheSuggestion | null>(null);
  const [trancheDepositAmt, setTrancheDepositAmt] = useState("");
  const [trancheDepositing, setTrancheDepositing] = useState(false);
  const [autoDeploying, setAutoDeploying] = useState(false);
  const [yieldLoading, setYieldLoading] = useState(false);
  const [yieldDataSource, setYieldDataSource] = useState<"indexer" | "on-chain" | "direct-defillama" | null>(null);
  const [yieldLastScan, setYieldLastScan] = useState<string>("");
  const [yieldScanError, setYieldScanError] = useState<string>("");
  const [yieldRiskFilter, setYieldRiskFilter] = useState<number | null>(null);
  const [yieldProtocolFilter, setYieldProtocolFilter] = useState<number | null>(null);
  const [yieldSortBy, setYieldSortBy] = useState<"apy" | "tvl" | "risk">("apy");
  const [showLeveragedOnly, setShowLeveragedOnly] = useState(false);
  const [yieldConfigAddr, setYieldConfigAddr] = useState("");
  const [yieldConfigProtocol, setYieldConfigProtocol] = useState("");

  const { musd, directMint, treasury, bridge, borrow, oracle, pendleStrategy, pendleSelector, morphoStrategy, morphoRegistry, yieldScanner, strategyFactory, yieldVerifier } = contracts;

  // Current values display
  const [currentValues, setCurrentValues] = useState<Record<string, string>>({});

  useEffect(() => {
    async function loadCurrentValues() {
      if (!address) return;
      const vals: Record<string, string> = {};
      try {
        if (musd) vals.supplyCap = formatUSD(await musd.supplyCap());
        if (directMint) {
          vals.mintFee = formatBps(await directMint.mintFeeBps());
          vals.redeemFee = formatBps(await directMint.redeemFeeBps());
          vals.accFees = formatToken(await directMint.accumulatedFees(), 6);
          vals.paused = (await directMint.paused()).toString();
        }
        if (treasury) {
          // Use TreasuryV2 functions instead of stale V1 calls
          vals.maxDeploy = formatBps(await treasury.reserveBps());
          vals.totalBacking = formatUSD(await treasury.totalValue(), 6);
          vals.treasuryReserve = formatUSD(await treasury.reserveBalance(), 6);
          vals.treasuryTargetReserve = formatUSD(await treasury.targetReserve(), 6);
          vals.treasuryNetValue = formatUSD(await treasury.totalValueNet(), 6);
          const feeData = await treasury.fees();
          vals.treasuryPerfFee = formatBps(feeData.performanceFeeBps);
          vals.treasuryAccruedFees = formatUSD(feeData.accruedFees, 6);
          vals.treasuryFeeRecipient = feeData.feeRecipient;
          vals.treasuryPendingFees = formatUSD(await treasury.pendingFees(), 6);
          const stratCount = await treasury.strategyCount();
          vals.treasuryStrategyCount = stratCount.toString();

          // Load full strategy details
          try {
            const allStrats = await treasury.getAllStrategies();
            const allocations = await treasury.getCurrentAllocations();
            const strats: StrategyInfo[] = [];
            for (let i = 0; i < allStrats.length; i++) {
              const s = allStrats[i];
              // Find matching allocation data
              let currentBps = 0;
              let currentValue = 0n;
              for (let j = 0; j < allocations.strategyAddresses.length; j++) {
                if (allocations.strategyAddresses[j].toLowerCase() === s.strategy.toLowerCase()) {
                  currentBps = Number(allocations.currentBps[j]);
                  break;
                }
              }
              // Try to get strategy value
              try {
                const stratContract = new ethers.Contract(s.strategy, ["function totalValue() view returns (uint256)"], treasury.runner);
                currentValue = await stratContract.totalValue();
              } catch {}
              strats.push({
                address: s.strategy,
                targetBps: Number(s.targetBps),
                minBps: Number(s.minBps),
                maxBps: Number(s.maxBps),
                active: s.active,
                autoAllocate: s.autoAllocate,
                currentValue,
                currentBps,
              });
            }
            setRegisteredStrategies(strats);
          } catch {
            setRegisteredStrategies([]);
          }
        }
        if (bridge) {
          vals.bridgeMinSigs = (await bridge.minSignatures()).toString();
          vals.bridgeRatio = formatBps(await bridge.collateralRatioBps());
          vals.bridgePaused = (await bridge.paused()).toString();
        }
        if (borrow) {
          vals.interestRate = formatBps(await borrow.interestRateBps());
          vals.minDebt = formatUSD(await borrow.minDebt());
        }
        if (pendleStrategy) {
          try {
            vals.pendleMarket = await pendleStrategy.currentMarket();
            vals.pendlePT = await pendleStrategy.currentPT();
            const expiry = await pendleStrategy.currentExpiry();
            vals.pendleExpiry = expiry > 0n ? new Date(Number(expiry) * 1000).toLocaleDateString() : "Not set";
            const tte = await pendleStrategy.timeToExpiry();
            vals.pendleTimeToExpiry = tte > 0n ? `${Math.floor(Number(tte) / 86400)}d ${Math.floor((Number(tte) % 86400) / 3600)}h` : "Expired / Not set";
            vals.pendlePtBalance = formatToken(await pendleStrategy.ptBalance(), 18);
            vals.pendleTotalValue = formatUSD(await pendleStrategy.totalValue(), 6);
            vals.pendleSlippage = formatBps(await pendleStrategy.slippageBps());
            vals.pendleDiscount = formatBps(await pendleStrategy.ptDiscountRateBps());
            const rollover = await pendleStrategy.rolloverThreshold();
            vals.pendleRollover = `${Math.floor(Number(rollover) / 86400)} days`;
            vals.pendleManualMode = (await pendleStrategy.manualMarketSelection()).toString();
            vals.pendleActive = (await pendleStrategy.isActive()).toString();
            vals.pendlePaused = (await pendleStrategy.paused()).toString();
            vals.pendleShouldRoll = (await pendleStrategy.shouldRollover()).toString();
            // Load multi-pool positions
            try {
              const idle = await pendleStrategy.idleBalance();
              vals.pendleIdleBalance = formatUSD(idle, 6);
              setIdleUSDC(idle);
              const count = await pendleStrategy.positionCount();
              vals.pendlePositionCount = count.toString();
              if (count > 0n) {
                const posData = await pendleStrategy.getPositions();
                const positions: ActivePosition[] = [];
                for (let i = 0; i < posData.markets.length; i++) {
                  positions.push({
                    market: posData.markets[i],
                    ptBalance: posData.ptBalances[i],
                    expiry: Number(posData.expiries[i]),
                    usdcValue: posData.usdcValues[i],
                  });
                }
                setActivePositions(positions);
              } else {
                setActivePositions([]);
              }
            } catch {
              setActivePositions([]);
              setIdleUSDC(0n);
            }
          } catch {}
        }
        if (morphoStrategy) {
          try {
            const pos = await morphoStrategy.getPosition();
            vals.morphoCollateral = formatUSD(pos.collateral, 6);
            vals.morphoBorrowed = formatUSD(pos.borrowed, 6);
            vals.morphoPrincipal = formatUSD(pos.principal, 6);
            vals.morphoNetValue = formatUSD(pos.netValue, 6);
            vals.morphoTotalValue = formatUSD(await morphoStrategy.totalValue(), 6);
            const hf = await morphoStrategy.getHealthFactor();
            vals.morphoHealthFactor = hf >= BigInt("0xffffffffffffffffffffffffffffffff")
              ? "∞" : (Number(hf) / 1e18).toFixed(2);
            const lev = await morphoStrategy.getCurrentLeverage();
            vals.morphoLeverage = (Number(lev) / 100).toFixed(2) + "x";
            vals.morphoTargetLtv = formatBps(await morphoStrategy.targetLtvBps());
            vals.morphoLoops = (await morphoStrategy.targetLoops()).toString();
            vals.morphoSafetyBuffer = formatBps(await morphoStrategy.safetyBufferBps());
            vals.morphoActive = (await morphoStrategy.active()).toString();
            vals.morphoPaused = (await morphoStrategy.paused()).toString();
            const profit = await morphoStrategy.checkProfitability();
            vals.morphoProfitable = profit.isProfitable.toString();
            vals.morphoBorrowRate = (Number(profit.currentBorrowRate) / 1e16).toFixed(2) + "%";
            vals.morphoMaxBorrowRate = (Number(profit.maxAllowedRate) / 1e16).toFixed(2) + "%";
          } catch {}
        }
      } catch {}
      setCurrentValues(vals);
    }
    loadCurrentValues();
  }, [musd, directMint, treasury, bridge, borrow, pendleStrategy, pendleSelector, morphoStrategy, address, tx.success]);

  // Load available pools from PendleMarketSelector
  useEffect(() => {
    async function loadPools() {
      if (!pendleSelector) return;
      setPoolsLoading(true);
      try {
        const markets: string[] = await pendleSelector.getWhitelistedMarkets();
        const pools: PoolInfo[] = [];
        for (const addr of markets) {
          try {
            const cat = await pendleSelector.marketCategory(addr);
            const info = await pendleSelector.getMarketInfo(addr);
            pools.push({
              market: info.market,
              pt: info.pt,
              expiry: Number(info.expiry),
              timeToExpiry: Number(info.timeToExpiry),
              tvlSy: info.tvlSy,
              impliedAPY: Number(info.impliedAPY),
              score: Number(info.score),
              category: cat,
            });
          } catch {
            // Skip markets that fail to load (expired, etc.)
          }
        }
        // Sort by APY descending
        pools.sort((a, b) => b.impliedAPY - a.impliedAPY);
        setAvailablePools(pools);
      } catch (err) {
        console.error("Failed to load pools:", err);
      }
      setPoolsLoading(false);
    }
    loadPools();
  }, [pendleSelector, tx.success]);

  // Load Morpho markets from MorphoMarketRegistry
  useEffect(() => {
    async function loadMorphoMarkets() {
      if (!morphoRegistry) return;
      setMorphoMarketsLoading(true);
      try {
        const infos = await morphoRegistry.getAllMarketInfo();
        const mkts: MorphoMarketInfo[] = infos.map((m: any) => ({
          marketId: m.marketId,
          label: m.label,
          loanToken: m.loanToken,
          collateralToken: m.collateralToken,
          lltv: m.lltv,
          totalSupplyAssets: m.totalSupplyAssets,
          totalBorrowAssets: m.totalBorrowAssets,
          utilizationBps: Number(m.utilizationBps),
          borrowRateAnnualized: m.borrowRateAnnualized,
          supplyRateAnnualized: m.supplyRateAnnualized,
        }));
        setMorphoMarkets(mkts);
      } catch (err) {
        console.error("Failed to load Morpho markets:", err);
      }
      setMorphoMarketsLoading(false);
    }
    loadMorphoMarkets();
  }, [morphoRegistry, tx.success]);

  if (!isConnected) {
    return <WalletConnector mode="ethereum" />;
  }

  const sections: { key: AdminSection; label: string }[] = [
    { key: "musd", label: "mUSD" },
    { key: "directmint", label: "DirectMint" },
    { key: "treasury", label: "Treasury" },
    { key: "bridge", label: "Bridge" },
    { key: "borrow", label: "Borrow" },
    { key: "oracle", label: "Oracle" },
    { key: "pendle", label: "Pendle PT" },
    { key: "morpho", label: "Morpho" },
    { key: "yield", label: "⚡ Yield Scanner" },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-white">Admin Panel</h1>
      <p className="text-gray-400">Protocol administration (requires appropriate roles)</p>

      <div className="flex flex-wrap gap-2 border-b border-gray-700 pb-4">
        {sections.map((s) => (
          <button
            key={s.key}
            onClick={() => setSection(s.key)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
              section === s.key ? "bg-brand-600 text-white" : "bg-gray-800 text-gray-400 hover:text-white"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {tx.error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 p-4 text-sm text-red-400">
          {tx.error}
        </div>
      )}
      {tx.success && (
        <div className="rounded-lg border border-green-800 bg-green-900/20 p-4 text-sm text-green-400">
          Transaction confirmed!
        </div>
      )}

      {/* ===== mUSD Section ===== */}
      {section === "musd" && (
        <div className="space-y-4">
          <div className="card">
            <p className="mb-2 text-sm text-gray-400">Current Supply Cap: {currentValues.supplyCap || "..."}</p>
            <label className="label">New Supply Cap (mUSD)</label>
            <input className="input" type="number" placeholder="1000000" value={newSupplyCap} onChange={(e) => setNewSupplyCap(e.target.value)} />
            <TxButton
              className="mt-3 w-full"
              onClick={() => tx.send(() => musd!.setSupplyCap(ethers.parseUnits(newSupplyCap, MUSD_DECIMALS)))}
              loading={tx.loading}
              disabled={!newSupplyCap}
            >
              Set Supply Cap
            </TxButton>
          </div>
          <div className="card">
            <label className="label">Blacklist Address</label>
            <input className="input" type="text" placeholder="0x..." value={blacklistAddr} onChange={(e) => setBlacklistAddr(e.target.value)} />
            <div className="mt-2 flex gap-2">
              <TxButton
                className="flex-1"
                onClick={() => tx.send(() => musd!.setBlacklist(blacklistAddr, true))}
                loading={tx.loading}
                disabled={!blacklistAddr}
                variant="danger"
              >
                Blacklist
              </TxButton>
              <TxButton
                className="flex-1"
                onClick={() => tx.send(() => musd!.setBlacklist(blacklistAddr, false))}
                loading={tx.loading}
                disabled={!blacklistAddr}
                variant="secondary"
              >
                Unblacklist
              </TxButton>
            </div>
          </div>
        </div>
      )}

      {/* ===== DirectMint Section ===== */}
      {section === "directmint" && (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Mint Fee" value={currentValues.mintFee || "..."} />
            <StatCard label="Redeem Fee" value={currentValues.redeemFee || "..."} />
            <StatCard label="Accumulated Fees" value={currentValues.accFees || "..."} subValue="USDC" />
          </div>
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Set Fees (basis points)</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Mint Fee (bps)</label>
                <input className="input" type="number" placeholder="30" value={mintFeeBps} onChange={(e) => setMintFeeBps(e.target.value)} />
              </div>
              <div>
                <label className="label">Redeem Fee (bps)</label>
                <input className="input" type="number" placeholder="30" value={redeemFeeBps} onChange={(e) => setRedeemFeeBps(e.target.value)} />
              </div>
            </div>
            <TxButton
              className="mt-3 w-full"
              onClick={() => tx.send(() => directMint!.setFees(BigInt(mintFeeBps), BigInt(redeemFeeBps)))}
              loading={tx.loading}
              disabled={!mintFeeBps || !redeemFeeBps}
            >
              Update Fees
            </TxButton>
          </div>
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Set Limits (USDC)</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Min Mint</label>
                <input className="input" type="number" value={minMint} onChange={(e) => setMinMint(e.target.value)} />
              </div>
              <div>
                <label className="label">Max Mint</label>
                <input className="input" type="number" value={maxMint} onChange={(e) => setMaxMint(e.target.value)} />
              </div>
              <div>
                <label className="label">Min Redeem</label>
                <input className="input" type="number" value={minRedeem} onChange={(e) => setMinRedeem(e.target.value)} />
              </div>
              <div>
                <label className="label">Max Redeem</label>
                <input className="input" type="number" value={maxRedeem} onChange={(e) => setMaxRedeem(e.target.value)} />
              </div>
            </div>
            <TxButton
              className="mt-3 w-full"
              onClick={() =>
                tx.send(() =>
                  directMint!.setLimits(
                    ethers.parseUnits(minMint, USDC_DECIMALS),
                    ethers.parseUnits(maxMint, USDC_DECIMALS),
                    ethers.parseUnits(minRedeem, USDC_DECIMALS),
                    ethers.parseUnits(maxRedeem, USDC_DECIMALS)
                  )
                )
              }
              loading={tx.loading}
              disabled={!minMint || !maxMint || !minRedeem || !maxRedeem}
            >
              Update Limits
            </TxButton>
          </div>
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Fee Recipient</h3>
            <input className="input" type="text" placeholder="0x..." value={newFeeRecipient} onChange={(e) => setNewFeeRecipient(e.target.value)} />
            <TxButton
              className="mt-3 w-full"
              onClick={() => tx.send(() => directMint!.setFeeRecipient(newFeeRecipient))}
              loading={tx.loading}
              disabled={!newFeeRecipient}
            >
              Set Fee Recipient
            </TxButton>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <TxButton onClick={() => tx.send(() => directMint!.withdrawFees())} loading={tx.loading}>
              Withdraw Fees
            </TxButton>
            <TxButton onClick={() => tx.send(() => directMint!.pause())} loading={tx.loading} variant="danger">
              Pause
            </TxButton>
            <TxButton onClick={() => tx.send(() => directMint!.unpause())} loading={tx.loading} variant="secondary">
              Unpause
            </TxButton>
          </div>
        </div>
      )}

      {/* ===== Treasury Section ===== */}
      {section === "treasury" && (
        <div className="space-y-4">
          {/* Status Overview */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <StatCard label="Total Value" value={currentValues.totalBacking || "..."} subValue="All strategies + reserves" />
            <StatCard label="Idle Reserves" value={currentValues.treasuryReserve || "..."} subValue="USDC in treasury" color="blue" />
            <StatCard label="Target Reserve" value={currentValues.treasuryTargetReserve || "..."} subValue={`${currentValues.maxDeploy || "..."} of total`} />
            <StatCard label="Strategies" value={currentValues.treasuryStrategyCount || "0"} subValue="of 10 max" />
            <StatCard label="Pending Fees" value={currentValues.treasuryPendingFees || "$0.00"} subValue={currentValues.treasuryPerfFee ? `${currentValues.treasuryPerfFee} perf fee` : ""} />
          </div>

          {/* Deployed Strategies Table */}
          <div className="card">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold text-gray-300">Strategy Allocations</h3>
              <span className="rounded-full bg-gray-700 px-3 py-1 text-xs text-gray-400">
                Idle: <span className="font-semibold text-blue-400">{currentValues.treasuryReserve || "$0.00"}</span> USDC
              </span>
            </div>

            {registeredStrategies.length === 0 ? (
              <div className="py-6 text-center text-sm text-gray-500">
                No strategies registered yet. Add one below.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-700 text-left text-xs text-gray-500 uppercase">
                      <th className="pb-2 pr-4">Strategy</th>
                      <th className="pb-2 pr-4 text-right">Deployed</th>
                      <th className="pb-2 pr-4 text-right">Current %</th>
                      <th className="pb-2 pr-4 text-right">Target %</th>
                      <th className="pb-2 pr-4 text-center">Status</th>
                      <th className="pb-2 pr-4 text-right">Deploy USDC</th>
                      <th className="pb-2 pr-4 text-right">Withdraw USDC</th>
                      <th className="pb-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {registeredStrategies.map((strat) => {
                      const deployedUsd = (Number(strat.currentValue) / 1e6).toFixed(2);
                      const currentPct = (strat.currentBps / 100).toFixed(1);
                      const targetPct = (strat.targetBps / 100).toFixed(1);
                      const isOverweight = strat.currentBps > strat.targetBps + 100;
                      const isUnderweight = strat.currentBps < strat.targetBps - 100;

                      return (
                        <tr
                          key={strat.address}
                          className={`border-b border-gray-800 transition ${
                            !strat.active ? "opacity-50" : "hover:bg-gray-800/50"
                          }`}
                        >
                          <td className="py-3 pr-4">
                            <div className="flex items-center gap-2">
                              <span className={`inline-block h-2 w-2 rounded-full ${strat.active ? "bg-emerald-400" : "bg-red-400"}`} />
                              <span className="font-mono text-xs text-gray-300">
                                {strat.address.slice(0, 6)}…{strat.address.slice(-4)}
                              </span>
                            </div>
                            <div className="mt-0.5 text-[10px] text-gray-600">
                              Range: {(strat.minBps / 100).toFixed(0)}% – {(strat.maxBps / 100).toFixed(0)}%
                              {strat.autoAllocate && " • Auto"}
                            </div>
                          </td>
                          <td className="py-3 pr-4 text-right font-semibold text-gray-200">
                            ${deployedUsd}
                          </td>
                          <td className={`py-3 pr-4 text-right font-medium ${
                            isOverweight ? "text-red-400" : isUnderweight ? "text-yellow-400" : "text-gray-300"
                          }`}>
                            {currentPct}%
                          </td>
                          <td className="py-3 pr-4 text-right text-gray-400">
                            {targetPct}%
                          </td>
                          <td className="py-3 pr-4 text-center">
                            <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                              strat.active ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"
                            }`}>
                              {strat.active ? "Active" : "Inactive"}
                            </span>
                          </td>
                          <td className="py-3 pr-4">
                            <input
                              className="input w-28 py-1 text-right text-sm"
                              type="number"
                              placeholder="0.00"
                              value={strategyDeployAmounts[strat.address] || ""}
                              onChange={(e) => setStrategyDeployAmounts((prev) => ({ ...prev, [strat.address]: e.target.value }))}
                              disabled={!strat.active}
                            />
                          </td>
                          <td className="py-3 pr-4">
                            <input
                              className="input w-28 py-1 text-right text-sm"
                              type="number"
                              placeholder="0.00"
                              value={strategyWithdrawAmounts[strat.address] || ""}
                              onChange={(e) => setStrategyWithdrawAmounts((prev) => ({ ...prev, [strat.address]: e.target.value }))}
                              disabled={!strat.active}
                            />
                          </td>
                          <td className="py-3">
                            <div className="flex gap-1">
                              <button
                                onClick={() => {
                                  const amt = strategyDeployAmounts[strat.address];
                                  if (!amt || parseFloat(amt) <= 0) return;
                                  const usdcWei = BigInt(Math.floor(parseFloat(amt) * 1e6));
                                  tx.send(() => treasury!.deployToStrategy(strat.address, usdcWei));
                                }}
                                disabled={!strat.active || !strategyDeployAmounts[strat.address] || parseFloat(strategyDeployAmounts[strat.address] || "0") <= 0 || tx.loading}
                                className="rounded-lg bg-emerald-600 px-2 py-1 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
                                title="Deploy USDC to this strategy"
                              >
                                Deploy
                              </button>
                              <button
                                onClick={() => {
                                  const amt = strategyWithdrawAmounts[strat.address];
                                  if (!amt || parseFloat(amt) <= 0) return;
                                  const usdcWei = BigInt(Math.floor(parseFloat(amt) * 1e6));
                                  tx.send(() => treasury!.withdrawFromStrategy(strat.address, usdcWei));
                                }}
                                disabled={!strat.active || !strategyWithdrawAmounts[strat.address] || parseFloat(strategyWithdrawAmounts[strat.address] || "0") <= 0 || tx.loading}
                                className="rounded-lg bg-yellow-600 px-2 py-1 text-xs font-medium text-white transition hover:bg-yellow-500 disabled:opacity-40 disabled:cursor-not-allowed"
                                title="Withdraw USDC from this strategy"
                              >
                                Pull
                              </button>
                              <button
                                onClick={() => tx.send(() => treasury!.withdrawAllFromStrategy(strat.address))}
                                disabled={!strat.active || tx.loading}
                                className="rounded-lg bg-red-600 px-2 py-1 text-xs font-medium text-white transition hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed"
                                title="Withdraw ALL from this strategy"
                              >
                                All
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Allocation bar chart */}
            {registeredStrategies.filter((s) => s.active).length > 0 && (
              <div className="mt-4">
                <div className="mb-1 flex justify-between text-xs text-gray-500">
                  <span>Allocation breakdown</span>
                  <span>100%</span>
                </div>
                <div className="flex h-4 w-full overflow-hidden rounded-full bg-gray-800">
                  {registeredStrategies
                    .filter((s) => s.active && s.currentBps > 0)
                    .map((s, i) => {
                      const colors = ["bg-brand-500", "bg-emerald-500", "bg-blue-500", "bg-purple-500", "bg-yellow-500", "bg-pink-500"];
                      return (
                        <div
                          key={s.address}
                          className={`${colors[i % colors.length]} transition-all`}
                          style={{ width: `${s.currentBps / 100}%` }}
                          title={`${s.address.slice(0, 6)}…${s.address.slice(-4)}: ${(s.currentBps / 100).toFixed(1)}%`}
                        />
                      );
                    })}
                  {/* Reserve portion */}
                  {(() => {
                    const stratBps = registeredStrategies.filter((s) => s.active).reduce((sum, s) => sum + s.currentBps, 0);
                    const reservePct = Math.max(0, 100 - stratBps / 100);
                    return reservePct > 0 ? (
                      <div
                        className="bg-gray-600 transition-all"
                        style={{ width: `${reservePct}%` }}
                        title={`Reserves: ${reservePct.toFixed(1)}%`}
                      />
                    ) : null;
                  })()}
                </div>
                <div className="mt-1 flex flex-wrap gap-3 text-[10px] text-gray-500">
                  {registeredStrategies.filter((s) => s.active && s.currentBps > 0).map((s, i) => {
                    const colors = ["text-brand-400", "text-emerald-400", "text-blue-400", "text-purple-400", "text-yellow-400", "text-pink-400"];
                    return (
                      <span key={s.address} className={colors[i % colors.length]}>
                        ● {s.address.slice(0, 6)}…{s.address.slice(-4)} ({(s.currentBps / 100).toFixed(1)}%)
                      </span>
                    );
                  })}
                  <span className="text-gray-500">● Reserves</span>
                </div>
              </div>
            )}
          </div>

          {/* Add Strategy */}
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Add Strategy</h3>
            <div>
              <label className="label">Strategy Address</label>
              <input className="input" type="text" placeholder="0x..." value={strategyAddr} onChange={(e) => setStrategyAddr(e.target.value)} />
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-4">
              <div>
                <label className="label">Target (bps)</label>
                <input className="input" type="number" placeholder="5000" value={targetBps} onChange={(e) => setTargetBps(e.target.value)} />
              </div>
              <div>
                <label className="label">Min (bps)</label>
                <input className="input" type="number" placeholder="4000" value={minBps} onChange={(e) => setMinBps(e.target.value)} />
              </div>
              <div>
                <label className="label">Max (bps)</label>
                <input className="input" type="number" placeholder="6000" value={maxBps} onChange={(e) => setMaxBps(e.target.value)} />
              </div>
              <div>
                <label className="label">Auto-Allocate</label>
                <select className="input" defaultValue="false">
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </div>
            </div>
            <TxButton
              className="mt-3 w-full"
              onClick={() => tx.send(() => treasury!.addStrategy(strategyAddr, BigInt(targetBps), BigInt(minBps), BigInt(maxBps), false))}
              loading={tx.loading}
              disabled={!strategyAddr || !targetBps || !minBps || !maxBps}
            >
              Add Strategy
            </TxButton>
          </div>

          {/* Remove Strategy */}
          {registeredStrategies.filter((s) => s.active).length > 0 && (
            <div className="card">
              <h3 className="mb-3 font-semibold text-gray-300">Remove Strategy</h3>
              <p className="mb-3 text-sm text-gray-400">
                Removes a strategy and withdraws all its funds back to treasury reserves.
              </p>
              <div className="grid gap-2">
                {registeredStrategies.filter((s) => s.active).map((strat) => (
                  <div key={strat.address} className="flex items-center justify-between rounded-lg bg-gray-800 px-4 py-2">
                    <span className="font-mono text-sm text-gray-300">
                      {strat.address.slice(0, 6)}…{strat.address.slice(-4)}
                      <span className="ml-2 text-xs text-gray-500">(${(Number(strat.currentValue) / 1e6).toFixed(2)} deployed)</span>
                    </span>
                    <TxButton
                      onClick={() => tx.send(() => treasury!.removeStrategy(strat.address))}
                      loading={tx.loading}
                      variant="danger"
                      className="!px-3 !py-1 !text-xs"
                    >
                      Remove
                    </TxButton>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Reserve & Rebalance */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="card">
              <h3 className="mb-3 font-semibold text-gray-300">Reserve Ratio (bps)</h3>
              <p className="mb-2 text-xs text-gray-500">Current: {currentValues.maxDeploy || "..."} — max 30%</p>
              <input className="input" type="number" placeholder="1000" value={reserveBps} onChange={(e) => setReserveBps(e.target.value)} />
              <TxButton
                className="mt-3 w-full"
                onClick={() => tx.send(() => treasury!.setReserveBps(BigInt(reserveBps)))}
                loading={tx.loading}
                disabled={!reserveBps}
              >
                Set Reserve (Timelock)
              </TxButton>
            </div>
            <div className="card">
              <h3 className="mb-3 font-semibold text-gray-300">Actions</h3>
              <div className="grid gap-2">
                <TxButton
                  className="w-full"
                  onClick={() => tx.send(() => treasury!.rebalance())}
                  loading={tx.loading}
                >
                  Rebalance to Targets
                </TxButton>
                <TxButton
                  className="w-full"
                  onClick={() => tx.send(() => treasury!.accrueFees())}
                  loading={tx.loading}
                  variant="secondary"
                >
                  Accrue Fees
                </TxButton>
                <TxButton
                  className="w-full"
                  onClick={() => tx.send(() => treasury!.claimFees())}
                  loading={tx.loading}
                  variant="secondary"
                >
                  Claim Fees ({currentValues.treasuryAccruedFees || "$0.00"})
                </TxButton>
                <TxButton
                  className="w-full"
                  onClick={() => tx.send(() => treasury!.emergencyWithdrawAll())}
                  loading={tx.loading}
                  variant="danger"
                >
                  Emergency Withdraw All
                </TxButton>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===== Bridge Section ===== */}
      {section === "bridge" && (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Min Signatures" value={currentValues.bridgeMinSigs || "..."} />
            <StatCard label="Collateral Ratio" value={currentValues.bridgeRatio || "..."} />
            <StatCard label="Paused" value={currentValues.bridgePaused || "..."} color={currentValues.bridgePaused === "true" ? "red" : "green"} />
          </div>
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Configuration</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Min Signatures</label>
                <input className="input" type="number" value={bridgeMinSigs} onChange={(e) => setBridgeMinSigs(e.target.value)} />
                <TxButton className="mt-2 w-full" onClick={() => tx.send(() => bridge!.setMinSignatures(BigInt(bridgeMinSigs)))} loading={tx.loading} disabled={!bridgeMinSigs}>
                  Update
                </TxButton>
              </div>
              <div>
                <label className="label">Collateral Ratio (bps)</label>
                <input className="input" type="number" value={bridgeRatio} onChange={(e) => setBridgeRatio(e.target.value)} />
                <TxButton className="mt-2 w-full" onClick={() => tx.send(() => bridge!.setCollateralRatio(BigInt(bridgeRatio)))} loading={tx.loading} disabled={!bridgeRatio}>
                  Update
                </TxButton>
              </div>
            </div>
          </div>
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Emergency Cap Reduction</h3>
            <div>
              <label className="label">New Cap (mUSD)</label>
              <input className="input" type="number" value={emergencyCap} onChange={(e) => setEmergencyCap(e.target.value)} />
            </div>
            <div className="mt-3">
              <label className="label">Reason</label>
              <input className="input" type="text" value={emergencyReason} onChange={(e) => setEmergencyReason(e.target.value)} />
            </div>
            <TxButton
              className="mt-3 w-full"
              onClick={() => tx.send(() => bridge!.emergencyReduceCap(ethers.parseUnits(emergencyCap, MUSD_DECIMALS), emergencyReason))}
              loading={tx.loading}
              disabled={!emergencyCap || !emergencyReason}
              variant="danger"
            >
              Emergency Reduce Cap
            </TxButton>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TxButton onClick={() => tx.send(() => bridge!.pause())} loading={tx.loading} variant="danger">
              Pause Bridge
            </TxButton>
            <TxButton onClick={() => tx.send(() => bridge!.unpause())} loading={tx.loading} variant="secondary">
              Unpause Bridge
            </TxButton>
          </div>
        </div>
      )}

      {/* ===== Borrow Section ===== */}
      {section === "borrow" && (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <StatCard label="Interest Rate" value={currentValues.interestRate || "..."} />
            <StatCard label="Min Debt" value={currentValues.minDebt || "..."} />
          </div>
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Set Interest Rate (bps APR)</h3>
            <input className="input" type="number" placeholder="500" value={newInterestRate} onChange={(e) => setNewInterestRate(e.target.value)} />
            <TxButton
              className="mt-3 w-full"
              onClick={() => tx.send(() => borrow!.setInterestRate(BigInt(newInterestRate)))}
              loading={tx.loading}
              disabled={!newInterestRate}
            >
              Set Interest Rate
            </TxButton>
          </div>
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Set Min Debt (mUSD)</h3>
            <input className="input" type="number" placeholder="100" value={newMinDebt} onChange={(e) => setNewMinDebt(e.target.value)} />
            <TxButton
              className="mt-3 w-full"
              onClick={() => tx.send(() => borrow!.setMinDebt(ethers.parseUnits(newMinDebt, MUSD_DECIMALS)))}
              loading={tx.loading}
              disabled={!newMinDebt}
            >
              Set Min Debt
            </TxButton>
          </div>
        </div>
      )}

      {/* ===== Oracle Section ===== */}
      {section === "oracle" && (
        <div className="space-y-4">
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Set Price Feed</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Token Address</label>
                <input className="input" type="text" placeholder="0x..." value={oracleToken} onChange={(e) => setOracleToken(e.target.value)} />
              </div>
              <div>
                <label className="label">Chainlink Feed</label>
                <input className="input" type="text" placeholder="0x..." value={oracleFeed} onChange={(e) => setOracleFeed(e.target.value)} />
              </div>
              <div>
                <label className="label">Stale Period (seconds)</label>
                <input className="input" type="number" value={oracleStale} onChange={(e) => setOracleStale(e.target.value)} />
              </div>
              <div>
                <label className="label">Token Decimals</label>
                <input className="input" type="number" value={oracleDecimals} onChange={(e) => setOracleDecimals(e.target.value)} />
              </div>
            </div>
            <TxButton
              className="mt-3 w-full"
              onClick={() =>
                tx.send(() =>
                  oracle!.setFeed(oracleToken, oracleFeed, BigInt(oracleStale), parseInt(oracleDecimals), 0)
                )
              }
              loading={tx.loading}
              disabled={!oracleToken || !oracleFeed}
            >
              Set Feed
            </TxButton>
          </div>
        </div>
      )}

      {/* ===== Pendle PT Strategy Section ===== */}
      {section === "pendle" && (
        <div className="space-y-4">
          {/* Status Overview */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <StatCard label="Total Value" value={currentValues.pendleTotalValue || "..."} subValue="USDC" />
            <StatCard label="Idle USDC" value={currentValues.pendleIdleBalance || "0"} subValue="Unallocated" color="blue" />
            <StatCard label="Positions" value={currentValues.pendlePositionCount || "0"} subValue={`of 10 max`} />
            <StatCard label="Time to Expiry" value={currentValues.pendleTimeToExpiry || "..."} />
            <StatCard
              label="Mode"
              value={currentValues.pendleManualMode === "true" ? "Manual" : "Auto"}
              color={currentValues.pendleManualMode === "true" ? "blue" : "default"}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Slippage" value={currentValues.pendleSlippage || "..."} />
            <StatCard label="PT Discount" value={currentValues.pendleDiscount || "..."} />
            <StatCard label="Rollover" value={currentValues.pendleRollover || "..."} />
          </div>

          {/* Current Market Info */}
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Current Market</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-400">Market:</span>
                <span className="font-mono text-gray-200 text-xs">{currentValues.pendleMarket || "Not set"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">PT Token:</span>
                <span className="font-mono text-gray-200 text-xs">{currentValues.pendlePT || "Not set"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Expiry:</span>
                <span className="text-gray-200">{currentValues.pendleExpiry || "Not set"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Active:</span>
                <span className={currentValues.pendleActive === "true" ? "text-green-400" : "text-red-400"}>
                  {currentValues.pendleActive === "true" ? "Yes" : "No"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Needs Rollover:</span>
                <span className={currentValues.pendleShouldRoll === "true" ? "text-yellow-400" : "text-gray-200"}>
                  {currentValues.pendleShouldRoll === "true" ? "Yes" : "No"}
                </span>
              </div>
            </div>
          </div>

          {/* Manual Mode Toggle */}
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Market Selection Mode</h3>
            <p className="mb-3 text-sm text-gray-400">
              {currentValues.pendleManualMode === "true"
                ? "Manual mode is ON — you must select the PT market below. Auto-selection and auto-rollover are disabled."
                : "Auto mode is ON — the PendleMarketSelector contract automatically picks the best PT market."}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <TxButton
                onClick={() => tx.send(() => pendleStrategy!.setManualMode(true))}
                loading={tx.loading}
                className={currentValues.pendleManualMode === "true" ? "opacity-50" : ""}
              >
                Enable Manual Mode
              </TxButton>
              <TxButton
                onClick={() => tx.send(() => pendleStrategy!.setManualMode(false))}
                loading={tx.loading}
                variant="secondary"
                className={currentValues.pendleManualMode !== "true" ? "opacity-50" : ""}
              >
                Enable Auto Mode
              </TxButton>
            </div>
          </div>

          {/* Active Positions (Multi-Pool) */}
          {currentValues.pendleManualMode === "true" && (
            <div className="card">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-semibold text-gray-300">Active Positions</h3>
                <span className="rounded-full bg-gray-700 px-3 py-1 text-xs text-gray-400">
                  Idle: <span className="font-semibold text-blue-400">{currentValues.pendleIdleBalance || "$0.00"}</span> USDC
                </span>
              </div>

              {activePositions.length === 0 ? (
                <div className="py-6 text-center text-sm text-gray-500">
                  No active positions. Allocate USDC to pools from the table below.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-700 text-left text-xs text-gray-500 uppercase">
                        <th className="pb-2 pr-4">Market</th>
                        <th className="pb-2 pr-4 text-right">PT Balance</th>
                        <th className="pb-2 pr-4 text-right">USDC Value</th>
                        <th className="pb-2 pr-4 text-right">Expiry</th>
                        <th className="pb-2 pr-4 text-right">Days Left</th>
                        <th className="pb-2 pr-4 text-right">Deallocate USDC</th>
                        <th className="pb-2">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activePositions.map((pos) => {
                        const daysLeft = Math.max(0, Math.floor((pos.expiry - Date.now() / 1000) / 86400));
                        const isExpired = pos.expiry <= Date.now() / 1000;
                        const usdcVal = (Number(pos.usdcValue) / 1e6).toFixed(2);
                        const ptBal = (Number(pos.ptBalance) / 1e18).toFixed(4);
                        return (
                          <tr key={pos.market} className="border-b border-gray-800 hover:bg-gray-800/50 transition">
                            <td className="py-3 pr-4">
                              <div className="flex items-center gap-2">
                                <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
                                <span className="font-mono text-xs text-gray-300">
                                  {pos.market.slice(0, 6)}…{pos.market.slice(-4)}
                                </span>
                              </div>
                            </td>
                            <td className="py-3 pr-4 text-right font-mono text-gray-300">{ptBal}</td>
                            <td className="py-3 pr-4 text-right font-semibold text-gray-200">${usdcVal}</td>
                            <td className="py-3 pr-4 text-right text-gray-400 text-xs">
                              {new Date(pos.expiry * 1000).toLocaleDateString()}
                            </td>
                            <td className={`py-3 pr-4 text-right font-medium ${
                              isExpired ? "text-red-400" : daysLeft < 7 ? "text-red-400" : daysLeft < 30 ? "text-yellow-400" : "text-gray-300"
                            }`}>
                              {isExpired ? "Expired" : `${daysLeft}d`}
                            </td>
                            <td className="py-3 pr-4">
                              <input
                                className="input w-28 py-1 text-right text-sm"
                                type="number"
                                placeholder="0.00"
                                value={deallocAmounts[pos.market] || ""}
                                onChange={(e) => setDeallocAmounts((prev) => ({ ...prev, [pos.market]: e.target.value }))}
                              />
                            </td>
                            <td className="py-3">
                              <div className="flex gap-1">
                                <button
                                  onClick={() => {
                                    const amt = deallocAmounts[pos.market];
                                    if (!amt || parseFloat(amt) <= 0) return;
                                    const usdcWei = BigInt(Math.floor(parseFloat(amt) * 1e6));
                                    tx.send(() => pendleStrategy!.deallocateFromMarket(pos.market, usdcWei));
                                  }}
                                  disabled={!deallocAmounts[pos.market] || parseFloat(deallocAmounts[pos.market] || "0") <= 0 || tx.loading}
                                  className="rounded-lg bg-yellow-600 px-2 py-1 text-xs font-medium text-white transition hover:bg-yellow-500 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                  Partial
                                </button>
                                <button
                                  onClick={() => tx.send(() => pendleStrategy!.deallocateAllFromMarket(pos.market))}
                                  disabled={tx.loading}
                                  className="rounded-lg bg-red-600 px-2 py-1 text-xs font-medium text-white transition hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                  All
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Pool Browser */}
          <div className="card">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold text-gray-300">
                {currentValues.pendleManualMode === "true" ? "Browse & Allocate to PT Pools" : "Available PT Pools"}
              </h3>
              <div className="flex items-center gap-2">
                <select
                  className="input w-24 py-1 text-sm"
                  value={poolCategory}
                  onChange={(e) => setPoolCategory(e.target.value)}
                >
                  <option value="USD">USD</option>
                  <option value="ETH">ETH</option>
                </select>
                <button
                  onClick={() => {
                    setAvailablePools([]);
                    setPoolsLoading(true);
                    // Trigger re-fetch via state change workaround
                    setPoolCategory((c) => c === "USD" ? "USD" : c);
                    // Force reload by toggling — effect depends on pendleSelector
                    if (pendleSelector) {
                      (async () => {
                        try {
                          const markets: string[] = await pendleSelector.getWhitelistedMarkets();
                          const pools: PoolInfo[] = [];
                          for (const addr of markets) {
                            try {
                              const cat = await pendleSelector.marketCategory(addr);
                              const info = await pendleSelector.getMarketInfo(addr);
                              pools.push({
                                market: info.market,
                                pt: info.pt,
                                expiry: Number(info.expiry),
                                timeToExpiry: Number(info.timeToExpiry),
                                tvlSy: info.tvlSy,
                                impliedAPY: Number(info.impliedAPY),
                                score: Number(info.score),
                                category: cat,
                              });
                            } catch {}
                          }
                          pools.sort((a, b) => b.impliedAPY - a.impliedAPY);
                          setAvailablePools(pools);
                        } catch {}
                        setPoolsLoading(false);
                      })();
                    }
                  }}
                  className="rounded-lg bg-gray-700 px-3 py-1 text-sm text-gray-300 hover:bg-gray-600 transition"
                >
                  Refresh
                </button>
              </div>
            </div>

            {poolsLoading && (
              <div className="flex items-center justify-center py-8">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
                <span className="ml-3 text-sm text-gray-400">Loading pools from chain…</span>
              </div>
            )}

            {!poolsLoading && availablePools.length === 0 && (
              <div className="py-6 text-center text-sm text-gray-500">
                {pendleSelector
                  ? "No whitelisted markets found. Add markets to the PendleMarketSelector contract first."
                  : "Set NEXT_PUBLIC_PENDLE_SELECTOR_ADDRESS in .env to browse pools."}
              </div>
            )}

            {!poolsLoading && availablePools.filter((p) => p.category === poolCategory || poolCategory === "").length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-700 text-left text-xs text-gray-500 uppercase">
                      <th className="pb-2 pr-4">Market</th>
                      <th className="pb-2 pr-4 text-right">APY</th>
                      <th className="pb-2 pr-4 text-right">TVL</th>
                      <th className="pb-2 pr-4 text-right">Expiry</th>
                      <th className="pb-2 pr-4 text-right">Days Left</th>
                      {currentValues.pendleManualMode === "true" && (
                        <th className="pb-2 pr-4 text-right">USDC Amount</th>
                      )}
                      <th className="pb-2">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {availablePools
                      .filter((p) => p.category === poolCategory || poolCategory === "")
                      .map((pool) => {
                        const hasPosition = activePositions.some((p) => p.market.toLowerCase() === pool.market.toLowerCase());
                        const isExpired = pool.timeToExpiry <= 0;
                        const daysLeft = Math.floor(pool.timeToExpiry / 86400);
                        const apyPercent = (pool.impliedAPY / 100).toFixed(2);
                        const tvlM = (Number(pool.tvlSy) / 1e12).toFixed(1);

                        return (
                          <tr
                            key={pool.market}
                            className={`border-b border-gray-800 transition ${
                              hasPosition ? "bg-brand-500/10" : "hover:bg-gray-800/50"
                            }`}
                          >
                            <td className="py-3 pr-4">
                              <div className="flex items-center gap-2">
                                {hasPosition && (
                                  <span className="inline-block h-2 w-2 rounded-full bg-brand-400" title="Has active position" />
                                )}
                                <span className="font-mono text-xs text-gray-300">
                                  {pool.market.slice(0, 6)}…{pool.market.slice(-4)}
                                </span>
                              </div>
                              <div className="mt-0.5 font-mono text-[10px] text-gray-600">
                                PT: {pool.pt.slice(0, 6)}…{pool.pt.slice(-4)}
                              </div>
                            </td>
                            <td className="py-3 pr-4 text-right">
                              <span className={`font-semibold ${
                                pool.impliedAPY >= 1200 ? "text-emerald-400" :
                                pool.impliedAPY >= 900 ? "text-green-400" :
                                pool.impliedAPY >= 500 ? "text-yellow-400" : "text-gray-400"
                              }`}>
                                {apyPercent}%
                              </span>
                            </td>
                            <td className="py-3 pr-4 text-right text-gray-300">
                              ${tvlM}M
                            </td>
                            <td className="py-3 pr-4 text-right text-gray-400 text-xs">
                              {new Date(pool.expiry * 1000).toLocaleDateString()}
                            </td>
                            <td className={`py-3 pr-4 text-right font-medium ${
                              isExpired ? "text-red-400" :
                              daysLeft < 7 ? "text-red-400" :
                              daysLeft < 30 ? "text-yellow-400" : "text-gray-300"
                            }`}>
                              {isExpired ? "Expired" : `${daysLeft}d`}
                            </td>
                            {currentValues.pendleManualMode === "true" && (
                              <td className="py-3 pr-4">
                                <input
                                  className="input w-28 py-1 text-right text-sm"
                                  type="number"
                                  placeholder="0.00"
                                  value={allocAmounts[pool.market] || ""}
                                  onChange={(e) => setAllocAmounts((prev) => ({ ...prev, [pool.market]: e.target.value }))}
                                />
                              </td>
                            )}
                            <td className="py-3">
                              {currentValues.pendleManualMode === "true" ? (
                                <button
                                  onClick={() => {
                                    const amt = allocAmounts[pool.market];
                                    if (!amt || parseFloat(amt) <= 0) return;
                                    const usdcWei = BigInt(Math.floor(parseFloat(amt) * 1e6));
                                    tx.send(() => pendleStrategy!.allocateToMarket(pool.market, usdcWei));
                                  }}
                                  disabled={isExpired || !allocAmounts[pool.market] || parseFloat(allocAmounts[pool.market] || "0") <= 0 || tx.loading}
                                  className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                  Allocate
                                </button>
                              ) : (
                                <button
                                  onClick={() => {
                                    setPendleMarketAddr(pool.market);
                                    if (currentValues.pendleManualMode === "true") {
                                      tx.send(() => pendleStrategy!.setMarketManual(pool.market));
                                    }
                                  }}
                                  disabled={isExpired || tx.loading}
                                  className="rounded-lg bg-brand-600 px-3 py-1 text-xs font-medium text-white transition hover:bg-brand-500 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                  Select
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            )}

            {currentValues.pendleManualMode !== "true" && availablePools.length > 0 && (
              <p className="mt-3 text-xs text-yellow-400">
                Enable manual mode above to allocate USDC to individual pools.
              </p>
            )}

            {currentValues.pendleManualMode === "true" && idleUSDC > 0n && (
              <p className="mt-3 text-xs text-blue-400">
                You have <span className="font-semibold">${(Number(idleUSDC) / 1e6).toFixed(2)}</span> idle USDC available to allocate. Enter an amount and click "Allocate" on any pool.
              </p>
            )}

            {currentValues.pendleManualMode === "true" && idleUSDC === 0n && (
              <p className="mt-3 text-xs text-gray-500">
                No idle USDC in strategy. Treasury must deposit first, then you can allocate here.
              </p>
            )}
          </div>

          {/* Manual fallback: paste address */}
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Or Paste Market Address</h3>
            <p className="mb-3 text-sm text-gray-400">
              If the pool you want isn't listed above (not yet whitelisted), paste the Pendle market
              address directly. The market must not be expired.
            </p>
            <div className="flex gap-3">
              <input
                className="input flex-1"
                type="text"
                placeholder="0x... (Pendle market address)"
                value={pendleMarketAddr}
                onChange={(e) => setPendleMarketAddr(e.target.value)}
              />
              <TxButton
                onClick={() => tx.send(() => pendleStrategy!.setMarketManual(pendleMarketAddr))}
                loading={tx.loading}
                disabled={!pendleMarketAddr || currentValues.pendleManualMode !== "true"}
              >
                Set Market
              </TxButton>
            </div>
            {currentValues.pendleManualMode !== "true" && (
              <p className="mt-2 text-xs text-yellow-400">Enable manual mode first to use this.</p>
            )}
          </div>

          {/* Parameters */}
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Strategy Parameters</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="label">Slippage (bps, max 100)</label>
                <input className="input" type="number" placeholder="50" value={pendleSlippage} onChange={(e) => setPendleSlippage(e.target.value)} />
                <TxButton
                  className="mt-2 w-full"
                  onClick={() => tx.send(() => pendleStrategy!.setSlippage(BigInt(pendleSlippage)))}
                  loading={tx.loading}
                  disabled={!pendleSlippage}
                >
                  Set Slippage
                </TxButton>
              </div>
              <div>
                <label className="label">PT Discount (bps, max 5000)</label>
                <input className="input" type="number" placeholder="1000" value={pendleDiscount} onChange={(e) => setPendleDiscount(e.target.value)} />
                <TxButton
                  className="mt-2 w-full"
                  onClick={() => tx.send(() => pendleStrategy!.setPtDiscountRate(BigInt(pendleDiscount)))}
                  loading={tx.loading}
                  disabled={!pendleDiscount}
                >
                  Set Discount
                </TxButton>
              </div>
              <div>
                <label className="label">Rollover Threshold (days)</label>
                <input className="input" type="number" placeholder="7" value={pendleRollover} onChange={(e) => setPendleRollover(e.target.value)} />
                <TxButton
                  className="mt-2 w-full"
                  onClick={() => tx.send(() => pendleStrategy!.setRolloverThreshold(BigInt(parseInt(pendleRollover) * 86400)))}
                  loading={tx.loading}
                  disabled={!pendleRollover}
                >
                  Set Threshold
                </TxButton>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Actions</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <TxButton
                onClick={() => tx.send(() => pendleStrategy!.setActive(true))}
                loading={tx.loading}
              >
                Activate Strategy
              </TxButton>
              <TxButton
                onClick={() => tx.send(() => pendleStrategy!.setActive(false))}
                loading={tx.loading}
                variant="secondary"
              >
                Deactivate Strategy
              </TxButton>
              <TxButton
                onClick={() => tx.send(() => pendleStrategy!.pause())}
                loading={tx.loading}
                variant="danger"
              >
                Pause
              </TxButton>
              <TxButton
                onClick={() => tx.send(() => pendleStrategy!.unpause())}
                loading={tx.loading}
                variant="secondary"
              >
                Unpause (Timelock)
              </TxButton>
            </div>
          </div>
        </div>
      )}

      {/* ===== Morpho Strategy Section ===== */}
      {section === "morpho" && (
        <div className="space-y-4">
          {/* Status Overview */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <StatCard label="Net Value" value={currentValues.morphoNetValue || "..."} subValue="USDC" />
            <StatCard label="Collateral" value={currentValues.morphoCollateral || "..."} subValue="Supplied" color="green" />
            <StatCard label="Borrowed" value={currentValues.morphoBorrowed || "..."} subValue="Debt" color="red" />
            <StatCard label="Health Factor" value={currentValues.morphoHealthFactor || "..."} subValue={currentValues.morphoLeverage || "..."} color={
              currentValues.morphoHealthFactor === "∞" ? "green" :
              parseFloat(currentValues.morphoHealthFactor || "0") > 1.5 ? "green" :
              parseFloat(currentValues.morphoHealthFactor || "0") > 1.1 ? "yellow" : "red"
            } />
            <StatCard
              label="Looping"
              value={currentValues.morphoProfitable === "true" ? "Profitable" : "Unprofitable"}
              subValue={`Borrow: ${currentValues.morphoBorrowRate || "..."}`}
              color={currentValues.morphoProfitable === "true" ? "green" : "red"}
            />
          </div>

          {/* Current Position */}
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Current Position</h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Total Value:</span>
                  <span className="font-semibold text-gray-200">{currentValues.morphoTotalValue || "–"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Principal:</span>
                  <span className="text-gray-200">{currentValues.morphoPrincipal || "–"}</span>
                </div>
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Leverage:</span>
                  <span className="font-semibold text-gray-200">{currentValues.morphoLeverage || "–"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Target LTV:</span>
                  <span className="text-gray-200">{currentValues.morphoTargetLtv || "–"}</span>
                </div>
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Max Borrow Rate:</span>
                  <span className="text-gray-200">{currentValues.morphoMaxBorrowRate || "–"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Safety Buffer:</span>
                  <span className="text-gray-200">{currentValues.morphoSafetyBuffer || "–"}</span>
                </div>
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Active:</span>
                  <span className={currentValues.morphoActive === "true" ? "text-green-400" : "text-red-400"}>
                    {currentValues.morphoActive === "true" ? "Yes" : "No"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Paused:</span>
                  <span className={currentValues.morphoPaused === "true" ? "text-red-400" : "text-green-400"}>
                    {currentValues.morphoPaused === "true" ? "Yes" : "No"}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Market Browser */}
          <div className="card">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold text-gray-300">Morpho Blue Markets</h3>
              <button
                onClick={() => {
                  setMorphoMarkets([]);
                  setMorphoMarketsLoading(true);
                  if (morphoRegistry) {
                    (async () => {
                      try {
                        const infos = await morphoRegistry.getAllMarketInfo();
                        const mkts: MorphoMarketInfo[] = infos.map((m: any) => ({
                          marketId: m.marketId,
                          label: m.label,
                          loanToken: m.loanToken,
                          collateralToken: m.collateralToken,
                          lltv: m.lltv,
                          totalSupplyAssets: m.totalSupplyAssets,
                          totalBorrowAssets: m.totalBorrowAssets,
                          utilizationBps: Number(m.utilizationBps),
                          borrowRateAnnualized: m.borrowRateAnnualized,
                          supplyRateAnnualized: m.supplyRateAnnualized,
                        }));
                        setMorphoMarkets(mkts);
                      } catch {}
                      setMorphoMarketsLoading(false);
                    })();
                  }
                }}
                className="rounded-lg bg-gray-700 px-3 py-1 text-sm text-gray-300 hover:bg-gray-600 transition"
              >
                Refresh
              </button>
            </div>

            {morphoMarketsLoading && (
              <div className="flex items-center justify-center py-8">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
                <span className="ml-3 text-sm text-gray-400">Loading markets from chain…</span>
              </div>
            )}

            {!morphoMarketsLoading && morphoMarkets.length === 0 && (
              <div className="py-6 text-center text-sm text-gray-500">
                {morphoRegistry
                  ? "No whitelisted markets. Add Morpho Blue market IDs below."
                  : "Set NEXT_PUBLIC_MORPHO_REGISTRY_ADDRESS in .env to browse markets."}
              </div>
            )}

            {!morphoMarketsLoading && morphoMarkets.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-700 text-left text-xs text-gray-500 uppercase">
                      <th className="pb-2 pr-4">Market</th>
                      <th className="pb-2 pr-4 text-right">Supply APR</th>
                      <th className="pb-2 pr-4 text-right">Borrow APR</th>
                      <th className="pb-2 pr-4 text-right">Utilization</th>
                      <th className="pb-2 pr-4 text-right">Total Supply</th>
                      <th className="pb-2 pr-4 text-right">Total Borrow</th>
                      <th className="pb-2 pr-4 text-right">LLTV</th>
                    </tr>
                  </thead>
                  <tbody>
                    {morphoMarkets.map((mkt) => {
                      const supplyApr = (Number(mkt.supplyRateAnnualized) / 1e16).toFixed(2);
                      const borrowApr = (Number(mkt.borrowRateAnnualized) / 1e16).toFixed(2);
                      const utilPct = (mkt.utilizationBps / 100).toFixed(1);
                      const lltvPct = (Number(mkt.lltv) / 1e16).toFixed(0);
                      // Assume loan token is USDC (6 decimals) for display
                      const supplyM = (Number(mkt.totalSupplyAssets) / 1e6 / 1e6).toFixed(1);
                      const borrowM = (Number(mkt.totalBorrowAssets) / 1e6 / 1e6).toFixed(1);

                      return (
                        <tr key={mkt.marketId} className="border-b border-gray-800 hover:bg-gray-800/50 transition">
                          <td className="py-3 pr-4">
                            <div className="font-medium text-gray-200 text-xs">{mkt.label || "Unnamed"}</div>
                            <div className="mt-0.5 font-mono text-[10px] text-gray-600">
                              {mkt.marketId.slice(0, 10)}…{mkt.marketId.slice(-6)}
                            </div>
                            <div className="mt-0.5 text-[10px] text-gray-600">
                              Loan: {mkt.loanToken.slice(0, 6)}…{mkt.loanToken.slice(-4)} | Col: {mkt.collateralToken.slice(0, 6)}…{mkt.collateralToken.slice(-4)}
                            </div>
                          </td>
                          <td className="py-3 pr-4 text-right">
                            <span className={`font-semibold ${
                              parseFloat(supplyApr) >= 8 ? "text-emerald-400" :
                              parseFloat(supplyApr) >= 4 ? "text-green-400" :
                              parseFloat(supplyApr) >= 2 ? "text-yellow-400" : "text-gray-400"
                            }`}>
                              {supplyApr}%
                            </span>
                          </td>
                          <td className="py-3 pr-4 text-right">
                            <span className={`font-medium ${
                              parseFloat(borrowApr) > 8 ? "text-red-400" :
                              parseFloat(borrowApr) > 5 ? "text-yellow-400" : "text-gray-300"
                            }`}>
                              {borrowApr}%
                            </span>
                          </td>
                          <td className={`py-3 pr-4 text-right font-medium ${
                            mkt.utilizationBps > 9000 ? "text-red-400" :
                            mkt.utilizationBps > 7500 ? "text-yellow-400" : "text-gray-300"
                          }`}>
                            {utilPct}%
                          </td>
                          <td className="py-3 pr-4 text-right text-gray-300">${supplyM}M</td>
                          <td className="py-3 pr-4 text-right text-gray-300">${borrowM}M</td>
                          <td className="py-3 pr-4 text-right text-gray-400">{lltvPct}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Add Market to Registry */}
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Add Market to Registry</h3>
            <p className="mb-3 text-sm text-gray-400">
              Whitelist a Morpho Blue market ID so it appears in the browser above. Get market IDs from{" "}
              <a href="https://app.morpho.org" target="_blank" rel="noopener noreferrer" className="text-brand-400 hover:underline">
                app.morpho.org
              </a>.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Market ID (bytes32)</label>
                <input
                  className="input"
                  type="text"
                  placeholder="0x..."
                  value={morphoAddMarketId}
                  onChange={(e) => setMorphoAddMarketId(e.target.value)}
                />
              </div>
              <div>
                <label className="label">Label</label>
                <input
                  className="input"
                  type="text"
                  placeholder="USDC/wETH 86% LLTV"
                  value={morphoAddLabel}
                  onChange={(e) => setMorphoAddLabel(e.target.value)}
                />
              </div>
            </div>
            <TxButton
              className="mt-3 w-full"
              onClick={() => tx.send(() => morphoRegistry!.addMarket(morphoAddMarketId, morphoAddLabel))}
              loading={tx.loading}
              disabled={!morphoAddMarketId || !morphoAddLabel}
            >
              Add Market
            </TxButton>
          </div>

          {/* Strategy Parameters */}
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Strategy Parameters</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="label">Target LTV (bps, 5000-8500)</label>
                <input className="input" type="number" placeholder="7000" value={morphoLtvInput} onChange={(e) => setMorphoLtvInput(e.target.value)} />
                <p className="mt-1 text-[10px] text-gray-600">Current: {currentValues.morphoTargetLtv || "..."}</p>
              </div>
              <div>
                <label className="label">Loops (1-5)</label>
                <input className="input" type="number" placeholder="4" value={morphoLoopsInput} onChange={(e) => setMorphoLoopsInput(e.target.value)} />
                <p className="mt-1 text-[10px] text-gray-600">Current: {currentValues.morphoLoops || "..."}</p>
              </div>
              <div>
                <label className="label">Safety Buffer (bps, 200-2000)</label>
                <input className="input" type="number" placeholder="500" value={morphoSafetyInput} onChange={(e) => setMorphoSafetyInput(e.target.value)} />
                <p className="mt-1 text-[10px] text-gray-600">Current: {currentValues.morphoSafetyBuffer || "..."}</p>
              </div>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <TxButton
                onClick={() => tx.send(() => morphoStrategy!.setParameters(BigInt(morphoLtvInput), BigInt(morphoLoopsInput)))}
                loading={tx.loading}
                disabled={!morphoLtvInput || !morphoLoopsInput}
              >
                Set LTV & Loops
              </TxButton>
              <TxButton
                onClick={() => tx.send(() => morphoStrategy!.setSafetyBuffer(BigInt(morphoSafetyInput)))}
                loading={tx.loading}
                disabled={!morphoSafetyInput}
              >
                Set Safety Buffer
              </TxButton>
            </div>
          </div>

          {/* Profitability Thresholds */}
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Profitability Thresholds</h3>
            <p className="mb-3 text-sm text-gray-400">
              Looping is skipped when borrow rate exceeds max threshold. Funds are supplied without leverage in that case.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Max Borrow Rate (%, e.g. 3 = 3%)</label>
                <input className="input" type="number" placeholder="3" value={morphoMaxBorrowInput} onChange={(e) => setMorphoMaxBorrowInput(e.target.value)} />
                <p className="mt-1 text-[10px] text-gray-600">Current: {currentValues.morphoMaxBorrowRate || "..."}</p>
              </div>
              <div>
                <label className="label">Min Supply Rate (%, e.g. 1 = 1%)</label>
                <input className="input" type="number" placeholder="1" value={morphoMinSupplyInput} onChange={(e) => setMorphoMinSupplyInput(e.target.value)} />
              </div>
            </div>
            <TxButton
              className="mt-3 w-full"
              onClick={() => {
                const maxBorrow = BigInt(Math.floor(parseFloat(morphoMaxBorrowInput) * 1e16));
                const minSupply = BigInt(Math.floor(parseFloat(morphoMinSupplyInput) * 1e16));
                tx.send(() => morphoStrategy!.setProfitabilityParams(maxBorrow, minSupply));
              }}
              loading={tx.loading}
              disabled={!morphoMaxBorrowInput || !morphoMinSupplyInput}
            >
              Set Profitability Params
            </TxButton>
          </div>

          {/* Actions */}
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Actions</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <TxButton
                onClick={() => tx.send(() => morphoStrategy!.setActive(true))}
                loading={tx.loading}
              >
                Activate Strategy
              </TxButton>
              <TxButton
                onClick={() => tx.send(() => morphoStrategy!.setActive(false))}
                loading={tx.loading}
                variant="secondary"
              >
                Deactivate Strategy
              </TxButton>
              <TxButton
                onClick={() => tx.send(() => morphoStrategy!.emergencyDeleverage())}
                loading={tx.loading}
                variant="danger"
              >
                Emergency Deleverage
              </TxButton>
              <TxButton
                onClick={() => tx.send(() => morphoStrategy!.pause())}
                loading={tx.loading}
                variant="danger"
              >
                Pause
              </TxButton>
              <TxButton
                onClick={() => tx.send(() => morphoStrategy!.unpause())}
                loading={tx.loading}
                variant="secondary"
              >
                Unpause (Timelock)
              </TxButton>
            </div>
          </div>
        </div>
      )}

      {/* ===== Yield Scanner Section ===== */}
      {section === "yield" && (
        <div className="space-y-4">
          {/* Scanner Header */}
          <div className="card">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-white">⚡ DeFi Yield Scanner</h3>
                <p className="mt-1 text-sm text-gray-400">
                  Hybrid scanner across 50+ active Ethereum DeFi protocols via DeFiLlama indexer with optional on-chain verification.
                </p>
                {yieldDataSource && (
                  <span className={`mt-1 inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-medium ${
                    yieldDataSource === "indexer" ? "bg-emerald-500/20 text-emerald-400" :
                    yieldDataSource === "on-chain" ? "bg-blue-500/20 text-blue-400" :
                    "bg-orange-500/20 text-orange-400"
                  }`}>
                    {yieldDataSource === "indexer" ? "🌐 DeFiLlama Indexer" :
                     yieldDataSource === "on-chain" ? "⛓️ On-Chain" :
                     "🔄 Direct DeFiLlama"}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3">
                {yieldLastScan && (
                  <span className="text-xs text-gray-500">Last scan: {yieldLastScan}</span>
                )}
                <button
                  onClick={async () => {
                    setYieldLoading(true);
                    setYieldScanError("");
                    try {
                      // ── Helper: is this a valid Ethereum address? ──
                      const isEthAddr = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v);

                      // ── Helper: deduplicate by (protocol, venue) ──
                      const dedup = (arr: YieldOpportunity[]) => {
                        const seen = new Set<string>();
                        return arr.filter((o) => {
                          const key = `${o.protocol}::${String(o.venue).toLowerCase()}`;
                          if (seen.has(key)) return false;
                          seen.add(key);
                          return true;
                        });
                      };

                      // Layer 1: Try hybrid API (indexer → DeFiLlama fallback)
                      let apiData: any = null;
                      try {
                        const res = await fetch("/api/yields");
                        if (res.ok) apiData = await res.json();
                      } catch { /* API unavailable, fall through */ }

                      if (apiData?.opportunities?.length) {
                        // Map API response to YieldOpportunity format
                        const opps: YieldOpportunity[] = dedup(apiData.opportunities.map((o: any) => ({
                          protocol: o.protocol ?? o.protocolId ?? 49,
                          risk: o.risk ?? o.riskTier ?? 2,
                          label: o.label || (o.symbol ? `${o.protocolName || o.project} ${o.symbol}` : (o.protocolName || o.project)),
                          venue: o.venue || o.pool || "0x0000000000000000000000000000000000000000",
                          marketId: o.marketId || "0x0000000000000000000000000000000000000000000000000000000000000000",
                          supplyApyBps: BigInt(o.supplyApyBps ?? Math.round((o.apy ?? 0) * 100)),
                          borrowApyBps: BigInt(o.borrowApyBps ?? 0),
                          tvlUsd6: BigInt(Math.round(o.tvlUsd ?? 0)),
                          utilizationBps: BigInt(o.utilizationBps ?? 0),
                          extraData: o.extraData || "0x0000000000000000000000000000000000000000000000000000000000000000",
                          available: o.available ?? true,
                          _poolUUID: o.venue || o.pool || "",  // L-3: preserve DeFiLlama pool UUID
                          _verified: false,                     // C-2: unverified until on-chain check
                          _isResolvableVenue: isEthAddr(o.venue || o.pool || ""), // H-2: venue validation
                        })));

                        // Map tranche data
                        const mapApiTranche = (arr: any[]): TrancheSuggestion[] =>
                          arr.map((s: any, i: number) => ({
                            rank: s.rank ?? (i + 1),
                            tranche: s.tranche ?? 0,
                            protocol: s.protocol ?? s.protocolId ?? 49,
                            label: s.label || (s.symbol ? `${s.protocolName || s.project} ${s.symbol}` : (s.protocolName || s.project)),
                            venue: s.venue || s.pool || "0x0000000000000000000000000000000000000000",
                            marketId: s.marketId || "0x0000000000000000000000000000000000000000000000000000000000000000",
                            supplyApyBps: BigInt(s.supplyApyBps ?? Math.round((s.apy ?? 0) * 100)),
                            borrowApyBps: BigInt(s.borrowApyBps ?? 0),
                            tvlUsd6: BigInt(Math.round(s.tvlUsd ?? 0)),
                            utilizationBps: BigInt(s.utilizationBps ?? 0),
                            risk: s.risk ?? s.riskTier ?? 2,
                            compositeScore: BigInt(Math.round(s.compositeScore ?? 0)),
                            reason: s.reason || `${s.protocolName || s.project} — APY ${((s.supplyApyBps ?? (s.apy ?? 0) * 100) / 100).toFixed(2)}%, TVL $${((s.tvlUsd ?? 0) / 1e6).toFixed(1)}M`,
                            _poolUUID: s.venue || s.pool || "",
                            _verified: false,
                            _isResolvableVenue: isEthAddr(s.venue || s.pool || ""),
                          }));

                        setYieldOpportunities(opps);
                        if (apiData.tranches) {
                          setTrancheSenior(mapApiTranche(apiData.tranches.senior || []));
                          setTrancheMezzanine(mapApiTranche(apiData.tranches.mezzanine || []));
                          setTrancheJunior(mapApiTranche(apiData.tranches.junior || []));
                        }
                        setYieldDataSource(apiData.source === "indexer" ? "indexer" : "direct-defillama");
                        setYieldLastScan(new Date().toLocaleTimeString());
                      } else if (yieldScanner) {
                        // Layer 2 fallback: on-chain YieldScanner for the 9 hardcoded protocols
                        const [scanResult, trancheResult] = await Promise.all([
                          yieldScanner.scanAll(),
                          yieldScanner.getTranches(10),
                        ]);
                        const opps: YieldOpportunity[] = scanResult[0].map((o: any) => ({
                          protocol: Number(o.protocol),
                          risk: Number(o.risk),
                          label: o.label,
                          venue: o.venue,
                          marketId: o.marketId,
                          supplyApyBps: o.supplyApyBps,
                          borrowApyBps: o.borrowApyBps,
                          tvlUsd6: o.tvlUsd6,
                          utilizationBps: o.utilizationBps,
                          extraData: o.extraData,
                          available: o.available,
                          _verified: true,   // on-chain data is inherently verified
                          _isResolvableVenue: true,
                        }));
                        const mapTranche = (arr: any[]): TrancheSuggestion[] =>
                          arr.map((s: any) => ({
                            rank: Number(s.rank),
                            tranche: Number(s.tranche),
                            protocol: Number(s.protocol),
                            label: s.label,
                            venue: s.venue,
                            marketId: s.marketId,
                            supplyApyBps: s.supplyApyBps,
                            borrowApyBps: s.borrowApyBps,
                            tvlUsd6: s.tvlUsd6,
                            utilizationBps: s.utilizationBps,
                            risk: Number(s.risk),
                            compositeScore: s.compositeScore,
                            reason: s.reason,
                            _verified: true,
                            _isResolvableVenue: true,
                          }));
                        setYieldOpportunities(opps);
                        setTrancheSenior(mapTranche(trancheResult[0]));
                        setTrancheMezzanine(mapTranche(trancheResult[1]));
                        setTrancheJunior(mapTranche(trancheResult[2]));
                        setYieldDataSource("on-chain");
                        setYieldLastScan(new Date().toLocaleTimeString());
                      } else {
                        setYieldScanError("No yield data source available — neither API nor on-chain scanner configured.");
                      }
                    } catch (err: any) {
                      console.error("Yield scan failed:", err);
                      setYieldScanError(`Scan failed: ${err.message || "Unknown error"}`);
                    }
                    setYieldLoading(false);
                  }}
                  disabled={yieldLoading}
                  className={`rounded-lg px-5 py-2 font-semibold text-white transition ${
                    yieldLoading
                      ? "bg-gray-600 cursor-not-allowed"
                      : "bg-brand-600 hover:bg-brand-500 shadow-lg shadow-brand-600/30"
                  }`}
                >
                  {yieldLoading ? (
                    <span className="flex items-center gap-2">
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                      Scanning…
                    </span>
                  ) : (
                    "🔍 Scan All Protocols"
                  )}
                </button>
              </div>
            </div>

            {!yieldScanner && !yieldDataSource && (
              <div className="mt-3 rounded-lg bg-blue-500/10 px-4 py-3 text-sm text-blue-400">
                💡 Hybrid mode active — scans via DeFiLlama indexer API. For on-chain fallback, set <code className="rounded bg-gray-800 px-1.5 py-0.5 font-mono text-xs">NEXT_PUBLIC_YIELD_SCANNER_ADDRESS</code> in <code className="rounded bg-gray-800 px-1.5 py-0.5 font-mono text-xs">.env</code>. For on-chain rate verification, set <code className="rounded bg-gray-800 px-1.5 py-0.5 font-mono text-xs">NEXT_PUBLIC_YIELD_VERIFIER_ADDRESS</code>.
              </div>
            )}

            {/* L-2: Error banner */}
            {yieldScanError && (
              <div className="mt-3 rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-red-400 flex items-center justify-between">
                <span>❌ {yieldScanError}</span>
                <button onClick={() => setYieldScanError("")} className="text-red-400/60 hover:text-red-400 text-xs ml-4">✕ Dismiss</button>
              </div>
            )}

            {/* C-2: Unverified data warning when using API sources */}
            {yieldDataSource && yieldDataSource !== "on-chain" && yieldOpportunities.length > 0 && (
              <div className="mt-3 rounded-lg bg-amber-500/10 border border-amber-500/30 px-4 py-3 text-sm text-amber-400">
                ⚠️ <strong>Unverified Data</strong> — Yield rates are from DeFiLlama (off-chain). Deploy with caution.
                {yieldVerifier
                  ? " On-chain YieldVerifier is available — rates will be checked before deployment."
                  : " Set NEXT_PUBLIC_YIELD_VERIFIER_ADDRESS to enable on-chain rate verification before deployment."}
              </div>
            )}
          </div>

          {/* Tranche Suggestions */}
          {(trancheSenior.length > 0 || trancheMezzanine.length > 0 || trancheJunior.length > 0) && (
            <div className="space-y-4">
              <h3 className="flex items-center gap-2 font-semibold text-brand-400 text-lg">
                <span>🏆</span> AI Tranche Suggestions
                <span className="ml-auto text-xs text-gray-500 font-normal">Click a strategy to select &amp; deploy</span>
              </h3>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* ── Senior Tranche ── */}
                <div className="card border border-blue-500/40 bg-gradient-to-b from-blue-500/10 to-transparent flex flex-col">
                  <div className="mb-3 flex items-center gap-2">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/20 text-blue-400 text-lg">🛡️</span>
                    <div>
                      <h4 className="font-bold text-blue-400">Senior Tranche</h4>
                      <p className="text-[10px] text-blue-400/60">Capital Preservation · Lowest Risk</p>
                    </div>
                    {trancheSenior.length > 3 && <span className="ml-auto rounded-full bg-blue-500/20 px-2 py-0.5 text-[10px] font-medium text-blue-400">{trancheSenior.length} strategies ↕</span>}
                  </div>
                  <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1 flex-1" style={{scrollbarWidth: "thin", scrollbarColor: "#3b82f6 transparent"}}>
                    {trancheSenior.length === 0 ? (
                      <p className="text-xs text-gray-500 italic py-8 text-center">No qualifying opportunities</p>
                    ) : trancheSenior.map((sug) => {
                      const isSelected = selectedSuggestion?.venue === sug.venue && selectedSuggestion?.marketId === sug.marketId && selectedSuggestion?.tranche === sug.tranche;
                      return (
                        <div
                          key={`sr-${sug.venue}-${sug.marketId}-${sug.rank}`}
                          onClick={() => { setSelectedSuggestion(sug); setTrancheDepositAmt(""); }}
                          className={`rounded-lg px-3 py-2.5 transition cursor-pointer hover:ring-1 hover:ring-blue-400/50 ${
                            isSelected ? "bg-blue-500/25 border-2 border-blue-400 ring-2 ring-blue-400/30" :
                            sug.rank === 1 ? "bg-blue-500/15 border border-blue-500/30" : "bg-gray-800/60 border border-transparent"
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <div className="flex items-center gap-2">
                              <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                                isSelected ? "bg-blue-400 text-white" : sug.rank === 1 ? "bg-blue-500 text-white" : "bg-gray-700 text-gray-300"
                              }`}>{sug.rank}</span>
                              <span className={`font-semibold text-sm ${getProtocolColor(sug.protocol)}`}>
                                {sug.label || getProtocolName(sug.protocol)}
                              </span>
                              {isSelected && <span className="text-[9px] text-blue-400 font-medium">✓ SELECTED</span>}
                            </div>
                            <span className={`text-sm font-bold ${Number(sug.supplyApyBps) >= 500 ? "text-emerald-400" : "text-green-400"}`}>
                              {(Number(sug.supplyApyBps) / 100).toFixed(2)}%
                            </span>
                          </div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${sug.risk === 0 ? "bg-green-500/20 text-green-400" : sug.risk === 1 ? "bg-yellow-500/20 text-yellow-400" : "bg-red-500/20 text-red-400"}`}>{RISK_LABELS[sug.risk] || "?"}</span>
                            <span className="text-[9px] text-gray-500">TVL ${(Number(sug.tvlUsd6) / 1e6).toFixed(1)}M</span>
                            <span className="text-[9px] text-gray-500">Score {Number(sug.compositeScore).toLocaleString()}</span>
                          </div>
                          <div className="w-full bg-gray-700 rounded-full h-1">
                            <div className="bg-blue-500 h-1 rounded-full" style={{width: `${Math.min(Number(sug.compositeScore) / 100, 100)}%`}}></div>
                          </div>
                          <p className="mt-1 text-[10px] text-gray-500 leading-tight">{sug.reason}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* ── Mezzanine Tranche ── */}
                <div className="card border border-yellow-500/40 bg-gradient-to-b from-yellow-500/10 to-transparent flex flex-col">
                  <div className="mb-3 flex items-center gap-2">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-yellow-500/20 text-yellow-400 text-lg">⚖️</span>
                    <div>
                      <h4 className="font-bold text-yellow-400">Mezzanine Tranche</h4>
                      <p className="text-[10px] text-yellow-400/60">Balanced · Medium Risk / Medium Yield</p>
                    </div>
                    {trancheMezzanine.length > 3 && <span className="ml-auto rounded-full bg-yellow-500/20 px-2 py-0.5 text-[10px] font-medium text-yellow-400">{trancheMezzanine.length} strategies ↕</span>}
                  </div>
                  <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1 flex-1" style={{scrollbarWidth: "thin", scrollbarColor: "#eab308 transparent"}}>
                    {trancheMezzanine.length === 0 ? (
                      <p className="text-xs text-gray-500 italic py-8 text-center">No qualifying opportunities</p>
                    ) : trancheMezzanine.map((sug) => {
                      const isSelected = selectedSuggestion?.venue === sug.venue && selectedSuggestion?.marketId === sug.marketId && selectedSuggestion?.tranche === sug.tranche;
                      return (
                        <div
                          key={`mz-${sug.venue}-${sug.marketId}-${sug.rank}`}
                          onClick={() => { setSelectedSuggestion(sug); setTrancheDepositAmt(""); }}
                          className={`rounded-lg px-3 py-2.5 transition cursor-pointer hover:ring-1 hover:ring-yellow-400/50 ${
                            isSelected ? "bg-yellow-500/25 border-2 border-yellow-400 ring-2 ring-yellow-400/30" :
                            sug.rank === 1 ? "bg-yellow-500/15 border border-yellow-500/30" : "bg-gray-800/60 border border-transparent"
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <div className="flex items-center gap-2">
                              <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                                isSelected ? "bg-yellow-400 text-white" : sug.rank === 1 ? "bg-yellow-500 text-white" : "bg-gray-700 text-gray-300"
                              }`}>{sug.rank}</span>
                              <span className={`font-semibold text-sm ${getProtocolColor(sug.protocol)}`}>
                                {sug.label || getProtocolName(sug.protocol)}
                              </span>
                              {isSelected && <span className="text-[9px] text-yellow-400 font-medium">✓ SELECTED</span>}
                            </div>
                            <span className={`text-sm font-bold ${Number(sug.supplyApyBps) >= 800 ? "text-emerald-400" : Number(sug.supplyApyBps) >= 400 ? "text-green-400" : "text-yellow-400"}`}>
                              {(Number(sug.supplyApyBps) / 100).toFixed(2)}%
                            </span>
                          </div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${sug.risk === 0 ? "bg-green-500/20 text-green-400" : sug.risk === 1 ? "bg-yellow-500/20 text-yellow-400" : "bg-red-500/20 text-red-400"}`}>{RISK_LABELS[sug.risk] || "?"}</span>
                            <span className="text-[9px] text-gray-500">TVL ${(Number(sug.tvlUsd6) / 1e6).toFixed(1)}M</span>
                            <span className="text-[9px] text-gray-500">Score {Number(sug.compositeScore).toLocaleString()}</span>
                          </div>
                          <div className="w-full bg-gray-700 rounded-full h-1">
                            <div className="bg-yellow-500 h-1 rounded-full" style={{width: `${Math.min(Number(sug.compositeScore) / 100, 100)}%`}}></div>
                          </div>
                          <p className="mt-1 text-[10px] text-gray-500 leading-tight">{sug.reason}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* ── Junior Tranche ── */}
                <div className="card border border-red-500/40 bg-gradient-to-b from-red-500/10 to-transparent flex flex-col">
                  <div className="mb-3 flex items-center gap-2">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500/20 text-red-400 text-lg">🔥</span>
                    <div>
                      <h4 className="font-bold text-red-400">Junior Tranche</h4>
                      <p className="text-[10px] text-red-400/60">Yield Maximization · Higher Risk</p>
                    </div>
                    {trancheJunior.length > 3 && <span className="ml-auto rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] font-medium text-red-400">{trancheJunior.length} strategies ↕</span>}
                  </div>
                  <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1 flex-1" style={{scrollbarWidth: "thin", scrollbarColor: "#ef4444 transparent"}}>
                    {trancheJunior.length === 0 ? (
                      <p className="text-xs text-gray-500 italic py-8 text-center">No qualifying opportunities</p>
                    ) : trancheJunior.map((sug) => {
                      const isSelected = selectedSuggestion?.venue === sug.venue && selectedSuggestion?.marketId === sug.marketId && selectedSuggestion?.tranche === sug.tranche;
                      return (
                        <div
                          key={`jr-${sug.venue}-${sug.marketId}-${sug.rank}`}
                          onClick={() => { setSelectedSuggestion(sug); setTrancheDepositAmt(""); }}
                          className={`rounded-lg px-3 py-2.5 transition cursor-pointer hover:ring-1 hover:ring-red-400/50 ${
                            isSelected ? "bg-red-500/25 border-2 border-red-400 ring-2 ring-red-400/30" :
                            sug.rank === 1 ? "bg-red-500/15 border border-red-500/30" : "bg-gray-800/60 border border-transparent"
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <div className="flex items-center gap-2">
                              <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                                isSelected ? "bg-red-400 text-white" : sug.rank === 1 ? "bg-red-500 text-white" : "bg-gray-700 text-gray-300"
                              }`}>{sug.rank}</span>
                              <span className={`font-semibold text-sm ${getProtocolColor(sug.protocol)}`}>
                                {sug.label || getProtocolName(sug.protocol)}
                              </span>
                              {isSelected && <span className="text-[9px] text-red-400 font-medium">✓ SELECTED</span>}
                            </div>
                            <span className={`text-sm font-bold ${Number(sug.supplyApyBps) >= 1000 ? "text-emerald-400" : Number(sug.supplyApyBps) >= 500 ? "text-green-400" : "text-yellow-400"}`}>
                              {(Number(sug.supplyApyBps) / 100).toFixed(2)}%
                            </span>
                          </div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${sug.risk === 0 ? "bg-green-500/20 text-green-400" : sug.risk === 1 ? "bg-yellow-500/20 text-yellow-400" : "bg-red-500/20 text-red-400"}`}>{RISK_LABELS[sug.risk] || "?"}</span>
                            <span className="text-[9px] text-gray-500">TVL ${(Number(sug.tvlUsd6) / 1e6).toFixed(1)}M</span>
                            <span className="text-[9px] text-gray-500">Score {Number(sug.compositeScore).toLocaleString()}</span>
                          </div>
                          <div className="w-full bg-gray-700 rounded-full h-1">
                            <div className="bg-red-500 h-1 rounded-full" style={{width: `${Math.min(Number(sug.compositeScore) / 100, 100)}%`}}></div>
                          </div>
                          <p className="mt-1 text-[10px] text-gray-500 leading-tight">{sug.reason}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* ── Deploy Panel (appears when a suggestion is selected) ── */}
              {selectedSuggestion && (() => {
                const sel = selectedSuggestion;
                const trancheLabel = TRANCHE_NAMES[sel.tranche] || "Unknown";
                const trancheIcon = sel.tranche === 0 ? "🛡️" : sel.tranche === 1 ? "⚖️" : "🔥";
                const borderColor = sel.tranche === 0 ? "border-blue-500/50" : sel.tranche === 1 ? "border-yellow-500/50" : "border-red-500/50";
                const accentText = sel.tranche === 0 ? "text-blue-400" : sel.tranche === 1 ? "text-yellow-400" : "text-red-400";
                const accentBg = sel.tranche === 0 ? "bg-blue-600 hover:bg-blue-500" : sel.tranche === 1 ? "bg-yellow-600 hover:bg-yellow-500" : "bg-red-600 hover:bg-red-500";
                const accentBadge = sel.tranche === 0 ? "bg-blue-500/20 text-blue-400" : sel.tranche === 1 ? "bg-yellow-500/20 text-yellow-400" : "bg-red-500/20 text-red-400";
                // H-2: Check if venue is a valid Ethereum address (not a DeFiLlama UUID)
                const venueIsEthAddr = /^0x[0-9a-fA-F]{40}$/.test(sel.venue);
                const isVerified = (sel as any)._verified === true;
                // Find matching registered strategy
                const matchedStrategy = registeredStrategies.find((s) => {
                  const stratKey = PROTOCOL_STRATEGY_KEYS[sel.protocol];
                  if (!stratKey) return false;
                  const configAddr = CONTRACTS[stratKey];
                  return configAddr && s.address.toLowerCase() === configAddr.toLowerCase() && s.active;
                });
                // C-2 + H-2: Require verified data AND valid venue address for deployment
                const canDeploy = !!matchedStrategy && !!treasury && !!trancheDepositAmt
                  && parseFloat(trancheDepositAmt) > 0 && venueIsEthAddr;

                return (
                  <div className={`card border-2 ${borderColor} bg-gray-900/80 backdrop-blur`}>
                    <div className="flex flex-col lg:flex-row lg:items-start gap-4">
                      {/* Selected strategy info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-lg">{trancheIcon}</span>
                          <h4 className={`font-bold ${accentText}`}>
                            Deploy to: {sel.label || PROTOCOL_NAMES[sel.protocol]}
                          </h4>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${accentBadge}`}>
                            {trancheLabel} Tranche
                          </span>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                          <div>
                            <span className="text-gray-500">Supply APY</span>
                            <p className="font-bold text-emerald-400">{(Number(sel.supplyApyBps) / 100).toFixed(2)}%</p>
                          </div>
                          <div>
                            <span className="text-gray-500">Borrow APY</span>
                            <p className="font-bold text-orange-400">{(Number(sel.borrowApyBps) / 100).toFixed(2)}%</p>
                          </div>
                          <div>
                            <span className="text-gray-500">TVL</span>
                            <p className="font-bold text-gray-300">${(Number(sel.tvlUsd6) / 1e6).toFixed(2)}M</p>
                          </div>
                          <div>
                            <span className="text-gray-500">Utilization</span>
                            <p className="font-bold text-gray-300">{(Number(sel.utilizationBps) / 100).toFixed(1)}%</p>
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-gray-500">
                          <span>Venue: <code className="rounded bg-gray-800 px-1 py-0.5 font-mono text-[9px]">{sel.venue}</code></span>
                          {sel.marketId !== "0x0000000000000000000000000000000000000000000000000000000000000000" && (
                            <span>Market: <code className="rounded bg-gray-800 px-1 py-0.5 font-mono text-[9px]">{sel.marketId.slice(0, 10)}...</code></span>
                          )}
                          {/* C-2: Verification badge */}
                          {isVerified ? (
                            <span className="rounded-full bg-green-500/20 px-2 py-0.5 text-green-400 font-medium">✓ Verified</span>
                          ) : (
                            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-amber-400 font-medium">⚠️ Unverified</span>
                          )}
                          {/* H-2: Venue address badge */}
                          {!venueIsEthAddr && (
                            <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-red-400 font-medium">🚫 Non-Ethereum venue</span>
                          )}
                        </div>
                        {/* H-2: Venue resolution warning */}
                        {!venueIsEthAddr && (
                          <div className="mt-2 rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2 text-[10px] text-red-400">
                            Venue &quot;{sel.venue.slice(0, 20)}...&quot; is a DeFiLlama pool UUID, not an Ethereum address. Deployment is blocked until the venue is resolved to a contract address.
                          </div>
                        )}
                        <p className="mt-1 text-xs text-gray-400 italic">{sel.reason}</p>
                      </div>

                      {/* Deposit controls */}
                      <div className="lg:w-72 shrink-0 space-y-3">
                        {matchedStrategy ? (
                          <>
                            <div className="rounded-lg bg-gray-800/80 px-3 py-2 text-xs">
                              <div className="flex justify-between text-gray-400">
                                <span>Strategy</span>
                                <span className="font-mono text-[10px]">{matchedStrategy.address.slice(0, 6)}...{matchedStrategy.address.slice(-4)}</span>
                              </div>
                              <div className="flex justify-between text-gray-400 mt-1">
                                <span>Deployed</span>
                                <span className="text-gray-300">${(Number(matchedStrategy.currentValue) / 1e6).toLocaleString(undefined, {minimumFractionDigits: 2})}</span>
                              </div>
                              <div className="flex justify-between text-gray-400 mt-1">
                                <span>Reserve Available</span>
                                <span className="text-gray-300">{currentValues.treasuryReserve || "..."}</span>
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <div className="relative flex-1">
                                <input
                                  type="number"
                                  placeholder="USDC amount"
                                  value={trancheDepositAmt}
                                  onChange={(e) => setTrancheDepositAmt(e.target.value)}
                                  className="input w-full py-2 pr-14 text-right text-sm"
                                  min="0"
                                  step="100"
                                />
                                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-500">USDC</span>
                              </div>
                              <button
                                onClick={async () => {
                                  if (!canDeploy) return;
                                  setTrancheDepositing(true);
                                  try {
                                    const usdcWei = BigInt(Math.floor(parseFloat(trancheDepositAmt) * 1e6));
                                    await tx.send(() => treasury!.deployToStrategy(matchedStrategy.address, usdcWei));
                                    setTrancheDepositAmt("");
                                    setSelectedSuggestion(null);
                                  } catch (err) {
                                    console.error("Deploy failed:", err);
                                  }
                                  setTrancheDepositing(false);
                                }}
                                disabled={!canDeploy || trancheDepositing || tx.loading}
                                className={`rounded-lg px-5 py-2 font-semibold text-white transition whitespace-nowrap ${
                                  canDeploy && !trancheDepositing ? accentBg : "bg-gray-600 cursor-not-allowed opacity-50"
                                }`}
                              >
                                {trancheDepositing ? (
                                  <span className="flex items-center gap-2">
                                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                                    Deploying...
                                  </span>
                                ) : "Deploy"}
                              </button>
                            </div>
                          </>
                        ) : strategyFactory ? (
                          /* ── Auto-Deploy via StrategyFactory ──────────── */
                          <div className="space-y-2">
                            <div className="rounded-lg bg-purple-500/10 border border-purple-500/30 px-3 py-2 text-xs text-purple-300">
                              <p className="font-medium mb-1">🏭 Auto-Deploy Available</p>
                              <p className="text-[10px] text-purple-300/70">
                                Deploy a {PROTOCOL_NAMES[sel.protocol]} strategy adapter and register it in Treasury in one transaction.
                              </p>
                            </div>
                            <div className="grid grid-cols-3 gap-2">
                              <div>
                                <label className="text-[10px] text-gray-500 block mb-0.5">Target %</label>
                                <input type="number" placeholder="20" min="1" max="100" step="1"
                                  className="input w-full py-1 text-xs text-center" id="autoDeploy-target" defaultValue="20" />
                              </div>
                              <div>
                                <label className="text-[10px] text-gray-500 block mb-0.5">Min %</label>
                                <input type="number" placeholder="5" min="0" max="100" step="1"
                                  className="input w-full py-1 text-xs text-center" id="autoDeploy-min" defaultValue="5" />
                              </div>
                              <div>
                                <label className="text-[10px] text-gray-500 block mb-0.5">Max %</label>
                                <input type="number" placeholder="50" min="1" max="100" step="1"
                                  className="input w-full py-1 text-xs text-center" id="autoDeploy-max" defaultValue="50" />
                              </div>
                            </div>
                            <button
                              onClick={async () => {
                                if (!strategyFactory || !treasury) return;
                                setAutoDeploying(true);
                                try {
                                  const targetEl = document.getElementById("autoDeploy-target") as HTMLInputElement;
                                  const minEl = document.getElementById("autoDeploy-min") as HTMLInputElement;
                                  const maxEl = document.getElementById("autoDeploy-max") as HTMLInputElement;
                                  const targetBps = BigInt(Math.round(parseFloat(targetEl?.value || "20") * 100));
                                  const minBps = BigInt(Math.round(parseFloat(minEl?.value || "5") * 100));
                                  const maxBps = BigInt(Math.round(parseFloat(maxEl?.value || "50") * 100));

                                  // Build protocol-specific initData
                                  // Each strategy has its own initialize() signature
                                  const treasuryAddr = await treasury.getAddress();
                                  const usdcAddr = CONTRACTS.USDC;
                                  const adminAddr = address; // connected wallet = admin
                                  const timelockAddr = address; // use admin as timelock for now

                                  let initData: string;
                                  const iface = new ethers.Interface([
                                    "function initialize(address,address,bytes32,address,address,address)",   // MorphoLoop
                                    "function initialize(address,address,address,address,address,address,address)", // Sky
                                  ]);
                                  if (sel.protocol === 2) {
                                    // Morpho: initialize(usdc, morpho, marketId, treasury, admin, timelock)
                                    const morphoAddr = CONTRACTS.MorphoStrategy; // or use a known Morpho Blue address
                                    initData = iface.encodeFunctionData(
                                      "initialize(address,address,bytes32,address,address,address)",
                                      [usdcAddr, morphoAddr, sel.marketId, treasuryAddr, adminAddr, timelockAddr]
                                    );
                                  } else if (sel.protocol === 4) {
                                    // Sky: initialize(usdc, usds, psm, sUsds, treasury, admin, timelock)
                                    initData = iface.encodeFunctionData(
                                      "initialize(address,address,address,address,address,address,address)",
                                      [usdcAddr, ethers.ZeroAddress, ethers.ZeroAddress, sel.venue, treasuryAddr, adminAddr, timelockAddr]
                                    );
                                  } else {
                                    // Generic fallback: just encode a minimal initialize(treasury)
                                    const genericIface = new ethers.Interface(["function initialize(address)"]);
                                    initData = genericIface.encodeFunctionData("initialize", [treasuryAddr]);
                                  }

                                  await tx.send(() =>
                                    strategyFactory.deployAndRegister(
                                      BigInt(sel.protocol),
                                      initData,
                                      targetBps,
                                      minBps,
                                      maxBps,
                                      true // autoAllocate
                                    )
                                  );

                                  // Refresh strategies list
                                  if (treasury) {
                                    try {
                                      const count = await treasury.strategyCount();
                                      const strats: typeof registeredStrategies = [];
                                      for (let i = 0; i < Number(count); i++) {
                                        const info = await treasury.strategies(i);
                                        strats.push({
                                          address: info.strategy || info[0],
                                          targetBps: Number(info.targetBps ?? info[1]),
                                          currentValue: Number(info.currentValue ?? info[2]),
                                          active: info.active ?? info[3],
                                        });
                                      }
                                      setRegisteredStrategies(strats);
                                    } catch {}
                                  }
                                  setSelectedSuggestion(null);
                                } catch (err) {
                                  console.error("Auto-deploy failed:", err);
                                }
                                setAutoDeploying(false);
                              }}
                              disabled={autoDeploying || tx.loading}
                              className={`w-full rounded-lg px-4 py-2 font-semibold text-white transition ${
                                autoDeploying ? "bg-gray-600 cursor-not-allowed opacity-50" : "bg-purple-600 hover:bg-purple-500"
                              }`}
                            >
                              {autoDeploying ? (
                                <span className="flex items-center justify-center gap-2">
                                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                                  Deploying & Registering...
                                </span>
                              ) : (
                                "🚀 Auto-Deploy & Register"
                              )}
                            </button>
                          </div>
                        ) : (
                          <div className="rounded-lg bg-yellow-500/10 px-3 py-3 text-xs text-yellow-400">
                            <p className="font-medium mb-1">⚠️ No registered strategy</p>
                            <p className="text-[10px] text-yellow-400/70">
                              {PROTOCOL_NAMES[sel.protocol]} does not have a registered Treasury strategy.
                              Deploy a StrategyFactory or register one in the Strategy Management section above.
                            </p>
                          </div>
                        )}
                        <button
                          onClick={() => { setSelectedSuggestion(null); setTrancheDepositAmt(""); }}
                          className="w-full rounded-lg bg-gray-700 px-3 py-1.5 text-xs text-gray-400 transition hover:bg-gray-600 hover:text-gray-300"
                        >
                          ✕ Deselect
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          {/* Filters & Sort */}
          {yieldOpportunities.length > 0 && (
            <div className="card">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm font-medium text-gray-400">Filter:</span>

                {/* Risk filter */}
                <div className="flex gap-1">
                  <button
                    onClick={() => setYieldRiskFilter(null)}
                    className={`rounded-lg px-3 py-1 text-xs transition ${
                      yieldRiskFilter === null ? "bg-brand-600 text-white" : "bg-gray-700 text-gray-400 hover:bg-gray-600"
                    }`}
                  >
                    All Risk
                  </button>
                  {RISK_LABELS.slice(0, 3).map((label, i) => (
                    <button
                      key={label}
                      onClick={() => setYieldRiskFilter(yieldRiskFilter === i ? null : i)}
                      className={`rounded-lg px-3 py-1 text-xs transition ${
                        yieldRiskFilter === i ? "bg-brand-600 text-white" : "bg-gray-700 text-gray-400 hover:bg-gray-600"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="h-4 w-px bg-gray-700" />

                {/* Protocol filter */}
                <div className="flex flex-wrap gap-1">
                  <button
                    onClick={() => setYieldProtocolFilter(null)}
                    className={`rounded-lg px-3 py-1 text-xs transition ${
                      yieldProtocolFilter === null ? "bg-brand-600 text-white" : "bg-gray-700 text-gray-400 hover:bg-gray-600"
                    }`}
                  >
                    All Protocols
                  </button>
                  {Object.entries(PROTOCOL_NAMES).map(([idStr, name]) => {
                    const id = Number(idStr);
                    const has = yieldOpportunities.some((o) => o.protocol === id);
                    if (!has) return null;
                    return (
                      <button
                        key={id}
                        onClick={() => setYieldProtocolFilter(yieldProtocolFilter === id ? null : id)}
                        className={`rounded-lg px-3 py-1 text-xs transition ${
                          yieldProtocolFilter === id ? "bg-brand-600 text-white" : "bg-gray-700 text-gray-400 hover:bg-gray-600"
                        }`}
                      >
                        {name}
                      </button>
                    );
                  })}
                </div>

                <div className="h-4 w-px bg-gray-700" />

                {/* Leverage filter */}
                <button
                  onClick={() => setShowLeveragedOnly(!showLeveragedOnly)}
                  className={`rounded-lg px-3 py-1 text-xs transition flex items-center gap-1 ${
                    showLeveragedOnly ? "bg-purple-600 text-white" : "bg-gray-700 text-gray-400 hover:bg-gray-600"
                  }`}
                >
                  🔄 Leveraged
                </button>

                <div className="ml-auto flex gap-1">
                  <span className="text-sm text-gray-400">Sort:</span>
                  {(["apy", "tvl", "risk"] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => setYieldSortBy(s)}
                      className={`rounded-lg px-3 py-1 text-xs transition ${
                        yieldSortBy === s ? "bg-brand-600 text-white" : "bg-gray-700 text-gray-400 hover:bg-gray-600"
                      }`}
                    >
                      {s === "apy" ? "APY ↓" : s === "tvl" ? "TVL ↓" : "Risk ↑"}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Opportunities Table */}
          {yieldLoading && (
            <div className="card flex items-center justify-center py-12">
              <div className="h-8 w-8 animate-spin rounded-full border-3 border-brand-500 border-t-transparent" />
              <span className="ml-4 text-gray-400">Querying 9 DeFi protocols on-chain…</span>
            </div>
          )}

          {!yieldLoading && yieldOpportunities.length > 0 && (() => {
            let filtered = yieldOpportunities.filter((o) => {
              if (yieldRiskFilter !== null && o.risk !== yieldRiskFilter) return false;
              if (yieldProtocolFilter !== null && o.protocol !== yieldProtocolFilter) return false;
              if (showLeveragedOnly && !o.isLeveraged) return false;
              return true;
            });

            // Sort
            filtered = [...filtered].sort((a, b) => {
              if (yieldSortBy === "apy") return Number(b.supplyApyBps) - Number(a.supplyApyBps);
              if (yieldSortBy === "tvl") return Number(b.tvlUsd6) - Number(a.tvlUsd6);
              return a.risk - b.risk;
            });

            return (
              <div className="card">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="font-semibold text-gray-300">
                    All Opportunities ({filtered.length} of {yieldOpportunities.length})
                  </h3>
                  <div className="flex items-center gap-4 text-xs text-gray-500">
                    {/* Protocol distribution */}
                    {Object.entries(PROTOCOL_NAMES).map(([idStr, name]) => {
                      const id = Number(idStr);
                      const count = yieldOpportunities.filter((o) => o.protocol === id).length;
                      if (count === 0) return null;
                      return (
                        <span key={id} className={getProtocolColor(id)}>
                          {name}: {count}
                        </span>
                      );
                    })}
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-700 text-left text-xs text-gray-500 uppercase">
                        <th className="pb-2 pr-3">#</th>
                        <th className="pb-2 pr-4">Protocol</th>
                        <th className="pb-2 pr-4">Opportunity</th>
                        <th className="pb-2 pr-4 text-center">Risk</th>
                        <th className="pb-2 pr-4 text-right">Supply APY</th>
                        <th className="pb-2 pr-4 text-right">Borrow APY</th>
                        <th className="pb-2 pr-4 text-right">TVL</th>
                        <th className="pb-2 pr-4 text-right">Utilization</th>
                        <th className="pb-2 text-center">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((opp, idx) => {
                        const supplyApy = (Number(opp.supplyApyBps) / 100).toFixed(2);
                        const borrowApy = (Number(opp.borrowApyBps) / 100).toFixed(2);
                        const utilPct = (Number(opp.utilizationBps) / 100).toFixed(1);
                        const tvlM = Number(opp.tvlUsd6) > 0
                          ? `$${(Number(opp.tvlUsd6) / 1e6 / 1e6).toFixed(1)}M`
                          : "–";

                        return (
                          <tr
                            key={`${opp.venue}-${opp.marketId}-${idx}`}
                            className={`border-b border-gray-800 transition ${
                              idx === 0 && yieldSortBy === "apy"
                                ? "bg-brand-500/5"
                                : "hover:bg-gray-800/50"
                            }`}
                          >
                            <td className="py-3 pr-3 text-gray-600 text-xs">{idx + 1}</td>
                            <td className="py-3 pr-4">
                              <span className={`font-medium ${getProtocolColor(opp.protocol)}`}>
                                {getProtocolName(opp.protocol, `ID:${opp.protocol}`)}
                              </span>
                            </td>
                            <td className="py-3 pr-4">
                              <div className="text-gray-200 text-xs font-medium flex items-center gap-1.5">
                                {opp.label}
                                {opp.isLeveraged && (
                                  <span className="rounded-full bg-purple-500/20 px-1.5 py-0.5 text-[9px] font-bold text-purple-400 border border-purple-500/30">
                                    🔄 {opp.leverageMultiplier?.toFixed(1)}x Loop
                                  </span>
                                )}
                                {opp.merklApyBps && opp.merklApyBps > 0 && (
                                  <span className="rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[9px] font-medium text-blue-400">
                                    +Merkl
                                  </span>
                                )}
                              </div>
                              <div className="mt-0.5 font-mono text-[10px] text-gray-600">
                                {opp.venue.slice(0, 6)}…{opp.venue.slice(-4)}
                                {opp.marketId !== "0x0000000000000000000000000000000000000000000000000000000000000000" && (
                                  <span className="ml-1">| {opp.marketId.slice(0, 8)}…</span>
                                )}
                              </div>
                            </td>
                            <td className="py-3 pr-4 text-center">
                              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                                opp.risk === 0 ? "bg-green-500/20 text-green-400" :
                                opp.risk === 1 ? "bg-yellow-500/20 text-yellow-400" :
                                opp.risk === 2 ? "bg-red-500/20 text-red-400" :
                                "bg-gray-500/20 text-gray-400"
                              }`}>
                                {RISK_LABELS[opp.risk] || "?"}
                              </span>
                            </td>
                            <td className="py-3 pr-4 text-right">
                              <span className={`font-bold ${
                                Number(opp.supplyApyBps) >= 800 ? "text-emerald-400" :
                                Number(opp.supplyApyBps) >= 400 ? "text-green-400" :
                                Number(opp.supplyApyBps) >= 200 ? "text-yellow-400" :
                                Number(opp.supplyApyBps) > 0 ? "text-gray-300" : "text-gray-600"
                              }`}>
                                {Number(opp.supplyApyBps) > 0 ? `${supplyApy}%` : "–"}
                              </span>
                              {opp.isLeveraged && opp.effectiveApyBps !== undefined && (
                                <div className="text-[9px] text-purple-400 mt-0.5">
                                  Net: {(opp.effectiveApyBps / 100).toFixed(2)}%
                                  {opp.merklApyBps ? ` (+${(opp.merklApyBps / 100).toFixed(1)}% Merkl)` : ""}
                                </div>
                              )}
                            </td>
                            <td className="py-3 pr-4 text-right">
                              <span className={Number(opp.borrowApyBps) > 0 ? "text-red-400" : "text-gray-600"}>
                                {Number(opp.borrowApyBps) > 0 ? `${borrowApy}%` : "–"}
                              </span>
                            </td>
                            <td className="py-3 pr-4 text-right text-gray-300">
                              {tvlM}
                            </td>
                            <td className="py-3 pr-4 text-right">
                              {Number(opp.utilizationBps) > 0 ? (
                                <div className="flex items-center justify-end gap-2">
                                  <div className="h-1.5 w-16 overflow-hidden rounded-full bg-gray-700">
                                    <div
                                      className={`h-full rounded-full ${
                                        Number(opp.utilizationBps) > 9000 ? "bg-red-500" :
                                        Number(opp.utilizationBps) > 7500 ? "bg-yellow-500" :
                                        "bg-green-500"
                                      }`}
                                      style={{ width: `${Math.min(Number(opp.utilizationBps) / 100, 100)}%` }}
                                    />
                                  </div>
                                  <span className="text-xs text-gray-400">{utilPct}%</span>
                                </div>
                              ) : (
                                <span className="text-gray-600">–</span>
                              )}
                            </td>
                            <td className="py-3 text-center">
                              <span className={`text-xs ${opp.available ? "text-green-400" : "text-gray-600"}`}>
                                {opp.available ? "✓ Open" : "✗ Closed"}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}

          {!yieldLoading && yieldOpportunities.length === 0 && yieldScanner && (
            <div className="card py-12 text-center">
              <div className="text-4xl">🔍</div>
              <p className="mt-3 text-gray-400">
                No yield data yet. Click <span className="font-semibold text-brand-400">"Scan All Protocols"</span> to query on-chain rates across 9 DeFi protocols.
              </p>
            </div>
          )}

          {/* Protocol Configuration */}
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Protocol Configuration</h3>
            <p className="mb-3 text-sm text-gray-400">
              Set external protocol addresses so the scanner knows where to query. Only addresses set to non-zero will be included in scans.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                { label: "Aave V3 Pool", fn: "configureAaveV3", current: "aaveV3Pool" },
                { label: "Compound V3 Comet (cUSDCv3)", fn: "configureCompoundV3", current: "compoundComet" },
                { label: "Spark Pool", fn: "configureSpark", current: "sparkPool" },
                { label: "Sky sUSDS Vault", fn: "configureSkySUSDS", current: "sUsdsVault" },
                { label: "Ethena sUSDe Vault", fn: "configureEthenaSUSDe", current: "sUsdeVault" },
                { label: "Yearn V3 USDC Vault", fn: "configureYearnV3", current: "yearnVault" },
              ].map(({ label, fn }) => (
                <div key={fn}>
                  <label className="label">{label}</label>
                  <div className="flex gap-2">
                    <input
                      className="input flex-1"
                      type="text"
                      placeholder="0x..."
                      value={yieldConfigProtocol === fn ? yieldConfigAddr : ""}
                      onChange={(e) => {
                        setYieldConfigProtocol(fn);
                        setYieldConfigAddr(e.target.value);
                      }}
                    />
                    <TxButton
                      onClick={() => tx.send(() => (yieldScanner as any)[fn](yieldConfigAddr))}
                      loading={tx.loading}
                      disabled={!yieldConfigAddr || yieldConfigProtocol !== fn}
                    >
                      Set
                    </TxButton>
                  </div>
                </div>
              ))}
            </div>

            {/* Morpho + Pendle use dual-address or existing contracts */}
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Morpho Blue + Registry</label>
                <TxButton
                  className="w-full"
                  onClick={() => {
                    const morphoAddr = currentValues.morphoBlueAddr || "";
                    const regAddr = currentValues.morphoRegistryAddr || "";
                    tx.send(() => yieldScanner!.configureMorpho(morphoAddr, regAddr));
                  }}
                  loading={tx.loading}
                  disabled={!yieldScanner}
                >
                  Auto-link from existing config
                </TxButton>
              </div>
              <div>
                <label className="label">Pendle Market Selector</label>
                <TxButton
                  className="w-full"
                  onClick={() => {
                    const selAddr = currentValues.pendleSelectorAddr || "";
                    tx.send(() => yieldScanner!.configurePendle(selAddr));
                  }}
                  loading={tx.loading}
                  disabled={!yieldScanner}
                >
                  Auto-link from existing config
                </TxButton>
              </div>
            </div>
          </div>

          {/* Summary Stats */}
          {yieldOpportunities.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label="Protocols Scanned"
                value={String(new Set(yieldOpportunities.map((o) => o.protocol)).size)}
                subValue={`of ${PROTOCOL_NAMES.length} configured`}
              />
              <StatCard
                label="Opportunities Found"
                value={String(yieldOpportunities.length)}
                subValue={`${yieldOpportunities.filter((o) => o.available).length} accepting deposits`}
                color="green"
              />
              <StatCard
                label="Best Supply APY"
                value={
                  (Number(
                    yieldOpportunities.reduce(
                      (best, o) => (Number(o.supplyApyBps) > Number(best) ? o.supplyApyBps : best),
                      0n
                    )
                  ) / 100).toFixed(2) + "%"
                }
                subValue={
                  yieldOpportunities.reduce(
                    (best, o) => (Number(o.supplyApyBps) > Number(best.supplyApyBps) ? o : best),
                    yieldOpportunities[0]
                  ).label
                }
                color="green"
              />
              <StatCard
                label="Avg Supply APY"
                value={
                  (() => {
                    const withApy = yieldOpportunities.filter((o) => Number(o.supplyApyBps) > 0);
                    if (withApy.length === 0) return "–";
                    const avg = withApy.reduce((s, o) => s + Number(o.supplyApyBps), 0) / withApy.length;
                    return (avg / 100).toFixed(2) + "%";
                  })()
                }
                subValue="Across all sources"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default AdminPage;
