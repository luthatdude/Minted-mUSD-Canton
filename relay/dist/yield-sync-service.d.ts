/**
 * Minted Protocol - Yield Sync Service (Unified Cross-Chain)
 *
 * Synchronizes GLOBAL SHARE PRICE between Ethereum and Canton for equal yield distribution.
 * All smUSD holders on both chains receive the same yield rate.
 *
 * Architecture:
 *   - Canton MMF ($50B) acts as collateral reference for minting capacity
 *   - Ethereum TreasuryV2 generates yield via Pendle/Morpho/Sky strategies
 *   - This service ensures UNIFIED share price across both chains
 *
 * Unified Share Price Model:
 *   globalSharePrice = TreasuryV2.totalValue() / (ethShares + cantonShares)
 *
 * Bidirectional Sync Flow:
 *   1. Read Canton totalShares → sync to Ethereum SMUSD.syncCantonShares()
 *   2. Read Ethereum SMUSD.globalSharePrice() (includes Treasury yield)
 *   3. Sync global share price to Canton via SyncGlobalSharePrice
 *   4. Both chains now have identical share price → equal yield for all stakers
 */
interface YieldSyncConfig {
    ethereumRpcUrl: string;
    treasuryAddress: string;
    smusdAddress: string;
    metaVault3Address: string;
    bridgePrivateKey: string;
    kmsKeyId: string;
    cantonHost: string;
    cantonPort: number;
    cantonToken: string;
    cantonParty: string;
    validatorParties: string[];
    syncIntervalMs: number;
    minYieldThreshold: string;
    epochStartNumber: number;
}
declare class YieldSyncService {
    private config;
    private provider;
    private wallet;
    private treasury;
    private smusd;
    private metaVault3;
    private canton;
    private isRunning;
    private lastSyncedTotalValue;
    private lastGlobalSharePrice;
    private lastETHPoolSharePrice;
    private currentEpoch;
    private nonce;
    constructor(config: YieldSyncConfig);
    /**
     * Start the yield sync service
     */
    start(): Promise<void>;
    /**
     * Stop the service
     */
    stop(): void;
    /**
     * Initialize state from both chains
     */
    private initializeState;
    /**
     * UNIFIED sync logic - bidirectional share price synchronization
     */
    private syncUnifiedYield;
    /**
     * Sync ETH Pool share price from Ethereum MetaVault #3 to Canton.
     *
     * Share price derivation:
     *   Canton ETH Pool tracks `pooledUsdc` (deposits + received yield counter)
     *   and `totalShares` (boosted shares issued to stakers).
     *   The real value sits in MetaVault #3 on Ethereum.
     *
     *   sharePrice = MetaVault3.totalValue() / cantonTotalShares
     *
     * This sync updates the informational `sharePrice` field on Canton
     * so frontends can display accurate yield without querying Ethereum.
     */
    private syncETHPoolSharePrice;
    private toNumeric18;
    private parseNumeric18;
    private formatUsdc;
    private sleep;
}
export { YieldSyncService, YieldSyncConfig };
//# sourceMappingURL=yield-sync-service.d.ts.map