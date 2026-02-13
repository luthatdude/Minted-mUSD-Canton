// Points calculator — computes points accrual for protocol participants
// FIX H-06: Populated stub file (was 0-byte)

export interface PointsConfig {
  /** Points per dollar per day for mUSD holders */
  musdHoldRate: number;
  /** Points per dollar per day for smUSD stakers */
  smusdStakeRate: number;
  /** Points per dollar per day for borrowers */
  borrowRate: number;
  /** Points per dollar per day for liquidity providers */
  lpRate: number;
  /** Multiplier for Canton bridge users */
  cantonBridgeMultiplier: number;
  /** Points per successful referral */
  referralBonus: number;
}

export const DEFAULT_CONFIG: PointsConfig = {
  musdHoldRate: 1.0,
  smusdStakeRate: 3.0,
  borrowRate: 2.0,
  lpRate: 5.0,
  cantonBridgeMultiplier: 1.5,
  referralBonus: 100,
};

/**
 * Calculate points for a user over a time period.
 */
export function calculatePoints(
  balanceUsd: number,
  durationDays: number,
  rate: number,
  multiplier: number = 1.0
): number {
  return balanceUsd * durationDays * rate * multiplier;
}
