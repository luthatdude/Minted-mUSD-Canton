/**
 * Minted Protocol - Calculator Utilities
 *
 * Pure math functions for interest, health factor, and liquidation calculations.
 * No external dependencies — used by bot services and tests.
 */

/** Basis points denominator */
export const BPS = 10_000n;

/** Seconds per year (365.25 days) */
export const SECONDS_PER_YEAR = 31_557_600n;

/**
 * Calculate accrued interest for a borrow position.
 * @param principal  Current debt principal (18 decimals)
 * @param rateBps    Annual interest rate in basis points
 * @param elapsed    Seconds since last accrual
 * @returns Accrued interest amount (18 decimals)
 */
export function calculateInterest(
  principal: bigint,
  rateBps: bigint,
  elapsed: bigint,
): bigint {
  if (principal === 0n || rateBps === 0n || elapsed === 0n) return 0n;
  return (principal * rateBps * elapsed) / (BPS * SECONDS_PER_YEAR);
}

/**
 * Calculate health factor for a borrower.
 * @param collateralValueUsd  Total collateral value in USD (18 decimals)
 * @param debtUsd             Total debt in USD (18 decimals)
 * @param collateralFactorBps Collateral factor in BPS (e.g. 8000 = 80%)
 * @returns Health factor scaled by 10000 (10000 = 1.0)
 */
export function calculateHealthFactor(
  collateralValueUsd: bigint,
  debtUsd: bigint,
  collateralFactorBps: bigint,
): bigint {
  if (debtUsd === 0n) return BigInt(Number.MAX_SAFE_INTEGER);
  const adjustedCollateral = (collateralValueUsd * collateralFactorBps) / BPS;
  return (adjustedCollateral * BPS) / debtUsd;
}

/**
 * Calculate liquidation seize amount.
 * @param repayAmount      mUSD being repaid (18 decimals)
 * @param penaltyBps       Liquidation penalty in BPS
 * @param collateralPrice  Price of collateral in USD (18 decimals)
 * @param tokenDecimals    Decimals of the collateral token
 * @returns Amount of collateral to seize
 */
export function calculateSeizeAmount(
  repayAmount: bigint,
  penaltyBps: bigint,
  collateralPrice: bigint,
  tokenDecimals: number,
): bigint {
  const scale = 10n ** BigInt(tokenDecimals);
  return (repayAmount * (BPS + penaltyBps) * scale) / (BPS * collateralPrice);
}
