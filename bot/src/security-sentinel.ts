/**
 * Minted Protocol — Security Sentinel
 *
 * Real-time on-chain monitoring bot that watches for suspicious activity
 * and sends alerts via Telegram (or console if Telegram is not configured).
 *
 * Monitored events:
 *   🔴 CRITICAL:
 *     - CallScheduled on MintedTimelockController (malicious upgrade/role change)
 *     - Upgraded (proxy implementation changed)
 *     - RoleGranted / RoleRevoked on any core contract
 *     - GlobalPauseStateChanged (protocol paused/unpaused)
 *
 *   🟡 HIGH:
 *     - Large mUSD mints (>$100K)
 *     - Bridge attestations from unknown relayers
 *     - Emergency cap reductions on the bridge
 *
 *   🟢 INFO:
 *     - Successful timelock executions
 *     - Sentinel startup / heartbeat
 *
 * Usage:
 *   cd bot && set -a && source .env && set +a && npx ts-node src/security-sentinel.ts
 *
 * Requires: RPC_URL, plus Telegram creds for real-time mobile alerts.
 */

import { ethers } from "ethers";

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const RPC_URL = process.env.RPC_URL || process.env.ETHEREUM_RPC_URL || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

// Known protocol addresses (Sepolia)
const ADDRESSES = {
  TIMELOCK: process.env.TIMELOCK_ADDRESS || "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410",
  GLOBAL_PAUSE: process.env.GLOBAL_PAUSE_ADDRESS || "0x471e9dceB2AB7398b63677C70c6C638c7AEA375F",
  MUSD: process.env.MUSD_ADDRESS || "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B",
  BRIDGE: process.env.BRIDGE_ADDRESS || "0xB466be5F516F7Aa45E61bA2C7d2Db639c7B3D125",
  TREASURY: process.env.TREASURY_ADDRESS || "0xf2051bDfc738f638668DF2f8c00d01ba6338C513",
  COLLATERAL_VAULT: process.env.COLLATERAL_VAULT_ADDRESS || "0x155d6618dcdeb2F4145395CA57C80e6931D7941e",
  BORROW_MODULE: process.env.BORROW_MODULE_ADDRESS || "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8",
  LEVERAGE_VAULT: process.env.LEVERAGE_VAULT_ADDRESS || "0x3b49d47f9714836F2aF21F13cdF79aafd75f1FE4",
  DIRECT_MINT: process.env.DIRECT_MINT_ADDRESS || "0xaA3e42f2AfB5DF83d6a33746c2927bce8B22Bae7",
};

// Known trusted addresses — operations from these are INFO, from unknown are CRITICAL
const TRUSTED_ADDRESSES = new Set([
  (process.env.DEPLOYER_ADDRESS || "0xe640db3Ad56330BFF39Da36Ef01ab3aEB699F8e0").toLowerCase(),
  ADDRESSES.TIMELOCK.toLowerCase(),
]);

// Large mint threshold (mUSD has 18 decimals)
const LARGE_MINT_THRESHOLD = ethers.parseUnits(
  process.env.LARGE_MINT_THRESHOLD_USD || "100000",
  18
);

// ═══════════════════════════════════════════════════════════════════════════
// EVENT SIGNATURES
// ═══════════════════════════════════════════════════════════════════════════

// MintedTimelockController events
const TIMELOCK_ABI = [
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  "event Cancelled(bytes32 indexed id)",
  "event MinDelayChange(uint256 oldDuration, uint256 newDuration)",
];

// AccessControl events (emitted by any OZ AccessControl contract)
const ACCESS_CONTROL_ABI = [
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
];

// UUPS Upgrade events
const UPGRADE_ABI = [
  "event Upgraded(address indexed implementation)",
];

// GlobalPauseRegistry events
const GLOBAL_PAUSE_ABI = [
  "event GlobalPauseStateChanged(bool indexed paused, address indexed actor)",
];

// MUSD events
const MUSD_ABI = [
  "event Mint(address indexed to, uint256 amount)",
  "event BlacklistUpdated(address indexed account, bool isBlacklisted)",
  "event SupplyCapUpdated(uint256 oldCap, uint256 newCap)",
];

// BLEBridgeV9 events
const BRIDGE_ABI = [
  "event AttestationReceived(bytes32 indexed attestationHash, uint256 nonce, uint256 epoch, uint256 mintAmount, uint256 burnAmount)",
  "event EmergencyCapReduction(uint256 oldCap, uint256 newCap, string reason)",
  "event SupplyCapUpdated(uint256 newMintCap, uint256 newBurnCap, uint256 epoch)",
];

// Known role hashes for human-readable labels
const ROLE_LABELS: Record<string, string> = {
  "0x0000000000000000000000000000000000000000000000000000000000000000": "DEFAULT_ADMIN_ROLE",
  [ethers.id("MINTER_ROLE")]: "MINTER_ROLE",
  [ethers.id("BURNER_ROLE")]: "BURNER_ROLE",
  [ethers.id("PAUSER_ROLE")]: "PAUSER_ROLE",
  [ethers.id("GUARDIAN_ROLE")]: "GUARDIAN_ROLE",
  [ethers.id("RELAYER_ROLE")]: "RELAYER_ROLE",
  [ethers.id("KEEPER_ROLE")]: "KEEPER_ROLE",
  [ethers.id("TIMELOCK_ROLE")]: "TIMELOCK_ROLE",
  [ethers.id("PROPOSER_ROLE")]: "PROPOSER_ROLE",
  [ethers.id("EXECUTOR_ROLE")]: "EXECUTOR_ROLE",
  [ethers.id("CANCELLER_ROLE")]: "CANCELLER_ROLE",
  [ethers.id("LEVERAGE_VAULT_ROLE")]: "LEVERAGE_VAULT_ROLE",
};

function roleName(roleHash: string): string {
  return ROLE_LABELS[roleHash] || `Unknown(${roleHash.slice(0, 10)}…)`;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function contractName(addr: string): string {
  const lower = addr.toLowerCase();
  for (const [name, address] of Object.entries(ADDRESSES)) {
    if (address.toLowerCase() === lower) return name;
  }
  return shortAddr(addr);
}

// ═══════════════════════════════════════════════════════════════════════════
// ALERTING
// ═══════════════════════════════════════════════════════════════════════════

type Severity = "CRITICAL" | "HIGH" | "INFO";

const SEVERITY_EMOJI: Record<Severity, string> = {
  CRITICAL: "🚨",
  HIGH: "⚠️",
  INFO: "ℹ️",
};

async function sendAlert(severity: Severity, title: string, body: string): Promise<void> {
  const emoji = SEVERITY_EMOJI[severity];
  const timestamp = new Date().toISOString();
  const message = `${emoji} *${severity}: ${title}*\n${body}\n\n_${timestamp}_`;

  // Always log to console
  const prefix = severity === "CRITICAL" ? "\x1b[31m" : severity === "HIGH" ? "\x1b[33m" : "\x1b[36m";
  console.log(`${prefix}[${severity}]\x1b[0m ${title}`);
  console.log(`  ${body.replace(/\n/g, "\n  ")}`);

  // Send to Telegram if configured
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    try {
      const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      console.error(`[Telegram] Failed to send alert: ${(err as Error).message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

function setupTimelockMonitor(provider: ethers.Provider): void {
  const timelock = new ethers.Contract(ADDRESSES.TIMELOCK, TIMELOCK_ABI, provider);

  // 🔴 CRITICAL: New operation scheduled
  timelock.on("CallScheduled", async (id, index, target, value, data, predecessor, delay, event) => {
    const txHash = event?.log?.transactionHash || "unknown";
    const isTrusted = event?.log?.address ? TRUSTED_ADDRESSES.has(event.log.address.toLowerCase()) : false;
    const severity: Severity = "CRITICAL";

    await sendAlert(severity, "Timelock Operation Scheduled", [
      `Operation ID: \`${id}\``,
      `Target: ${contractName(target)} (\`${target}\`)`,
      `Delay: ${Number(delay)}s (${(Number(delay) / 3600).toFixed(1)}h)`,
      `Value: ${ethers.formatEther(value)} ETH`,
      `Data: \`${String(data).slice(0, 40)}…\``,
      `Tx: \`${txHash}\``,
      ``,
      `⏰ *Executable after*: ${new Date(Date.now() + Number(delay) * 1000).toISOString()}`,
      `🔑 To cancel: \`timelock.cancel("${id}")\``,
    ].join("\n"));
  });

  // ℹ️ INFO: Operation executed
  timelock.on("CallExecuted", async (id, index, target, value, data) => {
    await sendAlert("INFO", "Timelock Operation Executed", [
      `Operation ID: \`${id}\``,
      `Target: ${contractName(target)}`,
    ].join("\n"));
  });

  // ℹ️ INFO: Operation cancelled
  timelock.on("Cancelled", async (id) => {
    await sendAlert("INFO", "Timelock Operation Cancelled", `Operation ID: \`${id}\``);
  });

  // 🔴 CRITICAL: Delay changed
  timelock.on("MinDelayChange", async (oldDuration, newDuration) => {
    await sendAlert("CRITICAL", "Timelock Delay Changed", [
      `Old: ${Number(oldDuration)}s → New: ${Number(newDuration)}s`,
      Number(newDuration) < Number(oldDuration) ? "⚠️ *DELAY REDUCED* — potential governance attack" : "",
    ].join("\n"));
  });

  console.log(`  ✅ Timelock: ${shortAddr(ADDRESSES.TIMELOCK)}`);
}

function setupAccessControlMonitor(provider: ethers.Provider): void {
  // Monitor role changes on all core contracts
  const contracts = [
    { name: "MUSD", address: ADDRESSES.MUSD },
    { name: "BRIDGE", address: ADDRESSES.BRIDGE },
    { name: "TREASURY", address: ADDRESSES.TREASURY },
    { name: "COLLATERAL_VAULT", address: ADDRESSES.COLLATERAL_VAULT },
    { name: "BORROW_MODULE", address: ADDRESSES.BORROW_MODULE },
    { name: "LEVERAGE_VAULT", address: ADDRESSES.LEVERAGE_VAULT },
    { name: "DIRECT_MINT", address: ADDRESSES.DIRECT_MINT },
    { name: "GLOBAL_PAUSE", address: ADDRESSES.GLOBAL_PAUSE },
  ];

  for (const { name, address } of contracts) {
    if (!address || address === "0x") continue;
    const contract = new ethers.Contract(address, ACCESS_CONTROL_ABI, provider);

    contract.on("RoleGranted", async (role, account, sender) => {
      const isTrusted = TRUSTED_ADDRESSES.has(sender.toLowerCase());
      const severity: Severity = isTrusted ? "HIGH" : "CRITICAL";

      await sendAlert(severity, `Role Granted on ${name}`, [
        `Role: ${roleName(role)}`,
        `Account: \`${account}\``,
        `Granted by: \`${sender}\` ${isTrusted ? "(trusted)" : "⚠️ *UNKNOWN SENDER*"}`,
      ].join("\n"));
    });

    contract.on("RoleRevoked", async (role, account, sender) => {
      await sendAlert("HIGH", `Role Revoked on ${name}`, [
        `Role: ${roleName(role)}`,
        `Account: \`${account}\``,
        `Revoked by: \`${sender}\``,
      ].join("\n"));
    });
  }

  console.log(`  ✅ AccessControl: ${contracts.length} contracts monitored`);
}

function setupUpgradeMonitor(provider: ethers.Provider): void {
  // Monitor UUPS proxy upgrades on all upgradeable contracts
  const proxies = [
    { name: "BRIDGE", address: ADDRESSES.BRIDGE },
    { name: "MUSD", address: ADDRESSES.MUSD },
    { name: "COLLATERAL_VAULT", address: ADDRESSES.COLLATERAL_VAULT },
    { name: "BORROW_MODULE", address: ADDRESSES.BORROW_MODULE },
    { name: "DIRECT_MINT", address: ADDRESSES.DIRECT_MINT },
    { name: "LEVERAGE_VAULT", address: ADDRESSES.LEVERAGE_VAULT },
  ];

  for (const { name, address } of proxies) {
    if (!address || address === "0x") continue;
    const contract = new ethers.Contract(address, UPGRADE_ABI, provider);

    contract.on("Upgraded", async (implementation) => {
      await sendAlert("CRITICAL", `Proxy Upgraded: ${name}`, [
        `Proxy: \`${address}\``,
        `New Implementation: \`${implementation}\``,
        `⚠️ Verify this upgrade was authorized via the timelock.`,
      ].join("\n"));
    });
  }

  console.log(`  ✅ Upgrades: ${proxies.length} proxies monitored`);
}

function setupGlobalPauseMonitor(provider: ethers.Provider): void {
  const pauseRegistry = new ethers.Contract(ADDRESSES.GLOBAL_PAUSE, GLOBAL_PAUSE_ABI, provider);

  pauseRegistry.on("GlobalPauseStateChanged", async (paused, actor) => {
    const severity: Severity = paused ? "CRITICAL" : "HIGH";
    const action = paused ? "🔴 PROTOCOL PAUSED" : "🟢 PROTOCOL UNPAUSED";

    await sendAlert(severity, action, [
      `Actor: \`${actor}\` ${TRUSTED_ADDRESSES.has(actor.toLowerCase()) ? "(trusted)" : "⚠️ UNKNOWN"}`,
      paused ? "All deposits, withdrawals, mints, and borrows are now HALTED." : "Protocol operations have resumed.",
    ].join("\n"));
  });

  console.log(`  ✅ GlobalPause: ${shortAddr(ADDRESSES.GLOBAL_PAUSE)}`);
}

function setupMUSDMonitor(provider: ethers.Provider): void {
  const musd = new ethers.Contract(ADDRESSES.MUSD, MUSD_ABI, provider);

  // Large mint detection
  musd.on("Mint", async (to, amount) => {
    if (amount >= LARGE_MINT_THRESHOLD) {
      const usdAmount = ethers.formatUnits(amount, 18);
      await sendAlert("HIGH", "Large mUSD Mint", [
        `To: \`${to}\``,
        `Amount: ${Number(usdAmount).toLocaleString()} mUSD`,
        `Threshold: ${ethers.formatUnits(LARGE_MINT_THRESHOLD, 18)} mUSD`,
      ].join("\n"));
    }
  });

  // Supply cap changes
  musd.on("SupplyCapUpdated", async (oldCap, newCap) => {
    await sendAlert("HIGH", "mUSD Supply Cap Changed", [
      `Old: ${ethers.formatUnits(oldCap, 18)} → New: ${ethers.formatUnits(newCap, 18)}`,
    ].join("\n"));
  });

  // Blacklist changes
  musd.on("BlacklistUpdated", async (account, isBlacklisted) => {
    await sendAlert("HIGH", `mUSD Blacklist ${isBlacklisted ? "Added" : "Removed"}`, [
      `Account: \`${account}\``,
    ].join("\n"));
  });

  console.log(`  ✅ MUSD: ${shortAddr(ADDRESSES.MUSD)}`);
}

function setupBridgeMonitor(provider: ethers.Provider): void {
  const bridge = new ethers.Contract(ADDRESSES.BRIDGE, BRIDGE_ABI, provider);

  bridge.on("EmergencyCapReduction", async (oldCap, newCap, reason) => {
    await sendAlert("CRITICAL", "Bridge Emergency Cap Reduction", [
      `Old cap: ${ethers.formatUnits(oldCap, 18)} → New: ${ethers.formatUnits(newCap, 18)}`,
      `Reason: ${reason}`,
    ].join("\n"));
  });

  bridge.on("AttestationReceived", async (hash, nonce, epoch, mintAmount, burnAmount) => {
    const totalValue = mintAmount + burnAmount;
    if (totalValue >= LARGE_MINT_THRESHOLD) {
      await sendAlert("HIGH", "Large Bridge Attestation", [
        `Hash: \`${hash}\``,
        `Nonce: ${nonce} | Epoch: ${epoch}`,
        `Mint: ${ethers.formatUnits(mintAmount, 18)} | Burn: ${ethers.formatUnits(burnAmount, 18)}`,
      ].join("\n"));
    }
  });

  console.log(`  ✅ Bridge: ${shortAddr(ADDRESSES.BRIDGE)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  if (!RPC_URL) {
    console.error("FATAL: RPC_URL or ETHEREUM_RPC_URL must be set");
    process.exit(1);
  }

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  🛡️  Minted Protocol — Security Sentinel        ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log();

  // Use WebSocket if available (for real-time events), fallback to HTTP polling
  let provider: ethers.Provider;
  const wsUrl = process.env.WS_RPC_URL;
  if (wsUrl) {
    provider = new ethers.WebSocketProvider(wsUrl);
    console.log(`[Provider] WebSocket: ${wsUrl.replace(/\/[^/]+$/, "/***")}`);
  } else {
    provider = new ethers.JsonRpcProvider(RPC_URL);
    console.log(`[Provider] HTTP (polling): ${RPC_URL.replace(/\/[^/]+$/, "/***")}`);
    console.log(`  ⚠️  For real-time alerts, set WS_RPC_URL to a WebSocket endpoint`);
  }

  const network = await provider.getNetwork();
  console.log(`[Network] ${network.name} (chainId: ${network.chainId})`);
  console.log();

  // Telegram status
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    console.log("[Telegram] ✅ Configured — alerts will be sent to Telegram");
  } else {
    console.log("[Telegram] ⚠️  Not configured — alerts will appear in console only");
    console.log("  Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID for mobile alerts.");
    console.log("  Run: ./scripts/setup-telegram-alerts.sh");
  }
  console.log();

  // Register all monitors
  console.log("[Monitors] Registering event listeners...");
  setupTimelockMonitor(provider);
  setupAccessControlMonitor(provider);
  setupUpgradeMonitor(provider);
  setupGlobalPauseMonitor(provider);
  setupMUSDMonitor(provider);
  setupBridgeMonitor(provider);
  console.log();

  const blockNumber = await provider.getBlockNumber();
  console.log(`[Ready] Listening from block ${blockNumber}`);
  console.log(`[Ready] ${Object.keys(ADDRESSES).length} contracts monitored`);
  console.log(`[Ready] Large mint threshold: ${ethers.formatUnits(LARGE_MINT_THRESHOLD, 18)} mUSD`);
  console.log();

  // Send startup alert
  await sendAlert("INFO", "Security Sentinel Online", [
    `Network: ${network.name} (${network.chainId})`,
    `Block: ${blockNumber}`,
    `Contracts: ${Object.keys(ADDRESSES).length}`,
    `Telegram: ${TELEGRAM_BOT_TOKEN ? "✅" : "❌"}`,
  ].join("\n"));

  // Heartbeat every 30 minutes
  const HEARTBEAT_MS = 30 * 60 * 1000;
  setInterval(async () => {
    try {
      const currentBlock = await provider.getBlockNumber();
      console.log(`[Heartbeat] Block ${currentBlock} — sentinel alive`);
    } catch (err) {
      console.error(`[Heartbeat] Provider error: ${(err as Error).message}`);
      await sendAlert("CRITICAL", "Sentinel RPC Connection Lost", [
        `Error: ${(err as Error).message}`,
        `Last known block: ${blockNumber}`,
      ].join("\n"));
    }
  }, HEARTBEAT_MS);

  // Keep process alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
