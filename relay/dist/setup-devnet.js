"use strict";
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
/**
 * Setup DevNet protocol contracts after Canton restart.
 * Creates ComplianceRegistry-dependent contracts.
 * Usage: NODE_ENV=development npx ts-node --skip-project setup-devnet.ts
 */
const dotenv = __importStar(require("dotenv"));
const path = __importStar(require("path"));
dotenv.config({ path: path.join(__dirname, ".env.development") });
async function setup() {
    const { CantonClient, TEMPLATES } = await Promise.resolve().then(() => __importStar(require("./canton-client")));
    const party = process.env.CANTON_PARTY;
    const pkg = process.env.CANTON_PACKAGE_ID;
    const canton = new CantonClient({
        baseUrl: "http://localhost:7575",
        token: "dummy-no-auth",
        userId: "administrator",
        actAs: party,
        timeoutMs: 30000,
        defaultPackageId: pkg,
    });
    console.log(`[Setup] Party: ${party.slice(0, 40)}...`);
    console.log(`[Setup] Package: ${pkg.slice(0, 16)}...`);
    // 1. ComplianceRegistry
    const cr = await canton.queryContracts(TEMPLATES.ComplianceRegistry);
    if (cr.length > 0) {
        console.log(`[Setup] ComplianceRegistry: ${cr[0].contractId.slice(0, 24)}...`);
    }
    else {
        console.log("[Setup] ComplianceRegistry MISSING - cannot proceed");
        process.exit(1);
    }
    // 2. CantonDirectMintService
    const dms = await canton.queryContracts(TEMPLATES.CantonDirectMintService);
    if (dms.length > 0) {
        console.log(`[Setup] CantonDirectMintService: ${dms[0].contractId.slice(0, 24)}...`);
    }
    else {
        console.log("[Setup] Creating CantonDirectMintService...");
        await canton.createContract(TEMPLATES.CantonDirectMintService, {
            operator: party,
            usdcIssuer: party,
            usdcxIssuer: null,
            mintFeeBps: 30,
            redeemFeeBps: 30,
            minAmount: "1.0",
            maxAmount: "1000000.0",
            supplyCap: "100000000.0",
            currentSupply: "0.0",
            accumulatedFees: "0.0",
            paused: false,
            validators: [party],
            targetChainId: 11155111,
            targetTreasury: "0x6218782d1699C9DCA2EB16495c6307C3729cC546",
            nextNonce: 1,
            dailyMintLimit: "10000000.0",
            dailyMinted: "0.0",
            dailyBurned: "0.0",
            lastRateLimitReset: "1970-01-01T00:00:00Z",
            complianceRegistryCid: cr[0].contractId,
            mpaHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            mpaUri: "ipfs://QmDevMPA",
            authorizedMinters: [party],
            cantonCoinPrice: null,
            serviceName: "minted-direct-mint-v1",
        });
        console.log("[Setup] CantonDirectMintService created!");
    }
    console.log("[Setup] Done!");
}
setup().catch((err) => {
    console.error("[Setup] Fatal:", err.message);
    process.exit(1);
});
//# sourceMappingURL=setup-devnet.js.map