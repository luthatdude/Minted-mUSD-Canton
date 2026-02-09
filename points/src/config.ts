/**
 * Minted Points System — Season Configuration
 *
 * Points are earned per dollar-hour of participation.
 * Formula: points = USD_value × multiplier × hours
 *
 * 3 Seasons with decreasing multipliers — early adopters earn the most.
 * Canton Boost Pool is ALWAYS the highest multiplier (most aggressive).
 *
 * Points → Minted Token Airdrop
 */

// ═══════════════════════════════════════════════════════════════════════════
// POINT-EARNING ACTIONS
// ═══════════════════════════════════════════════════════════════════════════

export enum PointAction {
  // Ethereum
  ETH_SMUSD_HOLD = "ETH_SMUSD_HOLD",               // Hold sMUSD on Ethereum
  ETH_COLLATERAL_ETH = "ETH_COLLATERAL_ETH",         // ETH supplied as collateral
  ETH_COLLATERAL_WBTC = "ETH_COLLATERAL_WBTC",       // WBTC supplied as collateral
  ETH_COLLATERAL_SMUSD = "ETH_COLLATERAL_SMUSD",     // sMUSD supplied as collateral
  ETH_BORROW = "ETH_BORROW",                         // Outstanding mUSD borrow
  ETH_LEVERAGE = "ETH_LEVERAGE",                     // LeverageVault positions

  // Canton
  CTN_SMUSD_HOLD = "CTN_SMUSD_HOLD",                 // Hold CantonSMUSD
  CTN_COLLATERAL_CTN = "CTN_COLLATERAL_CTN",          // Canton Coin as collateral
  CTN_COLLATERAL_SMUSD = "CTN_COLLATERAL_SMUSD",     // CantonSMUSD as collateral
  CTN_BORROW = "CTN_BORROW",                         // Outstanding CantonMUSD borrow
  CTN_BOOST_POOL = "CTN_BOOST_POOL",                 // Canton Boost Pool LP — HIGHEST
}

// ═══════════════════════════════════════════════════════════════════════════
// SEASON DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════

export interface SeasonConfig {
  id: number;
  name: string;
  startDate: Date;
  endDate: Date;
  multipliers: Record<PointAction, number>;
}

/**
 * Season 1: Genesis — Most aggressive. Reward early adopters hard.
 * Canton Boost Pool at 10x. Everything else elevated.
 * ~3 months
 */
const SEASON_1: SeasonConfig = {
  id: 1,
  name: "Genesis",
  startDate: new Date("2026-03-01T00:00:00Z"),
  endDate: new Date("2026-06-01T00:00:00Z"),
  multipliers: {
    // Ethereum (generous but Canton is higher)
    [PointAction.ETH_SMUSD_HOLD]: 3,
    [PointAction.ETH_COLLATERAL_ETH]: 2,
    [PointAction.ETH_COLLATERAL_WBTC]: 2,
    [PointAction.ETH_COLLATERAL_SMUSD]: 3,
    [PointAction.ETH_BORROW]: 1.5,
    [PointAction.ETH_LEVERAGE]: 4,

    // Canton (higher across the board)
    [PointAction.CTN_SMUSD_HOLD]: 4,
    [PointAction.CTN_COLLATERAL_CTN]: 3,
    [PointAction.CTN_COLLATERAL_SMUSD]: 4,
    [PointAction.CTN_BORROW]: 2,
    [PointAction.CTN_BOOST_POOL]: 10,       // 🔥 HIGHEST — 10x
  },
};

/**
 * Season 2: Growth — Still rewarding but cooling off.
 * Canton Boost Pool at 6x. Eth side normalizes.
 * ~3 months
 */
const SEASON_2: SeasonConfig = {
  id: 2,
  name: "Growth",
  startDate: new Date("2026-06-01T00:00:00Z"),
  endDate: new Date("2026-09-01T00:00:00Z"),
  multipliers: {
    // Ethereum
    [PointAction.ETH_SMUSD_HOLD]: 2,
    [PointAction.ETH_COLLATERAL_ETH]: 1.5,
    [PointAction.ETH_COLLATERAL_WBTC]: 1.5,
    [PointAction.ETH_COLLATERAL_SMUSD]: 2,
    [PointAction.ETH_BORROW]: 1,
    [PointAction.ETH_LEVERAGE]: 2.5,

    // Canton
    [PointAction.CTN_SMUSD_HOLD]: 2.5,
    [PointAction.CTN_COLLATERAL_CTN]: 2,
    [PointAction.CTN_COLLATERAL_SMUSD]: 2.5,
    [PointAction.CTN_BORROW]: 1.5,
    [PointAction.CTN_BOOST_POOL]: 6,        // Still highest
  },
};

/**
 * Season 3: Maturity — Final season before airdrop snapshot.
 * Canton Boost Pool at 4x. Base rates settle.
 * ~3 months
 */
const SEASON_3: SeasonConfig = {
  id: 3,
  name: "Maturity",
  startDate: new Date("2026-09-01T00:00:00Z"),
  endDate: new Date("2026-12-01T00:00:00Z"),
  multipliers: {
    // Ethereum
    [PointAction.ETH_SMUSD_HOLD]: 1,
    [PointAction.ETH_COLLATERAL_ETH]: 1,
    [PointAction.ETH_COLLATERAL_WBTC]: 1,
    [PointAction.ETH_COLLATERAL_SMUSD]: 1,
    [PointAction.ETH_BORROW]: 0.5,
    [PointAction.ETH_LEVERAGE]: 1.5,

    // Canton
    [PointAction.CTN_SMUSD_HOLD]: 1.5,
    [PointAction.CTN_COLLATERAL_CTN]: 1,
    [PointAction.CTN_COLLATERAL_SMUSD]: 1.5,
    [PointAction.CTN_BORROW]: 1,
    [PointAction.CTN_BOOST_POOL]: 4,        // Still highest
  },
};

export const SEASONS: SeasonConfig[] = [SEASON_1, SEASON_2, SEASON_3];

// ═══════════════════════════════════════════════════════════════════════════
// SNAPSHOT CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

/** How often to take balance snapshots (in ms) */
export const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000; // Every 1 hour

/** Minimum USD value to earn points (dust filter) */
export const MIN_VALUE_USD = 1.0;

// ═══════════════════════════════════════════════════════════════════════════
// CONTRACT ADDRESSES (Sepolia — update for mainnet)
// ═══════════════════════════════════════════════════════════════════════════

export const CONTRACTS = {
  ethereum: {
    MUSD: "0x2bD1671c378A525dDA911Cc53eE9E8929D54fd9b",
    SMUSD: "0xbe47E05f8aE025D03D034a50bE0Efd23E591AA68",
    COLLATERAL_VAULT: "0x3a11571879f5CAEB2CA881E8899303453a800C8c",
    BORROW_MODULE: "0x114109F3555Ee75DD343710a63926B9899A6A4a8",
    PRICE_ORACLE: "0x3F761A52091DB1349aF08C54336d1E5Ae6636901",
    LEVERAGE_VAULT: "", // TODO: deployed address
    RPC_URL: process.env.ETH_RPC_URL || "https://eth-sepolia.g.alchemy.com/v2/demo",
  },
  canton: {
    LEDGER_HOST: process.env.CANTON_LEDGER_HOST || "localhost",
    LEDGER_PORT: parseInt(process.env.CANTON_LEDGER_PORT || "6865"),
    OPERATOR_PARTY: process.env.CANTON_OPERATOR_PARTY || "",
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/** Get the current active season, or null if between/after seasons */
export function getCurrentSeason(): SeasonConfig | null {
  const now = new Date();
  return SEASONS.find((s) => now >= s.startDate && now < s.endDate) ?? null;
}

/** Get season by ID */
export function getSeasonById(id: number): SeasonConfig | undefined {
  return SEASONS.find((s) => s.id === id);
}

/** Get all active + past seasons (not future) */
export function getActiveAndPastSeasons(): SeasonConfig[] {
  const now = new Date();
  return SEASONS.filter((s) => now >= s.startDate);
}

/**
 * Display multiplier table for a season
 */
export function printSeasonMultipliers(season: SeasonConfig): void {
  console.log(`\n═══ Season ${season.id}: ${season.name} ═══`);
  console.log(`${season.startDate.toISOString().split("T")[0]} → ${season.endDate.toISOString().split("T")[0]}\n`);

  const ethActions = Object.entries(season.multipliers).filter(([k]) => k.startsWith("ETH_"));
  const ctnActions = Object.entries(season.multipliers).filter(([k]) => k.startsWith("CTN_"));

  console.log("Ethereum:");
  ethActions.forEach(([action, mult]) => {
    console.log(`  ${action.padEnd(30)} ${mult}x`);
  });

  console.log("\nCanton:");
  ctnActions.forEach(([action, mult]) => {
    const tag = action === "CTN_BOOST_POOL" ? " 🔥 HIGHEST" : "";
    console.log(`  ${action.padEnd(30)} ${mult}x${tag}`);
  });
}
