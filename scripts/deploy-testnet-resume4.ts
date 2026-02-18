import { ethers, upgrades } from "hardhat";

/**
 * Testnet deployment RESUME #4 — Remaining Contracts
 *
 * Deploys the 15 contracts NOT yet on Sepolia, in dependency order:
 *
 * TIER 1 (zero deps):
 *   13. SMUSDE               — ETH Pool staked token
 *   14. PriceAggregator       — UUPS proxy, multi-source oracle aggregator
 *   15. API3OracleAdapter     — UUPS proxy
 *   16. ChainlinkOracleAdapter — UUPS proxy
 *   17. YieldScanner          — DeFi yield aggregator (view-only)
 *   18. YieldVerifier         — Yield verification layer
 *
 * TIER 2 (depend on deployed contracts):
 *   19. MorphoMarketRegistry  — on-chain Morpho market reader
 *   20. ERC4626Adapter (Sky)  — yield adapter for Sky sUSDS
 *   21. ERC4626Adapter (Ethena) — yield adapter for Ethena sUSDe
 *   22. MorphoBlueAdapter     — yield adapter for Morpho Blue
 *   23. SMUSDPriceAdapter     — Chainlink-compatible smUSD price feed
 *   24. RedemptionQueue       — FIFO mUSD→USDC redemption queue
 *   25. ETHPoolYieldDistributor — harvests MetaVault #3 yield
 *   26. YieldDistributor      — proportional yield distribution to pools
 *
 * TIER 3 (depend on Tier 1):
 *   27. ETHPool               — multi-asset staking pool
 *   28. UniswapV3TWAPOracle   — TWAP validator for LeverageVault
 *
 * ROLE GRANTS (Phase 4):
 *   - Cross-contract role grants for the full system to function
 *
 * Prerequisites:
 *   - Steps 0–12 deployed (deploy-testnet.ts + resume scripts)
 *   - Deployer wallet with sufficient Sepolia ETH (~0.5 ETH)
 *
 * Run:
 *   npx hardhat run scripts/deploy-testnet-resume4.ts --network sepolia
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Minted Protocol — Sepolia Deployment Resume #4");
  console.log("  Deploying 15 remaining contracts + role grants");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("Deployer:", deployer.address);
  const bal = ethers.formatEther(await ethers.provider.getBalance(deployer.address));
  console.log("Balance:", bal, "ETH");
  if (parseFloat(bal) < 0.05) throw new Error("Need ≥ 0.05 Sepolia ETH");

  // ═══════════════════════════════════════════════════════════════
  // ALREADY DEPLOYED — from previous scripts
  // ═══════════════════════════════════════════════════════════════
  const DEPLOYED = {
    globalPauseRegistry: "0x471e9dceB2AB7398b63677C70c6C638c7AEA375F",
    timelock:            "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410",
    musd:                "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B",
    priceOracle:         "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025",
    interestRateModel:   "0x501265BeF81E6E96e4150661e2b9278272e9177B",
    collateralVault:     "0x155d6618dcdeb2F4145395CA57C80e6931D7941e",
    borrowModule:        "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8",
    smusd:               "0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540",
    liquidationEngine:   "0xbaf131Ee1AfdA4207f669DCd9F94634131D111f8",
    directMintV2:        "0xaA3e42f2AfB5DF83d6a33746c2927bce8B22Bae7",
    treasuryV2:          "0xf2051bDfc738f638668DF2f8c00d01ba6338C513",
    bleBridgeV9:         "0x708957bFfA312D1730BdF87467E695D3a9F26b0f",
    leverageVault:       "0x3b49d47f9714836F2aF21F13cdF79aafd75f1FE4",
    depositRouter:       "0x531e95585bcDfcB2303511483F232EEF4a0Cd2de",
    mockUSDC:            "0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474",
    mockWETH:            "0x7999F2894290F2Ce34a508eeff776126D9a7D46e",
    metaVault:           "0xb35Aced17eF8370cbe720d2B56d2273aB6BB12A6",
    mockMorphoBlue:      "0x737Da1acFC41f8A206356d7F8fB0d2f00b633B26",
  };

  // Helper to get contract instances for role grants
  const getContract = async (name: string, addr: string) =>
    (await ethers.getContractFactory(name)).attach(addr);

  // ═══════════════════════════════════════════════════════════════
  // TIER 1 — Zero dependency contracts
  // ═══════════════════════════════════════════════════════════════

  // ─── 13. SMUSDE (smUSD-E) ───
  console.log("\n[13/28] Deploying SMUSDE...");
  const SMUSDEFactory = await ethers.getContractFactory("SMUSDE");
  const smusde = await SMUSDEFactory.deploy();
  await smusde.waitForDeployment();
  const smusdeAddress = await smusde.getAddress();
  console.log("SMUSDE:", smusdeAddress);

  // ─── 14. PriceAggregator (UUPS proxy) ───
  console.log("\n[14/28] Deploying PriceAggregator (UUPS proxy)...");
  const PriceAggFactory = await ethers.getContractFactory("PriceAggregator");
  const priceAgg = await upgrades.deployProxy(
    PriceAggFactory,
    [deployer.address, DEPLOYED.timelock],
    { kind: "uups" }
  );
  await priceAgg.waitForDeployment();
  const priceAggAddress = await priceAgg.getAddress();
  console.log("PriceAggregator:", priceAggAddress);

  // ─── 15. API3OracleAdapter (UUPS proxy) ───
  console.log("\n[15/28] Deploying API3OracleAdapter (UUPS proxy)...");
  const API3Factory = await ethers.getContractFactory("API3OracleAdapter");
  const api3Adapter = await upgrades.deployProxy(
    API3Factory,
    [deployer.address, DEPLOYED.timelock],
    { kind: "uups" }
  );
  await api3Adapter.waitForDeployment();
  const api3AdapterAddress = await api3Adapter.getAddress();
  console.log("API3OracleAdapter:", api3AdapterAddress);

  // ─── 16. ChainlinkOracleAdapter (UUPS proxy) ───
  console.log("\n[16/28] Deploying ChainlinkOracleAdapter (UUPS proxy)...");
  const CLFactory = await ethers.getContractFactory("ChainlinkOracleAdapter");
  const clAdapter = await upgrades.deployProxy(
    CLFactory,
    [deployer.address, DEPLOYED.timelock],
    { kind: "uups" }
  );
  await clAdapter.waitForDeployment();
  const clAdapterAddress = await clAdapter.getAddress();
  console.log("ChainlinkOracleAdapter:", clAdapterAddress);

  // ─── 17. YieldScanner ───
  console.log("\n[17/28] Deploying YieldScanner...");
  const YieldScannerFactory = await ethers.getContractFactory("YieldScanner");
  const yieldScanner = await YieldScannerFactory.deploy(deployer.address, DEPLOYED.mockUSDC);
  await yieldScanner.waitForDeployment();
  const yieldScannerAddress = await yieldScanner.getAddress();
  console.log("YieldScanner:", yieldScannerAddress);

  // ─── 18. YieldVerifier ───
  console.log("\n[18/28] Deploying YieldVerifier...");
  const YieldVerifierFactory = await ethers.getContractFactory("YieldVerifier");
  const yieldVerifier = await YieldVerifierFactory.deploy(deployer.address);
  await yieldVerifier.waitForDeployment();
  const yieldVerifierAddress = await yieldVerifier.getAddress();
  console.log("YieldVerifier:", yieldVerifierAddress);

  // ═══════════════════════════════════════════════════════════════
  // TIER 2 — Depends on deployed contracts
  // ═══════════════════════════════════════════════════════════════

  // ─── 19. MorphoMarketRegistry ───
  console.log("\n[19/28] Deploying MorphoMarketRegistry...");
  const MorphoRegFactory = await ethers.getContractFactory("MorphoMarketRegistry");
  const morphoRegistry = await MorphoRegFactory.deploy(DEPLOYED.mockMorphoBlue, deployer.address);
  await morphoRegistry.waitForDeployment();
  const morphoRegistryAddress = await morphoRegistry.getAddress();
  console.log("MorphoMarketRegistry:", morphoRegistryAddress);

  // ─── 20. ERC4626Adapter (Sky sUSDS — protoId=4) ───
  console.log("\n[20/28] Deploying ERC4626Adapter (Sky sUSDS)...");
  const ERC4626Factory = await ethers.getContractFactory("ERC4626Adapter");
  const skyAdapter = await ERC4626Factory.deploy(4, "Sky sUSDS");
  await skyAdapter.waitForDeployment();
  const skyAdapterAddress = await skyAdapter.getAddress();
  console.log("ERC4626Adapter (Sky):", skyAdapterAddress);

  // ─── 21. ERC4626Adapter (Ethena sUSDe — protoId=5) ───
  console.log("\n[21/28] Deploying ERC4626Adapter (Ethena sUSDe)...");
  const ethenaAdapter = await ERC4626Factory.deploy(5, "Ethena sUSDe");
  await ethenaAdapter.waitForDeployment();
  const ethenaAdapterAddress = await ethenaAdapter.getAddress();
  console.log("ERC4626Adapter (Ethena):", ethenaAdapterAddress);

  // ─── 22. MorphoBlueAdapter ───
  console.log("\n[22/28] Deploying MorphoBlueAdapter...");
  const MorphoAdapterFactory = await ethers.getContractFactory("MorphoBlueAdapter");
  const morphoAdapter = await MorphoAdapterFactory.deploy();
  await morphoAdapter.waitForDeployment();
  const morphoAdapterAddress = await morphoAdapter.getAddress();
  console.log("MorphoBlueAdapter:", morphoAdapterAddress);

  // ─── 23. SMUSDPriceAdapter ───
  console.log("\n[23/28] Deploying SMUSDPriceAdapter...");
  const SMUSDPriceFactory = await ethers.getContractFactory("SMUSDPriceAdapter");
  const smusdPriceAdapter = await SMUSDPriceFactory.deploy(
    DEPLOYED.smusd,
    deployer.address,
    DEPLOYED.timelock
  );
  await smusdPriceAdapter.waitForDeployment();
  const smusdPriceAdapterAddress = await smusdPriceAdapter.getAddress();
  console.log("SMUSDPriceAdapter:", smusdPriceAdapterAddress);

  // ─── 24. RedemptionQueue ───
  console.log("\n[24/28] Deploying RedemptionQueue...");
  const MAX_DAILY_REDEMPTION = ethers.parseUnits("500000", 6); // $500K/day
  const MIN_REQUEST_AGE = 3600; // 1 hour minimum wait
  const RedemptionQueueFactory = await ethers.getContractFactory("RedemptionQueue");
  const redemptionQueue = await RedemptionQueueFactory.deploy(
    DEPLOYED.musd,
    DEPLOYED.mockUSDC,
    MAX_DAILY_REDEMPTION,
    MIN_REQUEST_AGE
  );
  await redemptionQueue.waitForDeployment();
  const redemptionQueueAddress = await redemptionQueue.getAddress();
  console.log("RedemptionQueue:", redemptionQueueAddress);

  // ─── 25. ETHPoolYieldDistributor ───
  console.log("\n[25/28] Deploying ETHPoolYieldDistributor...");
  const ETHPoolYDFactory = await ethers.getContractFactory("ETHPoolYieldDistributor");
  const ethPoolYD = await ETHPoolYDFactory.deploy(
    DEPLOYED.musd,
    DEPLOYED.bleBridgeV9,
    DEPLOYED.metaVault, // MetaVault #3 (using our single deployed MetaVault)
    deployer.address,
    DEPLOYED.timelock
  );
  await ethPoolYD.waitForDeployment();
  const ethPoolYDAddress = await ethPoolYD.getAddress();
  console.log("ETHPoolYieldDistributor:", ethPoolYDAddress);

  // ─── 26. YieldDistributor ───
  console.log("\n[26/28] Deploying YieldDistributor...");
  const YieldDistFactory = await ethers.getContractFactory("YieldDistributor");
  const yieldDistributor = await YieldDistFactory.deploy(
    DEPLOYED.mockUSDC,
    DEPLOYED.musd,
    DEPLOYED.smusd,
    DEPLOYED.treasuryV2,
    DEPLOYED.bleBridgeV9,
    DEPLOYED.directMintV2,
    deployer.address
  );
  await yieldDistributor.waitForDeployment();
  const yieldDistributorAddress = await yieldDistributor.getAddress();
  console.log("YieldDistributor:", yieldDistributorAddress);

  // ═══════════════════════════════════════════════════════════════
  // TIER 3 — Depends on Tier 1
  // ═══════════════════════════════════════════════════════════════

  // ─── 27. ETHPool ───
  console.log("\n[27/28] Deploying ETHPool...");
  const POOL_CAP = ethers.parseEther("10000000"); // 10M mUSD cap
  const ETHPoolFactory = await ethers.getContractFactory("ETHPool");
  const ethPool = await ETHPoolFactory.deploy(
    DEPLOYED.musd,
    smusdeAddress,        // From Tier 1 step 13
    DEPLOYED.priceOracle,
    DEPLOYED.mockWETH,
    POOL_CAP
  );
  await ethPool.waitForDeployment();
  const ethPoolAddress = await ethPool.getAddress();
  console.log("ETHPool:", ethPoolAddress);

  // ─── 28. UniswapV3TWAPOracle ───
  // Sepolia UniswapV3Factory: 0x0227628f3F023bb0B980b67D528571c95c6DaC1c
  console.log("\n[28/28] Deploying UniswapV3TWAPOracle...");
  const UNISWAP_V3_FACTORY_SEPOLIA = "0x0227628f3F023bb0B980b67D528571c95c6DaC1c";
  const TWAPFactory = await ethers.getContractFactory("UniswapV3TWAPOracle");
  const twapOracle = await TWAPFactory.deploy(UNISWAP_V3_FACTORY_SEPOLIA);
  await twapOracle.waitForDeployment();
  const twapOracleAddress = await twapOracle.getAddress();
  console.log("UniswapV3TWAPOracle:", twapOracleAddress);

  // ═══════════════════════════════════════════════════════════════
  // PHASE 4 — Cross-contract role grants
  // ═══════════════════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Phase 4: Role Grants");
  console.log("═══════════════════════════════════════════════════════════");

  const musd = await getContract("MUSD", DEPLOYED.musd);
  const smusdContract = await getContract("SMUSD", DEPLOYED.smusd);
  const treasuryV2 = await getContract("TreasuryV2", DEPLOYED.treasuryV2);

  // RedemptionQueue needs BRIDGE_ROLE on MUSD (to burn mUSD for redemptions)
  console.log("\n  Granting BRIDGE_ROLE on MUSD → RedemptionQueue...");
  const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
  let tx = await musd.grantRole(BRIDGE_ROLE, redemptionQueueAddress);
  await tx.wait();
  console.log("  ✅ MUSD.BRIDGE_ROLE → RedemptionQueue");

  // ETHPoolYieldDistributor needs BRIDGE_ROLE on MUSD (to mint mUSD for yield)
  console.log("  Granting BRIDGE_ROLE on MUSD → ETHPoolYieldDistributor...");
  tx = await musd.grantRole(BRIDGE_ROLE, ethPoolYDAddress);
  await tx.wait();
  console.log("  ✅ MUSD.BRIDGE_ROLE → ETHPoolYieldDistributor");

  // ETHPool needs BRIDGE_ROLE on MUSD (to mint mUSD for deposits)
  console.log("  Granting BRIDGE_ROLE on MUSD → ETHPool...");
  tx = await musd.grantRole(BRIDGE_ROLE, ethPoolAddress);
  await tx.wait();
  console.log("  ✅ MUSD.BRIDGE_ROLE → ETHPool");

  // ETHPool needs POOL_ROLE on SMUSDE (to mint/burn smUSD-E)
  console.log("  Granting POOL_ROLE on SMUSDE → ETHPool...");
  const POOL_ROLE = await smusde.POOL_ROLE();
  tx = await smusde.grantRole(POOL_ROLE, ethPoolAddress);
  await tx.wait();
  console.log("  ✅ SMUSDE.POOL_ROLE → ETHPool");

  // YieldDistributor needs VAULT_ROLE on TreasuryV2 (to withdraw yield)
  console.log("  Granting VAULT_ROLE on TreasuryV2 → YieldDistributor...");
  const VAULT_ROLE = await treasuryV2.VAULT_ROLE();
  tx = await treasuryV2.grantRole(VAULT_ROLE, yieldDistributorAddress);
  await tx.wait();
  console.log("  ✅ TreasuryV2.VAULT_ROLE → YieldDistributor");

  // YieldDistributor needs YIELD_MANAGER_ROLE on SMUSD (to distribute yield)
  console.log("  Granting YIELD_MANAGER_ROLE on SMUSD → YieldDistributor...");
  const YIELD_MANAGER_ROLE = await smusdContract.YIELD_MANAGER_ROLE();
  tx = await smusdContract.grantRole(YIELD_MANAGER_ROLE, yieldDistributorAddress);
  await tx.wait();
  console.log("  ✅ SMUSD.YIELD_MANAGER_ROLE → YieldDistributor");

  // Register adapters in YieldVerifier
  console.log("\n  Registering adapters in YieldVerifier...");
  tx = await yieldVerifier.registerAdapter(4, skyAdapterAddress);      // Sky sUSDS
  await tx.wait();
  tx = await yieldVerifier.registerAdapter(5, ethenaAdapterAddress);   // Ethena sUSDe
  await tx.wait();
  tx = await yieldVerifier.registerAdapter(2, morphoAdapterAddress);   // Morpho Blue
  await tx.wait();
  console.log("  ✅ YieldVerifier: 3 adapters registered");

  // ETHPool: add stablecoins (USDC)
  console.log("  Adding USDC as stablecoin to ETHPool...");
  tx = await ethPool.addStablecoin(DEPLOYED.mockUSDC, 6);
  await tx.wait();
  console.log("  ✅ ETHPool: MockUSDC added (6 decimals)");

  // ═══════════════════════════════════════════════════════════════
  // DEPLOYMENT SUMMARY
  // ═══════════════════════════════════════════════════════════════
  const endBal = ethers.formatEther(await ethers.provider.getBalance(deployer.address));

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  DEPLOYMENT COMPLETE — 15 Contracts + Role Grants");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Gas spent: ${(parseFloat(bal) - parseFloat(endBal)).toFixed(6)} ETH`);
  console.log("\n  TIER 1:");
  console.log(`    SMUSDE:                  ${smusdeAddress}`);
  console.log(`    PriceAggregator:         ${priceAggAddress}`);
  console.log(`    API3OracleAdapter:       ${api3AdapterAddress}`);
  console.log(`    ChainlinkOracleAdapter:  ${clAdapterAddress}`);
  console.log(`    YieldScanner:            ${yieldScannerAddress}`);
  console.log(`    YieldVerifier:           ${yieldVerifierAddress}`);
  console.log("\n  TIER 2:");
  console.log(`    MorphoMarketRegistry:    ${morphoRegistryAddress}`);
  console.log(`    ERC4626Adapter (Sky):    ${skyAdapterAddress}`);
  console.log(`    ERC4626Adapter (Ethena): ${ethenaAdapterAddress}`);
  console.log(`    MorphoBlueAdapter:       ${morphoAdapterAddress}`);
  console.log(`    SMUSDPriceAdapter:       ${smusdPriceAdapterAddress}`);
  console.log(`    RedemptionQueue:         ${redemptionQueueAddress}`);
  console.log(`    ETHPoolYieldDistributor: ${ethPoolYDAddress}`);
  console.log(`    YieldDistributor:        ${yieldDistributorAddress}`);
  console.log("\n  TIER 3:");
  console.log(`    ETHPool:                 ${ethPoolAddress}`);
  console.log(`    UniswapV3TWAPOracle:     ${twapOracleAddress}`);
  console.log("\n  Role Grants:");
  console.log("    ✅ MUSD.BRIDGE_ROLE → RedemptionQueue");
  console.log("    ✅ MUSD.BRIDGE_ROLE → ETHPoolYieldDistributor");
  console.log("    ✅ MUSD.BRIDGE_ROLE → ETHPool");
  console.log("    ✅ SMUSDE.POOL_ROLE → ETHPool");
  console.log("    ✅ TreasuryV2.VAULT_ROLE → YieldDistributor");
  console.log("    ✅ SMUSD.YIELD_MANAGER_ROLE → YieldDistributor");
  console.log("    ✅ YieldVerifier adapters registered (Sky, Ethena, Morpho)");
  console.log("    ✅ ETHPool stablecoin registered (MockUSDC)");
  console.log("═══════════════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("Deployment failed:", err);
  process.exit(1);
});
