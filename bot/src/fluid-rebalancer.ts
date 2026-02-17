/**
 * Minted Protocol — Fluid Strategy Rebalancer Keeper
 *
 * Monitors FluidLoopStrategy instances (vaultModes 1–3) and
 * auto-rebalances when LTV drifts outside targetLtvBps ± safetyBufferBps.
 * Triggers emergencyDeleverage via GUARDIAN_ROLE if health factor drops
 * below a critical threshold.
 *
 * Architecture:
 *   1. Poll getHealthFactor() + getPosition() on each strategy every N seconds
 *   2. If LTV outside safe band → call rebalance()       (KEEPER_ROLE)
 *   3. If health factor < critical → emergencyDeleverage() (GUARDIAN_ROLE)
 *   4. Alert via Telegram on every state change
 *   5. Expose /health for K8s liveness probes
 *
 * Env vars:
 *   RPC_URL, CHAIN_ID, KEEPER_PRIVATE_KEY, GUARDIAN_PRIVATE_KEY (optional),
 *   FLUID_STRATEGIES (comma-separated addresses),
 *   REBALANCER_POLL_MS (default 30000),
 *   CRITICAL_HF_THRESHOLD (default "1050000000000000000" = 1.05e18),
 *   WARN_HF_THRESHOLD (default "1100000000000000000" = 1.10e18),
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
 *   BOT_PORT (default 8081)
 */

import { ethers, Wallet } from "ethers";
import * as fs from "fs";
import { createLogger, format, transports } from "winston";
import { startHealthServer } from "./server";

// ─── Security: enforce TLS in non-dev environments ──────────
if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    console.error("[SECURITY] NODE_TLS_REJECT_UNAUTHORIZED=0 is FORBIDDEN in production. Overriding to 1.");
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
  }
}

process.on("unhandledRejection", (reason) => {
  console.error("FATAL: Unhandled promise rejection:", reason);
  process.exit(1);
});
process.on("uncaughtException", (error) => {
  console.error("FATAL: Uncaught exception:", error);
  process.exit(1);
});

// ═══════════════════════════════════════════════════════════════
//                          TYPES
// ═══════════════════════════════════════════════════════════════

export interface RebalancerConfig {
  rpcUrl: string;
  chainId: number;
  keeperPrivateKey: string;
  /** Optional separate key with GUARDIAN_ROLE for emergency deleverage */
  guardianPrivateKey: string;
  /** Strategy contract addresses to monitor */
  strategies: string[];
  /** Poll interval in ms (default 30 000 — 30s) */
  pollIntervalMs: number;
  /**
   * Health factor below which emergencyDeleverage() is called.
   * 1e18 = 1.0x HF. Default 1.05e18 (5% margin).
   */
  criticalHfThreshold: bigint;
  /**
   * Health factor below which a Telegram warning is sent (no action).
   * Default 1.10e18 (10% margin).
   */
  warnHfThreshold: bigint;
  /** Telegram bot token */
  telegramBotToken: string;
  /** Telegram chat ID */
  telegramChatId: string;
  /** Health-check HTTP port */
  httpPort: number;
}

export interface StrategySnapshot {
  address: string;
  healthFactor: bigint;
  collateral: bigint;
  borrowed: bigint;
  principal: bigint;
  netValue: bigint;
  targetLtvBps: bigint;
  safetyBufferBps: bigint;
  currentLtv: bigint;
  isActive: boolean;
}

type AlertSeverity = "INFO" | "WARN" | "CRITICAL" | "EMERGENCY";

// ═══════════════════════════════════════════════════════════════
//                          CONSTANTS
// ═══════════════════════════════════════════════════════════════

const BPS = 10_000n;
const WAD = ethers.WeiPerEther; // 1e18

const FLUID_STRATEGY_ABI = [
  // ILeverageLoopStrategy view functions
  "function getHealthFactor() external view returns (uint256)",
  "function getCurrentLeverage() external view returns (uint256)",
  "function getPosition() external view returns (uint256 collateral, uint256 borrowed, uint256 principal, uint256 netValue)",
  "function targetLtvBps() external view returns (uint256)",
  "function targetLoops() external view returns (uint256)",
  "function safetyBufferBps() external view returns (uint256)",
  "function isActive() external view returns (bool)",
  "function totalValue() external view returns (uint256)",
  "function vaultMode() external view returns (uint8)",
  "function realSharePrice() external view returns (uint256 priceWad, bool trusted)",
  "function realTvl() external view returns (uint256 tvl, bool trusted)",
  // Keeper actions
  "function rebalance() external",
  // Guardian actions
  "function emergencyDeleverage() external",
  // Events
  "event Rebalanced(uint256 oldLtv, uint256 newLtv, uint256 adjustment)",
  "event EmergencyDeleveraged(uint256 healthBefore, uint256 healthAfter)",
];

const VAULT_MODE_LABELS: Record<number, string> = {
  1: "T1 Stable (syrupUSDC/USDC)",
  2: "T2 LRT (weETH-ETH/wstETH)",
  3: "T4 LST (wstETH-ETH/wstETH-ETH)",
};

// ═══════════════════════════════════════════════════════════════
//                          LOGGER
// ═══════════════════════════════════════════════════════════════

const logger = createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: format.combine(
    format.timestamp(),
    format.printf(
      ({ timestamp, level, message }) =>
        `${timestamp} [${level.toUpperCase()}] [FLUID-REBALANCER] ${message}`
    )
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: "fluid-rebalancer.log" }),
  ],
});

// ═══════════════════════════════════════════════════════════════
//                     SECRET / KEY HELPERS
// ═══════════════════════════════════════════════════════════════

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
      `SECURITY: ${envVar} is not a valid secp256k1 private key.`
    );
  }
  return key;
}

// ═══════════════════════════════════════════════════════════════
//                      PURE HELPERS
// ═══════════════════════════════════════════════════════════════

/** Format a 1e18-scaled health factor as a human-readable string (e.g. "1.05x") */
export function formatHf(hf: bigint): string {
  const intPart = hf / WAD;
  const fracPart = ((hf % WAD) * 100n) / WAD;
  return `${intPart}.${fracPart.toString().padStart(2, "0")}x`;
}

/** Format bps as a percentage string */
export function formatBps(bps: bigint): string {
  const pct = Number(bps) / 100;
  return `${pct.toFixed(1)}%`;
}

/** Decide if rebalance is needed based on LTV drift */
export function needsRebalance(
  currentLtv: bigint,
  targetLtv: bigint,
  safetyBuffer: bigint
): "over" | "under" | "ok" {
  if (currentLtv > targetLtv + safetyBuffer) return "over";
  if (currentLtv < targetLtv - safetyBuffer) return "under";
  return "ok";
}

// ═══════════════════════════════════════════════════════════════
//                     REBALANCER CLASS
// ═══════════════════════════════════════════════════════════════

export class FluidRebalancer {
  private config: RebalancerConfig;
  private provider: ethers.JsonRpcProvider;
  private keeperWallet: Wallet;
  private guardianWallet: Wallet | null;
  private contracts: Map<string, ethers.Contract> = new Map();
  private guardianContracts: Map<string, ethers.Contract> = new Map();
  private running = false;
  private lastAlertTime: Map<string, number> = new Map();
  private consecutiveErrors = 0;

  /** Rate-limit alerts: at most 1 per strategy per 5 minutes */
  private static readonly ALERT_COOLDOWN_MS = 5 * 60 * 1000;
  /** Max consecutive errors before self-reporting unhealthy */
  private static readonly MAX_CONSECUTIVE_ERRORS = 5;

  constructor(config: RebalancerConfig) {
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
          "Configure KMS_KEY_ID, KMS_PROVIDER, and KMS_REGION environment variables."
      );
    }

    this.keeperWallet = new Wallet(config.keeperPrivateKey, this.provider);

    // Guardian wallet is optional — if not provided, emergency deleverage
    // will only trigger a Telegram alert for manual intervention
    this.guardianWallet = config.guardianPrivateKey
      ? new Wallet(config.guardianPrivateKey, this.provider)
      : null;

    // Create contract instances
    for (const addr of config.strategies) {
      this.contracts.set(
        addr.toLowerCase(),
        new ethers.Contract(addr, FLUID_STRATEGY_ABI, this.keeperWallet)
      );
      if (this.guardianWallet) {
        this.guardianContracts.set(
          addr.toLowerCase(),
          new ethers.Contract(addr, FLUID_STRATEGY_ABI, this.guardianWallet)
        );
      }
    }
  }

  // ─── Public API ─────────────────────────────────────────────

  async start(): Promise<void> {
    logger.info("═══════════════════════════════════════════════════");
    logger.info("  FLUID REBALANCER KEEPER — Starting");
    logger.info(`  Keeper:   ${this.keeperWallet.address}`);
    if (this.guardianWallet) {
      logger.info(`  Guardian: ${this.guardianWallet.address}`);
    } else {
      logger.info("  Guardian: NOT CONFIGURED (emergency = alert-only)");
    }
    logger.info(`  Strategies: ${this.config.strategies.length}`);
    for (const addr of this.config.strategies) {
      logger.info(`    • ${addr}`);
    }
    logger.info(`  Poll interval: ${this.config.pollIntervalMs / 1000}s`);
    logger.info(`  Critical HF:   ${formatHf(this.config.criticalHfThreshold)}`);
    logger.info(`  Warning HF:    ${formatHf(this.config.warnHfThreshold)}`);
    logger.info("═══════════════════════════════════════════════════");

    this.running = true;

    // Initial Telegram announcement
    await this.sendAlert(
      "INFO",
      "🟢 *Fluid Rebalancer Started*\n" +
        `Monitoring ${this.config.strategies.length} strategies\n` +
        `Poll: ${this.config.pollIntervalMs / 1000}s | ` +
        `Critical HF: ${formatHf(this.config.criticalHfThreshold)} | ` +
        `Warn HF: ${formatHf(this.config.warnHfThreshold)}`
    );

    while (this.running) {
      try {
        await this.runCycle();
        this.consecutiveErrors = 0;
      } catch (err) {
        this.consecutiveErrors++;
        logger.error(
          `Cycle failed (${this.consecutiveErrors}/${FluidRebalancer.MAX_CONSECUTIVE_ERRORS}): ${(err as Error).message}`
        );
        if (this.consecutiveErrors >= FluidRebalancer.MAX_CONSECUTIVE_ERRORS) {
          await this.sendAlert(
            "CRITICAL",
            `🔴 *Rebalancer Degraded*\n${this.consecutiveErrors} consecutive failures\nLast: ${(err as Error).message}`
          );
        }
      }
      await new Promise((r) => setTimeout(r, this.config.pollIntervalMs));
    }
  }

  stop(): void {
    this.running = false;
    logger.info("Fluid rebalancer stopped.");
  }

  isHealthy(): boolean {
    return this.consecutiveErrors < FluidRebalancer.MAX_CONSECUTIVE_ERRORS;
  }

  // ─── Core Loop ──────────────────────────────────────────────

  private async runCycle(): Promise<void> {
    for (const [addrLower, contract] of this.contracts) {
      try {
        await this.checkStrategy(addrLower, contract);
      } catch (err) {
        logger.warn(`Strategy ${addrLower.slice(0, 10)} check failed: ${(err as Error).message}`);
      }
    }
  }

  private async checkStrategy(addr: string, contract: ethers.Contract): Promise<void> {
    // 1. Gather snapshot
    const snapshot = await this.getSnapshot(addr, contract);
    if (!snapshot.isActive) {
      logger.debug(`${addr.slice(0, 10)} — inactive, skipping`);
      return;
    }
    if (snapshot.borrowed === 0n) {
      logger.debug(`${addr.slice(0, 10)} — no debt, skipping`);
      return;
    }

    const label = addr.slice(0, 10);
    logger.debug(
      `${label} — HF: ${formatHf(snapshot.healthFactor)} | ` +
        `LTV: ${formatBps(snapshot.currentLtv)} (target ${formatBps(snapshot.targetLtvBps)} ± ${formatBps(snapshot.safetyBufferBps)}) | ` +
        `Col: ${ethers.formatUnits(snapshot.collateral, 18)} | Debt: ${ethers.formatUnits(snapshot.borrowed, 18)}`
    );

    // 2. EMERGENCY check — health factor below critical
    if (snapshot.healthFactor < this.config.criticalHfThreshold) {
      logger.warn(`${label} — 🚨 CRITICAL HF ${formatHf(snapshot.healthFactor)} < ${formatHf(this.config.criticalHfThreshold)}`);
      await this.handleEmergency(addr, snapshot);
      return;
    }

    // 3. WARNING check — health factor below warning threshold
    if (snapshot.healthFactor < this.config.warnHfThreshold) {
      logger.warn(`${label} — ⚠️ LOW HF ${formatHf(snapshot.healthFactor)}`);
      await this.sendAlertThrottled(
        addr,
        "WARN",
        `⚠️ *Low Health Factor*\n` +
          `Strategy: \`${addr}\`\n` +
          `HF: ${formatHf(snapshot.healthFactor)}\n` +
          `LTV: ${formatBps(snapshot.currentLtv)} (target ${formatBps(snapshot.targetLtvBps)})\n` +
          `Action: Monitoring. Emergency at ${formatHf(this.config.criticalHfThreshold)}.`
      );
    }

    // 4. REBALANCE check — LTV outside safe band
    const drift = needsRebalance(snapshot.currentLtv, snapshot.targetLtvBps, snapshot.safetyBufferBps);
    if (drift !== "ok") {
      await this.executeRebalance(addr, contract, snapshot, drift);
    }
  }

  // ─── Snapshot ───────────────────────────────────────────────

  private async getSnapshot(addr: string, contract: ethers.Contract): Promise<StrategySnapshot> {
    // Batch read in parallel
    const [hf, position, targetLtv, safetyBuffer, active] = await Promise.all([
      contract.getHealthFactor() as Promise<bigint>,
      contract.getPosition() as Promise<[bigint, bigint, bigint, bigint]>,
      contract.targetLtvBps() as Promise<bigint>,
      contract.safetyBufferBps() as Promise<bigint>,
      contract.isActive() as Promise<boolean>,
    ]);

    const [collateral, borrowed, principal, netValue] = position;
    const currentLtv = collateral > 0n ? (borrowed * BPS) / collateral : 0n;

    return {
      address: addr,
      healthFactor: hf,
      collateral,
      borrowed,
      principal,
      netValue,
      targetLtvBps: targetLtv,
      safetyBufferBps: safetyBuffer,
      currentLtv,
      isActive: active,
    };
  }

  // ─── Rebalance ──────────────────────────────────────────────

  private async executeRebalance(
    addr: string,
    contract: ethers.Contract,
    snapshot: StrategySnapshot,
    drift: "over" | "under"
  ): Promise<void> {
    const label = addr.slice(0, 10);
    const direction = drift === "over" ? "OVER-leveraged ↓" : "UNDER-leveraged ↑";

    logger.info(
      `${label} — ${direction} | LTV ${formatBps(snapshot.currentLtv)} ` +
        `(target ${formatBps(snapshot.targetLtvBps)} ± ${formatBps(snapshot.safetyBufferBps)}). Rebalancing…`
    );

    try {
      const tx = await contract.rebalance();
      const receipt = await tx.wait();

      // Re-read post-rebalance state
      const newHf = await contract.getHealthFactor();
      const newPos = await contract.getPosition();
      const newLtv = newPos[0] > 0n ? (newPos[1] * BPS) / newPos[0] : 0n;

      logger.info(
        `${label} — ✅ Rebalanced in tx ${receipt.hash} | ` +
          `LTV ${formatBps(snapshot.currentLtv)} → ${formatBps(newLtv)} | HF → ${formatHf(newHf)}`
      );

      await this.sendAlert(
        "INFO",
        `✅ *Rebalance Executed*\n` +
          `Strategy: \`${addr}\`\n` +
          `Direction: ${direction}\n` +
          `LTV: ${formatBps(snapshot.currentLtv)} → ${formatBps(newLtv)}\n` +
          `HF: ${formatHf(snapshot.healthFactor)} → ${formatHf(newHf)}\n` +
          `Gas: ${receipt.gasUsed.toString()}\n` +
          `Tx: \`${receipt.hash}\``
      );
    } catch (err) {
      const errMsg = (err as Error).message;
      logger.error(`${label} — ❌ Rebalance FAILED: ${errMsg}`);

      await this.sendAlert(
        "CRITICAL",
        `🔴 *Rebalance FAILED*\n` +
          `Strategy: \`${addr}\`\n` +
          `Direction: ${direction}\n` +
          `LTV: ${formatBps(snapshot.currentLtv)} | HF: ${formatHf(snapshot.healthFactor)}\n` +
          `Error: ${errMsg.slice(0, 200)}\n` +
          `⚠️ Manual intervention may be needed.`
      );
    }
  }

  // ─── Emergency Deleverage ───────────────────────────────────

  private async handleEmergency(addr: string, snapshot: StrategySnapshot): Promise<void> {
    const label = addr.slice(0, 10);

    // If no guardian wallet, alert only
    if (!this.guardianWallet) {
      logger.error(
        `${label} — 🚨 EMERGENCY but no GUARDIAN_PRIVATE_KEY configured. Sending alert for manual intervention.`
      );
      await this.sendAlert(
        "EMERGENCY",
        `🚨🚨🚨 *EMERGENCY — MANUAL DELEVERAGE REQUIRED* 🚨🚨🚨\n\n` +
          `Strategy: \`${addr}\`\n` +
          `Health Factor: *${formatHf(snapshot.healthFactor)}* (critical < ${formatHf(this.config.criticalHfThreshold)})\n` +
          `LTV: ${formatBps(snapshot.currentLtv)} (target ${formatBps(snapshot.targetLtvBps)})\n` +
          `Collateral: ${ethers.formatUnits(snapshot.collateral, 18)}\n` +
          `Debt: ${ethers.formatUnits(snapshot.borrowed, 18)}\n\n` +
          `⚠️ *No guardian key configured — cannot auto-deleverage.*\n` +
          `Call emergencyDeleverage() manually NOW.`
      );
      return;
    }

    // Execute emergency deleverage via guardian wallet
    const guardianContract = this.guardianContracts.get(addr);
    if (!guardianContract) return;

    logger.warn(`${label} — 🚨 Executing emergencyDeleverage()…`);

    try {
      const tx = await guardianContract.emergencyDeleverage();
      const receipt = await tx.wait();

      const newHf = await guardianContract.getHealthFactor();

      logger.info(
        `${label} — 🛟 Emergency deleverage complete. Tx: ${receipt.hash} | New HF: ${formatHf(newHf)}`
      );

      await this.sendAlert(
        "EMERGENCY",
        `🛟 *Emergency Deleverage Executed*\n\n` +
          `Strategy: \`${addr}\`\n` +
          `HF: ${formatHf(snapshot.healthFactor)} → ${formatHf(newHf)}\n` +
          `LTV: ${formatBps(snapshot.currentLtv)} → fully deleveraged\n` +
          `Gas: ${receipt.gasUsed.toString()}\n` +
          `Tx: \`${receipt.hash}\`\n\n` +
          `⚠️ Strategy is now deleveraged. Re-leverage manually when safe.`
      );
    } catch (err) {
      const errMsg = (err as Error).message;
      logger.error(`${label} — ❌ Emergency deleverage FAILED: ${errMsg}`);

      await this.sendAlert(
        "EMERGENCY",
        `🚨🚨🚨 *EMERGENCY DELEVERAGE FAILED* 🚨🚨🚨\n\n` +
          `Strategy: \`${addr}\`\n` +
          `HF: ${formatHf(snapshot.healthFactor)}\n` +
          `Error: ${errMsg.slice(0, 200)}\n\n` +
          `⚠️ *MANUAL INTERVENTION REQUIRED IMMEDIATELY*`
      );
    }
  }

  // ─── Telegram Alerts ────────────────────────────────────────

  private async sendAlertThrottled(
    strategyAddr: string,
    severity: AlertSeverity,
    message: string
  ): Promise<void> {
    const key = `${strategyAddr}-${severity}`;
    const now = Date.now();
    const lastSent = this.lastAlertTime.get(key) || 0;
    if (now - lastSent < FluidRebalancer.ALERT_COOLDOWN_MS) {
      logger.debug(`Alert throttled for ${key}`);
      return;
    }
    this.lastAlertTime.set(key, now);
    await this.sendAlert(severity, message);
  }

  private async sendAlert(severity: AlertSeverity, message: string): Promise<void> {
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
      logger.debug(`Telegram ${severity} alert sent`);
    } catch (err) {
      logger.warn(`Telegram alert failed: ${(err as Error).message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//                        ENTRYPOINT
// ═══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  // Validate keys
  const keeperKey = readAndValidatePrivateKey("keeper_private_key", "KEEPER_PRIVATE_KEY");
  if (!keeperKey) {
    console.error("FATAL: KEEPER_PRIVATE_KEY is required");
    process.exit(1);
  }

  // Guardian key is optional
  const guardianKey = readAndValidatePrivateKey("guardian_private_key", "GUARDIAN_PRIVATE_KEY");
  if (!guardianKey) {
    console.warn("WARNING: GUARDIAN_PRIVATE_KEY not set — emergency deleverage will be alert-only");
  }

  // Parse strategy addresses
  const strategiesEnv = process.env.FLUID_STRATEGIES || "";
  const strategies = strategiesEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (strategies.length === 0) {
    console.error("FATAL: FLUID_STRATEGIES env var is required (comma-separated addresses)");
    process.exit(1);
  }

  const config: RebalancerConfig = {
    rpcUrl: process.env.RPC_URL || "",
    chainId: parseInt(process.env.CHAIN_ID || "1", 10),
    keeperPrivateKey: keeperKey,
    guardianPrivateKey: guardianKey,
    strategies,
    pollIntervalMs: parseInt(process.env.REBALANCER_POLL_MS || "30000", 10),
    criticalHfThreshold: BigInt(
      process.env.CRITICAL_HF_THRESHOLD || "1050000000000000000" // 1.05e18
    ),
    warnHfThreshold: BigInt(
      process.env.WARN_HF_THRESHOLD || "1100000000000000000" // 1.10e18
    ),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
    httpPort: Number(process.env.BOT_PORT) || 8081,
  };

  if (!config.rpcUrl) {
    console.error("FATAL: RPC_URL is required");
    process.exit(1);
  }

  // Reject insecure RPC transport in production
  if (
    process.env.NODE_ENV === "production" &&
    !config.rpcUrl.startsWith("https://") &&
    !config.rpcUrl.startsWith("wss://")
  ) {
    throw new Error("Insecure RPC transport in production. RPC_URL must use https:// or wss://");
  }

  if (config.pollIntervalMs < 5_000) {
    throw new Error("REBALANCER_POLL_MS must be >= 5000ms");
  }

  const rebalancer = new FluidRebalancer(config);

  // Start K8s health-check server
  const healthServer = startHealthServer(
    { port: config.httpPort, healthPath: "/health" },
    () => rebalancer.isHealthy()
  );

  // Graceful shutdown
  const shutdown = () => {
    rebalancer.stop();
    healthServer.stop();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await rebalancer.start();
}

// Only run main when executed directly
if (require.main === module) {
  main().catch((err) => {
    console.error("Fluid rebalancer crashed:", err);
    process.exit(1);
  });
}
