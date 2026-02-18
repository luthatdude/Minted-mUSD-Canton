import { ethers } from "hardhat";

/**
 * Audit TIMELOCK_ROLE state across ALL contracts that use it.
 * Reports: who has it, who is the role admin, and whether the
 * MintedTimelockController can call governance functions.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const TIMELOCK_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TIMELOCK_ROLE"));
  const TIMELOCK_CONTROLLER = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";

  console.log("Deployer:", deployer.address);
  console.log("MintedTimelockController:", TIMELOCK_CONTROLLER);
  console.log("TIMELOCK_ROLE hash:", TIMELOCK_ROLE);
  console.log("");

  const CONTRACTS = [
    // Core protocol
    { name: "MUSD",                address: "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B" },
    { name: "SMUSD",               address: "0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540" },
    { name: "PriceOracle",         address: "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025" },
    { name: "InterestRateModel",   address: "0x501265BeF81E6E96e4150661e2b9278272e9177B" },
    { name: "CollateralVault",     address: "0x155d6618dcdeb2F4145395CA57C80e6931D7941e" },
    { name: "BorrowModule",        address: "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8" },
    { name: "LiquidationEngine",   address: "0xbaf131Ee1AfdA4207f669DCd9F94634131D111f8" },
    { name: "DirectMintV2",        address: "0xaA3e42f2AfB5DF83d6a33746c2927bce8B22Bae7" },
    { name: "LeverageVault",       address: "0x3b49d47f9714836F2aF21F13cdF79aafd75f1FE4" },
    { name: "TreasuryV2",          address: "0xf2051bDfc738f638668DF2f8c00d01ba6338C513" },
    { name: "BLEBridgeV9",         address: "0x708957bFfA312D1730BdF87467E695D3a9F26b0f" },
    { name: "DepositRouter",       address: "0x531e95585bcDfcB2303511483F232EEF4a0Cd2de" },
    // Strategies
    { name: "PendleStrategyV2",           address: "0x38726CC401b732Cf3c5AF8CC0Dc4E7c10204c6C6" },
    { name: "MorphoLoopStrategy",         address: "0xaD83C9149242F9f82329F41464A1334A56969e98" },
    { name: "SkySUSDSStrategy",           address: "0x47Ef43FD576b535574228748FbDE1bE6B512CC6a" },
    { name: "FluidLoopStrategy",          address: "0x92f6EFaA6AcF32Ea9d3Af4ef5E519C851aB21635" },
    { name: "EulerV2LoopStrategy",        address: "0x3A97c235d5A7Af715934f633a2A2d4B27D8E951c" },
    { name: "EulerV2CrossStableLoop",     address: "0x7e8eD8102Ae1022072a8a5f798E5302737Ee5967" },
    { name: "MetaVault",                  address: "0x6f93e390aFfb4c7bfcf8c42f0aD9fd51C1d1ffDe" },
  ];

  const missing: { name: string; address: string; deployerHas: boolean; timelockHas: boolean; roleAdmin: string }[] = [];

  for (const c of CONTRACTS) {
    const contract = await ethers.getContractAt("AccessControl", c.address);
    try {
      const deployerHas = await contract.hasRole(TIMELOCK_ROLE, deployer.address);
      const timelockHas = await contract.hasRole(TIMELOCK_ROLE, TIMELOCK_CONTROLLER);
      const roleAdmin = await contract.getRoleAdmin(TIMELOCK_ROLE);
      const isSelfGoverned = roleAdmin === TIMELOCK_ROLE;
      const adminLabel = isSelfGoverned ? "TIMELOCK_ROLE (self)" : roleAdmin === "0x0000000000000000000000000000000000000000000000000000000000000000" ? "DEFAULT_ADMIN" : roleAdmin.slice(0, 18) + "...";

      const deployerIcon = deployerHas ? "✅" : "❌";
      const timelockIcon = timelockHas ? "✅" : "❌";
      
      console.log(`${c.name.padEnd(30)} deployer=${deployerIcon}  timelock=${timelockIcon}  admin=${adminLabel}`);
      
      if (!timelockHas) {
        missing.push({ name: c.name, address: c.address, deployerHas, timelockHas, roleAdmin });
      }
    } catch (e: any) {
      console.log(`${c.name.padEnd(30)} ⚠️  No TIMELOCK_ROLE (${e.message?.slice(0, 60)})`);
    }
  }

  console.log("\n" + "═".repeat(70));
  if (missing.length === 0) {
    console.log("✅ All contracts have TIMELOCK_ROLE granted to MintedTimelockController");
  } else {
    console.log(`❌ ${missing.length} contracts MISSING TIMELOCK_ROLE for timelock controller:`);
    for (const m of missing) {
      const canFix = m.deployerHas ? "fixable (deployer can grant)" : "⚠️  deployer also missing — needs role admin";
      console.log(`  - ${m.name} @ ${m.address.slice(0, 10)}... — ${canFix}`);
    }
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
