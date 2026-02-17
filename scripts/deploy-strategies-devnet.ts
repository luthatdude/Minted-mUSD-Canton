import { ethers, upgrades } from "hardhat";

/**
 * Deploy All 8 Strategy Contracts to Devnet/Sepolia
 *
 * Contracts:
 *   1. PendleMarketSelector (UUPS proxy)
 *   2. PendleStrategyV2 (UUPS proxy)
 *   3. MorphoLoopStrategy (UUPS proxy)
 *   4. SkySUSDSStrategy (UUPS proxy)
 *   5. FluidLoopStrategy (UUPS proxy)
 *   6. EulerV2LoopStrategy (UUPS proxy)
 *   7. EulerV2CrossStableLoopStrategy (UUPS proxy)
 *   8. MetaVault (UUPS proxy)
 *
 * Prerequisites:
 *   - Core protocol deployed (TreasuryV2, MUSD, PriceOracle, etc.)
 *   - USDC token address available
 *   - External protocol addresses available (Morpho, Euler, Pendle, Fluid, Sky)
 *
 * Usage:
 *   npx hardhat run scripts/deploy-strategies-devnet.ts --network sepolia
 */

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION — Update these for your target network
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  // Already deployed core protocol
  timelockAddress: "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410",
  treasuryV2Address: "0xf2051bDfc738f638668DF2f8c00d01ba6338C513",
  usdcAddress: "0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474", // MockUSDC on Sepolia

  // External protocol addresses (Sepolia/devnet — use deployer address as placeholder if not available)
  // These MUST be updated to real addresses before mainnet deployment
  morpho: {
    blueAddress: ethers.ZeroAddress, // Morpho Blue on Sepolia (set before deploy)
    marketId: ethers.ZeroHash,       // Target market ID (set before deploy)
  },
  euler: {
    supplyVaultUsdc: ethers.ZeroAddress,    // Euler V2 USDC supply vault
    borrowVaultUsdc: ethers.ZeroAddress,    // Euler V2 USDC borrow vault
    evc: ethers.ZeroAddress,               // Euler V2 EVC
    // Cross-stable (RLUSD/USDC)
    rlusd: ethers.ZeroAddress,             // RLUSD token
    supplyVaultRlusd: ethers.ZeroAddress,  // Euler V2 RLUSD supply vault
    borrowVaultUsdcCross: ethers.ZeroAddress, // Euler V2 USDC borrow vault (cross)
    rlusdPriceFeed: ethers.ZeroAddress,    // Chainlink RLUSD/USD feed
  },
  pendle: {
    // PendleStrategyV2 has no Pendle router dependency at init — it uses market selector
  },
  fluid: {
    fluidVault: ethers.ZeroAddress,    // Fluid vault address
    vaultFactory: ethers.ZeroAddress,  // Fluid VaultFactory
    vaultResolver: ethers.ZeroAddress, // Fluid VaultResolver
    dexResolver: ethers.ZeroAddress,   // Fluid DexResolver
    dexPool: ethers.ZeroAddress,       // Fluid DEX pool
    supplyToken: ethers.ZeroAddress,   // Supply token (e.g., USDC)
    borrowToken: ethers.ZeroAddress,   // Borrow token (e.g., USDC)
  },
  sky: {
    usds: ethers.ZeroAddress,  // USDS token
    psm: ethers.ZeroAddress,   // Sky PSM
    sUsds: ethers.ZeroAddress, // sUSDS savings vault
  },

  // Shared infrastructure
  aaveV3Pool: ethers.ZeroAddress,      // AAVE V3 Pool for flash loans
  merklDistributor: ethers.ZeroAddress, // Merkl Distributor
  swapRouter: ethers.ZeroAddress,      // Uniswap V3 SwapRouter
};

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("═".repeat(70));
  console.log("  MINTED mUSD — Strategy Deployment (Devnet)");
  console.log("═".repeat(70));
  console.log(`  Deployer:  ${deployer.address}`);
  const startBalance = ethers.formatEther(await ethers.provider.getBalance(deployer.address));
  console.log(`  Balance:   ${startBalance} ETH`);
  console.log(`  Network:   ${(await ethers.provider.getNetwork()).name}`);
  console.log();

  // Use deployer as placeholder for zero addresses (devnet only)
  const placeholder = deployer.address;
  const resolve = (addr: string) => addr === ethers.ZeroAddress ? placeholder : addr;

  const results: Record<string, string> = {};

  // ═══════════════════════════════════════════════════════════════════
  // 1. PendleMarketSelector (UUPS proxy)
  // ═══════════════════════════════════════════════════════════════════
  console.log("[1/8] Deploying PendleMarketSelector...");
  const MarketSelector = await ethers.getContractFactory("PendleMarketSelector");
  const marketSelector = await upgrades.deployProxy(
    MarketSelector,
    [deployer.address, CONFIG.timelockAddress],
    { kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"] }
  );
  await marketSelector.waitForDeployment();
  results.PendleMarketSelector = await marketSelector.getAddress();
  console.log(`  ✅ PendleMarketSelector: ${results.PendleMarketSelector}`);

  // ═══════════════════════════════════════════════════════════════════
  // 2. PendleStrategyV2 (UUPS proxy)
  // ═══════════════════════════════════════════════════════════════════
  console.log("[2/8] Deploying PendleStrategyV2...");
  const PendleStrategy = await ethers.getContractFactory("PendleStrategyV2");
  const pendleStrategy = await upgrades.deployProxy(
    PendleStrategy,
    [
      CONFIG.usdcAddress,
      results.PendleMarketSelector,
      CONFIG.treasuryV2Address,
      deployer.address,
      "stablecoin",
      CONFIG.timelockAddress,
    ],
    { kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"] }
  );
  await pendleStrategy.waitForDeployment();
  results.PendleStrategyV2 = await pendleStrategy.getAddress();
  console.log(`  ✅ PendleStrategyV2: ${results.PendleStrategyV2}`);

  // ═══════════════════════════════════════════════════════════════════
  // 3. MorphoLoopStrategy (UUPS proxy)
  // ═══════════════════════════════════════════════════════════════════
  console.log("[3/8] Deploying MorphoLoopStrategy...");
  const MorphoLoop = await ethers.getContractFactory("MorphoLoopStrategy");
  const morphoLoop = await upgrades.deployProxy(
    MorphoLoop,
    [
      CONFIG.usdcAddress,
      resolve(CONFIG.morpho.blueAddress),
      CONFIG.morpho.marketId,
      CONFIG.treasuryV2Address,
      deployer.address,
      CONFIG.timelockAddress,
    ],
    { kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"] }
  );
  await morphoLoop.waitForDeployment();
  results.MorphoLoopStrategy = await morphoLoop.getAddress();
  console.log(`  ✅ MorphoLoopStrategy: ${results.MorphoLoopStrategy}`);

  // ═══════════════════════════════════════════════════════════════════
  // 4. SkySUSDSStrategy (UUPS proxy)
  // ═══════════════════════════════════════════════════════════════════
  console.log("[4/8] Deploying SkySUSDSStrategy...");
  const SkySUSDS = await ethers.getContractFactory("SkySUSDSStrategy");
  const skySusds = await upgrades.deployProxy(
    SkySUSDS,
    [
      CONFIG.usdcAddress,
      resolve(CONFIG.sky.usds),
      resolve(CONFIG.sky.psm),
      resolve(CONFIG.sky.sUsds),
      CONFIG.treasuryV2Address,
      deployer.address,
      CONFIG.timelockAddress,
    ],
    { kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"] }
  );
  await skySusds.waitForDeployment();
  results.SkySUSDSStrategy = await skySusds.getAddress();
  console.log(`  ✅ SkySUSDSStrategy: ${results.SkySUSDSStrategy}`);

  // ═══════════════════════════════════════════════════════════════════
  // 5. FluidLoopStrategy (UUPS proxy)
  // ═══════════════════════════════════════════════════════════════════
  console.log("[5/8] Deploying FluidLoopStrategy...");
  const FluidLoop = await ethers.getContractFactory("FluidLoopStrategy");
  const fluidLoop = await upgrades.deployProxy(
    FluidLoop,
    [{
      mode: 1, // MODE_STABLE
      inputAsset: CONFIG.usdcAddress,
      supplyToken: resolve(CONFIG.fluid.supplyToken) || CONFIG.usdcAddress,
      borrowToken: resolve(CONFIG.fluid.borrowToken) || CONFIG.usdcAddress,
      supplyToken1: ethers.ZeroAddress,
      borrowToken1: ethers.ZeroAddress,
      fluidVault: resolve(CONFIG.fluid.fluidVault),
      vaultFactory: resolve(CONFIG.fluid.vaultFactory),
      flashLoanPool: resolve(CONFIG.aaveV3Pool),
      merklDistributor: resolve(CONFIG.merklDistributor),
      swapRouter: resolve(CONFIG.swapRouter),
      vaultResolver: CONFIG.fluid.vaultResolver, // Can be zero
      dexResolver: CONFIG.fluid.dexResolver,     // Can be zero
      dexPool: CONFIG.fluid.dexPool,             // Can be zero
      treasury: CONFIG.treasuryV2Address,
      admin: deployer.address,
      timelock: CONFIG.timelockAddress,
    }],
    { kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"] }
  );
  await fluidLoop.waitForDeployment();
  results.FluidLoopStrategy = await fluidLoop.getAddress();
  console.log(`  ✅ FluidLoopStrategy: ${results.FluidLoopStrategy}`);

  // ═══════════════════════════════════════════════════════════════════
  // 6. EulerV2LoopStrategy (UUPS proxy)
  // ═══════════════════════════════════════════════════════════════════
  console.log("[6/8] Deploying EulerV2LoopStrategy...");
  const EulerLoop = await ethers.getContractFactory("EulerV2LoopStrategy");
  const eulerLoop = await upgrades.deployProxy(
    EulerLoop,
    [
      CONFIG.usdcAddress,
      resolve(CONFIG.euler.supplyVaultUsdc),
      resolve(CONFIG.euler.borrowVaultUsdc),
      resolve(CONFIG.euler.evc),
      resolve(CONFIG.aaveV3Pool),
      resolve(CONFIG.merklDistributor),
      resolve(CONFIG.swapRouter),
      CONFIG.treasuryV2Address,
      deployer.address,
      CONFIG.timelockAddress,
    ],
    { kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"] }
  );
  await eulerLoop.waitForDeployment();
  results.EulerV2LoopStrategy = await eulerLoop.getAddress();
  console.log(`  ✅ EulerV2LoopStrategy: ${results.EulerV2LoopStrategy}`);

  // Setup EVC
  console.log("  → Setting up EVC for EulerV2LoopStrategy...");
  await (await eulerLoop.setupEVC()).wait();

  // ═══════════════════════════════════════════════════════════════════
  // 7. EulerV2CrossStableLoopStrategy (UUPS proxy)
  // ═══════════════════════════════════════════════════════════════════
  console.log("[7/8] Deploying EulerV2CrossStableLoopStrategy...");
  const EulerCrossStable = await ethers.getContractFactory("EulerV2CrossStableLoopStrategy");
  const eulerCrossStable = await upgrades.deployProxy(
    EulerCrossStable,
    [{
      usdc: CONFIG.usdcAddress,
      rlusd: resolve(CONFIG.euler.rlusd),
      supplyVault: resolve(CONFIG.euler.supplyVaultRlusd),
      borrowVault: resolve(CONFIG.euler.borrowVaultUsdcCross),
      evc: resolve(CONFIG.euler.evc),
      flashLoanPool: resolve(CONFIG.aaveV3Pool),
      merklDistributor: resolve(CONFIG.merklDistributor),
      swapRouter: resolve(CONFIG.swapRouter),
      rlusdPriceFeed: resolve(CONFIG.euler.rlusdPriceFeed),
      treasury: CONFIG.treasuryV2Address,
      admin: deployer.address,
      timelock: CONFIG.timelockAddress,
    }],
    { kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"] }
  );
  await eulerCrossStable.waitForDeployment();
  results.EulerV2CrossStableLoopStrategy = await eulerCrossStable.getAddress();
  console.log(`  ✅ EulerV2CrossStableLoopStrategy: ${results.EulerV2CrossStableLoopStrategy}`);

  // Setup EVC
  console.log("  → Setting up EVC for EulerV2CrossStableLoopStrategy...");
  await (await eulerCrossStable.setupEVC()).wait();

  // ═══════════════════════════════════════════════════════════════════
  // 8. MetaVault (UUPS proxy) — vault-of-vaults aggregator
  // ═══════════════════════════════════════════════════════════════════
  console.log("[8/8] Deploying MetaVault...");
  const MetaVault = await ethers.getContractFactory("MetaVault");
  const metaVault = await upgrades.deployProxy(
    MetaVault,
    [
      CONFIG.usdcAddress,
      CONFIG.treasuryV2Address,
      deployer.address,
      CONFIG.timelockAddress,
    ],
    { kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"] }
  );
  await metaVault.waitForDeployment();
  results.MetaVault = await metaVault.getAddress();
  console.log(`  ✅ MetaVault: ${results.MetaVault}`);

  // ═══════════════════════════════════════════════════════════════════
  // ROLE CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n  Configuring roles...");

  // Grant TREASURY_ROLE on each strategy to TreasuryV2
  const strategiesWithTreasuryRole = [
    { name: "PendleStrategyV2", contract: pendleStrategy },
    { name: "MorphoLoopStrategy", contract: morphoLoop },
    { name: "SkySUSDSStrategy", contract: skySusds },
    { name: "FluidLoopStrategy", contract: fluidLoop },
    { name: "EulerV2LoopStrategy", contract: eulerLoop },
    { name: "EulerV2CrossStableLoopStrategy", contract: eulerCrossStable },
  ];

  for (const { name, contract } of strategiesWithTreasuryRole) {
    const TREASURY_ROLE = await contract.TREASURY_ROLE();
    const hasTreasuryRole = await contract.hasRole(TREASURY_ROLE, CONFIG.treasuryV2Address);
    if (!hasTreasuryRole) {
      await (await contract.grantRole(TREASURY_ROLE, CONFIG.treasuryV2Address)).wait();
      console.log(`    ${name}: TREASURY_ROLE → TreasuryV2`);
    }
  }

  // Grant TREASURY_ROLE on MetaVault to TreasuryV2
  {
    const TREASURY_ROLE = await metaVault.TREASURY_ROLE();
    await (await metaVault.grantRole(TREASURY_ROLE, CONFIG.treasuryV2Address)).wait();
    console.log("    MetaVault: TREASURY_ROLE → TreasuryV2");
  }

  // ═══════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════
  const remaining = ethers.formatEther(await ethers.provider.getBalance(deployer.address));
  const gasUsed = (parseFloat(startBalance) - parseFloat(remaining)).toFixed(6);

  console.log("\n" + "═".repeat(70));
  console.log("  STRATEGY DEPLOYMENT COMPLETE");
  console.log("═".repeat(70));
  console.log();
  for (const [name, addr] of Object.entries(results)) {
    console.log(`  ${name.padEnd(36)} ${addr}`);
  }
  console.log();
  console.log(`  Gas used:   ${gasUsed} ETH`);
  console.log(`  Remaining:  ${remaining} ETH`);
  console.log("═".repeat(70));

  // Output JSON for programmatic use
  console.log("\n// Copy for deployment config:");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
