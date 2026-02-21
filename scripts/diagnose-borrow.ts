import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const CONTRACTS = {
    CollateralVault: process.env.NEXT_PUBLIC_COLLATERAL_VAULT_ADDRESS,
    BorrowModule: process.env.NEXT_PUBLIC_BORROW_MODULE_ADDRESS,
    PriceOracle: process.env.NEXT_PUBLIC_PRICE_ORACLE_ADDRESS,
    MUSD: process.env.NEXT_PUBLIC_MUSD_ADDRESS,
  };

  console.log("\n=== Contract Addresses ===");
  for (const [name, addr] of Object.entries(CONTRACTS)) {
    console.log(`${name}: ${addr || "NOT SET"}`);
  }

  if (!CONTRACTS.CollateralVault || !CONTRACTS.BorrowModule || !CONTRACTS.PriceOracle) {
    console.log("ERROR: Missing contract addresses in env");
    return;
  }

  // CollateralVault
  const vault = await ethers.getContractAt("CollateralVault", CONTRACTS.CollateralVault);
  const tokens: string[] = await vault.getSupportedTokens();
  console.log("\n=== Supported Tokens ===");
  console.log("Count:", tokens.length);

  for (const token of tokens) {
    const erc20 = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/ERC20.sol:ERC20", token);
    const sym = await erc20.symbol();
    const dec = await erc20.decimals();
    const config = await vault.getConfig(token);
    console.log(`\nToken: ${sym} (${token})`);
    console.log(`  Decimals: ${dec}`);
    console.log(`  Enabled: ${config[0]}, ColFactor: ${config[1]}bps, LiqThreshold: ${config[2]}bps, LiqPenalty: ${config[3]}bps`);

    const dep = await vault.deposits(deployer.address, token);
    console.log(`  Deployer deposit: ${ethers.formatUnits(dep, dec)} ${sym}`);
  }

  // Oracle
  const oracle = await ethers.getContractAt("PriceOracle", CONTRACTS.PriceOracle);
  console.log("\n=== Oracle Prices ===");
  for (const token of tokens) {
    const erc20 = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/ERC20.sol:ERC20", token);
    const sym = await erc20.symbol();
    const dec = await erc20.decimals();
    try {
      const price = await oracle.getPrice(token);
      console.log(`${sym} getPrice: ${ethers.formatUnits(price, 8)} USD (raw: ${price})`);
    } catch (e: any) {
      console.log(`${sym} getPrice ERROR: ${e.message?.slice(0, 200)}`);
    }
    try {
      const value = await oracle.getValueUsd(token, ethers.parseUnits("1", dec));
      console.log(`  1 ${sym} getValueUsd: ${ethers.formatUnits(value, 18)} USD`);
    } catch (e: any) {
      console.log(`  getValueUsd ERROR: ${e.message?.slice(0, 200)}`);
    }
  }

  // BorrowModule
  const borrow = await ethers.getContractAt("BorrowModule", CONTRACTS.BorrowModule);
  console.log("\n=== BorrowModule State ===");
  console.log("totalBorrows:", ethers.formatUnits(await borrow.totalBorrows(), 18));
  console.log("interestRateBps:", (await borrow.interestRateBps()).toString());
  console.log("minDebt:", ethers.formatUnits(await borrow.minDebt(), 18));

  const irModel = await borrow.interestRateModel();
  console.log("interestRateModel:", irModel);
  const smusdAddr = await borrow.smusd();
  console.log("smusd:", smusdAddr);
  const treasuryAddr = await borrow.treasury();
  console.log("treasury:", treasuryAddr);

  // Check deployer position
  const debt = await borrow.totalDebt(deployer.address);
  console.log("\nDeployer totalDebt:", ethers.formatUnits(debt, 18));
  try {
    const hf = await borrow.healthFactor(deployer.address);
    console.log("Deployer healthFactor:", hf.toString());
  } catch (e: any) {
    console.log("healthFactor ERROR:", e.message?.slice(0, 200));
  }
  try {
    const mb = await borrow.maxBorrow(deployer.address);
    console.log("Deployer maxBorrow:", ethers.formatUnits(mb, 18));
  } catch (e: any) {
    console.log("maxBorrow ERROR:", e.message?.slice(0, 200));
  }
  try {
    const cap = await borrow.borrowCapacity(deployer.address);
    console.log("Deployer borrowCapacity:", ethers.formatUnits(cap, 18));
  } catch (e: any) {
    console.log("borrowCapacity ERROR:", e.message?.slice(0, 200));
  }

  // Paused?
  try {
    const paused = await borrow.paused();
    console.log("\nContract paused:", paused);
  } catch (e: any) {
    console.log("paused() ERROR:", e.message?.slice(0, 100));
  }

  // MUSD supply cap
  if (CONTRACTS.MUSD) {
    const musd = await ethers.getContractAt("MUSD", CONTRACTS.MUSD);
    try {
      const cap = await musd.cap();
      const supply = await musd.totalSupply();
      console.log(`\nMUSD cap: ${ethers.formatUnits(cap, 18)}, supply: ${ethers.formatUnits(supply, 18)}, remaining: ${ethers.formatUnits(cap - supply, 18)}`);
    } catch (e: any) {
      console.log("MUSD cap/supply ERROR:", e.message?.slice(0, 100));
    }
  }

  // Check oracle feed details
  console.log("\n=== Oracle Feed Details ===");
  for (const token of tokens) {
    const erc20 = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/ERC20.sol:ERC20", token);
    const sym = await erc20.symbol();
    try {
      const feed = await oracle.feeds(token);
      console.log(`${sym} feed: ${feed}`);
      if (feed !== ethers.ZeroAddress) {
        // Try reading latest round from Chainlink
        const chainlink = new ethers.Contract(feed, [
          "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
          "function decimals() view returns (uint8)"
        ], deployer);
        const [, answer, , updatedAt] = await chainlink.latestRoundData();
        const feedDec = await chainlink.decimals();
        const age = Math.floor(Date.now()/1000) - Number(updatedAt);
        console.log(`  answer: ${ethers.formatUnits(answer, feedDec)} USD, updatedAt: ${updatedAt} (${age}s ago)`);
      }
    } catch (e: any) {
      console.log(`${sym} feed lookup ERROR: ${e.message?.slice(0, 200)}`);
    }
  }
}

main().catch(console.error);
