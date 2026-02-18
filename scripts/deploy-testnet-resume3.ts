import { ethers } from "hardhat";

/**
 * RESUME: Deploy LeverageVault (step 12) + configure all roles.
 * Steps 0–11 already deployed.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  const startBalance = ethers.formatEther(await ethers.provider.getBalance(deployer.address));
  console.log("Balance:", startBalance, "ETH");

  const SWAP_ROUTER = deployer.address;

  // Already deployed
  const timelockAddress     = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";
  const musdAddress         = "0x76AA12B576b72041b91FDE11e33c4eb2fCfa48FA";
  const oracleAddress       = "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025";
  const vaultAddress        = "0x155d6618dcdeb2F4145395CA57C80e6931D7941e";
  const borrowAddress       = "0x7d840D5e398bb27eeB220DF7253ffeE75477827b";
  const liquidationAddress  = "0x741C5516C9fF4d0b5F80b4D3Ac9c13b72cCAD748";
  const bridgeAddress       = "0x708957bFfA312D1730BdF87467E695D3a9F26b0f";

  // ─── 12. LeverageVault ───
  console.log("\n[12/12] Deploying LeverageVault...");
  const LeverageFactory = await ethers.getContractFactory("LeverageVault");
  const leverage = await LeverageFactory.deploy(
    SWAP_ROUTER,
    vaultAddress,
    borrowAddress,
    oracleAddress,
    musdAddress,
    timelockAddress
  );
  await leverage.waitForDeployment();
  const leverageAddress = await leverage.getAddress();
  console.log("LeverageVault:", leverageAddress);

  // ═══════════════════════════════════════════════════════════════════════
  // ROLE CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n=== Configuring roles ===");

  const musd = await ethers.getContractAt("MUSD", musdAddress);
  const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
  const LIQUIDATOR_ROLE = await musd.LIQUIDATOR_ROLE();
  await (await musd.grantRole(BRIDGE_ROLE, bridgeAddress)).wait();
  console.log("  MUSD: BRIDGE_ROLE -> BLEBridgeV9");
  await (await musd.grantRole(LIQUIDATOR_ROLE, liquidationAddress)).wait();
  console.log("  MUSD: LIQUIDATOR_ROLE -> LiquidationEngine");
  await (await musd.grantRole(BRIDGE_ROLE, borrowAddress)).wait();
  console.log("  MUSD: BRIDGE_ROLE -> BorrowModule");

  const vault = await ethers.getContractAt("CollateralVault", vaultAddress);
  const VAULT_ADMIN_ROLE = await vault.VAULT_ADMIN_ROLE();
  await (await vault.grantRole(VAULT_ADMIN_ROLE, borrowAddress)).wait();
  console.log("  CollateralVault: VAULT_ADMIN_ROLE -> BorrowModule");
  await (await vault.grantRole(VAULT_ADMIN_ROLE, liquidationAddress)).wait();
  console.log("  CollateralVault: VAULT_ADMIN_ROLE -> LiquidationEngine");

  const bridge = await ethers.getContractAt("BLEBridgeV9", bridgeAddress);
  const VALIDATOR_ROLE = await bridge.VALIDATOR_ROLE();
  await (await bridge.grantRole(VALIDATOR_ROLE, deployer.address)).wait();
  console.log("  BLEBridgeV9: VALIDATOR_ROLE -> deployer");

  // BorrowModule: LIQUIDATION_ROLE → LiquidationEngine
  const borrow = await ethers.getContractAt("BorrowModule", borrowAddress);
  const LIQUIDATION_ROLE = await borrow.LIQUIDATION_ROLE();
  await (await borrow.grantRole(LIQUIDATION_ROLE, liquidationAddress)).wait();
  console.log("  BorrowModule: LIQUIDATION_ROLE -> LiquidationEngine");

  // ═══════════════════════════════════════════════════════════════════════
  // TIMELOCK GOVERNANCE WIRING
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n=== Wiring TIMELOCK_ROLE → MintedTimelockController ===");
  const TIMELOCK_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TIMELOCK_ROLE"));
  const timelockContracts = [
    { name: "MUSD",              addr: musdAddress },
    { name: "CollateralVault",   addr: vaultAddress },
    { name: "BorrowModule",      addr: borrowAddress },
    { name: "LiquidationEngine", addr: liquidationAddress },
    { name: "DirectMintV2",      addr: "0x064842e7f14e2Ff497Cc203aB8Dc0D2003d45548" },
    { name: "BLEBridgeV9",       addr: bridgeAddress },
    { name: "LeverageVault",     addr: leverageAddress },
  ];
  for (const { name, addr } of timelockContracts) {
    const c = await ethers.getContractAt("AccessControl", addr);
    const already = await c.hasRole(TIMELOCK_ROLE, timelockAddress);
    if (!already) {
      await (await c.grantRole(TIMELOCK_ROLE, timelockAddress)).wait();
      console.log(`  ${name}: TIMELOCK_ROLE → timelock ✅`);
    } else {
      console.log(`  ${name}: already wired ✅`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  const remaining = ethers.formatEther(await ethers.provider.getBalance(deployer.address));
  console.log("\n========== SEPOLIA DEPLOYMENT COMPLETE ==========");
  console.log("GlobalPauseRegistry:      0x471e9dceB2AB7398b63677C70c6C638c7AEA375F");
  console.log("MintedTimelockController: 0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410");
  console.log("MUSD:                     0x76AA12B576b72041b91FDE11e33c4eb2fCfa48FA");
  console.log("PriceOracle:              0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025");
  console.log("InterestRateModel:        0x501265BeF81E6E96e4150661e2b9278272e9177B");
  console.log("CollateralVault:          0x155d6618dcdeb2F4145395CA57C80e6931D7941e");
  console.log("BorrowModule:            ", borrowAddress);
  console.log("SMUSD:                    0xa789a008212DAe30CBD381D7B0c1dcFC570a2A78");
  console.log("LiquidationEngine:       ", liquidationAddress);
  console.log("DirectMintV2:             0x064842e7f14e2Ff497Cc203aB8Dc0D2003d45548");
  console.log("TreasuryV2 (proxy):       0xf2051bDfc738f638668DF2f8c00d01ba6338C513");
  console.log("BLEBridgeV9 (proxy):     ", bridgeAddress);
  console.log("LeverageVault:           ", leverageAddress);
  console.log("=================================================");
  console.log("Gas used:", (parseFloat(startBalance) - parseFloat(remaining)).toFixed(6), "ETH");
  console.log("Remaining:", remaining, "ETH");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
