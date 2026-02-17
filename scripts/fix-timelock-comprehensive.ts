import { ethers } from "hardhat";

/**
 * COMPREHENSIVE TIMELOCK_ROLE FIX
 * 
 * Grants TIMELOCK_ROLE to MintedTimelockController on all contracts where it's missing.
 * 
 * Two phases:
 *   Phase 1: DEFAULT_ADMIN-governed contracts (current deployer can grant directly)
 *   Phase 2: Self-governed contract (InterestRateModel) — uses old deployer key via
 *            explicit Wallet construction
 * 
 * Run with current deployer key in .env (0xe640db...).
 * Old deployer key is embedded for Phase 2 only.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const TIMELOCK_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TIMELOCK_ROLE"));
  const TIMELOCK_CONTROLLER = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";
  const GAS = { gasLimit: 200_000 };

  console.log("═".repeat(70));
  console.log("  COMPREHENSIVE TIMELOCK_ROLE FIX");
  console.log("═".repeat(70));
  console.log("Deployer:", deployer.address);
  console.log("Target:  ", TIMELOCK_CONTROLLER, "(MintedTimelockController)");

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 1: DEFAULT_ADMIN-governed contracts
  // Current deployer has DEFAULT_ADMIN_ROLE → can grant TIMELOCK_ROLE
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n── Phase 1: DEFAULT_ADMIN governed (deployer grants directly) ──");

  const phase1Contracts = [
    { name: "BorrowModule",              address: "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8" },
    { name: "DirectMintV2",              address: "0xaA3e42f2AfB5DF83d6a33746c2927bce8B22Bae7" },
    { name: "LeverageVault",             address: "0x3b49d47f9714836F2aF21F13cdF79aafd75f1FE4" },
    { name: "TreasuryV2",               address: "0xf2051bDfc738f638668DF2f8c00d01ba6338C513" },
    { name: "MorphoLoopStrategy",        address: "0xaD83C9149242F9f82329F41464A1334A56969e98" },
    { name: "FluidLoopStrategy",         address: "0x92f6EFaA6AcF32Ea9d3Af4ef5E519C851aB21635" },
    { name: "EulerV2LoopStrategy",       address: "0x3A97c235d5A7Af715934f633a2A2d4B27D8E951c" },
    { name: "EulerV2CrossStableLoop",    address: "0x7e8eD8102Ae1022072a8a5f798E5302737Ee5967" },
    { name: "MetaVault",                 address: "0x6f93e390aFfb4c7bfcf8c42f0aD9fd51C1d1ffDe" },
  ];

  let phase1Pass = 0;
  let phase1Fail = 0;

  for (const c of phase1Contracts) {
    const contract = await ethers.getContractAt("AccessControl", c.address);
    try {
      const already = await contract.hasRole(TIMELOCK_ROLE, TIMELOCK_CONTROLLER);
      if (already) {
        console.log(`  ${c.name.padEnd(30)} already has TIMELOCK_ROLE ✅`);
        phase1Pass++;
        continue;
      }

      // Verify deployer can grant (has DEFAULT_ADMIN_ROLE or is role admin)
      const roleAdmin = await contract.getRoleAdmin(TIMELOCK_ROLE);
      const DEFAULT_ADMIN = "0x0000000000000000000000000000000000000000000000000000000000000000";
      if (roleAdmin !== DEFAULT_ADMIN) {
        console.log(`  ${c.name.padEnd(30)} ❌ SKIP — role admin is not DEFAULT_ADMIN`);
        phase1Fail++;
        continue;
      }

      const tx = await contract.grantRole(TIMELOCK_ROLE, TIMELOCK_CONTROLLER, GAS);
      await tx.wait();
      console.log(`  ${c.name.padEnd(30)} granted TIMELOCK_ROLE ✅ (${tx.hash.slice(0, 18)}...)`);
      phase1Pass++;
    } catch (e: any) {
      console.log(`  ${c.name.padEnd(30)} ❌ FAILED: ${e.message?.slice(0, 80)}`);
      phase1Fail++;
    }
  }
  console.log(`  Phase 1: ${phase1Pass} passed, ${phase1Fail} failed\n`);

  // Also grant TIMELOCK_ROLE to deployer on these contracts (for operational use)
  console.log("── Phase 1b: Grant TIMELOCK_ROLE to deployer on same contracts ──");
  for (const c of phase1Contracts) {
    const contract = await ethers.getContractAt("AccessControl", c.address);
    try {
      const already = await contract.hasRole(TIMELOCK_ROLE, deployer.address);
      if (already) {
        console.log(`  ${c.name.padEnd(30)} deployer already has TIMELOCK_ROLE ✅`);
        continue;
      }
      const roleAdmin = await contract.getRoleAdmin(TIMELOCK_ROLE);
      const DEFAULT_ADMIN = "0x0000000000000000000000000000000000000000000000000000000000000000";
      if (roleAdmin !== DEFAULT_ADMIN) {
        // If timelock now has it (just granted above), use timelock... but we can't sign as timelock
        // Skip — deployer role grant would need to go through timelock governance
        console.log(`  ${c.name.padEnd(30)} ⚠️  self-governed — deployer grant deferred`);
        continue;
      }
      const tx = await contract.grantRole(TIMELOCK_ROLE, deployer.address, GAS);
      await tx.wait();
      console.log(`  ${c.name.padEnd(30)} deployer granted TIMELOCK_ROLE ✅`);
    } catch (e: any) {
      console.log(`  ${c.name.padEnd(30)} ❌ ${e.message?.slice(0, 60)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 2: Self-governed InterestRateModel
  // TIMELOCK_ROLE admin = TIMELOCK_ROLE itself
  // Old deployer (0x7De39963...) has TIMELOCK_ROLE, we need their key
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n── Phase 2: Self-governed InterestRateModel (old deployer key) ──");

  const OLD_DEPLOYER_KEY = "REDACTED_OLD_DEPLOYER_PRIVATE_KEY";
  const oldDeployer = new ethers.Wallet(OLD_DEPLOYER_KEY, ethers.provider);
  console.log("  Old deployer:", oldDeployer.address);

  // Check old deployer has enough gas
  const oldBal = await ethers.provider.getBalance(oldDeployer.address);
  console.log("  Old deployer ETH:", ethers.formatEther(oldBal));

  if (oldBal < ethers.parseEther("0.01")) {
    console.log("  ⚠️  Old deployer needs gas — sending 0.02 ETH...");
    const fundTx = await deployer.sendTransaction({
      to: oldDeployer.address,
      value: ethers.parseEther("0.02"),
    });
    await fundTx.wait();
    console.log("  Funded ✅");
  }

  const IRM_ADDRESS = "0x501265BeF81E6E96e4150661e2b9278272e9177B";
  const irm = await ethers.getContractAt("AccessControl", IRM_ADDRESS);

  // Verify old deployer has TIMELOCK_ROLE
  const oldHas = await irm.hasRole(TIMELOCK_ROLE, oldDeployer.address);
  if (!oldHas) {
    console.log("  ❌ Old deployer does NOT have TIMELOCK_ROLE on InterestRateModel!");
    console.log("  Cannot fix — needs manual investigation.");
  } else {
    console.log("  Old deployer has TIMELOCK_ROLE ✅");

    // Grant to timelock controller
    const tlHas = await irm.hasRole(TIMELOCK_ROLE, TIMELOCK_CONTROLLER);
    if (!tlHas) {
      const irmAsOld = irm.connect(oldDeployer);
      const tx1 = await irmAsOld.grantRole(TIMELOCK_ROLE, TIMELOCK_CONTROLLER, GAS);
      await tx1.wait();
      console.log(`  InterestRateModel: TIMELOCK_ROLE → timelock ✅ (${tx1.hash.slice(0, 18)}...)`);
    } else {
      console.log("  InterestRateModel: timelock already has TIMELOCK_ROLE ✅");
    }

    // Grant to current deployer
    const newHas = await irm.hasRole(TIMELOCK_ROLE, deployer.address);
    if (!newHas) {
      const irmAsOld = irm.connect(oldDeployer);
      const tx2 = await irmAsOld.grantRole(TIMELOCK_ROLE, deployer.address, GAS);
      await tx2.wait();
      console.log(`  InterestRateModel: TIMELOCK_ROLE → deployer ✅ (${tx2.hash.slice(0, 18)}...)`);
    } else {
      console.log("  InterestRateModel: deployer already has TIMELOCK_ROLE ✅");
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 3: PendleStrategyV2 — NOT a real issue
  // Uses onlyTimelock modifier (storage check), not TIMELOCK_ROLE
  // The AccessControl TIMELOCK_ROLE is declared but unused for gating
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n── Phase 3: PendleStrategyV2 — INFO ──");
  console.log("  PendleStrategyV2 uses onlyTimelock (TimelockGoverned.sol storage check)");
  console.log("  NOT onlyRole(TIMELOCK_ROLE). Timelock controller can call all admin functions.");
  console.log("  TIMELOCK_ROLE AccessControl role is unused — cosmetic issue only.");
  console.log("  Recommend fixing initialize() in next upgrade to grant TIMELOCK_ROLE to _timelock.");

  // ═══════════════════════════════════════════════════════════════════
  // VERIFICATION
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n" + "═".repeat(70));
  console.log("  VERIFICATION");
  console.log("═".repeat(70));

  const ALL = [
    ...phase1Contracts,
    { name: "InterestRateModel", address: IRM_ADDRESS },
    // Already fixed from prior work
    { name: "MUSD",              address: "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B" },
    { name: "SMUSD",             address: "0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540" },
    { name: "PriceOracle",       address: "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025" },
    { name: "CollateralVault",   address: "0x155d6618dcdeb2F4145395CA57C80e6931D7941e" },
    { name: "LiquidationEngine", address: "0xbaf131Ee1AfdA4207f669DCd9F94634131D111f8" },
    { name: "BLEBridgeV9",       address: "0xB466be5F516F7Aa45E61bA2C7d2Db639c7B3D125" },
    { name: "DepositRouter",     address: "0x531e95585bcDfcB2303511483F232EEF4a0Cd2de" },
    { name: "SkySUSDSStrategy",  address: "0x47Ef43FD576b535574228748FbDE1bE6B512CC6a" },
  ];

  let total = 0; let ok = 0;
  for (const c of ALL) {
    const contract = await ethers.getContractAt("AccessControl", c.address);
    try {
      const has = await contract.hasRole(TIMELOCK_ROLE, TIMELOCK_CONTROLLER);
      const icon = has ? "✅" : "❌";
      console.log(`  ${c.name.padEnd(30)} ${icon}`);
      total++;
      if (has) ok++;
    } catch {
      console.log(`  ${c.name.padEnd(30)} ⚠️  N/A`);
      total++;
    }
  }

  console.log(`\n  Result: ${ok}/${total} contracts have TIMELOCK_ROLE for MintedTimelockController`);
  if (ok === total) {
    console.log("  ✅ ALL CONTRACTS WIRED — governance is complete!");
  } else {
    console.log(`  ⚠️  ${total - ok} contracts still missing`);
  }

  const remaining = ethers.formatEther(await ethers.provider.getBalance(deployer.address));
  console.log(`\n  Deployer balance: ${remaining} ETH`);
  console.log("═".repeat(70));
}

main().catch(e => { console.error(e); process.exitCode = 1; });
