#!/usr/bin/env node
/**
 * Deploy MockUSDT using raw ethers.js — bypasses Hardhat compilation entirely.
 * Uses the already-deployed MockERC20 bytecode from MockUSDC deployment.
 */
const { ethers } = require("ethers");
require("dotenv").config();

const MOCK_ERC20_ABI = [
  "constructor(string name, string symbol, uint8 decimals_)",
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
];

// MockERC20 bytecode — we'll grab it from the existing artifacts
const fs = require("fs");
const path = require("path");

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
  const bal = await provider.getBalance(wallet.address);
  console.log("Balance:", ethers.formatEther(bal), "ETH");

  // Load compiled artifact
  const artifactPath = path.join(__dirname, "../artifacts/contracts/mocks/MockERC20.sol/MockERC20.json");
  if (!fs.existsSync(artifactPath)) {
    console.error("MockERC20 artifact not found. Run: npx hardhat compile --force first");
    console.error("Or use: npx hardhat compile contracts/mocks/MockERC20.sol");
    process.exit(1);
  }
  
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  console.log("Deploying MockUSDT (6 decimals)...");
  
  const usdt = await factory.deploy("Mock USDT", "USDT", 6);
  console.log("Tx hash:", usdt.deploymentTransaction().hash);
  
  await usdt.waitForDeployment();
  const addr = await usdt.getAddress();
  console.log("\n✅ MockUSDT deployed to:", addr);
  console.log("\nAdd to frontend/.env.local:");
  console.log(`NEXT_PUBLIC_USDT_ADDRESS=${addr}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
