"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CONFIG = exports.YieldKeeper = exports.getKeeperStatus = void 0;
const ethers_1 = require("ethers");
const utils_1 = require("./utils");
const metrics_1 = require("./metrics");
// INFRA-H-01 / INFRA-H-06: Enforce TLS certificate validation at process level
(0, utils_1.enforceTLSSecurity)();
const DEFAULT_CONFIG = {
    // INFRA-H-01: No insecure fallback — require explicit RPC URL
    ethereumRpcUrl: (() => {
        const url = process.env.ETHEREUM_RPC_URL;
        if (!url)
            throw new Error("ETHEREUM_RPC_URL is required (no insecure default)");
        (0, utils_1.requireHTTPS)(url, "ETHEREUM_RPC_URL");
        return url;
    })(),
    treasuryAddress: process.env.TREASURY_ADDRESS || "",
    keeperPrivateKey: (0, utils_1.readSecret)("keeper_private_key", "KEEPER_PRIVATE_KEY"),
    pollIntervalMs: parseInt(process.env.KEEPER_POLL_MS || "60000", 10), // 1 minute
    maxGasPriceGwei: parseInt(process.env.MAX_GAS_PRICE_GWEI || "50", 10),
    // TS-H-01: Use Number() + validation instead of parseFloat
    minProfitUsd: (() => {
        const v = Number(process.env.MIN_PROFIT_USD || "10");
        if (Number.isNaN(v) || v < 0)
            throw new Error("MIN_PROFIT_USD must be a non-negative number");
        return v;
    })(),
};
exports.DEFAULT_CONFIG = DEFAULT_CONFIG;
// ============================================================
//                     TREASURY ABI
// ============================================================
const TREASURY_ABI = [
    {
        "inputs": [],
        "name": "shouldAutoDeploy",
        "outputs": [
            { "internalType": "bool", "name": "", "type": "bool" },
            { "internalType": "uint256", "name": "", "type": "uint256" }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "keeperTriggerAutoDeploy",
        "outputs": [
            { "internalType": "uint256", "name": "deployed", "type": "uint256" }
        ],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "autoDeployEnabled",
        "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "autoDeployThreshold",
        "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "defaultStrategy",
        "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "deployableAmount",
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
    }
];
// ============================================================
//                     YIELD KEEPER
// ============================================================
class YieldKeeper {
    provider;
    wallet;
    walletAddress = "";
    treasury;
    config;
    running = false;
    metricsServer = null;
    constructor(config) {
        this.config = config;
        this.provider = new ethers_1.ethers.JsonRpcProvider(config.ethereumRpcUrl);
        // Signer is initialised asynchronously via init()
        this.treasury = new ethers_1.ethers.Contract(config.treasuryAddress, TREASURY_ABI, this.provider);
    }
    /** Initialise the KMS-backed (or fallback) signer */
    async init() {
        this.wallet = await (0, utils_1.createSigner)(this.provider, "keeper_private_key", "KEEPER_PRIVATE_KEY");
        this.walletAddress = await this.wallet.getAddress();
        // Re-bind treasury with signing capability
        this.treasury = new ethers_1.ethers.Contract(this.config.treasuryAddress, TREASURY_ABI, this.wallet);
    }
    /**
     * Start the keeper loop
     */
    async start() {
        // Initialise signer (KMS or fallback)
        await this.init();
        console.log("🚀 Yield Keeper starting...");
        console.log(`   Treasury: ${this.config.treasuryAddress}`);
        const walletAddress = await this.wallet.getAddress();
        console.log(`   Keeper wallet: ${walletAddress}`);
        console.log(`   Poll interval: ${this.config.pollIntervalMs}ms`);
        // Verify connection and configuration
        await this.verifySetup();
        const metricsPort = parseInt(process.env.KEEPER_METRICS_PORT || "9094", 10);
        const metricsHost = process.env.KEEPER_METRICS_HOST || "0.0.0.0";
        this.metricsServer = (0, metrics_1.startMetricsServer)(metricsPort, metricsHost);
        this.running = true;
        while (this.running) {
            try {
                await this.checkAndDeploy();
            }
            catch (err) {
                console.error("❌ Keeper cycle error:", err);
            }
            await this.sleep(this.config.pollIntervalMs);
        }
    }
    /**
     * Stop the keeper
     */
    stop() {
        console.log("🛑 Yield Keeper stopping...");
        this.running = false;
        if (this.metricsServer) {
            this.metricsServer.close();
            this.metricsServer = null;
        }
    }
    /**
     * Verify setup is correct
     */
    async verifySetup() {
        // Check Treasury is accessible
        const enabled = await this.treasury.autoDeployEnabled();
        const threshold = await this.treasury.autoDeployThreshold();
        const strategy = await this.treasury.defaultStrategy();
        console.log(`   Auto-deploy enabled: ${enabled}`);
        console.log(`   Threshold: $${this.formatUsdc(threshold)}`);
        console.log(`   Default strategy: ${strategy}`);
        if (!enabled) {
            console.warn("⚠️  Auto-deploy is DISABLED on Treasury");
        }
        if (strategy === ethers_1.ethers.ZeroAddress) {
            console.warn("⚠️  No default strategy configured");
        }
    }
    /**
     * Main keeper logic: check if deploy needed and execute
     */
    async checkAndDeploy() {
        // 1. Check if auto-deploy would trigger
        const [shouldDeploy, deployable] = await this.treasury.shouldAutoDeploy();
        if (!shouldDeploy) {
            console.log(`📊 No deploy needed. Deployable: $${this.formatUsdc(deployable)}`);
            return;
        }
        console.log(`💰 Deploy opportunity: $${this.formatUsdc(deployable)} deployable`);
        // 2. Check gas price (TS-M-03: use BigInt comparison to avoid precision loss)
        const feeData = await this.provider.getFeeData();
        const gasPrice = feeData.gasPrice || 0n;
        const maxGasPriceWei = BigInt(this.config.maxGasPriceGwei) * 1000000000n;
        if (gasPrice > maxGasPriceWei) {
            console.log(`⛽ Gas too high (${ethers_1.ethers.formatUnits(gasPrice, "gwei")} gwei > ${this.config.maxGasPriceGwei}), skipping`);
            return;
        }
        // 3. Estimate gas and check profitability
        try {
            const gasEstimate = await this.treasury.keeperTriggerAutoDeploy.estimateGas();
            const gasCostWei = gasEstimate * gasPrice;
            // TS-M-03: Use ethers.formatUnits for safe BigInt → decimal conversion
            const gasCostEth = parseFloat(ethers_1.ethers.formatUnits(gasCostWei, 18));
            // TS-H-02: Use configurable ETH price from env/oracle instead of hardcoded $2000
            // In production, this should be fetched from the price oracle service
            const ethPriceUsd = Number(process.env.ETH_PRICE_USD || "0");
            if (ethPriceUsd <= 0) {
                console.warn("⚠️  ETH_PRICE_USD not set or invalid — skipping profitability check");
                return;
            }
            const gasCostUsd = gasCostEth * ethPriceUsd;
            // Estimate daily yield on deployed amount (assume 10% APY)
            // TS-M-04: Use ethers.formatUnits for safe BigInt → decimal conversion
            const deployableUsd = parseFloat(ethers_1.ethers.formatUnits(deployable, 6));
            const dailyYieldUsd = (deployableUsd * 0.10) / 365;
            console.log(`   Gas cost: $${gasCostUsd.toFixed(2)} | Daily yield: $${dailyYieldUsd.toFixed(2)}`);
            if (dailyYieldUsd < this.config.minProfitUsd) {
                console.log(`⚖️  Yield below minimum ($${this.config.minProfitUsd}), skipping`);
                return;
            }
            // 4. Execute deployment
            console.log("🔄 Triggering auto-deploy...");
            const observeDuration = metrics_1.yieldDistributionDuration.startTimer();
            const tx = await this.treasury.keeperTriggerAutoDeploy({
                gasLimit: gasEstimate * 12n / 10n, // 20% buffer
            });
            console.log(`   TX submitted: ${tx.hash}`);
            const receipt = await tx.wait(2); // Wait for 2 confirmations
            if (receipt?.status === 1) {
                console.log(`✅ Deployed $${this.formatUsdc(deployable)} to strategy`);
                metrics_1.yieldDistributionsTotal.labels("usdc", "success").inc();
            }
            else {
                console.error("❌ TX reverted");
                metrics_1.yieldDistributionsTotal.labels("usdc", "revert").inc();
            }
            observeDuration();
        }
        catch (err) {
            console.error("❌ Deploy failed:", err);
            metrics_1.yieldDistributionsTotal.labels("usdc", "error").inc();
        }
    }
    /**
     * Format USDC amount for display (6 decimals → human readable)
     * TS-M-04: Use ethers.formatUnits to avoid precision loss on large amounts
     */
    formatUsdc(amount) {
        return parseFloat(ethers_1.ethers.formatUnits(amount, 6)).toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });
    }
    /**
     * Sleep helper
     */
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
exports.YieldKeeper = YieldKeeper;
// ============================================================
//                     STATUS API
// ============================================================
/**
 * Get current Treasury/Keeper status (for monitoring dashboards)
 */
async function getKeeperStatus(config) {
    const provider = new ethers_1.ethers.JsonRpcProvider(config.ethereumRpcUrl);
    const treasury = new ethers_1.ethers.Contract(config.treasuryAddress, TREASURY_ABI, provider);
    const [enabled, strategy, threshold, deployable, reserves, deployed, [shouldDeploy]] = await Promise.all([
        treasury.autoDeployEnabled(),
        treasury.defaultStrategy(),
        treasury.autoDeployThreshold(),
        treasury.deployableAmount(),
        treasury.availableReserves(),
        treasury.deployedToStrategies(),
        treasury.shouldAutoDeploy(),
    ]);
    // TS-M-04: Use ethers.formatUnits to avoid precision loss on large USDC amounts
    return {
        autoDeployEnabled: enabled,
        defaultStrategy: strategy,
        threshold: parseFloat(ethers_1.ethers.formatUnits(threshold, 6)).toFixed(2),
        deployable: parseFloat(ethers_1.ethers.formatUnits(deployable, 6)).toFixed(2),
        availableReserves: parseFloat(ethers_1.ethers.formatUnits(reserves, 6)).toFixed(2),
        deployedToStrategies: parseFloat(ethers_1.ethers.formatUnits(deployed, 6)).toFixed(2),
        shouldDeploy,
    };
}
exports.getKeeperStatus = getKeeperStatus;
// ============================================================
//                     MAIN
// ============================================================
async function main() {
    // Validate config
    if (!DEFAULT_CONFIG.treasuryAddress) {
        console.error("❌ TREASURY_ADDRESS not set");
        process.exit(1);
    }
    if (!DEFAULT_CONFIG.keeperPrivateKey) {
        console.error("❌ KEEPER_PRIVATE_KEY not set");
        process.exit(1);
    }
    const keeper = new YieldKeeper(DEFAULT_CONFIG);
    // Graceful shutdown
    process.on("SIGINT", () => keeper.stop());
    process.on("SIGTERM", () => keeper.stop());
    await keeper.start();
}
// Run if executed directly
main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
//# sourceMappingURL=yield-keeper.js.map