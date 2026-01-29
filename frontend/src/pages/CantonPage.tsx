import React, { useState, useEffect } from "react";
import { useCanton } from "@/hooks/useCanton";

interface CantonContract {
  contractId: string;
  templateId: string;
  payload: Record<string, any>;
}

const DAML_TEMPLATES = [
  { id: "MintedProtocolV2Fixed:MUSD", label: "MUSD Assets" },
  { id: "MintedProtocolV2Fixed:Collateral", label: "Collateral" },
  { id: "MintedProtocolV2Fixed:USDC", label: "USDC Tokens" },
  { id: "MintedProtocolV2Fixed:TransferProposal", label: "Transfer Proposals" },
  { id: "MintedProtocolV2Fixed:DirectMintService", label: "Direct Mint Service" },
  { id: "MintedProtocolV2Fixed:StakingService", label: "Staking Service" },
  { id: "MintedProtocolV2Fixed:Vault", label: "Vaults (CDPs)" },
  { id: "MintedProtocolV2Fixed:LiquidityPool", label: "Liquidity Pool" },
  { id: "MintedProtocolV2Fixed:PriceOracle", label: "Price Oracle" },
  { id: "MintedProtocolV2Fixed:AttestationRequest", label: "Attestation Requests" },
  { id: "MintedProtocolV2Fixed:IssuerRole", label: "Issuer Role" },
  { id: "MUSD_Protocol:MintingService", label: "Minting Service (v1)" },
  { id: "MUSD_Protocol:StakingService", label: "Staking Service (v1)" },
  { id: "MUSD_Protocol:BridgeService", label: "Bridge Service" },
  { id: "MUSD_Protocol:BridgeClaim", label: "Bridge Claims" },
];

export function CantonPage() {
  const canton = useCanton();
  const [tokenInput, setTokenInput] = useState("");
  const [partyInput, setPartyInput] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState(DAML_TEMPLATES[0].id);
  const [contracts, setContracts] = useState<CantonContract[]>([]);
  const [loading, setLoading] = useState(false);

  // Exercise choice state
  const [exerciseContract, setExerciseContract] = useState<CantonContract | null>(null);
  const [choiceName, setChoiceName] = useState("");
  const [choiceArgs, setChoiceArgs] = useState("{}");
  const [exerciseResult, setExerciseResult] = useState<any>(null);

  function handleConnect() {
    canton.setToken(tokenInput, partyInput);
  }

  async function handleQuery() {
    setLoading(true);
    setContracts([]);
    try {
      const results = await canton.query(selectedTemplate);
      setContracts(results);
    } catch (err) {
      console.error("Query error:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleExercise() {
    if (!exerciseContract) return;
    try {
      const args = JSON.parse(choiceArgs);
      const result = await canton.exercise(
        exerciseContract.templateId,
        exerciseContract.contractId,
        choiceName,
        args
      );
      setExerciseResult(result);
    } catch (err: any) {
      setExerciseResult({ error: err.message });
    }
  }

  // Choices available per template
  const TEMPLATE_CHOICES: Record<string, string[]> = {
    "MintedProtocolV2Fixed:MUSD": ["MUSD_Split", "MUSD_Merge", "MUSD_Transfer", "MUSD_Burn"],
    "MintedProtocolV2Fixed:TransferProposal": [
      "TransferProposal_Accept", "TransferProposal_Reject",
      "TransferProposal_Cancel", "TransferProposal_Expire",
    ],
    "MintedProtocolV2Fixed:DirectMintService": [
      "DirectMint_Mint", "DirectMint_Redeem",
      "DirectMint_UpdateSupplyCap", "DirectMint_SetPaused", "DirectMint_WithdrawFees",
    ],
    "MintedProtocolV2Fixed:StakingService": ["Stake", "Unstake"],
    "MintedProtocolV2Fixed:Vault": [
      "Vault_Deposit", "Vault_Borrow", "Vault_Repay",
      "Vault_WithdrawCollateral", "Vault_GetHealthFactor",
    ],
    "MintedProtocolV2Fixed:LiquidityPool": ["Pool_SwapMUSDForCollateral"],
    "MintedProtocolV2Fixed:PriceOracle": ["GetPrice", "UpdatePrices"],
    "MintedProtocolV2Fixed:AttestationRequest": ["ProvideSignature", "FinalizeAttestation"],
    "MintedProtocolV2Fixed:IssuerRole": ["MintFromAttestation", "DirectMint"],
    "MUSD_Protocol:MintingService": ["Mint_Musd", "Burn_Musd"],
    "MUSD_Protocol:StakingService": ["Stake", "Unstake"],
    "MUSD_Protocol:BridgeService": ["Lock_Musd_For_Bridge"],
    "MUSD_Protocol:BridgeClaim": ["Add_Attestation", "Finalize_Bridge_Mint"],
  };

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-white">Canton Network</h1>
      <p className="text-gray-400">Interact with Daml contracts on Canton Network</p>

      {/* Connection */}
      {!canton.connected ? (
        <div className="card space-y-4">
          <h2 className="text-lg font-semibold text-gray-300">Connect to Canton Ledger</h2>
          <div>
            <label className="label">Party ID</label>
            <input
              type="text"
              className="input"
              placeholder="Alice::1234..."
              value={partyInput}
              onChange={(e) => setPartyInput(e.target.value)}
            />
          </div>
          <div>
            <label className="label">JWT Token</label>
            <input
              type="password"
              className="input"
              placeholder="Bearer token"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
            />
          </div>
          <button onClick={handleConnect} className="btn-primary">
            Connect
          </button>
        </div>
      ) : (
        <div className="card flex items-center justify-between">
          <div>
            <p className="text-sm text-gray-400">Connected as</p>
            <p className="font-mono text-sm text-brand-400">{canton.party}</p>
          </div>
          <button onClick={canton.disconnect} className="btn-secondary text-sm">
            Disconnect
          </button>
        </div>
      )}

      {canton.error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 p-4 text-sm text-red-400">
          {canton.error}
        </div>
      )}

      {/* Query contracts */}
      {canton.connected && (
        <div className="card space-y-4">
          <h2 className="text-lg font-semibold text-gray-300">Query Contracts</h2>
          <div className="flex flex-wrap gap-4">
            <div className="flex-1 min-w-[200px]">
              <label className="label">Template</label>
              <select
                className="input"
                value={selectedTemplate}
                onChange={(e) => setSelectedTemplate(e.target.value)}
              >
                {DAML_TEMPLATES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <button onClick={handleQuery} className="btn-primary" disabled={loading}>
                {loading ? "Querying..." : "Query"}
              </button>
            </div>
          </div>

          {/* Results */}
          {contracts.length > 0 && (
            <div className="space-y-3">
              <p className="text-sm text-gray-400">{contracts.length} contract(s) found</p>
              {contracts.map((c, i) => (
                <div key={c.contractId} className="rounded-lg border border-gray-700 bg-gray-800 p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="font-mono text-xs text-gray-500">{c.contractId}</p>
                      <p className="text-sm text-brand-400">{c.templateId}</p>
                    </div>
                    <button
                      onClick={() => setExerciseContract(c)}
                      className="btn-secondary text-xs"
                    >
                      Exercise
                    </button>
                  </div>
                  <pre className="mt-2 max-h-40 overflow-auto rounded bg-gray-900 p-2 text-xs text-gray-300">
                    {JSON.stringify(c.payload, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Exercise choice */}
      {exerciseContract && (
        <div className="card space-y-4">
          <h2 className="text-lg font-semibold text-gray-300">Exercise Choice</h2>
          <p className="font-mono text-xs text-gray-500">{exerciseContract.contractId}</p>

          <div>
            <label className="label">Choice</label>
            <select
              className="input"
              value={choiceName}
              onChange={(e) => setChoiceName(e.target.value)}
            >
              <option value="">Select choice...</option>
              {(TEMPLATE_CHOICES[exerciseContract.templateId] || []).map((ch) => (
                <option key={ch} value={ch}>
                  {ch}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">Arguments (JSON)</label>
            <textarea
              className="input font-mono text-sm"
              rows={4}
              value={choiceArgs}
              onChange={(e) => setChoiceArgs(e.target.value)}
            />
          </div>

          <div className="flex gap-2">
            <button onClick={handleExercise} className="btn-primary" disabled={!choiceName}>
              Execute
            </button>
            <button onClick={() => setExerciseContract(null)} className="btn-secondary">
              Cancel
            </button>
          </div>

          {exerciseResult && (
            <pre className="mt-2 max-h-60 overflow-auto rounded bg-gray-900 p-3 text-xs text-gray-300">
              {JSON.stringify(exerciseResult, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
