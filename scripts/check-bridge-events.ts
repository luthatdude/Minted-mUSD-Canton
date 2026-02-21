import { ethers } from "hardhat";
import { EventLog } from "ethers";

async function main() {
  const bridgeAddr = "0x155d6618dcdeb2F4145395CA57C80e6931D7941e"; // Check if this is right
  const musdAddr = "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B";
  
  // Try to find the bridge address from config
  const dotenv = require("dotenv");
  dotenv.config({ path: ".env" });

  // Read deployed addresses
  const fs = require("fs");
  let bridgeAddress = "";
  
  // Check .env for bridge address
  const envContent = fs.readFileSync(".env", "utf-8");
  const bridgeMatch = envContent.match(/BRIDGE_ADDRESS=(\S+)/);
  if (bridgeMatch) {
    bridgeAddress = bridgeMatch[1];
    console.log("Bridge address from .env:", bridgeAddress);
  }

  // Also check frontend config
  try {
    const envLocal = fs.readFileSync("frontend/.env.local", "utf-8");
    const lines = envLocal.split("\n");
    for (const line of lines) {
      if (line.includes("BRIDGE") || line.includes("BLE")) {
        console.log("Frontend env:", line.trim());
      }
    }
  } catch {}

  // Try known bridge addresses
  const possibleBridges = [
    bridgeAddress,
    "0x155d6618dcdeb2F4145395CA57C80e6931D7941e", // CollateralVault - probably wrong
  ].filter(Boolean);

  // Search for BridgeToCantonRequested events
  const provider = (await ethers.getSigners())[0].provider!;
  
  // Get BLEBridgeV9 ABI
  const BLE_ABI = [
    "event BridgeToCantonRequested(bytes32 indexed requestId, address indexed sender, uint256 amount, uint256 nonce, string cantonRecipient, uint256 timestamp)",
    "function currentNonce() view returns (uint256)",
    "function paused() view returns (bool)",
    "function bridgeOutMinAmount() view returns (uint256)",
  ];

  // Search for the contract in frontend config
  try {
    const configContent = fs.readFileSync("frontend/src/lib/config.ts", "utf-8");
    const bleMatch = configContent.match(/BLEBridgeV9[:\s]*["']([^"']+)["']/);
    if (bleMatch) {
      console.log("\nBLEBridgeV9 from frontend config:", bleMatch[1]);
      possibleBridges.push(bleMatch[1]);
    }
  } catch {}

  // Try each possible bridge address
  for (const addr of [...new Set(possibleBridges)]) {
    if (!addr) continue;
    console.log(`\n--- Checking ${addr} ---`);
    try {
      const contract = new ethers.Contract(addr, BLE_ABI, provider);
      const nonce = await contract.currentNonce();
      console.log("  currentNonce:", nonce.toString());
      const paused = await contract.paused();
      console.log("  paused:", paused);
      
      // Query for BridgeToCantonRequested events (last 50k blocks)
      const currentBlock = await provider.getBlockNumber();
      const fromBlock = Math.max(0, currentBlock - 50000);
      console.log(`  Searching events from block ${fromBlock} to ${currentBlock}...`);
      
      const filter = contract.filters.BridgeToCantonRequested();
      const events = await contract.queryFilter(filter, fromBlock, currentBlock);
      console.log(`  Found ${events.length} BridgeToCantonRequested events`);
      
      for (const evt of events) {
        const e = evt as EventLog;
        console.log(`\n  Event at block ${e.blockNumber}, tx: ${e.transactionHash}`);
        console.log(`    requestId: ${e.args.requestId}`);
        console.log(`    sender: ${e.args.sender}`);
        console.log(`    amount: ${ethers.formatEther(e.args.amount)} mUSD`);
        console.log(`    nonce: ${e.args.nonce.toString()}`);
        console.log(`    cantonRecipient: ${e.args.cantonRecipient}`);
        console.log(`    timestamp: ${new Date(Number(e.args.timestamp) * 1000).toISOString()}`);
      }
    } catch (err: any) {
      console.log(`  Not a BLEBridgeV9: ${err.message?.slice(0, 80)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
