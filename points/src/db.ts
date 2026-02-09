/**
 * Minted Points — Database Layer
 *
 * Uses better-sqlite3 for fast, synchronous, file-based storage.
 * Stores:
 *   - Balance snapshots per user per action per hour
 *   - Accumulated points per user per season
 *   - Leaderboard materialized view
 */

import Database from "better-sqlite3";
import path from "path";

const DB_PATH = process.env.POINTS_DB_PATH || path.join(__dirname, "..", "data", "points.db");

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initSchema();
  }
  return db;
}

function initSchema(): void {
  const d = getDb();

  d.exec(`
    -- Raw balance snapshots: what each user had at each hour
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,             -- ISO 8601 snapshot time
      chain TEXT NOT NULL,                 -- 'ethereum' | 'canton'
      user_address TEXT NOT NULL,          -- ETH address or Canton party ID
      action TEXT NOT NULL,                -- PointAction enum value
      balance_raw TEXT NOT NULL,           -- Raw token balance (string to preserve precision)
      value_usd REAL NOT NULL,            -- USD value at snapshot time
      season_id INTEGER NOT NULL,
      UNIQUE(timestamp, chain, user_address, action)
    );

    -- Accumulated points per user per season
    CREATE TABLE IF NOT EXISTS points (
      user_address TEXT NOT NULL,
      chain TEXT NOT NULL,
      season_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      total_points REAL NOT NULL DEFAULT 0,
      last_snapshot TEXT,                  -- Last processed snapshot timestamp
      PRIMARY KEY (user_address, chain, season_id, action)
    );

    -- Aggregated totals for fast leaderboard queries
    CREATE TABLE IF NOT EXISTS leaderboard (
      user_address TEXT NOT NULL,
      chain TEXT NOT NULL,
      season_id INTEGER NOT NULL,
      total_points REAL NOT NULL DEFAULT 0,
      rank INTEGER,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_address, chain, season_id)
    );

    -- Global leaderboard (cross-chain, all seasons)
    CREATE TABLE IF NOT EXISTS leaderboard_global (
      user_address TEXT NOT NULL,
      total_points REAL NOT NULL DEFAULT 0,
      rank INTEGER,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_address)
    );

    -- Metadata: track last snapshot time, etc.
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Indexes for fast queries
    CREATE INDEX IF NOT EXISTS idx_snapshots_user ON snapshots(user_address, chain);
    CREATE INDEX IF NOT EXISTS idx_snapshots_time ON snapshots(timestamp);
    CREATE INDEX IF NOT EXISTS idx_points_user ON points(user_address);
    CREATE INDEX IF NOT EXISTS idx_leaderboard_rank ON leaderboard(season_id, total_points DESC);
    CREATE INDEX IF NOT EXISTS idx_leaderboard_global_rank ON leaderboard_global(total_points DESC);
  `);
}

// ═══════════════════════════════════════════════════════════════════════════
// SNAPSHOT OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

export interface SnapshotRow {
  timestamp: string;
  chain: string;
  user_address: string;
  action: string;
  balance_raw: string;
  value_usd: number;
  season_id: number;
}

export function insertSnapshots(rows: SnapshotRow[]): void {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT OR REPLACE INTO snapshots (timestamp, chain, user_address, action, balance_raw, value_usd, season_id)
    VALUES (@timestamp, @chain, @user_address, @action, @balance_raw, @value_usd, @season_id)
  `);

  const insertMany = d.transaction((rows: SnapshotRow[]) => {
    for (const row of rows) {
      stmt.run(row);
    }
  });

  insertMany(rows);
}

// ═══════════════════════════════════════════════════════════════════════════
// POINTS OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

export function addPoints(
  userAddress: string,
  chain: string,
  seasonId: number,
  action: string,
  pointsToAdd: number,
  snapshotTime: string
): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO points (user_address, chain, season_id, action, total_points, last_snapshot)
    VALUES (@user, @chain, @season, @action, @points, @snapshot)
    ON CONFLICT(user_address, chain, season_id, action)
    DO UPDATE SET
      total_points = total_points + @points,
      last_snapshot = @snapshot
  `).run({
    user: userAddress,
    chain,
    season: seasonId,
    action,
    points: pointsToAdd,
    snapshot: snapshotTime,
  });
}

export function getUserPoints(userAddress: string): {
  bySeasonAndAction: Array<{ season_id: number; chain: string; action: string; total_points: number }>;
  totalPoints: number;
} {
  const d = getDb();

  const bySeasonAndAction = d.prepare(`
    SELECT season_id, chain, action, total_points
    FROM points
    WHERE user_address = ?
    ORDER BY season_id, chain, action
  `).all(userAddress) as Array<{ season_id: number; chain: string; action: string; total_points: number }>;

  const totalRow = d.prepare(`
    SELECT COALESCE(SUM(total_points), 0) as total
    FROM points
    WHERE user_address = ?
  `).get(userAddress) as { total: number } | undefined;

  return {
    bySeasonAndAction,
    totalPoints: totalRow?.total ?? 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LEADERBOARD
// ═══════════════════════════════════════════════════════════════════════════

export function refreshLeaderboard(seasonId: number): void {
  const d = getDb();
  const now = new Date().toISOString();

  d.transaction(() => {
    // Per-season leaderboard
    d.prepare("DELETE FROM leaderboard WHERE season_id = ?").run(seasonId);
    d.prepare(`
      INSERT INTO leaderboard (user_address, chain, season_id, total_points, rank, updated_at)
      SELECT
        user_address,
        chain,
        season_id,
        SUM(total_points) as total_points,
        ROW_NUMBER() OVER (ORDER BY SUM(total_points) DESC) as rank,
        @now
      FROM points
      WHERE season_id = @season
      GROUP BY user_address, chain
      ORDER BY total_points DESC
    `).run({ season: seasonId, now });

    // Global leaderboard (all seasons, cross-chain merged by address)
    d.prepare("DELETE FROM leaderboard_global").run();
    d.prepare(`
      INSERT INTO leaderboard_global (user_address, total_points, rank, updated_at)
      SELECT
        user_address,
        SUM(total_points) as total_points,
        ROW_NUMBER() OVER (ORDER BY SUM(total_points) DESC) as rank,
        @now
      FROM points
      GROUP BY user_address
      ORDER BY total_points DESC
    `).run({ now });
  })();
}

export function getLeaderboard(
  seasonId: number,
  limit = 100,
  offset = 0
): Array<{ rank: number; user_address: string; chain: string; total_points: number }> {
  const d = getDb();
  return d.prepare(`
    SELECT rank, user_address, chain, total_points
    FROM leaderboard
    WHERE season_id = ?
    ORDER BY rank ASC
    LIMIT ? OFFSET ?
  `).all(seasonId, limit, offset) as Array<{
    rank: number;
    user_address: string;
    chain: string;
    total_points: number;
  }>;
}

export function getGlobalLeaderboard(
  limit = 100,
  offset = 0
): Array<{ rank: number; user_address: string; total_points: number }> {
  const d = getDb();
  return d.prepare(`
    SELECT rank, user_address, total_points
    FROM leaderboard_global
    ORDER BY rank ASC
    LIMIT ? OFFSET ?
  `).all(limit, offset) as Array<{
    rank: number;
    user_address: string;
    total_points: number;
  }>;
}

export function getUserRank(userAddress: string, seasonId: number): number | null {
  const d = getDb();
  const row = d.prepare(`
    SELECT rank FROM leaderboard
    WHERE user_address = ? AND season_id = ?
  `).get(userAddress, seasonId) as { rank: number } | undefined;
  return row?.rank ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
// METADATA
// ═══════════════════════════════════════════════════════════════════════════

export function getMetadata(key: string): string | null {
  const d = getDb();
  const row = d.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMetadata(key: string, value: string): void {
  const d = getDb();
  d.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)").run(key, value);
}

export function closeDb(): void {
  if (db) {
    db.close();
  }
}
