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
import { PriceOracleService } from "./price-oracle";
interface KeeperBotConfig {
    cantonHost: string;
    cantonPort: number;
    cantonToken: string;
    cantonParty: string;
    keeperParty: string;
    tradecraftBaseUrl: string;
    pollIntervalMs: number;
    minProfitUsd: number;
    maxSlippagePct: number;
    maxConcurrentLiquidations: number;
    cooldownBetweenLiqMs: number;
    collateralConfigs: Record<string, {
        ltvBps: number;
        liqThresholdBps: number;
        penaltyBps: number;
        bonusBps: number;
    }>;
    smusdPrice: number;
}
interface DebtPosition {
    contractId: string;
    borrower: string;
    principalDebt: string;
    accruedInterest: string;
    lastAccrualTime: string;
    interestRateBps: number;
}
interface EscrowPosition {
    contractId: string;
    owner: string;
    collateralType: string;
    amount: string;
}
interface LiquidationCandidate {
    borrower: string;
    totalDebt: number;
    healthFactor: number;
    escrows: EscrowPosition[];
    debtPosition: DebtPosition;
    bestTarget: EscrowPosition;
    expectedProfit: number;
    maxRepay: number;
}
interface KeeperStats {
    totalScans: number;
    totalLiquidations: number;
    totalProfit: number;
    failedLiquidations: number;
    lastScan: Date | null;
    activeCandidates: number;
}
export declare class LendingKeeperBot {
    private config;
    private canton;
    private oracle;
    private running;
    private lastLiquidationTime;
    private stats;
    constructor(oracle: PriceOracleService, config?: Partial<KeeperBotConfig>);
    /**
     * Connect to Canton ledger
     */
    private connectLedger;
    /**
     * Fetch all active debt positions from ledger
     */
    private fetchDebtPositions;
    /**
     * Fetch all escrowed collateral for a specific borrower
     */
    private fetchEscrowPositions;
    /**
     * Get the current price for a collateral type.
     * Uses the oracle's last known prices.
     */
    private getPrice;
    /**
     * Calculate health factor for a borrower:
     * healthFactor = Σ(collateral × price × liqThreshold) / totalDebt
     * If < 1.0, position is liquidatable
     *
     * Uses BigInt fixed-point (18 decimals) to avoid float precision loss
     * on positions > $10M where 64-bit float loses sub-cent accuracy.
     */
    private calculateHealthFactor;
    /**
     * Calculate total debt including projected interest since last accrual
     *
     * Uses BigInt fixed-point to prevent precision loss on large debts
     */
    private calculateTotalDebt;
    /**
     * Find the most profitable collateral to seize for a given position.
     * Prefers CTN (highest penalty = highest keeper bonus).
     *
     * Uses BigInt fixed-point for seize/bonus calculations
     */
    private selectBestTarget;
    /**
     * Check if Tradecraft has enough liquidity to absorb the seized collateral
     * without excessive slippage (only relevant for CTN)
     */
    private checkSlippage;
    /**
     * Scan all positions and identify liquidation candidates
     */
    scanPositions(): Promise<LiquidationCandidate[]>;
    /**
     * Execute a liquidation on the Canton ledger
     */
    private executeLiquidation;
    /**
     * Main keeper loop
     */
    start(): Promise<void>;
    /**
     * Stop the keeper gracefully
     */
    stop(): void;
    /**
     * Get keeper statistics (for monitoring)
     */
    getStats(): KeeperStats;
}
export {};
//# sourceMappingURL=lending-keeper.d.ts.map