"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = exports.FluidRebalancer = exports.getRebalancerStatus = void 0;
const ethers_1 = require("ethers");
const utils_1 = require("./utils");
// INFRA-H-01 / INFRA-H-06: Enforce TLS certificate validation
(0, utils_1.enforceTLSSecurity)();
function loadConfig() {
    const rpcUrl = process.env.ETHEREUM_RPC_URL;
    if (!rpcUrl)
        throw new Error("ETHEREUM_RPC_URL is required");
    (0, utils_1.requireHTTPS)(rpcUrl, "ETHEREUM_RPC_URL");
    // Parse strategy addresses from comma-separated env var
    const strategyAddrs = (process.env.FLUID_STRATEGY_ADDRESSES || "").split(",").filter(Boolean);
    const strategyNames = (process.env.FLUID_STRATEGY_NAMES || "").split(",").filter(Boolean);
    const strategyModes = (process.env.FLUID_STRATEGY_MODES || "").split(",").filter(Boolean);
    const strategies = strategyAddrs.map((addr, i) => ({
        address: addr.trim(),
        name: strategyNames[i]?.trim() || `Strategy ${i}`,
        vaultMode: parseInt(strategyModes[i]?.trim() || "3", 10),
    }));
    if (strategies.length === 0) {
        throw new Error("FLUID_STRATEGY_ADDRESSES is required (comma-separated)");
    }
    return {
        ethereumRpcUrl: rpcUrl,
        strategies,
        keeperPrivateKey: (0, utils_1.readSecret)("keeper_private_key", "KEEPER_PRIVATE_KEY"),
        pollIntervalMs: parseInt(process.env.REBALANCER_POLL_MS || "30000", 10), // 30s default
        maxGasPriceGwei: parseInt(process.env.MAX_GAS_PRICE_GWEI || "80", 10),
        rebalanceTriggerHf: BigInt(process.env.REBALANCE_HF || "1150000000000000000"), // 1.15x
        emergencyHf: BigInt(process.env.EMERGENCY_HF || "1050000000000000000"), // 1.05x
        telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
        telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
    };
}
exports.loadConfig = loadConfig;
// ============================================================
//                     STRATEGY ABI
// ============================================================
const STRATEGY_ABI = [
    "function getHealthFactor() external view returns (uint256)",
    "function getCurrentLeverage() external view returns (uint256)",
    "function getPosition() external view returns (uint256 collateral, uint256 borrowed, uint256 principal, uint256 netValue)",
    "function targetLtvBps() external view returns (uint256)",
    "function targetLoops() external view returns (uint256)",
    "function safetyBufferBps() external view returns (uint256)",
    "function realSharePrice() external view returns (uint256 priceWad, bool trusted)",
    "function realTvl() external view returns (uint256 tvl, bool trusted)",
    "function isActive() external view returns (bool)",
    "function rebalance() external",
    "function emergencyDeleverage() external",
    "function positionNftId() external view returns (uint256)",
    "function vaultMode() external view returns (uint8)",
];
class FluidRebalancer {
    provider;
    wallet;
    walletAddress = "";
    config;
    running = false;
    consecutiveErrors = new Map();
    constructor(config) {
        this.config = config;
        this.provider = new ethers_1.ethers.JsonRpcProvider(config.ethereumRpcUrl);
    }
    async init() {
        this.wallet = await (0, utils_1.createSigner)(this.provider, "keeper_private_key", "KEEPER_PRIVATE_KEY");
        this.walletAddress = await this.wallet.getAddress();
    }
    async start() {
        await this.init();
        console.log("=== Fluid Strategy Rebalancer ===");
        console.log(`  Keeper: ${this.walletAddress}`);
        console.log(`  Poll interval: ${this.config.pollIntervalMs}ms`);
        console.log(`  Rebalance HF trigger: ${ethers_1.ethers.formatUnits(this.config.rebalanceTriggerHf, 18)}`);
        console.log(`  Emergency HF trigger: ${ethers_1.ethers.formatUnits(this.config.emergencyHf, 18)}`);
        console.log(`  Strategies:`);
        for (const s of this.config.strategies) {
            console.log(`    ${s.name}: ${s.address} (mode ${s.vaultMode})`);
        }
        this.running = true;
        while (this.running) {
            try {
                await this.monitorAndRebalance();
            }
            catch (err) {
                console.error("Rebalancer cycle error:", err);
            }
            await this.sleep(this.config.pollIntervalMs);
        }
    }
    stop() {
        console.log("Fluid Rebalancer stopping...");
        this.running = false;
    }
    // ── Core monitoring loop ────────────────────────────────────────────
    async monitorAndRebalance() {
        // Check gas price first
        const feeData = await this.provider.getFeeData();
        const gasPrice = feeData.gasPrice || 0n;
        const maxGasWei = BigInt(this.config.maxGasPriceGwei) * 1000000000n;
        if (gasPrice > maxGasWei) {
            console.log(`Gas too high: ${ethers_1.ethers.formatUnits(gasPrice, "gwei")} gwei, skipping cycle`);
            return;
        }
        for (const stratConfig of this.config.strategies) {
            try {
                const snapshot = await this.getSnapshot(stratConfig);
                if (!snapshot.isActive || !snapshot.hasPosition) {
                    console.log(`[${stratConfig.name}] Inactive or no position, skipping`);
                    continue;
                }
                this.logSnapshot(snapshot);
                // Check if emergency deleverage is needed
                if (snapshot.healthFactor < this.config.emergencyHf) {
                    console.log(`[${stratConfig.name}] EMERGENCY: HF ${ethers_1.ethers.formatUnits(snapshot.healthFactor, 18)} < ${ethers_1.ethers.formatUnits(this.config.emergencyHf, 18)}`);
                    await this.executeEmergencyDeleverage(stratConfig);
                    continue;
                }
                // Check if rebalance is needed
                if (snapshot.healthFactor < this.config.rebalanceTriggerHf) {
                    console.log(`[${stratConfig.name}] Rebalance needed: HF ${ethers_1.ethers.formatUnits(snapshot.healthFactor, 18)} < ${ethers_1.ethers.formatUnits(this.config.rebalanceTriggerHf, 18)}`);
                    await this.executeRebalance(stratConfig, snapshot);
                    continue;
                }
                console.log(`[${stratConfig.name}] Healthy: HF ${ethers_1.ethers.formatUnits(snapshot.healthFactor, 18)}, leverage ${Number(snapshot.leverageX100) / 100}x`);
                // Reset consecutive error count on successful check
                this.consecutiveErrors.set(stratConfig.address, 0);
            }
            catch (err) {
                const errorCount = (this.consecutiveErrors.get(stratConfig.address) || 0) + 1;
                this.consecutiveErrors.set(stratConfig.address, errorCount);
                console.error(`[${stratConfig.name}] Error (${errorCount} consecutive):`, err);
                // Alert after 3 consecutive errors
                if (errorCount >= 3) {
                    await this.sendAlert(`[${stratConfig.name}] ${errorCount} consecutive monitoring errors. Last: ${err.message}`);
                }
            }
        }
    }
    // ── Snapshot ─────────────────────────────────────────────────────────
    async getSnapshot(stratConfig) {
        const contract = new ethers_1.ethers.Contract(stratConfig.address, STRATEGY_ABI, this.provider);
        const [healthFactor, leverageX100, position, targetLtvBps, sharePrice, isActive, nftId,] = await Promise.all([
            contract.getHealthFactor(),
            contract.getCurrentLeverage(),
            contract.getPosition(),
            contract.targetLtvBps(),
            contract.realSharePrice(),
            contract.isActive(),
            contract.positionNftId(),
        ]);
        return {
            address: stratConfig.address,
            name: stratConfig.name,
            healthFactor,
            leverageX100,
            collateral: position[0],
            borrowed: position[1],
            principal: position[2],
            netValue: position[3],
            targetLtvBps,
            sharePriceWad: sharePrice[0],
            trusted: sharePrice[1],
            isActive,
            hasPosition: nftId > 0n,
        };
    }
    logSnapshot(s) {
        const hf = parseFloat(ethers_1.ethers.formatUnits(s.healthFactor, 18));
        const leverage = Number(s.leverageX100) / 100;
        const net = ethers_1.ethers.formatUnits(s.netValue, 18);
        const sp = parseFloat(ethers_1.ethers.formatUnits(s.sharePriceWad, 18));
        const targetLtv = Number(s.targetLtvBps) / 100;
        const hfStatus = hf < 1.05 ? "CRITICAL" : hf < 1.15 ? "WARNING" : "OK";
        console.log(`[${s.name}] HF: ${hf.toFixed(4)} (${hfStatus}) | ` +
            `Leverage: ${leverage.toFixed(2)}x | Target LTV: ${targetLtv}% | ` +
            `Net: ${net} | SharePrice: ${sp.toFixed(6)} (${s.trusted ? "trusted" : "UNTRUSTED"})`);
    }
    // ── Rebalance execution ─────────────────────────────────────────────
    async executeRebalance(stratConfig, snapshot) {
        const contract = new ethers_1.ethers.Contract(stratConfig.address, STRATEGY_ABI, this.wallet);
        try {
            const gasEstimate = await contract.rebalance.estimateGas();
            const tx = await contract.rebalance({
                gasLimit: gasEstimate * 12n / 10n, // 20% buffer
            });
            console.log(`[${stratConfig.name}] Rebalance TX: ${tx.hash}`);
            const receipt = await tx.wait(2);
            if (receipt?.status === 1) {
                // Read new health factor
                const newHf = await contract.getHealthFactor();
                const oldHfStr = parseFloat(ethers_1.ethers.formatUnits(snapshot.healthFactor, 18)).toFixed(4);
                const newHfStr = parseFloat(ethers_1.ethers.formatUnits(newHf, 18)).toFixed(4);
                console.log(`[${stratConfig.name}] Rebalanced: HF ${oldHfStr} -> ${newHfStr}`);
                await this.sendAlert(`[${stratConfig.name}] Rebalanced successfully\n` +
                    `HF: ${oldHfStr} -> ${newHfStr}\n` +
                    `TX: ${tx.hash}`);
            }
            else {
                console.error(`[${stratConfig.name}] Rebalance TX reverted`);
                await this.sendAlert(`[${stratConfig.name}] Rebalance TX REVERTED: ${tx.hash}`);
            }
        }
        catch (err) {
            console.error(`[${stratConfig.name}] Rebalance failed:`, err);
            await this.sendAlert(`[${stratConfig.name}] REBALANCE FAILED\n` +
                `HF: ${parseFloat(ethers_1.ethers.formatUnits(snapshot.healthFactor, 18)).toFixed(4)}\n` +
                `Error: ${err.message?.substring(0, 200)}`);
        }
    }
    // ── Emergency deleverage ────────────────────────────────────────────
    async executeEmergencyDeleverage(stratConfig) {
        const contract = new ethers_1.ethers.Contract(stratConfig.address, STRATEGY_ABI, this.wallet);
        try {
            const gasEstimate = await contract.emergencyDeleverage.estimateGas();
            const tx = await contract.emergencyDeleverage({
                gasLimit: gasEstimate * 15n / 10n, // 50% buffer for emergency
            });
            console.log(`[${stratConfig.name}] EMERGENCY DELEVERAGE TX: ${tx.hash}`);
            const receipt = await tx.wait(2);
            if (receipt?.status === 1) {
                console.log(`[${stratConfig.name}] Emergency deleverage complete`);
                await this.sendAlert(`[${stratConfig.name}] EMERGENCY DELEVERAGE EXECUTED\n` +
                    `Position fully unwound.\n` +
                    `TX: ${tx.hash}`);
            }
            else {
                console.error(`[${stratConfig.name}] Emergency deleverage TX reverted`);
                await this.sendAlert(`[${stratConfig.name}] EMERGENCY DELEVERAGE REVERTED\n` +
                    `TX: ${tx.hash}\n` +
                    `MANUAL INTERVENTION REQUIRED`);
            }
        }
        catch (err) {
            console.error(`[${stratConfig.name}] Emergency deleverage failed:`, err);
            await this.sendAlert(`[${stratConfig.name}] EMERGENCY DELEVERAGE FAILED\n` +
                `Error: ${err.message?.substring(0, 200)}\n` +
                `MANUAL INTERVENTION REQUIRED IMMEDIATELY`);
        }
    }
    // ── Telegram alerts ─────────────────────────────────────────────────
    async sendAlert(message) {
        if (!this.config.telegramBotToken || !this.config.telegramChatId)
            return;
        try {
            const url = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`;
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chat_id: this.config.telegramChatId,
                    text: `Fluid Rebalancer\n\n${message}`,
                    parse_mode: "HTML",
                }),
            });
            if (!res.ok) {
                console.error(`Telegram alert failed: ${res.status}`);
            }
        }
        catch (err) {
            console.error("Telegram alert error:", err);
        }
    }
    // ── Helpers ─────────────────────────────────────────────────────────
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
exports.FluidRebalancer = FluidRebalancer;
async function getRebalancerStatus(config) {
    const provider = new ethers_1.ethers.JsonRpcProvider(config.ethereumRpcUrl);
    const results = [];
    for (const stratConfig of config.strategies) {
        try {
            const contract = new ethers_1.ethers.Contract(stratConfig.address, STRATEGY_ABI, provider);
            const [hf, leverage, position, targetLtv, sp, active, nftId] = await Promise.all([
                contract.getHealthFactor(),
                contract.getCurrentLeverage(),
                contract.getPosition(),
                contract.targetLtvBps(),
                contract.realSharePrice(),
                contract.isActive(),
                contract.positionNftId(),
            ]);
            const hfNum = parseFloat(ethers_1.ethers.formatUnits(hf, 18));
            const hasPos = nftId > 0n;
            let status = "healthy";
            if (!active || !hasPos)
                status = "inactive";
            else if (hfNum < 1.05)
                status = "critical";
            else if (hfNum < 1.15)
                status = "warning";
            results.push({
                address: stratConfig.address,
                name: stratConfig.name,
                healthFactor: hfNum.toFixed(4),
                leverageX100: leverage.toString(),
                collateral: ethers_1.ethers.formatUnits(position[0], 18),
                borrowed: ethers_1.ethers.formatUnits(position[1], 18),
                netValue: ethers_1.ethers.formatUnits(position[3], 18),
                targetLtvBps: targetLtv.toString(),
                sharePrice: parseFloat(ethers_1.ethers.formatUnits(sp[0], 18)).toFixed(6),
                trusted: sp[1],
                isActive: active,
                hasPosition: hasPos,
                status,
            });
        }
        catch (err) {
            results.push({
                address: stratConfig.address,
                name: stratConfig.name,
                healthFactor: "0",
                leverageX100: "0",
                collateral: "0",
                borrowed: "0",
                netValue: "0",
                targetLtvBps: "0",
                sharePrice: "0",
                trusted: false,
                isActive: false,
                hasPosition: false,
                status: "inactive",
            });
        }
    }
    return results;
}
exports.getRebalancerStatus = getRebalancerStatus;
// ============================================================
//                     MAIN
// ============================================================
async function main() {
    const config = loadConfig();
    if (!config.keeperPrivateKey) {
        console.error("KEEPER_PRIVATE_KEY not set");
        process.exit(1);
    }
    const rebalancer = new FluidRebalancer(config);
    // Graceful shutdown
    process.on("SIGINT", () => rebalancer.stop());
    process.on("SIGTERM", () => rebalancer.stop());
    await rebalancer.start();
}
main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
//# sourceMappingURL=fluid-rebalancer.js.map