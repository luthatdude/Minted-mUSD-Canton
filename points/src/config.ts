// Points config — environment and chain configuration
// FIX H-06: Populated stub file (was 0-byte)

export interface PointsEnvConfig {
  /** Dune Analytics API key for on-chain data queries */
  duneApiKey: string;
  /** Ethereum RPC URL for contract reads */
  ethereumRpcUrl: string;
  /** Canton ledger API URL */
  cantonApiUrl: string;
  /** PostgreSQL connection string for points storage */
  databaseUrl: string;
  /** Points calculation epoch (ISO 8601) */
  epochStart: string;
  /** Server port */
  port: number;
}

export function loadConfig(): PointsEnvConfig {
  const required = ["DUNE_API_KEY", "ETHEREUM_RPC_URL"];
  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  return {
    duneApiKey: process.env.DUNE_API_KEY!,
    ethereumRpcUrl: process.env.ETHEREUM_RPC_URL!,
    cantonApiUrl: process.env.CANTON_API_URL || "http://localhost:6865",
    databaseUrl: process.env.DATABASE_URL || "sqlite://points.db",
    epochStart: process.env.POINTS_EPOCH_START || "2025-01-01T00:00:00Z",
    port: parseInt(process.env.PORT || "3001", 10),
  };
}
