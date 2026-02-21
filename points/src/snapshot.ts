// Points snapshot — periodic snapshot of user points balances

import { calculatePoints, DEFAULT_CONFIG, PointsConfig } from "./calculator";
import * as crypto from "crypto";

export interface UserSnapshot {
  address: string;
  musdBalance: number;
  smusdBalance: number;
  borrowBalance: number;
  lpBalance: number;
  pointsEarned: number;
  totalPoints: number;
  snapshotTimestamp: string;
}

export interface SnapshotManifest {
  epoch: number;
  timestamp: string;
  userCount: number;
  totalPoints: number;
  merkleRoot: string;
}

export interface MerkleProof {
  address: string;
  amount: number;
  proof: string[];
  leaf: string;
}

/**
 * In-memory snapshot service. Production would persist to DB.
 */
export class SnapshotService {
  private manifests: Map<number, SnapshotManifest> = new Map();
  private snapshots: Map<number, UserSnapshot[]> = new Map();
  private latestEpoch: number | null = null;

  /** Get the latest snapshot manifest */
  getLatestManifest(): SnapshotManifest | null {
    if (this.latestEpoch === null) return null;
    return this.manifests.get(this.latestEpoch) ?? null;
  }

  /** Get Merkle proof for a user in a given epoch */
  getProof(epoch: number, address: string): MerkleProof | null {
    const snaps = this.snapshots.get(epoch);
    if (!snaps) return null;
    const user = snaps.find(
      (s) => s.address.toLowerCase() === address.toLowerCase(),
    );
    if (!user) return null;
    const leaf = this.hashLeaf(user.address, user.totalPoints);
    // Simplified proof — production would compute full Merkle tree
    return { address: user.address, amount: user.totalPoints, proof: [], leaf };
  }

  /** Top N users by points in a given epoch */
  getLeaderboard(
    epoch: number,
    limit: number,
  ): Array<{ address: string; points: number; rank: number }> {
    const snaps = this.snapshots.get(epoch);
    if (!snaps) return [];
    return snaps
      .sort((a, b) => b.totalPoints - a.totalPoints)
      .slice(0, limit)
      .map((s, i) => ({ address: s.address, points: s.totalPoints, rank: i + 1 }));
  }

  /** Create a new snapshot */
  async createSnapshot(epoch: number, users: UserSnapshot[]): Promise<SnapshotManifest> {
    const totalPoints = users.reduce((sum, u) => sum + u.totalPoints, 0);
    const merkleRoot = this.computeMerkleRoot(users);
    const manifest: SnapshotManifest = {
      epoch,
      timestamp: new Date().toISOString(),
      userCount: users.length,
      totalPoints,
      merkleRoot,
    };
    this.manifests.set(epoch, manifest);
    this.snapshots.set(epoch, users);
    this.latestEpoch = epoch;
    return manifest;
  }

  private hashLeaf(address: string, amount: number): string {
    return crypto
      .createHash("sha256")
      .update(`${address.toLowerCase()}:${amount}`)
      .digest("hex");
  }

  private computeMerkleRoot(users: UserSnapshot[]): string {
    if (users.length === 0) return "0".repeat(64);
    const leaves = users.map((u) => this.hashLeaf(u.address, u.totalPoints));
    // Simplified: just hash all leaves together. Production uses a proper Merkle tree.
    return crypto.createHash("sha256").update(leaves.join("")).digest("hex");
  }
}

/**
 * Take a snapshot of all user points at the current block.
 * Queries on-chain balances and computes accrued points since last snapshot.
 */
export async function takeSnapshot(
  _config: PointsConfig = DEFAULT_CONFIG,
): Promise<UserSnapshot[]> {
  // TODO: Implement with Dune queries + on-chain reads
  // 1. Query Dune for all mUSD, smUSD, borrow positions
  // 2. Query Canton for bridge participants
  // 3. Calculate points per user using calculator
  // 4. Store snapshot to database
  // 5. Return snapshot array
  return [];
}
