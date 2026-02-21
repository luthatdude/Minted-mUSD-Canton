#!/usr/bin/env node
/**
 * Deploy SMUSDE + ETHPool to Sepolia using pre-compiled artifacts.
 * Bypasses Hardhat compilation (which has SMUSD.sol errors).
 */
const { ethers } = require("ethers");
require("dotenv").config();
const fs = require("fs");
const path = require("path");

// Deployed Sepolia addresses
const ADDRESSES = {
  MUSD: "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B",
  PriceOracle: "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025",
  MockWETH: "0x7999F2894290F2Ce34a508eeff776126D9a7D46e",
  Timelock: "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410",
  MockUSDC: "0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474",
  MockUSDT: "0xA0a4FAE8DA7892E216dE610cb2E6e800ffeb51D2",
};

const POOL_CAP = ethers.parseEther("1000000"); // 1M mUSD cap

function loadArtifact(contractPath) {
  const fullPath = path.join(__dirname, "..", "artifacts", "contracts", contractPath);
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

async function main() {
  const rpcUrl = process.env.RPC_URL || process.env.ETHEREUM_RPC_URL;
  const privKey = process.env.DEPLOYER_PRIVATE_KEY || process.env.RELAYER_PRIVATE_KEY;
  if (!rpcUrl || !privKey) {
    console.error("Need RPC_URL and DEPLOYER_PRIVATE_KEY in .env");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privKey, provider);
  console.log("Deployer:", wallet.address);
  console.log("Balance:", ethers.formatEther(await provider.getBalance(wallet.address)), "ETH\n");

  // ── Step 1: Deploy SMUSDE ──────────────────────────────────────────────
  console.log("Step 1: Deploying SMUSDE (smUSD-E receipt token)...");
  const smusdeArtifact = loadArtifact("SMUSDE.sol/SMUSDE.json");
  const smusdeFactory = new ethers.ContractFactory(smusdeArtifact.abi, smusdeArtifact.bytecode, wallet);
  const smusde = await smusdeFactory.deploy();
  await smusde.waitForDeployment();
  const smusdeAddr = await smusde.getAddress();
  console.log("  SMUSDE deployed to:", smusdeAddr);

  // ── Step 2: Deploy ETHPool ─────────────────────────────────────────────
  console.log("\nStep 2: Deploying ETHPool...");
  const ethPoolArtifact = loadArtifact("ETHPool.sol/ETHPool.json");
  const ethPoolFactory = new ethers.ContractFactory(ethPoolArtifact.abi, ethPoolArtifact.bytecode, wallet);
  const ethPool = await ethPoolFactory.deploy(
    ADDRESSES.MUSD,       // _musd
    smusdeAddr,           // _smUsdE
    ADDRESSES.PriceOracle,// _priceOracle
    ADDRESSES.MockWETH,   // _weth
    POOL_CAP,             // _poolCap
    ADDRESSES.Timelock,   // _timelockController
  );
  await ethPool.waitForDeployment();
  const ethPoolAddr = await ethPool.getAddress();
  console.log("  ETHPool deployed to:", ethPoolAddr);

  // ── Step 3: Grant POOL_ROLE on SMUSDE to ETHPool ──────────────────────
  console.log("\nStep 3: Granting POOL_ROLE on SMUSDE to ETHPool...");
  const POOL_ROLE = ethers.keccak256(ethers.toUtf8Bytes("POOL_ROLE"));
  const grantTx = await smusde.grantRole(POOL_ROLE, ethPoolAddr);
  await grantTx.wait();
  console.log("  POOL_ROLE granted");

  // ── Step 4: Add accepted stablecoins ──────────────────────────────────
  console.log("\nStep 4: Adding accepted stablecoins...");
  try {
    const addUsdcTx = await ethPool.addAcceptedStablecoin(ADDRESSES.MockUSDC, 6);
    await addUsdcTx.wait();
    console.log("  USDC added (6 decimals)");
  } catch (e) {
    console.log("  USDC add skipped:", e.reason || e.message);
  }
  try {
    const addUsdtTx = await ethPool.addAcceptedStablecoin(ADDRESSES.MockUSDT, 6);
    await addUsdtTx.wait();
    console.log("  USDT added (6 decimals)");
  } catch (e) {
    console.log("  USDT add skipped:", e.reason || e.message);
  }

  // ── Step 5: Grant BRIDGE_ROLE on MUSD to ETHPool so it can mint ───────
  console.log("\nStep 5: Granting BRIDGE_ROLE on MUSD to ETHPool...");
  const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ROLE"));
  const musdContract = new ethers.Contract(
    ADDRESSES.MUSD,
    ["function grantRole(bytes32 role, address account)", "function hasRole(bytes32 role, address account) view returns (bool)"],
    wallet,
  );
  const hasRole = await musdContract.hasRole(BRIDGE_ROLE, ethPoolAddr);
  if (!hasRole) {
    try {
      const tx = await musdContract.grantRole(BRIDGE_ROLE, ethPoolAddr);
      await tx.wait();
      console.log("  BRIDGE_ROLE granted on MUSD");
    } catch (e) {
      console.log("  ⚠️  Could not grant BRIDGE_ROLE (may need timelock):", e.reason || e.message);
      console.log("     ETHPool will need BRIDGE_ROLE to mint mUSD for stakers");
    }
  } else {
    console.log("  BRIDGE_ROLE already granted");
  }

  console.log("\n══════════════════════════════════════════════════════");
  console.log("✅ Deployment Complete!");
  console.log("══════════════════════════════════════════════════════");
  console.log("SMUSDE:", smusdeAddr);
  console.log("ETHPool:", ethPoolAddr);
  console.log("\nAdd to frontend/.env.local:");
  console.log(`NEXT_PUBLIC_SMUSDE_ADDRESS=${smusdeAddr}`);
  console.log(`NEXT_PUBLIC_ETH_POOL_ADDRESS=${ethPoolAddr}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
