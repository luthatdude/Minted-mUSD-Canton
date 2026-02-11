/**
 * Minted Protocol — Points Snapshot Service
 *
 * Periodically snapshots on-chain balances (mUSD, sMUSD, collateral)
 * and calculates points earned during each period.
 */

import { UserActivity } from "./calculator";
import { calculateBatchPoints } from "./calculator";
import { DEFAULT_POINTS_CONFIG, PointsConfig } from "./config";

export interface Snapshot {
  id: number;
  timestamp: Date;
  blockNumber: number;
  users: UserActivity[];
  totalPointsAwarded: number;
}

export class SnapshotService {
  private snapshots: Snapshot[] = [];
  private running = false;
  private config: PointsConfig;

  constructor(config: PointsConfig = DEFAULT_POINTS_CONFIG) {
    this.config = config;
  }

  /**
   * Take a snapshot of all user balances and calculate points.
   * In production this would query on-chain state via ethers/subgraph.
   */
  async takeSnapshot(blockNumber: number): Promise<Snapshot> {
    // Placeholder: production would fetch real balances
    const users: UserActivity[] = await this.fetchUserActivities();

    const pointsMap = calculateBatchPoints(users, this.config);

    let totalPointsAwarded = 0;
    for (const [, breakdown] of pointsMap) {
      totalPointsAwarded += breakdown.totalNewPoints;
    }

    const snapshot: Snapshot = {
      id: this.snapshots.length + 1,
      timestamp: new Date(),
      blockNumber,
      users,
      totalPointsAwarded,
    };

    this.snapshots.push(snapshot);
    console.log(
      `[Snapshot] #${snapshot.id}: ${users.length} users, ${totalPointsAwarded} points awarded`
    );

    return snapshot;
  }

  /**
   * Fetch user activities from on-chain data.
   * Placeholder — production would use subgraph or direct RPC calls.
   */
  private async fetchUserActivities(): Promise<UserActivity[]> {
    // TODO: Implement real on-chain data fetching
    return [];
  }

  /**
   * Get all recorded snapshots.
   */
  getSnapshots(): Snapshot[] {
    return [...this.snapshots];
  }

  /**
   * Start periodic snapshotting.
   */
  async start(): Promise<void> {
    console.log("[Snapshot] Starting snapshot service...");
    this.running = true;

    while (this.running) {
      try {
        await this.takeSnapshot(0); // Block number would come from provider
      } catch (err) {
        console.error("[Snapshot] Snapshot failed:", (err as Error).message);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, this.config.snapshotIntervalMs)
      );
    }
  }

  /**
   * Stop the service.
   */
  stop(): void {
    this.running = false;
    console.log("[Snapshot] Stopped.");
  }
}
