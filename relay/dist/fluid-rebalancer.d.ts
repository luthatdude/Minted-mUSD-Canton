/**
 * Minted Protocol — Fluid Strategy Auto-Rebalancer Keeper
 *
 * Monitors FluidLoopStrategy health factors and triggers rebalancing
 * to maintain target LTV on Fluid smart collateral/debt vaults.
 *
 * Actions:
 *   1. Poll getHealthFactor() on each registered FluidLoopStrategy
 *   2. Call rebalance() when LTV drifts outside targetLtvBps +/- safetyBufferBps
 *   3. Call emergencyDeleverage() if health factor drops below critical threshold
 *   4. Optionally claim and compound Merkl rewards
 *   5. Send Telegram alerts on rebalance, emergency, and error events
 *
 * Designed for the ETH Pool Fluid T2/T4 vaults:
 *   - T2 (LRT): weETH-ETH smart collateral / wstETH debt — 92% LTV, 4 loops
 *   - T4 (LST): wstETH-ETH smart collateral / wstETH-ETH smart debt — 94% LTV, 5 loops
 */
interface StrategyConfig {
    address: string;
    name: string;
    vaultMode: number;
}
interface RebalancerConfig {
    ethereumRpcUrl: string;
    strategies: StrategyConfig[];
    keeperPrivateKey: string;
    pollIntervalMs: number;
    maxGasPriceGwei: number;
    rebalanceTriggerHf: bigint;
    emergencyHf: bigint;
    telegramBotToken: string;
    telegramChatId: string;
}
declare function loadConfig(): RebalancerConfig;
declare class FluidRebalancer {
    private provider;
    private wallet;
    private walletAddress;
    private config;
    private running;
    private consecutiveErrors;
    constructor(config: RebalancerConfig);
    init(): Promise<void>;
    start(): Promise<void>;
    stop(): void;
    private monitorAndRebalance;
    private getSnapshot;
    private logSnapshot;
    private executeRebalance;
    private executeEmergencyDeleverage;
    private sendAlert;
    private sleep;
}
export interface StrategyStatus {
    address: string;
    name: string;
    healthFactor: string;
    leverageX100: string;
    collateral: string;
    borrowed: string;
    netValue: string;
    targetLtvBps: string;
    sharePrice: string;
    trusted: boolean;
    isActive: boolean;
    hasPosition: boolean;
    status: "healthy" | "warning" | "critical" | "inactive";
}
export declare function getRebalancerStatus(config: RebalancerConfig): Promise<StrategyStatus[]>;
export { FluidRebalancer, loadConfig };
//# sourceMappingURL=fluid-rebalancer.d.ts.map