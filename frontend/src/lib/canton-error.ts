/**
 * Maps raw Canton/DAML error strings to user-friendly messages.
 *
 * Canton API errors arrive as long gRPC strings containing DAML exception text.
 * This function pattern-matches known error signatures and returns concise,
 * actionable messages. Unknown errors are truncated to a safe display length.
 */

interface ErrorMapping {
  /** Substring to match in the raw error (case-insensitive). */
  pattern: string;
  /** User-facing message to display. */
  message: string;
  /** Classification tag for diagnostics. */
  tag: "POLICY_DISABLED" | "SERVICE_NOT_DEPLOYED" | "CONTRACT_STALE" | "INFRA" | "VALIDATION";
}

const ERROR_MAPPINGS: ErrorMapping[] = [
  // ── Policy / deployment gates ──
  {
    pattern: "USDCX_MINTING_DISABLED",
    message: "USDCx minting is disabled by protocol policy on this network.",
    tag: "POLICY_DISABLED",
  },
  {
    pattern: "MINTING_PAUSED",
    message: "Minting is currently paused by the protocol operator.",
    tag: "POLICY_DISABLED",
  },
  {
    pattern: "LENDING_PAUSED",
    message: "Lending operations are currently paused by the protocol operator.",
    tag: "POLICY_DISABLED",
  },
  {
    pattern: "CoinMintService is not deployed",
    message: "Coin mint service is not deployed on this network.",
    tag: "SERVICE_NOT_DEPLOYED",
  },

  // ── Contract staleness ──
  {
    pattern: "CONTRACT_NOT_FOUND",
    message: "A referenced contract was consumed by another transaction. Please retry.",
    tag: "CONTRACT_STALE",
  },
  {
    pattern: "Contract could not be found with id",
    message: "A referenced contract was consumed by another transaction. Please retry.",
    tag: "CONTRACT_STALE",
  },
  {
    pattern: "INCONSISTENT",
    message: "Ledger state changed during the transaction. Please retry.",
    tag: "CONTRACT_STALE",
  },

  // ── Infrastructure / relay ──
  {
    pattern: "ECONNREFUSED",
    message: "Canton ledger is not reachable. Check that the network is running.",
    tag: "INFRA",
  },
  {
    pattern: "UNAVAILABLE",
    message: "Canton service is temporarily unavailable. Try again in a moment.",
    tag: "INFRA",
  },
  {
    pattern: "DEADLINE_EXCEEDED",
    message: "Canton request timed out. The network may be under heavy load.",
    tag: "INFRA",
  },
  {
    pattern: "Canton API unavailable",
    message: "Canton API is not reachable. Check network connectivity.",
    tag: "INFRA",
  },

  // ── Validation ──
  {
    pattern: "PRICE_STALE",
    message: "Price feed data is stale. Refreshing prices — please retry.",
    tag: "VALIDATION",
  },
  {
    pattern: "INSUFFICIENT_COLLATERAL",
    message: "Insufficient collateral for this operation. Deposit more collateral first.",
    tag: "VALIDATION",
  },
  {
    pattern: "BELOW_MIN_BORROW",
    message: "Amount is below the minimum borrow threshold.",
    tag: "VALIDATION",
  },
];

const MAX_DISPLAY_LENGTH = 200;

/**
 * Sanitize a raw Canton/DAML error into a user-friendly message.
 * Returns `{ message, tag }` where `tag` classifies the error type.
 */
export function sanitizeCantonError(raw: string): { message: string; tag: string } {
  if (!raw) return { message: "An unknown error occurred.", tag: "UNKNOWN" };

  const lower = raw.toLowerCase();
  for (const mapping of ERROR_MAPPINGS) {
    if (lower.includes(mapping.pattern.toLowerCase())) {
      return { message: mapping.message, tag: mapping.tag };
    }
  }

  // Fallback: truncate raw error to safe display length
  const cleaned = raw
    .replace(/^Canton API \d+:\s*/i, "")
    .replace(/io\.grpc\.\w+Exception:\s*/g, "")
    .trim();

  if (cleaned.length <= MAX_DISPLAY_LENGTH) {
    return { message: cleaned, tag: "UNKNOWN" };
  }
  return { message: cleaned.slice(0, MAX_DISPLAY_LENGTH) + "...", tag: "UNKNOWN" };
}

/**
 * Check if an error indicates a stale contract (CONTRACT_NOT_FOUND / INCONSISTENT).
 */
export function isStaleContractError(errorMsg: string): boolean {
  const lower = (errorMsg || "").toLowerCase();
  return (
    lower.includes("contract_not_found") ||
    lower.includes("contract could not be found with id") ||
    lower.includes("inconsistent")
  );
}
