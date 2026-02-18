import React, { useState, useEffect } from "react";
import { ethers } from "ethers";
import { TxButton } from "@/components/TxButton";
import { StatCard } from "@/components/StatCard";
import { useTx } from "@/hooks/useTx";
import { formatUSD, formatBps, formatToken } from "@/lib/format";
import { USDC_DECIMALS, MUSD_DECIMALS } from "@/lib/config";
import { useUnifiedWallet } from "@/hooks/useUnifiedWallet";
import { useWCContracts } from "@/hooks/useWCContracts";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import WalletConnector from "@/components/WalletConnector";
import { AIYieldOptimizer } from "@/components/AIYieldOptimizer";
import { YieldScanner } from "@/components/YieldScanner";
import { useVaultAPY } from "@/hooks/useVaultAPY";

type AdminSection = "emergency" | "musd" | "directmint" | "treasury" | "vaults" | "bridge" | "borrow" | "oracle";

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGY CATALOG — all deployable yield strategies
// Addresses are populated from env vars; empty string = not yet deployed
// ═══════════════════════════════════════════════════════════════════════════
// TreasuryV2 registers MetaVault instances as allocation slots.
// Each vault aggregates sub-strategies internally via weighted allocation.
// Routing:
//   - DirectMint / smUSD deposits → TreasuryV2 → Vaults 1 & 2 (USDC strategies)
//   - ETH Pool deposits (ETH/USDC/USDT) → TreasuryV2 → Vault 3 only (ETH strategies)
type VaultAssignment = "vault1" | "vault2" | "vault3";

interface StrategyInfo {
  name: string;
  shortName: string;
  address: string;
  targetBps: number;
  apy: string;
  description: string;
  color: string;
  vault: VaultAssignment;
}

interface SubStrategyView {
  strategy: string;
  weightBps: number;
  capUsd: bigint;
  enabled: boolean;
  currentValue: bigint;
}

interface VaultViewData {
  key: VaultAssignment;
  contract: any;
  totalValue: bigint;
  totalPrincipal: bigint;
  idle: bigint;
  drift: number;
  driftThreshold: number;
  paused: boolean;
  active: boolean;
  subStrategies: SubStrategyView[];
}

const VAULT_CONTRACTS_MAP: { key: VaultAssignment; envKey: string }[] = [
  { key: "vault1", envKey: "metaVault1" },
  { key: "vault2", envKey: "metaVault2" },
  { key: "vault3", envKey: "metaVault3" },
];

const VAULT_LABELS: Record<VaultAssignment, { label: string; badge: string; desc: string }> = {
  vault1: {
    label: "Vault #1 — Diversified Yield",
    badge: "bg-emerald-800/60 text-emerald-300",
    desc: "Blue-chip lending loops + PT yield (Euler xStable, Euler V2, Pendle 3-PT)",
  },
  vault2: {
    label: "Vault #2 — Fluid Syrup",
    badge: "bg-pink-800/60 text-pink-300",
    desc: "Leveraged syrupUSDC loops across borrow tokens (GHO, USDT, USDC)",
  },
  vault3: {
    label: "Vault #3 — ETH Pool",
    badge: "bg-blue-800/60 text-blue-300",
    desc: "ETH Pool deposits (ETH/USDC/USDT) are routed exclusively here — Fluid T2 #74 LRT + T4 #44 LST. Exit: mUSD (30/60/90 day lock)",
  },
};

const KNOWN_STRATEGIES: StrategyInfo[] = [
  // ── Vault #1 — Diversified Yield (45% of treasury) ─────────
  {
    name: "Euler V2 RLUSD/USDC Cross-Stable",
    shortName: "Euler xStable",
    address: process.env.NEXT_PUBLIC_EULER_CROSS_STRATEGY_ADDRESS || "",
    targetBps: 5000,
    apy: "~15.7%",
    description: "Cross-stable leverage with depeg circuit breaker (RLUSD/USDC)",
    color: "#10b981", // emerald
    vault: "vault1",
  },
  {
    name: "Euler V2 Loop USDC/USDC",
    shortName: "Euler V2",
    address: process.env.NEXT_PUBLIC_EULER_STRATEGY_ADDRESS || "",
    targetBps: 3000,
    apy: "~18%",
    description: "Leveraged lending loop on Euler V2 (same-asset USDC, incentivized)",
    color: "#14b8a6", // teal
    vault: "vault1",
  },
  {
    name: "Pendle 3-PT Markets",
    shortName: "Pendle",
    address: process.env.NEXT_PUBLIC_PENDLE_STRATEGY_ADDRESS || "",
    targetBps: 2000,
    apy: "~10.7%",
    description: "PT markets with auto-rollover — top pools only",
    color: "#8b5cf6", // violet
    vault: "vault1",
  },
  // ── Vault #2 — Fluid Syrup (45% of treasury) ──────────────
  {
    name: "Fluid #148 syrupUSDC/GHO",
    shortName: "Fluid #148",
    address: process.env.NEXT_PUBLIC_FLUID_GHO_STRATEGY_ADDRESS || "",
    targetBps: 5000,
    apy: "~18.77%",
    description: "syrupUSDC/GHO VaultT1 — cross-borrow loop via Fluid Protocol",
    color: "#06b6d4", // cyan
    vault: "vault2",
  },
  {
    name: "Fluid #147 syrupUSDC/USDT",
    shortName: "Fluid #147",
    address: process.env.NEXT_PUBLIC_FLUID_USDT_STRATEGY_ADDRESS || "",
    targetBps: 3000,
    apy: "~16.61%",
    description: "syrupUSDC/USDT VaultT1 — cross-borrow loop via Fluid Protocol",
    color: "#0891b2", // cyan-600
    vault: "vault2",
  },
  {
    name: "Fluid #146 syrupUSDC/USDC",
    shortName: "Fluid #146",
    address: process.env.NEXT_PUBLIC_FLUID_STRATEGY_ADDRESS || "",
    targetBps: 2000,
    apy: "~11.66%",
    description: "syrupUSDC/USDC VaultT1 — same-asset stable loop via Fluid Protocol",
    color: "#22d3ee", // cyan-400
    vault: "vault2",
  },
  // ── Vault #3 — ETH Pool (10% of treasury) ─────────────────
  // All ETH Pool deposits (ETH/USDC/USDT) are routed exclusively here.
  // DirectMint / smUSD deposits do NOT flow into Vault 3.
  {
    name: "Fluid #74 weETH-ETH/wstETH (Mode 2 LRT)",
    shortName: "Fluid #74",
    address: process.env.NEXT_PUBLIC_FLUID_ETH_STRATEGY_ADDRESS || "",
    targetBps: 6000,
    apy: "~12-18%",
    description: "Mode 2 — LRT Smart Collateral + Smart Debt, Fluid T2 Vault #74 (92% LTV, 4 loops)",
    color: "#3b82f6", // blue-500
    vault: "vault3",
  },
  {
    name: "Fluid #44 wstETH-ETH/wstETH-ETH (Mode 3 LST)",
    shortName: "Fluid #44",
    address: process.env.NEXT_PUBLIC_FLUID_LST_STRATEGY_ADDRESS || "",
    targetBps: 4000,
    apy: "~14-20%",
    description: "Mode 3 — LST Smart Collateral + Smart Debt, Fluid T4 Vault #44 (94% LTV, 5 loops, ~16.7x leverage)",
    color: "#2563eb", // blue-600
    vault: "vault3",
  },
];

/** Look up a human-readable name for a strategy address */
function strategyName(addr: string): string {
  const found = KNOWN_STRATEGIES.find(
    (s) => s.address && s.address.toLowerCase() === addr.toLowerCase()
  );
  return found ? found.shortName : `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function strategyColor(addr: string): string {
  const found = KNOWN_STRATEGIES.find(
    (s) => s.address && s.address.toLowerCase() === addr.toLowerCase()
  );
  return found?.color || "#6b7280";
}

/** Map shortName → optimizer engine key for the AI yield optimizer */
const STRATEGY_KEY_MAP: Record<string, string> = {
  "Fluid #146": "fluid146",
  "Fluid #147": "fluid147",
  "Fluid #148": "fluid148",
  "Pendle": "pendle",
  "Euler xStable": "eulerCross",
  "Euler V2": "euler",
  "Fluid #74": "fluidETH",
  "Fluid #44": "fluidLST",
};

function strategyKey(addr: string): string {
  const name = strategyName(addr);
  return STRATEGY_KEY_MAP[name] || addr.toLowerCase();
}

/** H-01: Validate Ethereum address */
function isAddr(v: string): boolean {
  try { return ethers.isAddress(v); } catch { return false; }
}

/** H-02: Validate basis points in range [0, 10000] */
function isValidBps(v: string): boolean {
  if (!v) return false;
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n <= 10000;
}

export function AdminPage() {
  const { address, isConnected } = useUnifiedWallet();
  const contracts = useWCContracts();
  const { isAdmin, isLoading: isAdminLoading } = useIsAdmin();
  const [section, setSection] = useState<AdminSection>("musd");
  const tx = useTx();
  const { vaultAPYs, treasuryAPY, pendingYield, loading: apyLoading } = useVaultAPY();

  // ── All state hooks (must precede conditional returns — Rules of Hooks) ──

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
  const [addStrategyAddr, setAddStrategyAddr] = useState("");
  const [removeStrategyAddr, setRemoveStrategyAddr] = useState("");
  const [targetBps, setTargetBps] = useState("");
  const [minBps, setMinBps] = useState("");
  const [maxBps, setMaxBps] = useState("");
  const [autoAllocate, setAutoAllocate] = useState(true);
  const [reserveBps, setReserveBps] = useState("");
  const [deployStratAddr, setDeployStratAddr] = useState("");
  const [deployAmount, setDeployAmount] = useState("");
  const [withdrawStratAddr, setWithdrawStratAddr] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [strategyList, setStrategyList] = useState<{strategy: string; targetBps: bigint; active: boolean; value?: string}[]>([]);

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

  // Emergency / Global Pause
  const [cancelOpId, setCancelOpId] = useState("");
  const [globalPauseStatus, setGlobalPauseStatus] = useState<{ paused: boolean; lastPausedAt: string; lastUnpausedAt: string; isGuardian: boolean; isAdmin: boolean } | null>(null);

  // Vault Admin
  const [vaultData, setVaultData] = useState<Record<string, VaultViewData>>({});
  const [selectedVaultDeploy, setSelectedVaultDeploy] = useState<string>("");
  const [vaultDeployAmount, setVaultDeployAmount] = useState("");
  const [selectedVaultWithdraw, setSelectedVaultWithdraw] = useState<string>("");
  const [vaultWithdrawSubIdx, setVaultWithdrawSubIdx] = useState("");
  const [vaultWithdrawAmount, setVaultWithdrawAmount] = useState("");
  const [addSubAddr, setAddSubAddr] = useState("");
  const [addSubWeight, setAddSubWeight] = useState("");
  const [addSubCap, setAddSubCap] = useState("0");
  const [addSubVault, setAddSubVault] = useState<string>("");

  const { musd, directMint, treasury, bridge, borrow, oracle, metaVault1, metaVault2, metaVault3, globalPause, timelock } = contracts as any;

  // Current values + data-loading state (H-04)
  const [currentValues, setCurrentValues] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadCurrentValues() {
      if (!address) return;
      setLoadError(null);
      const vals: Record<string, string> = {};
      try {
        if (musd) vals.supplyCap = formatUSD(await musd.supplyCap());
        if (directMint) {
          vals.mintFee = formatBps(await directMint.mintFeeBps());
          vals.redeemFee = formatBps(await directMint.redeemFeeBps());
          vals.accFees = formatToken(await directMint.totalAccumulatedFees(), 6);
          vals.paused = (await directMint.paused()).toString();
        }
        if (treasury) {
          // Use TreasuryV2 functions instead of stale V1 calls
          vals.maxDeploy = formatBps(await treasury.reserveBps());
          vals.totalBacking = formatUSD(await treasury.totalValue(), 6);
          vals.reserveBalance = formatUSD(await treasury.reserveBalance(), 6);
          // Load strategies for the deploy/withdraw dropdowns
          try {
            const strats = await treasury.getAllStrategies();
            const stratItems = [];
            for (let i = 0; i < strats.length; i++) {
              const s = strats[i];
              if (s.active) {
                stratItems.push({
                  strategy: s.strategy,
                  targetBps: s.targetBps,
                  active: s.active,
                });
              }
            }
            if (!cancelled) setStrategyList(stratItems);
          } catch (err) {
            console.error("[AdminPage] Strategy list load failed:", err);
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
        // Global Pause status
        if (globalPause && address) {
          try {
            const paused = await globalPause.isGloballyPaused();
            const lastPausedAtRaw = await globalPause.lastPausedAt();
            const lastUnpausedAtRaw = await globalPause.lastUnpausedAt();
            const GUARDIAN_ROLE = await globalPause.GUARDIAN_ROLE();
            const ADMIN_ROLE = await globalPause.DEFAULT_ADMIN_ROLE();
            const isGuardian = await globalPause.hasRole(GUARDIAN_ROLE, address);
            const isAdmin = await globalPause.hasRole(ADMIN_ROLE, address);
            const fmtTs = (ts: bigint) => ts > 0n ? new Date(Number(ts) * 1000).toLocaleString() : "Never";
            if (!cancelled) setGlobalPauseStatus({
              paused,
              lastPausedAt: fmtTs(lastPausedAtRaw),
              lastUnpausedAt: fmtTs(lastUnpausedAtRaw),
              isGuardian,
              isAdmin,
            });
          } catch (err) {
            console.error("[AdminPage] GlobalPause load failed:", err);
          }
        }
      } catch (err) {
        console.error("[AdminPage] Failed to load protocol data:", err);
        if (!cancelled) setLoadError("Failed to load protocol data. Check RPC connection.");
      }
      if (!cancelled) setCurrentValues(vals);
    }
    loadCurrentValues();
    return () => { cancelled = true; };
  }, [musd, directMint, treasury, bridge, borrow, globalPause, address, tx.success]);

  // ── Load MetaVault data ──
  useEffect(() => {
    let cancelled = false;
    async function loadVaultData() {
      const vaults: Record<string, VaultViewData> = {};
      const mvContracts: Record<string, any> = { vault1: metaVault1, vault2: metaVault2, vault3: metaVault3 };

      for (const { key } of VAULT_CONTRACTS_MAP) {
        const mv = mvContracts[key];
        if (!mv) continue;
        try {
          const [totalVal, principal, idle, drift, driftThreshold, isPaused, isAct, count] = await Promise.all([
            mv.totalValue(),
            mv.totalPrincipal(),
            mv.idleBalance(),
            mv.currentDrift(),
            mv.driftThresholdBps(),
            mv.paused(),
            mv.isActive(),
            mv.subStrategyCount(),
          ]);
          const subs: SubStrategyView[] = [];
          for (let i = 0; i < Number(count); i++) {
            const s = await mv.getSubStrategy(i);
            subs.push({
              strategy: s.strategy,
              weightBps: Number(s.weightBps),
              capUsd: s.capUsd,
              enabled: s.enabled,
              currentValue: s.currentValue,
            });
          }
          vaults[key] = {
            key,
            contract: mv,
            totalValue: totalVal,
            totalPrincipal: principal,
            idle,
            drift: Number(drift),
            driftThreshold: Number(driftThreshold),
            paused: isPaused,
            active: isAct,
            subStrategies: subs,
          };
        } catch (err) {
          console.error(`[AdminPage] Failed to load ${key} data:`, err);
        }
      }
      if (!cancelled) setVaultData(vaults);
    }
    loadVaultData();
    return () => { cancelled = true; };
  }, [metaVault1, metaVault2, metaVault3, tx.success]);

  // ── Conditional returns (after all hooks — C-01 fix) ──
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

  const sections: { key: AdminSection; label: string }[] = [
    { key: "emergency", label: "🚨 Emergency" },
    { key: "musd", label: "mUSD" },
    { key: "directmint", label: "DirectMint" },
    { key: "treasury", label: "Treasury" },
    { key: "vaults", label: "Vaults" },
    { key: "bridge", label: "Bridge" },
    { key: "borrow", label: "Borrow" },
    { key: "oracle", label: "Oracle" },
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
      {loadError && (
        <div className="rounded-lg border border-amber-800 bg-amber-900/20 p-4 text-sm text-amber-400">
          ⚠️ {loadError}
        </div>
      )}

      {/* ===== Emergency Section ===== */}
      {section === "emergency" && (
        <div className="space-y-4">
          {/* Global Pause Status */}
          <div className={`card border-2 ${
            globalPauseStatus?.paused
              ? "border-red-500 bg-red-950/30"
              : "border-green-800 bg-green-950/20"
          }`}>
            <h3 className="text-lg font-bold text-white flex items-center gap-2">
              {globalPauseStatus?.paused ? "🔴" : "🟢"} Global Protocol Status
            </h3>
            <div className="mt-3 grid gap-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-400">Status</span>
                <span className={globalPauseStatus?.paused ? "text-red-400 font-bold" : "text-green-400 font-bold"}>
                  {globalPauseStatus?.paused ? "⛔ PAUSED" : "✅ ACTIVE"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Last Paused</span>
                <span className="text-gray-300">{globalPauseStatus?.lastPausedAt || "..."}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Last Unpaused</span>
                <span className="text-gray-300">{globalPauseStatus?.lastUnpausedAt || "..."}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Your Roles</span>
                <span className="text-gray-300">
                  {globalPauseStatus?.isGuardian ? "✅ GUARDIAN" : "❌ GUARDIAN"}
                  {" · "}
                  {globalPauseStatus?.isAdmin ? "✅ ADMIN" : "❌ ADMIN"}
                </span>
              </div>
            </div>

            <div className="mt-4 flex gap-3">
              <TxButton
                className="flex-1 !bg-red-700 hover:!bg-red-600"
                onClick={() => tx.send(() => globalPause!.pauseGlobal())}
                loading={tx.loading}
                disabled={!globalPause || !globalPauseStatus?.isGuardian || globalPauseStatus?.paused}
              >
                🛑 Pause Entire Protocol
              </TxButton>
              <TxButton
                className="flex-1 !bg-green-700 hover:!bg-green-600"
                onClick={() => tx.send(() => globalPause!.unpauseGlobal())}
                loading={tx.loading}
                disabled={!globalPause || !globalPauseStatus?.isAdmin || !globalPauseStatus?.paused}
              >
                ▶️ Unpause Protocol
              </TxButton>
            </div>

            {!globalPauseStatus?.isGuardian && (
              <p className="mt-2 text-xs text-amber-400">
                ⚠️ Your wallet does not have GUARDIAN_ROLE — you cannot trigger the global pause.
              </p>
            )}
          </div>

          {/* Timelock Cancel */}
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Cancel Pending Timelock Operation</h3>
            <p className="mb-3 text-sm text-gray-500">
              If a malicious or incorrect operation was scheduled on the MintedTimelockController,
              paste the operation ID below to cancel it before it becomes executable.
              Requires CANCELLER_ROLE.
            </p>
            <label className="label">Operation ID (bytes32)</label>
            <input
              className="input font-mono text-xs"
              type="text"
              placeholder="0xb2693f1d561b08b889b568927f2930793111ee06eafe82142d40fed18b11afe4"
              value={cancelOpId}
              onChange={(e) => setCancelOpId(e.target.value)}
            />
            <TxButton
              className="mt-3 w-full !bg-amber-700 hover:!bg-amber-600"
              onClick={() => tx.send(() => timelock!.cancel(cancelOpId))}
              loading={tx.loading}
              disabled={!timelock || !cancelOpId || cancelOpId.length !== 66}
            >
              ⚠️ Cancel Timelock Operation
            </TxButton>
          </div>

          {/* Info Card */}
          <div className="card border border-gray-700">
            <h3 className="mb-2 font-semibold text-gray-300">Emergency Response Guide</h3>
            <ul className="space-y-2 text-sm text-gray-400">
              <li><span className="text-red-400 font-mono">pauseGlobal()</span> — Instantly halts all deposits, withdrawals, mints, borrows, and liquidations across the entire protocol. Use during active exploits.</li>
              <li><span className="text-amber-400 font-mono">cancel(id)</span> — Cancels a scheduled timelock operation before it executes. Use if a PROPOSER key is compromised and a malicious upgrade is queued.</li>
              <li><span className="text-green-400 font-mono">unpauseGlobal()</span> — Resumes protocol after root cause is resolved. Requires DEFAULT_ADMIN_ROLE (higher authority than GUARDIAN).</li>
            </ul>
          </div>
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
              disabled={!musd || !newSupplyCap}
            >
              Set Supply Cap
            </TxButton>
          </div>
          <div className="card">
            <label className="label">Compliance — Freeze / Permit Address</label>
            <input className="input" type="text" placeholder="0x..." value={blacklistAddr} onChange={(e) => setBlacklistAddr(e.target.value)} />
            <div className="mt-2 flex gap-2">
              <TxButton
                className="flex-1"
                onClick={() => tx.send(() => musd!.setBlacklist(blacklistAddr, true))}
                loading={tx.loading}
                disabled={!musd || !blacklistAddr || !isAddr(blacklistAddr)}
                variant="danger"
              >
                🔒 FREEZE
              </TxButton>
              <TxButton
                className="flex-1"
                onClick={() => tx.send(() => musd!.setBlacklist(blacklistAddr, false))}
                loading={tx.loading}
                disabled={!musd || !blacklistAddr || !isAddr(blacklistAddr)}
                variant="success"
              >
                ✅ PERMIT
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
              disabled={!directMint || !isValidBps(mintFeeBps) || !isValidBps(redeemFeeBps)}
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
              disabled={!directMint || !minMint || !maxMint || !minRedeem || !maxRedeem}
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
              disabled={!directMint || !newFeeRecipient || !isAddr(newFeeRecipient)}
            >
              Set Fee Recipient
            </TxButton>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <TxButton onClick={() => tx.send(() => directMint!.withdrawFees())} loading={tx.loading} disabled={!directMint}>
              Withdraw Fees
            </TxButton>
            <TxButton onClick={() => tx.send(() => directMint!.pause())} loading={tx.loading} disabled={!directMint} variant="danger">
              Pause
            </TxButton>
            <TxButton onClick={() => tx.send(() => directMint!.unpause())} loading={tx.loading} disabled={!directMint} variant="secondary">
              Unpause
            </TxButton>
          </div>
        </div>
      )}

      {/* ===== Treasury Section ===== */}
      {section === "treasury" && (
        <div className="space-y-4">
          {/* ── Overview Stats ── */}
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Total Value" value={currentValues.totalBacking || "..."} />
            <StatCard label="Reserve (idle USDC)" value={currentValues.reserveBalance || "..."} color="green" />
            <StatCard label="Reserve Target (bps)" value={currentValues.maxDeploy || "..."} />
          </div>

          <div className="rounded-lg border border-blue-700/50 bg-blue-900/10 p-3 text-xs text-blue-400">
            <strong>Auto-Allocation:</strong> Deposits ≥ $1,000 are automatically split across active strategies
            according to their target allocations. Smaller deposits stay in reserve until the next rebalance.
            Use the deploy/withdraw controls below for manual adjustments.
          </div>

          {/* ── DeFi Yield Scanner (live market data) ── */}
          <YieldScanner />

          {/* ── AI Yield Optimizer ── */}
          <AIYieldOptimizer
            totalValueUsd={parseFloat((currentValues.totalBacking || "0").replace(/[^0-9.]/g, ""))}
            reserveBalanceUsd={parseFloat((currentValues.reserveBalance || "0").replace(/[^0-9.]/g, ""))}
            currentStrategies={strategyList.map((s) => ({
              key: strategyKey(s.strategy),
              bps: Number(s.targetBps),
            }))}
            onApply={(diffs) => {
              // Show a summary; actual deploy/withdraw still done manually below
              const summary = diffs
                .map((d) => `${d.action} ${d.shortName}: ${(d.currentBps / 100).toFixed(1)}% → ${(d.recommendedBps / 100).toFixed(1)}%`)
                .join("\n");
              if (confirm(`Apply AI recommendation?\n\n${summary}\n\nThis will queue the first deploy/withdraw. Execute each manually below.`)) {
                // Pre-fill the deploy form with the first NEW/DEPLOY action
                const firstDeploy = diffs.find((d) => d.action === "NEW" || d.action === "DEPLOY");
                if (firstDeploy) {
                  const strat = strategyList.find(
                    (s) => strategyKey(s.strategy) === firstDeploy.key
                  );
                  if (strat) {
                    setDeployStratAddr(strat.strategy);
                    const amt = Math.abs(firstDeploy.deltaUsd);
                    setDeployAmount(amt.toFixed(2));
                  }
                }
              }
            }}
          />

          {/* ── Active Strategies (on-chain registered) ── */}
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">
              Active Strategies
              <span className="ml-2 rounded bg-gray-700 px-2 py-0.5 text-xs text-gray-400">
                {strategyList.length} registered
              </span>
            </h3>
            {strategyList.length === 0 ? (
              <p className="text-sm text-gray-500">No strategies registered on-chain yet. Use "Add Strategy" below.</p>
            ) : (
              <div className="space-y-2">
                {strategyList.map((s, i) => {
                  const name = strategyName(s.strategy);
                  const color = strategyColor(s.strategy);
                  return (
                    <div key={i} className="flex items-center justify-between rounded-lg bg-gray-800/50 px-4 py-3 text-sm">
                      <div className="flex items-center gap-3">
                        <div className="h-3 w-3 rounded-full" style={{ backgroundColor: color }} />
                        <div>
                          <span className="font-medium text-white">{name}</span>
                          <span className="ml-2 font-mono text-xs text-gray-500">
                            {s.strategy.slice(0, 6)}…{s.strategy.slice(-4)}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        {s.value && (
                          <span className="text-gray-400 text-xs">{s.value} USDC</span>
                        )}
                        <span className="rounded bg-gray-700/80 px-2 py-0.5 text-xs text-gray-300">
                          Target: {Number(s.targetBps) / 100}%
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── Strategy Catalog (all known strategies) ── */}
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Strategy Catalog</h3>
            <p className="mb-3 text-xs text-gray-500">
              All available yield strategies. Strategies with addresses configured can be added to Treasury.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {KNOWN_STRATEGIES.map((ks, i) => {
                const isRegistered = strategyList.some(
                  (s) => ks.address && s.strategy.toLowerCase() === ks.address.toLowerCase()
                );
                return (
                  <div
                    key={i}
                    className={`rounded-lg border px-3 py-2 text-xs ${
                      isRegistered
                        ? "border-green-700/50 bg-green-900/10"
                        : ks.address
                        ? "border-gray-700 bg-gray-800/30"
                        : "border-gray-800 bg-gray-900/20 opacity-50"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: ks.color }} />
                      <span className="font-medium text-white">{ks.shortName}</span>
                      {ks.targetBps > 0 && (
                        <span className="rounded bg-gray-700 px-1.5 py-0.5 text-[10px] text-gray-400">
                          {ks.targetBps / 100}%
                        </span>
                      )}
                      {isRegistered && (
                        <span className="rounded bg-green-800/60 px-1.5 py-0.5 text-[10px] text-green-400">ACTIVE</span>
                      )}
                      {!ks.address && (
                        <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-500">NO ADDR</span>
                      )}
                    </div>
                    <p className="mt-1 text-gray-500">{ks.description}</p>
                    {ks.address && (
                      <p className="mt-0.5 font-mono text-[10px] text-gray-600">{ks.address}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Manual Deploy to Strategy ── */}
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Deploy to Strategy</h3>
            <p className="mb-3 text-xs text-gray-500">Manually deploy idle USDC from reserve into a registered strategy.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Strategy</label>
                <select className="input" value={deployStratAddr} onChange={(e) => setDeployStratAddr(e.target.value)}>
                  <option value="">Select strategy…</option>
                  {strategyList.map((s, i) => (
                    <option key={i} value={s.strategy}>
                      {strategyName(s.strategy)} — {Number(s.targetBps) / 100}%
                    </option>
                  ))}
                </select>
                {deployStratAddr && (
                  <p className="mt-1 font-mono text-[10px] text-gray-500">{deployStratAddr}</p>
                )}
              </div>
              <div>
                <label className="label">Amount (USDC)</label>
                <input className="input" type="number" placeholder="10000" value={deployAmount} onChange={(e) => setDeployAmount(e.target.value)} />
                {currentValues.reserveBalance && (
                  <button
                    type="button"
                    className="mt-1 text-[10px] text-brand-400 hover:underline"
                    onClick={() => {
                      const raw = currentValues.reserveBalance?.replace(/[^0-9.]/g, "") || "0";
                      setDeployAmount(raw);
                    }}
                  >
                    MAX: {currentValues.reserveBalance}
                  </button>
                )}
              </div>
            </div>
            <TxButton
              className="mt-3 w-full"
              onClick={() => tx.send(() => treasury!.deployToStrategy(deployStratAddr, ethers.parseUnits(deployAmount, USDC_DECIMALS)))}
              loading={tx.loading}
              disabled={!treasury || !deployStratAddr || !deployAmount}
            >
              Deploy to Strategy
            </TxButton>
          </div>

          {/* ── Manual Withdraw from Strategy ── */}
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Withdraw from Strategy</h3>
            <p className="mb-3 text-xs text-gray-500">Pull USDC back from a strategy into the reserve.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Strategy</label>
                <select className="input" value={withdrawStratAddr} onChange={(e) => setWithdrawStratAddr(e.target.value)}>
                  <option value="">Select strategy…</option>
                  {strategyList.map((s, i) => (
                    <option key={i} value={s.strategy}>
                      {strategyName(s.strategy)} — {Number(s.targetBps) / 100}%
                    </option>
                  ))}
                </select>
                {withdrawStratAddr && (
                  <p className="mt-1 font-mono text-[10px] text-gray-500">{withdrawStratAddr}</p>
                )}
              </div>
              <div>
                <label className="label">Amount (USDC)</label>
                <input className="input" type="number" placeholder="10000" value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)} />
              </div>
            </div>
            <TxButton
              className="mt-3 w-full"
              onClick={() => tx.send(() => treasury!.withdrawFromStrategy(withdrawStratAddr, ethers.parseUnits(withdrawAmount, USDC_DECIMALS)))}
              loading={tx.loading}
              disabled={!treasury || !withdrawStratAddr || !withdrawAmount}
              variant="secondary"
            >
              Withdraw from Strategy
            </TxButton>
          </div>

          {/* ── Add Strategy (from catalog or manual address) ── */}
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Add Strategy to Treasury</h3>
            <p className="mb-3 text-xs text-gray-500">
              Register a strategy on-chain. Pick from the catalog or enter a custom address.
            </p>
            <div>
              <label className="label">Strategy</label>
              <select
                className="input"
                value={addStrategyAddr}
                onChange={(e) => {
                  setAddStrategyAddr(e.target.value);
                  // Pre-fill target bps from catalog
                  const found = KNOWN_STRATEGIES.find(
                    (ks) => ks.address && ks.address.toLowerCase() === e.target.value.toLowerCase()
                  );
                  if (found && found.targetBps > 0) {
                    setTargetBps(String(found.targetBps));
                    setMinBps(String(Math.max(0, found.targetBps - 1000)));
                    setMaxBps(String(Math.min(10000, found.targetBps + 1000)));
                  }
                }}
              >
                <option value="">Select from catalog…</option>
                {KNOWN_STRATEGIES.filter((ks) => ks.address).map((ks, i) => {
                  const already = strategyList.some(
                    (s) => s.strategy.toLowerCase() === ks.address.toLowerCase()
                  );
                  return (
                    <option key={i} value={ks.address} disabled={already}>
                      {ks.name} {already ? "(already active)" : `— ${ks.apy}`}
                    </option>
                  );
                })}
              </select>
            </div>
            <div className="mt-2">
              <label className="label">Or enter address manually</label>
              <input
                className="input"
                type="text"
                placeholder="0x..."
                value={addStrategyAddr}
                onChange={(e) => setAddStrategyAddr(e.target.value)}
              />
            </div>
            {addStrategyAddr && (
              <p className="mt-1 text-xs text-gray-400">
                {KNOWN_STRATEGIES.find(
                  (ks) => ks.address && ks.address.toLowerCase() === addStrategyAddr.toLowerCase()
                )?.description || "Custom strategy (not in catalog)"}
              </p>
            )}
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <div>
                <label className="label">Target (bps)</label>
                <input className="input" type="number" placeholder="3500" value={targetBps} onChange={(e) => setTargetBps(e.target.value)} />
              </div>
              <div>
                <label className="label">Min (bps)</label>
                <input className="input" type="number" placeholder="2500" value={minBps} onChange={(e) => setMinBps(e.target.value)} />
              </div>
              <div>
                <label className="label">Max (bps)</label>
                <input className="input" type="number" placeholder="4500" value={maxBps} onChange={(e) => setMaxBps(e.target.value)} />
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <input
                type="checkbox"
                id="autoAllocate"
                checked={autoAllocate}
                onChange={(e) => setAutoAllocate(e.target.checked)}
                className="h-4 w-4 rounded border-gray-600 bg-gray-800 text-brand-500"
              />
              <label htmlFor="autoAllocate" className="text-xs text-gray-400">
                Auto-allocate deposits to this strategy (recommended)
              </label>
            </div>
            <TxButton
              className="mt-3 w-full"
              onClick={() => tx.send(() => treasury!.addStrategy(addStrategyAddr, BigInt(targetBps), BigInt(minBps), BigInt(maxBps), autoAllocate))}
              loading={tx.loading}
              disabled={!treasury || !addStrategyAddr || !isAddr(addStrategyAddr) || !isValidBps(targetBps) || !isValidBps(minBps) || !isValidBps(maxBps)}
            >
              Add Strategy
            </TxButton>
          </div>

          {/* ── Remove Strategy ── */}
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Remove Strategy</h3>
            <p className="mb-3 text-xs text-gray-500">Deactivate a strategy. Funds will be withdrawn first.</p>
            <select
              className="input"
              value={removeStrategyAddr}
              onChange={(e) => setRemoveStrategyAddr(e.target.value)}
            >
              <option value="">Select strategy to remove…</option>
              {strategyList.map((s, i) => (
                <option key={i} value={s.strategy}>
                  {strategyName(s.strategy)} — {s.strategy.slice(0, 10)}…
                </option>
              ))}
            </select>
            <TxButton
              className="mt-3 w-full"
              onClick={() => tx.send(() => treasury!.removeStrategy(removeStrategyAddr))}
              loading={tx.loading}
              disabled={!treasury || !removeStrategyAddr}
              variant="danger"
            >
              Remove Strategy
            </TxButton>
          </div>

          {/* ── Reserve & Rebalance ── */}
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Reserve Ratio (bps)</h3>
            <p className="mb-2 text-xs text-gray-500">Current: {currentValues.maxDeploy || "..."}</p>
            <input className="input" type="number" placeholder="500" value={reserveBps} onChange={(e) => setReserveBps(e.target.value)} />
            <TxButton
              className="mt-3 w-full"
              onClick={() => tx.send(() => treasury!.setReserveBps(BigInt(reserveBps)))}
              loading={tx.loading}
              disabled={!treasury || !isValidBps(reserveBps)}
            >
              Set Reserve
            </TxButton>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <TxButton
              onClick={() => tx.send(() => treasury!.rebalance())}
              loading={tx.loading}
              disabled={!treasury}
            >
              Rebalance All
            </TxButton>
            <TxButton
              onClick={() => tx.send(() => treasury!.claimFees())}
              loading={tx.loading}
              disabled={!treasury}
              variant="secondary"
            >
              Claim Fees
            </TxButton>
            <TxButton
              onClick={() => tx.send(() => treasury!.emergencyWithdrawAll())}
              loading={tx.loading}
              disabled={!treasury}
              variant="danger"
            >
              Emergency Withdraw All
            </TxButton>
          </div>
        </div>
      )}

      {/* ===== Vaults Section ===== */}
      {section === "vaults" && (
        <div className="space-y-6">
          {/* Overview stats */}
          <div className="grid gap-4 sm:grid-cols-4">
            <StatCard
              label="Total Across Vaults"
              value={formatUSD(
                Object.values(vaultData).reduce((sum, v) => sum + v.totalValue, 0n),
                6
              )}
            />
            <StatCard
              label="Active Vaults"
              value={`${Object.values(vaultData).filter((v) => v.active).length} / 3`}
              color="green"
            />
            <StatCard
              label="Total Idle USDC"
              value={formatUSD(
                Object.values(vaultData).reduce((sum, v) => sum + v.idle, 0n),
                6
              )}
            />
            <StatCard
              label="Treasury APY (7d)"
              value={treasuryAPY != null ? `${treasuryAPY.toFixed(2)}%` : apyLoading ? "Loading…" : "Collecting…"}
              color={treasuryAPY != null && treasuryAPY > 0 ? "green" : undefined}
            />
          </div>

          {/* ── Yield Harvest Status ── */}
          <div className="rounded-xl border border-emerald-800/40 bg-emerald-950/20 px-5 py-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-emerald-300">📊 Yield Harvest</h3>
              {pendingYield && (
                <span className="text-xs text-gray-400">
                  Auto-distributes 80% to smUSD holders | 20% protocol fee
                </span>
              )}
            </div>
            {pendingYield ? (
              <div className="grid gap-3 sm:grid-cols-4">
                <div className="rounded-lg bg-gray-800/40 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-gray-500">Gross Yield</p>
                  <p className="text-sm font-medium text-white">${pendingYield.gross}</p>
                </div>
                <div className="rounded-lg bg-gray-800/40 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-gray-500">Net Yield (80%)</p>
                  <p className="text-sm font-medium text-emerald-400">${pendingYield.net}</p>
                </div>
                <div className="rounded-lg bg-gray-800/40 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-gray-500">Protocol Fee (20%)</p>
                  <p className="text-sm font-medium text-yellow-400">${pendingYield.fee}</p>
                </div>
                <div className="flex items-end">
                  <TxButton
                    size="sm"
                    onClick={() => tx.send(() => contracts.treasury!.harvestYield())}
                    loading={tx.loading}
                    disabled={!contracts.treasury || pendingYield.net === "0.00"}
                  >
                    Harvest Now
                  </TxButton>
                </div>
              </div>
            ) : (
              <p className="text-xs text-gray-500">
                {apyLoading ? "Loading yield data…" : "Connect wallet & deploy TreasuryV2 upgrade to see pending yield."}
              </p>
            )}
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {(["vault1", "vault2", "vault3"] as VaultAssignment[]).map((vk) => (
                <div key={vk} className="rounded-lg bg-gray-800/30 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-gray-500">{VAULT_LABELS[vk].label.split("—")[0].trim()} APY</p>
                  <p className={`text-lg font-bold ${vaultAPYs[vk] != null && vaultAPYs[vk]! > 0 ? "text-emerald-400" : "text-gray-400"}`}>
                    {vaultAPYs[vk] != null ? `${vaultAPYs[vk]!.toFixed(2)}%` : "—"}
                  </p>
                  <p className="text-[10px] text-gray-600">
                    {vaultAPYs[vk] != null ? "7-day annualized" : "Collecting data…"}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Per-vault cards */}
          {(["vault1", "vault2", "vault3"] as VaultAssignment[]).map((vk) => {
            const label = VAULT_LABELS[vk];
            const vd = vaultData[vk];
            const strategies = KNOWN_STRATEGIES.filter((ks) => ks.vault === vk);

            return (
              <div key={vk} className="rounded-xl border border-gray-700 bg-gray-900/50 overflow-hidden">
                {/* Vault header */}
                <div className="flex items-center justify-between border-b border-gray-700/50 px-5 py-3">
                  <div className="flex items-center gap-3">
                    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${label.badge}`}>
                      {vk.replace("vault", "#")}
                    </span>
                    <div>
                      <h3 className="text-base font-semibold text-white">{label.label}</h3>
                      <p className="text-xs text-gray-500">{label.desc}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {vd ? (
                      <>
                        {vd.paused && (
                          <span className="rounded bg-red-900/60 px-2 py-0.5 text-[10px] font-medium text-red-400">PAUSED</span>
                        )}
                        {!vd.active && !vd.paused && (
                          <span className="rounded bg-yellow-900/60 px-2 py-0.5 text-[10px] font-medium text-yellow-400">INACTIVE</span>
                        )}
                        {vd.active && !vd.paused && (
                          <span className="rounded bg-green-900/60 px-2 py-0.5 text-[10px] font-medium text-green-400">LIVE</span>
                        )}
                      </>
                    ) : (
                      <span className="rounded bg-gray-800 px-2 py-0.5 text-[10px] text-gray-500">NOT DEPLOYED</span>
                    )}
                  </div>
                </div>

                {/* Vault body */}
                {vd ? (
                  <div className="px-5 py-4 space-y-4">
                    {/* Stats row */}
                    <div className="grid gap-3 sm:grid-cols-4">
                      <div className="rounded-lg bg-gray-800/40 px-3 py-2">
                        <p className="text-[10px] uppercase tracking-wide text-gray-500">Total Value</p>
                        <p className="text-sm font-medium text-white">{formatUSD(vd.totalValue, 6)}</p>
                      </div>
                      <div className="rounded-lg bg-gray-800/40 px-3 py-2">
                        <p className="text-[10px] uppercase tracking-wide text-gray-500">Principal</p>
                        <p className="text-sm font-medium text-white">{formatUSD(vd.totalPrincipal, 6)}</p>
                      </div>
                      <div className="rounded-lg bg-gray-800/40 px-3 py-2">
                        <p className="text-[10px] uppercase tracking-wide text-gray-500">Idle USDC</p>
                        <p className="text-sm font-medium text-white">{formatUSD(vd.idle, 6)}</p>
                      </div>
                      <div className="rounded-lg bg-gray-800/40 px-3 py-2">
                        <p className="text-[10px] uppercase tracking-wide text-gray-500">Drift / Threshold</p>
                        <p className={`text-sm font-medium ${vd.drift >= vd.driftThreshold ? "text-yellow-400" : "text-white"}`}>
                          {(vd.drift / 100).toFixed(1)}% / {(vd.driftThreshold / 100).toFixed(1)}%
                        </p>
                      </div>
                    </div>

                    {/* Sub-strategies */}
                    <div>
                      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Sub-Strategies</h4>
                      {vd.subStrategies.length === 0 ? (
                        <p className="text-xs text-gray-500">No sub-strategies registered.</p>
                      ) : (
                        <div className="space-y-1.5">
                          {vd.subStrategies.map((ss, idx) => {
                            const name = strategyName(ss.strategy);
                            const color = strategyColor(ss.strategy);
                            const pct = vd.totalValue > 0n
                              ? Number((ss.currentValue * 10000n) / vd.totalValue) / 100
                              : 0;
                            return (
                              <div key={idx} className="flex items-center justify-between rounded-lg bg-gray-800/30 px-4 py-2.5 text-sm">
                                <div className="flex items-center gap-3">
                                  <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
                                  <span className="font-medium text-white">{name}</span>
                                  <span className="font-mono text-[10px] text-gray-600">
                                    {ss.strategy.slice(0, 6)}…{ss.strategy.slice(-4)}
                                  </span>
                                </div>
                                <div className="flex items-center gap-3">
                                  <span className="text-xs text-gray-400">{formatUSD(ss.currentValue, 6)}</span>
                                  {/* Weight bar */}
                                  <div className="flex items-center gap-1.5">
                                    <div className="h-1.5 w-16 rounded-full bg-gray-700 overflow-hidden">
                                      <div
                                        className="h-full rounded-full"
                                        style={{ width: `${pct}%`, backgroundColor: color }}
                                      />
                                    </div>
                                    <span className="text-[10px] text-gray-400 w-8 text-right">
                                      {(ss.weightBps / 100).toFixed(0)}%
                                    </span>
                                  </div>
                                  {ss.enabled ? (
                                    <span className="rounded bg-green-900/40 px-1.5 py-0.5 text-[10px] text-green-400">ON</span>
                                  ) : (
                                    <span className="rounded bg-red-900/40 px-1.5 py-0.5 text-[10px] text-red-400">OFF</span>
                                  )}
                                  {/* Toggle circuit breaker */}
                                  <button
                                    onClick={() => tx.send(() => vd.contract.toggleSubStrategy(idx, !ss.enabled))}
                                    className="rounded bg-gray-700 px-2 py-0.5 text-[10px] text-gray-300 hover:bg-gray-600"
                                    disabled={tx.loading}
                                  >
                                    {ss.enabled ? "Disable" : "Enable"}
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* Vault actions */}
                    <div className="flex flex-wrap gap-2 border-t border-gray-700/30 pt-3">
                      <TxButton
                        size="sm"
                        onClick={() => tx.send(() => vd.contract.rebalance())}
                        loading={tx.loading}
                        disabled={vd.drift < vd.driftThreshold}
                      >
                        Rebalance
                      </TxButton>
                      <TxButton
                        size="sm"
                        variant="secondary"
                        onClick={() => tx.send(() => vd.contract.pause())}
                        loading={tx.loading}
                        disabled={vd.paused}
                      >
                        Pause
                      </TxButton>
                      <TxButton
                        size="sm"
                        variant="secondary"
                        onClick={() => tx.send(() => vd.contract.unpause())}
                        loading={tx.loading}
                        disabled={!vd.paused}
                      >
                        Unpause
                      </TxButton>
                      <TxButton
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          if (confirm(`Emergency withdraw ALL from ${label.label}? This will disable all sub-strategies.`)) {
                            tx.send(() => vd.contract.emergencyWithdrawAll());
                          }
                        }}
                        loading={tx.loading}
                      >
                        Emergency Withdraw All
                      </TxButton>
                    </div>
                  </div>
                ) : (
                  /* Not deployed — show catalog preview */
                  <div className="px-5 py-4">
                    <p className="mb-3 text-xs text-gray-500">
                      Not yet deployed. Planned sub-strategies:
                    </p>
                    <div className="space-y-1">
                      {strategies.map((ks, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs text-gray-400">
                          <div className="h-2 w-2 rounded-full" style={{ backgroundColor: ks.color }} />
                          <span>{ks.shortName}</span>
                          <span className="text-gray-600">— {vaultAPYs[vk] != null ? `${vaultAPYs[vk]!.toFixed(1)}% live` : ks.apy}</span>
                          <span className="text-gray-600">({ks.targetBps / 100}%)</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* ── Deploy to Vault ── */}
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Deploy USDC to Vault</h3>
            <p className="mb-3 text-xs text-gray-500">
              TreasuryV2 calls deposit() on the selected MetaVault. The vault splits across sub-strategies by weight.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Vault</label>
                <select className="input" value={selectedVaultDeploy} onChange={(e) => setSelectedVaultDeploy(e.target.value)}>
                  <option value="">Select vault…</option>
                  {(["vault1", "vault2", "vault3"] as VaultAssignment[]).map((vk) => {
                    const vd = vaultData[vk];
                    if (!vd) return null;
                    return (
                      <option key={vk} value={vk}>
                        {VAULT_LABELS[vk].label} — {formatUSD(vd.totalValue, 6)}
                      </option>
                    );
                  })}
                </select>
              </div>
              <div>
                <label className="label">Amount (USDC)</label>
                <input className="input" type="number" placeholder="10000" value={vaultDeployAmount} onChange={(e) => setVaultDeployAmount(e.target.value)} />
              </div>
            </div>
            <TxButton
              className="mt-3 w-full"
              onClick={() => {
                const vd = vaultData[selectedVaultDeploy];
                if (vd) tx.send(() => treasury!.deployToStrategy(vd.contract.target, ethers.parseUnits(vaultDeployAmount, USDC_DECIMALS)));
              }}
              loading={tx.loading}
              disabled={!treasury || !selectedVaultDeploy || !vaultDeployAmount}
            >
              Deploy to Vault
            </TxButton>
          </div>

          {/* ── Add Sub-Strategy to Vault ── */}
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Add Sub-Strategy to Vault</h3>
            <p className="mb-3 text-xs text-gray-500">Register a new sub-strategy inside a MetaVault. Remember to call setWeights() afterwards so weights sum to 100%.</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <label className="label">Vault</label>
                <select className="input" value={addSubVault} onChange={(e) => setAddSubVault(e.target.value)}>
                  <option value="">Select vault…</option>
                  {(["vault1", "vault2", "vault3"] as VaultAssignment[]).map((vk) => (
                    vaultData[vk] ? <option key={vk} value={vk}>{VAULT_LABELS[vk].label}</option> : null
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Strategy Address</label>
                <input className="input" type="text" placeholder="0x..." value={addSubAddr} onChange={(e) => setAddSubAddr(e.target.value)} />
              </div>
              <div>
                <label className="label">Weight (bps)</label>
                <input className="input" type="number" placeholder="2500" value={addSubWeight} onChange={(e) => setAddSubWeight(e.target.value)} />
              </div>
              <div>
                <label className="label">Cap (USDC, 0=∞)</label>
                <input className="input" type="number" placeholder="0" value={addSubCap} onChange={(e) => setAddSubCap(e.target.value)} />
              </div>
            </div>
            <TxButton
              className="mt-3 w-full"
              onClick={() => {
                const vd = vaultData[addSubVault];
                if (vd) {
                  tx.send(() =>
                    vd.contract.addSubStrategy(
                      addSubAddr,
                      BigInt(addSubWeight),
                      ethers.parseUnits(addSubCap || "0", USDC_DECIMALS)
                    )
                  );
                }
              }}
              loading={tx.loading}
              disabled={!addSubVault || !isAddr(addSubAddr) || !addSubWeight}
            >
              Add Sub-Strategy
            </TxButton>
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
                <TxButton className="mt-2 w-full" onClick={() => tx.send(() => bridge!.setMinSignatures(BigInt(bridgeMinSigs)))} loading={tx.loading} disabled={!bridge || !bridgeMinSigs}>
                  Update
                </TxButton>
              </div>
              <div>
                <label className="label">Collateral Ratio (bps)</label>
                <input className="input" type="number" value={bridgeRatio} onChange={(e) => setBridgeRatio(e.target.value)} />
                <TxButton className="mt-2 w-full" onClick={() => tx.send(() => bridge!.setCollateralRatio(BigInt(bridgeRatio)))} loading={tx.loading} disabled={!bridge || !isValidBps(bridgeRatio)}>
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
              disabled={!bridge || !emergencyCap || !emergencyReason}
              variant="danger"
            >
              Emergency Reduce Cap
            </TxButton>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <TxButton onClick={() => tx.send(() => bridge!.pause())} loading={tx.loading} disabled={!bridge} variant="danger">
              Pause Bridge
            </TxButton>
            <TxButton onClick={() => tx.send(() => bridge!.requestUnpause())} loading={tx.loading} disabled={!bridge} variant="secondary">
              Request Unpause (24h delay)
            </TxButton>
            <TxButton onClick={() => tx.send(() => bridge!.executeUnpause())} loading={tx.loading} disabled={!bridge} variant="secondary">
              Execute Unpause
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
              disabled={!borrow || !isValidBps(newInterestRate)}
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
              disabled={!borrow || !newMinDebt}
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
              disabled={!oracle || !oracleToken || !oracleFeed || !isAddr(oracleToken) || !isAddr(oracleFeed)}
            >
              Set Feed
            </TxButton>
          </div>
        </div>
      )}
    </div>
  );
}

export default AdminPage;
