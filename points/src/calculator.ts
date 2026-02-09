/**
 * Minted Points — Calculator
 *
 * Takes raw balance snapshots and calculates points earned.
 *
 * Formula:  points = USD_value × multiplier × hours_elapsed
 *
 * For each new snapshot, we look at the user's value at that moment,
 * apply the season multiplier, and multiply by the time since their
 * last snapshot (in hours). This gives dollar-hour weighted points.
 */

import {
  PointAction,
  getCurrentSeason,
  getSeasonById,
  SEASONS,
  type SeasonConfig,
} from "./config";
import {
  getDb,
  addPoints,
  refreshLeaderboard,
  getMetadata,
  setMetadata,
  type SnapshotRow,
} from "./db";

// ═══════════════════════════════════════════════════════════════════════════
// CORE CALCULATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Process a batch of snapshot rows and accumulate points.
 *
 * For each row, we find the user's previous snapshot for the same
 * (chain, action) and compute hours elapsed. Points are:
 *
 *   points = value_usd × multiplier × hours_since_last
 *
 * This rewards consistent participation — you earn more the longer
 * you hold a position.
 */
export function processSnapshots(rows: SnapshotRow[]): {
  totalPointsAwarded: number;
  usersProcessed: number;
} {
  if (rows.length === 0) return { totalPointsAwarded: 0, usersProcessed: 0 };

  const d = getDb();
  let totalPointsAwarded = 0;
  const usersProcessed = new Set<string>();

  for (const row of rows) {
    const season = getSeasonById(row.season_id);
    if (!season) continue;

    const multiplier = season.multipliers[row.action as PointAction];
    if (!multiplier || multiplier <= 0) continue;

    // Find the user's last snapshot time for this specific action
    const lastSnapshot = d.prepare(`
      SELECT timestamp FROM snapshots
      WHERE chain = ? AND user_address = ? AND action = ? AND timestamp < ?
      ORDER BY timestamp DESC
      LIMIT 1
    `).get(row.chain, row.user_address, row.action, row.timestamp) as { timestamp: string } | undefined;

    // Calculate hours elapsed
    let hoursElapsed: number;
    if (lastSnapshot) {
      const lastTime = new Date(lastSnapshot.timestamp).getTime();
      const currentTime = new Date(row.timestamp).getTime();
      hoursElapsed = (currentTime - lastTime) / (1000 * 60 * 60);
    } else {
      // First snapshot for this user+action — award 1 hour (the snapshot interval)
      hoursElapsed = 1;
    }

    // Cap at reasonable max (in case of gaps)
    hoursElapsed = Math.min(hoursElapsed, 24);

    // Calculate points
    const points = row.value_usd * multiplier * hoursElapsed;

    if (points > 0) {
      addPoints(
        row.user_address,
        row.chain,
        row.season_id,
        row.action,
        points,
        row.timestamp
      );
      totalPointsAwarded += points;
      usersProcessed.add(row.user_address);
    }
  }

  // Refresh leaderboard for the active season
  const currentSeason = getCurrentSeason();
  if (currentSeason) {
    refreshLeaderboard(currentSeason.id);
  }

  console.log(
    `[Calculator] Awarded ${totalPointsAwarded.toLocaleString()} points to ${usersProcessed.size} users`
  );

  return {
    totalPointsAwarded,
    usersProcessed: usersProcessed.size,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PROJECTIONS — show users what they'd earn
// ═══════════════════════════════════════════════════════════════════════════

export interface PointsProjection {
  action: PointAction;
  multiplier: number;
  valueUsd: number;
  pointsPerHour: number;
  pointsPerDay: number;
  pointsPerWeek: number;
  pointsPerSeason: number;
}

/**
 * Project how many points a user would earn for a given value & action
 * in the current (or specified) season.
 */
export function projectPoints(
  valueUsd: number,
  action: PointAction,
  seasonId?: number
): PointsProjection | null {
  const season = seasonId ? getSeasonById(seasonId) : getCurrentSeason();
  if (!season) return null;

  const multiplier = season.multipliers[action];
  if (!multiplier) return null;

  const pointsPerHour = valueUsd * multiplier;
  const seasonDurationHours =
    (season.endDate.getTime() - season.startDate.getTime()) / (1000 * 60 * 60);

  return {
    action,
    multiplier,
    valueUsd,
    pointsPerHour,
    pointsPerDay: pointsPerHour * 24,
    pointsPerWeek: pointsPerHour * 24 * 7,
    pointsPerSeason: pointsPerHour * seasonDurationHours,
  };
}

/**
 * Compare points across all actions for a given USD value.
 * Shows the user where to get the most points.
 */
export function compareActions(
  valueUsd: number,
  seasonId?: number
): PointsProjection[] {
  const season = seasonId ? getSeasonById(seasonId) : getCurrentSeason();
  if (!season) return [];

  return Object.values(PointAction)
    .map((action) => projectPoints(valueUsd, action, season.id))
    .filter((p): p is PointsProjection => p !== null)
    .sort((a, b) => b.pointsPerHour - a.pointsPerHour);
}

// ═══════════════════════════════════════════════════════════════════════════
// STATISTICS
// ═══════════════════════════════════════════════════════════════════════════

export interface SeasonStats {
  seasonId: number;
  seasonName: string;
  totalPointsDistributed: number;
  totalUsers: number;
  totalSnapshots: number;
  topAction: string;
  topActionPoints: number;
}

export function getSeasonStats(seasonId: number): SeasonStats | null {
  const season = getSeasonById(seasonId);
  if (!season) return null;

  const d = getDb();

  const totalPoints = d.prepare(`
    SELECT COALESCE(SUM(total_points), 0) as total
    FROM points WHERE season_id = ?
  `).get(seasonId) as { total: number };

  const totalUsers = d.prepare(`
    SELECT COUNT(DISTINCT user_address) as count
    FROM points WHERE season_id = ?
  `).get(seasonId) as { count: number };

  const totalSnapshots = d.prepare(`
    SELECT COUNT(*) as count
    FROM snapshots WHERE season_id = ?
  `).get(seasonId) as { count: number };

  const topAction = d.prepare(`
    SELECT action, SUM(total_points) as total
    FROM points WHERE season_id = ?
    GROUP BY action
    ORDER BY total DESC
    LIMIT 1
  `).get(seasonId) as { action: string; total: number } | undefined;

  return {
    seasonId,
    seasonName: season.name,
    totalPointsDistributed: totalPoints.total,
    totalUsers: totalUsers.count,
    totalSnapshots: totalSnapshots.count,
    topAction: topAction?.action ?? "N/A",
    topActionPoints: topAction?.total ?? 0,
  };
}

/**
 * Print a nice summary of points distribution across all actions.
 * Useful for debugging and operator dashboards.
 */
export function printActionBreakdown(seasonId: number): void {
  const d = getDb();
  const season = getSeasonById(seasonId);
  if (!season) return;

  console.log(`\n═══ Points Breakdown — Season ${season.id}: ${season.name} ═══\n`);

  const actions = d.prepare(`
    SELECT action, chain, SUM(total_points) as total, COUNT(DISTINCT user_address) as users
    FROM points
    WHERE season_id = ?
    GROUP BY action, chain
    ORDER BY total DESC
  `).all(seasonId) as Array<{ action: string; chain: string; total: number; users: number }>;

  const grandTotal = actions.reduce((sum, a) => sum + a.total, 0);

  for (const a of actions) {
    const pct = grandTotal > 0 ? ((a.total / grandTotal) * 100).toFixed(1) : "0.0";
    const mult = season.multipliers[a.action as PointAction] ?? 0;
    console.log(
      `  ${a.action.padEnd(30)} ${mult}x  ${a.total.toLocaleString().padStart(15)} pts  (${pct}%)  ${a.users} users`
    );
  }

  console.log(`\n  ${"TOTAL".padEnd(30)}     ${grandTotal.toLocaleString().padStart(15)} pts\n`);
}
