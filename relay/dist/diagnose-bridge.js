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
 * Diagnostic script: check Canton state for bridge processing
 */
const dotenv = __importStar(require("dotenv"));
const path = __importStar(require("path"));
dotenv.config({ path: path.resolve(__dirname, ".env.development") });
const canton_client_1 = require("./canton-client");
async function main() {
    const canton = new canton_client_1.CantonClient({
        baseUrl: `http://${process.env.CANTON_HOST}:${process.env.CANTON_PORT}`,
        token: process.env.CANTON_TOKEN || "dummy-no-auth",
        userId: process.env.CANTON_USER || "administrator",
        actAs: process.env.CANTON_PARTY,
        defaultPackageId: process.env.CANTON_PACKAGE_ID,
    });
    console.log("=== Querying ALL BridgeInRequests ===");
    const allRequests = await canton.queryContracts(canton_client_1.TEMPLATES.BridgeInRequest);
    console.log(`Total BridgeInRequests: ${allRequests.length}`);
    for (const req of allRequests) {
        console.log(`  nonce=${req.payload.nonce}, status=${req.payload.status}, amount=${req.payload.amount}`);
    }
    console.log("\n=== Querying PENDING BridgeInRequests (with filter) ===");
    const pendingRequests = await canton.queryContracts(canton_client_1.TEMPLATES.BridgeInRequest, (p) => p.status === "pending");
    console.log(`Pending BridgeInRequests: ${pendingRequests.length}`);
    for (const req of pendingRequests) {
        console.log(`  nonce=${req.payload.nonce}, status=${req.payload.status}, amount=${req.payload.amount}`);
    }
    console.log("\n=== Querying ALL CantonMUSD tokens ===");
    const musdTokens = await canton.queryContracts(canton_client_1.TEMPLATES.CantonMUSD);
    console.log(`Total CantonMUSD tokens: ${musdTokens.length}`);
    for (const tok of musdTokens) {
        console.log(`  amount=${tok.payload.amount}, agreementHash=${tok.payload.agreementHash || "NONE"}, owner=${String(tok.payload.owner).slice(0, 40)}`);
    }
    // Summary
    console.log("\n=== SUMMARY ===");
    const pendingNonces = pendingRequests.filter(r => Number(r.payload.nonce) < 900).map(r => Number(r.payload.nonce));
    const totalPendingAmount = pendingRequests
        .filter(r => Number(r.payload.nonce) < 900)
        .reduce((sum, r) => sum + parseFloat(r.payload.amount), 0);
    console.log(`Pending nonces (< 900): [${pendingNonces.join(", ")}]`);
    console.log(`Total pending amount: ${totalPendingAmount} mUSD`);
    console.log(`Existing CantonMUSD tokens: ${musdTokens.length}`);
    console.log(`Missing CantonMUSD: ${pendingNonces.length - musdTokens.length} (need to mint)`);
}
main().catch(console.error);
//# sourceMappingURL=diagnose-bridge.js.map