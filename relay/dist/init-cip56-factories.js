"use strict";
/**
 * Initialize CIP-56 Factory Contracts on Canton
 *
 * Creates MUSDTransferFactory and MUSDAllocationFactory if they don't already
 * exist. Idempotent — safe to run multiple times.
 *
 * Required env vars:
 *   CANTON_PARTY          — operator party ID
 *   CANTON_PACKAGE_ID     — main protocol DAR package ID
 *   CIP56_PACKAGE_ID      — ble-protocol-cip56 DAR package ID
 *
 * Usage:
 *   cd relay && npx ts-node --skip-project init-cip56-factories.ts
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
const dotenv = __importStar(require("dotenv"));
const path = __importStar(require("path"));
// Load env BEFORE importing canton-client — TEMPLATES reads
// process.env.CIP56_PACKAGE_ID at module load time (top-level const).
const envFile = process.env.NODE_ENV === "development" ? ".env.development" : ".env";
dotenv.config({ path: path.join(__dirname, envFile) });
async function initCip56Factories() {
    // Dynamic import: canton-client's TEMPLATES const reads process.env.CIP56_PACKAGE_ID
    // at module initialisation, so we must import AFTER dotenv.config() has run.
    const { CantonClient, TEMPLATES } = await Promise.resolve().then(() => __importStar(require("./canton-client")));
    const cantonHost = process.env.CANTON_HOST || "localhost";
    const cantonPort = parseInt(process.env.CANTON_PORT || "7575", 10);
    const cantonToken = process.env.CANTON_TOKEN || "dummy-no-auth";
    const cantonParty = process.env.CANTON_PARTY || "";
    const packageId = process.env.CANTON_PACKAGE_ID || "";
    const cip56PackageId = process.env.CIP56_PACKAGE_ID || "";
    const protocol = process.env.CANTON_USE_TLS === "false" ? "http" : "https";
    // --- Preflight checks ---
    if (!cantonParty) {
        console.error("[CIP-56 Init] ✗ CANTON_PARTY not set");
        process.exit(1);
    }
    if (!packageId) {
        console.error("[CIP-56 Init] ✗ CANTON_PACKAGE_ID not set");
        process.exit(1);
    }
    if (!cip56PackageId) {
        console.error("[CIP-56 Init] ✗ CIP56_PACKAGE_ID not set");
        console.error("  Obtain after uploading ble-protocol-cip56-1.0.0.dar:");
        console.error("    daml ledger upload-dar daml-cip56/.daml/dist/ble-protocol-cip56-1.0.0.dar");
        console.error("  Then set CIP56_PACKAGE_ID to the returned package hash.");
        process.exit(1);
    }
    console.log("[CIP-56 Init] Configuration:");
    console.log(`  Canton:         ${protocol}://${cantonHost}:${cantonPort}`);
    console.log(`  Party:          ${cantonParty.slice(0, 40)}...`);
    console.log(`  Main package:   ${packageId.slice(0, 16)}...`);
    console.log(`  CIP-56 package: ${cip56PackageId.slice(0, 16)}...`);
    const canton = new CantonClient({
        baseUrl: `${protocol}://${cantonHost}:${cantonPort}`,
        token: cantonToken,
        userId: "administrator",
        actAs: cantonParty,
        timeoutMs: 30000,
        defaultPackageId: packageId,
    });
    // --- Connection test ---
    try {
        const offset = await canton.getLedgerEnd();
        console.log(`[CIP-56 Init] ✓ Connected — ledger offset: ${offset}`);
    }
    catch (err) {
        console.error(`[CIP-56 Init] ✗ Failed to connect: ${err.message}`);
        process.exit(1);
    }
    // --- Verify CIP-56 DAR is uploaded ---
    console.log("\n[CIP-56 Init] Verifying CIP-56 DAR is uploaded...");
    try {
        const packages = await canton.listPackages();
        if (packages.includes(cip56PackageId)) {
            console.log(`[CIP-56 Init] ✓ CIP-56 DAR found (${cip56PackageId.slice(0, 16)}...)`);
        }
        else {
            console.error(`[CIP-56 Init] ✗ CIP-56 DAR not found on participant.`);
            console.error(`  Upload it first:`);
            console.error(`    daml ledger upload-dar daml-cip56/.daml/dist/ble-protocol-cip56-1.0.0.dar`);
            console.error(`  Available packages: ${packages.length}`);
            process.exit(1);
        }
    }
    catch (err) {
        console.warn(`[CIP-56 Init] ⚠ Could not verify packages (non-fatal): ${err.message?.slice(0, 100)}`);
    }
    // Additional observers for factory discovery (e.g., wallet parties).
    // For DevNet canary, operator-only is sufficient.
    // Add wallet/DEX parties here when expanding beyond canary.
    const factoryObservers = [cantonParty];
    // --- 1. MUSDTransferFactory ---
    console.log("\n[CIP-56 Init] Checking MUSDTransferFactory...");
    const existingTransfer = await canton.queryContracts(TEMPLATES.MUSDTransferFactory, (p) => p.admin === cantonParty);
    if (existingTransfer.length > 0) {
        console.log(`[CIP-56 Init] ✓ MUSDTransferFactory already exists ` +
            `(${existingTransfer[0].contractId.slice(0, 24)}...)`);
    }
    else {
        console.log("[CIP-56 Init] Creating MUSDTransferFactory...");
        try {
            await canton.createContract(TEMPLATES.MUSDTransferFactory, {
                admin: cantonParty,
                observers: factoryObservers,
            });
            console.log("[CIP-56 Init] ✓ MUSDTransferFactory created");
        }
        catch (err) {
            console.error(`[CIP-56 Init] ✗ Failed to create MUSDTransferFactory: ${err.message}`);
            process.exit(1);
        }
    }
    // --- 2. MUSDAllocationFactory ---
    console.log("\n[CIP-56 Init] Checking MUSDAllocationFactory...");
    const existingAlloc = await canton.queryContracts(TEMPLATES.MUSDAllocationFactory, (p) => p.admin === cantonParty);
    if (existingAlloc.length > 0) {
        console.log(`[CIP-56 Init] ✓ MUSDAllocationFactory already exists ` +
            `(${existingAlloc[0].contractId.slice(0, 24)}...)`);
    }
    else {
        console.log("[CIP-56 Init] Creating MUSDAllocationFactory...");
        try {
            await canton.createContract(TEMPLATES.MUSDAllocationFactory, {
                admin: cantonParty,
                observers: factoryObservers,
            });
            console.log("[CIP-56 Init] ✓ MUSDAllocationFactory created");
        }
        catch (err) {
            console.error(`[CIP-56 Init] ✗ Failed to create MUSDAllocationFactory: ${err.message}`);
            process.exit(1);
        }
    }
    // --- 3. Verify ---
    console.log("\n[CIP-56 Init] Verification:");
    const transferCheck = await canton.queryContracts(TEMPLATES.MUSDTransferFactory);
    const allocCheck = await canton.queryContracts(TEMPLATES.MUSDAllocationFactory);
    const transferOk = transferCheck.length > 0;
    const allocOk = allocCheck.length > 0;
    console.log(`  MUSDTransferFactory:    ${transferOk ? "✓ EXISTS" : "✗ MISSING"}`);
    console.log(`  MUSDAllocationFactory:  ${allocOk ? "✓ EXISTS" : "✗ MISSING"}`);
    if (!transferOk || !allocOk) {
        console.error("\n[CIP-56 Init] ✗ Not all factories created. Check errors above.");
        process.exit(1);
    }
    // --- 4. Contract summary ---
    console.log("\n[CIP-56 Init] CIP-56 contracts on ledger:");
    const cip56Contracts = await canton.queryContracts(undefined, (p) => true);
    const cip56Only = cip56Contracts.filter((c) => typeof c.templateId === "string" && c.templateId.includes("CIP56Interfaces"));
    const templateCounts = {};
    for (const c of cip56Only) {
        const parts = c.templateId.split(":");
        const name = parts.length >= 3 ? parts[parts.length - 1] : c.templateId;
        templateCounts[name] = (templateCounts[name] || 0) + 1;
    }
    if (Object.keys(templateCounts).length === 0) {
        console.log("  (no CIP-56 contracts visible — factories may use interface-based templateId)");
        console.log(`  Total CIP-56 factory contracts found: Transfer=${transferCheck.length}, Allocation=${allocCheck.length}`);
    }
    else {
        for (const [tpl, count] of Object.entries(templateCounts).sort()) {
            console.log(`  ${tpl}: ${count}`);
        }
    }
    console.log("\n[CIP-56 Init] ✓ Done! CIP-56 factories are live.");
    console.log("  Next: restart relay and verify 'CIP-56 MUSDTransferFactory detected' log.");
}
initCip56Factories().catch((err) => {
    console.error("[CIP-56 Init] Fatal:", err);
    process.exit(1);
});
//# sourceMappingURL=init-cip56-factories.js.map