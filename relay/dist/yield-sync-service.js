"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.YieldSyncService = void 0;
const ethers_1 = require("ethers");
const canton_client_1 = require("./canton-client");
const utils_1 = require("./utils");
// INFRA-H-06: Ensure TLS certificate validation is enforced at process level
(0, utils_1.enforceTLSSecurity)();
const DEFAULT_CONFIG = {
    // INFRA-H-01 / INFRA-H-03: Read RPC URL from Docker secret (contains API keys), fallback to env var
    ethereumRpcUrl: (() => {
        const url = (0, utils_1.readSecret)("ethereum_rpc_url", "ETHEREUM_RPC_URL");
        if (!url)
            throw new Error("ETHEREUM_RPC_URL is required");
        if (!url.startsWith("https://") && process.env.NODE_ENV !== "development") {
            throw new Error("ETHEREUM_RPC_URL must use HTTPS in production");
        }
        return url;
    })(),
    treasuryAddress: process.env.TREASURY_ADDRESS || "",
    smusdAddress: process.env.SMUSD_ADDRESS || "",
    metaVault3Address: process.env.META_VAULT3_ADDRESS || "", // Fluid T2/T4 strategy
    bridgePrivateKey: (0, utils_1.readSecret)("bridge_private_key", "BRIDGE_PRIVATE_KEY"),
    kmsKeyId: process.env.KMS_KEY_ID || "",
    cantonHost: process.env.CANTON_HOST || "localhost",
    cantonPort: parseInt(process.env.CANTON_PORT || "6865", 10),
    cantonToken: (0, utils_1.readSecret)("canton_token", "CANTON_TOKEN"),
    cantonParty: process.env.CANTON_PARTY || "",
    validatorParties: (process.env.VALIDATOR_PARTIES || "").split(",").filter(Boolean),
    syncIntervalMs: parseInt(process.env.YIELD_SYNC_INTERVAL_MS || "3600000", 10), // 1 hour
    minYieldThreshold: process.env.MIN_YIELD_THRESHOLD || "1000000000", // $1000 (6 decimals)
    epochStartNumber: parseInt(process.env.EPOCH_START || "1", 10),
};
// ============================================================
//                     CONTRACT ABIs
// ============================================================
const TREASURY_ABI = [
    {
        "inputs": [],
        "name": "totalValue",
        "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "lastRecordedValue",
        "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "availableReserves",
        "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "deployedToStrategies",
        "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    },
];
const SMUSD_ABI = [
    {
        "inputs": [],
        "name": "globalSharePrice",
        "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "globalTotalShares",
        "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "globalTotalAssets",
        "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "ethereumTotalShares",
        "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "cantonTotalShares",
        "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "lastCantonSyncEpoch",
        "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            { "internalType": "uint256", "name": "_cantonShares", "type": "uint256" },
            { "internalType": "uint256", "name": "epoch", "type": "uint256" }
        ],
        "name": "syncCantonShares",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
];
// MetaVault #3 (Fluid) ABI — for ETH Pool share price derivation
const METAVAULT_ABI = [
    {
        "inputs": [],
        "name": "totalValue",
        "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    },
];
// ============================================================
//                     YIELD SYNC SERVICE (UNIFIED)
// ============================================================
class YieldSyncService {
    config;
    provider;
    wallet;
    treasury;
    smusd;
    metaVault3 = null; // MetaVault #3 (Fluid) for ETH Pool
    canton;
    isRunning = false;
    // State tracking
    lastSyncedTotalValue = BigInt(0);
    lastGlobalSharePrice = BigInt(0);
    lastETHPoolSharePrice = BigInt(0); // MetaVault #3 derived share price
    currentEpoch;
    nonce = 1;
    constructor(config) {
        this.config = config;
        this.currentEpoch = config.epochStartNumber;
        // TS-C-01: Only validate raw private key when KMS is NOT configured
        if (!config.kmsKeyId) {
            const keyBytes = Buffer.from(config.bridgePrivateKey.replace(/^0x/, ""), "hex");
            if (keyBytes.length !== 32) {
                throw new Error(`[YieldSync] Invalid bridge private key: expected 32 bytes, got ${keyBytes.length}`);
            }
            // Validate it's a valid secp256k1 scalar (0 < key < curve order)
            const SECP256K1_ORDER = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
            const keyBigInt = BigInt("0x" + keyBytes.toString("hex"));
            if (keyBigInt === BigInt(0) || keyBigInt >= SECP256K1_ORDER) {
                throw new Error("[YieldSync] Invalid bridge private key: not a valid secp256k1 scalar");
            }
        }
        // Ethereum connection with signing capability
        this.provider = new ethers_1.ethers.JsonRpcProvider(config.ethereumRpcUrl);
        // Wallet initialised asynchronously via init() — use KMS when available
        this.treasury = new ethers_1.ethers.Contract(config.treasuryAddress, TREASURY_ABI, this.provider);
        this.smusd = new ethers_1.ethers.Contract(config.smusdAddress, SMUSD_ABI, this.provider // Upgraded to signing wallet in init()
        );
        // MetaVault #3 (Fluid) — for ETH Pool share price derivation
        if (config.metaVault3Address) {
            this.metaVault3 = new ethers_1.ethers.Contract(config.metaVault3Address, METAVAULT_ABI, this.provider);
        }
        // Canton connection (TLS by default)
        const protocol = process.env.CANTON_USE_TLS === "false" ? "http" : "https";
        this.canton = new canton_client_1.CantonClient({
            baseUrl: `${protocol}://${config.cantonHost}:${config.cantonPort}`,
            token: config.cantonToken,
            userId: "administrator",
            actAs: config.cantonParty,
            timeoutMs: 30000,
        });
        console.log("[YieldSync] Initialized (UNIFIED CROSS-CHAIN MODE)");
        console.log(`[YieldSync] Treasury: ${config.treasuryAddress}`);
        console.log(`[YieldSync] SMUSD: ${config.smusdAddress}`);
        console.log(`[YieldSync] MetaVault #3: ${config.metaVault3Address || "(not configured)"}`);
        console.log(`[YieldSync] Bridge wallet: (deferred until start)`);
        console.log(`[YieldSync] Canton: ${config.cantonHost}:${config.cantonPort}`);
        console.log(`[YieldSync] Operator: ${config.cantonParty}`);
        console.log(`[YieldSync] Sync interval: ${config.syncIntervalMs}ms`);
    }
    /**
     * Start the yield sync service
     */
    async start() {
        // Initialise KMS-backed (or fallback) signer
        this.wallet = await (0, utils_1.createSigner)(this.provider, "bridge_private_key", "BRIDGE_PRIVATE_KEY");
        // Re-bind smusd with signing capability
        this.smusd = new ethers_1.ethers.Contract(this.config.smusdAddress, SMUSD_ABI, this.wallet);
        const walletAddress = await this.wallet.getAddress();
        console.log(`[YieldSync] Bridge wallet: ${walletAddress}`);
        console.log("[YieldSync] Starting UNIFIED yield sync...");
        this.isRunning = true;
        // Initialize last synced value
        await this.initializeState();
        // Main sync loop
        while (this.isRunning) {
            try {
                await this.syncUnifiedYield();
            }
            catch (err) {
                console.error("[YieldSync] Error in smUSD sync cycle:", err);
            }
            // ETH Pool share price sync (parallel product — MetaVault #3 / Fluid)
            if (this.metaVault3) {
                try {
                    await this.syncETHPoolSharePrice();
                }
                catch (err) {
                    console.error("[YieldSync] Error in ETH Pool sync cycle:", err);
                }
            }
            await this.sleep(this.config.syncIntervalMs);
        }
    }
    /**
     * Stop the service
     */
    stop() {
        console.log("[YieldSync] Stopping...");
        this.isRunning = false;
    }
    /**
     * Initialize state from both chains
     */
    async initializeState() {
        console.log("[YieldSync] Initializing unified state...");
        // Get current values from Ethereum
        const currentTotalValue = await this.treasury.totalValue();
        this.lastSyncedTotalValue = BigInt(currentTotalValue.toString());
        const currentSharePrice = await this.smusd.globalSharePrice();
        this.lastGlobalSharePrice = BigInt(currentSharePrice.toString());
        // Get last epoch from Canton staking service
        const stakingServices = await this.canton.queryContracts((0, canton_client_1.parseTemplateId)("CantonSMUSD:CantonStakingService"), (p) => p.operator === this.config.cantonParty);
        if (stakingServices.length > 0) {
            this.currentEpoch = parseInt(stakingServices[0].payload.lastSyncEpoch || "0", 10) + 1;
            console.log(`[YieldSync] Resuming from epoch ${this.currentEpoch}`);
            console.log(`[YieldSync] Canton totalShares: ${stakingServices[0].payload.totalShares}`);
            console.log(`[YieldSync] Canton globalSharePrice: ${stakingServices[0].payload.globalSharePrice}`);
        }
        else {
            console.log(`[YieldSync] No staking service found, starting fresh at epoch ${this.currentEpoch}`);
        }
        console.log(`[YieldSync] Ethereum Treasury value: $${this.formatUsdc(currentTotalValue)}`);
        console.log(`[YieldSync] Ethereum globalSharePrice: ${currentSharePrice}`);
    }
    /**
     * UNIFIED sync logic - bidirectional share price synchronization
     */
    async syncUnifiedYield() {
        console.log(`\n[YieldSync] ═══════════════════════════════════════════`);
        console.log(`[YieldSync] EPOCH ${this.currentEpoch} - UNIFIED YIELD SYNC`);
        console.log(`[YieldSync] ═══════════════════════════════════════════`);
        // ═══════════════════════════════════════════════════════════════════
        // STEP 1: Read Canton shares and sync to Ethereum
        // ═══════════════════════════════════════════════════════════════════
        console.log(`\n[YieldSync] Step 1: Syncing Canton shares → Ethereum...`);
        const stakingServices = await this.canton.queryContracts((0, canton_client_1.parseTemplateId)("CantonSMUSD:CantonStakingService"), (p) => p.operator === this.config.cantonParty);
        if (stakingServices.length === 0) {
            console.log(`[YieldSync] No Canton staking service found, skipping`);
            return;
        }
        const cantonService = stakingServices[0];
        const cantonShares = this.parseNumeric18(cantonService.payload.totalShares);
        console.log(`[YieldSync] Canton totalShares: ${cantonShares}`);
        // Sync Canton shares to Ethereum SMUSD
        const lastEthEpoch = await this.smusd.lastCantonSyncEpoch();
        if (this.currentEpoch > Number(lastEthEpoch)) {
            console.log(`[YieldSync] Calling SMUSD.syncCantonShares(${cantonShares}, ${this.currentEpoch})...`);
            const tx = await this.smusd.syncCantonShares(cantonShares, this.currentEpoch);
            await tx.wait();
            console.log(`[YieldSync] ✅ Canton shares synced to Ethereum (tx: ${tx.hash})`);
        }
        else {
            console.log(`[YieldSync] Ethereum already synced for epoch ${this.currentEpoch}`);
        }
        // ═══════════════════════════════════════════════════════════════════
        // STEP 2: Read global share price from Ethereum (now includes Canton shares)
        // ═══════════════════════════════════════════════════════════════════
        console.log(`\n[YieldSync] Step 2: Reading global share price from Ethereum...`);
        const globalSharePrice = BigInt((await this.smusd.globalSharePrice()).toString());
        const globalTotalAssets = BigInt((await this.smusd.globalTotalAssets()).toString());
        const globalTotalShares = BigInt((await this.smusd.globalTotalShares()).toString());
        const ethShares = BigInt((await this.smusd.ethereumTotalShares()).toString());
        console.log(`[YieldSync] globalTotalAssets: $${this.formatUsdc(globalTotalAssets)}`);
        console.log(`[YieldSync] globalTotalShares: ${globalTotalShares} (ETH: ${ethShares}, Canton: ${cantonShares})`);
        console.log(`[YieldSync] globalSharePrice: ${globalSharePrice}`);
        // Check if share price increased (yield generated)
        if (globalSharePrice <= this.lastGlobalSharePrice) {
            console.log(`[YieldSync] No yield increase detected, skipping Canton sync`);
            return;
        }
        const sharePriceIncrease = globalSharePrice - this.lastGlobalSharePrice;
        console.log(`[YieldSync] Share price increase: ${sharePriceIncrease}`);
        // ═══════════════════════════════════════════════════════════════════
        // STEP 3: Sync global share price to Canton
        // ═══════════════════════════════════════════════════════════════════
        console.log(`\n[YieldSync] Step 3: Syncing global share price → Canton...`);
        await this.canton.exerciseChoice((0, canton_client_1.parseTemplateId)("CantonSMUSD:CantonStakingService"), cantonService.contractId, "SyncGlobalSharePrice", {
            newGlobalSharePrice: this.toNumeric18(globalSharePrice),
            newGlobalTotalAssets: this.toNumeric18(globalTotalAssets),
            newGlobalTotalShares: this.toNumeric18(globalTotalShares),
            epochNumber: this.currentEpoch.toString(),
        });
        console.log(`[YieldSync] ✅ Global share price synced to Canton!`);
        // ═══════════════════════════════════════════════════════════════════
        // STEP 4: Update state and log summary
        // ═══════════════════════════════════════════════════════════════════
        this.lastSyncedTotalValue = globalTotalAssets;
        this.lastGlobalSharePrice = globalSharePrice;
        this.currentEpoch++;
        console.log(`\n[YieldSync] ═══════════════════════════════════════════`);
        console.log(`[YieldSync] ✅ UNIFIED YIELD SYNC COMPLETE!`);
        console.log(`[YieldSync] ═══════════════════════════════════════════`);
        console.log(`[YieldSync] All stakers on BOTH chains now have:`);
        console.log(`[YieldSync]   - Same share price: ${globalSharePrice}`);
        console.log(`[YieldSync]   - Equal yield rate`);
        console.log(`[YieldSync] Next sync in ${this.config.syncIntervalMs / 1000}s`);
    }
    // ============================================================
    //  ETH POOL SHARE PRICE SYNC (MetaVault #3 / Fluid)
    // ============================================================
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
    async syncETHPoolSharePrice() {
        console.log(`\n[YieldSync] ── ETH Pool Share Price Sync ──`);
        // Read Canton ETH Pool state
        const ethPoolServices = await this.canton.queryContracts((0, canton_client_1.parseTemplateId)("CantonETHPool:CantonETHPoolService"), (p) => p.operator === this.config.cantonParty);
        if (ethPoolServices.length === 0) {
            console.log(`[YieldSync] No Canton ETH Pool service found, skipping`);
            return;
        }
        const pool = ethPoolServices[0];
        const cantonShares = this.parseNumeric18(pool.payload.totalShares);
        if (cantonShares === BigInt(0)) {
            console.log(`[YieldSync] ETH Pool has no shares, skipping sync`);
            return;
        }
        // Read MetaVault #3 total value from Ethereum (USDC 6 decimals)
        const metaVaultValue = BigInt((await this.metaVault3.totalValue()).toString());
        console.log(`[YieldSync] MetaVault #3 totalValue: $${this.formatUsdc(metaVaultValue)}`);
        console.log(`[YieldSync] Canton ETH Pool totalShares: ${pool.payload.totalShares}`);
        // Derive share price: MetaVault3.totalValue() / totalShares
        // Both in USDC 6-decimal, result is 6-decimal share price
        // To avoid precision loss: (value * 1e6) / shares gives 6-decimal price
        const SCALE = BigInt(1000000); // 1e6
        const sharePrice6 = (metaVaultValue * SCALE) / cantonShares;
        console.log(`[YieldSync] Derived share price: ${this.formatUsdc(sharePrice6)} USDC/share`);
        // Check for meaningful change (> 0.01% movement)
        if (this.lastETHPoolSharePrice > BigInt(0)) {
            const diff = sharePrice6 > this.lastETHPoolSharePrice
                ? sharePrice6 - this.lastETHPoolSharePrice
                : this.lastETHPoolSharePrice - sharePrice6;
            const bpsChange = (diff * BigInt(10000)) / this.lastETHPoolSharePrice;
            if (bpsChange < BigInt(1)) {
                console.log(`[YieldSync] ETH Pool share price change < 0.01%, skipping sync`);
                return;
            }
        }
        // Generate attestation hash for the sync
        const attestationData = ethers_1.ethers.solidityPackedKeccak256(["uint256", "uint256", "uint256"], [metaVaultValue, cantonShares, this.currentEpoch]);
        // Exercise ETHPool_SyncSharePrice on Canton
        await this.canton.exerciseChoice((0, canton_client_1.parseTemplateId)("CantonETHPool:CantonETHPoolService"), pool.contractId, "ETHPool_SyncSharePrice", {
            newSharePrice: this.toNumeric18(sharePrice6),
            epochNumber: this.currentEpoch.toString(),
            attestationHash: attestationData,
            validatorCount: this.config.validatorParties.length.toString(),
        });
        this.lastETHPoolSharePrice = sharePrice6;
        console.log(`[YieldSync] ✅ ETH Pool share price synced to Canton: ${this.formatUsdc(sharePrice6)} USDC/share`);
    }
    // ============================================================
    //                     HELPERS
    // ============================================================
    toNumeric18(value) {
        // Convert USDC (6 decimals) to Numeric 18 (18 decimals)
        const scale12 = BigInt("1000000000000"); // 10^12
        const scale18 = BigInt("1000000000000000000"); // 10^18
        const scaled = value * scale12;
        const intPart = scaled / scale18;
        const fracPart = scaled % scale18;
        return `${intPart}.${fracPart.toString().padStart(18, "0")}`;
    }
    parseNumeric18(value) {
        // Convert DAML Numeric 18 string to BigInt (in 6 decimal USDC units)
        const parts = value.split(".");
        const intPart = BigInt(parts[0] || "0");
        const fracPart = parts[1] || "0";
        // Take first 6 decimal places for USDC
        const fracUsdc = fracPart.padEnd(6, "0").substring(0, 6);
        const scale6 = BigInt("1000000");
        return intPart * scale6 + BigInt(fracUsdc);
    }
    formatUsdc(value) {
        const million = BigInt(1000000);
        const intPart = value / million;
        const fracPart = value % million;
        return `${intPart.toLocaleString()}.${fracPart.toString().padStart(6, "0").substring(0, 2)}`;
    }
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
exports.YieldSyncService = YieldSyncService;
// ============================================================
//                     MAIN
// ============================================================
async function main() {
    console.log("═══════════════════════════════════════════════════════════");
    console.log("     MINTED PROTOCOL - UNIFIED YIELD SYNC SERVICE");
    console.log("═══════════════════════════════════════════════════════════");
    console.log("");
    console.log("  UNIFIED CROSS-CHAIN YIELD DISTRIBUTION");
    console.log("");
    console.log("  This service ensures equal yield for ALL stakers:");
    console.log("    1. Reads Canton shares → syncs to Ethereum SMUSD");
    console.log("    2. Calculates global share price from Treasury");
    console.log("    3. Syncs global share price → Canton");
    console.log("    4. Both chains have IDENTICAL share price!");
    console.log("");
    console.log("═══════════════════════════════════════════════════════════");
    console.log("");
    // Validate config
    if (!DEFAULT_CONFIG.treasuryAddress) {
        throw new Error("TREASURY_ADDRESS environment variable required");
    }
    if (!DEFAULT_CONFIG.smusdAddress) {
        throw new Error("SMUSD_ADDRESS environment variable required");
    }
    if (!DEFAULT_CONFIG.cantonParty) {
        throw new Error("CANTON_PARTY environment variable required");
    }
    const service = new YieldSyncService(DEFAULT_CONFIG);
    // Graceful shutdown
    process.on("SIGINT", () => {
        console.log("\n[YieldSync] Received SIGINT, shutting down...");
        service.stop();
    });
    process.on("SIGTERM", () => {
        console.log("\n[YieldSync] Received SIGTERM, shutting down...");
        service.stop();
    });
    await service.start();
}
main().catch(err => {
    console.error("[YieldSync] Fatal error:", err);
    process.exit(1);
});
//# sourceMappingURL=yield-sync-service.js.map