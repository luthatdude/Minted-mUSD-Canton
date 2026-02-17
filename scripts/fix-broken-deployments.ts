import { ethers, upgrades } from "hardhat";

/**
 * FIX BROKEN DEPLOYMENTS — Sepolia
 *
 * Root Cause:
 *   deploy-testnet-resume.ts used `deployer.address` as placeholder for USDC_ADDRESS,
 *   which cascaded into DirectMintV2 (immutable usdc/treasury) and TreasuryV2 (asset).
 *
 * What This Script Does:
 *   1. Deploy a NEW TreasuryV2 proxy with correct asset (MockUSDC)
 *   2. Deploy a NEW DirectMintV2 with correct constructor args (MockUSDC, MUSD, new TreasuryV2)
 *   3. Grant BRIDGE_ROLE to new DirectMintV2 on MUSD (so it can call musd.mint())
 *   4. Grant VAULT_ROLE on new TreasuryV2 to new DirectMintV2 (so it can call treasury.deposit())
 *   5. Print updated addresses for test scripts
 *
 * Pre-requisites:
 *   - .env DEPLOYER_PRIVATE_KEY must be the NEW deployer (0xe640db3A...) which has admin on all contracts
 *   - New deployer must have enough Sepolia ETH for gas (~0.02 ETH)
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("═".repeat(60));
  console.log("FIX BROKEN DEPLOYMENTS");
  console.log("═".repeat(60));
  console.log("Deployer:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "ETH");
  if (balance < ethers.parseEther("0.01")) throw new Error("Insufficient Sepolia ETH");

  // ═══════════════════════════════════════════════════════════════════════
  // CORRECT ADDRESSES
  // ═══════════════════════════════════════════════════════════════════════
  const MOCK_USDC     = "0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474";
  const MUSD          = "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B";
  const SMUSD         = "0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540";
  const TIMELOCK      = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";
  const FEE_RECIPIENT = deployer.address;

  // Old (broken) addresses for reference
  const OLD_DIRECT_MINT = "0xa869f58c213634Dda2Ef522b66E9587b953279C2";
  const OLD_TREASURY    = "0x11Cc7750F2033d21FC3762b94D1355eD15F7913d";

  console.log("\nCorrect addresses:");
  console.log("  MockUSDC:", MOCK_USDC);
  console.log("  MUSD:", MUSD);
  console.log("  SMUSD:", SMUSD);
  console.log("  Timelock:", TIMELOCK);

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 1: Deploy NEW TreasuryV2 (UUPS proxy)
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[1/5] Deploying NEW TreasuryV2 (UUPS proxy) with correct asset...");
  const TreasuryImpl = await ethers.getContractFactory("TreasuryV2");
  const treasuryProxy = await upgrades.deployProxy(TreasuryImpl, [
    MOCK_USDC,          // _asset  (was deployer.address — WRONG)
    SMUSD,              // _vault  (SMUSD vault)
    deployer.address,   // _admin
    FEE_RECIPIENT,      // _feeRecipient
    TIMELOCK,           // _timelock
  ], { kind: "uups" });
  await treasuryProxy.waitForDeployment();
  const newTreasuryAddress = await treasuryProxy.getAddress();
  console.log("  ✅ NEW TreasuryV2 proxy:", newTreasuryAddress);

  // Verify correct asset
  const treasury = await ethers.getContractAt("TreasuryV2", newTreasuryAddress);
  const assetAddr = await treasury.asset();
  console.log("  Verification: asset() =", assetAddr);
  if (assetAddr.toLowerCase() !== MOCK_USDC.toLowerCase()) {
    throw new Error("TreasuryV2 asset mismatch!");
  }
  console.log("  ✅ Asset correctly set to MockUSDC");

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2: Deploy NEW DirectMintV2
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[2/5] Deploying NEW DirectMintV2 with correct constructor args...");
  const DirectMintFactory = await ethers.getContractFactory("DirectMintV2");
  const directMint = await DirectMintFactory.deploy(
    MOCK_USDC,            // _usdc      (was deployer.address — WRONG)
    MUSD,                 // _musd      (was correct)
    newTreasuryAddress,   // _treasury  (was deployer.address — WRONG)
    FEE_RECIPIENT         // _feeRecipient
  );
  await directMint.waitForDeployment();
  const newDirectMintAddress = await directMint.getAddress();
  console.log("  ✅ NEW DirectMintV2:", newDirectMintAddress);

  // Verify immutables
  const dm = await ethers.getContractAt("DirectMintV2", newDirectMintAddress);
  const dmUsdc = await dm.usdc();
  const dmMusd = await dm.musd();
  const dmTreasury = await dm.treasury();
  console.log("  Verification:");
  console.log("    usdc()     =", dmUsdc);
  console.log("    musd()     =", dmMusd);
  console.log("    treasury() =", dmTreasury);

  if (dmUsdc.toLowerCase() !== MOCK_USDC.toLowerCase()) throw new Error("usdc mismatch!");
  if (dmMusd.toLowerCase() !== MUSD.toLowerCase()) throw new Error("musd mismatch!");
  if (dmTreasury.toLowerCase() !== newTreasuryAddress.toLowerCase()) throw new Error("treasury mismatch!");
  console.log("  ✅ All immutables correctly set");

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3: Grant BRIDGE_ROLE to new DirectMintV2 on MUSD
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[3/5] Granting BRIDGE_ROLE on MUSD to new DirectMintV2...");
  const musd = await ethers.getContractAt("MUSD", MUSD);
  const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ROLE"));
  const hasBridgeRole = await musd.hasRole(BRIDGE_ROLE, newDirectMintAddress);
  if (!hasBridgeRole) {
    const tx = await musd.grantRole(BRIDGE_ROLE, newDirectMintAddress);
    await tx.wait();
    console.log("  ✅ BRIDGE_ROLE granted (tx:", tx.hash, ")");
  } else {
    console.log("  ✅ Already has BRIDGE_ROLE");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 4: Grant VAULT_ROLE on new TreasuryV2 to new DirectMintV2
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[4/5] Granting VAULT_ROLE on new TreasuryV2 to new DirectMintV2...");
  const VAULT_ROLE = ethers.keccak256(ethers.toUtf8Bytes("VAULT_ROLE"));
  const hasVaultRole = await treasury.hasRole(VAULT_ROLE, newDirectMintAddress);
  if (!hasVaultRole) {
    const tx = await treasury.grantRole(VAULT_ROLE, newDirectMintAddress);
    await tx.wait();
    console.log("  ✅ VAULT_ROLE granted (tx:", tx.hash, ")");
  } else {
    console.log("  ✅ Already has VAULT_ROLE");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 5: Revoke BRIDGE_ROLE from OLD DirectMintV2 on MUSD
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[5/5] Revoking BRIDGE_ROLE from OLD DirectMintV2 on MUSD...");
  const oldHasBridgeRole = await musd.hasRole(BRIDGE_ROLE, OLD_DIRECT_MINT);
  if (oldHasBridgeRole) {
    const tx = await musd.revokeRole(BRIDGE_ROLE, OLD_DIRECT_MINT);
    await tx.wait();
    console.log("  ✅ Revoked BRIDGE_ROLE from old DirectMintV2:", OLD_DIRECT_MINT);
  } else {
    console.log("  ✅ Old DirectMintV2 already has no BRIDGE_ROLE");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n" + "═".repeat(60));
  console.log("REDEPLOYMENT COMPLETE");
  console.log("═".repeat(60));
  console.log("\n📋 UPDATE THESE ADDRESSES in test scripts + SEPOLIA_TESTING.md:\n");
  console.log(`  OLD DirectMintV2: ${OLD_DIRECT_MINT}  → DEPRECATED`);
  console.log(`  NEW DirectMintV2: ${newDirectMintAddress}`);
  console.log(`  OLD TreasuryV2:   ${OLD_TREASURY}  → DEPRECATED`);
  console.log(`  NEW TreasuryV2:   ${newTreasuryAddress}`);
  console.log("\nAll other contract addresses remain unchanged.");

  const endBalance = await ethers.provider.getBalance(deployer.address);
  const gasUsed = balance - endBalance;
  console.log(`\nGas used: ${ethers.formatEther(gasUsed)} ETH`);
  console.log(`Remaining: ${ethers.formatEther(endBalance)} ETH`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
