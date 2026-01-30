import React, { useState, useEffect, useCallback } from "react";
import { StatCard } from "@/components/StatCard";
import LeverageSlider from "@/components/LeverageSlider";
import { useLoopWallet, LoopContract } from "@/hooks/useLoopWallet";
import WalletConnector from "@/components/WalletConnector";

// DAML template IDs - adjust package ID as needed
const PACKAGE_ID = process.env.NEXT_PUBLIC_DAML_PACKAGE_ID || "your-package-id";
const VAULT_TEMPLATE = `${PACKAGE_ID}:MintedProtocolV2Fixed:Vault`;
const COLLATERAL_TEMPLATE = `${PACKAGE_ID}:MintedProtocolV2Fixed:Collateral`;
const POOL_TEMPLATE = `${PACKAGE_ID}:MintedProtocol:LiquidityPool`;
const ORACLE_TEMPLATE = `${PACKAGE_ID}:MintedProtocolV2Fixed:PriceOracle`;
const LEVERAGE_MANAGER_TEMPLATE = `${PACKAGE_ID}:MintedProtocol:LeverageManager`;
const MUSD_TEMPLATE = `${PACKAGE_ID}:MintedProtocolV2Fixed:MUSD`;

export function CantonLeverage() {
  const loopWallet = useLoopWallet();
  
  const [depositAmount, setDepositAmount] = useState("");
  const [leverageX10, setLeverageX10] = useState(20); // Default 2x
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Contract IDs
  const [collateralCid, setCollateralCid] = useState("");
  const [vaultCid, setVaultCid] = useState("");
  const [poolCid, setPoolCid] = useState("");
  const [oracleCid, setOracleCid] = useState("");

  // State
  const [collaterals, setCollaterals] = useState<LoopContract[]>([]);
  const [vaults, setVaults] = useState<LoopContract[]>([]);
  const [pools, setPools] = useState<LoopContract[]>([]);
  const [leverageManagers, setLeverageManagers] = useState<LoopContract[]>([]);
  const [hasPosition, setHasPosition] = useState(false);
  const [currentVault, setCurrentVault] = useState<any>(null);

  // Load contracts using Loop SDK
  const loadContracts = useCallback(async () => {
    if (!loopWallet.isConnected) return;
    
    try {
      const [v, c, p, o, lm] = await Promise.all([
        loopWallet.queryContracts(VAULT_TEMPLATE),
        loopWallet.queryContracts(COLLATERAL_TEMPLATE),
        loopWallet.queryContracts(POOL_TEMPLATE),
        loopWallet.queryContracts(ORACLE_TEMPLATE),
        loopWallet.queryContracts(LEVERAGE_MANAGER_TEMPLATE),
      ]);
      
      setVaults(v);
      setCollaterals(c);
      setPools(p);
      setLeverageManagers(lm);
      
      // Find user's vault
      const userVault = v.find(vault => vault.payload.owner === loopWallet.partyId);
      if (userVault) {
        setVaultCid(userVault.contractId);
        setCurrentVault(userVault.payload);
        setHasPosition(userVault.payload.debtAmount > 0);
      }
      
      // Set first available contracts
      if (c.length > 0) setCollateralCid(c[0].contractId);
      if (p.length > 0) setPoolCid(p[0].contractId);
      if (o.length > 0) setOracleCid(o[0].contractId);
      
    } catch (err: any) {
      console.error("Failed to load contracts:", err);
      setError(err.message);
    }
  }, [loopWallet.isConnected, loopWallet.partyId, loopWallet.queryContracts]);

  useEffect(() => {
    loadContracts();
  }, [loadContracts]);

  // Calculate loops needed for target leverage
  const calculateLoops = (targetLeverage: number): number => {
    // Approximate: each loop adds ~LTV of current position
    // For 150% collateral ratio (66% LTV), need ~log(leverage)/log(1.66) loops
    const ltv = 0.66; // Approximate
    const loopsNeeded = Math.ceil(Math.log(targetLeverage / 10) / Math.log(1 + ltv));
    return Math.min(Math.max(loopsNeeded, 1), 10);
  };

  // Open leveraged position using Loop SDK
  async function handleOpenPosition() {
    if (!collateralCid || !poolCid || !oracleCid) {
      setError("Missing required contracts");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const loops = calculateLoops(leverageX10);
      
      // First, create or get existing vault
      let targetVaultCid = vaultCid;
      
      if (!targetVaultCid) {
        // Create new vault with initial collateral
        const createRes = await loopWallet.exerciseChoice(
          COLLATERAL_TEMPLATE,
          collateralCid,
          "CreateVault",
          { minCollateralRatio: 1.5 }
        );
        targetVaultCid = createRes.vaultCid;
      } else {
        // Deposit more collateral to existing vault
        if (depositAmount && parseFloat(depositAmount) > 0) {
          await loopWallet.exerciseChoice(
            VAULT_TEMPLATE,
            targetVaultCid,
            "Vault_Deposit",
            { depositCid: collateralCid }
          );
        }
      }

      // Find LeverageManager for this user
      const manager = leverageManagers.find(
        lm => lm.payload.user === loopWallet.partyId
      );
      
      if (!manager) {
        setError("No LeverageManager found. Contact admin to enable leverage.");
        setLoading(false);
        return;
      }

      // Execute leverage loops via Loop SDK
      const leverageRes = await loopWallet.exerciseChoice(
        LEVERAGE_MANAGER_TEMPLATE,
        manager.contractId,
        "Loop_Leverage",
        {
          vaultCid: targetVaultCid,
          oracleCid: oracleCid,
          poolCid: poolCid,
          loops: loops
        }
      );

      setResult(`Opened ${(leverageX10 / 10).toFixed(1)}x position with ${loops} loops`);
      setHasPosition(true);
      setDepositAmount("");
      
      // Refresh contracts
      await loadContracts();
      
    } catch (err: any) {
      setError(err.message || "Failed to open position");
    } finally {
      setLoading(false);
    }
  }

  // Close position (repay debt and withdraw)
  async function handleClosePosition() {
    if (!vaultCid) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      // Get mUSD to repay
      const musdContracts = await loopWallet.queryContracts(MUSD_TEMPLATE);
      const userMusd = musdContracts.find(m => m.payload.owner === loopWallet.partyId);
      
      if (!userMusd) {
        setError("No mUSD available to repay debt");
        setLoading(false);
        return;
      }

      // Repay all debt
      await loopWallet.exerciseChoice(
        VAULT_TEMPLATE,
        vaultCid,
        "Vault_Repay",
        { musdCid: userMusd.contractId }
      );

      // Withdraw all collateral
      await loopWallet.exerciseChoice(
        VAULT_TEMPLATE,
        vaultCid,
        "Vault_WithdrawCollateral",
        { amount: currentVault?.collateralAmount || 0 }
      );

      setResult("Position closed successfully");
      setHasPosition(false);
      setCurrentVault(null);
      
      // Refresh contracts
      await loadContracts();
      
    } catch (err: any) {
      setError(err.message || "Failed to close position");
    } finally {
      setLoading(false);
    }
  }

  // Not connected state
  if (!loopWallet.isConnected) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold text-white">Leverage Vault</h1>
        <p className="text-purple-400 text-sm font-medium">Canton Network (Daml Ledger)</p>
        
        <div className="max-w-md mx-auto">
          <WalletConnector mode="canton" />
        </div>
        
        <div className="text-center text-gray-400 py-8">
          Connect your Loop Wallet to use Canton leverage
        </div>
      </div>
    );
  }

  const effectiveLeverage = currentVault && currentVault.collateralAmount > 0
    ? (currentVault.collateralAmount / (currentVault.collateralAmount - currentVault.debtAmount * 1.5)).toFixed(2)
    : "1.0";

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-white">Leverage Vault</h1>
      <p className="text-emerald-400 text-sm font-medium">Canton Network (Daml Ledger)</p>

      {/* Stats Row */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard 
          label="Available Collateral" 
          value={collaterals[0]?.payload?.amount?.toFixed(2) || "0"} 
        />
        <StatCard 
          label="Current Leverage" 
          value={hasPosition ? `${effectiveLeverage}x` : "None"}
        />
        <StatCard 
          label="Vault Debt" 
          value={currentVault?.debtAmount?.toFixed(2) || "0"}
          subValue="mUSD"
        />
        <StatCard 
          label="Health Factor" 
          value={currentVault?.healthFactor?.toFixed(2) || "∞"}
        />
      </div>

      {!hasPosition ? (
        /* Open Position Form */
        <div className="bg-gray-900 rounded-2xl p-6 border border-gray-800">
          <h2 className="text-xl font-semibold text-white mb-6">Open Leveraged Position</h2>

          {/* Collateral Selection */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-400 mb-2">
              Collateral Contract
            </label>
            <select
              value={collateralCid}
              onChange={(e) => setCollateralCid(e.target.value)}
              className="w-full bg-gray-800 text-white rounded-xl px-4 py-3 border border-gray-700 
                focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 outline-none"
            >
              {collaterals.map((c) => (
                <option key={c.contractId} value={c.contractId}>
                  {c.payload.symbol}: {c.payload.amount?.toFixed(4)}
                </option>
              ))}
            </select>
          </div>

          {/* Leverage Slider */}
          <div className="mb-6">
            <LeverageSlider
              value={leverageX10}
              onChange={setLeverageX10}
              maxLeverage={30}
              disabled={loading}
            />
          </div>

          {/* Preview */}
          <div className="bg-gray-800 rounded-xl p-4 mb-6">
            <h4 className="text-sm font-medium text-gray-400 mb-3">Position Preview</h4>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-gray-500">Target Leverage:</span>
                <span className="text-white ml-2">{(leverageX10 / 10).toFixed(1)}x</span>
              </div>
              <div>
                <span className="text-gray-500">Estimated Loops:</span>
                <span className="text-white ml-2">{calculateLoops(leverageX10)}</span>
              </div>
              <div>
                <span className="text-gray-500">Min Collateral Ratio:</span>
                <span className="text-white ml-2">150%</span>
              </div>
              <div>
                <span className="text-gray-500">Liquidation Risk:</span>
                <span className={`ml-2 ${leverageX10 > 20 ? 'text-red-400' : 'text-green-400'}`}>
                  {leverageX10 > 25 ? 'High' : leverageX10 > 20 ? 'Medium' : 'Low'}
                </span>
              </div>
            </div>
          </div>

          {/* Action Button */}
          <button
            onClick={handleOpenPosition}
            disabled={loading || !collateralCid || collaterals.length === 0}
            className={`w-full py-4 rounded-xl font-semibold text-lg transition-all
              ${loading || !collateralCid
                ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white'
              }`}
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Opening Position...
              </span>
            ) : (
              `Open ${(leverageX10 / 10).toFixed(1)}x Position`
            )}
          </button>
        </div>
      ) : (
        /* Current Position */
        <div className="bg-gray-900 rounded-2xl p-6 border border-gray-800">
          <h2 className="text-xl font-semibold text-white mb-6">Your Position</h2>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-6 mb-6">
            <div className="bg-gray-800 rounded-xl p-4">
              <p className="text-sm text-gray-400">Collateral</p>
              <p className="text-xl font-bold text-white">
                {currentVault?.collateralAmount?.toFixed(4) || "0"}
              </p>
            </div>
            <div className="bg-gray-800 rounded-xl p-4">
              <p className="text-sm text-gray-400">Debt</p>
              <p className="text-xl font-bold text-white">
                {currentVault?.debtAmount?.toFixed(2) || "0"} mUSD
              </p>
            </div>
            <div className="bg-gray-800 rounded-xl p-4">
              <p className="text-sm text-gray-400">Effective Leverage</p>
              <p className="text-xl font-bold text-emerald-400">
                {effectiveLeverage}x
              </p>
            </div>
          </div>

          <button
            onClick={handleClosePosition}
            disabled={loading}
            className={`w-full py-4 rounded-xl font-semibold text-lg transition-all
              ${loading
                ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                : 'bg-red-600 hover:bg-red-500 text-white'
              }`}
          >
            {loading ? "Closing..." : "Close Position & Repay Debt"}
          </button>
        </div>
      )}

      {/* Result/Error Messages */}
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
