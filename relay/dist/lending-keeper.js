"use strict";
/**
 * Minted Protocol - Canton Lending Keeper Bot
 *
 * Monitors CantonDebtPositions for undercollateralized users and executes
 * liquidations via the CantonLendingService on Canton ledger.
 *
 * Flow:
 *   1. Poll all active CantonDebtPositions from Canton ledger
 *   2. For each, fetch escrowed collateral + price feeds → compute health factor
 *   3. If health factor < 1.0, check Tradecraft pool depth for slippage
 *   4. Execute Lending_Liquidate choice with keeper's mUSD
 *   5. Sell seized collateral on Tradecraft for profit
 *
 * Revenue:
 *   Keeper earns liquidation bonus (e.g. 5% of CTN penalty, 1.5% for stables)
 *   defined in CollateralConfig.liquidationBonusBps
 *
 * Safety:
 *   - Checks pool depth before liquidation to avoid excessive slippage
 *   - Maximum liquidation size capped by closeFactorBps (50%)
 *   - Won't liquidate if expected profit < gas cost threshold
 *   - Rate-limits liquidation calls to prevent ledger spam
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LendingKeeperBot = void 0;
const ledger_1 = __importDefault(require("@daml/ledger"));
const utils_1 = require("./utils");
const price_oracle_1 = require("./price-oracle");
const DEFAULT_CONFIG = {
    cantonHost: process.env.CANTON_HOST || "localhost",
    cantonPort: parseInt(process.env.CANTON_PORT || "6865", 10),
    cantonToken: (0, utils_1.readSecret)("canton_token", "CANTON_TOKEN"),
    cantonParty: process.env.CANTON_PARTY || "",
    keeperParty: process.env.KEEPER_PARTY || "",
    tradecraftBaseUrl: process.env.TRADECRAFT_URL || "https://api.tradecraft.fi/v1",
    pollIntervalMs: parseInt(process.env.KEEPER_POLL_MS || "15000", 10), // 15s
    minProfitUsd: parseFloat(process.env.MIN_PROFIT_USD || "5.0"),
    maxSlippagePct: parseFloat(process.env.MAX_SLIPPAGE_PCT || "3.0"),
    maxConcurrentLiquidations: parseInt(process.env.MAX_CONCURRENT_LIQ || "3", 10),
    cooldownBetweenLiqMs: parseInt(process.env.LIQ_COOLDOWN_MS || "5000", 10),
    collateralConfigs: {
        "CTN_Coin": { ltvBps: 6500, liqThresholdBps: 7500, penaltyBps: 1000, bonusBps: 500 },
        "CTN_USDC": { ltvBps: 9500, liqThresholdBps: 9700, penaltyBps: 300, bonusBps: 150 },
        "CTN_USDCx": { ltvBps: 9500, liqThresholdBps: 9700, penaltyBps: 300, bonusBps: 150 },
        "CTN_SMUSD": { ltvBps: 9000, liqThresholdBps: 9300, penaltyBps: 400, bonusBps: 200 },
    },
    // FIX LK-03: Read sMUSD price from env (production: synced from yield-sync-service)
    smusdPrice: parseFloat(process.env.SMUSD_PRICE || "1.05"),
};
// ============================================================
//                     KEEPER BOT
// ============================================================
class LendingKeeperBot {
    config;
    ledger = null;
    oracle;
    running = false;
    lastLiquidationTime = 0;
    stats = {
        totalScans: 0,
        totalLiquidations: 0,
        totalProfit: 0,
        failedLiquidations: 0,
        lastScan: null,
        activeCandidates: 0,
    };
    constructor(oracle, config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.oracle = oracle;
    }
    /**
     * Connect to Canton ledger
     */
    async connectLedger() {
        if (this.ledger)
            return;
        // FIX M-7: Default to TLS for Canton ledger connections (consistent with relay-service.ts)
        const protocol = process.env.CANTON_USE_TLS === "false" ? "http" : "https";
        const wsProtocol = process.env.CANTON_USE_TLS === "false" ? "ws" : "wss";
        this.ledger = new ledger_1.default({
            token: this.config.cantonToken,
            httpBaseUrl: `${protocol}://${this.config.cantonHost}:${this.config.cantonPort}`,
            wsBaseUrl: `${wsProtocol}://${this.config.cantonHost}:${this.config.cantonPort}`,
        });
        console.log(`[Keeper] Connected to Canton ledger`);
    }
    /**
     * Fetch all active debt positions from ledger
     */
    async fetchDebtPositions() {
        if (!this.ledger)
            throw new Error("Ledger not connected");
        const contracts = await this.ledger.query("CantonLending:CantonDebtPosition", {});
        return contracts.map((c) => ({
            contractId: c.contractId,
            borrower: c.payload.borrower,
            principalDebt: parseFloat(c.payload.principalDebt),
            accruedInterest: parseFloat(c.payload.accruedInterest),
            lastAccrualTime: c.payload.lastAccrualTime,
            interestRateBps: parseInt(c.payload.interestRateBps, 10),
        }));
    }
    /**
     * Fetch all escrowed collateral for a specific borrower
     */
    async fetchEscrowPositions(borrower) {
        if (!this.ledger)
            throw new Error("Ledger not connected");
        const contracts = await this.ledger.query("CantonLending:EscrowedCollateral", { owner: borrower });
        return contracts.map((c) => ({
            contractId: c.contractId,
            owner: c.payload.owner,
            collateralType: c.payload.collateralType,
            amount: parseFloat(c.payload.amount),
        }));
    }
    /**
     * Get the current price for a collateral type.
     * Uses the oracle's last known prices.
     */
    getPrice(collateralType) {
        switch (collateralType) {
            case "CTN_Coin":
                return this.oracle.getLastCTNPrice();
            case "CTN_USDC":
            case "CTN_USDCx":
                return 1.0; // Stablecoins hardcoded
            case "CTN_SMUSD":
                return this.config.smusdPrice; // FIX LK-03: Configurable via SMUSD_PRICE env var
            default:
                throw new Error(`Unknown collateral type: ${collateralType}`);
        }
    }
    /**
     * Calculate health factor for a borrower:
     * healthFactor = Σ(collateral × price × liqThreshold) / totalDebt
     * If < 1.0, position is liquidatable
     */
    calculateHealthFactor(escrows, totalDebt) {
        if (totalDebt <= 0)
            return 999.0;
        let totalLiqValue = 0;
        for (const escrow of escrows) {
            const price = this.getPrice(escrow.collateralType);
            const cfg = this.config.collateralConfigs[escrow.collateralType];
            if (!cfg)
                continue;
            totalLiqValue += escrow.amount * price * cfg.liqThresholdBps / 10000;
        }
        return totalLiqValue / totalDebt;
    }
    /**
     * Calculate total debt including projected interest since last accrual
     */
    calculateTotalDebt(position) {
        const now = Date.now() / 1000;
        const lastAccrual = new Date(position.lastAccrualTime).getTime() / 1000;
        const elapsed = Math.max(0, now - lastAccrual);
        const yearSeconds = 31536000;
        const newInterest = position.principalDebt * position.interestRateBps * elapsed / (10000 * yearSeconds);
        return position.principalDebt + position.accruedInterest + newInterest;
    }
    /**
     * Find the most profitable collateral to seize for a given position.
     * Prefers CTN (highest penalty = highest keeper bonus).
     */
    selectBestTarget(escrows, maxRepayUsd) {
        let bestEscrow = null;
        let bestProfit = 0;
        for (const escrow of escrows) {
            const cfg = this.config.collateralConfigs[escrow.collateralType];
            if (!cfg)
                continue;
            const price = this.getPrice(escrow.collateralType);
            const collateralValueUsd = escrow.amount * price;
            // How much debt can we repay against this collateral?
            const seizeValueUsd = maxRepayUsd * (10000 + cfg.penaltyBps) / 10000;
            const actualSeizeUsd = Math.min(seizeValueUsd, collateralValueUsd);
            // Keeper bonus from penalty
            const actualRepay = actualSeizeUsd * 10000 / (10000 + cfg.penaltyBps);
            const penaltyUsd = actualSeizeUsd - actualRepay;
            const keeperBonusUsd = penaltyUsd * cfg.bonusBps / cfg.penaltyBps;
            if (keeperBonusUsd > bestProfit) {
                bestProfit = keeperBonusUsd;
                bestEscrow = escrow;
            }
        }
        if (!bestEscrow)
            return null;
        return { escrow: bestEscrow, expectedProfit: bestProfit };
    }
    /**
     * Check if Tradecraft has enough liquidity to absorb the seized collateral
     * without excessive slippage (only relevant for CTN)
     */
    async checkSlippage(collateralType, seizeAmount) {
        // Stablecoins don't need slippage check
        if (collateralType !== "CTN_Coin") {
            return { acceptable: true, slippagePct: 0 };
        }
        try {
            const oracleConfig = {
                tradecraftBaseUrl: this.config.tradecraftBaseUrl,
            };
            // Get quote for selling seized CC
            const quote = await (0, price_oracle_1.fetchTradecraftQuote)(oracleConfig, seizeAmount);
            // Get spot price for comparison
            const spotPrice = this.oracle.getLastCTNPrice();
            const expectedUsd = seizeAmount * spotPrice;
            if (expectedUsd <= 0) {
                return { acceptable: false, slippagePct: 100 };
            }
            const slippagePct = ((expectedUsd - quote.userGets) / expectedUsd) * 100;
            console.log(`[Keeper] Slippage check: selling ${seizeAmount.toFixed(2)} CC → ` +
                `expected $${expectedUsd.toFixed(2)}, quoted $${quote.userGets.toFixed(2)} ` +
                `(${slippagePct.toFixed(2)}% slippage)`);
            return {
                acceptable: slippagePct <= this.config.maxSlippagePct,
                slippagePct,
            };
        }
        catch (err) {
            console.warn(`[Keeper] Slippage check failed:`, err.message);
            // Proceed cautiously — if we can't check, use smaller amount
            return { acceptable: seizeAmount < 10000, slippagePct: -1 };
        }
    }
    /**
     * Scan all positions and identify liquidation candidates
     */
    async scanPositions() {
        await this.connectLedger();
        const debtPositions = await this.fetchDebtPositions();
        const candidates = [];
        for (const position of debtPositions) {
            const totalDebt = this.calculateTotalDebt(position);
            if (totalDebt <= 0)
                continue;
            const escrows = await this.fetchEscrowPositions(position.borrower);
            if (escrows.length === 0)
                continue;
            const healthFactor = this.calculateHealthFactor(escrows, totalDebt);
            if (healthFactor < 1.0) {
                // Position is liquidatable
                const maxRepay = totalDebt * 0.5; // 50% close factor
                const target = this.selectBestTarget(escrows, maxRepay);
                if (!target)
                    continue;
                // Only proceed if profit exceeds minimum
                if (target.expectedProfit >= this.config.minProfitUsd) {
                    candidates.push({
                        borrower: position.borrower,
                        totalDebt,
                        healthFactor,
                        escrows,
                        debtPosition: position,
                        bestTarget: target.escrow,
                        expectedProfit: target.expectedProfit,
                        maxRepay,
                    });
                }
            }
        }
        // Sort by profit (highest first)
        candidates.sort((a, b) => b.expectedProfit - a.expectedProfit);
        return candidates;
    }
    /**
     * Execute a liquidation on the Canton ledger
     */
    async executeLiquidation(candidate) {
        if (!this.ledger)
            throw new Error("Ledger not connected");
        const timestamp = new Date();
        try {
            // Rate limit
            const timeSinceLastLiq = Date.now() - this.lastLiquidationTime;
            if (timeSinceLastLiq < this.config.cooldownBetweenLiqMs) {
                const waitMs = this.config.cooldownBetweenLiqMs - timeSinceLastLiq;
                console.log(`[Keeper] Rate limiting: waiting ${waitMs}ms`);
                await new Promise((resolve) => setTimeout(resolve, waitMs));
            }
            // Check slippage for the target collateral
            const cfg = this.config.collateralConfigs[candidate.bestTarget.collateralType];
            const price = this.getPrice(candidate.bestTarget.collateralType);
            const seizeValueUsd = candidate.maxRepay * (10000 + (cfg?.penaltyBps || 0)) / 10000;
            const seizeAmount = seizeValueUsd / price;
            const slippage = await this.checkSlippage(candidate.bestTarget.collateralType, seizeAmount);
            if (!slippage.acceptable) {
                return {
                    borrower: candidate.borrower,
                    debtRepaid: 0,
                    collateralSeized: 0,
                    collateralType: candidate.bestTarget.collateralType,
                    keeperBonus: 0,
                    success: false,
                    error: `Slippage too high: ${slippage.slippagePct.toFixed(2)}% > ${this.config.maxSlippagePct}%`,
                    timestamp,
                };
            }
            // Fetch keeper's mUSD balance to use for repayment
            const keeperMusd = await this.ledger.query("CantonDirectMint:CantonMUSD", { owner: this.config.keeperParty });
            if (keeperMusd.length === 0) {
                return {
                    borrower: candidate.borrower,
                    debtRepaid: 0,
                    collateralSeized: 0,
                    collateralType: candidate.bestTarget.collateralType,
                    keeperBonus: 0,
                    success: false,
                    error: "Keeper has no mUSD for repayment",
                    timestamp,
                };
            }
            // Find an mUSD contract with enough balance
            const musdContract = keeperMusd.find((c) => parseFloat(c.payload.amount) >= candidate.maxRepay);
            if (!musdContract) {
                return {
                    borrower: candidate.borrower,
                    debtRepaid: 0,
                    collateralSeized: 0,
                    collateralType: candidate.bestTarget.collateralType,
                    keeperBonus: 0,
                    success: false,
                    error: `Keeper mUSD insufficient for repay amount ${candidate.maxRepay.toFixed(2)}`,
                    timestamp,
                };
            }
            // FIX LK-01: Re-fetch ALL contract IDs immediately before exercise to avoid stale CIDs
            // FIX LK-02: Force fresh price fetch before execution
            try {
                await this.oracle.fetchCTNPrice();
            }
            catch (err) {
                console.warn(`[Keeper] Could not refresh price before liquidation:`, err.message);
            }
            // Re-fetch debt position (may have been repaid since scan)
            const freshDebtPositions = await this.ledger.query("CantonLending:CantonDebtPosition", { borrower: candidate.borrower });
            if (freshDebtPositions.length === 0) {
                return {
                    borrower: candidate.borrower, debtRepaid: 0, collateralSeized: 0,
                    collateralType: candidate.bestTarget.collateralType, keeperBonus: 0,
                    success: false, error: "Debt position no longer exists (already repaid/liquidated)",
                    timestamp,
                };
            }
            const freshDebtCid = freshDebtPositions[0].contractId;
            // Re-fetch target escrow (may have been withdrawn)
            const freshEscrows = await this.fetchEscrowPositions(candidate.borrower);
            const freshTarget = freshEscrows.find((e) => e.collateralType === candidate.bestTarget.collateralType);
            if (!freshTarget) {
                return {
                    borrower: candidate.borrower, debtRepaid: 0, collateralSeized: 0,
                    collateralType: candidate.bestTarget.collateralType, keeperBonus: 0,
                    success: false, error: "Target escrow no longer exists",
                    timestamp,
                };
            }
            // Collect all price feed contract IDs
            const priceFeeds = await this.ledger.query("CantonLending:CantonPriceFeed", {});
            // Find the lending service contract
            const services = await this.ledger.query("CantonLending:CantonLendingService", {});
            if (services.length === 0) {
                throw new Error("CantonLendingService not found on ledger");
            }
            const serviceContract = services[0];
            // Exercise Lending_Liquidate
            console.log(`[Keeper] 🔥 Liquidating ${candidate.borrower}: ` +
                `debt=$${candidate.totalDebt.toFixed(2)}, ` +
                `HF=${candidate.healthFactor.toFixed(4)}, ` +
                `target=${candidate.bestTarget.collateralType}, ` +
                `repay=$${candidate.maxRepay.toFixed(2)}`);
            await this.ledger.exercise("CantonLending:CantonLendingService", serviceContract.contractId, "Lending_Liquidate", {
                liquidator: this.config.keeperParty,
                borrower: candidate.borrower,
                repayAmount: candidate.maxRepay.toFixed(18),
                targetEscrowCid: freshTarget.contractId, // FIX LK-01: Fresh CID
                debtCid: freshDebtCid, // FIX LK-01: Fresh CID
                musdCid: musdContract.contractId,
                escrowCids: freshEscrows.map((e) => e.contractId), // FIX LK-01: Fresh CIDs
                priceFeedCids: priceFeeds.map((f) => f.contractId),
            });
            this.lastLiquidationTime = Date.now();
            const result = {
                borrower: candidate.borrower,
                debtRepaid: candidate.maxRepay,
                collateralSeized: seizeAmount,
                collateralType: candidate.bestTarget.collateralType,
                keeperBonus: candidate.expectedProfit,
                success: true,
                timestamp,
            };
            console.log(`[Keeper] ✅ Liquidation successful: ` +
                `seized ${seizeAmount.toFixed(4)} ${candidate.bestTarget.collateralType}, ` +
                `bonus ~$${candidate.expectedProfit.toFixed(2)}`);
            this.stats.totalLiquidations++;
            this.stats.totalProfit += candidate.expectedProfit;
            return result;
        }
        catch (err) {
            this.stats.failedLiquidations++;
            const result = {
                borrower: candidate.borrower,
                debtRepaid: 0,
                collateralSeized: 0,
                collateralType: candidate.bestTarget.collateralType,
                keeperBonus: 0,
                success: false,
                error: err.message,
                timestamp,
            };
            console.error(`[Keeper] ❌ Liquidation failed for ${candidate.borrower}:`, err.message);
            return result;
        }
    }
    /**
     * Main keeper loop
     */
    async start() {
        console.log("[Keeper] Starting Canton Lending Keeper Bot...");
        console.log(`[Keeper] Operator: ${this.config.cantonParty}`);
        console.log(`[Keeper] Keeper party: ${this.config.keeperParty}`);
        console.log(`[Keeper] Poll interval: ${this.config.pollIntervalMs}ms`);
        console.log(`[Keeper] Min profit: $${this.config.minProfitUsd}`);
        console.log(`[Keeper] Max slippage: ${this.config.maxSlippagePct}%`);
        await this.connectLedger();
        this.running = true;
        while (this.running) {
            try {
                this.stats.totalScans++;
                this.stats.lastScan = new Date();
                const candidates = await this.scanPositions();
                this.stats.activeCandidates = candidates.length;
                if (candidates.length > 0) {
                    console.log(`[Keeper] Found ${candidates.length} liquidation candidate(s)`);
                    // Execute up to maxConcurrentLiquidations
                    const batch = candidates.slice(0, this.config.maxConcurrentLiquidations);
                    for (const candidate of batch) {
                        await this.executeLiquidation(candidate);
                    }
                }
            }
            catch (err) {
                console.error("[Keeper] Scan cycle failed:", err.message);
            }
            await new Promise((resolve) => setTimeout(resolve, this.config.pollIntervalMs));
        }
        console.log("[Keeper] Stopped.");
    }
    /**
     * Stop the keeper gracefully
     */
    stop() {
        this.running = false;
        console.log("[Keeper] Stop requested.");
    }
    /**
     * Get keeper statistics (for monitoring)
     */
    getStats() {
        return { ...this.stats };
    }
}
exports.LendingKeeperBot = LendingKeeperBot;
// ============================================================
//                     MAIN ENTRY POINT
// ============================================================
async function main() {
    console.log("═══════════════════════════════════════════════════");
    console.log("  Minted Protocol — Canton Lending Keeper Bot");
    console.log("  Monitors health factors, executes liquidations");
    console.log("═══════════════════════════════════════════════════");
    // Start oracle first (keeper needs prices)
    const oracle = new price_oracle_1.PriceOracleService();
    // Start keeper
    const keeper = new LendingKeeperBot(oracle);
    // Graceful shutdown
    const shutdown = () => {
        console.log("\n[Main] Shutting down...");
        keeper.stop();
        oracle.stop();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    // Run both in parallel
    await Promise.all([
        oracle.start(),
        // Delay keeper start by 5s to let oracle get first price
        new Promise((resolve) => setTimeout(async () => {
            await keeper.start();
            resolve();
        }, 5000)),
    ]);
}
main().catch((err) => {
    console.error("[Main] Fatal error:", err);
    process.exit(1);
});
//# sourceMappingURL=lending-keeper.js.map