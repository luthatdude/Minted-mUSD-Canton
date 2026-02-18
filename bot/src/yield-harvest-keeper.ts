/**
 * Minted Protocol — Yield Harvest Keeper
 *
 * Automatically harvests yield from TreasuryV2 strategies and distributes
 * the net 80% to smUSD holders via YieldDistributor.distributeYield().
 *
 * Cycle:
 *   1. Read TreasuryV2.pendingYield() → (netYield, grossYield, protocolFee)
 *   2. If netYield > MIN_HARVEST_USD → call TreasuryV2.harvestYield()
 *   3. Call YieldDistributor.distributeYield(netYield) — splits ETH/Canton by share weight
 *   4. Optionally trigger MetaVault.rebalance() on each vault if drift > threshold
 *   5. Snapshot totalValue() per vault for APY calculation
 *   6. Expose /health + /apy for K8s probes and frontend consumption
 *
 * Yield Distribution Flow (after harvest):
 *   YieldDistributor.distributeYield(netYieldUsdc):
 *     - Reads ETH vs Canton share ratio from SMUSD
 *     - ETH portion → SMUSD.distributeYield() (12h linear vesting)
 *     - Canton portion → BLEBridge.bridgeToCanton() (burn ETH, relay credits Canton)
 *   The relay then picks up the BridgeToCantonRequested event and exercises
 *   ReceiveYield on the Canton CantonStakingService.
 *
 * Env vars:
 *   RPC_URL, CHAIN_ID, KEEPER_PRIVATE_KEY,
 *   TREASURY_ADDRESS, SMUSD_ADDRESS, YIELD_DISTRIBUTOR_ADDRESS,
 *   ETH_POOL_YIELD_DISTRIBUTOR_ADDRESS (optional — bridges MetaVault #3 yield to Canton ETH Pool),
 *   META_VAULT_ADDRESSES (comma-separated — vault1,vault2,vault3),
 *   YIELD_POLL_MS (default 300_000 — 5 min),
 *   MIN_HARVEST_USD (default "50" — USDC 6 decimals = 50e6),
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
 *   BOT_PORT (default 8082)
 */

import { ethers, Wallet } from "ethers";
import * as fs from "fs";
import http from "http";
import { createLogger, format, transports } from "winston";

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

export interface YieldKeeperConfig {
  rpcUrl: string;
  chainId: number;
  keeperPrivateKey: string;
  treasuryAddress: string;
  smusdAddress: string;
  yieldDistributorAddress: string;
  metaVaultAddresses: string[];
  /** ETH Pool yield distributor — bridges MetaVault #3 yield to Canton ETH Pool */
  ethPoolYieldDistributorAddress: string;
  pollIntervalMs: number;
  /** Minimum net yield (in USDC raw units, 6 decimals) to trigger harvest */
  minHarvestAmount: bigint;
  telegramBotToken: string;
  telegramChatId: string;
  httpPort: number;
}

interface VaultSnapshot {
  address: string;
  label: string;
  totalValue: bigint;
  timestamp: number;
}

interface APYData {
  vaultAddress: string;
  label: string;
  currentTotalValue: string;
  apy7d: number | null;
  apy30d: number | null;
  lastUpdated: number;
}

// ═══════════════════════════════════════════════════════════════
//                          CONSTANTS
// ═══════════════════════════════════════════════════════════════

const USDC_DECIMALS = 6;
const SECONDS_PER_YEAR = 365.25 * 24 * 3600;

const TREASURY_ABI = [
  "function totalValue() external view returns (uint256)",
  "function totalValueNet() external view returns (uint256)",
  "function pendingYield() external view returns (uint256 netYield, uint256 grossYield, uint256 protocolFee)",
  "function harvestYield() external returns (uint256 claimedFees)",
  "function accrueFees() external",
  "function pendingFees() external view returns (uint256)",
  "function peakRecordedValue() external view returns (uint256)",
  "function lastRecordedValue() external view returns (uint256)",
  "function lastFeeAccrual() external view returns (uint256)",
  "function getAllStrategies() external view returns (tuple(address strategy, uint256 targetBps, uint256 minBps, uint256 maxBps, bool active, bool autoAllocate)[])",
  "event YieldHarvested(uint256 netYield, uint256 protocolFee)",
  "event FeesClaimed(address indexed recipient, uint256 amount)",
];

const META_VAULT_ABI = [
  "function totalValue() external view returns (uint256)",
  "function rebalance() external",
  "function driftThresholdBps() external view returns (uint256)",
  "function lastRebalanceAt() external view returns (uint256)",
  "function rebalanceCooldown() external view returns (uint256)",
  "function paused() external view returns (bool)",
  "function getSubStrategies() external view returns (tuple(address strategy, uint256 weightBps, uint256 capUsd, bool enabled)[])",
];

const SMUSD_ABI = [
  "function totalAssets() external view returns (uint256)",
  "function totalSupply() external view returns (uint256)",
  "function convertToAssets(uint256 shares) external view returns (uint256)",
  "function unvestedYield() external view returns (uint256)",
  "function yieldVestingEnd() external view returns (uint256)",
];

const YIELD_DISTRIBUTOR_ABI = [
  "function distributeYield(uint256 yieldUsdc) external",
  "function canDistribute() external view returns (bool)",
  "function previewDistribution(uint256 yieldUsdc) external view returns (uint256 ethMusd, uint256 cantonMusd, uint256 ethShareBps, uint256 cantonShareBps)",
  "function minDistributionUsdc() external view returns (uint256)",
  "function distributionCount() external view returns (uint256)",
  "function totalDistributedEth() external view returns (uint256)",
  "function totalDistributedCanton() external view returns (uint256)",
  "event YieldDistributed(uint256 indexed epoch, uint256 yieldUsdc, uint256 musdMinted, uint256 ethMusd, uint256 cantonMusd, uint256 ethSharesBps, uint256 cantonSharesBps)",
  "event CantonYieldBridged(uint256 indexed epoch, uint256 musdAmount, string cantonRecipient)",
];

const ETH_POOL_YIELD_DISTRIBUTOR_ABI = [
  "function distributeETHPoolYield() external",
  "function previewYield() external view returns (uint256 yieldUsdc, bool canDistribute)",
  "function distributionCount() external view returns (uint256)",
  "function totalDistributed() external view returns (uint256)",
  "function lastDistributionTime() external view returns (uint256)",
  "function distributionCooldown() external view returns (uint256)",
  "function minYieldUsdc() external view returns (uint256)",
  "event ETHPoolYieldBridged(uint256 indexed epoch, uint256 yieldUsdc, uint256 musdBridged, string ethPoolRecipient)",
];

const VAULT_LABELS: Record<number, string> = {
  0: "Vault #1 — Diversified Yield",
  1: "Vault #2 — Fluid Syrup",
  2: "Vault #3 — ETH Pool",
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
        `${timestamp} [${level.toUpperCase()}] [YIELD-KEEPER] ${message}`
    )
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: "yield-harvest-keeper.log" }),
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
    throw new Error(`SECURITY: ${envVar} is not a valid secp256k1 private key.`);
  }
  return key;
}

// ═══════════════════════════════════════════════════════════════
//                      HELPERS
// ═══════════════════════════════════════════════════════════════

function formatUsdc(raw: bigint): string {
  return `$${ethers.formatUnits(raw, USDC_DECIMALS)}`;
}

/**
 * Compute annualized yield from two snapshots.
 * Returns null if insufficient data or zero elapsed time.
 */
function computeAPY(
  earlierValue: bigint,
  laterValue: bigint,
  elapsedSeconds: number
): number | null {
  if (earlierValue === 0n || elapsedSeconds < 3600) return null; // Need at least 1h of data
  if (laterValue <= earlierValue) return 0;

  const yieldRatio = Number(laterValue - earlierValue) / Number(earlierValue);
  const annualized = Math.pow(1 + yieldRatio, SECONDS_PER_YEAR / elapsedSeconds) - 1;

  // Sanity cap — >500% APY is almost certainly a data glitch
  return annualized > 5 ? null : annualized * 100;
}

// ═══════════════════════════════════════════════════════════════
//                   YIELD HARVEST KEEPER
// ═══════════════════════════════════════════════════════════════

export class YieldHarvestKeeper {
  private config: YieldKeeperConfig;
  private provider: ethers.JsonRpcProvider;
  private keeperWallet: Wallet;
  private treasury: ethers.Contract;
  private smusd: ethers.Contract;
  private yieldDistributor: ethers.Contract | null = null;
  private ethPoolYieldDistributor: ethers.Contract | null = null;
  private metaVaults: Map<string, ethers.Contract> = new Map();
  private running = false;
  private consecutiveErrors = 0;

  /** Rolling snapshots for APY calculation — per vault address */
  private snapshots: Map<string, VaultSnapshot[]> = new Map();
  /** Treasury-level snapshots */
  private treasurySnapshots: VaultSnapshot[] = [];

  /** Max consecutive errors before self-reporting unhealthy */
  private static readonly MAX_CONSECUTIVE_ERRORS = 5;
  /** Keep 30 days of snapshots max */
  private static readonly MAX_SNAPSHOT_AGE_S = 30 * 24 * 3600;
  /** Minimum snapshots for APY calculation */
  private static readonly MIN_SNAPSHOTS = 2;

  constructor(config: YieldKeeperConfig) {
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

    this.treasury = new ethers.Contract(
      config.treasuryAddress,
      TREASURY_ABI,
      this.keeperWallet
    );
    this.smusd = new ethers.Contract(
      config.smusdAddress,
      SMUSD_ABI,
      this.provider // read-only for SMUSD
    );

    // YieldDistributor — proportional yield distribution to ETH + Canton pools
    if (config.yieldDistributorAddress) {
      this.yieldDistributor = new ethers.Contract(
        config.yieldDistributorAddress,
        YIELD_DISTRIBUTOR_ABI,
        this.keeperWallet
      );
    }

    // ETH Pool YieldDistributor — MetaVault #3 yield → Canton ETH Pool
    if (config.ethPoolYieldDistributorAddress) {
      this.ethPoolYieldDistributor = new ethers.Contract(
        config.ethPoolYieldDistributorAddress,
        ETH_POOL_YIELD_DISTRIBUTOR_ABI,
        this.keeperWallet
      );
    }

    for (let i = 0; i < config.metaVaultAddresses.length; i++) {
      const addr = config.metaVaultAddresses[i];
      this.metaVaults.set(
        addr.toLowerCase(),
        new ethers.Contract(addr, META_VAULT_ABI, this.keeperWallet)
      );
    }
  }

  // ─── Public API ─────────────────────────────────────────────

  async start(): Promise<void> {
    logger.info("═══════════════════════════════════════════════════");
    logger.info("  YIELD HARVEST KEEPER — Starting");
    logger.info(`  Keeper:    ${this.keeperWallet.address}`);
    logger.info(`  Treasury:  ${this.config.treasuryAddress}`);
    logger.info(`  SMUSD:     ${this.config.smusdAddress}`);
    logger.info(`  YieldDist: ${this.config.yieldDistributorAddress || "(not configured)"}`);
    logger.info(`  ETHPoolDist: ${this.config.ethPoolYieldDistributorAddress || "(not configured)"}`);
    logger.info(`  MetaVaults: ${this.config.metaVaultAddresses.length}`);
    for (let i = 0; i < this.config.metaVaultAddresses.length; i++) {
      logger.info(`    • ${VAULT_LABELS[i] || `Vault #${i + 1}`}: ${this.config.metaVaultAddresses[i]}`);
    }
    logger.info(`  Poll interval: ${this.config.pollIntervalMs / 1000}s`);
    logger.info(`  Min harvest: ${formatUsdc(this.config.minHarvestAmount)}`);
    logger.info("═══════════════════════════════════════════════════");

    this.running = true;

    await this.sendAlert(
      "🟢 *Yield Harvest Keeper Started*\n" +
        `Monitoring ${this.config.metaVaultAddresses.length} vaults\n` +
        `Poll: ${this.config.pollIntervalMs / 1000}s | Min harvest: ${formatUsdc(this.config.minHarvestAmount)}`
    );

    while (this.running) {
      try {
        await this.runCycle();
        this.consecutiveErrors = 0;
      } catch (err) {
        this.consecutiveErrors++;
        logger.error(
          `Cycle failed (${this.consecutiveErrors}/${YieldHarvestKeeper.MAX_CONSECUTIVE_ERRORS}): ${(err as Error).message}`
        );
        if (this.consecutiveErrors >= YieldHarvestKeeper.MAX_CONSECUTIVE_ERRORS) {
          await this.sendAlert(
            `🔴 *Yield Keeper Degraded*\n${this.consecutiveErrors} consecutive failures\nLast: ${(err as Error).message}`
          );
        }
      }
      await new Promise((r) => setTimeout(r, this.config.pollIntervalMs));
    }
  }

  stop(): void {
    this.running = false;
    logger.info("Yield harvest keeper stopped.");
  }

  isHealthy(): boolean {
    return this.consecutiveErrors < YieldHarvestKeeper.MAX_CONSECUTIVE_ERRORS;
  }

  /** Return current APY data for all vaults + treasury aggregate */
  getAPYData(): APYData[] {
    const now = Date.now() / 1000;
    const results: APYData[] = [];

    // Treasury aggregate
    const tSnaps = this.treasurySnapshots;
    if (tSnaps.length >= YieldHarvestKeeper.MIN_SNAPSHOTS) {
      const latest = tSnaps[tSnaps.length - 1];
      const snap7d = this.findSnapshotAtAge(tSnaps, 7 * 24 * 3600);
      const snap30d = this.findSnapshotAtAge(tSnaps, 30 * 24 * 3600);

      results.push({
        vaultAddress: this.config.treasuryAddress,
        label: "Treasury (Aggregate)",
        currentTotalValue: ethers.formatUnits(latest.totalValue, USDC_DECIMALS),
        apy7d: snap7d ? computeAPY(snap7d.totalValue, latest.totalValue, latest.timestamp - snap7d.timestamp) : null,
        apy30d: snap30d ? computeAPY(snap30d.totalValue, latest.totalValue, latest.timestamp - snap30d.timestamp) : null,
        lastUpdated: latest.timestamp,
      });
    }

    // Per-vault APY
    for (let i = 0; i < this.config.metaVaultAddresses.length; i++) {
      const addr = this.config.metaVaultAddresses[i].toLowerCase();
      const snaps = this.snapshots.get(addr) || [];
      if (snaps.length < YieldHarvestKeeper.MIN_SNAPSHOTS) {
        results.push({
          vaultAddress: addr,
          label: VAULT_LABELS[i] || `Vault #${i + 1}`,
          currentTotalValue: "0",
          apy7d: null,
          apy30d: null,
          lastUpdated: 0,
        });
        continue;
      }

      const latest = snaps[snaps.length - 1];
      const snap7d = this.findSnapshotAtAge(snaps, 7 * 24 * 3600);
      const snap30d = this.findSnapshotAtAge(snaps, 30 * 24 * 3600);

      results.push({
        vaultAddress: addr,
        label: VAULT_LABELS[i] || `Vault #${i + 1}`,
        currentTotalValue: ethers.formatUnits(latest.totalValue, USDC_DECIMALS),
        apy7d: snap7d ? computeAPY(snap7d.totalValue, latest.totalValue, latest.timestamp - snap7d.timestamp) : null,
        apy30d: snap30d ? computeAPY(snap30d.totalValue, latest.totalValue, latest.timestamp - snap30d.timestamp) : null,
        lastUpdated: latest.timestamp,
      });
    }

    return results;
  }

  // ─── Core Loop ──────────────────────────────────────────────

  private async runCycle(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    // 1. Snapshot all vaults + treasury for APY tracking
    await this.takeSnapshots(now);

    // 2. Check for harvestable yield
    const [netYield, grossYield, protocolFee] = await this.treasury.pendingYield();

    logger.info(
      `Yield check — gross: ${formatUsdc(grossYield)} | net (80%): ${formatUsdc(netYield)} | fee (20%): ${formatUsdc(protocolFee)}`
    );

    // 3. Harvest if above minimum
    if (netYield > this.config.minHarvestAmount) {
      await this.executeHarvest(netYield, grossYield, protocolFee);

      // 3b. Distribute yield to all pools (ETH smUSD + Canton via bridge)
      if (this.yieldDistributor) {
        await this.executeDistribution(netYield);
      }
    } else if (netYield > 0n) {
      logger.debug(
        `Net yield ${formatUsdc(netYield)} below minimum ${formatUsdc(this.config.minHarvestAmount)} — skipping harvest`
      );
    }

    // 4. Check MetaVault rebalance opportunities
    await this.checkRebalances();

    // 5. ETH Pool yield distribution (independent of smUSD harvest)
    if (this.ethPoolYieldDistributor) {
      await this.executeETHPoolDistribution();
    }
  }

  private async takeSnapshots(now: number): Promise<void> {
    // Treasury aggregate
    try {
      const tv: bigint = await this.treasury.totalValue();
      this.addSnapshot(this.treasurySnapshots, {
        address: this.config.treasuryAddress,
        label: "Treasury",
        totalValue: tv,
        timestamp: now,
      });
      logger.debug(`Treasury totalValue: ${formatUsdc(tv)}`);
    } catch (err) {
      logger.warn(`Treasury snapshot failed: ${(err as Error).message}`);
    }

    // Per-vault
    for (let i = 0; i < this.config.metaVaultAddresses.length; i++) {
      const addr = this.config.metaVaultAddresses[i].toLowerCase();
      const contract = this.metaVaults.get(addr);
      if (!contract) continue;

      try {
        const tv: bigint = await contract.totalValue();
        const snaps = this.snapshots.get(addr) || [];
        this.addSnapshot(snaps, {
          address: addr,
          label: VAULT_LABELS[i] || `Vault #${i + 1}`,
          totalValue: tv,
          timestamp: now,
        });
        this.snapshots.set(addr, snaps);
        logger.debug(`${VAULT_LABELS[i]}: ${formatUsdc(tv)}`);
      } catch (err) {
        logger.warn(`${VAULT_LABELS[i] || addr.slice(0, 10)} snapshot failed: ${(err as Error).message}`);
      }
    }
  }

  private addSnapshot(arr: VaultSnapshot[], snap: VaultSnapshot): void {
    arr.push(snap);
    // Prune old snapshots
    const cutoff = snap.timestamp - YieldHarvestKeeper.MAX_SNAPSHOT_AGE_S;
    while (arr.length > 0 && arr[0].timestamp < cutoff) {
      arr.shift();
    }
  }

  private findSnapshotAtAge(snaps: VaultSnapshot[], ageSeconds: number): VaultSnapshot | null {
    if (snaps.length < 2) return null;
    const target = snaps[snaps.length - 1].timestamp - ageSeconds;
    // Find closest snapshot to target time
    let closest: VaultSnapshot | null = null;
    let closestDiff = Infinity;
    for (const s of snaps) {
      const diff = Math.abs(s.timestamp - target);
      if (diff < closestDiff) {
        closestDiff = diff;
        closest = s;
      }
    }
    // Only use if within 20% of target age
    if (closest && closestDiff < ageSeconds * 0.2) return closest;
    return null;
  }

  // ─── Harvest ────────────────────────────────────────────────

  private async executeHarvest(
    netYield: bigint,
    grossYield: bigint,
    protocolFee: bigint
  ): Promise<void> {
    logger.info(
      `📊 Harvesting — gross: ${formatUsdc(grossYield)} | net (auto-compounds): ${formatUsdc(netYield)} | claiming fee: ${formatUsdc(protocolFee)}`
    );

    try {
      const tx = await this.treasury.harvestYield();
      const receipt = await tx.wait();

      // Parse events to get actual claimed fees
      let claimedFees = 0n;
      for (const log of receipt.logs) {
        try {
          const parsed = this.treasury.interface.parseLog(log);
          if (parsed && parsed.name === "FeesClaimed") {
            claimedFees = parsed.args[1]; // amount
          }
        } catch {
          // Not our event
        }
      }

      // Read post-harvest state
      let smUSDInfo = "";
      try {
        const totalAssets: bigint = await this.smusd.totalAssets();
        const totalSupply: bigint = await this.smusd.totalSupply();
        if (totalSupply > 0n) {
          const sharePrice = await this.smusd.convertToAssets(ethers.parseEther("1"));
          smUSDInfo = `\nsmUSD share price: ${ethers.formatEther(sharePrice)}`;
        }
      } catch {
        /* smUSD read optional */
      }

      logger.info(
        `✅ Harvest complete — fees claimed: ${formatUsdc(claimedFees)} | net yield compounds in strategies | tx: ${receipt.hash} | gas: ${receipt.gasUsed}`
      );

      await this.sendAlert(
        `✅ *Yield Harvested*\n` +
          `Gross yield: ${formatUsdc(grossYield)}\n` +
          `Net yield (80% auto-compounds): ${formatUsdc(netYield)}\n` +
          `Protocol fees claimed (20%): ${formatUsdc(claimedFees)}\n` +
          `Gas: ${receipt.gasUsed.toString()}${smUSDInfo}\n` +
          `Tx: \`${receipt.hash}\``
      );
    } catch (err) {
      const errMsg = (err as Error).message;
      logger.error(`❌ Harvest FAILED: ${errMsg}`);

      await this.sendAlert(
        `🔴 *Harvest FAILED*\n` +
          `Gross yield: ${formatUsdc(grossYield)}\n` +
          `Error: ${errMsg.slice(0, 300)}\n` +
          `⚠️ Manual intervention may be needed.`
      );
    }
  }

  // ─── MetaVault Rebalance ────────────────────────────────────

  /**
   * Distribute net yield to all pools (ETH smUSD stakers + Canton via bridge).
   *
   * Called after TreasuryV2.harvestYield() succeeds. The net yield (80% after
   * protocol fee) is distributed proportionally by share weight:
   *   - ETH portion → SMUSD.distributeYield() (12h linear vesting)
   *   - Canton portion → BLEBridge.bridgeToCanton() (relay credits Canton)
   */
  private async executeDistribution(netYield: bigint): Promise<void> {
    if (!this.yieldDistributor) return;

    try {
      // Check cooldown
      const canDistribute: boolean = await this.yieldDistributor.canDistribute();
      if (!canDistribute) {
        logger.debug("YieldDistributor cooldown active — skipping distribution");
        return;
      }

      // Check minimum
      const minDistribution: bigint = await this.yieldDistributor.minDistributionUsdc();
      if (netYield < minDistribution) {
        logger.debug(
          `Net yield ${formatUsdc(netYield)} below distributor minimum ${formatUsdc(minDistribution)} — skipping`
        );
        return;
      }

      // Preview the split
      const [ethMusd, cantonMusd, ethBps, cantonBps] =
        await this.yieldDistributor.previewDistribution(netYield);

      logger.info(
        `📤 Distributing ${formatUsdc(netYield)} yield → ` +
        `ETH: ${ethers.formatEther(ethMusd)} mUSD (${ethBps}bps) | ` +
        `Canton: ${ethers.formatEther(cantonMusd)} mUSD (${cantonBps}bps)`
      );

      // Execute distribution
      const tx = await this.yieldDistributor.distributeYield(netYield);
      const receipt = await tx.wait();

      // Parse events
      let distributedEthMusd = 0n;
      let distributedCantonMusd = 0n;
      for (const log of receipt.logs) {
        try {
          const parsed = this.yieldDistributor!.interface.parseLog(log);
          if (parsed?.name === "YieldDistributed") {
            distributedEthMusd = parsed.args.ethMusd;
            distributedCantonMusd = parsed.args.cantonMusd;
          }
        } catch {
          /* Not our event */
        }
      }

      logger.info(
        `✅ Yield distributed — ` +
        `ETH: ${ethers.formatEther(distributedEthMusd)} mUSD (12h vesting) | ` +
        `Canton: ${ethers.formatEther(distributedCantonMusd)} mUSD (bridged) | ` +
        `tx: ${receipt.hash}`
      );

      await this.sendAlert(
        `📤 *Yield Distributed*\n` +
        `Input: ${formatUsdc(netYield)} USDC\n` +
        `ETH pool: ${ethers.formatEther(distributedEthMusd)} mUSD (12h vesting)\n` +
        `Canton pool: ${ethers.formatEther(distributedCantonMusd)} mUSD (bridged)\n` +
        `Tx: \`${receipt.hash}\``
      );
    } catch (err) {
      const errMsg = (err as Error).message;
      logger.error(`❌ Yield distribution FAILED: ${errMsg}`);

      await this.sendAlert(
        `🔴 *Yield Distribution FAILED*\n` +
        `Net yield: ${formatUsdc(netYield)}\n` +
        `Error: ${errMsg.slice(0, 300)}\n` +
        `⚠️ Harvest succeeded but distribution failed — yield stays in Treasury reserve.`
      );
    }
  }

  // ─── ETH Pool Yield Distribution ────────────────────────────

  /**
   * Distribute MetaVault #3 yield to Canton ETH Pool via mUSD bridge.
   *
   * Independent of smUSD harvest — this reads MetaVault #3's totalValue()
   * delta and bridges the yield as mUSD to Canton, where the relay exercises
   * ETHPool_ReceiveYield to increment pooledUsdc.
   */
  private async executeETHPoolDistribution(): Promise<void> {
    if (!this.ethPoolYieldDistributor) return;

    try {
      // MEDIUM-01: Check HWM desync and alert
      try {
        const [desynced, currentValue, hwm]: [boolean, bigint, bigint] =
          await this.ethPoolYieldDistributor.checkHwmDesync();
        if (desynced) {
          const deficit = hwm - currentValue;
          logger.warn(
            `⚠️ ETH Pool HWM DESYNC: strategy value ${formatUsdc(currentValue)} < HWM ${formatUsdc(hwm)} ` +
            `(deficit: ${formatUsdc(deficit)}). Yield distribution blocked. Call syncHighWaterMark() to resolve.`
          );
          await this.sendAlert(
            `⚠️ *ETH Pool HWM Desync Detected*\n` +
            `Strategy value: ${formatUsdc(currentValue)} USDC\n` +
            `High-water mark: ${formatUsdc(hwm)} USDC\n` +
            `Deficit: ${formatUsdc(deficit)} USDC\n` +
            `Action: Call \`syncHighWaterMark()\` if this is due to manual withdrawal/rebalance.`
          );
          return;
        }
      } catch (hwmErr) {
        logger.debug(`HWM desync check failed (non-critical): ${(hwmErr as Error).message}`);
      }

      // Preview yield
      const [yieldUsdc, canDistribute]: [bigint, boolean] =
        await this.ethPoolYieldDistributor.previewYield();

      if (!canDistribute) {
        if (yieldUsdc > 0n) {
          // HIGH-01: Try to observe yield to start maturity timer
          try {
            await this.ethPoolYieldDistributor.observeYield();
            logger.debug(
              `ETH Pool yield: ${formatUsdc(yieldUsdc)} observed — waiting for maturity`
            );
          } catch {
            logger.debug(
              `ETH Pool yield: ${formatUsdc(yieldUsdc)} available but not distributable (cooldown, maturity, or below minimum)`
            );
          }
        }
        return;
      }

      logger.info(
        `🏊 ETH Pool yield: ${formatUsdc(yieldUsdc)} USDC from MetaVault #3 — distributing to Canton ETH Pool`
      );

      // LOW-02: Gas estimation before sending tx
      try {
        await this.ethPoolYieldDistributor.distributeETHPoolYield.estimateGas();
      } catch (gasErr) {
        logger.warn(`ETH Pool distribution gas estimation failed — skipping: ${(gasErr as Error).message}`);
        return;
      }

      const tx = await this.ethPoolYieldDistributor.distributeETHPoolYield();
      const receipt = await tx.wait();

      // Parse ETHPoolYieldBridged event
      let bridgedMusd = 0n;
      let epoch = 0n;
      for (const log of receipt.logs) {
        try {
          const parsed = this.ethPoolYieldDistributor!.interface.parseLog(log);
          if (parsed?.name === "ETHPoolYieldBridged") {
            epoch = parsed.args.epoch;
            bridgedMusd = parsed.args.musdBridged;
          }
        } catch {
          /* Not our event */
        }
      }

      logger.info(
        `✅ ETH Pool yield bridged — epoch: ${epoch} | ` +
        `yield: ${formatUsdc(yieldUsdc)} USDC | ` +
        `bridged: ${ethers.formatEther(bridgedMusd)} mUSD | ` +
        `tx: ${receipt.hash}`
      );

      await this.sendAlert(
        `🏊 *ETH Pool Yield Bridged*\n` +
        `Epoch: ${epoch}\n` +
        `Yield: ${formatUsdc(yieldUsdc)} USDC\n` +
        `Bridged: ${ethers.formatEther(bridgedMusd)} mUSD → Canton ETH Pool\n` +
        `Tx: \`${receipt.hash}\``
      );
    } catch (err) {
      const errMsg = (err as Error).message;
      logger.error(`❌ ETH Pool yield distribution FAILED: ${errMsg}`);

      await this.sendAlert(
        `🔴 *ETH Pool Yield Distribution FAILED*\n` +
        `Error: ${errMsg.slice(0, 300)}\n` +
        `⚠️ MetaVault #3 yield was not bridged to Canton ETH Pool.`
      );
    }
  }

  private async checkRebalances(): Promise<void> {
    for (let i = 0; i < this.config.metaVaultAddresses.length; i++) {
      const addr = this.config.metaVaultAddresses[i].toLowerCase();
      const contract = this.metaVaults.get(addr);
      if (!contract) continue;

      try {
        const [paused, lastRebalance, cooldown] = await Promise.all([
          contract.paused() as Promise<boolean>,
          contract.lastRebalanceAt() as Promise<bigint>,
          contract.rebalanceCooldown() as Promise<bigint>,
        ]);

        if (paused) {
          logger.debug(`${VAULT_LABELS[i]} paused — skip rebalance`);
          continue;
        }

        const now = BigInt(Math.floor(Date.now() / 1000));
        if (now < lastRebalance + cooldown) {
          logger.debug(`${VAULT_LABELS[i]} cooldown active — skip rebalance`);
          continue;
        }

        // Attempt rebalance — will revert with DriftBelowThreshold if not needed
        try {
          const tx = await contract.rebalance();
          const receipt = await tx.wait();
          logger.info(
            `🔄 ${VAULT_LABELS[i]} rebalanced — tx: ${receipt.hash} | gas: ${receipt.gasUsed}`
          );
          await this.sendAlert(
            `🔄 *MetaVault Rebalanced*\n` +
              `${VAULT_LABELS[i]}\n` +
              `Gas: ${receipt.gasUsed.toString()}\n` +
              `Tx: \`${receipt.hash}\``
          );
        } catch (err) {
          const msg = (err as Error).message;
          // DriftBelowThreshold is expected — means rebalance not needed
          if (msg.includes("DriftBelowThreshold") || msg.includes("0x")) {
            logger.debug(`${VAULT_LABELS[i]} drift below threshold — no rebalance needed`);
          } else {
            logger.warn(`${VAULT_LABELS[i]} rebalance failed: ${msg.slice(0, 200)}`);
          }
        }
      } catch (err) {
        logger.warn(`${VAULT_LABELS[i]} check failed: ${(err as Error).message}`);
      }
    }
  }

  // ─── Telegram Alerts ────────────────────────────────────────

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
      logger.debug("Telegram alert sent");
    } catch (err) {
      logger.warn(`Telegram alert failed: ${(err as Error).message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//                 HTTP SERVER (Health + APY)
// ═══════════════════════════════════════════════════════════════

function startYieldKeeperServer(
  port: number,
  keeper: YieldHarvestKeeper
): { stop: () => void } {
  const server = http.createServer((req, res) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET",
      "Content-Type": "application/json",
    };

    if (req.url === "/health" && req.method === "GET") {
      const healthy = keeper.isHealthy();
      res.writeHead(healthy ? 200 : 503, corsHeaders);
      res.end(JSON.stringify({ status: healthy ? "ok" : "unhealthy", timestamp: Date.now() }));
    } else if (req.url === "/apy" && req.method === "GET") {
      const data = keeper.getAPYData();
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify({ vaults: data, timestamp: Date.now() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, () => {
    logger.info(`Health+APY server listening on port ${port}`);
  });

  return { stop: () => server.close() };
}

// ═══════════════════════════════════════════════════════════════
//                        ENTRYPOINT
// ═══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const keeperKey = readAndValidatePrivateKey("keeper_private_key", "KEEPER_PRIVATE_KEY");
  if (!keeperKey) {
    console.error("FATAL: KEEPER_PRIVATE_KEY is required");
    process.exit(1);
  }

  const treasuryAddr = process.env.TREASURY_ADDRESS;
  if (!treasuryAddr || !ethers.isAddress(treasuryAddr)) {
    console.error("FATAL: TREASURY_ADDRESS is required and must be a valid address");
    process.exit(1);
  }

  const smusdAddr = process.env.SMUSD_ADDRESS;
  if (!smusdAddr || !ethers.isAddress(smusdAddr)) {
    console.error("FATAL: SMUSD_ADDRESS is required and must be a valid address");
    process.exit(1);
  }

  const vaultsEnv = process.env.META_VAULT_ADDRESSES || "";
  const metaVaultAddresses = vaultsEnv.split(",").map((s) => s.trim()).filter(Boolean);
  if (metaVaultAddresses.length === 0) {
    console.error("FATAL: META_VAULT_ADDRESSES is required (comma-separated)");
    process.exit(1);
  }
  for (const addr of metaVaultAddresses) {
    if (!ethers.isAddress(addr)) {
      console.error(`FATAL: Invalid MetaVault address: ${addr}`);
      process.exit(1);
    }
  }

  const rpcUrl = process.env.RPC_URL || "";
  if (!rpcUrl) {
    console.error("FATAL: RPC_URL is required");
    process.exit(1);
  }
  if (
    process.env.NODE_ENV === "production" &&
    !rpcUrl.startsWith("https://") &&
    !rpcUrl.startsWith("wss://")
  ) {
    throw new Error("Insecure RPC transport in production. RPC_URL must use https:// or wss://");
  }

  // YieldDistributor (optional — keeper works without it but won't distribute)
  const yieldDistAddr = process.env.YIELD_DISTRIBUTOR_ADDRESS || "";
  if (yieldDistAddr && !ethers.isAddress(yieldDistAddr)) {
    console.error("FATAL: YIELD_DISTRIBUTOR_ADDRESS must be a valid address");
    process.exit(1);
  }

  // ETH Pool YieldDistributor (optional — bridges MetaVault #3 yield to Canton ETH Pool)
  const ethPoolDistAddr = process.env.ETH_POOL_YIELD_DISTRIBUTOR_ADDRESS || "";
  if (ethPoolDistAddr && !ethers.isAddress(ethPoolDistAddr)) {
    console.error("FATAL: ETH_POOL_YIELD_DISTRIBUTOR_ADDRESS must be a valid address");
    process.exit(1);
  }

  // Min harvest: default 50 USDC
  const minHarvestRaw = process.env.MIN_HARVEST_USD
    ? BigInt(process.env.MIN_HARVEST_USD) * 10n ** BigInt(USDC_DECIMALS)
    : 50n * 10n ** BigInt(USDC_DECIMALS);

  const config: YieldKeeperConfig = {
    rpcUrl,
    chainId: parseInt(process.env.CHAIN_ID || "1", 10),
    keeperPrivateKey: keeperKey,
    treasuryAddress: treasuryAddr,
    smusdAddress: smusdAddr,
    yieldDistributorAddress: yieldDistAddr,
    ethPoolYieldDistributorAddress: ethPoolDistAddr,
    metaVaultAddresses,
    pollIntervalMs: parseInt(process.env.YIELD_POLL_MS || "300000", 10), // 5 min default
    minHarvestAmount: minHarvestRaw,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
    httpPort: Number(process.env.BOT_PORT) || 8082,
  };

  if (config.pollIntervalMs < 30_000) {
    throw new Error("YIELD_POLL_MS must be >= 30000ms (30s)");
  }

  const keeper = new YieldHarvestKeeper(config);

  // Start HTTP server (health + APY endpoint)
  const httpServer = startYieldKeeperServer(config.httpPort, keeper);

  // Graceful shutdown
  const shutdown = () => {
    keeper.stop();
    httpServer.stop();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await keeper.start();
}

// Only run main when executed directly
if (require.main === module) {
  main().catch((err) => {
    console.error("Yield harvest keeper crashed:", err);
    process.exit(1);
  });
}
