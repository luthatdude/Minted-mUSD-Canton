/**
 * Minted Points — Snapshot Service
 *
 * Reads on-chain balances from Ethereum contracts and Canton Ledger API
 * every SNAPSHOT_INTERVAL_MS and stores them in the database.
 *
 * This is the data collection layer — it does NOT calculate points.
 * The calculator runs after each snapshot to accumulate points.
 */

import { ethers } from "ethers";
import {
  CONTRACTS,
  SNAPSHOT_INTERVAL_MS,
  MIN_VALUE_USD,
  PointAction,
  getCurrentSeason,
} from "./config";
import { insertSnapshots, getMetadata, setMetadata, type SnapshotRow } from "./db";

// ═══════════════════════════════════════════════════════════════════════════
// MINIMAL ABIs — only the functions we need
// ═══════════════════════════════════════════════════════════════════════════

const SMUSD_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function globalSharePrice() view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

const COLLATERAL_VAULT_ABI = [
  "function deposits(address user, address token) view returns (uint256)",
  "function getDeposit(address user, address token) view returns (uint256)",
  "function getSupportedTokens() view returns (address[])",
  "event Deposited(address indexed user, address indexed token, uint256 amount)",
];

const BORROW_MODULE_ABI = [
  "function totalDebt(address user) view returns (uint256)",
  "event Borrowed(address indexed user, uint256 amount, uint256 totalDebt)",
];

const LEVERAGE_VAULT_ABI = [
  "function getPosition(address user) view returns (tuple(address collateralToken, uint256 initialDeposit, uint256 totalCollateral, uint256 totalDebt, uint256 loopsExecuted, uint256 targetLeverageX10, uint256 openedAt))",
  "event LeverageOpened(address indexed user, address indexed collateralToken, uint256 initialDeposit, uint256 totalCollateral, uint256 totalDebt, uint256 loopsExecuted, uint256 effectiveLeverageX10)",
];

const PRICE_ORACLE_ABI = [
  "function getPrice(address token) view returns (uint256)",
];

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
];

// ═══════════════════════════════════════════════════════════════════════════
// PROVIDER + CONTRACT INSTANCES
// ═══════════════════════════════════════════════════════════════════════════

let provider: ethers.JsonRpcProvider;
let smusd: ethers.Contract;
let collateralVault: ethers.Contract;
let borrowModule: ethers.Contract;
let leverageVault: ethers.Contract | null;
let priceOracle: ethers.Contract;

function initContracts(): void {
  provider = new ethers.JsonRpcProvider(CONTRACTS.ethereum.RPC_URL);

  smusd = new ethers.Contract(CONTRACTS.ethereum.SMUSD, SMUSD_ABI, provider);
  collateralVault = new ethers.Contract(CONTRACTS.ethereum.COLLATERAL_VAULT, COLLATERAL_VAULT_ABI, provider);
  borrowModule = new ethers.Contract(CONTRACTS.ethereum.BORROW_MODULE, BORROW_MODULE_ABI, provider);
  priceOracle = new ethers.Contract(CONTRACTS.ethereum.PRICE_ORACLE, PRICE_ORACLE_ABI, provider);

  if (CONTRACTS.ethereum.LEVERAGE_VAULT) {
    leverageVault = new ethers.Contract(CONTRACTS.ethereum.LEVERAGE_VAULT, LEVERAGE_VAULT_ABI, provider);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// USER DISCOVERY — scan events to find all addresses
// ═══════════════════════════════════════════════════════════════════════════

/** Cache of discovered addresses to avoid re-scanning old blocks */
const knownUsers = {
  smusdHolders: new Set<string>(),
  depositors: new Set<string>(),
  borrowers: new Set<string>(),
  leveragers: new Set<string>(),
};

async function discoverUsers(): Promise<void> {
  const lastScannedBlock = parseInt(getMetadata("last_scanned_block") ?? "0");
  const currentBlock = await provider.getBlockNumber();

  if (currentBlock <= lastScannedBlock) return;

  // Scan in chunks to avoid RPC limits
  const CHUNK_SIZE = 10_000;
  let fromBlock = lastScannedBlock + 1;

  while (fromBlock <= currentBlock) {
    const toBlock = Math.min(fromBlock + CHUNK_SIZE - 1, currentBlock);

    // sMUSD Transfer events (mints = from address(0))
    const mintFilter = smusd.filters.Transfer(ethers.ZeroAddress);
    const mints = await smusd.queryFilter(mintFilter, fromBlock, toBlock);
    for (const event of mints) {
      const log = event as ethers.EventLog;
      knownUsers.smusdHolders.add(log.args[1]); // 'to' address
    }

    // Also track sMUSD transfers to catch secondary holders
    const transferFilter = smusd.filters.Transfer();
    const transfers = await smusd.queryFilter(transferFilter, fromBlock, toBlock);
    for (const event of transfers) {
      const log = event as ethers.EventLog;
      knownUsers.smusdHolders.add(log.args[1]); // 'to' address
    }

    // CollateralVault deposits
    const depositFilter = collateralVault.filters.Deposited();
    const deposits = await collateralVault.queryFilter(depositFilter, fromBlock, toBlock);
    for (const event of deposits) {
      const log = event as ethers.EventLog;
      knownUsers.depositors.add(log.args[0]); // 'user' address
    }

    // Borrow events
    const borrowFilter = borrowModule.filters.Borrowed();
    const borrows = await borrowModule.queryFilter(borrowFilter, fromBlock, toBlock);
    for (const event of borrows) {
      const log = event as ethers.EventLog;
      knownUsers.borrowers.add(log.args[0]);
    }

    // Leverage events
    if (leverageVault) {
      const levFilter = leverageVault.filters.LeverageOpened();
      const levs = await leverageVault.queryFilter(levFilter, fromBlock, toBlock);
      for (const event of levs) {
        const log = event as ethers.EventLog;
        knownUsers.leveragers.add(log.args[0]);
      }
    }

    fromBlock = toBlock + 1;
  }

  setMetadata("last_scanned_block", currentBlock.toString());
  console.log(
    `[Snapshot] Discovered users — sMUSD: ${knownUsers.smusdHolders.size}, Depositors: ${knownUsers.depositors.size}, Borrowers: ${knownUsers.borrowers.size}, Leveragers: ${knownUsers.leveragers.size}`
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ETHEREUM SNAPSHOT
// ═══════════════════════════════════════════════════════════════════════════

/** Token address → known decimals + Chainlink symbol mapping */
const TOKEN_ACTIONS: Record<string, PointAction> = {};

async function snapshotEthereum(seasonId: number): Promise<SnapshotRow[]> {
  const rows: SnapshotRow[] = [];
  const timestamp = new Date().toISOString();

  // Get the share price for USD conversion (sMUSD is 1:1-ish with mUSD which pegs to $1)
  let sharePriceRaw: bigint;
  try {
    sharePriceRaw = await smusd.globalSharePrice();
  } catch {
    sharePriceRaw = BigInt(1e3); // Fallback 1.0 (with _decimalsOffset=3)
  }
  const sharePrice = Number(sharePriceRaw) / 1e3; // Normalize share price

  // 1) sMUSD holders
  for (const addr of knownUsers.smusdHolders) {
    try {
      const balance: bigint = await smusd.balanceOf(addr);
      if (balance === 0n) continue;

      // Convert shares to underlying mUSD value
      const assetsRaw: bigint = await smusd.convertToAssets(balance);
      const valueUsd = Number(ethers.formatEther(assetsRaw)); // mUSD is 18 decimals, pegged $1

      if (valueUsd < MIN_VALUE_USD) continue;

      rows.push({
        timestamp,
        chain: "ethereum",
        user_address: addr,
        action: PointAction.ETH_SMUSD_HOLD,
        balance_raw: balance.toString(),
        value_usd: valueUsd,
        season_id: seasonId,
      });
    } catch (e) {
      console.error(`[Snapshot] Error reading sMUSD for ${addr}:`, e);
    }
  }

  // 2) Collateral depositors
  let supportedTokens: string[] = [];
  try {
    supportedTokens = await collateralVault.getSupportedTokens();
  } catch {
    console.warn("[Snapshot] Could not get supported tokens");
  }

  for (const addr of knownUsers.depositors) {
    for (const token of supportedTokens) {
      try {
        const deposit: bigint = await collateralVault.getDeposit(addr, token);
        if (deposit === 0n) continue;

        // Get price from oracle
        const priceRaw: bigint = await priceOracle.getPrice(token);
        const tokenContract = new ethers.Contract(token, ERC20_ABI, provider);
        const decimals: number = await tokenContract.decimals();

        const depositNormalized = Number(ethers.formatUnits(deposit, decimals));
        const priceUsd = Number(ethers.formatUnits(priceRaw, 8)); // Chainlink 8 decimals
        const valueUsd = depositNormalized * priceUsd;

        if (valueUsd < MIN_VALUE_USD) continue;

        // Determine which collateral action this is
        const action = classifyCollateral(token);

        rows.push({
          timestamp,
          chain: "ethereum",
          user_address: addr,
          action,
          balance_raw: deposit.toString(),
          value_usd: valueUsd,
          season_id: seasonId,
        });
      } catch (e) {
        console.error(`[Snapshot] Error reading collateral for ${addr}/${token}:`, e);
      }
    }
  }

  // 3) Borrowers
  for (const addr of knownUsers.borrowers) {
    try {
      const debt: bigint = await borrowModule.totalDebt(addr);
      if (debt === 0n) continue;

      const valueUsd = Number(ethers.formatEther(debt)); // mUSD 18 decimals, pegged $1

      if (valueUsd < MIN_VALUE_USD) continue;

      rows.push({
        timestamp,
        chain: "ethereum",
        user_address: addr,
        action: PointAction.ETH_BORROW,
        balance_raw: debt.toString(),
        value_usd: valueUsd,
        season_id: seasonId,
      });
    } catch (e) {
      console.error(`[Snapshot] Error reading debt for ${addr}:`, e);
    }
  }

  // 4) Leverage positions
  if (leverageVault) {
    for (const addr of knownUsers.leveragers) {
      try {
        const pos = await leverageVault.getPosition(addr);
        if (pos.totalCollateral === 0n) continue;

        // Value the total collateral position
        const priceRaw: bigint = await priceOracle.getPrice(pos.collateralToken);
        const tokenContract = new ethers.Contract(pos.collateralToken, ERC20_ABI, provider);
        const decimals: number = await tokenContract.decimals();

        const totalCol = Number(ethers.formatUnits(pos.totalCollateral, decimals));
        const priceUsd = Number(ethers.formatUnits(priceRaw, 8));
        const valueUsd = totalCol * priceUsd;

        if (valueUsd < MIN_VALUE_USD) continue;

        rows.push({
          timestamp,
          chain: "ethereum",
          user_address: addr,
          action: PointAction.ETH_LEVERAGE,
          balance_raw: pos.totalCollateral.toString(),
          value_usd: valueUsd,
          season_id: seasonId,
        });
      } catch (e) {
        console.error(`[Snapshot] Error reading leverage for ${addr}:`, e);
      }
    }
  }

  return rows;
}

/** Map a collateral token address to the right PointAction */
function classifyCollateral(tokenAddress: string): PointAction {
  const addr = tokenAddress.toLowerCase();

  // sMUSD as collateral
  if (addr === CONTRACTS.ethereum.SMUSD.toLowerCase()) {
    return PointAction.ETH_COLLATERAL_SMUSD;
  }

  // WBTC — common addresses
  const wbtcAddresses = [
    "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", // Mainnet
    "0x29f2d40b0605204364af54ec677bd022da425d03", // Sepolia mock
  ];
  if (wbtcAddresses.includes(addr)) {
    return PointAction.ETH_COLLATERAL_WBTC;
  }

  // Default: ETH/WETH
  return PointAction.ETH_COLLATERAL_ETH;
}

// ═══════════════════════════════════════════════════════════════════════════
// CANTON SNAPSHOT
// ═══════════════════════════════════════════════════════════════════════════

interface CantonContract {
  templateId: string;
  payload: Record<string, any>;
}

async function queryCantonContracts(templateId: string): Promise<CantonContract[]> {
  const { LEDGER_HOST, LEDGER_PORT } = CONTRACTS.canton;

  try {
    const response = await fetch(
      `http://${LEDGER_HOST}:${LEDGER_PORT}/v1/query`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.CANTON_JWT_TOKEN || ""}`,
        },
        body: JSON.stringify({
          templateIds: [templateId],
          query: {},
        }),
      }
    );

    if (!response.ok) {
      console.error(`[Canton] Query failed for ${templateId}: ${response.status}`);
      return [];
    }

    const data: any = await response.json();
    return (data.result || []).map((item: any) => ({
      templateId: item.templateId,
      payload: item.payload,
    }));
  } catch (e) {
    console.error(`[Canton] Query error for ${templateId}:`, e);
    return [];
  }
}

async function snapshotCanton(seasonId: number): Promise<SnapshotRow[]> {
  const rows: SnapshotRow[] = [];
  const timestamp = new Date().toISOString();

  // 1) CantonSMUSD holders
  const smusdContracts = await queryCantonContracts("CantonSMUSD:CantonSMUSD");
  for (const c of smusdContracts) {
    const owner = c.payload.owner;
    const shares = parseFloat(c.payload.shares || "0");
    const entryPrice = parseFloat(c.payload.entrySharePrice || "1.0");

    // Value = shares × current share price (approximate with entry for now)
    // In production, fetch globalSharePrice from the bridge sync
    const valueUsd = shares * entryPrice;
    if (valueUsd < MIN_VALUE_USD) continue;

    rows.push({
      timestamp,
      chain: "canton",
      user_address: owner,
      action: PointAction.CTN_SMUSD_HOLD,
      balance_raw: shares.toString(),
      value_usd: valueUsd,
      season_id: seasonId,
    });
  }

  // 2) Canton Boost Pool LP positions — THE BIG ONE 🔥
  const boostLPs = await queryCantonContracts("CantonBoostPool:BoostPoolLP");
  const poolService = await queryCantonContracts("CantonBoostPool:CantonBoostPoolService");

  let cantonPriceMusd = 0.166; // Fallback from last known price
  let totalLPShares = 1; // Avoid division by zero
  let totalCantonDeposited = 0;

  if (poolService.length > 0) {
    const svc = poolService[0].payload;
    cantonPriceMusd = parseFloat(svc.cantonPriceMusd || "0.166");
    totalLPShares = parseFloat(svc.totalLPShares || "1");
    totalCantonDeposited = parseFloat(svc.totalCantonDeposited || "0");
  }

  for (const c of boostLPs) {
    const owner = c.payload.owner;
    const shares = parseFloat(c.payload.shares || "0");

    // User's pro-rata Canton value in USD
    const userCantonAmount = (shares / totalLPShares) * totalCantonDeposited;
    const valueUsd = userCantonAmount * cantonPriceMusd; // Canton price in mUSD ≈ USD
    if (valueUsd < MIN_VALUE_USD) continue;

    rows.push({
      timestamp,
      chain: "canton",
      user_address: owner,
      action: PointAction.CTN_BOOST_POOL,
      balance_raw: shares.toString(),
      value_usd: valueUsd,
      season_id: seasonId,
    });
  }

  // 3) Canton Lending — collateral deposits
  const lendingPositions = await queryCantonContracts("CantonLending:LendingPosition");
  for (const c of lendingPositions) {
    const owner = c.payload.borrower;
    const collateral = c.payload.collateral || {};

    // CTN collateral
    const ctnAmount = parseFloat(collateral.ctnAmount || "0");
    if (ctnAmount > 0) {
      const valueUsd = ctnAmount * cantonPriceMusd;
      if (valueUsd >= MIN_VALUE_USD) {
        rows.push({
          timestamp,
          chain: "canton",
          user_address: owner,
          action: PointAction.CTN_COLLATERAL_CTN,
          balance_raw: ctnAmount.toString(),
          value_usd: valueUsd,
          season_id: seasonId,
        });
      }
    }

    // sMUSD collateral (on Canton)
    const smusdAmount = parseFloat(collateral.smusdAmount || "0");
    if (smusdAmount > 0) {
      const valueUsd = smusdAmount; // sMUSD ≈ $1 per underlying
      if (valueUsd >= MIN_VALUE_USD) {
        rows.push({
          timestamp,
          chain: "canton",
          user_address: owner,
          action: PointAction.CTN_COLLATERAL_SMUSD,
          balance_raw: smusdAmount.toString(),
          value_usd: valueUsd,
          season_id: seasonId,
        });
      }
    }

    // Canton borrows
    const debtAmount = parseFloat(c.payload.debt || c.payload.borrowedAmount || "0");
    if (debtAmount > 0) {
      const valueUsd = debtAmount; // mUSD pegged $1
      if (valueUsd >= MIN_VALUE_USD) {
        rows.push({
          timestamp,
          chain: "canton",
          user_address: owner,
          action: PointAction.CTN_BORROW,
          balance_raw: debtAmount.toString(),
          value_usd: valueUsd,
          season_id: seasonId,
        });
      }
    }
  }

  return rows;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN SNAPSHOT LOOP
// ═══════════════════════════════════════════════════════════════════════════

export async function takeSnapshot(): Promise<SnapshotRow[]> {
  const season = getCurrentSeason();
  if (!season) {
    console.log("[Snapshot] No active season — skipping");
    return [];
  }

  console.log(`[Snapshot] Taking snapshot for Season ${season.id}: ${season.name}`);

  initContracts();
  await discoverUsers();

  const [ethRows, cantonRows] = await Promise.all([
    snapshotEthereum(season.id),
    snapshotCanton(season.id),
  ]);

  const allRows = [...ethRows, ...cantonRows];

  if (allRows.length > 0) {
    insertSnapshots(allRows);
    setMetadata("last_snapshot", new Date().toISOString());
  }

  console.log(
    `[Snapshot] Stored ${allRows.length} rows (ETH: ${ethRows.length}, Canton: ${cantonRows.length})`
  );

  return allRows;
}

export function startSnapshotLoop(): void {
  console.log(`[Snapshot] Starting snapshot loop (interval: ${SNAPSHOT_INTERVAL_MS / 1000}s)`);

  // Take initial snapshot
  takeSnapshot().catch(console.error);

  // Schedule recurring snapshots
  setInterval(() => {
    takeSnapshot().catch(console.error);
  }, SNAPSHOT_INTERVAL_MS);
}
