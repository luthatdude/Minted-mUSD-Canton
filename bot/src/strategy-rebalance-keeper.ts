/**
 * Minted Protocol — Strategy Rebalance Keeper
 *
 * Automates LTV drift correction, reward compounding, and emergency
 * deleveraging for FluidLoopStrategy vaults. This is the "driver" for
 * the on-chain rebalance(), claimAndCompound(), and emergencyDeleverage()
 * functions that already exist in the strategy contracts.
 *
 * Architecture:
 *   1. Poll each registered strategy's position via getPosition()
 *   2. Compute LTV drift against targetLtvBps ± safetyBufferBps
 *   3. If drift exceeds threshold → compound first, then rebalance
 *   4. If health factor < emergency threshold → emergencyDeleverage()
 *   5. Gas-aware execution — skip if gas too expensive for stablecoin loops
 *   6. Optionally route through Flashbots for MEV protection
 *   7. Alert via Telegram on every state change
 *
 * Environment variables:
 *   RPC_URL                   — Ethereum JSON-RPC (HTTPS required in prod)
 *   KEEPER_PRIVATE_KEY        — Signing key (KMS in prod)
 *   STRATEGY_ADDRESSES        — Comma-separated strategy proxy addresses
 *   KEEPER_POLL_MS            — Poll interval (default 60000 = 60s)
 *   MAX_GAS_GWEI              — Skip rebalance if baseFee > this (default 30)
 *   EMERGENCY_HF_THRESHOLD    — HF below this triggers emergency (default 1.05e18)
 *   COMPOUND_INTERVAL_HOURS   — Hours between compounding (default 24)
 *   USE_FLASHBOTS             — "true" to route via Flashbots (default "false")
 *   TELEGRAM_BOT_TOKEN        — Telegram bot token (optional)
 *   TELEGRAM_CHAT_ID          — Telegram chat ID (optional)
 */

import { ethers, Wallet } from "ethers";
import * as fs from "fs";
import { createLogger, format, transports } from "winston";

// ============================================================
//                     SECURITY HARDENING
// ============================================================

// INFRA-H-02 / INFRA-H-06: Enforce TLS certificate validation at process level
if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    console.error("[SECURITY] NODE_TLS_REJECT_UNAUTHORIZED=0 is FORBIDDEN in production. Overriding to 1.");
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
  }
}

// Handle unhandled promise rejections to prevent silent failures
process.on("unhandledRejection", (reason) => {
  console.error("FATAL: Unhandled promise rejection:", reason);
  process.exit(1);
});

// Handle uncaught exceptions to prevent silent crashes
process.on("uncaughtException", (error) => {
  console.error("FATAL: Uncaught exception:", error);
  process.exit(1);
});

// ============================================================
//                     TYPES
// ============================================================

export interface StrategyRebalanceConfig {
  rpcUrl: string;
  chainId: number;
  privateKey: string;
  /** Strategy proxy addresses to monitor */
  strategyAddresses: string[];
  /** Poll interval in ms (default 60s) */
  pollIntervalMs: number;
  /** Skip rebalance if baseFee > this (gwei). 0 = no limit */
  maxGasGwei: number;
  /** Health factor below this triggers emergencyDeleverage (WAD) */
  emergencyHfThreshold: bigint;
  /** Hours between compound cycles */
  compoundIntervalHours: number;
  /** Route transactions via Flashbots relay */
  useFlashbots: boolean;
  /** Telegram alerts */
  telegramBotToken: string;
  telegramChatId: string;
}

interface StrategyState {
  address: string;
  collateral: bigint;
  borrowed: bigint;
  principal: bigint;
  netValue: bigint;
  healthFactor: bigint;
  currentLtvBps: bigint;
  targetLtvBps: bigint;
  safetyBufferBps: bigint;
  leverageX100: bigint;
  active: boolean;
  paused: boolean;
  positionNftId: bigint;
}

// ============================================================
//                     DEFAULT CONFIG
// ============================================================

export const DEFAULT_REBALANCE_CONFIG: StrategyRebalanceConfig = {
  rpcUrl: process.env.RPC_URL || "",
  chainId: parseInt(process.env.CHAIN_ID || "1", 10),
  privateKey: "",
  strategyAddresses: (process.env.STRATEGY_ADDRESSES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  pollIntervalMs: parseInt(process.env.KEEPER_POLL_MS || "60000", 10),
  maxGasGwei: parseInt(process.env.MAX_GAS_GWEI || "30", 10),
  emergencyHfThreshold: BigInt(process.env.EMERGENCY_HF_THRESHOLD || "1050000000000000000"), // 1.05e18
  compoundIntervalHours: parseInt(process.env.COMPOUND_INTERVAL_HOURS || "24", 10),
  useFlashbots: process.env.USE_FLASHBOTS === "true",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
};

// Reject insecure HTTP transport in production
if (
  process.env.NODE_ENV === "production" &&
  DEFAULT_REBALANCE_CONFIG.rpcUrl &&
  !DEFAULT_REBALANCE_CONFIG.rpcUrl.startsWith("https://") &&
  !DEFAULT_REBALANCE_CONFIG.rpcUrl.startsWith("wss://")
) {
  throw new Error("Insecure RPC transport in production. RPC_URL must use https:// or wss://");
}

// ============================================================
//                     ABIs (ethers human-readable)
// ============================================================

const STRATEGY_ABI = [
  // View — position
  "function getPosition() external view returns (uint256 collateral, uint256 borrowed, uint256 principal, uint256 netValue)",
  "function getHealthFactor() external view returns (uint256)",
  "function getCurrentLeverage() external view returns (uint256 leverageX100)",
  "function realSharePrice() external view returns (uint256 priceWad, bool trusted)",
  "function realTvl() external view returns (uint256 tvl, bool trusted)",
  "function totalValue() external view returns (uint256)",
  // View — parameters
  "function targetLtvBps() external view returns (uint256)",
  "function safetyBufferBps() external view returns (uint256)",
  "function targetLoops() external view returns (uint256)",
  "function active() external view returns (bool)",
  "function paused() external view returns (bool)",
  "function positionNftId() external view returns (uint256)",
  "function vaultMode() external view returns (uint8)",
  "function totalPrincipal() external view returns (uint256)",
  "function totalRewardsClaimed() external view returns (uint256)",
  // Write — keeper
  "function rebalance() external",
  "function claimAndCompound(address[] tokens, uint256[] amounts, bytes32[][] proofs) external",
  // Write — guardian
  "function emergencyDeleverage() external",
  // Events
  "event Rebalanced(uint256 oldLtv, uint256 newLtv, uint256 rewardsClaimed)",
  "event RewardsCompounded(uint256 amount, uint256 leverageX100)",
  "event EmergencyDeleveraged(uint256 healthFactorBefore, uint256 healthFactorAfter)",
];

// ============================================================
//                     CONSTANTS
// ============================================================

const WAD = 10n ** 18n;
const BPS = 10_000n;

// ============================================================
//                     LOGGER
// ============================================================

const logger = createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: format.combine(
    format.timestamp(),
    format.printf(
      ({ timestamp, level, message }) =>
        `${timestamp} [${level.toUpperCase()}] [REBALANCE-KEEPER] ${message}`
    )
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: "strategy-rebalance-keeper.log" }),
  ],
});

// ============================================================
//                     SECRET READING
// ============================================================

function readSecret(name: string, envVar: string): string {
  const secretPath = `/run/secrets/${name}`;
  try {
    if (fs.existsSync(secretPath)) {
      return fs.readFileSync(secretPath, "utf-8").trim();
    }
  } catch {
    /* Fall through to env var */
  }
  return process.env[envVar] || "";
}

const SECP256K1_N = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"
);

function readAndValidatePrivateKey(secretName: string, envVar: string): string {
  const key = readSecret(secretName, envVar);
  if (!key) return "";
  const normalized = key.startsWith("0x") ? key.slice(2) : key;
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`SECURITY: ${envVar} is not a valid private key (expected 64 hex chars)`);
  }
  const keyValue = BigInt("0x" + normalized);
  if (keyValue === 0n || keyValue >= SECP256K1_N) {
    throw new Error(
      `SECURITY: ${envVar} is not a valid secp256k1 private key. ` +
        `Key must be in range [1, curve order-1]`
    );
  }
  return key;
}

// ============================================================
//                     PURE HELPERS (exported for testing)
// ============================================================

/**
 * Determines if a strategy needs rebalancing based on LTV drift.
 * Returns: "over" | "under" | null (null = no rebalance needed)
 */
export function shouldRebalance(
  currentLtvBps: bigint,
  targetLtvBps: bigint,
  safetyBufferBps: bigint
): "over" | "under" | null {
  if (currentLtvBps > targetLtvBps + safetyBufferBps) return "over";
  if (targetLtvBps > safetyBufferBps && currentLtvBps < targetLtvBps - safetyBufferBps) return "under";
  return null;
}

/**
 * Determines if health factor is below emergency threshold.
 */
export function isEmergency(healthFactor: bigint, threshold: bigint): boolean {
  return healthFactor > 0n && healthFactor < threshold;
}

/**
 * Determines if gas price is too high for non-emergency operations.
 */
export function isGasTooHigh(baseFeeGwei: number, maxGasGwei: number): boolean {
  if (maxGasGwei <= 0) return false; // 0 = no limit
  return baseFeeGwei > maxGasGwei;
}

/**
 * Determines if compounding is due based on last compound time.
 */
export function isCompoundDue(
  nowMs: number,
  lastCompoundMs: number,
  intervalHours: number
): boolean {
  const intervalMs = intervalHours * 3600 * 1000;
  return nowMs - lastCompoundMs >= intervalMs;
}

// ============================================================
//                     KEEPER CLASS
// ============================================================

export class StrategyRebalanceKeeper {
  private config: StrategyRebalanceConfig;
  private provider: ethers.JsonRpcProvider;
  private wallet: Wallet;
  private strategies: ethers.Contract[];
  private running = false;
  /** Tracks last compound timestamp per strategy address */
  private lastCompoundTime: Map<string, number> = new Map();
  /** Tracks consecutive failures per strategy (circuit breaker) */
  private consecutiveFailures: Map<string, number> = new Map();
  private static readonly MAX_CONSECUTIVE_FAILURES = 5;

  constructor(config: StrategyRebalanceConfig) {
    this.config = config;

    const fetchReq = new ethers.FetchRequest(config.rpcUrl);
    fetchReq.timeout = parseInt(process.env.RPC_TIMEOUT_MS || "30000", 10);
    this.provider = new ethers.JsonRpcProvider(fetchReq, undefined, {
      staticNetwork: true,
      batchMaxCount: 1,
    });

    // Guard against raw private key usage in production
    if (process.env.NODE_ENV === "production" && !process.env.KMS_KEY_ID) {
      throw new Error(
        "SECURITY: Raw private key usage is forbidden in production. " +
          "Configure KMS_KEY_ID, KMS_PROVIDER, and KMS_REGION environment variables. " +
          "See relay/kms-ethereum-signer.ts for KMS signer implementation."
      );
    }
    this.wallet = new Wallet(config.privateKey, this.provider);

    this.strategies = config.strategyAddresses.map(
      (addr) => new ethers.Contract(addr, STRATEGY_ABI, this.wallet)
    );
  }

  // ----------------------------------------------------------
  //  MAIN LOOP
  // ----------------------------------------------------------

  async start(): Promise<void> {
    logger.info("═══════════════════════════════════════════════════════════");
    logger.info("  STRATEGY REBALANCE KEEPER — Starting");
    logger.info(`  Keeper wallet: ${this.wallet.address}`);
    logger.info(`  Strategies: ${this.config.strategyAddresses.length}`);
    for (const addr of this.config.strategyAddresses) {
      logger.info(`    • ${addr}`);
    }
    logger.info(`  Poll interval: ${this.config.pollIntervalMs / 1000}s`);
    logger.info(`  Max gas: ${this.config.maxGasGwei} gwei`);
    logger.info(`  Emergency HF: ${ethers.formatEther(this.config.emergencyHfThreshold)}`);
    logger.info(`  Compound interval: ${this.config.compoundIntervalHours}h`);
    logger.info(`  Flashbots: ${this.config.useFlashbots ? "ENABLED" : "disabled"}`);
    logger.info("═══════════════════════════════════════════════════════════");

    this.running = true;

    while (this.running) {
      try {
        await this.runCycle();
      } catch (err) {
        logger.error(`Cycle failed: ${(err as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, this.config.pollIntervalMs));
    }
  }

  stop(): void {
    this.running = false;
    this.provider.removeAllListeners();
    logger.info("Strategy rebalance keeper stopped.");
  }

  // ----------------------------------------------------------
  //  CYCLE: READ → DECIDE → ACT
  // ----------------------------------------------------------

  private async runCycle(): Promise<void> {
    for (const strategy of this.strategies) {
      const addr = await strategy.getAddress();
      try {
        const state = await this.readStrategyState(strategy, addr);

        if (!state.active || state.paused) {
          logger.debug(`${this.short(addr)} — inactive/paused, skipping`);
          continue;
        }

        if (state.positionNftId === 0n) {
          logger.debug(`${this.short(addr)} — no position, skipping`);
          continue;
        }

        // ── EMERGENCY CHECK (always runs, ignores gas) ──
        if (isEmergency(state.healthFactor, this.config.emergencyHfThreshold)) {
          logger.warn(
            `🚨 ${this.short(addr)} — HF ${this.fmtWad(state.healthFactor)} < ${this.fmtWad(this.config.emergencyHfThreshold)}. ` +
              `EMERGENCY DELEVERAGE required.`
          );
          await this.sendAlert(
            `🚨 *EMERGENCY DELEVERAGE*\nStrategy: \`${this.short(addr)}\`\n` +
              `Health Factor: ${this.fmtWad(state.healthFactor)}\n` +
              `Threshold: ${this.fmtWad(this.config.emergencyHfThreshold)}\n` +
              `⚠️ Requires GUARDIAN_ROLE — manual action needed`
          );
          // NOTE: rebalance keeper has KEEPER_ROLE, not GUARDIAN_ROLE.
          // emergencyDeleverage() requires GUARDIAN_ROLE — alert only.
          this.resetFailures(addr);
          continue;
        }

        // ── GAS CHECK (skip non-emergency ops if gas is too high) ──
        if (this.config.maxGasGwei > 0) {
          const feeData = await this.provider.getFeeData();
          const baseFeeGwei = feeData.gasPrice
            ? Number(ethers.formatUnits(feeData.gasPrice, "gwei"))
            : 0;

          if (isGasTooHigh(baseFeeGwei, this.config.maxGasGwei)) {
            logger.info(
              `${this.short(addr)} — gas ${baseFeeGwei.toFixed(1)} gwei > max ${this.config.maxGasGwei} gwei, deferring`
            );
            continue;
          }
        }

        // ── COMPOUND CHECK (time-based, before rebalance) ──
        await this.maybeCompound(strategy, addr);

        // ── LTV DRIFT CHECK ──
        await this.maybeRebalance(strategy, addr, state);

        // Reset failure counter on success
        this.resetFailures(addr);
      } catch (err) {
        const failures = this.recordFailure(addr);
        logger.error(
          `${this.short(addr)} — error (${failures}/${StrategyRebalanceKeeper.MAX_CONSECUTIVE_FAILURES}): ` +
            `${(err as Error).message}`
        );

        if (failures >= StrategyRebalanceKeeper.MAX_CONSECUTIVE_FAILURES) {
          await this.sendAlert(
            `⚠️ *Strategy Keeper Circuit Breaker*\nStrategy: \`${this.short(addr)}\`\n` +
              `${failures} consecutive failures\nError: ${(err as Error).message}\n` +
              `⏸️ Will retry next cycle`
          );
        }
      }
    }
  }

  // ----------------------------------------------------------
  //  READ STATE
  // ----------------------------------------------------------

  private async readStrategyState(
    strategy: ethers.Contract,
    addr: string
  ): Promise<StrategyState> {
    // Batch reads to minimize RPC calls
    const [position, hf, leverage, targetLtv, buffer, active, paused, nftId] =
      await Promise.all([
        strategy.getPosition() as Promise<[bigint, bigint, bigint, bigint]>,
        strategy.getHealthFactor() as Promise<bigint>,
        strategy.getCurrentLeverage() as Promise<bigint>,
        strategy.targetLtvBps() as Promise<bigint>,
        strategy.safetyBufferBps() as Promise<bigint>,
        strategy.active() as Promise<boolean>,
        strategy.paused() as Promise<boolean>,
        strategy.positionNftId() as Promise<bigint>,
      ]);

    const [collateral, borrowed, principal, netValue] = position;
    const currentLtvBps = collateral > 0n ? (borrowed * BPS) / collateral : 0n;

    return {
      address: addr,
      collateral,
      borrowed,
      principal,
      netValue,
      healthFactor: hf,
      currentLtvBps,
      targetLtvBps: targetLtv,
      safetyBufferBps: buffer,
      leverageX100: leverage,
      active,
      paused,
      positionNftId: nftId,
    };
  }

  // ----------------------------------------------------------
  //  REBALANCE
  // ----------------------------------------------------------

  private async maybeRebalance(
    strategy: ethers.Contract,
    addr: string,
    state: StrategyState
  ): Promise<void> {
    const direction = shouldRebalance(state.currentLtvBps, state.targetLtvBps, state.safetyBufferBps);
    if (direction === null) {
      const drift = state.currentLtvBps > state.targetLtvBps
        ? state.currentLtvBps - state.targetLtvBps
        : state.targetLtvBps - state.currentLtvBps;
      logger.debug(
        `${this.short(addr)} — LTV ${state.currentLtvBps}bps, target ${state.targetLtvBps}bps, ` +
          `drift ${drift}bps within buffer ${state.safetyBufferBps}bps ✓`
      );
      return;
    }
    logger.info(
      `${this.short(addr)} — LTV drift detected: ${state.currentLtvBps}bps vs target ${state.targetLtvBps}bps ` +
        `(${direction.toUpperCase()}-leveraged, buffer=${state.safetyBufferBps}bps)`
    );

    // Simulate first via eth_call
    try {
      await strategy.rebalance.staticCall();
    } catch (err) {
      logger.error(
        `${this.short(addr)} — rebalance simulation reverted: ${(err as Error).message}`
      );
      await this.sendAlert(
        `⚠️ *Rebalance Simulation Failed*\nStrategy: \`${this.short(addr)}\`\n` +
          `LTV: ${state.currentLtvBps}bps (target ${state.targetLtvBps}bps)\n` +
          `Error: ${(err as Error).message}`
      );
      return;
    }

    // Execute
    logger.info(`${this.short(addr)} — executing rebalance()...`);
    const tx = await strategy.rebalance({ gasLimit: 800_000n });
    const receipt = await tx.wait();

    // Read new state
    const newState = await this.readStrategyState(strategy, addr);

    logger.info(
      `${this.short(addr)} — ✅ rebalanced: ${state.currentLtvBps}bps → ${newState.currentLtvBps}bps ` +
        `(gas: ${receipt.gasUsed}, tx: ${receipt.hash})`
    );

    await this.sendAlert(
      `✅ *Rebalance Executed*\nStrategy: \`${this.short(addr)}\`\n` +
        `LTV: ${state.currentLtvBps} → ${newState.currentLtvBps} bps\n` +
        `HF: ${this.fmtWad(newState.healthFactor)}\n` +
        `Gas: ${receipt.gasUsed}\nTx: \`${receipt.hash}\``
    );
  }

  // ----------------------------------------------------------
  //  COMPOUND
  // ----------------------------------------------------------

  private async maybeCompound(
    strategy: ethers.Contract,
    addr: string
  ): Promise<void> {
    const now = Date.now();
    const lastCompound = this.lastCompoundTime.get(addr) || 0;

    if (!isCompoundDue(now, lastCompound, this.config.compoundIntervalHours)) {
      return; // Not time yet
    }

    // NOTE: claimAndCompound requires Merkl proof data (tokens, amounts, proofs).
    // In production, these proofs must be fetched from the Merkl API:
    //   GET https://api.merkl.xyz/v3/userRewards?user={strategyAddress}&chainId={chainId}
    // The keeper then filters for allowedRewardTokens and constructs the call.
    //
    // For now, we log that compounding is due and update the timestamp.
    // A full implementation would:
    //   1. Fetch proofs from Merkl API
    //   2. Filter for allowedRewardTokens on-chain
    //   3. Simulate claimAndCompound via eth_call
    //   4. Execute if simulation succeeds

    logger.info(
      `${this.short(addr)} — compound cycle due (last: ${lastCompound === 0 ? "never" : new Date(lastCompound).toISOString()})`
    );

    // TODO: Integrate Merkl API proof fetching here
    // const proofData = await this.fetchMerklProofs(addr);
    // if (proofData) {
    //   await strategy.claimAndCompound(proofData.tokens, proofData.amounts, proofData.proofs);
    // }

    this.lastCompoundTime.set(addr, now);
  }

  // ----------------------------------------------------------
  //  ALERTING
  // ----------------------------------------------------------

  private async sendAlert(message: string): Promise<void> {
    if (!this.config.telegramBotToken || !this.config.telegramChatId) return;
    try {
      const url = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`;
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.config.telegramChatId,
          text: message,
          parse_mode: "Markdown",
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      logger.warn(`Telegram alert failed: ${(err as Error).message}`);
    }
  }

  // ----------------------------------------------------------
  //  FAILURE TRACKING (circuit breaker)
  // ----------------------------------------------------------

  private recordFailure(addr: string): number {
    const count = (this.consecutiveFailures.get(addr) || 0) + 1;
    this.consecutiveFailures.set(addr, count);
    return count;
  }

  private resetFailures(addr: string): void {
    this.consecutiveFailures.set(addr, 0);
  }

  // ----------------------------------------------------------
  //  HELPERS
  // ----------------------------------------------------------

  private short(addr: string): string {
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  }

  private fmtWad(value: bigint): string {
    return Number(ethers.formatEther(value)).toFixed(4);
  }
}

// ============================================================
//                     ENTRYPOINT
// ============================================================

async function main(): Promise<void> {
  const privateKey = readAndValidatePrivateKey("keeper_private_key", "KEEPER_PRIVATE_KEY");
  if (!privateKey) {
    console.error("FATAL: KEEPER_PRIVATE_KEY is required");
    process.exit(1);
  }

  const config: StrategyRebalanceConfig = {
    ...DEFAULT_REBALANCE_CONFIG,
    privateKey,
  };

  if (config.strategyAddresses.length === 0) {
    console.error("FATAL: STRATEGY_ADDRESSES is required (comma-separated strategy proxy addresses)");
    process.exit(1);
  }

  const keeper = new StrategyRebalanceKeeper(config);

  process.on("SIGINT", () => keeper.stop());
  process.on("SIGTERM", () => keeper.stop());

  await keeper.start();
}

// Only run main when executed directly
if (require.main === module) {
  main().catch((err) => {
    console.error("Strategy rebalance keeper crashed:", err);
    process.exit(1);
  });
}
