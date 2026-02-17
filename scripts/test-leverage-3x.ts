// Fix MockSwapRouter BRIDGE_ROLE + test 3x leverage open/close
// The swap router needs BRIDGE_ROLE to mint mUSD during WETH→mUSD swaps

import { ethers } from "hardhat";

const CONTRACTS = {
  MUSD: "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B",
  MockUSDC: "0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474",
  MockWETH: "0x7999F2894290F2Ce34a508eeff776126D9a7D46e",
  PriceOracle: "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025",
  CollateralVault: "0x155d6618dcdeb2F4145395CA57C80e6931D7941e",
  BorrowModule: "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8",
  LeverageVault: "0x3b49d47f9714836F2aF21F13cdF79aafd75f1FE4",
  MockSwapRouter: "0x510379a06bBb260E0442BCE7e519Fbf7Dd4ba77e",
  DirectMint: "0xaA3e42f2AfB5DF83d6a33746c2927bce8B22Bae7",
  ETH_USD_Feed: "0xc82116f198C582C2570712Cbe514e17dC9E8e01A",
};

const GAS = { gasLimit: 500_000 };
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("═".repeat(60));
  console.log("3x Leveraged Position — Open → Close → Verify");
  console.log("═".repeat(60));
  console.log(`Tester: ${signer.address}\n`);

  const musd = await ethers.getContractAt("MUSD", CONTRACTS.MUSD);
  const mockWETH = await ethers.getContractAt("MockERC20", CONTRACTS.MockWETH);
  const leverageVault = await ethers.getContractAt("LeverageVault", CONTRACTS.LeverageVault);
  const borrowModule = await ethers.getContractAt("BorrowModule", CONTRACTS.BorrowModule);
  const priceOracle = await ethers.getContractAt("PriceOracle", CONTRACTS.PriceOracle);

  // ═══════════════════════════════════════════════════════════
  // Step 0: Fix BRIDGE_ROLE for MockSwapRouter
  // ═══════════════════════════════════════════════════════════
  const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ROLE"));
  const hasBridgeRole = await musd.hasRole(BRIDGE_ROLE, CONTRACTS.MockSwapRouter);
  
  if (!hasBridgeRole) {
    console.log("0️⃣  Granting BRIDGE_ROLE to MockSwapRouter...");
    const tx = await musd.grantRole(BRIDGE_ROLE, CONTRACTS.MockSwapRouter, GAS);
    await tx.wait();
    console.log("   ✅ BRIDGE_ROLE granted\n");
    await wait(5000);
  } else {
    console.log("0️⃣  MockSwapRouter already has BRIDGE_ROLE ✅\n");
  }

  // ═══════════════════════════════════════════════════════════
  // Step 0b: Refresh stale price feed
  // ═══════════════════════════════════════════════════════════
  console.log("0️⃣b Refreshing ETH/USD mock price feed...");
  const mockFeed = await ethers.getContractAt("MockAggregatorV3", CONTRACTS.ETH_USD_Feed);
  const refreshTx = await mockFeed.setAnswer(2500n * 10n ** 8n, GAS); // $2500/ETH
  await refreshTx.wait();
  console.log("   ✅ Feed refreshed to $2,500 (timestamp = now)\n");
  await wait(3000);

  // ═══════════════════════════════════════════════════════════
  // Step 1: Close any existing position
  // ═══════════════════════════════════════════════════════════
  const existingPos = await leverageVault.getPosition(signer.address);
  if (existingPos.totalCollateral > 0n) {
    console.log("1️⃣  Closing existing position first...");
    const debt = await borrowModule.totalDebt(signer.address);
    if (debt > 0n) {
      const debtBuf = debt * 110n / 100n;
      // Ensure enough mUSD
      const musdBal = await musd.balanceOf(signer.address);
      if (musdBal < debtBuf) {
        const directMint = await ethers.getContractAt("DirectMintV2", CONTRACTS.DirectMint);
        const mockUSDC = await ethers.getContractAt("MockERC20", CONTRACTS.MockUSDC);
        const usdcNeeded = (debtBuf * 102n / 99n / 10n ** 12n) + 10_000_000n;
        await (await mockUSDC.mint(signer.address, usdcNeeded, GAS)).wait();
        await wait(5000);
        await (await mockUSDC.approve(CONTRACTS.DirectMint, usdcNeeded, GAS)).wait();
        await wait(5000);
        await (await directMint.mint(usdcNeeded, { gasLimit: 500_000 })).wait();
        await wait(5000);
      }
      await (await musd.approve(CONTRACTS.LeverageVault, ethers.MaxUint256, GAS)).wait();
      await wait(5000);
      await (await leverageVault.closeLeveragedPositionWithMusd(debtBuf, 0, { gasLimit: 1_000_000 })).wait();
    } else {
      await (await leverageVault.closeLeveragedPositionWithMusd(0, 0, { gasLimit: 1_000_000 })).wait();
    }
    console.log("   ✅ Existing position closed\n");
    await wait(5000);
  }

  // ═══════════════════════════════════════════════════════════
  // Step 2: Mint and approve WETH
  // ═══════════════════════════════════════════════════════════
  console.log("1️⃣  Preparing collateral...");
  const depositAmount = ethers.parseEther("5"); // 5 WETH
  await (await mockWETH.mint(signer.address, depositAmount, GAS)).wait();
  await wait(3000);
  await (await mockWETH.approve(CONTRACTS.LeverageVault, depositAmount, GAS)).wait();
  await wait(3000);

  const wethBalBefore = await mockWETH.balanceOf(signer.address);
  const musdBalBefore = await musd.balanceOf(signer.address);
  console.log(`   WETH balance: ${ethers.formatEther(wethBalBefore)}`);
  console.log(`   mUSD balance: ${ethers.formatUnits(musdBalBefore, 18)}`);

  // ═══════════════════════════════════════════════════════════
  // Step 3: Open 3x leveraged position
  // ═══════════════════════════════════════════════════════════
  console.log("\n2️⃣  Opening 3x leveraged position...");
  console.log(`   Deposit: ${ethers.formatEther(depositAmount)} WETH`);
  console.log(`   Target: 3.0x leverage | Max loops: 10`);

  const openTx = await leverageVault.openLeveragedPosition(
    CONTRACTS.MockWETH,
    depositAmount,
    30,   // 3.0x leverage
    10,   // max loops
    0,    // no deadline
    { gasLimit: 2_000_000 }
  );
  const openReceipt = await openTx.wait();
  console.log(`   ✅ Position opened! Gas: ${openReceipt?.gasUsed}`);
  console.log(`   Tx: https://sepolia.etherscan.io/tx/${openReceipt?.hash}`);
  await wait(5000);

  // ═══════════════════════════════════════════════════════════
  // Step 4: Verify position details
  // ═══════════════════════════════════════════════════════════
  console.log("\n3️⃣  Position Details:");
  const position = await leverageVault.getPosition(signer.address);
  const debt = await borrowModule.totalDebt(signer.address);
  const effectiveLev = await leverageVault.getEffectiveLeverage(signer.address);
  const collateralValue = await priceOracle.getValueUsd(CONTRACTS.MockWETH, position.totalCollateral);

  console.log(`   Initial Deposit:   ${ethers.formatEther(position.initialDeposit)} WETH`);
  console.log(`   Total Collateral:  ${ethers.formatEther(position.totalCollateral)} WETH`);
  console.log(`   Total Debt:        ${ethers.formatUnits(debt, 18)} mUSD`);
  console.log(`   Loops Executed:    ${position.loopsExecuted}`);
  console.log(`   Effective Leverage: ${Number(effectiveLev) / 10}x`);
  console.log(`   Collateral Value:  $${ethers.formatUnits(collateralValue, 18)}`);
  
  // Assertions
  const levX10 = Number(effectiveLev);
  if (levX10 < 15) {
    console.log(`   ⚠️ Leverage too low: ${levX10 / 10}x (expected ≥ 1.5x)`);
  }
  if (position.totalCollateral <= position.initialDeposit) {
    console.log(`   ❌ FAIL: Total collateral should exceed initial deposit`);
    return;
  }
  if (debt <= 0n) {
    console.log(`   ❌ FAIL: Should have debt after leveraging`);
    return;
  }
  console.log(`   ✅ Position looks correct!`);

  // ═══════════════════════════════════════════════════════════
  // Step 5: Close position with mUSD
  // ═══════════════════════════════════════════════════════════
  console.log("\n4️⃣  Closing leveraged position...");
  
  const debtToRepay = await leverageVault.getMusdNeededToClose(signer.address);
  console.log(`   Debt to repay: ${ethers.formatUnits(debtToRepay, 18)} mUSD`);
  
  const debtWithBuffer = debtToRepay * 110n / 100n; // 10% buffer
  
  // Ensure we have enough mUSD
  const currentMusd = await musd.balanceOf(signer.address);
  if (currentMusd < debtWithBuffer) {
    console.log("   📝 Minting additional mUSD via DirectMintV2...");
    const directMint = await ethers.getContractAt("DirectMintV2", CONTRACTS.DirectMint);
    const mockUSDC = await ethers.getContractAt("MockERC20", CONTRACTS.MockUSDC);
    const shortfall = debtWithBuffer - currentMusd;
    const usdcNeeded = (shortfall * 102n / 99n / 10n ** 12n) + 50_000_000n; // +50 USDC buffer
    console.log(`   Minting ${ethers.formatUnits(usdcNeeded, 6)} USDC → mUSD...`);
    await (await mockUSDC.mint(signer.address, usdcNeeded, GAS)).wait();
    await wait(5000);
    await (await mockUSDC.approve(CONTRACTS.DirectMint, usdcNeeded, GAS)).wait();
    await wait(5000);
    await (await directMint.mint(usdcNeeded, { gasLimit: 500_000 })).wait();
    await wait(5000);
    const newMusd = await musd.balanceOf(signer.address);
    console.log(`   mUSD balance after mint: ${ethers.formatUnits(newMusd, 18)}`);
  }

  // Approve and close
  await (await musd.approve(CONTRACTS.LeverageVault, ethers.MaxUint256, GAS)).wait();
  await wait(3000);

  const wethBefore = await mockWETH.balanceOf(signer.address);
  
  console.log(`   Providing ${ethers.formatUnits(debtWithBuffer, 18)} mUSD to close...`);
  const closeTx = await leverageVault.closeLeveragedPositionWithMusd(debtWithBuffer, 0, { gasLimit: 1_500_000 });
  const closeReceipt = await closeTx.wait();
  console.log(`   ✅ Position closed! Gas: ${closeReceipt?.gasUsed}`);
  console.log(`   Tx: https://sepolia.etherscan.io/tx/${closeReceipt?.hash}`);
  await wait(5000);

  // ═══════════════════════════════════════════════════════════
  // Step 6: Verify debt repayment + collateral return
  // ═══════════════════════════════════════════════════════════
  console.log("\n5️⃣  Verification:");
  
  const posAfter = await leverageVault.getPosition(signer.address);
  const debtAfter = await borrowModule.totalDebt(signer.address);
  const wethAfter = await mockWETH.balanceOf(signer.address);
  const wethReturned = wethAfter - wethBefore;
  const musdAfter = await musd.balanceOf(signer.address);

  console.log(`   Position cleared:    ${posAfter.totalCollateral === 0n ? '✅ YES' : '❌ NO'}`);
  console.log(`   Debt repaid:         ${debtAfter === 0n ? '✅ YES (0 mUSD)' : '❌ NO (' + ethers.formatUnits(debtAfter, 18) + ' mUSD remaining)'}`);
  console.log(`   WETH returned:       ${ethers.formatEther(wethReturned)} WETH`);
  console.log(`   mUSD balance:        ${ethers.formatUnits(musdAfter, 18)} mUSD`);

  // Final verdict
  console.log("\n" + "═".repeat(60));
  if (posAfter.totalCollateral === 0n && debtAfter === 0n && wethReturned > 0n) {
    console.log("✅ 3x LEVERAGE TEST PASSED");
    console.log("   Position opened → verified → closed → debt fully repaid");
    console.log("   Collateral returned to user");
  } else {
    console.log("❌ 3x LEVERAGE TEST FAILED");
    if (posAfter.totalCollateral > 0n) console.log("   Position not cleared");
    if (debtAfter > 0n) console.log("   Debt not fully repaid");
    if (wethReturned <= 0n) console.log("   No WETH returned");
  }
  console.log("═".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
