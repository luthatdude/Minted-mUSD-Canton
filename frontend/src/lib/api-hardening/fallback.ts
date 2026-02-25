/**
 * Canonical fallback classification for CIP-56 native → hybrid flows.
 *
 * The strict policy is:
 *   - Infra/transient errors (409, 5xx, network timeout) → ALLOW fallback to hybrid
 *   - Business/policy errors (400, 401, 403, 404) → BLOCK fallback, surface to user
 *
 * This module provides a single source of truth so that frontend components
 * (CantonBorrow, CantonStake, CantonBridge) and API endpoints use identical
 * classification logic.
 */

export type FallbackDecision = "allow" | "block";

export interface FallbackResult {
  decision: FallbackDecision;
  reason: string;
}

/**
 * Classify an HTTP status code for fallback eligibility.
 *
 * @param status — HTTP status code from native CIP-56 endpoint (0 for network error)
 * @returns FallbackResult with decision and human-readable reason
 */
export function classifyFallback(status: number): FallbackResult {
  // Network error / timeout — no status code available
  if (status === 0 || !Number.isFinite(status)) {
    return { decision: "allow", reason: "network-error" };
  }

  // 409 Conflict — inventory contention, safe to retry via hybrid
  if (status === 409) {
    return { decision: "allow", reason: "inventory-conflict" };
  }

  // 5xx — server/infrastructure error, safe to retry via hybrid
  if (status >= 500 && status < 600) {
    return { decision: "allow", reason: "server-error" };
  }

  // Everything else (400, 401, 403, 404, etc.) — business/policy error, surface to user
  return { decision: "block", reason: "business-error" };
}

/**
 * Convenience: returns true if hybrid fallback is allowed for this status.
 */
export function isFallbackAllowed(status: number): boolean {
  return classifyFallback(status).decision === "allow";
}

/**
 * Convenience: returns true if this is a business error that should surface.
 */
export function isBusinessError(status: number): boolean {
  return classifyFallback(status).decision === "block";
}
