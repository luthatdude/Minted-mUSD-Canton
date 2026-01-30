import React from "react";
import type { ActiveChain } from "@/hooks/useChain";

interface ChainToggleProps {
  chain: ActiveChain;
  onToggle: () => void;
}

export function ChainToggle({ chain, onToggle }: ChainToggleProps) {
  return (
    <button
      onClick={onToggle}
      className="flex items-center gap-2 rounded-full border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm font-medium transition hover:border-gray-600"
    >
      <span
        className={`h-2 w-2 rounded-full ${
          chain === "ethereum" ? "bg-blue-400" : "bg-emerald-400"
        }`}
      />
      <span className={chain === "ethereum" ? "text-blue-400" : "text-emerald-400"}>
        {chain === "ethereum" ? "Ethereum" : "Canton"}
      </span>
      <svg className="h-3 w-3 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
      </svg>
    </button>
  );
}
