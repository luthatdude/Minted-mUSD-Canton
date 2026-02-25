/**
 * Bounded in-memory idempotency store with TTL and max entry limits.
 *
 * Replaces the unbounded `new Map<string, T>()` pattern used in
 * canton-convert, canton-cip56-redeem, canton-cip56-repay, and
 * canton-cip56-stake endpoints.
 *
 * Safety improvements over raw Map:
 *   1. TTL — entries expire after configurable duration (default 5 min)
 *   2. Max entries — oldest entries evicted when capacity reached (default 1000)
 *   3. Periodic prune — stale entries cleaned on each get/set
 *
 * This is NOT a durable store. For production multi-instance deployments,
 * replace with Redis or Postgres-backed implementation.
 */

import * as crypto from "crypto";

export interface IdempotencyStoreOptions {
  /** Max entries before LRU eviction. Default: 1000 */
  maxEntries?: number;
  /** TTL in milliseconds. Default: 300_000 (5 minutes) */
  ttlMs?: number;
}

interface StoreEntry<T> {
  value: T;
  createdAt: number;
}

export class IdempotencyStore<T> {
  private readonly store = new Map<string, StoreEntry<T>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private lastPrune = 0;

  constructor(opts?: IdempotencyStoreOptions) {
    this.maxEntries = opts?.maxEntries ?? 1000;
    this.ttlMs = opts?.ttlMs ?? 300_000; // 5 minutes
  }

  /**
   * Look up a cached result by key. Returns undefined if not found or expired.
   */
  get(key: string): T | undefined {
    this.maybePrune();
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Store a result under the given key.
   */
  set(key: string, value: T): void {
    this.maybePrune();
    // Evict oldest if at capacity
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) {
        this.store.delete(oldest);
      }
    }
    this.store.set(key, { value, createdAt: Date.now() });
  }

  /**
   * Check if a key exists and is not expired.
   */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Current store size (including potentially expired entries pending prune).
   */
  get size(): number {
    return this.store.size;
  }

  /**
   * Prune expired entries. Called automatically on get/set, but throttled
   * to at most once per 30 seconds to avoid O(n) scans on every call.
   */
  private maybePrune(): void {
    const now = Date.now();
    if (now - this.lastPrune < 30_000) return;
    this.lastPrune = now;

    for (const [key, entry] of this.store) {
      if (now - entry.createdAt > this.ttlMs) {
        this.store.delete(key);
      }
    }
  }
}

// ── Key derivation helpers ─────────────────────────────────

/**
 * Derive a deterministic idempotency key from sorted CIDs + context.
 *
 * @param prefix — operation prefix (e.g. "redeem", "repay", "stake", "convert")
 * @param sourceCids — contract IDs being consumed
 * @param amount — amount as fixed-point string (e.g. "100.000000")
 * @param party — acting party
 * @param extra — additional context (e.g. debtCid for repay)
 */
export function deriveIdempotencyKey(
  prefix: string,
  sourceCids: string[],
  amount: string,
  party: string,
  extra?: string
): string {
  const sorted = [...sourceCids].sort().join(",");
  const input = extra
    ? `${prefix}:${sorted}:${amount}:${party}:${extra}`
    : `${prefix}:${sorted}:${amount}:${party}`;
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 32);
}
