"use strict";
/**
 * Bootstrap Canton Protocol Contracts
 *
 * Creates the essential BridgeService contract on Canton so the relay
 * can complete bridge-in operations. Also creates MUSDSupplyService
 * if it doesn't exist.
 *
 * Usage: cd relay && NODE_ENV=development npx ts-node --skip-project bootstrap-canton.ts
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const canton_client_1 = require("./canton-client");
const dotenv = __importStar(require("dotenv"));
const path = __importStar(require("path"));
// Load .env.development in dev mode
const envFile = process.env.NODE_ENV === "development" ? ".env.development" : ".env";
dotenv.config({ path: path.join(__dirname, envFile) });
async function bootstrap() {
    const cantonHost = process.env.CANTON_HOST || "localhost";
    const cantonPort = parseInt(process.env.CANTON_PORT || "7575", 10);
    const cantonToken = process.env.CANTON_TOKEN || "dummy-no-auth";
    const cantonParty = process.env.CANTON_PARTY || "";
    const packageId = process.env.CANTON_PACKAGE_ID || "";
    const protocol = process.env.CANTON_USE_TLS === "false" ? "http" : "https";
    if (!cantonParty) {
        throw new Error("CANTON_PARTY not set");
    }
    if (!packageId) {
        throw new Error("CANTON_PACKAGE_ID not set");
    }
    console.log(`[Bootstrap] Connecting to Canton at ${cantonHost}:${cantonPort}`);
    console.log(`[Bootstrap] Party: ${cantonParty.slice(0, 40)}...`);
    console.log(`[Bootstrap] Package: ${packageId.slice(0, 16)}...`);
    const canton = new canton_client_1.CantonClient({
        baseUrl: `${protocol}://${cantonHost}:${cantonPort}`,
        token: cantonToken,
        userId: "administrator",
        actAs: cantonParty,
        timeoutMs: 30000,
        defaultPackageId: packageId,
    });
    // Test connection
    try {
        const offset = await canton.getLedgerEnd();
        console.log(`[Bootstrap] ✓ Connected — ledger offset: ${offset}`);
    }
    catch (err) {
        console.error(`[Bootstrap] ✗ Failed to connect: ${err.message}`);
        process.exit(1);
    }
    // 1. Check/Create BridgeService
    console.log("\n[Bootstrap] Checking BridgeService...");
    const governanceParty = process.env.CANTON_GOVERNANCE_PARTY || cantonParty;
    const existingBridge = await canton.queryContracts(canton_client_1.TEMPLATES.BridgeService);
    if (existingBridge.length > 0) {
        console.log(`[Bootstrap] ✓ BridgeService already exists (${existingBridge[0].contractId.slice(0, 24)}...)`);
    }
    else {
        console.log("[Bootstrap] Creating BridgeService...");
        try {
            await canton.createContract(canton_client_1.TEMPLATES.BridgeService, {
                operator: cantonParty,
                governance: governanceParty,
                validators: [cantonParty],
                requiredSignatures: 1,
                minValidators: 1, // Canton v2 JSON API: Optional Int encodes as just the value (or null)
                totalBridgedIn: "0.0",
                totalBridgedOut: "0.0",
                lastBridgeOutNonce: 0, // CRIT-05: Separate nonce for Canton→ETH
                lastBridgeInNonce: 0, // CRIT-05: Separate nonce for ETH→Canton
                paused: false,
                observers: [cantonParty],
            });
            console.log("[Bootstrap] ✓ BridgeService created successfully");
        }
        catch (err) {
            console.error(`[Bootstrap] ✗ Failed to create BridgeService: ${err.message}`);
            // Try with submitMulti approach (governance + operator as actAs)
            console.log("[Bootstrap] Note: If governance ≠ operator, both parties must be on this participant.");
        }
    }
    // 2. Check/Create MUSDSupplyService
    console.log("\n[Bootstrap] Checking MUSDSupplyService...");
    const existingSupply = await canton.queryContracts(canton_client_1.TEMPLATES.MUSDSupplyService);
    if (existingSupply.length > 0) {
        console.log(`[Bootstrap] ✓ MUSDSupplyService already exists (${existingSupply[0].contractId.slice(0, 24)}...)`);
    }
    else {
        console.log("[Bootstrap] Creating MUSDSupplyService...");
        try {
            await canton.createContract(canton_client_1.TEMPLATES.MUSDSupplyService, {
                operator: cantonParty,
                governance: governanceParty,
                supplyCap: "100000000.0", // 100M mUSD cap
                currentSupply: "0.0",
                largeMintThreshold: "100000.0", // 100k mUSD
                pendingLargeMints: [],
                observers: [],
            });
            console.log("[Bootstrap] ✓ MUSDSupplyService created successfully");
        }
        catch (err) {
            console.error(`[Bootstrap] ✗ Failed to create MUSDSupplyService: ${err.message}`);
        }
    }
    // 3. Verify
    console.log("\n[Bootstrap] Verifying...");
    const bridgeCheck = await canton.queryContracts(canton_client_1.TEMPLATES.BridgeService);
    const supplyCheck = await canton.queryContracts(canton_client_1.TEMPLATES.MUSDSupplyService);
    console.log(`  BridgeService: ${bridgeCheck.length > 0 ? "✓ EXISTS" : "✗ MISSING"}`);
    console.log(`  MUSDSupplyService: ${supplyCheck.length > 0 ? "✓ EXISTS" : "✗ MISSING"}`);
    // 4. Show all active contracts summary
    console.log("\n[Bootstrap] Active contracts summary:");
    const allContracts = await canton.queryContracts();
    const templateCounts = {};
    for (const c of allContracts) {
        const parts = c.templateId.split(":");
        const name = parts.length >= 3 ? `${parts[parts.length - 2]}:${parts[parts.length - 1]}` : c.templateId;
        templateCounts[name] = (templateCounts[name] || 0) + 1;
    }
    for (const [tpl, count] of Object.entries(templateCounts).sort()) {
        console.log(`  ${tpl}: ${count}`);
    }
    console.log("\n[Bootstrap] Done! Relay should now be able to complete bridge-in operations.");
}
bootstrap().catch((err) => {
    console.error("[Bootstrap] Fatal:", err);
    process.exit(1);
});
//# sourceMappingURL=bootstrap-canton.js.map