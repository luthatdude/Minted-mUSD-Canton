import { ethers, upgrades } from "hardhat";

/**
 * Resumable Strategy Deployment — Phase 0 (remaining mocks) + Phases 1-8 + Roles
 *
 * Phase 0 partially completed earlier. These 6 mocks are already deployed:
 *   RLUSD:                0xe435F3B9B772e4349547774251eed2ec1220D2CA
 *   USDS:                 0xb4A219CbA22f37A4Fc609525f7baE6bc5119FbE8
 *   MorphoBlue:           0xFf4F89dD40D83dA008f88366d1e4066eB1c12D17
 *   AaveV3Pool:           0x10cFdF253484E75bC746a0F0be6C194595C6cE6b
 *   EVC:                  0x36E5a1359BD3ff326C86E7AEaAed5E35932BFd5B
 *   EulerSupplyVault(USDC): 0x7A78fD4eAf59ff5484Cd4E1cE386CC557f7a57D8
 *
 * This script deploys the remaining 10 mocks, then all 8 strategy proxies + roles.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-strategies-devnet.ts --network sepolia
 */

// ═══════════════════════════════════════════════════════════════════════════
// CORE PROTOCOL (already deployed)
// ═══════════════════════════════════════════════════════════════════════════
const CORE = {
  timelockAddress: "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410",
  treasuryV2Address: "0xf2051bDfc738f638668DF2f8c00d01ba6338C513",
  usdcAddress: "0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474",
};

// ═══════════════════════════════════════════════════════════════════════════
// ALREADY DEPLOYED MOCKS (from partial run)
// ═══════════════════════════════════════════════════════════════════════════
const MOCKS: Record<string, string> = {
  rlusd: "0xe435F3B9B772e4349547774251eed2ec1220D2CA",
  usds: "0xb4A219CbA22f37A4Fc609525f7baE6bc5119FbE8",
  morphoBlue: "0xFf4F89dD40D83dA008f88366d1e4066eB1c12D17",
  morphoMarketId: "0xf8bd2203f7d53e90bb1d2304ecdb443737e4848ecf65e1f3cd9e674011eb9872",
  aaveV3Pool: "0x10cFdF253484E75bC746a0F0be6C194595C6cE6b",
  evc: "0x36E5a1359BD3ff326C86E7AEaAed5E35932BFd5B",
  eulerSupplyVaultUsdc: "0x7A78fD4eAf59ff5484Cd4E1cE386CC557f7a57D8",
  // Deployed in second run:
  eulerBorrowVaultUsdc: "0x520f88b39342021548C675330A42f7Eb5c0564EE",
  eulerSupplyVaultRlusd: "0x2f875630902b2290Bdba853513a7c2d3D353d2cF",
  eulerBorrowVaultUsdcCross: "0xAEC852F71367f1B7e70529685575461fC251A1d4",
  rlusdPriceFeed: "0x233f74d6DbB2253d53DccdaB5B39B012AA60a65B",
  merklDistributor: "0xf2d880B60834aF2Ab6C8Ed20Ac74CC76346F21b4",
  swapRouter: "0x1652Fee80c7038ab87828D77F21EA8F7FECBbf65",
  fluidVault: "0xcf54A9bF5c82B1EC9cde70Ed15614451F46936a3",
  fluidVaultFactory: "0x650Cb51e46D27765c71B61AB3c23468bEF2d5938",
  skyPsm: "0x4120b088463B76AE7776f5C32518AECd3b762ABC",
  sUsds: "0xC59B9d8Abf5d23BF90E1fC83bFb1D58cb1Dd31BA",
};

// Strategy already deployed in second run:
const ALREADY_DEPLOYED = {
  PendleMarketSelector: "0x17Fb251e4580891590633848f3ea9d8d99DA77F6",
};

async function deployRemainingMocks(deployer: any) {
  console.log("─".repeat(70));
  console.log("  PHASE 0 (resume): Deploying Remaining Mock Infrastructure");
  console.log("─".repeat(70));

  const usdc = CORE.usdcAddress;
  const MockEulerVault = await ethers.getContractFactory("MockEulerVaultCrossStable");

  // 0g. MockEulerVault — USDC borrow vault
  console.log("  [0g] MockEulerVault — USDC borrow...");
  const eulerBorrowUsdc = await MockEulerVault.deploy(usdc);
  await eulerBorrowUsdc.waitForDeployment();
  MOCKS.eulerBorrowVaultUsdc = await eulerBorrowUsdc.getAddress();
  console.log(`       ✅ EulerBorrowVault(USDC): ${MOCKS.eulerBorrowVaultUsdc}`);

  // 0h. MockEulerVault — RLUSD supply vault (cross-stable)
  console.log("  [0h] MockEulerVault — RLUSD supply...");
  const eulerSupplyRlusd = await MockEulerVault.deploy(MOCKS.rlusd);
  await eulerSupplyRlusd.waitForDeployment();
  MOCKS.eulerSupplyVaultRlusd = await eulerSupplyRlusd.getAddress();
  console.log(`       ✅ EulerSupplyVault(RLUSD): ${MOCKS.eulerSupplyVaultRlusd}`);

  // 0i. MockEulerVault — USDC borrow vault (cross-stable)
  console.log("  [0i] MockEulerVault — USDC borrow (cross)...");
  const eulerBorrowUsdcCross = await MockEulerVault.deploy(usdc);
  await eulerBorrowUsdcCross.waitForDeployment();
  MOCKS.eulerBorrowVaultUsdcCross = await eulerBorrowUsdcCross.getAddress();
  console.log(`       ✅ EulerBorrowVault(USDC-cross): ${MOCKS.eulerBorrowVaultUsdcCross}`);

  // 0j. MockPriceFeedCrossStable — RLUSD/USD ($1.00, 8 decimals)
  console.log("  [0j] MockPriceFeedCrossStable — RLUSD/USD...");
  const MockPriceFeed = await ethers.getContractFactory("MockPriceFeedCrossStable");
  const rlusdFeed = await MockPriceFeed.deploy(1e8, 8);
  await rlusdFeed.waitForDeployment();
  MOCKS.rlusdPriceFeed = await rlusdFeed.getAddress();
  console.log(`       ✅ RLUSD/USD Feed: ${MOCKS.rlusdPriceFeed}`);

  // 0k. MockMerklDistributor
  console.log("  [0k] MockMerklDistributor...");
  const MockMerkl = await ethers.getContractFactory("MockMerklDistributor");
  const merkl = await MockMerkl.deploy();
  await merkl.waitForDeployment();
  MOCKS.merklDistributor = await merkl.getAddress();
  console.log(`       ✅ MerklDistributor: ${MOCKS.merklDistributor}`);

  // 0l. MockSwapRouterV3ForLoop (1:1 stablecoin swaps)
  console.log("  [0l] MockSwapRouterV3ForLoop...");
  const MockRouter = await ethers.getContractFactory("MockSwapRouterV3ForLoop");
  const swapRouter = await MockRouter.deploy();
  await swapRouter.waitForDeployment();
  MOCKS.swapRouter = await swapRouter.getAddress();
  console.log(`       ✅ SwapRouter: ${MOCKS.swapRouter}`);

  // 0m. MockFluidVaultT1 (USDC/USDC stable vault)
  console.log("  [0m] MockFluidVaultT1...");
  const MockFluidVaultT1 = await ethers.getContractFactory("MockFluidVaultT1");
  const fluidVault = await MockFluidVaultT1.deploy(usdc, usdc);
  await fluidVault.waitForDeployment();
  MOCKS.fluidVault = await fluidVault.getAddress();
  console.log(`       ✅ FluidVaultT1: ${MOCKS.fluidVault}`);

  // 0n. MockFluidVaultFactory
  console.log("  [0n] MockFluidVaultFactory...");
  const MockFluidFactory = await ethers.getContractFactory("MockFluidVaultFactory");
  const fluidFactory = await MockFluidFactory.deploy();
  await fluidFactory.waitForDeployment();
  MOCKS.fluidVaultFactory = await fluidFactory.getAddress();
  await (await fluidFactory.registerVault(146, MOCKS.fluidVault)).wait();
  console.log(`       ✅ FluidVaultFactory: ${MOCKS.fluidVaultFactory}`);

  // 0o. MockSkyPSM (USDC <-> USDS)
  console.log("  [0o] MockSkyPSM...");
  const MockSkyPSM = await ethers.getContractFactory("MockSkyPSM");
  const skyPsm = await MockSkyPSM.deploy(usdc, MOCKS.usds);
  await skyPsm.waitForDeployment();
  MOCKS.skyPsm = await skyPsm.getAddress();
  console.log(`       ✅ SkyPSM: ${MOCKS.skyPsm}`);

  // 0p. MockSUSDS (sUSDS savings vault)
  console.log("  [0p] MockSUSDS...");
  const MockSUSDS = await ethers.getContractFactory("MockSUSDS");
  const sUsds = await MockSUSDS.deploy(MOCKS.usds);
  await sUsds.waitForDeployment();
  MOCKS.sUsds = await sUsds.getAddress();
  console.log(`       ✅ sUSDS: ${MOCKS.sUsds}`);

  console.log();
  console.log(`  ✅ Phase 0 complete — all ${Object.keys(MOCKS).length} mock entries populated`);
  console.log();
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

  console.log("═".repeat(70));
  console.log("  MINTED mUSD — Strategy Deployment (Devnet) — RESUME");
  console.log("═".repeat(70));
  console.log(`  Deployer:  ${deployer.address}`);
  const startBalance = ethers.formatEther(await ethers.provider.getBalance(deployer.address));
  console.log(`  Balance:   ${startBalance} ETH`);
  console.log(`  Network:   ${(await ethers.provider.getNetwork()).name}`);
  console.log();

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 0: All mocks already deployed — skip
  // ═══════════════════════════════════════════════════════════════════
  console.log("  All mock infrastructure already deployed ✅");
  console.log(`  Mock contracts: ${Object.keys(MOCKS).length} entries`);
  console.log();

  const results: Record<string, string> = { ...ALREADY_DEPLOYED };

  // ═══════════════════════════════════════════════════════════════════
  // 1. PendleMarketSelector — ALREADY DEPLOYED
  // ═══════════════════════════════════════════════════════════════════
  console.log(`[1/8] PendleMarketSelector — already deployed: ${results.PendleMarketSelector} ✅`);

  // ═══════════════════════════════════════════════════════════════════
  // 2. PendleStrategyV2 — ALREADY DEPLOYED
  // ═══════════════════════════════════════════════════════════════════
  results.PendleStrategyV2 = "0x8C952A04C45f0DCF6711DaC320f8cc3797d5c818";
  console.log(`[2/8] PendleStrategyV2 — already deployed: ${results.PendleStrategyV2} ✅`);
  const pendleStrategy = await ethers.getContractAt("PendleStrategyV2", results.PendleStrategyV2);

  // ═══════════════════════════════════════════════════════════════════
  // 3. MorphoLoopStrategy (UUPS proxy)
  // ═══════════════════════════════════════════════════════════════════
  await wait(5000); // let mempool clear
  console.log("[3/8] Deploying MorphoLoopStrategy...");
  const MorphoLoop = await ethers.getContractFactory("MorphoLoopStrategy");
  const morphoLoop = await upgrades.deployProxy(
    MorphoLoop,
    [
      CORE.usdcAddress,
      MOCKS.morphoBlue,
      MOCKS.morphoMarketId,
      CORE.treasuryV2Address,
      deployer.address,
      CORE.timelockAddress,
    ],
    { kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"] }
  );
  await morphoLoop.waitForDeployment();
  results.MorphoLoopStrategy = await morphoLoop.getAddress();
  console.log(`  ✅ MorphoLoopStrategy: ${results.MorphoLoopStrategy}`);

  // ═══════════════════════════════════════════════════════════════════
  // 4. SkySUSDSStrategy (UUPS proxy)
  // ═══════════════════════════════════════════════════════════════════
  await wait(5000);
  console.log("[4/8] Deploying SkySUSDSStrategy...");
  const SkySUSDS = await ethers.getContractFactory("SkySUSDSStrategy");
  const skySusds = await upgrades.deployProxy(
    SkySUSDS,
    [
      CORE.usdcAddress,
      MOCKS.usds,
      MOCKS.skyPsm,
      MOCKS.sUsds,
      CORE.treasuryV2Address,
      deployer.address,
      CORE.timelockAddress,
    ],
    { kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"] }
  );
  await skySusds.waitForDeployment();
  results.SkySUSDSStrategy = await skySusds.getAddress();
  console.log(`  ✅ SkySUSDSStrategy: ${results.SkySUSDSStrategy}`);

  // ═══════════════════════════════════════════════════════════════════
  // 5. FluidLoopStrategy (UUPS proxy)
  // ═══════════════════════════════════════════════════════════════════
  await wait(5000);
  console.log("[5/8] Deploying FluidLoopStrategy...");
  const FluidLoop = await ethers.getContractFactory("FluidLoopStrategy");
  const fluidLoop = await upgrades.deployProxy(
    FluidLoop,
    [{
      mode: 1, // MODE_STABLE
      inputAsset: CORE.usdcAddress,
      supplyToken: CORE.usdcAddress,
      borrowToken: CORE.usdcAddress,
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
      treasury: CORE.treasuryV2Address,
      admin: deployer.address,
      timelock: CORE.timelockAddress,
    }],
    { kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"] }
  );
  await fluidLoop.waitForDeployment();
  results.FluidLoopStrategy = await fluidLoop.getAddress();
  console.log(`  ✅ FluidLoopStrategy: ${results.FluidLoopStrategy}`);

  // ═══════════════════════════════════════════════════════════════════
  // 6. EulerV2LoopStrategy (UUPS proxy)
  // ═══════════════════════════════════════════════════════════════════
  await wait(5000);
  console.log("[6/8] Deploying EulerV2LoopStrategy...");
  const EulerLoop = await ethers.getContractFactory("EulerV2LoopStrategy");
  const eulerLoop = await upgrades.deployProxy(
    EulerLoop,
    [
      CORE.usdcAddress,
      MOCKS.eulerSupplyVaultUsdc,
      MOCKS.eulerBorrowVaultUsdc,
      MOCKS.evc,
      MOCKS.aaveV3Pool,
      MOCKS.merklDistributor,
      MOCKS.swapRouter,
      CORE.treasuryV2Address,
      deployer.address,
      CORE.timelockAddress,
    ],
    { kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"] }
  );
  await eulerLoop.waitForDeployment();
  results.EulerV2LoopStrategy = await eulerLoop.getAddress();
  console.log(`  ✅ EulerV2LoopStrategy: ${results.EulerV2LoopStrategy}`);

  // Setup EVC
  console.log("  → Setting up EVC for EulerV2LoopStrategy...");
  await (await eulerLoop.setupEVC()).wait();
  console.log("    ✅ EVC configured");

  // ═══════════════════════════════════════════════════════════════════
  // 7. EulerV2CrossStableLoopStrategy (UUPS proxy)
  // ═══════════════════════════════════════════════════════════════════
  await wait(5000);
  console.log("[7/8] Deploying EulerV2CrossStableLoopStrategy...");
  const EulerCrossStable = await ethers.getContractFactory("EulerV2CrossStableLoopStrategy");
  const eulerCrossStable = await upgrades.deployProxy(
    EulerCrossStable,
    [{
      usdc: CORE.usdcAddress,
      rlusd: MOCKS.rlusd,
      supplyVault: MOCKS.eulerSupplyVaultRlusd,
      borrowVault: MOCKS.eulerBorrowVaultUsdcCross,
      evc: MOCKS.evc,
      flashLoanPool: MOCKS.aaveV3Pool,
      merklDistributor: MOCKS.merklDistributor,
      swapRouter: MOCKS.swapRouter,
      rlusdPriceFeed: MOCKS.rlusdPriceFeed,
      treasury: CORE.treasuryV2Address,
      admin: deployer.address,
      timelock: CORE.timelockAddress,
    }],
    { kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"] }
  );
  await eulerCrossStable.waitForDeployment();
  results.EulerV2CrossStableLoopStrategy = await eulerCrossStable.getAddress();
  console.log(`  ✅ EulerV2CrossStableLoopStrategy: ${results.EulerV2CrossStableLoopStrategy}`);

  // Setup EVC
  console.log("  → Setting up EVC for EulerV2CrossStableLoopStrategy...");
  await (await eulerCrossStable.setupEVC()).wait();
  console.log("    ✅ EVC configured");

  // ═══════════════════════════════════════════════════════════════════
  // 8. MetaVault (UUPS proxy)
  // ═══════════════════════════════════════════════════════════════════
  await wait(5000);
  console.log("[8/8] Deploying MetaVault...");
  const MetaVault = await ethers.getContractFactory("contracts/strategies/MetaVault.sol:MetaVault");
  const metaVault = await upgrades.deployProxy(
    MetaVault,
    [
      CORE.usdcAddress,
      CORE.treasuryV2Address,
      deployer.address,
      CORE.timelockAddress,
    ],
    { kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"] }
  );
  await metaVault.waitForDeployment();
  results.MetaVault = await metaVault.getAddress();
  console.log(`  ✅ MetaVault: ${results.MetaVault}`);

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 9: ROLE CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n" + "─".repeat(70));
  console.log("  PHASE 9: Role Configuration");
  console.log("─".repeat(70));

  const strategiesWithTreasuryRole = [
    { name: "PendleStrategyV2", contract: pendleStrategy },
    { name: "MorphoLoopStrategy", contract: morphoLoop },
    { name: "SkySUSDSStrategy", contract: skySusds },
    { name: "FluidLoopStrategy", contract: fluidLoop },
    { name: "EulerV2LoopStrategy", contract: eulerLoop },
    { name: "EulerV2CrossStableLoopStrategy", contract: eulerCrossStable },
    { name: "MetaVault", contract: metaVault },
  ];

  for (const { name, contract } of strategiesWithTreasuryRole) {
    try {
      const TREASURY_ROLE = await contract.TREASURY_ROLE();
      const hasTreasuryRole = await contract.hasRole(TREASURY_ROLE, CORE.treasuryV2Address);
      if (!hasTreasuryRole) {
        await (await contract.grantRole(TREASURY_ROLE, CORE.treasuryV2Address)).wait();
        console.log(`    ${name}: TREASURY_ROLE → TreasuryV2 ✅`);
      } else {
        console.log(`    ${name}: TREASURY_ROLE already set ✅`);
      }
    } catch (e: any) {
      console.log(`    ${name}: TREASURY_ROLE grant failed — ${e.message?.slice(0, 80)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 10: STRATEGY REGISTRATION WITH TREASURYV2
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n" + "─".repeat(70));
  console.log("  PHASE 10: Register Strategies with TreasuryV2");
  console.log("─".repeat(70));

  const treasury = await ethers.getContractAt("TreasuryV2", CORE.treasuryV2Address);
  const registrations = [
    // name, contract, targetBps, minBps, maxBps, autoAllocate
    { name: "MetaVault",                 addr: results["MetaVault"],                 target: 3000, min: 1000, max: 5000, auto: true },
    { name: "MorphoLoopStrategy",        addr: results["MorphoLoopStrategy"],        target: 1500, min: 500,  max: 2500, auto: false },
    { name: "SkySUSDSStrategy",          addr: results["SkySUSDSStrategy"],          target: 1500, min: 500,  max: 2500, auto: false },
    { name: "FluidLoopStrategy",         addr: results["FluidLoopStrategy"],         target: 1000, min: 300,  max: 2000, auto: false },
    { name: "PendleStrategyV2",          addr: results["PendleStrategyV2"],          target: 1000, min: 500,  max: 1500, auto: false },
    { name: "EulerV2LoopStrategy",       addr: results["EulerV2LoopStrategy"],       target: 500,  min: 200,  max: 800,  auto: false },
    { name: "EulerV2CrossStableLoop",    addr: results["EulerV2CrossStableLoopStrategy"], target: 500,  min: 200,  max: 800,  auto: false },
  ];

  for (const r of registrations) {
    try {
      const isStrat = await treasury.isStrategy(r.addr);
      if (isStrat) {
        console.log(`    ${r.name}: already registered ✅`);
        continue;
      }
      const tx = await treasury.addStrategy(r.addr, r.target, r.min, r.max, r.auto);
      await tx.wait();
      console.log(`    ${r.name}: registered (${r.target}bps) ✅`);
    } catch (e: any) {
      console.log(`    ${r.name}: registration failed — ${e.message?.slice(0, 80)}`);
    }
  }
  const count = await treasury.strategyCount();
  console.log(`    Total strategies: ${count}`);

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 11: TIMELOCK_ROLE GOVERNANCE WIRING
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n" + "─".repeat(70));
  console.log("  PHASE 11: Wire TIMELOCK_ROLE → MintedTimelockController");
  console.log("─".repeat(70));

  const TIMELOCK_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TIMELOCK_ROLE"));
  const strategyContracts = [
    { name: "MorphoLoopStrategy",     addr: results["MorphoLoopStrategy"] },
    { name: "FluidLoopStrategy",      addr: results["FluidLoopStrategy"] },
    { name: "EulerV2LoopStrategy",    addr: results["EulerV2LoopStrategy"] },
    { name: "EulerV2CrossStableLoop", addr: results["EulerV2CrossStableLoopStrategy"] },
    { name: "MetaVault",              addr: results["MetaVault"] },
    { name: "SkySUSDSStrategy",       addr: results["SkySUSDSStrategy"] },
    { name: "TreasuryV2",            addr: CORE.treasuryV2Address },
  ];

  for (const { name, addr } of strategyContracts) {
    try {
      const c = await ethers.getContractAt("AccessControl", addr);
      const has = await c.hasRole(TIMELOCK_ROLE, CORE.timelockAddress);
      if (!has) {
        await (await c.grantRole(TIMELOCK_ROLE, CORE.timelockAddress)).wait();
        console.log(`    ${name}: TIMELOCK_ROLE → timelock ✅`);
      } else {
        console.log(`    ${name}: already wired ✅`);
      }
    } catch (e: any) {
      console.log(`    ${name}: failed — ${e.message?.slice(0, 80)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════
  const remaining = ethers.formatEther(await ethers.provider.getBalance(deployer.address));
  const gasUsed = (parseFloat(startBalance) - parseFloat(remaining)).toFixed(6);

  console.log("\n" + "═".repeat(70));
  console.log("  DEPLOYMENT COMPLETE");
  console.log("═".repeat(70));

  console.log("\n  ── Mock Infrastructure ──");
  for (const [name, addr] of Object.entries(MOCKS)) {
    console.log(`  ${name.padEnd(30)} ${addr}`);
  }

  console.log("\n  ── Strategy Proxies ──");
  for (const [name, addr] of Object.entries(results)) {
    console.log(`  ${name.padEnd(36)} ${addr}`);
  }

  console.log();
  console.log(`  Gas used:   ${gasUsed} ETH`);
  console.log(`  Remaining:  ${remaining} ETH`);
  console.log("═".repeat(70));

  console.log("\n// ── Mock addresses (JSON) ──");
  console.log(JSON.stringify(MOCKS, null, 2));
  console.log("\n// ── Strategy addresses (JSON) ──");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
