/**
 * Unified server-side Canton party resolver.
 *
 * Single source of truth for resolving a raw party identifier from
 * query/body parameters into the effective Canton party to query.
 *
 * Used by all server-side Canton API routes to ensure consistent
 * identity resolution across balances, preflight, ops-health, etc.
 */

const CANTON_PARTY = process.env.CANTON_PARTY || "";
const RECIPIENT_ALIAS_MAP_RAW = process.env.CANTON_RECIPIENT_PARTY_ALIASES || "";
const CANTON_PARTY_PATTERN = /^[A-Za-z0-9._:-]+::1220[0-9a-f]{64}$/i;

export { CANTON_PARTY_PATTERN };

function parseRecipientAliasMap(): Record<string, string> {
  if (!RECIPIENT_ALIAS_MAP_RAW.trim()) return {};
  try {
    const parsed = JSON.parse(RECIPIENT_ALIAS_MAP_RAW);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([from, to]) =>
          typeof from === "string" &&
          from.trim().length > 0 &&
          typeof to === "string" &&
          to.trim().length > 0
      )
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

const RECIPIENT_ALIAS_MAP = parseRecipientAliasMap();

// ── Alias policy guard ──────────────────────────────────────────────
// Block alias entries that map a non-operator key to the operator party.
// This prevents accidentally routing all wallet queries through the operator,
// which masks zero-balance issues and creates a privilege escalation risk.
function validateAliasPolicyGuard(aliases: Record<string, string>): void {
  if (process.env.ALLOW_OPERATOR_ALIAS_OVERRIDE === "true") return;
  if (!CANTON_PARTY) return;

  const operatorHint = CANTON_PARTY.split("::")[0];
  for (const [from, to] of Object.entries(aliases)) {
    const fromHint = from.split("::")[0];
    const isFromOperator = fromHint === operatorHint;
    const isToOperator = to === CANTON_PARTY || to.split("::")[0] === operatorHint;
    if (!isFromOperator && isToOperator) {
      throw new Error(
        `[canton-party-resolver] ALIAS POLICY VIOLATION: Non-operator key "${from.slice(0, 24)}..." ` +
        `maps to operator party. This masks real user balances. ` +
        `Fix: map to the user's own funded party, or set ALLOW_OPERATOR_ALIAS_OVERRIDE=true to bypass.`
      );
    }
  }
}
validateAliasPolicyGuard(RECIPIENT_ALIAS_MAP);

export interface ResolvedParty {
  /** The party that was requested (after trim, before alias resolution). */
  requestedParty: string;
  /** The party to actually query Canton with (after alias resolution). */
  resolvedParty: string;
  /** Whether the alias map changed the party identity. */
  wasAliased: boolean;
  /** Source of the alias mapping. */
  aliasSource: "env" | "none" | "fallback";
}

export interface ResolveOptions {
  /** Allow falling back to CANTON_PARTY when no party is provided. Default: false. */
  allowFallback?: boolean;
}

/**
 * Resolve a raw party from query or body into a validated, alias-resolved party.
 *
 * Resolution order:
 *   1. Validate format (strict Canton party pattern)
 *   2. Apply CANTON_RECIPIENT_PARTY_ALIASES map
 *   3. If no party provided and allowFallback=true, use CANTON_PARTY
 *
 * @throws Error if party is invalid or missing (when fallback is not allowed)
 */
export function resolveRequestedParty(
  rawParty: string | string[] | undefined,
  opts?: ResolveOptions
): ResolvedParty {
  const candidate = Array.isArray(rawParty) ? rawParty[0] : rawParty;

  if (!candidate || !candidate.trim()) {
    if (opts?.allowFallback && CANTON_PARTY) {
      return {
        requestedParty: CANTON_PARTY,
        resolvedParty: CANTON_PARTY,
        wasAliased: false,
        aliasSource: "fallback",
      };
    }
    throw new Error("Missing Canton party");
  }

  const party = candidate.trim();
  if (party.length > 200 || !CANTON_PARTY_PATTERN.test(party)) {
    throw new Error("Invalid Canton party");
  }

  const aliased = RECIPIENT_ALIAS_MAP[party];
  if (aliased) {
    if (process.env.NODE_ENV === "development") {
      console.debug("[canton-party-resolver] alias remap:", party, "\u2192", aliased);
    }
    return {
      requestedParty: party,
      resolvedParty: aliased,
      wasAliased: true,
      aliasSource: "env",
    };
  }

  return {
    requestedParty: party,
    resolvedParty: party,
    wasAliased: false,
    aliasSource: "none",
  };
}

/** The configured operator/default party (CANTON_PARTY env). */
export function getOperatorParty(): string {
  return CANTON_PARTY;
}
