import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const feedAddr = "0xc82116f198C582C2570712Cbe514e17dC9E8e01A";
  const oracleAddr = "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025";
  const weth = "0x7999F2894290F2Ce34a508eeff776126D9a7D46e";
  const borrowModule = "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8";
  const target = "0x33f97321214B5B8443f6212a05836C8FfE42DDa5";

  // 1. Check feed staleness
  const feed = new ethers.Contract(feedAddr, [
    "function setAnswer(int256) external",
    "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  ], deployer);

  const [, answer, , updatedAt] = await feed.latestRoundData();
  const now = Math.floor(Date.now() / 1000);
  const age = now - Number(updatedAt);
  console.log("Feed price:", ethers.formatUnits(answer, 8), "USD");
  console.log("Feed age:", (age / 3600).toFixed(1), "hours");

  // 2. Refresh if stale
  if (age > 82800) { // > 23 hours
    console.log("Feed is stale, refreshing...");
    const tx = await feed.setAnswer(250000000000n); // $2500
    await tx.wait();
    console.log("Feed refreshed!");
  }

  // 3. Test oracle getPrice
  const oracle = await ethers.getContractAt("PriceOracle", oracleAddr);
  try {
    const price = await oracle.getPrice(weth);
    console.log("Oracle getPrice(WETH):", ethers.formatUnits(price, 18), "USD");
  } catch (e: any) {
    console.log("Oracle getPrice FAILED:", e.message?.slice(0, 200));
  }

  // 4. Check BorrowModule state
  const borrow = await ethers.getContractAt("BorrowModule", borrowModule);
  try {
    const debt = await borrow.totalDebt(target);
    console.log("Target debt:", ethers.formatUnits(debt, 18));
  } catch (e: any) {
    console.log("BorrowModule.totalDebt() failed:", e.message?.slice(0, 200));
  }

  // 5. Try to simulate a borrow
  try {
    const borrowable = await borrow.maxBorrow(target);
    console.log("Max borrowable:", ethers.formatUnits(borrowable, 18), "mUSD");
  } catch (e: any) {
    console.log("maxBorrowable failed:", e.message?.slice(0, 200));
  }

  // 6. Check mUSD supply vs cap
  const musd = await ethers.getContractAt("MUSD", "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B");
  const totalSupply = await musd.totalSupply();
  const cap = await musd.supplyCap();
  const localBps = await musd.localCapBps();
  const effectiveCap = (cap * localBps) / 10000n;
  console.log("mUSD totalSupply:", ethers.formatUnits(totalSupply, 18));
  console.log("mUSD supplyCap:", ethers.formatUnits(cap, 18));
  console.log("mUSD effectiveCap (", localBps.toString(), "bps):", ethers.formatUnits(effectiveCap, 18));
  console.log("Remaining mintable:", ethers.formatUnits(effectiveCap - totalSupply, 18));

  // 7. Check if BorrowModule has BRIDGE_ROLE on MUSD
  const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ROLE"));
  const hasBridgeRole = await musd.hasRole(BRIDGE_ROLE, borrowModule);
  console.log("BorrowModule has BRIDGE_ROLE on MUSD:", hasBridgeRole);
}

main().catch(console.error);
