import React from "react";

interface CantonIdentityStatusProps {
  connectedParty: string | null;
  effectiveParty: string | null;
  aliasApplied: boolean;
}

function shortenParty(party: string): string {
  if (party.length <= 36) return party;
  return `${party.slice(0, 20)}\u2026${party.slice(-8)}`;
}

export function CantonIdentityStatus({
  connectedParty,
  effectiveParty,
  aliasApplied,
}: CantonIdentityStatusProps) {
  if (!connectedParty && !effectiveParty) return null;

  const isDirect = !aliasApplied || connectedParty === effectiveParty;
  const statusLabel = isDirect ? "Direct" : "Aliased";
  const statusColor = isDirect
    ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
    : "text-amber-400 bg-amber-500/10 border-amber-500/20";

  return (
    <div className="rounded-lg border border-white/10 bg-surface-800/50 px-4 py-3 text-xs">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-gray-500 shrink-0">Connected:</span>
          <span className="font-mono text-gray-300 truncate" title={connectedParty || effectiveParty || ""}>
            {shortenParty(connectedParty || effectiveParty || "\u2014")}
          </span>
        </div>

        {aliasApplied && effectiveParty && connectedParty && connectedParty !== effectiveParty && (
          <>
            <svg className="h-3 w-3 text-gray-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-gray-500 shrink-0">Effective:</span>
              <span className="font-mono text-gray-300 truncate" title={effectiveParty}>
                {shortenParty(effectiveParty)}
              </span>
            </div>
          </>
        )}

        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusColor}`}>
          {statusLabel}
        </span>
      </div>

      {aliasApplied && !isDirect && (
        <p className="mt-1.5 text-gray-500">
          Actions execute as local party due to devnet alias mapping.
        </p>
      )}
    </div>
  );
}
