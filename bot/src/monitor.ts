// Minted mUSD Protocol - Position Monitor
// View-only monitoring without liquidation execution
//
// Never load .env files. All config comes from env vars.

import { ethers } from "ethers";

// Validate required env vars at startup (read-only — no private key needed)
const REQUIRED_MONITOR_VARS = ["RPC_URL", "BORROW_MODULE_ADDRESS", "LIQUIDATION_ENGINE_ADDRESS", "COLLATERAL_VAULT_ADDRESS", "PRICE_ORACLE_ADDRESS"] as const;
for (const name of REQUIRED_MONITOR_VARS) {
  if (!process.env[name]) {
    console.error(`FATAL: ${name} env var is required`);
    process.exit(1);
  }
}

const BORROW_MODULE_ABI = [
  "function healthFactor(address user) external view returns (uint256)",
  "function totalDebt(address user) external view returns (uint256)",
  "function positions(address user) external view returns (uint256 principal, uint256 accruedInterest, uint256 lastAccrualTime)",
  "event Borrowed(address indexed user, uint256 amount, uint256 totalDebt)",
];

const LIQUIDATION_ENGINE_ABI = [
  "function isLiquidatable(address borrower) external view returns (bool)",
  "function closeFactorBps() external view returns (uint256)",
];

const COLLATERAL_VAULT_ABI = [
  "function deposits(address user, address token) external view returns (uint256)",
  "function getSupportedTokens() external view returns (address[])",
  "function getConfig(address token) external view returns (bool enabled, uint256 collateralFactorBps, uint256 liquidationThresholdBps, uint256 liquidationPenaltyBps)",
];

const PRICE_ORACLE_ABI = [
  "function getPrice(address token) external view returns (uint256)",
  "function getValueUsd(address token, uint256 amount) external view returns (uint256)",
];

const ERC20_ABI = [
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
];

interface PositionInfo {
  address: string;
  debt: string;
  healthFactor: string;
  isLiquidatable: boolean;
  collateral: { symbol: string; amount: string; valueUsd: string }[];
}

async function monitorPositions(borrowerAddresses: string[]) {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  
  const borrowModule = new ethers.Contract(process.env.BORROW_MODULE_ADDRESS!, BORROW_MODULE_ABI, provider);
  const liquidationEngine = new ethers.Contract(process.env.LIQUIDATION_ENGINE_ADDRESS!, LIQUIDATION_ENGINE_ABI, provider);
  const collateralVault = new ethers.Contract(process.env.COLLATERAL_VAULT_ADDRESS!, COLLATERAL_VAULT_ABI, provider);
  const priceOracle = new ethers.Contract(process.env.PRICE_ORACLE_ADDRESS!, PRICE_ORACLE_ABI, provider);
  
  // Get supported tokens
  const supportedTokens: string[] = await collateralVault.getSupportedTokens();
  const tokenInfo: Map<string, { symbol: string; decimals: number }> = new Map();
  
  for (const token of supportedTokens) {
    const tokenContract = new ethers.Contract(token, ERC20_ABI, provider);
    const symbol = await tokenContract.symbol();
    const decimals = await tokenContract.decimals();
    tokenInfo.set(token, { symbol, decimals });
  }
  
  console.log("\n" + "=".repeat(80));
  console.log("                    MINTED mUSD - POSITION MONITOR");
  console.log("=".repeat(80));
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Monitoring ${borrowerAddresses.length} positions\n`);
  
  const positions: PositionInfo[] = [];
  let liquidatableCount = 0;
  
  for (const address of borrowerAddresses) {
    try {
      const debt = await borrowModule.totalDebt(address);
      
      if (debt === 0n) {
        continue;
      }
      
      const healthFactor = await borrowModule.healthFactor(address);
      const isLiquidatable = await liquidationEngine.isLiquidatable(address);
      
      const collateralList: { symbol: string; amount: string; valueUsd: string }[] = [];
      
      for (const token of supportedTokens) {
        const balance = await collateralVault.deposits(address, token);
        if (balance > 0n) {
          const info = tokenInfo.get(token)!;
          const valueUsd = await priceOracle.getValueUsd(token, balance);
          collateralList.push({
            symbol: info.symbol,
            amount: ethers.formatUnits(balance, info.decimals),
            valueUsd: ethers.formatEther(valueUsd),
          });
        }
      }
      
      const position: PositionInfo = {
        address,
        debt: ethers.formatEther(debt),
        healthFactor: (Number(healthFactor) / 10000).toFixed(4),
        isLiquidatable,
        collateral: collateralList,
      };
      
      positions.push(position);
      
      if (isLiquidatable) {
        liquidatableCount++;
      }
    } catch (error) {
      console.error(`Error fetching position for ${address}: ${error}`);
    }
  }
  
  // Sort by health factor (lowest first)
  positions.sort((a, b) => Number(a.healthFactor) - Number(b.healthFactor));
  
  // Display positions
  for (const pos of positions) {
    const status = pos.isLiquidatable ? "🔴 LIQUIDATABLE" : "🟢 HEALTHY";
    const hf = Number(pos.healthFactor);
    if (isNaN(hf)) { console.error(`Invalid healthFactor for ${pos.address}: ${pos.healthFactor}`); continue; }
    const hfColor = hf < 1.0 ? "\x1b[31m" : 
                    hf < 1.2 ? "\x1b[33m" : "\x1b[32m";
    
    console.log("-".repeat(80));
    console.log(`Address: ${pos.address}`);
    console.log(`Status:  ${status}`);
    console.log(`Health Factor: ${hfColor}${pos.healthFactor}\x1b[0m`);
    console.log(`Debt: ${pos.debt} mUSD`);
    console.log("Collateral:");
    for (const col of pos.collateral) {
      const valUsd = Number(col.valueUsd);
      console.log(`  - ${col.amount} ${col.symbol} ($${isNaN(valUsd) ? "?.??" : valUsd.toFixed(2)})`);
    }
  }
  
  console.log("\n" + "=".repeat(80));
  console.log(`SUMMARY: ${positions.length} active positions, ${liquidatableCount} liquidatable`);
  console.log("=".repeat(80) + "\n");
  
  return positions;
}

// Watch mode - continuously monitor
async function watchMode(borrowerAddresses: string[], intervalMs: number = 30000) {
  console.log(`Starting watch mode (refreshing every ${intervalMs / 1000}s)...`);
  console.log("Press Ctrl+C to stop\n");
  
  while (true) {
    console.clear();
    await monitorPositions(borrowerAddresses);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Scan for borrowers from events
async function scanBorrowers(fromBlock: number): Promise<string[]> {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const borrowModule = new ethers.Contract(process.env.BORROW_MODULE_ADDRESS!, BORROW_MODULE_ABI, provider);
  
  const currentBlock = await provider.getBlockNumber();
  const borrowers = new Set<string>();
  
  console.log(`Scanning for borrowers from block ${fromBlock} to ${currentBlock}...`);
  
  const batchSize = 10000;
  for (let start = fromBlock; start < currentBlock; start += batchSize) {
    const end = Math.min(start + batchSize - 1, currentBlock);
    const filter = borrowModule.filters.Borrowed();
    const events = await borrowModule.queryFilter(filter, start, end);
    
    for (const event of events) {
      const args = (event as any).args;
      if (args && args.user) {
        borrowers.add(args.user);
      }
    }
    
    process.stdout.write(`\rScanned blocks ${start}-${end}: ${borrowers.size} borrowers found`);
  }
  
  console.log(`\nFound ${borrowers.size} unique borrowers\n`);
  return Array.from(borrowers);
}

// Main
async function main() {
  const args = process.argv.slice(2);
  
  if (args[0] === "--scan") {
    const fromBlock = parseInt(args[1] || "0");
    const borrowers = await scanBorrowers(fromBlock);
    console.log("Borrower addresses:");
    borrowers.forEach((b) => console.log(b));
    return;
  }
  
  if (args[0] === "--watch") {
    const fromBlock = parseInt(args[1] || "0");
    const borrowers = await scanBorrowers(fromBlock);
    await watchMode(borrowers);
    return;
  }
  
  if (args[0] === "--address") {
    const addresses = args.slice(1);
    await monitorPositions(addresses);
    return;
  }
  
  console.log("Usage:");
  console.log("  npm run monitor -- --scan <fromBlock>      Scan for all borrowers");
  console.log("  npm run monitor -- --watch <fromBlock>     Continuous monitoring");
  console.log("  npm run monitor -- --address <addr1> ...   Monitor specific addresses");
}

main().catch(console.error);
