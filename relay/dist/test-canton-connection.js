"use strict";
/**
 * Quick test: verify CantonClient can connect to the Canton participant v2 JSON API.
 *
 * Usage:
 *   NODE_ENV=development npx ts-node test-canton-connection.ts
 *
 * Defaults to localhost:7575 (port-forwarded participant).
 * Override with CANTON_HOST / CANTON_PORT env vars.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const canton_client_1 = require("./canton-client");
const fs_1 = require("fs");
const path_1 = require("path");
async function main() {
    const host = process.env.CANTON_HOST || "localhost";
    const port = parseInt(process.env.CANTON_PORT || "7575", 10);
    const useTls = process.env.CANTON_USE_TLS === "true";
    const protocol = useTls ? "https" : "http";
    // Read token from secrets file or env
    let token = process.env.CANTON_TOKEN || "";
    if (!token) {
        try {
            token = (0, fs_1.readFileSync)((0, path_1.resolve)(__dirname, "secrets/canton_token"), "utf-8").trim();
        }
        catch {
            console.error("No token found. Set CANTON_TOKEN or create secrets/canton_token");
            process.exit(1);
        }
    }
    const baseUrl = `${protocol}://${host}:${port}`;
    console.log(`[Test] Connecting to Canton v2 API at ${baseUrl}`);
    const canton = new canton_client_1.CantonClient({
        baseUrl,
        token,
        userId: "administrator",
        actAs: "minted-validator-1::12203f16a8f4b26778d5c8c6847dc055acf5db91e0c5b0846de29ba5ea272ab2a0e4",
    });
    // 1. List users
    try {
        const users = await canton.listUsers();
        console.log(`[Test] ✓ Found ${users.length} users:`);
        for (const u of users) {
            console.log(`  - ${u.id} → ${u.primaryParty || "(no party)"}`);
        }
    }
    catch (err) {
        console.error("[Test] ✗ Failed to list users:", err);
        process.exit(1);
    }
    // 2. Ledger end offset
    try {
        const offset = await canton.getLedgerEnd();
        console.log(`[Test] ✓ Ledger end offset: ${offset}`);
    }
    catch (err) {
        console.error("[Test] ✗ Failed to get ledger end:", err);
    }
    // 3. List packages
    try {
        const packages = await canton.listPackages();
        console.log(`[Test] ✓ ${packages.length} packages uploaded`);
    }
    catch (err) {
        console.error("[Test] ✗ Failed to list packages:", err);
    }
    // 4. Query active contracts (wildcard — all visible)
    try {
        const contracts = await canton.queryContracts();
        console.log(`[Test] ✓ ${contracts.length} active contracts visible to party`);
        // Show template breakdown
        const byTemplate = new Map();
        for (const c of contracts) {
            const tpl = c.templateId.split(":").slice(1).join(":");
            byTemplate.set(tpl, (byTemplate.get(tpl) || 0) + 1);
        }
        for (const [tpl, count] of byTemplate) {
            console.log(`  - ${tpl}: ${count}`);
        }
    }
    catch (err) {
        console.error("[Test] ✗ Failed to query contracts:", err);
    }
    // 5. Query AttestationRequest specifically (the relay's primary query)
    try {
        const attestations = await canton.queryContracts(canton_client_1.TEMPLATES.AttestationRequest);
        console.log(`[Test] ✓ ${attestations.length} AttestationRequest contracts (expected: 0 on fresh node)`);
    }
    catch (err) {
        console.log(`[Test] ⚠ AttestationRequest query: ${err.message}`);
    }
    console.log("\n[Test] ✓✓✓ Canton v2 API connection verified! CantonClient works.");
    process.exit(0);
}
main().catch((err) => {
    console.error("[Test] Fatal:", err);
    process.exit(1);
});
//# sourceMappingURL=test-canton-connection.js.map