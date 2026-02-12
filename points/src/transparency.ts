/**
 * Minted Protocol — Points Transparency Service
 *
 * Generates daily point-balance snapshots as:
 *   1. CSV export (for public download / Dune upload)
 *   2. Merkle tree root (for on-chain verifiability)
 *
 * Merkle leaf = keccak256(abi.encodePacked(address, totalPoints, snapshotId))
 * The root can be posted on-chain or published via API for anyone to verify.
 */

import { keccak256 as ethersKeccak256, toUtf8Bytes, solidityPackedKeccak256, concat } from "ethers";
import fs from "fs";
import path from "path";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface PointBalance {
  address: string;
  totalPoints: number;
  holdPoints: number;
  stakePoints: number;
  mintPoints: number;
  collateralPoints: number;
  referralPoints: number;
  tier: string;
}

export interface SnapshotManifest {
  snapshotId: number;
  timestamp: string;
  blockNumber: number;
  totalUsers: number;
  totalPoints: number;
  merkleRoot: string;
  csvPath: string;
  csvHash: string;
}

export interface MerkleProof {
  leaf: string;
  proof: string[];
  index: number;
  root: string;
}

// ═══════════════════════════════════════════════════════════════
// Merkle Tree (Keccak-256, sorted pairs)
// ═══════════════════════════════════════════════════════════════

/**
 * Keccak-256 hash of raw bytes (matches Solidity's keccak256).
 */
function keccak256(data: string | Uint8Array): string {
  return ethersKeccak256(data);
}

/**
 * Create a leaf hash for a user's point balance.
 * Mirrors Solidity: keccak256(abi.encodePacked(address, uint256, uint256))
 * Uses solidityPackedKeccak256 for exact binary-level compatibility
 * with on-chain verifiers.
 */
function createLeaf(address: string, totalPoints: number, snapshotId: number): string {
  return solidityPackedKeccak256(
    ["address", "uint256", "uint256"],
    [address.toLowerCase(), totalPoints, snapshotId]
  );
}

/**
 * Combine two hashes (sorted for deterministic ordering).
 * Concatenates raw 32-byte hashes, matching Solidity:
 * keccak256(abi.encodePacked(left, right))
 */
function hashPair(a: string, b: string): string {
  const [left, right] = a < b ? [a, b] : [b, a];
  return keccak256(concat([left, right]));
}

/**
 * Build a Merkle tree from leaf hashes.
 * Returns all layers (leaves at index 0, root at last index).
 */
function buildMerkleTree(leaves: string[]): string[][] {
  if (leaves.length === 0) return [["0x" + "0".repeat(64)]];

  // Pad to power of 2
  const paddedLeaves = [...leaves];
  while (paddedLeaves.length & (paddedLeaves.length - 1)) {
    paddedLeaves.push("0x" + "0".repeat(64));
  }
  if (paddedLeaves.length === 0) paddedLeaves.push("0x" + "0".repeat(64));

  const layers: string[][] = [paddedLeaves];

  while (layers[layers.length - 1].length > 1) {
    const currentLayer = layers[layers.length - 1];
    const nextLayer: string[] = [];

    for (let i = 0; i < currentLayer.length; i += 2) {
      nextLayer.push(hashPair(currentLayer[i], currentLayer[i + 1] || currentLayer[i]));
    }

    layers.push(nextLayer);
  }

  return layers;
}

/**
 * Generate a Merkle proof for a leaf at a given index.
 */
function getMerkleProof(layers: string[][], index: number): string[] {
  const proof: string[] = [];
  let currentIndex = index;

  for (let i = 0; i < layers.length - 1; i++) {
    const layer = layers[i];
    const siblingIndex = currentIndex % 2 === 0 ? currentIndex + 1 : currentIndex - 1;

    if (siblingIndex < layer.length) {
      proof.push(layer[siblingIndex]);
    }

    currentIndex = Math.floor(currentIndex / 2);
  }

  return proof;
}

/**
 * Verify a Merkle proof.
 */
export function verifyMerkleProof(
  leaf: string,
  proof: string[],
  root: string
): boolean {
  let hash = leaf;
  for (const sibling of proof) {
    hash = hashPair(hash, sibling);
  }
  return hash === root;
}

// ═══════════════════════════════════════════════════════════════
// Transparency Service
// ═══════════════════════════════════════════════════════════════

export class TransparencyService {
  private outputDir: string;
  private manifests: SnapshotManifest[] = [];

  constructor(outputDir: string = "./snapshots") {
    this.outputDir = outputDir;
  }

  /**
   * Generate a full transparency snapshot:
   *   1. CSV file with all point balances
   *   2. Merkle root over all (address, points, snapshotId) tuples
   *   3. Manifest file linking everything together
   */
  async generateSnapshot(
    snapshotId: number,
    blockNumber: number,
    balances: PointBalance[]
  ): Promise<SnapshotManifest> {
    // FIX HIGH-PATH: Validate snapshotId is a positive integer to prevent path traversal
    if (!Number.isInteger(snapshotId) || snapshotId < 1 || snapshotId > 1_000_000) {
      throw new Error(`Invalid snapshotId: must be a positive integer, got ${snapshotId}`);
    }

    // FIX HIGH-PATH: Validate outputDir resolves within expected base
    const resolvedBase = path.resolve(this.outputDir);

    // Ensure output directory exists
    const snapshotDir = path.join(resolvedBase, `snapshot-${snapshotId}`);
    // FIX HIGH-PATH: Verify resolved path is still under base directory
    if (!path.resolve(snapshotDir).startsWith(resolvedBase)) {
      throw new Error(`Path traversal detected: ${snapshotDir}`);
    }
    fs.mkdirSync(snapshotDir, { recursive: true });

    // ─── 1. Generate CSV ──────────────────────────────────────
    const csvPath = path.join(snapshotDir, `points-${snapshotId}.csv`);
    const csvContent = this.generateCSV(balances, snapshotId, blockNumber);
    fs.writeFileSync(csvPath, csvContent);

    const csvHash = ethersKeccak256(toUtf8Bytes(csvContent));

    // ─── 2. Build Merkle tree ─────────────────────────────────
    const sortedBalances = [...balances].sort((a, b) =>
      a.address.toLowerCase().localeCompare(b.address.toLowerCase())
    );

    const leaves = sortedBalances.map((b) =>
      createLeaf(b.address, b.totalPoints, snapshotId)
    );

    const tree = buildMerkleTree(leaves);
    const merkleRoot = tree[tree.length - 1][0];

    // Save Merkle leaves for proof generation
    const leavesPath = path.join(snapshotDir, `leaves-${snapshotId}.json`);
    fs.writeFileSync(
      leavesPath,
      JSON.stringify(
        sortedBalances.map((b, i) => ({
          index: i,
          address: b.address.toLowerCase(),
          totalPoints: b.totalPoints,
          leaf: leaves[i],
        })),
        null,
        2
      )
    );

    // ─── 3. Build manifest ────────────────────────────────────
    const totalPoints = balances.reduce((sum, b) => sum + b.totalPoints, 0);

    const manifest: SnapshotManifest = {
      snapshotId,
      timestamp: new Date().toISOString(),
      blockNumber,
      totalUsers: balances.length,
      totalPoints,
      merkleRoot,
      csvPath: `points-${snapshotId}.csv`,
      csvHash,
    };

    // Save manifest
    const manifestPath = path.join(snapshotDir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // Save to latest symlink
    const latestPath = path.join(this.outputDir, "latest.json");
    fs.writeFileSync(latestPath, JSON.stringify(manifest, null, 2));

    this.manifests.push(manifest);

    console.log(
      `[Transparency] Snapshot #${snapshotId}: ${balances.length} users, ` +
      `${totalPoints.toLocaleString()} total points, root=${merkleRoot.slice(0, 18)}...`
    );

    return manifest;
  }

  /**
   * Generate a Merkle proof for a specific address in a snapshot.
   */
  generateProof(
    snapshotId: number,
    address: string,
    balances: PointBalance[]
  ): MerkleProof | null {
    const sortedBalances = [...balances].sort((a, b) =>
      a.address.toLowerCase().localeCompare(b.address.toLowerCase())
    );

    const index = sortedBalances.findIndex(
      (b) => b.address.toLowerCase() === address.toLowerCase()
    );

    if (index === -1) return null;

    const leaves = sortedBalances.map((b) =>
      createLeaf(b.address, b.totalPoints, snapshotId)
    );

    const tree = buildMerkleTree(leaves);
    const proof = getMerkleProof(tree, index);
    const root = tree[tree.length - 1][0];

    return {
      leaf: leaves[index],
      proof,
      index,
      root,
    };
  }

  /**
   * Generate a Merkle proof from persisted snapshot data on disk.
   * Unlike generateProof(), this does NOT recompute from live balances —
   * it loads the leaves saved at snapshot time, guaranteeing the proof
   * matches the published root even if balances changed since the snapshot.
   */
  generateProofFromDisk(
    snapshotId: number,
    address: string
  ): MerkleProof | null {
    // FIX HIGH-PATH: Validate snapshotId to prevent path traversal
    if (!Number.isInteger(snapshotId) || snapshotId < 1 || snapshotId > 1_000_000) {
      return null;
    }

    const resolvedBase = path.resolve(this.outputDir);
    const snapshotDir = path.join(resolvedBase, `snapshot-${snapshotId}`);
    // FIX HIGH-PATH: Verify resolved path stays within base
    if (!path.resolve(snapshotDir).startsWith(resolvedBase)) {
      return null;
    }
    const leavesPath = path.join(snapshotDir, `leaves-${snapshotId}.json`);

    if (!fs.existsSync(leavesPath)) {
      return null;
    }

    const storedLeaves: { index: number; address: string; totalPoints: number; leaf: string }[] =
      JSON.parse(fs.readFileSync(leavesPath, "utf-8"));

    const entry = storedLeaves.find(
      (e) => e.address.toLowerCase() === address.toLowerCase()
    );

    if (!entry) return null;

    const leaves = storedLeaves.map((e) => e.leaf);
    const tree = buildMerkleTree(leaves);
    const proof = getMerkleProof(tree, entry.index);
    const root = tree[tree.length - 1][0];

    return {
      leaf: entry.leaf,
      proof,
      index: entry.index,
      root,
    };
  }

  /**
   * Generate CSV content from point balances.
   */
  private generateCSV(
    balances: PointBalance[],
    snapshotId: number,
    blockNumber: number
  ): string {
    const header = [
      "snapshot_id",
      "block_number",
      "address",
      "total_points",
      "hold_points",
      "stake_points",
      "mint_points",
      "collateral_points",
      "referral_points",
      "tier",
    ].join(",");

    const rows = balances
      .sort((a, b) => b.totalPoints - a.totalPoints) // Sort by points desc for readability
      .map((b) =>
        [
          snapshotId,
          blockNumber,
          b.address.toLowerCase(),
          b.totalPoints,
          b.holdPoints,
          b.stakePoints,
          b.mintPoints,
          b.collateralPoints,
          b.referralPoints,
          b.tier,
        ].join(",")
      );

    return [header, ...rows].join("\n") + "\n";
  }

  /**
   * Get all manifest history.
   */
  getManifests(): SnapshotManifest[] {
    return [...this.manifests];
  }

  /**
   * Get the latest manifest.
   */
  getLatest(): SnapshotManifest | null {
    return this.manifests.length > 0
      ? this.manifests[this.manifests.length - 1]
      : null;
  }

  /**
   * Load manifests from disk on startup.
   */
  loadFromDisk(): void {
    try {
      const latestPath = path.join(this.outputDir, "latest.json");
      if (fs.existsSync(latestPath)) {
        const data = JSON.parse(fs.readFileSync(latestPath, "utf-8"));
        console.log(`[Transparency] Loaded latest snapshot: #${data.snapshotId}`);
      }
    } catch {
      console.log("[Transparency] No existing snapshots found");
    }
  }
}
