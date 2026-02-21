/**
 * Deploy a fresh BLEBridgeV9 proxy with the CORRECT MUSD address,
 * set up roles, and run the e2e bridge test.
 *
 * Root cause: The original bridge at 0xB466... was initialized with an
 * old MUSD proxy (0x76AA...) that has 0 supply. The current MUSD proxy
 * is at 0xEAf4... with 115K+ supply. Since there's no setMusdToken
 * function, we deploy a fresh bridge.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-fresh-bridge.ts --network sepolia
 */
import { ethers, upgrades } from "hardhat";

const ADDR = {
  musd:       "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B",   // correct MUSD proxy
  usdc:       "0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474",
  directMint: "0xaA3e42f2AfB5DF83d6a33746c2927bce8B22Bae7",
  treasury:   "0xf2051bDfc738f638668DF2f8c00d01ba6338C513",
  timelock:   "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410",
};

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("═".repeat(70));
  console.log("  DEPLOY FRESH BLEBridgeV9 (correct MUSD)");
  console.log("═".repeat(70));
  console.log(`  Deployer: ${deployer.address}`);
  console.log(`  Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
  console.log();

  // ── Step 1: Deploy BLEBridgeV9 proxy ──
  console.log("── Step 1: Deploy BLEBridgeV9 proxy ──");
  const BLEBridgeV9 = await ethers.getContractFactory("BLEBridgeV9");
  const bridge = await upgrades.deployProxy(BLEBridgeV9, [
    2,                          // minSignatures = 2
    ADDR.musd,                  // correct MUSD token
    15000,                      // collateralRatioBps = 150%
    ethers.parseUnits("1000000", 18), // dailyCapIncreaseLimit = 1M
    ADDR.timelock,              // timelockController
  ], {
    kind: "uups",
    unsafeAllow: ["constructor"],
  });
  await bridge.waitForDeployment();
  const bridgeAddr = await bridge.getAddress();
  console.log(`  ✅ BLEBridgeV9 proxy deployed: ${bridgeAddr}`);

  // Verify musdToken is correct
  const musdInBridge = await bridge.musdToken();
  console.log(`  ✅ bridge.musdToken(): ${musdInBridge}`);
  if (musdInBridge.toLowerCase() !== ADDR.musd.toLowerCase()) {
    throw new Error(`musdToken mismatch: ${musdInBridge} !== ${ADDR.musd}`);
  }

  // ── Step 2: Grant BRIDGE_ROLE on MUSD to new bridge ──
  console.log("\n── Step 2: Grant BRIDGE_ROLE on MUSD ──");
  const musd = await ethers.getContractAt("MUSD", ADDR.musd);
  const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
  const tx1 = await musd.grantRole(BRIDGE_ROLE, bridgeAddr);
  await tx1.wait(2);
  console.log(`  ✅ BRIDGE_ROLE granted to new bridge on MUSD`);

  // ── Step 3: Set up VALIDATOR_ROLE for 2 validators ──
  console.log("\n── Step 3: Set up validators ──");
  const VALIDATOR_ROLE = await bridge.VALIDATOR_ROLE();

  // Deployer is already DEFAULT_ADMIN (from initialize)
  // Grant VALIDATOR_ROLE to deployer (validator 1)
  const tx2 = await bridge.grantRole(VALIDATOR_ROLE, deployer.address);
  await tx2.wait(2);
  console.log(`  ✅ VALIDATOR_ROLE → deployer (validator 1)`);

  // Create a second validator wallet
  const validator2 = ethers.Wallet.createRandom();
  const tx3 = await bridge.grantRole(VALIDATOR_ROLE, validator2.address);
  await tx3.wait(2);
  console.log(`  ✅ VALIDATOR_ROLE → ${validator2.address} (validator 2)`);
  console.log(`  ⚠️  Validator 2 private key (testnet only): ${validator2.privateKey}`);

  // Verify roles
  const RELAYER_ROLE = await bridge.RELAYER_ROLE();
  console.log(`\n  Role verification:`);
  console.log(`    DEFAULT_ADMIN: ${await bridge.hasRole(await bridge.DEFAULT_ADMIN_ROLE(), deployer.address)}`);
  console.log(`    RELAYER_ROLE:  ${await bridge.hasRole(RELAYER_ROLE, deployer.address)}`);
  console.log(`    VALIDATOR(1):  ${await bridge.hasRole(VALIDATOR_ROLE, deployer.address)}`);
  console.log(`    VALIDATOR(2):  ${await bridge.hasRole(VALIDATOR_ROLE, validator2.address)}`);
  console.log(`    BRIDGE on MUSD: ${await musd.hasRole(BRIDGE_ROLE, bridgeAddr)}`);
  console.log(`    minSignatures: ${await bridge.minSignatures()}`);

  // ── Step 4: Output for test script ──
  console.log("\n── Step 4: Test configuration ──");
  console.log(`  Update your e2e test with:`);
  console.log(`    bridge: "${bridgeAddr}",`);
  console.log(`    validator2Key: "${validator2.privateKey}",`);

  // ── Step 5: Save state ──
  console.log("\n═".repeat(70));
  console.log("  DEPLOYMENT COMPLETE");
  console.log("═".repeat(70));
  console.log(`  New bridge proxy: ${bridgeAddr}`);
  console.log(`  Validator 2 key:  ${validator2.privateKey}`);
  console.log(`  Old bridge:       0xB466be5F516F7Aa45E61bA2C7d2Db639c7B3D125 (musdToken mismatch — DO NOT USE)`);
  console.log();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
