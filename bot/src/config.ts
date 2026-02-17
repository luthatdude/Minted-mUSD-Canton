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
