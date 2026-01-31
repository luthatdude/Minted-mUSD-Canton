import React, { useState, useEffect } from "react";
import { ethers } from "ethers";
import { TxButton } from "@/components/TxButton";
import { StatCard } from "@/components/StatCard";
import { useTx } from "@/hooks/useTx";
import { formatUSD, formatBps, formatToken } from "@/lib/format";
import { USDC_DECIMALS, MUSD_DECIMALS } from "@/lib/config";
import { useWalletConnect } from "@/hooks/useWalletConnect";
import { useWCContracts } from "@/hooks/useWCContracts";
import WalletConnector from "@/components/WalletConnector";

type AdminSection = "musd" | "directmint" | "treasury" | "bridge" | "borrow" | "oracle";

export function AdminPage() {
  const { address, isConnected } = useWalletConnect();
  const contracts = useWCContracts();
  const [section, setSection] = useState<AdminSection>("musd");
  const tx = useTx();

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
  const [deployAmount, setDeployAmount] = useState("");
  const [maxDeployBps, setMaxDeployBps] = useState("");

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
          vals.maxDeploy = formatBps(await treasury.maxDeploymentBps());
          vals.totalBacking = formatUSD(await treasury.totalBacking(), 6);
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
          <div className="grid gap-4 sm:grid-cols-2">
            <StatCard label="Total Backing" value={currentValues.totalBacking || "..."} />
            <StatCard label="Max Deployment" value={currentValues.maxDeploy || "..."} />
          </div>
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Deploy to Strategy</h3>
            <div>
              <label className="label">Strategy Address</label>
              <input className="input" type="text" placeholder="0x..." value={strategyAddr} onChange={(e) => setStrategyAddr(e.target.value)} />
            </div>
            <div className="mt-3">
              <label className="label">Amount (USDC)</label>
              <input className="input" type="number" value={deployAmount} onChange={(e) => setDeployAmount(e.target.value)} />
            </div>
            <TxButton
              className="mt-3 w-full"
              onClick={() => tx.send(() => treasury!.deployToStrategy(strategyAddr, ethers.parseUnits(deployAmount, USDC_DECIMALS)))}
              loading={tx.loading}
              disabled={!strategyAddr || !deployAmount}
            >
              Deploy
            </TxButton>
          </div>
          <div className="card">
            <h3 className="mb-3 font-semibold text-gray-300">Max Deployment (bps)</h3>
            <input className="input" type="number" placeholder="9000" value={maxDeployBps} onChange={(e) => setMaxDeployBps(e.target.value)} />
            <TxButton
              className="mt-3 w-full"
              onClick={() => tx.send(() => treasury!.setMaxDeploymentBps(BigInt(maxDeployBps)))}
              loading={tx.loading}
              disabled={!maxDeployBps}
            >
              Set Max Deployment
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
                  oracle!.setFeed(oracleToken, oracleFeed, BigInt(oracleStale), parseInt(oracleDecimals))
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
