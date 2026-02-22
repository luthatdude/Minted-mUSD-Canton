/**
 * Minted Protocol - Yield Keeper Service
 *
 * Monitors Treasury for idle USDC and triggers auto-deployment to yield strategies.
 *
 * Flow:
 *   1. Poll Treasury.shouldAutoDeploy() periodically
 *   2. When deployable amount > threshold, call keeperTriggerAutoDeploy()
 *   3. Log deployments and emit metrics
 *
 * Can run as a standalone service or integrated into the relay service.
 */
interface KeeperConfig {
    ethereumRpcUrl: string;
    treasuryAddress: string;
    keeperPrivateKey: string;
    pollIntervalMs: number;
    maxGasPriceGwei: number;
    minProfitUsd: number;
}
declare const DEFAULT_CONFIG: KeeperConfig;
declare class YieldKeeper {
    private provider;
    private wallet;
    private walletAddress;
    private treasury;
    private config;
    private running;
    private metricsServer;
    constructor(config: KeeperConfig);
    /** Initialise the KMS-backed (or fallback) signer */
    init(): Promise<void>;
    /**
     * Start the keeper loop
     */
    start(): Promise<void>;
    /**
     * Stop the keeper
     */
    stop(): void;
    /**
     * Verify setup is correct
     */
    private verifySetup;
    /**
     * Main keeper logic: check if deploy needed and execute
     */
    private checkAndDeploy;
    /**
     * Format USDC amount for display (6 decimals → human readable)
     * TS-M-04: Use ethers.formatUnits to avoid precision loss on large amounts
     */
    private formatUsdc;
    /**
     * Sleep helper
     */
    private sleep;
}
/**
 * Get current Treasury/Keeper status (for monitoring dashboards)
 */
export declare function getKeeperStatus(config: KeeperConfig): Promise<{
    autoDeployEnabled: boolean;
    defaultStrategy: string;
    threshold: string;
    deployable: string;
    availableReserves: string;
    deployedToStrategies: string;
    shouldDeploy: boolean;
}>;
export { YieldKeeper, DEFAULT_CONFIG };
//# sourceMappingURL=yield-keeper.d.ts.map