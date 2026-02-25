import React from "react";
import { ReferralWidget } from "@/components/ReferralWidget";

interface ProtocolStatsBlockProps {
  /** Already-formatted APY string, e.g. "4.50%" or "--%" */
  apyLabel: string;
  /** Already-formatted total supply, e.g. "$1,234,567.89" */
  totalSupply: string;
  supplySubValue?: string;
  /** Already-formatted total staked, e.g. "456,789.12" */
  totalStaked: string;
  stakedSubValue?: string;
}

export function ProtocolStatsBlock({
  apyLabel,
  totalSupply,
  supplySubValue,
  totalStaked,
  stakedSubValue,
}: ProtocolStatsBlockProps) {
  return (
    <>
      <div className="card-gradient-border p-8">
        <div className="grid gap-8 lg:grid-cols-3">
          <div className="space-y-2">
            <p className="text-sm font-medium text-gray-400">mUSD APY %</p>
            <p className="text-4xl font-bold text-emerald-400">{apyLabel}</p>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-gray-400">Total Supply</p>
            <p className="text-4xl font-bold text-gradient">{totalSupply}</p>
            {supplySubValue && (
              <p className="text-sm text-gray-500">{supplySubValue}</p>
            )}
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-gray-400">Total Staked</p>
            <p className="text-4xl font-bold text-gradient-emerald">{totalStaked}</p>
            {stakedSubValue && (
              <p className="text-sm text-gray-500">{stakedSubValue}</p>
            )}
          </div>
        </div>
      </div>

      <ReferralWidget />
    </>
  );
}
