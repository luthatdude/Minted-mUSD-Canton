/**
 * Minted Protocol — Points System Configuration
 *
 * Defines point-earning rules, multipliers, and tier thresholds
 * for the Minted loyalty / points program.
 */

export interface PointsConfig {
  /** Points earned per mUSD held per day */
  holdPointsPerMusdPerDay: number;
  /** Points earned per sMUSD staked per day (higher multiplier) */
  stakePointsPerSmusdPerDay: number;
  /** Points earned per $1 minted via DirectMint */
  mintPointsPerUsd: number;
  /** Points earned per $1 provided as collateral */
  collateralPointsPerUsd: number;
  /** Bonus multiplier for Canton-bridged positions */
  cantonBridgeMultiplier: number;
  /** Minimum balance to earn points (in mUSD, 18 decimals) */
  minBalanceForPoints: string;
  /** Snapshot interval in milliseconds */
  snapshotIntervalMs: number;
}

export interface TierConfig {
  name: string;
  minPoints: number;
  multiplier: number;
}

export const DEFAULT_POINTS_CONFIG: PointsConfig = {
  holdPointsPerMusdPerDay: 1,
  stakePointsPerSmusdPerDay: 3,
  mintPointsPerUsd: 10,
  collateralPointsPerUsd: 5,
  cantonBridgeMultiplier: 1.5,
  minBalanceForPoints: "100000000000000000000", // 100 mUSD
  snapshotIntervalMs: 86_400_000, // 24 hours
};

export const TIERS: TierConfig[] = [
  { name: "Bronze", minPoints: 0, multiplier: 1.0 },
  { name: "Silver", minPoints: 10_000, multiplier: 1.25 },
  { name: "Gold", minPoints: 100_000, multiplier: 1.5 },
  { name: "Platinum", minPoints: 1_000_000, multiplier: 2.0 },
];

/**
 * Get the tier for a given point balance.
 */
export function getTier(points: number): TierConfig {
  let current = TIERS[0];
  for (const tier of TIERS) {
    if (points >= tier.minPoints) current = tier;
  }
  return current;
}
