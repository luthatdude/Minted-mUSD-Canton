/**
 * Task 7 — Deploy Strategies & Register with TreasuryV2
 *
 * Deploys 6 strategy proxies (PendleMarketSelector already deployed):
 *   1. PendleStrategyV2
 *   2. MorphoLoopStrategy
 *   3. SkySUSDSStrategy
 *   4. FluidLoopStrategy
 *   5. EulerV2LoopStrategy
 *   6. EulerV2CrossStableLoopStrategy
 *   7. MetaVault
 *
 * Then registers MetaVault + 3 sub-strategies with TreasuryV2.addStrategy()
 *
 * Usage:
 *   npx hardhat run scripts/deploy-and-register-strategies.ts --network sepolia
 */
import { ethers, upgrades } from "hardhat";

const CORE = {
  timelock:  "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410",
  treasury:  "0xf2051bDfc738f638668DF2f8c00d01ba6338C513",
  usdc:      "0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474",
};

// Mocks already deployed on Sepolia
const MOCKS: Record<string, string> = {
  rlusd:                "0xe435F3B9B772e4349547774251eed2ec1220D2CA",
  usds:                 "0xb4A219CbA22f37A4Fc609525f7baE6bc5119FbE8",
  morphoBlue:           "0xFf4F89dD40D83dA008f88366d1e4066eB1c12D17",
  morphoMarketId:       "0xf8bd2203f7d53e90bb1d2304ecdb443737e4848ecf65e1f3cd9e674011eb9872",
  aaveV3Pool:           "0x10cFdF253484E75bC746a0F0be6C194595C6cE6b",
  evc:                  "0x36E5a1359BD3ff326C86E7AEaAed5E35932BFd5B",
  eulerSupplyVaultUsdc: "0x7A78fD4eAf59ff5484Cd4E1cE386CC557f7a57D8",
  eulerBorrowVaultUsdc: "0x520f88b39342021548C675330A42f7Eb5c0564EE",
  eulerSupplyVaultRlusd: "0x2f875630902b2290Bdba853513a7c2d3D353d2cF",
  eulerBorrowVaultUsdcCross: "0xAEC852F71367f1B7e70529685575461fC251A1d4",
  rlusdPriceFeed:       "0x233f74d6DbB2253d53DccdaB5B39B012AA60a65B",
  merklDistributor:     "0xf2d880B60834aF2Ab6C8Ed20Ac74CC76346F21b4",
  swapRouter:           "0x1652Fee80c7038ab87828D77F21EA8F7FECBbf65",
  fluidVault:           "0xcf54A9bF5c82B1EC9cde70Ed15614451F46936a3",
  fluidVaultFactory:    "0x650Cb51e46D27765c71B61AB3c23468bEF2d5938",
  skyPsm:               "0x4120b088463B76AE7776f5C32518AECd3b762ABC",
  sUsds:                "0xC59B9d8Abf5d23BF90E1fC83bFb1D58cb1Dd31BA",
};

// PendleMarketSelector already deployed
const ALREADY_DEPLOYED = {
  pendleMarketSelector: "0x17Fb251e4580891590633848f3ea9d8d99DA77F6",
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

  console.log("═".repeat(70));
  console.log("  STRATEGY DEPLOYMENT & REGISTRATION — Sepolia Devnet");
  console.log("═".repeat(70));
  const startBal = await ethers.provider.getBalance(deployer.address);
  console.log(`  Deployer: ${deployer.address}`);
  console.log(`  Balance:  ${ethers.formatEther(startBal)} ETH`);
  console.log();

  const results: Record<string, string> = {};

  // ═══════════════════════════════════════════════════════════════════
  // 1. PendleStrategyV2 (UUPS proxy)
  // ═══════════════════════════════════════════════════════════════════
  console.log("[1/7] Deploying PendleStrategyV2...");
  await wait(3000);
  try {
    const Factory = await ethers.getContractFactory("PendleStrategyV2");
    const proxy = await upgrades.deployProxy(
      Factory,
      [
        CORE.usdc,                         // inputAsset
        ALREADY_DEPLOYED.pendleMarketSelector,
        CORE.treasury,
        deployer.address,
        CORE.timelock,
      ],
      { kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"] }
    );
    await proxy.waitForDeployment();
    results.PendleStrategyV2 = await proxy.getAddress();
    console.log(`  ✅ PendleStrategyV2: ${results.PendleStrategyV2}`);
  } catch (e: any) {
    console.log(`  ❌ PendleStrategyV2 failed: ${e.message?.slice(0, 120)}`);
    results.PendleStrategyV2 = "FAILED";
  }

  // ═══════════════════════════════════════════════════════════════════
  // 2. MorphoLoopStrategy (UUPS proxy)
  // ═══════════════════════════════════════════════════════════════════
  console.log("[2/7] Deploying MorphoLoopStrategy...");
  await wait(5000);
  try {
    const Factory = await ethers.getContractFactory("MorphoLoopStrategy");
    const proxy = await upgrades.deployProxy(
      Factory,
      [CORE.usdc, MOCKS.morphoBlue, MOCKS.morphoMarketId, CORE.treasury, deployer.address, CORE.timelock],
      { kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"] }
    );
    await proxy.waitForDeployment();
    results.MorphoLoopStrategy = await proxy.getAddress();
    console.log(`  ✅ MorphoLoopStrategy: ${results.MorphoLoopStrategy}`);
  } catch (e: any) {
    console.log(`  ❌ MorphoLoopStrategy failed: ${e.message?.slice(0, 120)}`);
    results.MorphoLoopStrategy = "FAILED";
  }

  // ═══════════════════════════════════════════════════════════════════
  // 3. SkySUSDSStrategy (UUPS proxy)
  // ═══════════════════════════════════════════════════════════════════
  console.log("[3/7] Deploying SkySUSDSStrategy...");
  await wait(5000);
  try {
    const Factory = await ethers.getContractFactory("SkySUSDSStrategy");
    const proxy = await upgrades.deployProxy(
      Factory,
      [CORE.usdc, MOCKS.usds, MOCKS.skyPsm, MOCKS.sUsds, CORE.treasury, deployer.address, CORE.timelock],
      { kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"] }
    );
    await proxy.waitForDeployment();
    results.SkySUSDSStrategy = await proxy.getAddress();
    console.log(`  ✅ SkySUSDSStrategy: ${results.SkySUSDSStrategy}`);
  } catch (e: any) {
    console.log(`  ❌ SkySUSDSStrategy failed: ${e.message?.slice(0, 120)}`);
    results.SkySUSDSStrategy = "FAILED";
  }

  // ═══════════════════════════════════════════════════════════════════
  // 4. FluidLoopStrategy (UUPS proxy)
  // ═══════════════════════════════════════════════════════════════════
  console.log("[4/7] Deploying FluidLoopStrategy...");
  await wait(5000);
  try {
    const Factory = await ethers.getContractFactory("FluidLoopStrategy");
    const proxy = await upgrades.deployProxy(
      Factory,
      [{
        mode: 1,
        inputAsset: CORE.usdc,
        supplyToken: CORE.usdc,
        borrowToken: CORE.usdc,
        supplyToken1: ethers.ZeroAddress,
        borrowToken1: ethers.ZeroAddress,
        fluidVault: MOCKS.fluidVault,
        vaultFactory: MOCKS.fluidVaultFactory,
        flashLoanPool: MOCKS.aaveV3Pool,
        merklDistributor: MOCKS.merklDistributor,
        swapRouter: MOCKS.swapRouter,
        vaultResolver: ethers.ZeroAddress,
        dexResolver: ethers.ZeroAddress,
        dexPool: ethers.ZeroAddress,
        treasury: CORE.treasury,
        admin: deployer.address,
        timelock: CORE.timelock,
      }],
      { kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"] }
    );
    await proxy.waitForDeployment();
    results.FluidLoopStrategy = await proxy.getAddress();
    console.log(`  ✅ FluidLoopStrategy: ${results.FluidLoopStrategy}`);
  } catch (e: any) {
    console.log(`  ❌ FluidLoopStrategy failed: ${e.message?.slice(0, 120)}`);
    results.FluidLoopStrategy = "FAILED";
  }

  // ═══════════════════════════════════════════════════════════════════
  // 5. EulerV2LoopStrategy (UUPS proxy)
  // ═══════════════════════════════════════════════════════════════════
  console.log("[5/7] Deploying EulerV2LoopStrategy...");
  await wait(5000);
  try {
    const Factory = await ethers.getContractFactory("EulerV2LoopStrategy");
    const proxy = await upgrades.deployProxy(
      Factory,
      [CORE.usdc, MOCKS.eulerSupplyVaultUsdc, MOCKS.eulerBorrowVaultUsdc, MOCKS.evc, MOCKS.aaveV3Pool, MOCKS.merklDistributor, MOCKS.swapRouter, CORE.treasury, deployer.address, CORE.timelock],
      { kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"] }
    );
    await proxy.waitForDeployment();
    results.EulerV2LoopStrategy = await proxy.getAddress();
    console.log(`  ✅ EulerV2LoopStrategy: ${results.EulerV2LoopStrategy}`);

    // Setup EVC
    const euler = await ethers.getContractAt("EulerV2LoopStrategy", results.EulerV2LoopStrategy);
    await (await euler.setupEVC()).wait();
    console.log(`     ✅ EVC configured`);
  } catch (e: any) {
    console.log(`  ❌ EulerV2LoopStrategy failed: ${e.message?.slice(0, 120)}`);
    results.EulerV2LoopStrategy = "FAILED";
  }

  // ═══════════════════════════════════════════════════════════════════
  // 6. EulerV2CrossStableLoopStrategy (UUPS proxy)
  // ═══════════════════════════════════════════════════════════════════
  console.log("[6/7] Deploying EulerV2CrossStableLoopStrategy...");
  await wait(5000);
  try {
    const Factory = await ethers.getContractFactory("EulerV2CrossStableLoopStrategy");
    const proxy = await upgrades.deployProxy(
      Factory,
      [{
        usdc: CORE.usdc,
        rlusd: MOCKS.rlusd,
        supplyVault: MOCKS.eulerSupplyVaultRlusd,
        borrowVault: MOCKS.eulerBorrowVaultUsdcCross,
        evc: MOCKS.evc,
        flashLoanPool: MOCKS.aaveV3Pool,
        merklDistributor: MOCKS.merklDistributor,
        swapRouter: MOCKS.swapRouter,
        rlusdPriceFeed: MOCKS.rlusdPriceFeed,
        treasury: CORE.treasury,
        admin: deployer.address,
        timelock: CORE.timelock,
      }],
      { kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"] }
    );
    await proxy.waitForDeployment();
    results.EulerV2CrossStableLoopStrategy = await proxy.getAddress();
    console.log(`  ✅ EulerV2CrossStableLoopStrategy: ${results.EulerV2CrossStableLoopStrategy}`);

    const euler = await ethers.getContractAt("EulerV2CrossStableLoopStrategy", results.EulerV2CrossStableLoopStrategy);
    await (await euler.setupEVC()).wait();
    console.log(`     ✅ EVC configured`);
  } catch (e: any) {
    console.log(`  ❌ EulerV2CrossStableLoopStrategy failed: ${e.message?.slice(0, 120)}`);
    results.EulerV2CrossStableLoopStrategy = "FAILED";
  }

  // ═══════════════════════════════════════════════════════════════════
  // 7. MetaVault (UUPS proxy)
  // ═══════════════════════════════════════════════════════════════════
  console.log("[7/7] Deploying MetaVault...");
  await wait(5000);
  try {
    const Factory = await ethers.getContractFactory("contracts/strategies/MetaVault.sol:MetaVault");
    const proxy = await upgrades.deployProxy(
      Factory,
      [CORE.usdc, CORE.treasury, deployer.address, CORE.timelock],
      { kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"] }
    );
    await proxy.waitForDeployment();
    results.MetaVault = await proxy.getAddress();
    console.log(`  ✅ MetaVault: ${results.MetaVault}`);
  } catch (e: any) {
    console.log(`  ❌ MetaVault failed: ${e.message?.slice(0, 120)}`);
    results.MetaVault = "FAILED";
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 2: GRANT TREASURY_ROLE to TreasuryV2 on each strategy
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n" + "─".repeat(70));
  console.log("  GRANTING TREASURY_ROLE");
  console.log("─".repeat(70));

  for (const [name, addr] of Object.entries(results)) {
    if (addr === "FAILED") continue;
    try {
      const strategy = await ethers.getContractAt("IAccessControl", addr);
      const TREASURY_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TREASURY_ROLE"));
      const hasTR = await strategy.hasRole(TREASURY_ROLE, CORE.treasury);
      if (!hasTR) {
        const tx = await strategy.grantRole(TREASURY_ROLE, CORE.treasury);
        await tx.wait();
        console.log(`  ${name}: TREASURY_ROLE → TreasuryV2 ✅`);
      } else {
        console.log(`  ${name}: TREASURY_ROLE already set ✅`);
      }
    } catch (e: any) {
      console.log(`  ${name}: TREASURY_ROLE grant failed — ${e.message?.slice(0, 80)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 3: REGISTER WITH TREASURYV2
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n" + "─".repeat(70));
  console.log("  REGISTERING STRATEGIES WITH TREASURYV2");
  console.log("─".repeat(70));

  const treasury = await ethers.getContractAt("TreasuryV2", CORE.treasury);
  const existingCount = await treasury.strategyCount();
  console.log(`  Current strategy count: ${existingCount}`);
  console.log(`  Deployer has STRATEGIST: ${await treasury.hasRole(await treasury.STRATEGIST_ROLE(), deployer.address)}`);
  console.log();

  // Strategy allocations (total = 10000 bps including reserve)
  // Reserve: 3000 bps (30%)
  // MetaVault: 3000 bps (30%)
  // MorphoLoop: 1500 bps (15%)
  // SkySUSDS: 1500 bps (15%)
  // FluidLoop: 1000 bps (10%)
  // Total: 3000 + 3000 + 1500 + 1500 + 1000 = 10000 ✅
  const registrations = [
    { name: "MetaVault",         addr: results.MetaVault,         target: 3000, min: 1000, max: 5000, auto: true },
    { name: "MorphoLoopStrategy", addr: results.MorphoLoopStrategy, target: 1500, min: 500, max: 3000, auto: true },
    { name: "SkySUSDSStrategy",  addr: results.SkySUSDSStrategy,  target: 1500, min: 500, max: 3000, auto: true },
    { name: "FluidLoopStrategy", addr: results.FluidLoopStrategy, target: 1000, min: 200, max: 2000, auto: true },
  ];

  for (const reg of registrations) {
    if (!reg.addr || reg.addr === "FAILED") {
      console.log(`  ⏭️  ${reg.name}: SKIPPED (deployment failed)`);
      continue;
    }
    await wait(3000);
    try {
      const tx = await treasury.addStrategy(
        reg.addr,
        reg.target,
        reg.min,
        reg.max,
        reg.auto
      );
      const receipt = await tx.wait();
      console.log(`  ✅ ${reg.name}: registered (target=${reg.target}bps, tx=${receipt!.hash.slice(0,18)}...)`);
    } catch (e: any) {
      console.log(`  ❌ ${reg.name}: registration failed — ${e.message?.slice(0, 120)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // VERIFY
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n" + "─".repeat(70));
  console.log("  VERIFICATION");
  console.log("─".repeat(70));
  const finalCount = await treasury.strategyCount();
  console.log(`  Strategy count: ${existingCount} → ${finalCount}`);

  try {
    const strategies = await treasury.getAllStrategies();
    for (let i = 0; i < strategies.length; i++) {
      const s = strategies[i];
      console.log(`  [${i}] ${s.strategy} — target=${s.targetBps}bps, active=${s.active}, autoAlloc=${s.autoAllocate}`);
    }
  } catch (e: any) { console.log(`  Strategy list error: ${e.message?.slice(0, 80)}`); }

  // ═══════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════
  const endBal = await ethers.provider.getBalance(deployer.address);
  const gasUsed = ethers.formatEther(startBal - endBal);

  console.log("\n" + "═".repeat(70));
  console.log("  DEPLOYMENT COMPLETE");
  console.log("═".repeat(70));

  console.log("\n  ── Strategy Proxies ──");
  for (const [name, addr] of Object.entries(results)) {
    console.log(`  ${name.padEnd(40)} ${addr}`);
  }

  console.log();
  console.log(`  Gas used:  ${gasUsed} ETH`);
  console.log(`  Remaining: ${ethers.formatEther(endBal)} ETH`);
  console.log();
  console.log("// ── Strategy addresses (JSON) ──");
  console.log(JSON.stringify(results, null, 2));
  console.log("═".repeat(70));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
