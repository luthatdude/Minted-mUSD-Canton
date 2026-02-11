/**
 * Minted Protocol — Points API Server
 *
 * Exposes REST endpoints for querying user points, leaderboard, and tiers.
 * In production, this would run behind an API gateway with auth.
 */

import { SnapshotService } from "./snapshot";
import { getTier, DEFAULT_POINTS_CONFIG } from "./config";

export interface PointsResponse {
  address: string;
  totalPoints: number;
  tier: string;
  multiplier: number;
}

export interface LeaderboardEntry {
  rank: number;
  address: string;
  totalPoints: number;
  tier: string;
}

/**
 * Points API server placeholder.
 *
 * In production this would be an Express/Fastify server.
 * For now, exports handler functions for integration testing.
 */
export class PointsServer {
  private snapshotService: SnapshotService;
  private userPoints: Map<string, number> = new Map();

  constructor(snapshotService?: SnapshotService) {
    this.snapshotService = snapshotService || new SnapshotService(DEFAULT_POINTS_CONFIG);
  }

  /**
   * Get points and tier for a specific user.
   */
  getPoints(address: string): PointsResponse {
    const points = this.userPoints.get(address.toLowerCase()) || 0;
    const tier = getTier(points);
    return {
      address,
      totalPoints: points,
      tier: tier.name,
      multiplier: tier.multiplier,
    };
  }

  /**
   * Get the top N users by points.
   */
  getLeaderboard(limit = 100): LeaderboardEntry[] {
    const sorted = Array.from(this.userPoints.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit);

    return sorted.map(([address, totalPoints], index) => ({
      rank: index + 1,
      address,
      totalPoints,
      tier: getTier(totalPoints).name,
    }));
  }

  /**
   * Update points from a snapshot.
   */
  applySnapshot(userPoints: Map<string, number>): void {
    for (const [address, points] of userPoints) {
      const existing = this.userPoints.get(address.toLowerCase()) || 0;
      this.userPoints.set(address.toLowerCase(), existing + points);
    }
  }

  /**
   * Start the server (placeholder).
   */
  async start(port = 3001): Promise<void> {
    console.log(`[PointsServer] Points API would start on port ${port}`);
    console.log("[PointsServer] Endpoints: GET /points/:address, GET /leaderboard");
    // In production: app.listen(port)
  }
}

export default PointsServer;
