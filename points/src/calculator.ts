/**
 * Minted Protocol — Points Calculator
 *
 * Computes points earned by users based on their on-chain activity:
 * holding mUSD, staking sMUSD, minting, providing collateral, bridging.
 */

import { PointsConfig, DEFAULT_POINTS_CONFIG, getTier } from "./config";

export interface UserActivity {
  address: string;
  musdBalance: number;
  smusdBalance: number;
  totalMinted: number;
  totalCollateral: number;
  cantonBridged: boolean;
  currentPoints: number;
}

export interface PointsBreakdown {
  holdPoints: number;
  stakePoints: number;
  mintPoints: number;
  collateralPoints: number;
  bridgeBonus: number;
  tierMultiplier: number;
  totalNewPoints: number;
}

/**
 * Calculate points earned for one snapshot period (default: 1 day).
 */
export function calculatePoints(
  activity: UserActivity,
  config: PointsConfig = DEFAULT_POINTS_CONFIG
): PointsBreakdown {
  const holdPoints = activity.musdBalance * config.holdPointsPerMusdPerDay;
  const stakePoints = activity.smusdBalance * config.stakePointsPerSmusdPerDay;
  const mintPoints = activity.totalMinted * config.mintPointsPerUsd;
  const collateralPoints = activity.totalCollateral * config.collateralPointsPerUsd;

  const subtotal = holdPoints + stakePoints + mintPoints + collateralPoints;

  // Canton bridge bonus
  const bridgeBonus = activity.cantonBridged
    ? subtotal * (config.cantonBridgeMultiplier - 1)
    : 0;

  // Tier multiplier based on existing points
  const tier = getTier(activity.currentPoints);

  const totalNewPoints = (subtotal + bridgeBonus) * tier.multiplier;

  return {
    holdPoints,
    stakePoints,
    mintPoints,
    collateralPoints,
    bridgeBonus,
    tierMultiplier: tier.multiplier,
    totalNewPoints: Math.floor(totalNewPoints),
  };
}

/**
 * Batch-calculate points for multiple users.
 */
export function calculateBatchPoints(
  activities: UserActivity[],
  config: PointsConfig = DEFAULT_POINTS_CONFIG
): Map<string, PointsBreakdown> {
  const results = new Map<string, PointsBreakdown>();
  for (const activity of activities) {
    results.set(activity.address, calculatePoints(activity, config));
  }
  return results;
}
