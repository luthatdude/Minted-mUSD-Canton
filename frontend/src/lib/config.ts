export const CHAIN_ID = parseInt(process.env.NEXT_PUBLIC_CHAIN_ID || "1");

export const CONTRACTS: Record<string, string> = {
  MUSD: process.env.NEXT_PUBLIC_MUSD_ADDRESS || "",
  SMUSD: process.env.NEXT_PUBLIC_SMUSD_ADDRESS || "",
  USDC: process.env.NEXT_PUBLIC_USDC_ADDRESS || "",
  DirectMint: process.env.NEXT_PUBLIC_DIRECT_MINT_ADDRESS || "",
  Treasury: process.env.NEXT_PUBLIC_TREASURY_ADDRESS || "",
  CollateralVault: process.env.NEXT_PUBLIC_COLLATERAL_VAULT_ADDRESS || "",
  BorrowModule: process.env.NEXT_PUBLIC_BORROW_MODULE_ADDRESS || "",
  LiquidationEngine: process.env.NEXT_PUBLIC_LIQUIDATION_ENGINE_ADDRESS || "",
  BLEBridgeV9: process.env.NEXT_PUBLIC_BRIDGE_ADDRESS || "",
  PriceOracle: process.env.NEXT_PUBLIC_PRICE_ORACLE_ADDRESS || "",
};

export const CANTON_CONFIG = {
  ledgerHost: process.env.NEXT_PUBLIC_CANTON_LEDGER_HOST || "localhost",
  ledgerPort: parseInt(process.env.NEXT_PUBLIC_CANTON_LEDGER_PORT || "6865"),
  token: process.env.NEXT_PUBLIC_CANTON_TOKEN || "",
};

export const USDC_DECIMALS = 6;
export const MUSD_DECIMALS = 18;
export const SCALING_FACTOR = 10n ** 12n; // USDC 6 → mUSD 18
