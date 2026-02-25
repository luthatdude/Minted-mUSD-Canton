/**
 * Safe decimal helpers for Canton token math.
 *
 * Canton/DAML uses 38-digit fixed-point Decimal with 10 decimal places.
 * JavaScript's IEEE 754 doubles have ~15-17 significant digits, which is
 * sufficient for the amounts we handle (< 1 billion mUSD) but comparison
 * with raw === or < is dangerous due to floating-point rounding.
 *
 * These helpers centralize the epsilon-based comparison pattern used
 * throughout the canton-*.ts API endpoints.
 */

/**
 * Default epsilon for mUSD comparisons.
 * Matches the 0.000001 (1e-6) threshold used across all endpoints.
 * This is safe for amounts up to ~1 billion mUSD.
 */
export const EPSILON = 0.000001;

/**
 * Parse a string amount to number, defaulting to 0 for invalid input.
 * Equivalent to `parseFloat(str || "0")` but with NaN safety.
 */
export function parseAmount(raw: string | number | undefined | null): number {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  const n = parseFloat(String(raw ?? "0"));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Check if `a >= b` within epsilon tolerance.
 * Used for balance sufficiency checks: `hasSufficient >= needed`.
 */
export function gte(a: number, b: number, eps = EPSILON): boolean {
  return a >= b - eps;
}

/**
 * Check if `a > b` beyond epsilon tolerance.
 * Used for change amount checks: `selectedSum - amount > epsilon`.
 */
export function gt(a: number, b: number, eps = EPSILON): boolean {
  return a > b + eps;
}

/**
 * Check if two amounts are approximately equal within epsilon.
 */
export function approxEqual(a: number, b: number, eps = EPSILON): boolean {
  return Math.abs(a - b) < eps;
}

/**
 * Sum an array of numeric values.
 */
export function sum(values: number[]): number {
  return values.reduce((s, v) => s + v, 0);
}

/**
 * Sum an array of objects by a numeric field extracted via accessor.
 */
export function sumBy<T>(items: T[], accessor: (item: T) => number): number {
  return items.reduce((s, item) => s + accessor(item), 0);
}

/**
 * Format amount for Canton DAML (10 decimal places).
 * Used for CreateCommand / ExerciseCommand arguments.
 */
export function toDamlDecimal(amount: number): string {
  return amount.toFixed(10);
}

/**
 * Format amount for display/response (6 decimal places).
 * Used for user-facing responses.
 */
export function toDisplay(amount: number): string {
  return amount.toFixed(6);
}
