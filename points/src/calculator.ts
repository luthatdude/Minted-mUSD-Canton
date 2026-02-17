// Points calculator — computes points accrual for protocol participants

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
  /** Referral kickback percentage (0-1) — referrer earns this % of referee points */
  referralKickbackPct: number;
  /** Depth decay factor for multi-level referrals */
  referralDepthDecay: number;
  /** Max referral chain depth */
  referralMaxDepth: number;
}

export const DEFAULT_CONFIG: PointsConfig = {
  musdHoldRate: 1.0,
  smusdStakeRate: 3.0,
  borrowRate: 2.0,
  lpRate: 5.0,
  cantonBridgeMultiplier: 1.5,
  referralBonus: 100,
  referralKickbackPct: 0.10,    // 10% of referee's points
  referralDepthDecay: 0.5,      // Grandparent gets 5% (10% × 0.5)
  referralMaxDepth: 2,
};

/**
 * TVL-based referral multiplier tiers (Ethena-style shards).
 * Referrers earn a multiplier on their kickback points based on
 * the cumulative TVL their referees contribute.
 */
export interface ReferralMultiplierTier {
  minTvlUsd: number;
  multiplier: number;
  label: string;
}

export const REFERRAL_TIERS: ReferralMultiplierTier[] = [
  { minTvlUsd: 1_000_000, multiplier: 3.0, label: "Diamond" },
  { minTvlUsd: 500_000,   multiplier: 2.5, label: "Platinum" },
  { minTvlUsd: 100_000,   multiplier: 2.0, label: "Gold" },
  { minTvlUsd: 10_000,    multiplier: 1.5, label: "Silver" },
];

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

/**
 * Get the referral multiplier for a given cumulative referred TVL.
 */
export function getReferralMultiplier(referredTvlUsd: number): number {
  for (const tier of REFERRAL_TIERS) {
    if (referredTvlUsd >= tier.minTvlUsd) {
      return tier.multiplier;
    }
  }
  return 1.0;
}

/**
 * Get the tier label for a given TVL.
 */
export function getReferralTierLabel(referredTvlUsd: number): string {
  for (const tier of REFERRAL_TIERS) {
    if (referredTvlUsd >= tier.minTvlUsd) {
      return tier.label;
    }
  }
  return "Bronze";
}

/**
 * Calculate kickback points for a referrer based on a referee's earned points.
 *
 * @param refEarnedPoints - Points the referee earned this epoch
 * @param depth           - Referral depth (1 = direct, 2 = grandparent, etc.)
 * @param referredTvlUsd  - Cumulative TVL referred (for tier multiplier)
 * @param config          - Points config
 * @returns kickback points to award to the referrer
 */
export function calculateReferralKickback(
  refEarnedPoints: number,
  depth: number,
  referredTvlUsd: number,
  config: PointsConfig = DEFAULT_CONFIG
): number {
  if (depth < 1 || depth > config.referralMaxDepth) return 0;

  const decayFactor = Math.pow(config.referralDepthDecay, depth - 1);
  const effectivePct = config.referralKickbackPct * decayFactor;
  const baseKickback = refEarnedPoints * effectivePct;
  const tierMultiplier = getReferralMultiplier(referredTvlUsd);

  return Math.floor(baseKickback * tierMultiplier);
}

/**
 * Full referral points calculation for all referrers in a single epoch.
 *
 * @param refereePoints  - Map of referee address → points earned this epoch
 * @param referralLinks  - Map of referee address → referrer address
 * @param referrerTvls   - Map of referrer address → cumulative referred TVL in USD
 * @param config         - Points config
 * @returns Map of referrer address → kickback points to award
 */
export function calculateEpochReferralKickbacks(
  refereePoints: Map<string, number>,
  referralLinks: Map<string, string>,   // referee → referrer
  referrerTvls: Map<string, number>,    // referrer → cumulative referred TVL
  config: PointsConfig = DEFAULT_CONFIG
): Map<string, number> {
  const kickbacks = new Map<string, number>();

  for (const [referee, earnedPoints] of refereePoints) {
    let current = referee;
    let depth = 0;

    while (depth < config.referralMaxDepth) {
      const referrer = referralLinks.get(current);
      if (!referrer) break;

      depth++;
      const referrerTvl = referrerTvls.get(referrer) || 0;
      const kickback = calculateReferralKickback(earnedPoints, depth, referrerTvl, config);

      if (kickback > 0) {
        kickbacks.set(referrer, (kickbacks.get(referrer) || 0) + kickback);
      }

      current = referrer;
    }
  }

  return kickbacks;
}

