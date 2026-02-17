import { ethers } from "hardhat";
async function main() {
  const [deployer] = await ethers.getSigners();
  const ADDR = {
    treasury: "0xf2051bDfc738f638668DF2f8c00d01ba6338C513",
    pendleStrategy: "0x38726CC401b732Cf3c5AF8CC0Dc4E7c10204c6C6",
    eulerV2Loop: "0x3A97c235d5A7Af715934f633a2A2d4B27D8E951c",
    eulerV2CrossStable: "0x7e8eD8102Ae1022072a8a5f798E5302737Ee5967",
  };

  const treasury = await ethers.getContractAt("TreasuryV2", ADDR.treasury);

  console.log("=== Register Remaining Strategies ===\n");

  // Check current count
  const count = await treasury.strategyCount();
  console.log("Current strategy count:", Number(count));

  // Register PendleStrategyV2 — 1000 bps target, 500 min, 1500 max
  console.log("\n1. Registering PendleStrategyV2 (1000 bps)...");
  try {
    const tx1 = await treasury.addStrategy(ADDR.pendleStrategy, 1000, 500, 1500, false);
    await tx1.wait();
    console.log("   ✅ PendleStrategyV2 registered! tx:", tx1.hash);
  } catch(e: any) {
    console.log("   ❌ Failed:", e.message?.slice(0, 200));
  }

  // Register EulerV2LoopStrategy — 500 bps target, 200 min, 800 max
  console.log("\n2. Registering EulerV2LoopStrategy (500 bps)...");
  try {
    const tx2 = await treasury.addStrategy(ADDR.eulerV2Loop, 500, 200, 800, false);
    await tx2.wait();
    console.log("   ✅ EulerV2LoopStrategy registered! tx:", tx2.hash);
  } catch(e: any) {
    console.log("   ❌ Failed:", e.message?.slice(0, 200));
  }

  // Register EulerV2CrossStableLoopStrategy — 500 bps target, 200 min, 800 max
  console.log("\n3. Registering EulerV2CrossStableLoopStrategy (500 bps)...");
  try {
    const tx3 = await treasury.addStrategy(ADDR.eulerV2CrossStable, 500, 200, 800, false);
    await tx3.wait();
    console.log("   ✅ EulerV2CrossStableLoopStrategy registered! tx:", tx3.hash);
  } catch(e: any) {
    console.log("   ❌ Failed:", e.message?.slice(0, 200));
  }

  // Final summary
  const newCount = await treasury.strategyCount();
  console.log("\n=== Strategy count:", Number(newCount), "/ max 10 ===");
  console.log("Total allocation: 7000 + 1000 + 500 + 500 = 9000 bps (10% reserve)");
  console.log("\nDone ✅");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
