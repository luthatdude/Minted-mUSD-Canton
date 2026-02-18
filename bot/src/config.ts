/**
 * Minted Protocol - Bot Configuration
 *
 * Centralised configuration for all bot services (oracle-keeper, yield-keeper, etc.)
 * Reads from environment variables with sensible defaults.
 */

export interface BotConfig {
  /** Ethereum JSON-RPC endpoint (must be HTTPS in production) */
  ethereumRpcUrl: string;
  /** Poll interval in milliseconds */
  pollIntervalMs: number;
  /** Telegram bot token for alerts (optional) */
  telegramBotToken?: string;
  /** Telegram chat ID for alerts (optional) */
  telegramChatId?: string;
  /** Environment: production | staging | development | test */
  environment: string;
}

export const DEFAULT_CONFIG: BotConfig = {
  ethereumRpcUrl: process.env.ETHEREUM_RPC_URL || "",
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 30_000,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  environment: process.env.NODE_ENV || "development",
};

/**
 * Validate that required configuration is present.
 * Throws if critical config is missing.
 */
export function validateConfig(config: BotConfig): void {
  if (!config.ethereumRpcUrl) {
    throw new Error("ETHEREUM_RPC_URL environment variable is required");
  }
  if (config.environment === "production" && !config.ethereumRpcUrl.startsWith("https://")) {
    throw new Error("ETHEREUM_RPC_URL must use HTTPS in production");
  }
  if (config.pollIntervalMs < 1000) {
    throw new Error("POLL_INTERVAL_MS must be >= 1000ms");
  }
}

// ============================================================
//  TS-H-02 FIX: Role Key Uniqueness Validation
// ============================================================

/**
 * Validate that bot role private keys are distinct.
 *
 * PRIVATE_KEY (liquidation bot), KEEPER_PRIVATE_KEY (yield/oracle keeper),
 * and GUARDIAN_PRIVATE_KEY (security sentinel) must be different keys.
 * Reusing a single key across all roles violates least-privilege — compromise
 * of one role would compromise all three.
 *
 * Call this at bot startup before loading any signers.
 *
 * @param keys - Array of { name, envVar } pairs to check
 * @throws In production if any two keys are identical
 * @warns In development if any two keys are identical
 */
export function validateDistinctRoleKeys(
  keys: Array<{ name: string; envVar: string }>
): void {
  const resolved: Array<{ name: string; value: string }> = [];

  for (const { name, envVar } of keys) {
    // Check Docker secrets first, then env var
    let value = "";
    try {
      const fs = require("fs");
      const secretPath = `/run/secrets/${name}`;
      if (fs.existsSync(secretPath)) {
        value = fs.readFileSync(secretPath, "utf-8").trim();
      }
    } catch { /* fall through */ }
    if (!value) {
      value = process.env[envVar] || "";
    }
    if (value) {
      // Normalize: strip 0x prefix for comparison
      const normalized = value.startsWith("0x") ? value.slice(2).toLowerCase() : value.toLowerCase();
      resolved.push({ name: envVar, value: normalized });
    }
  }

  // Check all pairs for duplicates
  const duplicates: string[] = [];
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      if (resolved[i].value === resolved[j].value) {
        duplicates.push(`${resolved[i].name} == ${resolved[j].name}`);
      }
    }
  }

  if (duplicates.length > 0) {
    const msg =
      `SECURITY: Bot role keys must be distinct (least-privilege). ` +
      `Duplicate keys found: ${duplicates.join(", ")}. ` +
      `Generate separate keys for each role to limit blast radius of key compromise.`;

    if (process.env.NODE_ENV === "production") {
      throw new Error(msg);
    } else {
      console.warn(`⚠️  ${msg}`);
    }
  }
}

/**
 * Standard set of bot role keys to validate.
 * Call validateDistinctRoleKeys(BOT_ROLE_KEYS) at startup.
 */
export const BOT_ROLE_KEYS = [
  { name: "bot_private_key", envVar: "PRIVATE_KEY" },
  { name: "keeper_private_key", envVar: "KEEPER_PRIVATE_KEY" },
  { name: "guardian_private_key", envVar: "GUARDIAN_PRIVATE_KEY" },
  { name: "reconciliation_keeper_key", envVar: "RECONCILIATION_KEEPER_KEY" },
];
