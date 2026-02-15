import React, { useState, useEffect } from "react";
import { ethers } from "ethers";
import { TxButton } from "@/components/TxButton";
import { StatCard } from "@/components/StatCard";
import { useTx } from "@/hooks/useTx";
import { formatUSD, formatBps, formatToken } from "@/lib/format";
import { USDC_DECIMALS, MUSD_DECIMALS } from "@/lib/config";
import { useWalletConnect } from "@/hooks/useWalletConnect";
import { useWCContracts } from "@/hooks/useWCContracts";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import WalletConnector from "@/components/WalletConnector";
import { AIYieldOptimizer } from "@/components/AIYieldOptimizer";
import { YieldScanner } from "@/components/YieldScanner";

type AdminSection = "musd" | "directmint" | "treasury" | "bridge" | "borrow" | "oracle";

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGY CATALOG — all deployable yield strategies
// Addresses are populated from env vars; empty string = not yet deployed
// ═══════════════════════════════════════════════════════════════════════════
interface StrategyInfo {
  name: string;
  shortName: string;
  address: string;
  targetBps: number;
  apy: string;
  description: string;
  color: string;
}

const KNOWN_STRATEGIES: StrategyInfo[] = [
  {
    name: "Fluid Stable Loop #146",
    shortName: "Fluid #146",
    address: process.env.NEXT_PUBLIC_FLUID_STRATEGY_ADDRESS || "",
    targetBps: 3500,
    apy: "~14.3%",
    description: "syrupUSDC/USDC VaultT1 — leveraged stable loop via Fluid Protocol",
    color: "#06b6d4", // cyan
  },
  {
    name: "Pendle Multi-Pool",
    shortName: "Pendle",
    address: process.env.NEXT_PUBLIC_PENDLE_STRATEGY_ADDRESS || "",
    targetBps: 3000,
    apy: "~11.7%",
    description: "PT markets with auto-rollover and manual multi-pool allocation",
    color: "#8b5cf6", // violet
  },
  {
    name: "Morpho Leveraged Loop",
    shortName: "Morpho",
    address: process.env.NEXT_PUBLIC_MORPHO_STRATEGY_ADDRESS || "",
    targetBps: 2000,
    apy: "~11.5%",
    description: "3.3x leveraged USDC lending on Morpho Blue (70% LTV, 5 loops max)",
    color: "#3b82f6", // blue
  },
  {
    name: "Euler V2 RLUSD/USDC Cross-Stable",
    shortName: "Euler xStable",
    address: process.env.NEXT_PUBLIC_EULER_CROSS_STRATEGY_ADDRESS || "",
    targetBps: 1000,
    apy: "~8-12%",
    description: "Cross-stable leverage with depeg circuit breaker (RLUSD/USDC)",
    color: "#10b981", // emerald
  },
  {
    name: "Aave V3 Loop",
    shortName: "Aave V3",
    address: process.env.NEXT_PUBLIC_AAVE_STRATEGY_ADDRESS || "",
    targetBps: 0,
    apy: "~6-9%",
    description: "Leveraged supply/borrow loop on Aave V3",
    color: "#a855f7", // purple
  },
  {
    name: "Compound V3 Loop",
    shortName: "Compound",
    address: process.env.NEXT_PUBLIC_COMPOUND_STRATEGY_ADDRESS || "",
    targetBps: 0,
    apy: "~5-8%",
    description: "Leveraged supply/borrow loop on Compound V3",
    color: "#22c55e", // green
  },
  {
    name: "Contango Perp Loop",
    shortName: "Contango",
    address: process.env.NEXT_PUBLIC_CONTANGO_STRATEGY_ADDRESS || "",
    targetBps: 0,
    apy: "~8-14%",
    description: "Perp-based yield loop with flash loan leverage via Contango",
    color: "#f59e0b", // amber
  },
  {
    name: "Euler V2 Loop",
    shortName: "Euler V2",
    address: process.env.NEXT_PUBLIC_EULER_STRATEGY_ADDRESS || "",
    targetBps: 0,
    apy: "~7-10%",
    description: "Leveraged lending loop on Euler V2",
    color: "#14b8a6", // teal
  },
  {
    name: "Sky sUSDS Savings",
    shortName: "Sky sUSDS",
    address: process.env.NEXT_PUBLIC_SKY_STRATEGY_ADDRESS || "",
    targetBps: 0,
    apy: "~7.9%",
    description: "USDC → PSM → sUSDS savings vault (zero-slippage, no leverage)",
    color: "#f97316", // orange
  },
  {
    name: "MetaVault (Vault-of-Vaults)",
    shortName: "MetaVault",
    address: process.env.NEXT_PUBLIC_METAVAULT_ADDRESS || "",
    targetBps: 0,
    apy: "~12.5%",
    description: "Composable vault aggregating multiple sub-strategies with auto-rebalance",
    color: "#ec4899", // pink
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
  "Fluid #146": "fluid",
  "Pendle": "pendle",
  "Morpho": "morpho",
  "Euler xStable": "eulerCross",
  "Aave V3": "aave",
  "Compound": "compound",
  "Contango": "contango",
  "Euler V2": "euler",
  "Sky sUSDS": "sky",
  "MetaVault": "metavault",
};

function strategyKey(addr: string): string {
  const name = strategyName(addr);
  return STRATEGY_KEY_MAP[name] || addr.toLowerCase();
}

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

  const { musd, directMint, treasury, bridge, borrow, oracle } = contracts;

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
            setStrategyList(stratItems);
          } catch {}
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
      } catch {}
      setCurrentValues(vals);
    }
    loadCurrentValues();
  }, [musd, directMint, treasury, bridge, borrow, address, tx.success]);

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
          {/* ── Overview Stats ── */}
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Total Value" value={currentValues.totalBacking || "..."} />
            <StatCard label="Reserve (idle USDC)" value={currentValues.reserveBalance || "..."} color="green" />
            <StatCard label="Reserve Target (bps)" value={currentValues.maxDeploy || "..."} />
          </div>

          <div className="rounded-lg border border-amber-700/50 bg-amber-900/10 p-3 text-xs text-amber-400">
            <strong>Manual Deployment:</strong> All deposits sit idle in the reserve until you explicitly deploy them below.
            No funds are auto-allocated.
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
              disabled={!deployStratAddr || !deployAmount}
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
              disabled={!withdrawStratAddr || !withdrawAmount}
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
                value={strategyAddr}
                onChange={(e) => {
                  setStrategyAddr(e.target.value);
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
                value={strategyAddr}
                onChange={(e) => setStrategyAddr(e.target.value)}
              />
            </div>
            {strategyAddr && (
              <p className="mt-1 text-xs text-gray-400">
                {KNOWN_STRATEGIES.find(
                  (ks) => ks.address && ks.address.toLowerCase() === strategyAddr.toLowerCase()
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
            <TxButton
              className="mt-3 w-full"
              onClick={() => tx.send(() => treasury!.addStrategy(strategyAddr, BigInt(targetBps), BigInt(minBps), BigInt(maxBps), false))}
              loading={tx.loading}
              disabled={!strategyAddr || !targetBps || !minBps || !maxBps}
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
              value={strategyAddr}
              onChange={(e) => setStrategyAddr(e.target.value)}
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
              onClick={() => tx.send(() => treasury!.removeStrategy(strategyAddr))}
              loading={tx.loading}
              disabled={!strategyAddr}
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
              disabled={!reserveBps}
            >
              Set Reserve
            </TxButton>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <TxButton
              onClick={() => tx.send(() => treasury!.rebalance())}
              loading={tx.loading}
            >
              Rebalance All
            </TxButton>
            <TxButton
              onClick={() => tx.send(() => treasury!.claimFees())}
              loading={tx.loading}
              variant="secondary"
            >
              Claim Fees
            </TxButton>
            <TxButton
              onClick={() => tx.send(() => treasury!.emergencyWithdrawAll())}
              loading={tx.loading}
              variant="danger"
            >
              Emergency Withdraw All
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
    </div>
  );
}

export default AdminPage;
