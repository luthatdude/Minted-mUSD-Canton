/**
 * Minted Protocol — Dune Analytics Dashboard Queries
 *
 * SQL queries for publishing on-chain snapshots to Dune.
 * These track mUSD deposits, smUSD staking, borrowing, and bridging activity.
 *
 * Usage:
 *   1. Create a Dune dashboard at https://dune.com/
 *   2. Add each query below as a separate visualization
 *   3. Replace {{musd_address}}, {{smusd_address}}, etc. with deployed addresses
 *   4. Schedule daily refresh
 *
 * For automated upload of points CSV snapshots:
 *   Use Dune's CSV Upload API: POST https://api.dune.com/api/v1/table/upload/csv
 *   See uploadToDune() function at bottom.
 */

// ═══════════════════════════════════════════════════════════════
// Query 1: mUSD Supply & Holder Distribution (Daily)
// ═══════════════════════════════════════════════════════════════

export const MUSD_SUPPLY_QUERY = `
-- mUSD Total Supply Over Time
-- Dashboard: mUSD Protocol Overview
-- Refresh: Daily

WITH daily_supply AS (
  SELECT
    DATE_TRUNC('day', evt_block_time) AS day,
    SUM(CASE WHEN evt_name = 'Mint' THEN CAST(value AS DECIMAL(38,0)) ELSE 0 END) AS minted,
    SUM(CASE WHEN evt_name = 'Burn' THEN CAST(value AS DECIMAL(38,0)) ELSE 0 END) AS burned
  FROM erc20_ethereum.evt_Transfer
  WHERE contract_address = {{musd_address}}
    AND (
      "from" = 0x0000000000000000000000000000000000000000  -- Mints
      OR "to" = 0x0000000000000000000000000000000000000000  -- Burns
    )
  GROUP BY 1
)
SELECT
  day,
  SUM(minted - burned) OVER (ORDER BY day) / 1e18 AS total_supply,
  minted / 1e18 AS daily_minted,
  burned / 1e18 AS daily_burned
FROM daily_supply
ORDER BY day DESC
`;

// ═══════════════════════════════════════════════════════════════
// Query 2: smUSD Staking Deposits & Share Price
// ═══════════════════════════════════════════════════════════════

export const SMUSD_STAKING_QUERY = `
-- smUSD Staking Activity (ERC-4626 Deposits/Withdrawals)
-- Dashboard: Staking Analytics

WITH deposits AS (
  SELECT
    DATE_TRUNC('day', evt_block_time) AS day,
    COUNT(*) AS deposit_count,
    SUM(CAST(assets AS DECIMAL(38,0))) / 1e18 AS total_deposited,
    COUNT(DISTINCT sender) AS unique_depositors
  FROM {{smusd_address}}.Deposit
  GROUP BY 1
),
withdrawals AS (
  SELECT
    DATE_TRUNC('day', evt_block_time) AS day,
    COUNT(*) AS withdraw_count,
    SUM(CAST(assets AS DECIMAL(38,0))) / 1e18 AS total_withdrawn,
    COUNT(DISTINCT receiver) AS unique_withdrawers
  FROM {{smusd_address}}.Withdraw
  GROUP BY 1
)
SELECT
  COALESCE(d.day, w.day) AS day,
  COALESCE(d.total_deposited, 0) AS deposited,
  COALESCE(w.total_withdrawn, 0) AS withdrawn,
  COALESCE(d.total_deposited, 0) - COALESCE(w.total_withdrawn, 0) AS net_flow,
  COALESCE(d.unique_depositors, 0) AS unique_depositors,
  COALESCE(d.deposit_count, 0) AS deposit_txns
FROM deposits d
FULL OUTER JOIN withdrawals w ON d.day = w.day
ORDER BY day DESC
`;

// ═══════════════════════════════════════════════════════════════
// Query 3: Borrow Module — Outstanding Debt & Utilization
// ═══════════════════════════════════════════════════════════════

export const BORROW_ACTIVITY_QUERY = `
-- BorrowModule Activity (Borrows, Repays, Liquidations)
-- Dashboard: Lending Analytics

WITH borrows AS (
  SELECT
    DATE_TRUNC('day', evt_block_time) AS day,
    SUM(CAST(amount AS DECIMAL(38,0))) / 1e18 AS borrowed,
    COUNT(DISTINCT borrower) AS unique_borrowers
  FROM {{borrow_module_address}}.Borrowed
  GROUP BY 1
),
repays AS (
  SELECT
    DATE_TRUNC('day', evt_block_time) AS day,
    SUM(CAST(amount AS DECIMAL(38,0))) / 1e18 AS repaid
  FROM {{borrow_module_address}}.Repaid
  GROUP BY 1
),
liquidations AS (
  SELECT
    DATE_TRUNC('day', evt_block_time) AS day,
    COUNT(*) AS liquidation_count,
    SUM(CAST("debtRepaid" AS DECIMAL(38,0))) / 1e18 AS debt_liquidated,
    SUM(CAST("collateralSeized" AS DECIMAL(38,0))) / 1e18 AS collateral_seized
  FROM {{liquidation_engine_address}}.Liquidation
  GROUP BY 1
)
SELECT
  COALESCE(b.day, r.day, l.day) AS day,
  COALESCE(b.borrowed, 0) AS daily_borrowed,
  COALESCE(r.repaid, 0) AS daily_repaid,
  COALESCE(b.unique_borrowers, 0) AS unique_borrowers,
  COALESCE(l.liquidation_count, 0) AS liquidations,
  COALESCE(l.debt_liquidated, 0) AS debt_liquidated,
  SUM(COALESCE(b.borrowed, 0) - COALESCE(r.repaid, 0) - COALESCE(l.debt_liquidated, 0))
    OVER (ORDER BY COALESCE(b.day, r.day, l.day)) AS cumulative_outstanding_debt
FROM borrows b
FULL OUTER JOIN repays r ON b.day = r.day
FULL OUTER JOIN liquidations l ON COALESCE(b.day, r.day) = l.day
ORDER BY day DESC
`;

// ═══════════════════════════════════════════════════════════════
// Query 4: Collateral Deposits by Token
// ═══════════════════════════════════════════════════════════════

export const COLLATERAL_DEPOSITS_QUERY = `
-- CollateralVault Deposits by Token
-- Dashboard: Collateral Health

SELECT
  DATE_TRUNC('day', evt_block_time) AS day,
  token,
  SUM(CAST(amount AS DECIMAL(38,0))) / 1e18 AS deposited,
  COUNT(DISTINCT "user") AS unique_users
FROM {{collateral_vault_address}}.CollateralDeposited
GROUP BY 1, 2
ORDER BY day DESC, deposited DESC
`;

// ═══════════════════════════════════════════════════════════════
// Query 5: Bridge Activity (Canton ↔ Ethereum)
// ═══════════════════════════════════════════════════════════════

export const BRIDGE_ACTIVITY_QUERY = `
-- BLEBridgeV9 Cross-Chain Activity
-- Dashboard: Bridge Health

WITH bridge_in AS (
  SELECT
    DATE_TRUNC('day', evt_block_time) AS day,
    COUNT(*) AS mint_count,
    SUM(CAST(amount AS DECIMAL(38,0))) / 1e18 AS bridged_in
  FROM {{bridge_address}}.SupplyCapUpdated
  WHERE "newCap" > "oldCap"
  GROUP BY 1
),
rate_limits AS (
  SELECT
    DATE_TRUNC('day', evt_block_time) AS day,
    MAX(CAST("dailyCapIncreased" AS DECIMAL(38,0))) / 1e18 AS daily_cap_used,
    MAX(CAST("dailyCapIncreaseLimit" AS DECIMAL(38,0))) / 1e18 AS daily_cap_limit
  FROM {{bridge_address}}.RateLimitStatus
  GROUP BY 1
)
SELECT
  COALESCE(b.day, r.day) AS day,
  COALESCE(b.bridged_in, 0) AS bridged_in,
  COALESCE(b.mint_count, 0) AS bridge_txns,
  COALESCE(r.daily_cap_used, 0) AS rate_limit_used,
  COALESCE(r.daily_cap_limit, 50000000) AS rate_limit_max,
  CASE WHEN COALESCE(r.daily_cap_limit, 50000000) > 0
    THEN COALESCE(r.daily_cap_used, 0) / COALESCE(r.daily_cap_limit, 50000000) * 100
    ELSE 0
  END AS rate_limit_utilization_pct
FROM bridge_in b
FULL OUTER JOIN rate_limits r ON b.day = r.day
ORDER BY day DESC
`;

// ═══════════════════════════════════════════════════════════════
// Query 6: Top mUSD Holders (Whale Watch)
// ═══════════════════════════════════════════════════════════════

export const TOP_HOLDERS_QUERY = `
-- Top 100 mUSD Holders (current balances)
-- Dashboard: Holder Distribution

WITH transfers AS (
  SELECT
    "to" AS address,
    CAST(value AS DECIMAL(38,0)) AS amount
  FROM erc20_ethereum.evt_Transfer
  WHERE contract_address = {{musd_address}}

  UNION ALL

  SELECT
    "from" AS address,
    -CAST(value AS DECIMAL(38,0)) AS amount
  FROM erc20_ethereum.evt_Transfer
  WHERE contract_address = {{musd_address}}
)
SELECT
  address,
  SUM(amount) / 1e18 AS balance,
  ROW_NUMBER() OVER (ORDER BY SUM(amount) DESC) AS rank
FROM transfers
WHERE address != 0x0000000000000000000000000000000000000000
GROUP BY address
HAVING SUM(amount) > 0
ORDER BY balance DESC
LIMIT 100
`;

// ═══════════════════════════════════════════════════════════════
// Query 7: Treasury Strategy Performance
// ═══════════════════════════════════════════════════════════════

export const TREASURY_STRATEGY_QUERY = `
-- TreasuryV2 Strategy Allocation & Yield
-- Dashboard: Treasury Analytics

WITH fee_events AS (
  SELECT
    DATE_TRUNC('day', evt_block_time) AS day,
    SUM(CAST(yield AS DECIMAL(38,0))) / 1e6 AS daily_yield,
    SUM(CAST("protocolFee" AS DECIMAL(38,0))) / 1e6 AS daily_fees
  FROM {{treasury_address}}.FeesAccrued
  GROUP BY 1
)
SELECT
  day,
  daily_yield,
  daily_fees,
  daily_yield - daily_fees AS net_yield_to_stakers,
  SUM(daily_yield) OVER (ORDER BY day) AS cumulative_yield,
  SUM(daily_fees) OVER (ORDER BY day) AS cumulative_fees
FROM fee_events
ORDER BY day DESC
`;

// ═══════════════════════════════════════════════════════════════
// Dune CSV Upload (for points snapshots)
// ═══════════════════════════════════════════════════════════════

/**
 * Upload a points snapshot CSV to Dune for querying.
 *
 * Requires DUNE_API_KEY env var.
 * Creates/updates the table `dune.minted_points_snapshots`.
 *
 * Usage:
 *   await uploadToDune("./snapshots/snapshot-1/points-1.csv");
 */
export async function uploadToDune(csvPath: string): Promise<{ success: boolean; error?: string }> {
  const apiKey = process.env.DUNE_API_KEY;
  if (!apiKey) {
    return { success: false, error: "DUNE_API_KEY not set" };
  }

  const fs = await import("fs");
  if (!fs.existsSync(csvPath)) {
    return { success: false, error: `File not found: ${csvPath}` };
  }

  const csvContent = fs.readFileSync(csvPath, "utf-8");

  try {
    const response = await fetch("https://api.dune.com/api/v1/table/upload/csv", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Dune-API-Key": apiKey,
      },
      body: JSON.stringify({
        table_name: "minted_points_snapshots",
        description: "Minted Protocol daily points snapshots",
        data: csvContent,
        is_private: false,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Dune API error: ${response.status} — ${errorText}` };
    }

    console.log("[Dune] ✅ Snapshot uploaded successfully");
    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

// ═══════════════════════════════════════════════════════════════
// Export all queries as a single object for easy iteration
// ═══════════════════════════════════════════════════════════════

export const DUNE_QUERIES = {
  musdSupply: { name: "mUSD Supply & Minting", query: MUSD_SUPPLY_QUERY },
  smusdStaking: { name: "smUSD Staking Activity", query: SMUSD_STAKING_QUERY },
  borrowActivity: { name: "Borrow & Liquidation Activity", query: BORROW_ACTIVITY_QUERY },
  collateralDeposits: { name: "Collateral Deposits by Token", query: COLLATERAL_DEPOSITS_QUERY },
  bridgeActivity: { name: "Bridge Activity (Canton ↔ ETH)", query: BRIDGE_ACTIVITY_QUERY },
  topHolders: { name: "Top 100 mUSD Holders", query: TOP_HOLDERS_QUERY },
  treasuryStrategy: { name: "Treasury Strategy Performance", query: TREASURY_STRATEGY_QUERY },
};
