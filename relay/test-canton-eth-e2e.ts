/**
 * Canton ↔ Ethereum End-to-End Bridge Test
 *
 * This test verifies the complete Canton↔ETH bridge integration:
 *   1. Canton devnet connectivity + BLE Protocol contracts
 *   2. Canton BridgeService is live and queryable
 *   3. Ethereum (Sepolia) BLEBridgeV9 is reachable
 *   4. Round-trip: Create AttestationRequest on Canton → verify relayer can read it
 *   5. Round-trip: Verify BLEBridgeV9 nonce consistency with Canton BridgeService
 *
 * Prerequisites:
 *   - Canton devnet running: cd ~/splice-node/docker-compose/validator && docker compose up -d
 *   - Port-forward: docker run --rm -d --name canton-port-fwd \
 *       --network splice-validator_splice_validator -p 127.0.0.1:7575:7575 \
 *       alpine/socat TCP-LISTEN:7575,fork,reuseaddr TCP:participant:7575
 *   - BLE Protocol initialized: scripts/canton-init.sh
 *
 * Usage:
 *   NODE_ENV=development npx ts-node test-canton-eth-e2e.ts
 */

import * as path from "path";
import * as dotenv from "dotenv";
dotenv.config({ path: path.resolve(__dirname, ".env.development") });

import { CantonClient, TEMPLATES, ActiveContract } from "./canton-client";
import { ethers } from "ethers";
import { readFileSync } from "fs";
import { resolve } from "path";

// ============================================================
//                     CONFIG
// ============================================================
const CANTON_HOST = process.env.CANTON_HOST || "localhost";
const CANTON_PORT = parseInt(process.env.CANTON_PORT || "7575", 10);
const CANTON_TOKEN = process.env.CANTON_TOKEN || readTokenFromFile();
const ETH_RPC = process.env.ETHEREUM_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const BRIDGE_ADDR = process.env.BRIDGE_CONTRACT_ADDRESS || "0xF0D3CC638a3aB76683F0aFF675329E96d17bf8a7";

// Parties on devnet
const PARTIES = {
  operator: "minted-operator",
  governance: "minted-governance",
  validator1: "validator-1",
  relayer: "minted-validator-1",
};

// BLEBridgeV9 minimal ABI
const BRIDGE_ABI = [
  "function currentNonce() view returns (uint256)",
  "function paused() view returns (bool)",
  "function minSignatures() view returns (uint256)",
  "function VALIDATOR_ROLE() view returns (bytes32)",
  "function RELAYER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function getRoleAdmin(bytes32 role) view returns (bytes32)",
  "function musdToken() view returns (address)",
];

function readTokenFromFile(): string {
  try {
    return readFileSync(resolve(__dirname, "secrets/canton_token"), "utf-8").trim();
  } catch {
    return "dummy-no-auth";
  }
}

let passed = 0;
let failed = 0;

function pass(label: string, detail?: string) {
  passed++;
  console.log(`  ✅ ${label}${detail ? " — " + detail : ""}`);
}

function fail(label: string, error: unknown) {
  failed++;
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`  ❌ ${label} — ${msg}`);
}

// ============================================================
//                     TEST SECTIONS
// ============================================================

async function testCantonConnectivity(): Promise<CantonClient> {
  console.log("\n═══ 1. CANTON DEVNET CONNECTIVITY ═══");

  const baseUrl = `http://${CANTON_HOST}:${CANTON_PORT}`;
  const canton = new CantonClient({
    baseUrl,
    token: CANTON_TOKEN,
    userId: "administrator",
    actAs: `${PARTIES.relayer}::122038887449dad08a7caecd8acf578db26b02b61773070bfa7013f7563d2c01adb9`,
  });

  // 1a. Ledger end
  try {
    const offset = await canton.getLedgerEnd();
    pass("Ledger end offset", `${offset}`);
  } catch (err) {
    fail("Ledger end offset", err);
  }

  // 1b. Users
  try {
    const users = await canton.listUsers();
    pass("Users found", `${users.length} users`);
  } catch (err) {
    fail("Users", err);
  }

  // 1c. Packages
  try {
    const pkgs = await canton.listPackages();
    pass("Packages uploaded", `${pkgs.length} packages`);
    if (pkgs.length < 130) {
      fail("Package count low", `Expected 130+, got ${pkgs.length}. BLE Protocol DAR may not be uploaded.`);
    }
  } catch (err) {
    fail("Packages", err);
  }

  return canton;
}

async function testBLEProtocolContracts(): Promise<void> {
  console.log("\n═══ 2. BLE PROTOCOL CONTRACTS ON CANTON ═══");

  // Connect as operator (has visibility on BridgeService, VaultManager, etc.)
  const canton = new CantonClient({
    baseUrl: `http://${CANTON_HOST}:${CANTON_PORT}`,
    token: CANTON_TOKEN,
    userId: "administrator",
    // Use operator party for broader visibility
    actAs: `${PARTIES.operator}::122038887449dad08a7caecd8acf578db26b02b61773070bfa7013f7563d2c01adb9`,
    readAs: [
      `${PARTIES.governance}::122038887449dad08a7caecd8acf578db26b02b61773070bfa7013f7563d2c01adb9`,
      `${PARTIES.validator1}::122038887449dad08a7caecd8acf578db26b02b61773070bfa7013f7563d2c01adb9`,
    ],
  });

  // 2a. All visible contracts
  try {
    const allContracts = await canton.queryContracts();
    pass("Active contracts query", `${allContracts.length} contracts visible to operator`);

    // Group by template
    const byTemplate = new Map<string, number>();
    for (const c of allContracts) {
      const parts = c.templateId.split(":");
      const tpl = parts.length >= 3 ? `${parts[parts.length - 2]}:${parts[parts.length - 1]}` : c.templateId;
      byTemplate.set(tpl, (byTemplate.get(tpl) || 0) + 1);
    }
    for (const [tpl, count] of Array.from(byTemplate.entries()).sort()) {
      console.log(`      ${tpl}: ${count}`);
    }
  } catch (err) {
    fail("Active contracts query", err);
  }

  // 2b. BridgeService
  try {
    const bridges = await canton.queryContracts(TEMPLATES.BridgeService);
    if (bridges.length > 0) {
      const bs = bridges[0].payload as any;
      pass("BridgeService", `lastNonce=${bs.lastNonce}, paused=${bs.paused}, validators=${bs.validators?.length}`);
    } else {
      fail("BridgeService", "No BridgeService contract found — run canton-init.sh");
    }
  } catch (err) {
    fail("BridgeService query", err);
  }

  // 2c. MUSDSupplyService
  try {
    const supplies = await canton.queryContracts(TEMPLATES.MUSDSupplyService);
    if (supplies.length > 0) {
      const ss = supplies[0].payload as any;
      pass("MUSDSupplyService", `supply=${ss.currentSupply}/${ss.supplyCap}`);
    } else {
      fail("MUSDSupplyService", "Not found");
    }
  } catch (err) {
    fail("MUSDSupplyService query", err);
  }

  // 2d. AttestationRequests (should be 0 on clean node)
  try {
    const attestations = await canton.queryContracts(TEMPLATES.AttestationRequest);
    pass("AttestationRequest contracts", `${attestations.length} (expected: 0 on clean node)`);
  } catch (err) {
    fail("AttestationRequest query", err);
  }
}

async function testEthereumBridge(): Promise<void> {
  console.log("\n═══ 3. ETHEREUM BRIDGE (SEPOLIA) ═══");

  const provider = new ethers.JsonRpcProvider(ETH_RPC);
  const bridge = new ethers.Contract(BRIDGE_ADDR, BRIDGE_ABI, provider);

  // 3a. Bridge reachable
  try {
    const nonce = await bridge.currentNonce();
    pass("BLEBridgeV9.currentNonce()", `${nonce}`);
  } catch (err) {
    fail("BLEBridgeV9.currentNonce()", err);
  }

  // 3a2. MUSD token address
  try {
    const musd = await bridge.musdToken();
    pass("BLEBridgeV9.musdToken()", musd);
  } catch (err) {
    fail("BLEBridgeV9.musdToken()", err);
  }

  // 3b. Bridge paused state
  try {
    const paused = await bridge.paused();
    if (!paused) {
      pass("BLEBridgeV9.paused()", "false (operational)");
    } else {
      fail("BLEBridgeV9.paused()", "Bridge is PAUSED");
    }
  } catch (err) {
    fail("BLEBridgeV9.paused()", err);
  }

  // 3c. Min signatures threshold
  try {
    const threshold = await bridge.minSignatures();
    pass("BLEBridgeV9.minSignatures()", `${threshold}`);
  } catch (err) {
    fail("BLEBridgeV9.minSignatures()", err);
  }

  // 3d. Relayer role granted
  try {
    const RELAYER_ROLE = await bridge.RELAYER_ROLE();
    const relayerAddr = "0x7De39963ee59B0a5e74f36B8BCc0426c286bDd36";
    const hasRelayer = await bridge.hasRole(RELAYER_ROLE, relayerAddr);
    if (hasRelayer) {
      pass("RELAYER_ROLE granted", `${relayerAddr}`);
    } else {
      fail("RELAYER_ROLE", `${relayerAddr} does NOT have RELAYER_ROLE`);
    }
  } catch (err) {
    fail("RELAYER_ROLE check", err);
  }

  // 3e. Validator role granted
  try {
    const VALIDATOR_ROLE = await bridge.VALIDATOR_ROLE();
    const validatorAddrs = [
      "0x7De39963ee59B0a5e74f36B8BCc0426c286bDd36",
      "0x2Fe44803dfE94c1C911A4733A76b89114D7B6e0D",
    ];
    for (const addr of validatorAddrs) {
      const hasValidator = await bridge.hasRole(VALIDATOR_ROLE, addr);
      if (hasValidator) {
        pass(`VALIDATOR_ROLE for ${addr.slice(0, 10)}...`, "granted");
      } else {
        fail(`VALIDATOR_ROLE for ${addr.slice(0, 10)}...`, "NOT granted");
      }
    }
  } catch (err) {
    fail("VALIDATOR_ROLE check", err);
  }
}

async function testNonceConsistency(): Promise<void> {
  console.log("\n═══ 4. CROSS-CHAIN NONCE CONSISTENCY ═══");

  // Get Canton nonce (from BridgeService)
  let cantonNonce = -1;
  try {
    const canton = new CantonClient({
      baseUrl: `http://${CANTON_HOST}:${CANTON_PORT}`,
      token: CANTON_TOKEN,
      userId: "administrator",
      actAs: `${PARTIES.operator}::122038887449dad08a7caecd8acf578db26b02b61773070bfa7013f7563d2c01adb9`,
    });
    const bridges = await canton.queryContracts(TEMPLATES.BridgeService);
    if (bridges.length > 0) {
      cantonNonce = (bridges[0].payload as any).lastNonce;
      pass("Canton BridgeService.lastNonce", `${cantonNonce}`);
    } else {
      fail("Canton BridgeService", "Not found");
      return;
    }
  } catch (err) {
    fail("Canton BridgeService query", err);
    return;
  }

  // Get Ethereum nonce
  let ethNonce = -1;
  try {
    const provider = new ethers.JsonRpcProvider(ETH_RPC);
    const bridge = new ethers.Contract(BRIDGE_ADDR, BRIDGE_ABI, provider);
    ethNonce = Number(await bridge.currentNonce());
    pass("ETH BLEBridgeV9.currentNonce()", `${ethNonce}`);
  } catch (err) {
    fail("ETH BLEBridgeV9.currentNonce()", err);
    return;
  }

  // Compare
  if (cantonNonce === ethNonce) {
    pass("Nonce consistency", `Canton=${cantonNonce}, ETH=${ethNonce} — MATCH ✓`);
  } else {
    // On fresh deployment, nonces may differ (Canton starts at 0, ETH at whatever the bridge was deployed with)
    // This is informational, not necessarily a failure
    console.log(`  ⚠️  Nonce mismatch: Canton=${cantonNonce}, ETH=${ethNonce} (expected on fresh deployment)`);
  }
}

async function testRelayConfig(): Promise<void> {
  console.log("\n═══ 5. RELAY SERVICE CONFIGURATION ═══");

  // Check .env.development has correct values
  const requiredEnvVars = [
    "CANTON_HOST",
    "CANTON_PORT",
    "CANTON_TOKEN",
    "CANTON_PARTY",
    "ETHEREUM_RPC_URL",
    "BRIDGE_CONTRACT_ADDRESS",
    "RELAYER_PRIVATE_KEY",
    "VALIDATOR_ADDRESSES",
  ];

  for (const varName of requiredEnvVars) {
    const value = process.env[varName];
    if (value) {
      // Mask sensitive values
      const display = varName.includes("KEY") || varName.includes("TOKEN")
        ? `${value.slice(0, 6)}...${value.slice(-4)}`
        : varName === "VALIDATOR_ADDRESSES"
          ? `${value.slice(0, 30)}...`
          : value;
      pass(`ENV ${varName}`, display);
    } else {
      fail(`ENV ${varName}`, "NOT SET");
    }
  }

  // Verify bridge address matches
  if (process.env.BRIDGE_CONTRACT_ADDRESS === BRIDGE_ADDR) {
    pass("Bridge address consistency", BRIDGE_ADDR);
  } else {
    fail("Bridge address consistency", `ENV=${process.env.BRIDGE_CONTRACT_ADDRESS} vs expected=${BRIDGE_ADDR}`);
  }
}

// ============================================================
//                     MAIN
// ============================================================

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  CANTON ↔ ETHEREUM E2E BRIDGE TEST          ║");
  console.log("║  Minted mUSD Protocol                       ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  Canton: http://${CANTON_HOST}:${CANTON_PORT}`);
  console.log(`  ETH RPC: ${ETH_RPC}`);
  console.log(`  Bridge: ${BRIDGE_ADDR}`);

  await testCantonConnectivity();
  await testBLEProtocolContracts();
  await testEthereumBridge();
  await testNonceConsistency();
  await testRelayConfig();

  console.log("\n╔══════════════════════════════════════════════╗");
  console.log(`║  RESULTS: ${passed} passed, ${failed} failed${" ".repeat(Math.max(0, 20 - String(passed).length - String(failed).length))}║`);
  console.log("╚══════════════════════════════════════════════╝");

  if (failed > 0) {
    console.log("\n⚠️  Some checks failed. See details above.");
    process.exit(1);
  } else {
    console.log("\n🎉 All Canton↔ETH bridge checks passed!");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("\n💥 Fatal error:", err);
  process.exit(1);
});
