/**
 * Minted Protocol - Transaction Queue & Rate Limiter
 *
 * Shared utility for all bot services to serialize nonce access,
 * rate-limit transaction submissions, and retry with exponential backoff.
 *
 * Usage:
 *   const queue = new TxQueue({ maxTxPerMinute: 10 });
 *   const receipt = await queue.submit(() => contract.someMethod(args));
 */

import { ethers } from "ethers";
import { createLogger, format, transports } from "winston";

const logger = createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

export interface TxQueueConfig {
  /** Maximum transactions per minute (default: 12) */
  maxTxPerMinute: number;
  /** Maximum retry attempts for transient errors (default: 3) */
  maxRetries: number;
  /** Base delay for exponential backoff in ms (default: 1000) */
  baseDelayMs: number;
  /** Maximum delay cap in ms (default: 30000) */
  maxDelayMs: number;
}

const DEFAULT_CONFIG: TxQueueConfig = {
  maxTxPerMinute: 12,
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
};

/** Errors that are safe to retry */
const RETRYABLE_ERRORS = [
  "nonce too low",
  "replacement transaction underpriced",
  "already known",
  "ETIMEDOUT",
  "ECONNRESET",
  "SERVER_ERROR",
  "NETWORK_ERROR",
  "TIMEOUT",
  "noNetwork",
  "connection reset",
  "rate limit",
  "429",
];

export class TxQueue {
  private readonly config: TxQueueConfig;
  private mutex: Promise<void> = Promise.resolve();
  private txTimestamps: number[] = [];
  private _pendingCount = 0;
  private _totalSubmitted = 0;
  private _totalFailed = 0;

  constructor(config: Partial<TxQueueConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Number of transactions currently in-flight */
  get pendingCount(): number {
    return this._pendingCount;
  }

  /** Lifetime stats */
  get stats(): { submitted: number; failed: number; pending: number } {
    return {
      submitted: this._totalSubmitted,
      failed: this._totalFailed,
      pending: this._pendingCount,
    };
  }

  /**
   * Submit a transaction through the queue.
   * Serializes nonce access, enforces rate limit, and retries transient errors.
   *
   * @param txFn — async function that returns a ContractTransactionResponse
   * @param label — human-readable label for logging
   * @returns the transaction receipt
   */
  async submit(
    txFn: () => Promise<ethers.ContractTransactionResponse>,
    label = "tx",
  ): Promise<ethers.TransactionReceipt | null> {
    return this.withMutex(async () => {
      await this.enforceRateLimit();

      let lastError: Error | undefined;
      for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
        try {
          this._pendingCount++;
          this._totalSubmitted++;

          logger.info(`[TxQueue] Submitting ${label} (attempt ${attempt + 1}/${this.config.maxRetries + 1})`);
          const tx = await txFn();
          this.recordTx();

          logger.info(`[TxQueue] ${label} sent: ${tx.hash}`);
          const receipt = await tx.wait();
          logger.info(`[TxQueue] ${label} confirmed in block ${receipt?.blockNumber}`);

          return receipt;
        } catch (err: any) {
          lastError = err;
          const msg = err?.message || String(err);

          if (this.isRetryable(msg) && attempt < this.config.maxRetries) {
            const delay = Math.min(
              this.config.baseDelayMs * Math.pow(2, attempt),
              this.config.maxDelayMs,
            );
            logger.warn(
              `[TxQueue] ${label} failed (attempt ${attempt + 1}), retrying in ${delay}ms: ${msg.slice(0, 120)}`,
            );
            await this.sleep(delay);
          } else {
            this._totalFailed++;
            logger.error(`[TxQueue] ${label} failed permanently: ${msg.slice(0, 200)}`);
            throw err;
          }
        } finally {
          this._pendingCount--;
        }
      }

      this._totalFailed++;
      throw lastError || new Error(`${label} failed after ${this.config.maxRetries + 1} attempts`);
    });
  }

  /** Serialize access through a mutex to prevent nonce races */
  private async withMutex<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const acquired = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.mutex;
    this.mutex = acquired;
    await prev;
    try {
      return await fn();
    } finally {
      release!();
    }
  }

  /** Enforce rate limit using a sliding window */
  private async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    const windowMs = 60_000; // 1 minute

    // Prune old timestamps
    this.txTimestamps = this.txTimestamps.filter((ts) => now - ts < windowMs);

    if (this.txTimestamps.length >= this.config.maxTxPerMinute) {
      const oldestInWindow = this.txTimestamps[0];
      const waitMs = windowMs - (now - oldestInWindow) + 100; // +100ms buffer
      logger.warn(
        `[TxQueue] Rate limit hit (${this.txTimestamps.length}/${this.config.maxTxPerMinute} tx/min), waiting ${waitMs}ms`,
      );
      await this.sleep(waitMs);
    }
  }

  private recordTx(): void {
    this.txTimestamps.push(Date.now());
  }

  private isRetryable(msg: string): boolean {
    const lower = msg.toLowerCase();
    return RETRYABLE_ERRORS.some((pattern) => lower.includes(pattern.toLowerCase()));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
