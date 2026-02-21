import { ethers } from "hardhat";
import { EventLog } from "ethers";

async function main() {
  const bridgeAddr = "0x708957bFfA312D1730BdF87467E695D3a9F26b0f";
  const provider = (await ethers.getSigners())[0].provider!;

  const BLE_ABI = [
    "event BridgeToCantonRequested(bytes32 indexed requestId, address indexed sender, uint256 amount, uint256 nonce, string cantonRecipient, uint256 timestamp)",
    "function currentNonce() view returns (uint256)",
    "function paused() view returns (bool)",
    "function bridgeOutMinAmount() view returns (uint256)",
  ];

  const bridge = new ethers.Contract(bridgeAddr, BLE_ABI, provider);
  
  console.log("BLEBridgeV9:", bridgeAddr);
  console.log("currentNonce:", (await bridge.currentNonce()).toString());
  console.log("paused:", await bridge.paused());
  
  try {
    const minAmt = await bridge.bridgeOutMinAmount();
    console.log("bridgeOutMinAmount:", ethers.formatEther(minAmt), "mUSD");
  } catch { console.log("bridgeOutMinAmount: N/A"); }

  // Query ALL BridgeToCantonRequested events
  const currentBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(0, currentBlock - 10000);
  console.log(`\nSearching events from block ${fromBlock} to ${currentBlock}...`);

  const filter = bridge.filters.BridgeToCantonRequested();
  const events = await bridge.queryFilter(filter, fromBlock, currentBlock);
  console.log(`Found ${events.length} BridgeToCantonRequested events\n`);

  for (const evt of events) {
    const e = evt as EventLog;
    console.log(`Event at block ${e.blockNumber}`);
    console.log(`  tx: ${e.transactionHash}`);
    console.log(`  sender: ${e.args.sender}`);
    console.log(`  amount: ${ethers.formatEther(e.args.amount)} mUSD`);
    console.log(`  nonce: ${e.args.nonce.toString()}`);
    console.log(`  cantonRecipient: ${e.args.cantonRecipient}`);
    console.log(`  timestamp: ${new Date(Number(e.args.timestamp) * 1000).toISOString()}`);
    console.log();
  }

  if (events.length === 0) {
    console.log("No bridge-out events found. The bridge TX may not have been submitted,");
    console.log("or it reverted before emitting the event.");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
