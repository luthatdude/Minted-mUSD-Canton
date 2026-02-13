// Canton Dashboard Mint — Canton Network-specific minting within the dashboard view
// Populated stub file (was 0-byte)

import React, { useState, useCallback } from "react";
import { StatCard } from "@/components/StatCard";
import { useLoopWallet, LoopContract } from "@/hooks/useLoopWallet";
import WalletConnector from "@/components/WalletConnector";

const PACKAGE_ID = process.env.NEXT_PUBLIC_DAML_PACKAGE_ID || "";
const templates = {
  DirectMintService: `${PACKAGE_ID}:MintedProtocolV2Fixed:DirectMintService`,
  USDC: `${PACKAGE_ID}:MintedProtocolV2Fixed:USDC`,
  MUSD: `${PACKAGE_ID}:MintedProtocolV2Fixed:MUSD`,
};

export function CantonDashboardMint() {
  const loopWallet = useLoopWallet();
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usdcContracts, setUsdcContracts] = useState<LoopContract[]>([]);
  const [musdContracts, setMusdContracts] = useState<LoopContract[]>([]);

  const fetchBalances = useCallback(async () => {
    if (!loopWallet.isConnected) return;
    try {
      const usdc = await loopWallet.queryContracts(templates.USDC);
      const musd = await loopWallet.queryContracts(templates.MUSD);
      setUsdcContracts(usdc);
      setMusdContracts(musd);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch balances");
    }
  }, [loopWallet]);

  const handleMint = useCallback(async () => {
    if (!loopWallet.isConnected || !amount || usdcContracts.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      // Exercise DirectMint_Mint on the DirectMintService
      const services = await loopWallet.queryContracts(templates.DirectMintService);
      if (services.length === 0) throw new Error("No DirectMintService found");
      await loopWallet.exerciseChoice(services[0].contractId, "DirectMint_Mint", {
        usdcCid: usdcContracts[0].contractId,
        amount,
      });
      await fetchBalances();
      setAmount("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Mint failed");
    } finally {
      setLoading(false);
    }
  }, [loopWallet, amount, usdcContracts, fetchBalances]);

  if (!loopWallet.isConnected) {
    return <WalletConnector />;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <StatCard label="Canton USDC" value={`${usdcContracts.length} contracts`} />
        <StatCard label="Canton mUSD" value={`${musdContracts.length} contracts`} />
      </div>
      <div className="bg-gray-900 rounded-xl p-6">
        <h3 className="text-lg font-semibold mb-4">Canton Mint</h3>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount to mint"
          className="w-full px-4 py-2 bg-gray-800 rounded-lg border border-gray-700 mb-4"
        />
        <button
          onClick={handleMint}
          disabled={loading || !amount}
          className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg font-semibold"
        >
          {loading ? "Minting..." : "Mint mUSD on Canton"}
        </button>
        {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
      </div>
    </div>
  );
}

export default CantonDashboardMint;
