#!/usr/bin/env npx ts-node --skip-project
/**
 * devnet-fund-and-restore-alias.ts — Safely fund a user party and restore alias mappings.
 *
 * Dry-run by default. Pass --execute to apply changes.
 *
 * Usage:
 *   npx ts-node --skip-project scripts/devnet-fund-and-restore-alias.ts \
 *     --user-party "minted-user-abc::1220..." \
 *     [--base-url http://localhost:3001] \
 *     [--musd 100] [--usdc 50] [--usdcx 50] \
 *     [--execute]
 */

import * as fs from "fs";
import * as path from "path";

// ── Arg parsing ──────────────────────────────────────────────────────

interface Args {
  userParty: string;
  baseUrl: string;
  musd: number;
  usdc: number;
  usdcx: number;
  execute: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const result: Args = {
    userParty: "",
    baseUrl: "http://localhost:3001",
    musd: 100,
    usdc: 50,
    usdcx: 50,
    execute: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--user-party":
        result.userParty = args[++i];
        break;
      case "--base-url":
        result.baseUrl = args[++i];
        break;
      case "--musd":
        result.musd = parseFloat(args[++i]);
        break;
      case "--usdc":
        result.usdc = parseFloat(args[++i]);
        break;
      case "--usdcx":
        result.usdcx = parseFloat(args[++i]);
        break;
      case "--execute":
        result.execute = true;
        break;
      default:
        console.error(`Unknown arg: ${args[i]}`);
        process.exit(1);
    }
  }

  return result;
}

// ── Validation ───────────────────────────────────────────────────────

const CANTON_PARTY_PATTERN = /^[A-Za-z0-9._:-]+::1220[0-9a-f]{64}$/i;

function validateParty(party: string): void {
  if (!party) {
    console.error("ERROR: --user-party is required");
    process.exit(1);
  }
  if (!CANTON_PARTY_PATTERN.test(party)) {
    console.error(`ERROR: Invalid Canton party format: "${party.slice(0, 40)}..."`);
    console.error("  Expected: <hint>::1220<64-hex-chars>");
    process.exit(1);
  }
}

// ── .env.local update ────────────────────────────────────────────────

function updateEnvLocal(args: Args): void {
  const envPath = path.resolve(process.cwd(), ".env.local");

  if (!fs.existsSync(envPath)) {
    console.error(`ERROR: ${envPath} not found`);
    process.exit(1);
  }

  const content = fs.readFileSync(envPath, "utf-8");

  // Extract the alias key(s) from existing config
  const aliasMatch = content.match(/CANTON_RECIPIENT_PARTY_ALIASES=(.+)/);
  if (!aliasMatch) {
    console.log("  No CANTON_RECIPIENT_PARTY_ALIASES found — skipping alias update");
    return;
  }

  let aliasJson: Record<string, string>;
  try {
    aliasJson = JSON.parse(aliasMatch[1]);
  } catch {
    console.error("  ERROR: Failed to parse existing CANTON_RECIPIENT_PARTY_ALIASES");
    return;
  }

  // Remap all alias values to the user party
  const updated: Record<string, string> = {};
  for (const key of Object.keys(aliasJson)) {
    updated[key] = args.userParty;
  }

  const newAliasLine = `CANTON_RECIPIENT_PARTY_ALIASES=${JSON.stringify(updated)}`;
  const newPubAliasLine = `NEXT_PUBLIC_CANTON_PARTY_ALIASES_JSON=${JSON.stringify(updated)}`;

  console.log("\n  Planned .env.local changes:");
  console.log(`    CANTON_RECIPIENT_PARTY_ALIASES -> map to ${args.userParty.slice(0, 30)}...`);
  console.log(`    NEXT_PUBLIC_CANTON_PARTY_ALIASES_JSON -> same`);

  // Ensure user party is in DEVNET_FAUCET_ALLOWLIST
  const allowlistMatch = content.match(/DEVNET_FAUCET_ALLOWLIST=(.+)/);
  let allowlistUpdate = "";
  if (allowlistMatch) {
    const existing = allowlistMatch[1];
    if (!existing.includes(args.userParty.split("::")[0])) {
      allowlistUpdate = `${existing},${args.userParty}`;
      console.log(`    DEVNET_FAUCET_ALLOWLIST -> add ${args.userParty.slice(0, 30)}...`);
    }
  }

  if (!args.execute) {
    console.log("\n  DRY RUN: No changes applied. Pass --execute to apply.");
    return;
  }

  // Backup
  const backupPath = `${envPath}.bak.${Date.now()}`;
  fs.copyFileSync(envPath, backupPath);
  console.log(`\n  Backup: ${backupPath}`);

  // Apply changes
  let newContent = content;
  newContent = newContent.replace(
    /CANTON_RECIPIENT_PARTY_ALIASES=.+/,
    newAliasLine
  );
  newContent = newContent.replace(
    /NEXT_PUBLIC_CANTON_PARTY_ALIASES_JSON=.+/,
    newPubAliasLine
  );
  if (allowlistUpdate) {
    newContent = newContent.replace(
      /DEVNET_FAUCET_ALLOWLIST=.+/,
      `DEVNET_FAUCET_ALLOWLIST=${allowlistUpdate}`
    );
  }

  // Atomic write via temp file
  const tmpPath = `${envPath}.tmp`;
  fs.writeFileSync(tmpPath, newContent, "utf-8");
  fs.renameSync(tmpPath, envPath);
  console.log("  .env.local updated successfully");
}

// ── Funding API calls ────────────────────────────────────────────────

async function fundParty(args: Args): Promise<number> {
  if (!args.execute) {
    console.log("\n  Planned funding:");
    console.log(`    mUSD: ${args.musd} via ${args.baseUrl}/api/canton-devnet-fund-musd`);
    console.log(`    USDC: ${args.usdc} via ${args.baseUrl}/api/canton-devnet-faucet`);
    console.log(`    USDCx: ${args.usdcx} via ${args.baseUrl}/api/canton-devnet-faucet`);
    console.log("\n  DRY RUN: No API calls made.");
    return 0;
  }

  console.log("\n  Funding party...");
  let failures = 0;

  // Fund mUSD
  try {
    const resp = await fetch(`${args.baseUrl}/api/canton-devnet-fund-musd`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ party: args.userParty, amount: String(args.musd) }),
    });
    const body = await resp.text();
    console.log(`    mUSD ${args.musd}: ${resp.status} ${body.slice(0, 100)}`);
    if (!resp.ok) {
      console.error(`    ERROR: mUSD funding returned non-2xx status ${resp.status}`);
      failures++;
    }
  } catch (e: any) {
    console.error(`    mUSD funding failed: ${e.message}`);
    console.error("    Is the frontend running? Check: curl " + args.baseUrl);
    failures++;
  }

  // Fund USDC
  try {
    const resp = await fetch(`${args.baseUrl}/api/canton-devnet-faucet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ party: args.userParty, asset: "USDC", amount: String(args.usdc) }),
    });
    const body = await resp.text();
    console.log(`    USDC ${args.usdc}: ${resp.status} ${body.slice(0, 100)}`);
    if (!resp.ok) {
      console.error(`    ERROR: USDC funding returned non-2xx status ${resp.status}`);
      failures++;
    }
  } catch (e: any) {
    console.error(`    USDC funding failed: ${e.message}`);
    failures++;
  }

  // Fund USDCx
  try {
    const resp = await fetch(`${args.baseUrl}/api/canton-devnet-faucet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ party: args.userParty, asset: "USDCx", amount: String(args.usdcx) }),
    });
    const body = await resp.text();
    console.log(`    USDCx ${args.usdcx}: ${resp.status} ${body.slice(0, 100)}`);
    if (!resp.ok) {
      console.error(`    ERROR: USDCx funding returned non-2xx status ${resp.status}`);
      failures++;
    }
  } catch (e: any) {
    console.error(`    USDCx funding failed: ${e.message}`);
    failures++;
  }

  return failures;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  console.log("=== Devnet: Fund & Restore Alias ===");
  console.log(`  Mode: ${args.execute ? "EXECUTE" : "DRY RUN"}`);
  console.log(`  User party: ${args.userParty || "(not set)"}`);
  console.log(`  Base URL: ${args.baseUrl}`);

  validateParty(args.userParty);

  // Step 1: Update .env.local
  console.log("\n--- Step 1: Update .env.local ---");
  updateEnvLocal(args);

  // Step 2: Fund the party
  console.log("\n--- Step 2: Fund party ---");
  const fundingFailures = await fundParty(args);

  // Step 3: Next steps
  console.log("\n--- Next steps ---");
  if (args.execute) {
    if (fundingFailures > 0) {
      console.error(`\n  ERROR: ${fundingFailures} funding call(s) failed. Review output above.`);
      process.exit(1);
    }
    console.log("  1. Restart the frontend dev server");
    console.log("  2. Connect the wallet and verify balances");
    console.log("  3. Check: curl http://localhost:3001/api/canton-balances?party=<user-party>");
  } else {
    console.log("  Re-run with --execute to apply changes.");
  }
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
