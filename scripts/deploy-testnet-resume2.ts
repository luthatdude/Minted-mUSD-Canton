import { ethers, upgrades } from "hardhat";

/**
 * RESUME deployment from step 11 (BLEBridgeV9 proxy).
 * Steps 0–10 were deployed. Addresses hardcoded below.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  const startBalance = ethers.formatEther(await ethers.provider.getBalance(deployer.address));
  console.log("Balance:", startBalance, "ETH");

  const SWAP_ROUTER = deployer.address;

  // ═══════════════════════════════════════════════════════════════════════
  // ALREADY DEPLOYED (steps 0–10)
  // ═══════════════════════════════════════════════════════════════════════
  const gprAddress          = "0x471e9dceB2AB7398b63677C70c6C638c7AEA375F";
  const timelockAddress     = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";
  const musdAddress         = "0x76AA12B576b72041b91FDE11e33c4eb2fCfa48FA";
  const oracleAddress       = "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025";
  const irmAddress          = "0x501265BeF81E6E96e4150661e2b9278272e9177B";
  const vaultAddress        = "0x155d6618dcdeb2F4145395CA57C80e6931D7941e";
  const borrowAddress       = "0x7d840D5e398bb27eeB220DF7253ffeE75477827b";
  const smusdAddress        = "0xa789a008212DAe30CBD381D7B0c1dcFC570a2A78";
  const liquidationAddress  = "0x741C5516C9fF4d0b5F80b4D3Ac9c13b72cCAD748";
  const directMintAddress   = "0x064842e7f14e2Ff497Cc203aB8Dc0D2003d45548";
  const treasuryAddress     = "0xf2051bDfc738f638668DF2f8c00d01ba6338C513";

  console.log("=== Resuming from step 11 (BLEBridgeV9) ===");

  // ─────────────────────────────────────────────────────────────────────
  // 11. BLEBridgeV9 (UUPS proxy)
  //     Contract enforces minSigs >= 2 in initialize(), so we use 2
  // ─────────────────────────────────────────────────────────────────────
  console.log("\n[11/12] Deploying BLEBridgeV9 (UUPS proxy)...");
  const BridgeImpl = await ethers.getContractFactory("BLEBridgeV9");
  const MIN_SIGS = 2; // contract enforces >= 2
  const COLLATERAL_RATIO_BPS = 10000; // 100 %
  const DAILY_CAP_INCREASE = ethers.parseEther("1000000"); // 1 M

  const bridgeProxy = await upgrades.deployProxy(BridgeImpl, [
    MIN_SIGS, musdAddress, COLLATERAL_RATIO_BPS, DAILY_CAP_INCREASE, timelockAddress,
  ], { kind: "uups" });
  await bridgeProxy.waitForDeployment();
  const bridgeAddress = await bridgeProxy.getAddress();
  console.log("BLEBridgeV9 proxy:", bridgeAddress);

  // ─────────────────────────────────────────────────────────────────────
  // 12. LeverageVault
  // ─────────────────────────────────────────────────────────────────────
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
  await (await musd.grantRole(LIQUIDATOR_ROLE, liquidationAddress)).wait();
  await (await musd.grantRole(BRIDGE_ROLE, borrowAddress)).wait();
  console.log("MUSD roles configured");

  const vault = await ethers.getContractAt("CollateralVault", vaultAddress);
  const VAULT_ADMIN_ROLE = await vault.VAULT_ADMIN_ROLE();
  await (await vault.grantRole(VAULT_ADMIN_ROLE, borrowAddress)).wait();
  await (await vault.grantRole(VAULT_ADMIN_ROLE, liquidationAddress)).wait();
  console.log("CollateralVault roles configured");

  // Register deployer as validator on BLEBridgeV9 for testnet
  const bridge = await ethers.getContractAt("BLEBridgeV9", bridgeAddress);
  const VALIDATOR_ROLE = await bridge.VALIDATOR_ROLE();
  await (await bridge.grantRole(VALIDATOR_ROLE, deployer.address)).wait();
  console.log("BLEBridgeV9: deployer registered as validator");

  // BorrowModule: LIQUIDATION_ROLE → LiquidationEngine
  const borrow = await ethers.getContractAt("BorrowModule", borrowAddress);
  const LIQUIDATION_ROLE = await borrow.LIQUIDATION_ROLE();
  await (await borrow.grantRole(LIQUIDATION_ROLE, liquidationAddress)).wait();
  console.log("BorrowModule: LIQUIDATION_ROLE -> LiquidationEngine");

  // ═══════════════════════════════════════════════════════════════════════
  // TIMELOCK GOVERNANCE WIRING
  // Grant TIMELOCK_ROLE to MintedTimelockController on all contracts that
  // use onlyRole(TIMELOCK_ROLE) for admin functions (unpause, setters, etc).
  // Without this, the timelock cannot call governance functions.
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n=== Wiring TIMELOCK_ROLE → MintedTimelockController ===");
  const TIMELOCK_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TIMELOCK_ROLE"));
  const timelockContracts = [
    { name: "MUSD",              addr: musdAddress },
    { name: "SMUSD",             addr: smusdAddress },
    { name: "PriceOracle",       addr: oracleAddress },
    { name: "InterestRateModel", addr: irmAddress },
    { name: "CollateralVault",   addr: vaultAddress },
    { name: "BorrowModule",      addr: borrowAddress },
    { name: "LiquidationEngine", addr: liquidationAddress },
    { name: "DirectMintV2",      addr: directMintAddress },
    { name: "TreasuryV2",        addr: treasuryAddress },
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
      console.log(`  ${name}: already has TIMELOCK_ROLE ✅`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  const remaining = ethers.formatEther(await ethers.provider.getBalance(deployer.address));
  console.log("\n========== SEPOLIA DEPLOYMENT COMPLETE ==========");
  console.log("GlobalPauseRegistry:", gprAddress);
  console.log("MintedTimelockController:", timelockAddress);
  console.log("MUSD:", musdAddress);
  console.log("PriceOracle:", oracleAddress);
  console.log("InterestRateModel:", irmAddress);
  console.log("CollateralVault:", vaultAddress);
  console.log("BorrowModule:", borrowAddress);
  console.log("SMUSD:", smusdAddress);
  console.log("LiquidationEngine:", liquidationAddress);
  console.log("DirectMintV2:", directMintAddress);
  console.log("TreasuryV2 (proxy):", treasuryAddress);
  console.log("BLEBridgeV9 (proxy):", bridgeAddress);
  console.log("LeverageVault:", leverageAddress);
  console.log("=================================================");
  console.log("Gas used:", (parseFloat(startBalance) - parseFloat(remaining)).toFixed(6), "ETH");
  console.log("Remaining:", remaining, "ETH");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
