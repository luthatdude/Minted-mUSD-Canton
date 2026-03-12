/**
 * API Hardening Utilities — Barrel export.
 *
 * Usage:
 *   import { validateConfig, classifyFallback, IdempotencyStore } from "@/lib/api-hardening";
 */

export {
  CANTON_PARTY_PATTERN,
  PKG_ID_PATTERN,
  getCantonBaseUrl,
  getCantonToken,
  getCantonParty,
  getCantonUser,
  getPackageId,
  getLendingPackageId,
  getCip56PackageId,
  getV3PackageIds,
  validateConfig,
  validatePartyInput,
} from "./env";
export type { ConfigError } from "./env";

export {
  classifyFallback,
  isFallbackAllowed,
  isBusinessError,
} from "./fallback";
export type { FallbackDecision, FallbackResult } from "./fallback";

export {
  EPSILON,
  parseAmount,
  gte,
  gt,
  approxEqual,
  sum,
  sumBy,
  toDamlDecimal,
  toDisplay,
} from "./decimal";

export {
  IdempotencyStore,
  deriveIdempotencyKey,
} from "./idempotency";
export type { IdempotencyStoreOptions } from "./idempotency";

export {
  guardMethod,
  guardBodyParty,
  guardBodyPartyResolved,
  guardQueryParty,
} from "./auth";
export type { HttpMethod, ResolvedParty } from "./auth";
