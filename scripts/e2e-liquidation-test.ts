/**
 * Task 8 — End-to-End Liquidation Flow Test on Sepolia
 *
 * Flow:
 *   1. Mint MockWETH for borrower
 *   2. Deposit WETH as collateral
 *   3. Borrow mUSD against collateral
 *   4. Deploy MockPriceFeed with crashed WETH price
 *   5. setFeed on PriceOracle to use crashed feed
 *   6. Verify health factor < 1.0
 *   7. Liquidator repays portion of debt, seizes collateral
 *   8. Restore original WETH price feed
 *
 * Usage:
 *   npx hardhat run scripts/e2e-liquidation-test.ts --network sepolia
 */
import { ethers } from "hardhat";

const ADDR = {
  musd:        "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B",
  weth:        "0x7999F2894290F2Ce34a508eeff776126D9a7D46e",
  vault:       "0x155d6618dcdeb2F4145395CA57C80e6931D7941e",
  borrow:      "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8",
  oracle:      "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025",
  liquidation: "0xbaf131Ee1AfdA4207f669DCd9F94634131D111f8",
};

// Original WETH feed (Sepolia Chainlink)
const ORIGINAL_WETH_FEED = "0xc82116f198C582C2570712Cbe514e17dC9E8e01A";

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("═".repeat(70));
  console.log("  E2E LIQUIDATION FLOW TEST — Sepolia Devnet");
  console.log("═".repeat(70));
  console.log(`  Deployer:  ${deployer.address}`);
  console.log(`  Balance:   ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
  console.log();

  const musd       = await ethers.getContractAt("MUSD", ADDR.musd);
  const weth       = await ethers.getContractAt("MockERC20", ADDR.weth);
  const vault      = await ethers.getContractAt("CollateralVault", ADDR.vault);
  const borrow     = await ethers.getContractAt("BorrowModule", ADDR.borrow);
  const oracle     = await ethers.getContractAt("PriceOracle", ADDR.oracle);
  const liqEngine  = await ethers.getContractAt("LiquidationEngine", ADDR.liquidation);

  let passed = 0;
  let failed = 0;
  let crashFeedAddress: string | null = null;

  try {
    // ═════════════════════════════════════════════════════════════════
    // STEP 1: Mint MockWETH for borrower
    // ═════════════════════════════════════════════════════════════════
    console.log("── STEP 1: Mint 10 WETH for borrower ──");
    const wethAmount = ethers.parseUnits("10", 18); // 10 WETH
    const mintTx = await weth.mint(deployer.address, wethAmount);
    await mintTx.wait(2);
    const wethBal = await weth.balanceOf(deployer.address);
    console.log(`  ✅ Minted 10 WETH (total bal: ${ethers.formatUnits(wethBal, 18)})`);
    console.log();

    // ═════════════════════════════════════════════════════════════════
    // STEP 2: Deposit WETH as collateral
    // ═════════════════════════════════════════════════════════════════
    console.log("── STEP 2: Deposit 10 WETH as collateral ──");
    const approveTx = await weth.approve(ADDR.vault, wethAmount);
    await approveTx.wait(2);
    console.log(`  ✅ WETH approved for CollateralVault`);

    const depositTx = await vault.deposit(ADDR.weth, wethAmount);
    await depositTx.wait(2);
    const deposited = await vault.getDeposit(deployer.address, ADDR.weth);
    console.log(`  ✅ Deposited: ${ethers.formatUnits(deposited, 18)} WETH`);

    // Calculate borrow capacity:
    // 10 WETH × $2500 × 75% LTV = $18,750 max borrow
    const wethPrice = await oracle.getPrice(ADDR.weth);
    console.log(`  WETH price: $${ethers.formatUnits(wethPrice, 18)}`);
    console.log(`  Collateral value: $${ethers.formatUnits(wethAmount * wethPrice / ethers.parseUnits("1", 18), 18)}`);
    console.log();

    // ═════════════════════════════════════════════════════════════════
    // STEP 3: Borrow mUSD at 90% of max capacity (aggressive)
    // ═════════════════════════════════════════════════════════════════
    console.log("── STEP 3: Borrow mUSD (90% of capacity) ──");
    // max capacity = 10 × 2500 × 75% = 18750, borrow 90% = 16875
    const borrowAmount = ethers.parseUnits("16875", 18);
    const musdBefore = await musd.balanceOf(deployer.address);

    const borrowTx = await borrow.borrow(borrowAmount);
    await borrowTx.wait(2);

    const musdAfter = await musd.balanceOf(deployer.address);
    const debt = await borrow.totalDebt(deployer.address);
    console.log(`  ✅ Borrowed: ${ethers.formatUnits(borrowAmount, 18)} mUSD`);
    console.log(`  mUSD received: ${ethers.formatUnits(musdAfter - musdBefore, 18)}`);
    console.log(`  Total debt: ${ethers.formatUnits(debt, 18)} mUSD`);

    // Check health factor
    const hfBefore = await borrow.healthFactorUnsafe(deployer.address);
    console.log(`  Health factor: ${Number(hfBefore) / 10000} (${hfBefore} bps)`);
    console.log(`  Position is ${Number(hfBefore) >= 10000 ? "HEALTHY ✅" : "UNHEALTHY ⚠️"}`);
    passed++;
    console.log();

    // ═════════════════════════════════════════════════════════════════
    // STEP 4: Deploy MockPriceFeed with crashed WETH price ($500)
    // ═════════════════════════════════════════════════════════════════
    console.log("── STEP 4: Deploy MockPriceFeed (WETH crash → $500) ──");
    // Deploy a mock Chainlink aggregator that returns $500 for WETH
    const MockFeedFactory = await ethers.getContractFactory("MockPriceFeedCrossStable");
    const crashPrice = 500e8; // $500 in 8 decimal Chainlink format
    const crashFeed = await MockFeedFactory.deploy(crashPrice, 8);
    await crashFeed.waitForDeployment();
    crashFeedAddress = await crashFeed.getAddress();
    console.log(`  ✅ MockPriceFeed deployed: ${crashFeedAddress}`);
    console.log(`  Price: $500 (80% drop from $2500)`);
    console.log();

    // ═════════════════════════════════════════════════════════════════
    // STEP 5: Point PriceOracle to crashed feed
    // ═════════════════════════════════════════════════════════════════
    console.log("── STEP 5: setFeed — WETH → crashed feed ──");
    // setFeed(token, feed, stalePeriod, tokenDecimals, assetMaxDeviationBps)
    // Use large deviationBps (5000 = 50%) to avoid circuit breaker blocking the update
    const setFeedTx = await oracle.setFeed(
      ADDR.weth,
      crashFeedAddress,
      3600,    // 1 hour stale period
      18,      // WETH has 18 decimals
      5000     // 50% max deviation per-asset
    );
    await setFeedTx.wait(2);
    console.log(`  ✅ Oracle feed updated: ${setFeedTx.hash}`);

    // Verify new price
    const newPrice = await oracle.getPrice(ADDR.weth);
    console.log(`  WETH price now: $${ethers.formatUnits(newPrice, 18)}`);
    console.log();

    // ═════════════════════════════════════════════════════════════════
    // STEP 6: Verify position is now undercollateralized
    // ═════════════════════════════════════════════════════════════════
    console.log("── STEP 6: Verify health factor < 1.0 ──");
    const hfAfterCrash = await borrow.healthFactorUnsafe(deployer.address);
    console.log(`  Health factor: ${Number(hfAfterCrash) / 10000} (${hfAfterCrash} bps)`);
    console.log(`  Position is ${Number(hfAfterCrash) >= 10000 ? "HEALTHY ✅ (unexpected!)" : "UNHEALTHY ⚠️ — LIQUIDATABLE"}`);

    if (Number(hfAfterCrash) < 10000) {
      console.log(`  ✅ STEP 6 PASSED — Position correctly marked as liquidatable`);
      passed++;
    } else {
      console.log(`  ❌ STEP 6 FAILED — Position should be unhealthy at $500 WETH`);
      failed++;
    }
    console.log();

    // ═════════════════════════════════════════════════════════════════
    // STEP 7: Liquidate the position
    // ═════════════════════════════════════════════════════════════════
    console.log("── STEP 7: Liquidate position ──");
    // For self-liquidation prevention, we need a second account.
    // Since deployer == borrower, we'll create a secondary signer.
    // On devnet with single deployer, use a fresh funded wallet.

    // Check if borrower can be liquidated by someone else
    // Since we only have one signer, we'll use a workaround:
    // Transfer some mUSD to a fresh wallet, then liquidate from there.

    // Alternatively, check if we have another Hardhat account
    const signers = await ethers.getSigners();
    if (signers.length >= 2) {
      const liquidator = signers[1];
      console.log(`  Liquidator: ${liquidator.address}`);

      // Fund liquidator with mUSD for repaying debt
      const repayAmount = ethers.parseUnits("5000", 18); // Repay 5000 mUSD
      const transferTx = await musd.transfer(liquidator.address, repayAmount);
      await transferTx.wait(2);
      console.log(`  ✅ Transferred ${ethers.formatUnits(repayAmount, 18)} mUSD to liquidator`);

      // Liquidator approves LiquidationEngine
      const liqMusd = musd.connect(liquidator);
      const liqApproveTx = await liqMusd.approve(ADDR.liquidation, repayAmount);
      await liqApproveTx.wait(2);
      console.log(`  ✅ Liquidator approved LiquidationEngine`);

      // Execute liquidation
      const liqEng = liqEngine.connect(liquidator);
      const liqTx = await liqEng.liquidate(deployer.address, ADDR.weth, repayAmount);
      const liqReceipt = await liqTx.wait(2);
      console.log(`  ✅ Liquidation tx: ${liqTx.hash}`);

      // Parse Liquidation event
      const liqEvent = liqReceipt!.logs.find((log: any) => {
        try { return liqEngine.interface.parseLog(log)?.name === "Liquidation"; } catch { return false; }
      });
      if (liqEvent) {
        const parsed = liqEngine.interface.parseLog(liqEvent);
        console.log(`  ✅ Liquidation event:`);
        console.log(`     liquidator: ${parsed!.args[0]}`);
        console.log(`     borrower:   ${parsed!.args[1]}`);
        console.log(`     collateral: ${parsed!.args[2]}`);
        console.log(`     debtRepaid: ${ethers.formatUnits(parsed!.args[3], 18)} mUSD`);
        console.log(`     seized:     ${ethers.formatUnits(parsed!.args[4], 18)} WETH`);
      }

      // Verify post-liquidation state
      const debtAfter = await borrow.totalDebt(deployer.address);
      const depositAfter = await vault.getDeposit(deployer.address, ADDR.weth);
      const liqWethBal = await weth.balanceOf(liquidator.address);
      console.log(`  Post-liquidation debt:     ${ethers.formatUnits(debtAfter, 18)} mUSD`);
      console.log(`  Post-liquidation deposit:  ${ethers.formatUnits(depositAfter, 18)} WETH`);
      console.log(`  Liquidator WETH received:  ${ethers.formatUnits(liqWethBal, 18)} WETH`);

      console.log(`  ✅ STEP 7 PASSED — Liquidation executed successfully`);
      passed++;
    } else {
      // Single-signer workaround: create a temp liquidator wallet
      console.log(`  Only 1 signer available — creating temporary liquidator wallet`);
      const liqWallet = ethers.Wallet.createRandom().connect(ethers.provider);
      console.log(`  Liquidator: ${liqWallet.address}`);

      // Fund with ETH for gas
      const fundEthTx = await deployer.sendTransaction({ to: liqWallet.address, value: ethers.parseEther("0.1") });
      await fundEthTx.wait(2);
      console.log(`  ✅ Funded liquidator with 0.1 ETH`);

      // Transfer mUSD to liquidator
      const repayAmount = ethers.parseUnits("5000", 18);
      const transferTx = await musd.transfer(liqWallet.address, repayAmount);
      await transferTx.wait(2);
      console.log(`  ✅ Transferred ${ethers.formatUnits(repayAmount, 18)} mUSD to liquidator`);

      // Liquidator approves LiquidationEngine
      const liqMusd = musd.connect(liqWallet);
      const liqApproveTx = await liqMusd.approve(ADDR.liquidation, repayAmount);
      await liqApproveTx.wait(2);
      console.log(`  ✅ Liquidator approved LiquidationEngine`);

      // Execute liquidation
      const liqEng = liqEngine.connect(liqWallet);
      const liqTx = await liqEng.liquidate(deployer.address, ADDR.weth, repayAmount);
      const liqReceipt = await liqTx.wait(2);
      console.log(`  ✅ Liquidation tx: ${liqTx.hash}`);

      // Parse Liquidation event
      const liqEvent = liqReceipt!.logs.find((log: any) => {
        try { return liqEngine.interface.parseLog(log)?.name === "Liquidation"; } catch { return false; }
      });
      if (liqEvent) {
        const parsed = liqEngine.interface.parseLog(liqEvent);
        console.log(`  ✅ Liquidation event:`);
        console.log(`     liquidator: ${parsed!.args[0]}`);
        console.log(`     borrower:   ${parsed!.args[1]}`);
        console.log(`     collateral: ${parsed!.args[2]}`);
        console.log(`     debtRepaid: ${ethers.formatUnits(parsed!.args[3], 18)} mUSD`);
        console.log(`     seized:     ${ethers.formatUnits(parsed!.args[4], 18)} WETH`);
      }

      // Verify post-liquidation state
      const debtAfter = await borrow.totalDebt(deployer.address);
      const depositAfter = await vault.getDeposit(deployer.address, ADDR.weth);
      const liqWethBal = await weth.balanceOf(liqWallet.address);
      console.log(`  Post-liquidation debt:     ${ethers.formatUnits(debtAfter, 18)} mUSD`);
      console.log(`  Post-liquidation deposit:  ${ethers.formatUnits(depositAfter, 18)} WETH`);
      console.log(`  Liquidator WETH received:  ${ethers.formatUnits(liqWethBal, 18)} WETH`);

      console.log(`  ✅ STEP 7 PASSED — Liquidation executed successfully`);
      passed++;
    }
    console.log();

  } catch (e: any) {
    console.log(`  ❌ FAILED: ${e.message?.slice(0, 300)}`);
    failed++;
  } finally {
    // ═════════════════════════════════════════════════════════════════
    // STEP 8: Restore original WETH price feed
    // ═════════════════════════════════════════════════════════════════
    console.log("── STEP 8: Restore original WETH price feed ──");
    try {
      const restoreTx = await oracle.setFeed(
        ADDR.weth,
        ORIGINAL_WETH_FEED,
        3600,    // same stale period
        18,      // WETH decimals
        5000     // max deviation
      );
      await restoreTx.wait(2);
      const restoredPrice = await oracle.getPrice(ADDR.weth);
      console.log(`  ✅ Feed restored. WETH price: $${ethers.formatUnits(restoredPrice, 18)}`);
    } catch (e: any) {
      console.log(`  ⚠️  Failed to restore feed: ${e.message?.slice(0, 120)}`);
      console.log(`  ⚠️  MANUAL RESTORE NEEDED: setFeed(WETH, ${ORIGINAL_WETH_FEED}, 3600, 18, 5000)`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═════════════════════════════════════════════════════════════════════
  console.log();
  console.log("═".repeat(70));
  console.log(`  LIQUIDATION TEST COMPLETE — ${passed} passed, ${failed} failed`);
  console.log("═".repeat(70));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
