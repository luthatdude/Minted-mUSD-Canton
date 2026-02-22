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
Object.defineProperty(exports, "__esModule", { value: true });
exports.LendingKeeperBot = void 0;
const canton_client_1 = require("./canton-client");
const utils_1 = require("./utils");
const price_oracle_1 = require("./price-oracle");
// INFRA-H-06: Ensure TLS certificate validation is enforced at process level
(0, utils_1.enforceTLSSecurity)();
const DEFAULT_CONFIG = {
    cantonHost: process.env.CANTON_HOST || "localhost",
    cantonPort: parseInt(process.env.CANTON_PORT || "6865", 10),
    cantonToken: (0, utils_1.readSecret)("canton_token", "CANTON_TOKEN"),
    cantonParty: process.env.CANTON_PARTY || "",
    keeperParty: process.env.KEEPER_PARTY || "",
    tradecraftBaseUrl: process.env.TRADECRAFT_URL || "https://api.tradecraft.fi/v1",
    // INFRA-H-06: Validated below — requireHTTPS(tradecraftBaseUrl)
    pollIntervalMs: parseInt(process.env.KEEPER_POLL_MS || "15000", 10), // 15s
    // TS-H-01: Use Number() + validation instead of parseFloat for financial values
    // parseFloat silently accepts garbage like "5.0abc" → 5.0, risking misconfiguration
    minProfitUsd: (() => {
        const v = Number(process.env.MIN_PROFIT_USD || "5.0");
        if (Number.isNaN(v) || v < 0)
            throw new Error("MIN_PROFIT_USD must be a non-negative number");
        return v;
    })(),
    maxSlippagePct: (() => {
        const v = Number(process.env.MAX_SLIPPAGE_PCT || "3.0");
        if (Number.isNaN(v) || v < 0 || v > 100)
            throw new Error("MAX_SLIPPAGE_PCT must be 0-100");
        return v;
    })(),
    maxConcurrentLiquidations: parseInt(process.env.MAX_CONCURRENT_LIQ || "3", 10),
    cooldownBetweenLiqMs: parseInt(process.env.LIQ_COOLDOWN_MS || "5000", 10),
    collateralConfigs: {
        "CTN_Coin": { ltvBps: 6500, liqThresholdBps: 7500, penaltyBps: 1000, bonusBps: 500 },
        "CTN_SMUSD": { ltvBps: 9000, liqThresholdBps: 9300, penaltyBps: 400, bonusBps: 200 },
    },
    // Read sMUSD price from env (production: synced from yield-sync-service)
    // TS-H-01: Strict numeric validation
    smusdPrice: (() => {
        const v = Number(process.env.SMUSD_PRICE || "1.05");
        if (Number.isNaN(v) || v <= 0)
            throw new Error("SMUSD_PRICE must be a positive number");
        return v;
    })(),
};
// INFRA-H-06: Enforce HTTPS for external API endpoints in production
(0, utils_1.requireHTTPS)(DEFAULT_CONFIG.tradecraftBaseUrl, "TRADECRAFT_URL");
// ============================================================
//                     TYPES
// ============================================================
// Fixed-point precision constants for BigInt-based financial math
// All USD/token values scaled to 18 decimals to avoid floating-point precision loss
const PRECISION = BigInt(10) ** BigInt(18);
const BPS_BASE = BigInt(10000);
const YEAR_SECONDS = BigInt(31536000);
/** Convert a number or ledger string to fixed-point BigInt (18 decimals).
 *  TS-H-01/M-01: Strings are parsed directly to BigInt — no parseFloat intermediate.
 *  This avoids IEEE 754 precision loss on values with 18+ significant digits.
 *  For number inputs (config values, small constants), falls back to
 *  string conversion via toFixed(18). */
function toFixed(value) {
    const str = typeof value === "string" ? value : value.toFixed(18);
    const negative = str.startsWith("-");
    const abs = negative ? str.slice(1) : str;
    const parts = abs.split(".");
    const whole = BigInt(parts[0] || "0");
    const fracStr = (parts[1] || "").padEnd(18, "0").slice(0, 18);
    const frac = BigInt(fracStr);
    const result = whole * PRECISION + frac;
    return negative ? -result : result;
}
/** Convert fixed-point BigInt back to number (for display/logging only) */
function fromFixed(value) {
    const whole = value / PRECISION;
    const frac = value % PRECISION;
    return Number(whole) + Number(frac) / Number(PRECISION);
}
// ============================================================
//                     KEEPER BOT
// ============================================================
class LendingKeeperBot {
    config;
    canton = null;
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
        if (this.canton)
            return;
        // Default to TLS for Canton ledger connections (consistent with relay-service.ts)
        const protocol = process.env.CANTON_USE_TLS === "false" ? "http" : "https";
        this.canton = new canton_client_1.CantonClient({
            baseUrl: `${protocol}://${this.config.cantonHost}:${this.config.cantonPort}`,
            token: this.config.cantonToken,
            userId: "administrator",
            actAs: this.config.cantonParty,
            timeoutMs: 30000,
        });
        console.log(`[Keeper] Connected to Canton ledger`);
    }
    /**
     * Fetch all active debt positions from ledger
     */
    async fetchDebtPositions() {
        if (!this.canton)
            throw new Error("Ledger not connected");
        const contracts = await this.canton.queryContracts((0, canton_client_1.parseTemplateId)("CantonLending:CantonDebtPosition"));
        return contracts.map((c) => ({
            contractId: c.contractId,
            borrower: c.payload.borrower,
            // TS-H-01/M-01: Preserve raw ledger strings to avoid IEEE 754 precision loss on
            // financial values with 18+ significant digits. Use toFixed() for BigInt math.
            principalDebt: String(c.payload.principalDebt),
            accruedInterest: String(c.payload.accruedInterest),
            lastAccrualTime: c.payload.lastAccrualTime,
            interestRateBps: parseInt(c.payload.interestRateBps, 10),
        }));
    }
    /**
     * Fetch all escrowed collateral for a specific borrower
     */
    async fetchEscrowPositions(borrower) {
        if (!this.canton)
            throw new Error("Ledger not connected");
        const contracts = await this.canton.queryContracts((0, canton_client_1.parseTemplateId)("CantonLending:EscrowedCollateral"), (p) => p.owner === borrower);
        return contracts.map((c) => ({
            contractId: c.contractId,
            owner: c.payload.owner,
            collateralType: c.payload.collateralType,
            // TS-H-01/M-01: Preserve raw ledger string to avoid IEEE 754 precision loss
            amount: String(c.payload.amount),
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
            case "CTN_SMUSD":
                return this.config.smusdPrice; // Configurable via SMUSD_PRICE env var
            default:
                throw new Error(`Unknown collateral type: ${collateralType}`);
        }
    }
    /**
     * Calculate health factor for a borrower:
     * healthFactor = Σ(collateral × price × liqThreshold) / totalDebt
     * If < 1.0, position is liquidatable
     *
     * Uses BigInt fixed-point (18 decimals) to avoid float precision loss
     * on positions > $10M where 64-bit float loses sub-cent accuracy.
     */
    calculateHealthFactor(escrows, totalDebt) {
        if (totalDebt <= 0)
            return 999.0;
        const debtBig = toFixed(totalDebt);
        let totalLiqValue = BigInt(0);
        for (const escrow of escrows) {
            const price = this.getPrice(escrow.collateralType);
            const cfg = this.config.collateralConfigs[escrow.collateralType];
            if (!cfg)
                continue;
            const amountBig = toFixed(escrow.amount);
            const priceBig = toFixed(price);
            const thresholdBps = BigInt(cfg.liqThresholdBps);
            // amount * price * threshold / 10000, all in fixed-point
            totalLiqValue +=
                (amountBig * priceBig / PRECISION) * thresholdBps / BPS_BASE;
        }
        // healthFactor = totalLiqValue / totalDebt (both in fixed-point)
        return fromFixed((totalLiqValue * PRECISION) / debtBig);
    }
    /**
     * Calculate total debt including projected interest since last accrual
     *
     * Uses BigInt fixed-point to prevent precision loss on large debts
     */
    calculateTotalDebt(position) {
        const now = Date.now() / 1000;
        const lastAccrual = new Date(position.lastAccrualTime).getTime() / 1000;
        const elapsed = Math.max(0, now - lastAccrual);
        const principalBig = toFixed(position.principalDebt);
        const accruedBig = toFixed(position.accruedInterest);
        const rateBps = BigInt(position.interestRateBps);
        const elapsedBig = BigInt(Math.floor(elapsed));
        // newInterest = principal * rateBps * elapsed / (10000 * yearSeconds)
        const newInterest = principalBig * rateBps * elapsedBig / (BPS_BASE * YEAR_SECONDS);
        return fromFixed(principalBig + accruedBig + newInterest);
    }
    /**
     * Find the most profitable collateral to seize for a given position.
     * Prefers CTN (highest penalty = highest keeper bonus).
     *
     * Uses BigInt fixed-point for seize/bonus calculations
     */
    selectBestTarget(escrows, maxRepayUsd) {
        let bestEscrow = null;
        let bestProfit = BigInt(0);
        const maxRepayBig = toFixed(maxRepayUsd);
        for (const escrow of escrows) {
            const cfg = this.config.collateralConfigs[escrow.collateralType];
            if (!cfg)
                continue;
            const price = this.getPrice(escrow.collateralType);
            const priceBig = toFixed(price);
            const amountBig = toFixed(escrow.amount);
            const penaltyBps = BigInt(cfg.penaltyBps);
            const bonusBps = BigInt(cfg.bonusBps);
            const collateralValueUsd = amountBig * priceBig / PRECISION;
            // How much debt can we repay against this collateral?
            const seizeValueUsd = maxRepayBig * (BPS_BASE + penaltyBps) / BPS_BASE;
            const actualSeizeUsd = seizeValueUsd < collateralValueUsd ? seizeValueUsd : collateralValueUsd;
            // Keeper bonus from penalty
            const actualRepay = actualSeizeUsd * BPS_BASE / (BPS_BASE + penaltyBps);
            const penaltyUsd = actualSeizeUsd - actualRepay;
            const keeperBonusUsd = penaltyBps > BigInt(0)
                ? penaltyUsd * bonusBps / penaltyBps
                : BigInt(0);
            if (keeperBonusUsd > bestProfit) {
                bestProfit = keeperBonusUsd;
                bestEscrow = escrow;
            }
        }
        if (!bestEscrow)
            return null;
        return { escrow: bestEscrow, expectedProfit: fromFixed(bestProfit) };
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
        if (!this.canton)
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
            const keeperMusd = await this.canton.queryContracts((0, canton_client_1.parseTemplateId)("CantonDirectMint:CantonMUSD"), (p) => p.owner === this.config.keeperParty);
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
            // TS-H-01/M-01: Use BigInt comparison to avoid precision loss on large amounts
            const maxRepayBig = toFixed(candidate.maxRepay);
            const musdContract = keeperMusd.find((c) => toFixed(String(c.payload.amount)) >= maxRepayBig);
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
            // Re-fetch ALL contract IDs immediately before exercise to avoid stale CIDs
            // Force fresh price fetch before execution
            try {
                await this.oracle.fetchCTNPrice();
            }
            catch (err) {
                console.warn(`[Keeper] Could not refresh price before liquidation:`, err.message);
            }
            // Re-fetch debt position (may have been repaid since scan)
            const freshDebtPositions = await this.canton.queryContracts((0, canton_client_1.parseTemplateId)("CantonLending:CantonDebtPosition"), (p) => p.borrower === candidate.borrower);
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
            const priceFeeds = await this.canton.queryContracts((0, canton_client_1.parseTemplateId)("CantonLending:CantonPriceFeed"));
            // Find the lending service contract
            const services = await this.canton.queryContracts((0, canton_client_1.parseTemplateId)("CantonLending:CantonLendingService"));
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
            await this.canton.exerciseChoice((0, canton_client_1.parseTemplateId)("CantonLending:CantonLendingService"), serviceContract.contractId, "Lending_Liquidate", {
                liquidator: this.config.keeperParty,
                borrower: candidate.borrower,
                repayAmount: candidate.maxRepay.toFixed(18),
                targetEscrowCid: freshTarget.contractId, // Fresh CID
                debtCid: freshDebtCid, // Fresh CID
                musdCid: musdContract.contractId,
                escrowCids: freshEscrows.map((e) => e.contractId), // Fresh CIDs
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