import { ethers } from "hardhat";
async function main() {
  const [deployer] = await ethers.getSigners();
  const ADDR = {
    musd: "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B",
    vault: "0x155d6618dcdeb2F4145395CA57C80e6931D7941e",
    borrow: "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8",
    oracle: "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025",
    liquidation: "0xbaf131Ee1AfdA4207f669DCd9F94634131D111f8",
    weth: "0x7999F2894290F2Ce34a508eeff776126D9a7D46e",
    originalWethFeed: "0xc82116f198C582C2570712Cbe514e17dC9E8e01A",
    crashFeed: "0x111b98802656141F812fDE35D9FF3f6166d60617",
  };

  const borrow = await ethers.getContractAt("BorrowModule", ADDR.borrow);
  const oracle = await ethers.getContractAt("PriceOracle", ADDR.oracle);
  const musd = await ethers.getContractAt("MUSD", ADDR.musd);
  const liq = await ethers.getContractAt("LiquidationEngine", ADDR.liquidation);

  console.log("=== LIQUIDATION RETRY ===\n");

  // Current state
  const debt = await borrow.totalDebt(deployer.address);
  console.log("Deployer debt:", ethers.formatUnits(debt, 18), "mUSD");
  const hf0 = await borrow.healthFactorUnsafe(deployer.address);
  console.log("Current HF:", Number(hf0) / 10000);

  // 1. Crash the oracle to $500
  console.log("\n[1] Crashing WETH oracle to $500...");
  // setFeed(token, feed, stalePeriod, tokenDecimals, assetMaxDeviationBps)
  // Use 5000 bps (50%) max deviation so the large price change doesn't trip circuit breaker
  const setFeedTx = await oracle.setFeed(ADDR.weth, ADDR.crashFeed, 86400, 18, 5000);
  await setFeedTx.wait();
  
  // Also call updatePrice to ensure the circuit breaker doesn't block getPrice()
  try {
    const updateTx = await oracle.updatePrice(ADDR.weth);
    await updateTx.wait();
    console.log("  updatePrice() succeeded — circuit breaker cleared");
  } catch(e: any) {
    console.log("  updatePrice() failed:", e.message?.slice(0, 120));
    // Try to see if we can still get the price
    try {
      const p = await oracle.getPrice(ADDR.weth);
      console.log("  getPrice() works:", ethers.formatUnits(p, 18));
    } catch(e2: any) {
      console.log("  getPrice() also fails:", e2.message?.slice(0, 120));
      console.log("  Trying to bypass circuit breaker by setting deviation...");
      try {
        // Try setMaxDeviation if available
        const setDevTx = await oracle.setMaxDeviation(ADDR.weth, 9500); // 95%
        await setDevTx.wait();
        console.log("  setMaxDeviation(95%) succeeded");
        const updateTx2 = await oracle.updatePrice(ADDR.weth);
        await updateTx2.wait();
        console.log("  updatePrice() now succeeded");
      } catch(e3: any) {
        console.log("  setMaxDeviation failed:", e3.message?.slice(0, 120));
      }
    }
  }

  const wethPrice = await oracle.getPriceUnsafe(ADDR.weth);
  console.log("  WETH price:", ethers.formatUnits(wethPrice, 18));

  // 2. Verify position is liquidatable
  const hf1 = await borrow.healthFactorUnsafe(deployer.address);
  console.log("\n[2] Health factor after crash:", Number(hf1) / 10000, hf1 < 10000n ? "✅ LIQUIDATABLE" : "❌ HEALTHY");

  // 3. Create liquidator wallet (deployer can't self-liquidate)
  console.log("\n[3] Preparing liquidator wallet...");
  const liquidator = ethers.Wallet.createRandom().connect(ethers.provider);
  console.log("  Liquidator:", liquidator.address);

  // Fund liquidator with ETH for gas
  const fundEthTx = await deployer.sendTransaction({ to: liquidator.address, value: ethers.parseEther("0.15") });
  await fundEthTx.wait();
  console.log("  Funded 0.15 ETH for gas ✅");

  // Transfer mUSD to liquidator
  const repayAmount = ethers.parseUnits("1000", 18);
  const transferTx = await musd.transfer(liquidator.address, repayAmount);
  await transferTx.wait();
  console.log("  Transferred", ethers.formatUnits(repayAmount, 18), "mUSD ✅");

  // Approve LiquidationEngine from liquidator
  const musdAsLiq = musd.connect(liquidator);
  const approveTx = await musdAsLiq.approve(ADDR.liquidation, repayAmount);
  await approveTx.wait();
  console.log("  Approved LiquidationEngine ✅");

  const closeFactorBps = await liq.closeFactorBps();
  const maxRepay = (debt * closeFactorBps) / 10000n;
  console.log("  Close factor:", Number(closeFactorBps), "bps");
  console.log("  Max repayable:", ethers.formatUnits(maxRepay, 18), "mUSD");
  console.log("  Attempting repay:", ethers.formatUnits(repayAmount, 18), "mUSD");

  // 4. Execute liquidation
  console.log("\n[4] Executing liquidation...");
  const liqAsLiq = liq.connect(liquidator);
  try {
    // First simulate
    await liqAsLiq.liquidate.staticCall(deployer.address, ADDR.weth, repayAmount);
    console.log("  staticCall succeeded ✅");
  } catch(e: any) {
    console.log("  staticCall failed:", e.message?.slice(0, 400));
    if (e.data) console.log("  Error data:", e.data);

    console.log("\n  Restoring oracle and exiting...");
    const restoreTx = await oracle.setFeed(ADDR.weth, ADDR.originalWethFeed, 86400, 18, 0);
    await restoreTx.wait();
    console.log("  Oracle restored ✅");
    return;
  }

  try {
    const tx = await liqAsLiq.liquidate(deployer.address, ADDR.weth, repayAmount, { gasLimit: 1_000_000 });
    const receipt = await tx.wait();
    console.log("  ✅ LIQUIDATION SUCCEEDED! tx:", tx.hash);
    console.log("  Gas used:", receipt?.gasUsed.toString());

    // Check new state
    const debtAfter = await borrow.totalDebt(deployer.address);
    console.log("  Debt after:", ethers.formatUnits(debtAfter, 18), "mUSD");
    console.log("  Debt reduced by:", ethers.formatUnits(debt - debtAfter, 18), "mUSD");

    const vault = await ethers.getContractAt("CollateralVault", ADDR.vault);
    const wethAfter = await vault.getDeposit(deployer.address, ADDR.weth);
    console.log("  Collateral after:", ethers.formatUnits(wethAfter, 18), "WETH");

    // Check liquidator received collateral
    const MockWETH = await ethers.getContractAt("MockERC20", ADDR.weth);
    const liqWeth = await MockWETH.balanceOf(liquidator.address);
    console.log("  Liquidator received:", ethers.formatUnits(liqWeth, 18), "WETH");
  } catch(e: any) {
    console.log("  ❌ Liquidation TX failed:", e.message?.slice(0, 400));
  }

  // 6. Restore oracle
  console.log("\n[6] Restoring oracle...");
  const restoreTx2 = await oracle.setFeed(ADDR.weth, ADDR.originalWethFeed, 86400, 18, 0);
  await restoreTx2.wait();
  const restoredPrice = await oracle.getPriceUnsafe(ADDR.weth);
  console.log("  WETH price restored:", ethers.formatUnits(restoredPrice, 18));

  console.log("\n=== DONE ===");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
