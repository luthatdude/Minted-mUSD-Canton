/**
 * Minted Protocol — 🚨 Red Alert Security Sentinel
 *
 * Real-time on-chain monitoring bot with ONE-TAP emergency response.
 * When a CRITICAL event is detected, you get a Telegram alert with
 * inline buttons to PAUSE the protocol or CANCEL a timelock operation
 * — directly from your phone.
 *
 * Monitored events:
 *   🔴 CRITICAL (with action buttons):
 *     - CallScheduled on MintedTimelockController → [🔴 PAUSE] [❌ CANCEL OP]
 *     - Upgraded (proxy implementation changed) → [🔴 PAUSE]
 *     - RoleGranted from unknown sender → [🔴 PAUSE]
 *     - MinDelayChange on Timelock → [🔴 PAUSE]
 *     - EmergencyCapReduction on Bridge → [🔴 PAUSE]
 *
 *   🟡 HIGH:
 *     - Large mUSD mints (>$100K)
 *     - Bridge attestations from unknown relayers
 *     - GlobalPauseStateChanged
 *     - Role grants/revokes from trusted senders
 *
 *   🟢 INFO:
 *     - Successful timelock executions
 *     - Sentinel startup / heartbeat
 *
 * Telegram Commands:
 *     /status  — Protocol status (pause state, block, contracts)
 *     /pause   — Emergency pause (requires confirmation)
 *     /unpause — Unpause protocol (requires DEFAULT_ADMIN_ROLE)
 *     /cancel <operationId> — Cancel a pending timelock operation
 *
 * Usage:
 *   cd bot && set -a && source .env && set +a && npx ts-node src/security-sentinel.ts
 *
 * Requires:
 *   - RPC_URL (or ETHEREUM_RPC_URL)
 *   - TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (for alerts + buttons)
 *   - GUARDIAN_PRIVATE_KEY (for on-chain pause/cancel — optional but recommended)
 */

import { ethers } from "ethers";

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const RPC_URL = process.env.RPC_URL || process.env.ETHEREUM_RPC_URL || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const GUARDIAN_PRIVATE_KEY = process.env.GUARDIAN_PRIVATE_KEY || "";

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

// Restrict who can use Telegram buttons (only your chat ID)
const AUTHORIZED_CHAT_IDS = new Set(
  (process.env.AUTHORIZED_CHAT_IDS || TELEGRAM_CHAT_ID)
    .split(",")
    .map((id: string) => id.trim())
    .filter(Boolean)
);

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════════════

let guardianWallet: ethers.Wallet | null = null;
let rpcProvider: ethers.Provider;

// ═══════════════════════════════════════════════════════════════════════════
// EVENT ABIs (read-only for monitoring)
// ═══════════════════════════════════════════════════════════════════════════

const TIMELOCK_EVENT_ABI = [
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  "event Cancelled(bytes32 indexed id)",
  "event MinDelayChange(uint256 oldDuration, uint256 newDuration)",
];

const ACCESS_CONTROL_ABI = [
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
];

const UPGRADE_ABI = [
  "event Upgraded(address indexed implementation)",
];

const GLOBAL_PAUSE_EVENT_ABI = [
  "event GlobalPauseStateChanged(bool indexed paused, address indexed actor)",
];

const MUSD_EVENT_ABI = [
  "event Mint(address indexed to, uint256 amount)",
  "event BlacklistUpdated(address indexed account, bool isBlacklisted)",
  "event SupplyCapUpdated(uint256 oldCap, uint256 newCap)",
];

const BRIDGE_EVENT_ABI = [
  "event AttestationReceived(bytes32 indexed attestationHash, uint256 nonce, uint256 epoch, uint256 mintAmount, uint256 burnAmount)",
  "event EmergencyCapReduction(uint256 oldCap, uint256 newCap, string reason)",
  "event SupplyCapUpdated(uint256 newMintCap, uint256 newBurnCap, uint256 epoch)",
];

// ═══════════════════════════════════════════════════════════════════════════
// WRITE ABIs (for emergency actions)
// ═══════════════════════════════════════════════════════════════════════════

const GLOBAL_PAUSE_WRITE_ABI = [
  "function pauseGlobal() external",
  "function unpauseGlobal() external",
  "function isGloballyPaused() view returns (bool)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
];

const TIMELOCK_WRITE_ABI = [
  "function cancel(bytes32 id) external",
  "function isOperationPending(bytes32 id) view returns (bool)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
  "function getTimestamp(bytes32 id) view returns (uint256)",
  "function getMinDelay() view returns (uint256)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
];

// ═══════════════════════════════════════════════════════════════════════════
// ROLE LABELS
// ═══════════════════════════════════════════════════════════════════════════

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
// TELEGRAM API HELPERS
// ═══════════════════════════════════════════════════════════════════════════

interface InlineButton {
  text: string;
  callback_data: string;
}

type InlineKeyboard = InlineButton[][];

async function telegramAPI(method: string, body: Record<string, unknown>): Promise<any> {
  if (!TELEGRAM_BOT_TOKEN) return null;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return await res.json();
  } catch (err) {
    console.error(`[Telegram] ${method} failed: ${(err as Error).message}`);
    return null;
  }
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

/** Standard pause button row for CRITICAL alerts */
function pauseButtons(): InlineKeyboard {
  return [
    [{ text: "🔴 PAUSE PROTOCOL", callback_data: "pause_confirm" }],
    [{ text: "📊 Status", callback_data: "status" }],
  ];
}

/** Cancel + pause buttons for timelock alerts */
function timelockButtons(operationId: string): InlineKeyboard {
  return [
    [
      { text: "🔴 PAUSE PROTOCOL", callback_data: "pause_confirm" },
      { text: "❌ CANCEL THIS OP", callback_data: `cancel_confirm:${operationId}` },
    ],
    [{ text: "📊 Status", callback_data: "status" }],
  ];
}

async function sendAlert(
  severity: Severity,
  title: string,
  body: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  const emoji = SEVERITY_EMOJI[severity];
  const timestamp = new Date().toISOString();
  const message = `${emoji} *${severity}: ${title}*\n${body}\n\n_${timestamp}_`;

  // Always log to console
  const prefix = severity === "CRITICAL" ? "\x1b[31m" : severity === "HIGH" ? "\x1b[33m" : "\x1b[36m";
  console.log(`${prefix}[${severity}]\x1b[0m ${title}`);
  console.log(`  ${body.replace(/\n/g, "\n  ")}`);

  // Send to Telegram if configured
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    const payload: Record<string, unknown> = {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    };

    // Attach inline keyboard buttons (only if guardian wallet is available)
    if (keyboard && guardianWallet) {
      payload.reply_markup = { inline_keyboard: keyboard };
    }

    await telegramAPI("sendMessage", payload);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ON-CHAIN EMERGENCY ACTIONS
// ═══════════════════════════════════════════════════════════════════════════

async function executeGlobalPause(): Promise<string> {
  if (!guardianWallet) return "❌ GUARDIAN_PRIVATE_KEY not configured — cannot pause on-chain.";

  try {
    const pauseRegistry = new ethers.Contract(
      ADDRESSES.GLOBAL_PAUSE, GLOBAL_PAUSE_WRITE_ABI, guardianWallet
    );

    // Check if already paused
    const alreadyPaused = await pauseRegistry.isGloballyPaused();
    if (alreadyPaused) return "⚠️ Protocol is already paused.";

    // Check guardian role
    const guardianRole = ethers.id("GUARDIAN_ROLE");
    const hasGuardian = await pauseRegistry.hasRole(guardianRole, guardianWallet.address);
    if (!hasGuardian) {
      return `❌ Wallet ${shortAddr(guardianWallet.address)} lacks GUARDIAN_ROLE on GlobalPauseRegistry.`;
    }

    // Execute pause
    console.log("[RED ALERT] Executing pauseGlobal()...");
    const tx = await pauseRegistry.pauseGlobal();
    const receipt = await tx.wait();

    return [
      "🔴 *PROTOCOL PAUSED SUCCESSFULLY*",
      `Tx: \`${receipt.hash}\``,
      `Block: ${receipt.blockNumber}`,
      `Gas: ${receipt.gasUsed.toString()}`,
      "",
      "All deposits, withdrawals, mints, and borrows are now HALTED.",
      "Use /unpause or the Admin Panel to resume.",
    ].join("\n");
  } catch (err) {
    return `❌ Pause failed: ${(err as Error).message}`;
  }
}

async function executeUnpause(): Promise<string> {
  if (!guardianWallet) return "❌ GUARDIAN_PRIVATE_KEY not configured.";

  try {
    const pauseRegistry = new ethers.Contract(
      ADDRESSES.GLOBAL_PAUSE, GLOBAL_PAUSE_WRITE_ABI, guardianWallet
    );

    const isPaused = await pauseRegistry.isGloballyPaused();
    if (!isPaused) return "✅ Protocol is already running (not paused).";

    // Unpause requires DEFAULT_ADMIN_ROLE (not GUARDIAN_ROLE)
    const adminRole = "0x0000000000000000000000000000000000000000000000000000000000000000";
    const hasAdmin = await pauseRegistry.hasRole(adminRole, guardianWallet.address);
    if (!hasAdmin) {
      return `❌ Wallet ${shortAddr(guardianWallet.address)} lacks DEFAULT_ADMIN_ROLE — cannot unpause.\nUse a DEFAULT_ADMIN wallet or the Admin Panel.`;
    }

    const tx = await pauseRegistry.unpauseGlobal();
    const receipt = await tx.wait();

    return [
      "🟢 *PROTOCOL UNPAUSED*",
      `Tx: \`${receipt.hash}\``,
      `Block: ${receipt.blockNumber}`,
    ].join("\n");
  } catch (err) {
    return `❌ Unpause failed: ${(err as Error).message}`;
  }
}

async function executeCancelTimelock(operationId: string): Promise<string> {
  if (!guardianWallet) return "❌ GUARDIAN_PRIVATE_KEY not configured.";

  try {
    const timelock = new ethers.Contract(
      ADDRESSES.TIMELOCK, TIMELOCK_WRITE_ABI, guardianWallet
    );

    // Validate operation state
    const isPending = await timelock.isOperationPending(operationId);
    if (!isPending) {
      const isDone = await timelock.isOperationDone(operationId);
      if (isDone) return "⚠️ Operation already executed — cannot cancel.";
      return "⚠️ Operation not found or already cancelled.";
    }

    // Check canceller role
    const cancellerRole = ethers.id("CANCELLER_ROLE");
    const hasCanceller = await timelock.hasRole(cancellerRole, guardianWallet.address);
    if (!hasCanceller) {
      return `❌ Wallet ${shortAddr(guardianWallet.address)} lacks CANCELLER_ROLE on Timelock.`;
    }

    const tx = await timelock.cancel(operationId);
    const receipt = await tx.wait();

    return [
      "✅ *TIMELOCK OPERATION CANCELLED*",
      `Operation: \`${operationId}\``,
      `Tx: \`${receipt.hash}\``,
      `Block: ${receipt.blockNumber}`,
    ].join("\n");
  } catch (err) {
    return `❌ Cancel failed: ${(err as Error).message}`;
  }
}

async function getProtocolStatus(): Promise<string> {
  try {
    const pauseRegistry = new ethers.Contract(
      ADDRESSES.GLOBAL_PAUSE, GLOBAL_PAUSE_WRITE_ABI, rpcProvider
    );
    const timelock = new ethers.Contract(
      ADDRESSES.TIMELOCK, TIMELOCK_WRITE_ABI, rpcProvider
    );

    const [isPaused, minDelay, blockNumber] = await Promise.all([
      pauseRegistry.isGloballyPaused(),
      timelock.getMinDelay(),
      rpcProvider.getBlockNumber(),
    ]);

    const status = isPaused ? "🔴 PAUSED" : "🟢 RUNNING";
    const walletInfo = guardianWallet
      ? `Guardian: \`${shortAddr(guardianWallet.address)}\``
      : "Guardian: ❌ not configured";

    return [
      `📊 *Minted Protocol Status*`,
      ``,
      `Status: ${status}`,
      `Block: ${blockNumber}`,
      `Timelock delay: ${Number(minDelay) / 3600}h`,
      `Contracts: ${Object.keys(ADDRESSES).length} monitored`,
      walletInfo,
      ``,
      `_${new Date().toISOString()}_`,
    ].join("\n");
  } catch (err) {
    return `❌ Status check failed: ${(err as Error).message}`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TELEGRAM COMMAND & CALLBACK HANDLER
// ═══════════════════════════════════════════════════════════════════════════

let telegramOffset = 0;

async function handleCallbackQuery(callbackQuery: any): Promise<void> {
  const chatId = String(callbackQuery.message?.chat?.id || "");
  const callbackId = callbackQuery.id;
  const data = callbackQuery.data as string;

  // Authorization check — only your chat ID(s) can trigger actions
  if (!AUTHORIZED_CHAT_IDS.has(chatId)) {
    await telegramAPI("answerCallbackQuery", {
      callback_query_id: callbackId,
      text: "⛔ Unauthorized. This incident has been logged.",
      show_alert: true,
    });
    console.log(`\x1b[31m[SECURITY]\x1b[0m Unauthorized callback from chat ${chatId}: ${data}`);
    return;
  }

  // Acknowledge the button press immediately
  await telegramAPI("answerCallbackQuery", {
    callback_query_id: callbackId,
    text: "Processing...",
  });

  // ── STATUS ──
  if (data === "status") {
    const status = await getProtocolStatus();
    await telegramAPI("sendMessage", {
      chat_id: chatId,
      text: status,
      parse_mode: "Markdown",
    });
    return;
  }

  // ── PAUSE CONFIRM (step 1: show confirmation) ──
  if (data === "pause_confirm") {
    await telegramAPI("sendMessage", {
      chat_id: chatId,
      text: [
        "⚠️ *CONFIRM EMERGENCY PAUSE*",
        "",
        "This will immediately halt ALL protocol operations:",
        "• Deposits & withdrawals",
        "• Minting & burning",
        "• Borrowing & liquidations",
        "",
        "Are you absolutely sure?",
      ].join("\n"),
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔴 YES — PAUSE NOW", callback_data: "pause_execute" },
            { text: "↩️ No, cancel", callback_data: "pause_abort" },
          ],
        ],
      },
    });
    return;
  }

  // ── PAUSE EXECUTE (step 2: actually pause) ──
  if (data === "pause_execute") {
    await telegramAPI("sendMessage", {
      chat_id: chatId,
      text: "⏳ Signing and broadcasting `pauseGlobal()` transaction...",
      parse_mode: "Markdown",
    });

    const result = await executeGlobalPause();
    await telegramAPI("sendMessage", {
      chat_id: chatId,
      text: result,
      parse_mode: "Markdown",
    });
    return;
  }

  // ── PAUSE ABORT ──
  if (data === "pause_abort") {
    await telegramAPI("sendMessage", {
      chat_id: chatId,
      text: "✅ Pause cancelled. Protocol continues running.",
    });
    return;
  }

  // ── CANCEL CONFIRM (step 1) ──
  if (data.startsWith("cancel_confirm:")) {
    const operationId = data.split(":")[1];
    await telegramAPI("sendMessage", {
      chat_id: chatId,
      text: [
        "⚠️ *CONFIRM TIMELOCK CANCELLATION*",
        "",
        `Operation: \`${operationId}\``,
        "",
        "This will permanently cancel this pending timelock operation.",
        "The operation will NOT be executable.",
      ].join("\n"),
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "❌ YES — CANCEL OP", callback_data: `cancel_execute:${operationId}` },
            { text: "↩️ No, keep it", callback_data: "cancel_abort" },
          ],
        ],
      },
    });
    return;
  }

  // ── CANCEL EXECUTE (step 2) ──
  if (data.startsWith("cancel_execute:")) {
    const operationId = data.split(":")[1];
    await telegramAPI("sendMessage", {
      chat_id: chatId,
      text: "⏳ Signing and broadcasting `cancel()` transaction...",
      parse_mode: "Markdown",
    });

    const result = await executeCancelTimelock(operationId);
    await telegramAPI("sendMessage", {
      chat_id: chatId,
      text: result,
      parse_mode: "Markdown",
    });
    return;
  }

  // ── CANCEL ABORT ──
  if (data === "cancel_abort") {
    await telegramAPI("sendMessage", {
      chat_id: chatId,
      text: "✅ Timelock operation kept. No action taken.",
    });
    return;
  }
}

async function handleCommand(message: any): Promise<void> {
  const chatId = String(message.chat?.id || "");
  const text = (message.text || "").trim();

  if (!AUTHORIZED_CHAT_IDS.has(chatId)) return;

  if (text === "/status" || text === "/start") {
    const status = await getProtocolStatus();
    await telegramAPI("sendMessage", {
      chat_id: chatId,
      text: status,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔴 PAUSE PROTOCOL", callback_data: "pause_confirm" },
            { text: "🔄 Refresh", callback_data: "status" },
          ],
        ],
      },
    });
    return;
  }

  if (text === "/pause") {
    await handleCallbackQuery({
      id: "cmd",
      message: { chat: { id: chatId }, message_id: 0 },
      data: "pause_confirm",
    });
    return;
  }

  if (text === "/unpause") {
    const result = await executeUnpause();
    await telegramAPI("sendMessage", {
      chat_id: chatId,
      text: result,
      parse_mode: "Markdown",
    });
    return;
  }

  if (text.startsWith("/cancel ")) {
    const operationId = text.replace("/cancel ", "").trim();
    if (!operationId.startsWith("0x") || operationId.length !== 66) {
      await telegramAPI("sendMessage", {
        chat_id: chatId,
        text: "Usage: `/cancel 0x<64-hex-chars>`",
        parse_mode: "Markdown",
      });
      return;
    }
    await handleCallbackQuery({
      id: "cmd",
      message: { chat: { id: chatId }, message_id: 0 },
      data: `cancel_confirm:${operationId}`,
    });
    return;
  }

  if (text === "/help") {
    await telegramAPI("sendMessage", {
      chat_id: chatId,
      text: [
        "🛡️ *Red Alert Security Sentinel*",
        "",
        "Commands:",
        "/status — Protocol status",
        "/pause — Emergency pause",
        "/unpause — Resume protocol",
        "/cancel `<opId>` — Cancel timelock operation",
        "/help — This message",
        "",
        "Buttons appear automatically on CRITICAL alerts.",
      ].join("\n"),
      parse_mode: "Markdown",
    });
    return;
  }
}

async function pollTelegramUpdates(): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) return;

  console.log("[Telegram] Starting command & callback listener (long-polling)...");

  // Set bot commands menu
  await telegramAPI("setMyCommands", {
    commands: [
      { command: "status", description: "Protocol status" },
      { command: "pause", description: "🔴 Emergency pause" },
      { command: "unpause", description: "🟢 Resume protocol" },
      { command: "cancel", description: "Cancel timelock operation" },
      { command: "help", description: "Show help" },
    ],
  });

  while (true) {
    try {
      const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offset: telegramOffset,
          timeout: 30, // long-poll for 30s
          allowed_updates: ["callback_query", "message"],
        }),
        signal: AbortSignal.timeout(35_000), // 30s poll + 5s buffer
      });

      const data = await res.json() as any;
      if (!data.ok || !data.result?.length) continue;

      for (const update of data.result) {
        telegramOffset = update.update_id + 1;

        if (update.callback_query) {
          await handleCallbackQuery(update.callback_query);
        } else if (update.message?.text?.startsWith("/")) {
          await handleCommand(update.message);
        }
      }
    } catch (err) {
      // AbortError is expected when timeout fires with no updates — ignore it
      if ((err as Error).name !== "AbortError") {
        console.error(`[Telegram] Poll error: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 5_000)); // backoff on error
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EVENT HANDLERS (on-chain monitoring)
// ═══════════════════════════════════════════════════════════════════════════

function setupTimelockMonitor(provider: ethers.Provider): void {
  const timelock = new ethers.Contract(ADDRESSES.TIMELOCK, TIMELOCK_EVENT_ABI, provider);

  // 🔴 CRITICAL: New operation scheduled — show PAUSE + CANCEL buttons
  timelock.on("CallScheduled", async (id, index, target, value, data, predecessor, delay, event) => {
    const txHash = event?.log?.transactionHash || "unknown";

    await sendAlert("CRITICAL", "Timelock Operation Scheduled", [
      `Operation ID: \`${id}\``,
      `Target: ${contractName(target)} (\`${target}\`)`,
      `Delay: ${Number(delay)}s (${(Number(delay) / 3600).toFixed(1)}h)`,
      `Value: ${ethers.formatEther(value)} ETH`,
      `Data: \`${String(data).slice(0, 40)}…\``,
      `Tx: \`${txHash}\``,
      ``,
      `⏰ *Executable after*: ${new Date(Date.now() + Number(delay) * 1000).toISOString()}`,
    ].join("\n"), timelockButtons(id));
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

  // 🔴 CRITICAL: Delay changed — show PAUSE button
  timelock.on("MinDelayChange", async (oldDuration, newDuration) => {
    await sendAlert("CRITICAL", "Timelock Delay Changed", [
      `Old: ${Number(oldDuration)}s → New: ${Number(newDuration)}s`,
      Number(newDuration) < Number(oldDuration) ? "⚠️ *DELAY REDUCED* — potential governance attack" : "",
    ].join("\n"), pauseButtons());
  });

  console.log(`  ✅ Timelock: ${shortAddr(ADDRESSES.TIMELOCK)}`);
}

function setupAccessControlMonitor(provider: ethers.Provider): void {
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
      ].join("\n"), isTrusted ? undefined : pauseButtons());
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
      ].join("\n"), pauseButtons());
    });
  }

  console.log(`  ✅ Upgrades: ${proxies.length} proxies monitored`);
}

function setupGlobalPauseMonitor(provider: ethers.Provider): void {
  const pauseRegistry = new ethers.Contract(ADDRESSES.GLOBAL_PAUSE, GLOBAL_PAUSE_EVENT_ABI, provider);

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
  const musd = new ethers.Contract(ADDRESSES.MUSD, MUSD_EVENT_ABI, provider);

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

  musd.on("SupplyCapUpdated", async (oldCap, newCap) => {
    await sendAlert("HIGH", "mUSD Supply Cap Changed", [
      `Old: ${ethers.formatUnits(oldCap, 18)} → New: ${ethers.formatUnits(newCap, 18)}`,
    ].join("\n"));
  });

  musd.on("BlacklistUpdated", async (account, isBlacklisted) => {
    await sendAlert("HIGH", `mUSD Blacklist ${isBlacklisted ? "Added" : "Removed"}`, [
      `Account: \`${account}\``,
    ].join("\n"));
  });

  console.log(`  ✅ MUSD: ${shortAddr(ADDRESSES.MUSD)}`);
}

function setupBridgeMonitor(provider: ethers.Provider): void {
  const bridge = new ethers.Contract(ADDRESSES.BRIDGE, BRIDGE_EVENT_ABI, provider);

  bridge.on("EmergencyCapReduction", async (oldCap, newCap, reason) => {
    await sendAlert("CRITICAL", "Bridge Emergency Cap Reduction", [
      `Old cap: ${ethers.formatUnits(oldCap, 18)} → New: ${ethers.formatUnits(newCap, 18)}`,
      `Reason: ${reason}`,
    ].join("\n"), pauseButtons());
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

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  🚨  Minted Protocol — Red Alert Security Sentinel     ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log();

  // ── Provider ──
  const wsUrl = process.env.WS_RPC_URL;
  if (wsUrl) {
    rpcProvider = new ethers.WebSocketProvider(wsUrl);
    console.log(`[Provider] WebSocket: ${wsUrl.replace(/\/[^/]+$/, "/***")}`);
  } else {
    rpcProvider = new ethers.JsonRpcProvider(RPC_URL);
    console.log(`[Provider] HTTP (polling): ${RPC_URL.replace(/\/[^/]+$/, "/***")}`);
    console.log(`  ⚠️  For real-time alerts, set WS_RPC_URL to a WebSocket endpoint`);
  }

  const network = await rpcProvider.getNetwork();
  console.log(`[Network] ${network.name} (chainId: ${network.chainId})`);
  console.log();

  // ── Guardian Wallet ──
  if (GUARDIAN_PRIVATE_KEY) {
    guardianWallet = new ethers.Wallet(GUARDIAN_PRIVATE_KEY, rpcProvider);
    const balance = await rpcProvider.getBalance(guardianWallet.address);
    console.log(`[Guardian] ✅ ${shortAddr(guardianWallet.address)} (${ethers.formatEther(balance)} ETH)`);
    console.log(`[Guardian] Can execute: pauseGlobal(), cancel(), unpauseGlobal()`);
  } else {
    console.log("[Guardian] ⚠️  No GUARDIAN_PRIVATE_KEY — alert-only mode (no on-chain actions)");
    console.log("  Set GUARDIAN_PRIVATE_KEY in .env to enable one-tap pause from Telegram.");
  }
  console.log();

  // ── Telegram ──
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    console.log("[Telegram] ✅ Configured — alerts + interactive buttons enabled");
    console.log(`[Telegram] Authorized chats: ${[...AUTHORIZED_CHAT_IDS].join(", ")}`);
  } else {
    console.log("[Telegram] ⚠️  Not configured — console-only mode");
    console.log("  Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID for mobile alerts.");
  }
  console.log();

  // ── Register all monitors ──
  console.log("[Monitors] Registering event listeners...");
  setupTimelockMonitor(rpcProvider);
  setupAccessControlMonitor(rpcProvider);
  setupUpgradeMonitor(rpcProvider);
  setupGlobalPauseMonitor(rpcProvider);
  setupMUSDMonitor(rpcProvider);
  setupBridgeMonitor(rpcProvider);
  console.log();

  const blockNumber = await rpcProvider.getBlockNumber();
  console.log(`[Ready] Listening from block ${blockNumber}`);
  console.log(`[Ready] ${Object.keys(ADDRESSES).length} contracts monitored`);
  console.log(`[Ready] Large mint threshold: ${ethers.formatUnits(LARGE_MINT_THRESHOLD, 18)} mUSD`);
  console.log();

  // ── Startup alert with status button ──
  await sendAlert("INFO", "Red Alert Sentinel Online 🛡️", [
    `Network: ${network.name} (${network.chainId})`,
    `Block: ${blockNumber}`,
    `Contracts: ${Object.keys(ADDRESSES).length}`,
    `Guardian: ${guardianWallet ? `✅ ${shortAddr(guardianWallet.address)}` : "❌ alert-only"}`,
    `Telegram: ${TELEGRAM_BOT_TOKEN ? "✅" : "❌"}`,
  ].join("\n"), [
    [
      { text: "📊 Status", callback_data: "status" },
      { text: "🔴 Test Pause", callback_data: "pause_confirm" },
    ],
  ]);

  // ── Start Telegram callback listener (non-blocking) ──
  pollTelegramUpdates(); // runs forever in background

  // ── Heartbeat every 30 minutes ──
  const HEARTBEAT_MS = 30 * 60 * 1000;
  setInterval(async () => {
    try {
      const currentBlock = await rpcProvider.getBlockNumber();
      console.log(`[Heartbeat] Block ${currentBlock} — sentinel alive`);
    } catch (err) {
      console.error(`[Heartbeat] Provider error: ${(err as Error).message}`);
      await sendAlert("CRITICAL", "Sentinel RPC Connection Lost", [
        `Error: ${(err as Error).message}`,
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
