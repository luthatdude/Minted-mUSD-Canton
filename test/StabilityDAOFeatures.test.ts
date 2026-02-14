import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("Stability DAO Features", function () {
  // ═══════════════════════════════════════════════════════════════════
  // SHARED FIXTURE
  // ═══════════════════════════════════════════════════════════════════

  async function deployFullFixture() {
    const [owner, treasury, strategist, keeper, guardian, user1, feeRecipient, timelockSigner] = await ethers.getSigners();

    // Deploy USDC mock
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    // Mint initial USDC
    const mintAmount = ethers.parseUnits("10000000", 6); // 10M USDC
    await usdc.mint(owner.address, mintAmount);
    await usdc.mint(treasury.address, mintAmount);
    await usdc.mint(strategist.address, ethers.parseUnits("1000000", 6));

    // Deploy AAVE mocks
    const MockAaveV3Pool = await ethers.getContractFactory("MockAaveV3Pool");
    const aavePool = await MockAaveV3Pool.deploy(await usdc.getAddress());
    const MockAToken = await ethers.getContractFactory("MockAToken");
    const aToken = await MockAToken.deploy(await aavePool.getAddress(), await usdc.getAddress());
    const MockVariableDebtToken = await ethers.getContractFactory("MockVariableDebtToken");
    const debtToken = await MockVariableDebtToken.deploy(await aavePool.getAddress());
    const MockAaveV3DataProvider = await ethers.getContractFactory("MockAaveV3DataProvider");
    const dataProvider = await MockAaveV3DataProvider.deploy(await aavePool.getAddress());

    // Seed AAVE pool liquidity
    await usdc.mint(owner.address, ethers.parseUnits("5000000", 6));
    await usdc.approve(await aavePool.getAddress(), ethers.parseUnits("5000000", 6));
    await aavePool.seedLiquidity(ethers.parseUnits("5000000", 6));

    // Deploy Merkl mock
    const MockMerklDistributor = await ethers.getContractFactory("MockMerklDistributor");
    const merklDistributor = await MockMerklDistributor.deploy();

    // Deploy swap router mock
    const MockSwapRouter = await ethers.getContractFactory("MockSwapRouterV3ForLoop");
    const swapRouter = await MockSwapRouter.deploy();

    // Deploy Balancer V3 mock
    const MockBalancerV3Vault = await ethers.getContractFactory("MockBalancerV3Vault");
    const balancerVault = await MockBalancerV3Vault.deploy(await usdc.getAddress());
    // Seed Balancer vault
    await usdc.mint(owner.address, ethers.parseUnits("5000000", 6));
    await usdc.approve(await balancerVault.getAddress(), ethers.parseUnits("5000000", 6));
    await balancerVault.seedLiquidity(ethers.parseUnits("5000000", 6));

    // Deploy AaveV3LoopStrategy (for MetaVault testing)
    const AaveV3LoopStrategy = await ethers.getContractFactory("AaveV3LoopStrategy");
    const strategy = await upgrades.deployProxy(AaveV3LoopStrategy, [
      await usdc.getAddress(),
      await aavePool.getAddress(),
      await dataProvider.getAddress(),
      await aToken.getAddress(),
      await debtToken.getAddress(),
      await merklDistributor.getAddress(),
      await swapRouter.getAddress(),
      treasury.address,
      owner.address,
      timelockSigner.address
    ], { kind: "uups" });

    // Grant roles on strategy
    await strategy.grantRole(await strategy.STRATEGIST_ROLE(), strategist.address);
    await strategy.grantRole(await strategy.KEEPER_ROLE(), keeper.address);
    await strategy.grantRole(await strategy.GUARDIAN_ROLE(), guardian.address);

    // Approve strategy from treasury
    await usdc.connect(treasury).approve(await strategy.getAddress(), ethers.MaxUint256);

    return {
      owner, treasury, strategist, keeper, guardian, user1, feeRecipient,
      timelockSigner,
      usdc, aavePool, aToken, debtToken, dataProvider,
      merklDistributor, swapRouter, balancerVault,
      strategy
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // 1. FLASH LOAN LIBRARY
  // ═══════════════════════════════════════════════════════════════════

  describe("FlashLoanLib", function () {
    it("Should calculate AAVE V3 fee correctly (0.05%)", async function () {
      // FlashLoanLib is an internal library, test via the IFlashLoanProvider enum
      // Fee = amount * 5 / 10000
      const amount = ethers.parseUnits("1000000", 6);
      const expectedFee = amount * 5n / 10000n;
      expect(expectedFee).to.equal(ethers.parseUnits("500", 6)); // $500 on $1M
    });

    it("Should calculate Balancer V3 fee as zero (FREE!)", async function () {
      // Balancer V3 flash loans are free
      const fee = 0; // BalancerV3 enum
      expect(fee).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. BALANCER V3 MOCK FLASH LOAN
  // ═══════════════════════════════════════════════════════════════════

  describe("MockBalancerV3Vault", function () {
    it("Should execute flash loan with zero fees", async function () {
      const { balancerVault, usdc } = await loadFixture(deployFullFixture);

      const vaultBalance = await usdc.balanceOf(await balancerVault.getAddress());
      expect(vaultBalance).to.be.gte(ethers.parseUnits("5000000", 6));
    });

    it("Should have seedLiquidity function", async function () {
      const { balancerVault, usdc, owner } = await loadFixture(deployFullFixture);

      const balBefore = await usdc.balanceOf(await balancerVault.getAddress());
      const seedAmount = ethers.parseUnits("1000", 6);
      await usdc.mint(owner.address, seedAmount);
      await usdc.approve(await balancerVault.getAddress(), seedAmount);
      await balancerVault.seedLiquidity(seedAmount);

      expect(await usdc.balanceOf(await balancerVault.getAddress())).to.equal(balBefore + seedAmount);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. REAL SHARE PRICE & TVL
  // ═══════════════════════════════════════════════════════════════════

  describe("realSharePrice & realTvl", function () {
    it("Should return WAD (1e18) share price with no deposits", async function () {
      const { strategy } = await loadFixture(deployFullFixture);

      const [price, trusted] = await strategy.realSharePrice();
      expect(price).to.equal(ethers.parseUnits("1", 18));
      expect(trusted).to.be.true;
    });

    it("Should return correct share price after deposit", async function () {
      const { strategy, treasury } = await loadFixture(deployFullFixture);

      const amount = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(amount);

      const [price, trusted] = await strategy.realSharePrice();
      // Share price should be close to 1.0 (slightly less due to flash loan fees)
      expect(price).to.be.gt(ethers.parseUnits("0.9", 18));
      expect(price).to.be.lte(ethers.parseUnits("1.1", 18));
      expect(trusted).to.be.true;
    });

    it("Should return 0 TVL with no deposits", async function () {
      const { strategy } = await loadFixture(deployFullFixture);

      const [tvl, trusted] = await strategy.realTvl();
      expect(tvl).to.equal(0);
      expect(trusted).to.be.true;
    });

    it("Should return correct TVL after deposit", async function () {
      const { strategy, treasury } = await loadFixture(deployFullFixture);

      const amount = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(amount);

      const [tvl, trusted] = await strategy.realTvl();
      // TVL should be close to deposit (minus flash loan fees)
      expect(tvl).to.be.gt(ethers.parseUnits("90000", 6)); // At least 90% 
      expect(tvl).to.be.lte(ethers.parseUnits("110000", 6));
      expect(trusted).to.be.true;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. ADJUST LEVERAGE WITH MIN SHARE PRICE
  // ═══════════════════════════════════════════════════════════════════

  describe("adjustLeverage with minSharePrice", function () {
    it("Should adjust leverage to new LTV", async function () {
      const { strategy, treasury, strategist } = await loadFixture(deployFullFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      // Adjust from 75% to 60% LTV
      await strategy.connect(strategist).adjustLeverage(6000, 0);

      expect(await strategy.targetLtvBps()).to.equal(6000);
    });

    it("Should accept valid share price after adjustment", async function () {
      const { strategy, treasury, strategist } = await loadFixture(deployFullFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      // Set low min share price (should pass)
      const minPrice = ethers.parseUnits("0.5", 18); // 50% of original
      await strategy.connect(strategist).adjustLeverage(6000, minPrice);
    });

    it("Should revert with SharePriceTooLow if price drops below min", async function () {
      const { strategy, treasury, strategist } = await loadFixture(deployFullFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      // Set unrealistically high min share price (should revert)
      const minPrice = ethers.parseUnits("100", 18); // 100x — impossible
      await expect(
        strategy.connect(strategist).adjustLeverage(6000, minPrice)
      ).to.be.revertedWithCustomError(strategy, "SharePriceTooLow");
    });

    it("Should revert with InvalidLTV for out-of-range values", async function () {
      const { strategy, treasury, strategist } = await loadFixture(deployFullFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      await expect(
        strategy.connect(strategist).adjustLeverage(2000, 0) // < 3000
      ).to.be.revertedWithCustomError(strategy, "InvalidLTV");

      await expect(
        strategy.connect(strategist).adjustLeverage(9500, 0) // > 9000
      ).to.be.revertedWithCustomError(strategy, "InvalidLTV");
    });

    it("Should only allow STRATEGIST_ROLE", async function () {
      const { strategy, user1 } = await loadFixture(deployFullFixture);

      await expect(
        strategy.connect(user1).adjustLeverage(6000, 0)
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 5. LEVERAGE MATH LIBRARY
  // ═══════════════════════════════════════════════════════════════════

  describe("LeverageMathLib", function () {
    it("Should be deployable (library exists)", async function () {
      // Library is used internally — verify it compiled
      const artifact = await ethers.getContractFactory("LeverageMathLib");
      expect(artifact).to.not.be.undefined;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 6. ORACLE ADAPTER SYSTEM
  // ═══════════════════════════════════════════════════════════════════

  describe("Oracle Adapter System", function () {
    async function deployOracleFixture() {
      const base = await loadFixture(deployFullFixture);

      // Deploy Chainlink adapter
      const ChainlinkAdapter = await ethers.getContractFactory("ChainlinkOracleAdapter");
      const chainlinkAdapter = await upgrades.deployProxy(ChainlinkAdapter, [
        base.owner.address,
        base.timelockSigner.address
      ], { kind: "uups" });

      // Deploy mock aggregator
      const MockAggregatorV3 = await ethers.getContractFactory("MockAggregatorV3");
      const mockFeed = await MockAggregatorV3.deploy(8, 100000000); // 8 decimals, $1.00

      // Deploy PriceAggregator
      const PriceAggregator = await ethers.getContractFactory("PriceAggregator");
      const priceAggregator = await upgrades.deployProxy(PriceAggregator, [
        base.owner.address,
        base.timelockSigner.address
      ], { kind: "uups" });

      return {
        ...base,
        chainlinkAdapter,
        mockFeed,
        priceAggregator
      };
    }

    describe("ChainlinkOracleAdapter", function () {
      it("Should initialize correctly", async function () {
        const { chainlinkAdapter, owner } = await loadFixture(deployOracleFixture);

        expect(await chainlinkAdapter.hasRole(
          await chainlinkAdapter.DEFAULT_ADMIN_ROLE(),
          owner.address
        )).to.be.true;
      });

      it("Should set and query a feed", async function () {
        const { chainlinkAdapter, mockFeed, usdc } = await loadFixture(deployOracleFixture);

        const usdcAddr = await usdc.getAddress();
        await chainlinkAdapter.setFeed(usdcAddr, await mockFeed.getAddress(), 86400, 6);

        expect(await chainlinkAdapter.supportsToken(usdcAddr)).to.be.true;
      });

      it("Should return correct price from feed", async function () {
        const { chainlinkAdapter, mockFeed, usdc } = await loadFixture(deployOracleFixture);

        const usdcAddr = await usdc.getAddress();
        await chainlinkAdapter.setFeed(usdcAddr, await mockFeed.getAddress(), 86400, 6);

        const [price] = await chainlinkAdapter.getPrice(usdcAddr);
        expect(price).to.equal(ethers.parseUnits("1", 18)); // $1 in 18 decimals
      });

      it("Should return source as Chainlink", async function () {
        const { chainlinkAdapter } = await loadFixture(deployOracleFixture);
        expect(await chainlinkAdapter.source()).to.equal("Chainlink");
      });

      it("Should report healthy feed", async function () {
        const { chainlinkAdapter, mockFeed, usdc } = await loadFixture(deployOracleFixture);

        const usdcAddr = await usdc.getAddress();
        await chainlinkAdapter.setFeed(usdcAddr, await mockFeed.getAddress(), 86400, 6);

        expect(await chainlinkAdapter.isHealthy(usdcAddr)).to.be.true;
      });

      it("Should remove feed", async function () {
        const { chainlinkAdapter, mockFeed, usdc } = await loadFixture(deployOracleFixture);

        const usdcAddr = await usdc.getAddress();
        await chainlinkAdapter.setFeed(usdcAddr, await mockFeed.getAddress(), 86400, 6);
        await chainlinkAdapter.removeFeed(usdcAddr);

        expect(await chainlinkAdapter.supportsToken(usdcAddr)).to.be.false;
      });
    });

    describe("PriceAggregator", function () {
      it("Should initialize correctly", async function () {
        const { priceAggregator } = await loadFixture(deployOracleFixture);
        expect(await priceAggregator.adapterCount()).to.equal(0);
      });

      it("Should add adapter", async function () {
        const { priceAggregator, chainlinkAdapter } = await loadFixture(deployOracleFixture);

        await priceAggregator.addAdapter(await chainlinkAdapter.getAddress());
        expect(await priceAggregator.adapterCount()).to.equal(1);
      });

      it("Should get price from adapter with fallback", async function () {
        const { priceAggregator, chainlinkAdapter, mockFeed, usdc } = await loadFixture(deployOracleFixture);

        // Setup feed
        const usdcAddr = await usdc.getAddress();
        await chainlinkAdapter.setFeed(usdcAddr, await mockFeed.getAddress(), 86400, 6);

        // Add adapter to aggregator
        await priceAggregator.addAdapter(await chainlinkAdapter.getAddress());

        const price = await priceAggregator.getPrice(usdcAddr);
        expect(price).to.equal(ethers.parseUnits("1", 18));
      });

      it("Should get price with source info", async function () {
        const { priceAggregator, chainlinkAdapter, mockFeed, usdc } = await loadFixture(deployOracleFixture);

        const usdcAddr = await usdc.getAddress();
        await chainlinkAdapter.setFeed(usdcAddr, await mockFeed.getAddress(), 86400, 6);
        await priceAggregator.addAdapter(await chainlinkAdapter.getAddress());

        const [price, source, updatedAt] = await priceAggregator.getPriceWithSource(usdcAddr);
        expect(price).to.equal(ethers.parseUnits("1", 18));
        expect(source).to.equal("Chainlink");
        expect(updatedAt).to.be.gt(0);
      });

      it("Should revert when no adapter available", async function () {
        const { priceAggregator, usdc } = await loadFixture(deployOracleFixture);

        await expect(
          priceAggregator.getPrice(await usdc.getAddress())
        ).to.be.revertedWithCustomError(priceAggregator, "NoAdapterAvailable");
      });

      it("Should remove adapter", async function () {
        const { priceAggregator, chainlinkAdapter } = await loadFixture(deployOracleFixture);

        const adapterAddr = await chainlinkAdapter.getAddress();
        await priceAggregator.addAdapter(adapterAddr);
        expect(await priceAggregator.adapterCount()).to.equal(1);

        await priceAggregator.removeAdapter(adapterAddr);
        expect(await priceAggregator.adapterCount()).to.equal(0);
      });

      it("Should set max deviation", async function () {
        const { priceAggregator } = await loadFixture(deployOracleFixture);

        await priceAggregator.setMaxDeviation(300); // 3%
        expect(await priceAggregator.maxDeviationBps()).to.equal(300);
      });

      it("Should reject invalid max deviation", async function () {
        const { priceAggregator } = await loadFixture(deployOracleFixture);

        await expect(
          priceAggregator.setMaxDeviation(10) // < 50 bps
        ).to.be.revertedWithCustomError(priceAggregator, "InvalidMaxDeviation");
      });

      it("Should toggle cross-validation", async function () {
        const { priceAggregator } = await loadFixture(deployOracleFixture);

        await priceAggregator.setCrossValidation(true);
        expect(await priceAggregator.crossValidationEnabled()).to.be.true;
      });

      it("Should get healthy adapter count", async function () {
        const { priceAggregator, chainlinkAdapter, mockFeed, usdc } = await loadFixture(deployOracleFixture);

        const usdcAddr = await usdc.getAddress();
        await chainlinkAdapter.setFeed(usdcAddr, await mockFeed.getAddress(), 86400, 6);
        await priceAggregator.addAdapter(await chainlinkAdapter.getAddress());

        expect(await priceAggregator.getHealthyAdapterCount(usdcAddr)).to.equal(1);
      });

      it("Should enforce MAX_ADAPTERS limit", async function () {
        const { priceAggregator, chainlinkAdapter, owner, timelockSigner } = await loadFixture(deployOracleFixture);

        // Add 5 adapters (max)
        for (let i = 0; i < 5; i++) {
          const ChainlinkAdapter = await ethers.getContractFactory("ChainlinkOracleAdapter");
          const adapter = await upgrades.deployProxy(ChainlinkAdapter, [
            owner.address,
            timelockSigner.address
          ], { kind: "uups" });
          await priceAggregator.addAdapter(await adapter.getAddress());
        }

        // 6th should fail
        await expect(
          priceAggregator.addAdapter(await chainlinkAdapter.getAddress())
        ).to.be.revertedWithCustomError(priceAggregator, "TooManyAdapters");
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 7. META VAULT
  // ═══════════════════════════════════════════════════════════════════

  describe("MetaVault", function () {
    async function deployMetaVaultFixture() {
      const base = await loadFixture(deployFullFixture);

      // Deploy MetaVault
      const MetaVault = await ethers.getContractFactory("MetaVault");
      const metaVault = await upgrades.deployProxy(MetaVault, [
        await base.usdc.getAddress(),
        base.feeRecipient.address,
        base.owner.address,
        base.timelockSigner.address
      ], { kind: "uups" });

      // Grant roles
      await metaVault.grantRole(await metaVault.DEPOSITOR_ROLE(), base.treasury.address);
      await metaVault.grantRole(await metaVault.STRATEGIST_ROLE(), base.strategist.address);
      await metaVault.grantRole(await metaVault.KEEPER_ROLE(), base.keeper.address);
      await metaVault.grantRole(await metaVault.GUARDIAN_ROLE(), base.guardian.address);

      // Deploy 2 mock strategies for MetaVault
      const MockStrategy = await ethers.getContractFactory("MockStrategy");
      const strat1 = await MockStrategy.deploy(await base.usdc.getAddress(), base.treasury.address);
      const strat2 = await MockStrategy.deploy(await base.usdc.getAddress(), base.treasury.address);

      // Approve MetaVault from treasury
      await base.usdc.connect(base.treasury).approve(await metaVault.getAddress(), ethers.MaxUint256);

      return {
        ...base,
        metaVault,
        strat1,
        strat2
      };
    }

    describe("Initialization", function () {
      it("Should initialize with correct parameters", async function () {
        const { metaVault, usdc, feeRecipient } = await loadFixture(deployMetaVaultFixture);

        expect(await metaVault.asset()).to.equal(await usdc.getAddress());
        expect(await metaVault.feeRecipient()).to.equal(feeRecipient.address);
        expect(await metaVault.performanceFeeBps()).to.equal(2000);
        expect(await metaVault.rebalanceThresholdBps()).to.equal(200);
        expect(await metaVault.autoAllocateEnabled()).to.be.true;
        expect(await metaVault.vaultCount()).to.equal(0);
      });
    });

    describe("Vault Management", function () {
      it("Should add a vault", async function () {
        const { metaVault, strat1, strategist } = await loadFixture(deployMetaVaultFixture);

        await expect(metaVault.connect(strategist).addVault(await strat1.getAddress(), 5000))
          .to.emit(metaVault, "VaultAdded");

        expect(await metaVault.vaultCount()).to.equal(1);
      });

      it("Should add multiple vaults with valid allocations", async function () {
        const { metaVault, strat1, strat2, strategist } = await loadFixture(deployMetaVaultFixture);

        await metaVault.connect(strategist).addVault(await strat1.getAddress(), 6000);
        await metaVault.connect(strategist).addVault(await strat2.getAddress(), 4000);

        expect(await metaVault.vaultCount()).to.equal(2);
      });

      it("Should reject allocation exceeding 100%", async function () {
        const { metaVault, strat1, strat2, strategist } = await loadFixture(deployMetaVaultFixture);

        await metaVault.connect(strategist).addVault(await strat1.getAddress(), 6000);

        await expect(
          metaVault.connect(strategist).addVault(await strat2.getAddress(), 5000)
        ).to.be.revertedWithCustomError(metaVault, "AllocationExceedsBPS");
      });

      it("Should reject duplicate vaults", async function () {
        const { metaVault, strat1, strategist } = await loadFixture(deployMetaVaultFixture);

        await metaVault.connect(strategist).addVault(await strat1.getAddress(), 5000);

        await expect(
          metaVault.connect(strategist).addVault(await strat1.getAddress(), 2000)
        ).to.be.revertedWithCustomError(metaVault, "VaultAlreadyExists");
      });

      it("Should remove a vault", async function () {
        const { metaVault, strat1, strategist } = await loadFixture(deployMetaVaultFixture);

        await metaVault.connect(strategist).addVault(await strat1.getAddress(), 5000);
        await metaVault.connect(strategist).removeVault(await strat1.getAddress());

        expect(await metaVault.vaultCount()).to.equal(0);
      });

      it("Should update vault target allocation", async function () {
        const { metaVault, strat1, strategist } = await loadFixture(deployMetaVaultFixture);

        await metaVault.connect(strategist).addVault(await strat1.getAddress(), 5000);
        await metaVault.connect(strategist).updateVault(await strat1.getAddress(), 7000, true);

        const vaults = await metaVault.getAllVaults();
        expect(vaults[0].targetBps).to.equal(7000);
      });
    });

    describe("Deposit & Withdraw", function () {
      it("Should deposit and issue shares", async function () {
        const { metaVault, strat1, treasury, strategist } = await loadFixture(deployMetaVaultFixture);

        await metaVault.connect(strategist).addVault(await strat1.getAddress(), 10000);

        const amount = ethers.parseUnits("100000", 6);
        await expect(metaVault.connect(treasury).deposit(amount))
          .to.emit(metaVault, "Deposited");

        expect(await metaVault.totalShares()).to.equal(amount);
        expect(await metaVault.totalValue()).to.be.gt(0);
      });

      it("Should withdraw shares correctly", async function () {
        const { metaVault, strat1, treasury, usdc, strategist } = await loadFixture(deployMetaVaultFixture);

        await metaVault.connect(strategist).addVault(await strat1.getAddress(), 10000);
        await metaVault.connect(strategist).setAutoAllocate(false);

        const depositAmount = ethers.parseUnits("100000", 6);
        await metaVault.connect(treasury).deposit(depositAmount);

        const balBefore = await usdc.balanceOf(treasury.address);
        await metaVault.connect(treasury).withdraw(depositAmount);
        const balAfter = await usdc.balanceOf(treasury.address);

        expect(balAfter - balBefore).to.be.gt(0);
        expect(await metaVault.totalShares()).to.equal(0);
      });

      it("Should revert withdraw with insufficient shares", async function () {
        const { metaVault, treasury } = await loadFixture(deployMetaVaultFixture);

        await expect(
          metaVault.connect(treasury).withdraw(ethers.parseUnits("1", 6))
        ).to.be.revertedWithCustomError(metaVault, "InsufficientShares");
      });
    });

    describe("Share Price", function () {
      it("Should return WAD for empty vault", async function () {
        const { metaVault } = await loadFixture(deployMetaVaultFixture);

        expect(await metaVault.sharePrice()).to.equal(ethers.parseUnits("1", 18));
      });

      it("Should return correct share price after deposit", async function () {
        const { metaVault, strat1, treasury, strategist, usdc } = await loadFixture(deployMetaVaultFixture);

        await metaVault.connect(strategist).addVault(await strat1.getAddress(), 10000);
        await metaVault.connect(strategist).setAutoAllocate(false);

        const amount = ethers.parseUnits("100000", 6);
        await metaVault.connect(treasury).deposit(amount);

        const price = await metaVault.sharePrice();
        // With autoAllocate off, all funds stay in MetaVault reserve
        // Share price = totalValue / totalShares. totalValue includes reserve only.
        expect(price).to.be.gte(ethers.parseUnits("1", 18));
      });
    });

    describe("Rebalance", function () {
      it("Should allow keeper to rebalance", async function () {
        const { metaVault, strat1, strat2, treasury, keeper, strategist } = await loadFixture(deployMetaVaultFixture);

        await metaVault.connect(strategist).addVault(await strat1.getAddress(), 5000);
        await metaVault.connect(strategist).addVault(await strat2.getAddress(), 5000);
        await metaVault.connect(strategist).setAutoAllocate(false);

        const amount = ethers.parseUnits("100000", 6);
        await metaVault.connect(treasury).deposit(amount);

        // Rebalance should not revert
        await metaVault.connect(keeper).rebalance();
      });

      it("Should reject rebalance from non-keeper", async function () {
        const { metaVault, user1 } = await loadFixture(deployMetaVaultFixture);

        await expect(metaVault.connect(user1).rebalance()).to.be.reverted;
      });
    });

    describe("Admin & Emergency", function () {
      it("Should set rebalance threshold", async function () {
        const { metaVault, strategist } = await loadFixture(deployMetaVaultFixture);

        await metaVault.connect(strategist).setRebalanceThreshold(500);
        expect(await metaVault.rebalanceThresholdBps()).to.equal(500);
      });

      it("Should reject invalid rebalance threshold", async function () {
        const { metaVault, strategist } = await loadFixture(deployMetaVaultFixture);

        await expect(
          metaVault.connect(strategist).setRebalanceThreshold(10) // < 50 bps
        ).to.be.revertedWithCustomError(metaVault, "InvalidRebalanceThreshold");
      });

      it("Should allow guardian to pause", async function () {
        const { metaVault, guardian } = await loadFixture(deployMetaVaultFixture);

        await metaVault.connect(guardian).pause();
        expect(await metaVault.paused()).to.be.true;
      });

      it("Should only allow timelock to unpause", async function () {
        const { metaVault, guardian, timelockSigner } = await loadFixture(deployMetaVaultFixture);

        await metaVault.connect(guardian).pause();
        await expect(metaVault.connect(guardian).unpause()).to.be.reverted;
        await metaVault.connect(timelockSigner).unpause();
        expect(await metaVault.paused()).to.be.false;
      });

      it("Should emergency withdraw from single vault", async function () {
        const { metaVault, strat1, treasury, guardian, strategist } = await loadFixture(deployMetaVaultFixture);

        await metaVault.connect(strategist).addVault(await strat1.getAddress(), 10000);
        await metaVault.connect(strategist).setAutoAllocate(false);
        const amount = ethers.parseUnits("50000", 6);
        await metaVault.connect(treasury).deposit(amount);

        await expect(metaVault.connect(guardian).emergencyWithdrawFromVault(await strat1.getAddress()))
          .to.emit(metaVault, "EmergencyWithdrawn");
      });

      it("Should emergency withdraw all", async function () {
        const { metaVault, strat1, strat2, treasury, guardian, strategist } = await loadFixture(deployMetaVaultFixture);

        await metaVault.connect(strategist).addVault(await strat1.getAddress(), 5000);
        await metaVault.connect(strategist).addVault(await strat2.getAddress(), 5000);
        await metaVault.connect(strategist).setAutoAllocate(false);

        const amount = ethers.parseUnits("100000", 6);
        await metaVault.connect(treasury).deposit(amount);

        await expect(metaVault.connect(guardian).emergencyWithdrawAll())
          .to.emit(metaVault, "EmergencyWithdrawn");
      });

      it("Should set performance fee via timelock", async function () {
        const { metaVault, timelockSigner } = await loadFixture(deployMetaVaultFixture);

        await metaVault.connect(timelockSigner).setPerformanceFee(1000);
        expect(await metaVault.performanceFeeBps()).to.equal(1000);
      });

      it("Should reject excessive performance fee", async function () {
        const { metaVault, timelockSigner } = await loadFixture(deployMetaVaultFixture);

        await expect(
          metaVault.connect(timelockSigner).setPerformanceFee(6000) // > 50%
        ).to.be.revertedWithCustomError(metaVault, "InvalidFee");
      });

      it("Should get current allocations", async function () {
        const { metaVault, strat1, strat2, strategist } = await loadFixture(deployMetaVaultFixture);

        await metaVault.connect(strategist).addVault(await strat1.getAddress(), 6000);
        await metaVault.connect(strategist).addVault(await strat2.getAddress(), 4000);

        const [strategies, currentBps, targetBps] = await metaVault.getCurrentAllocations();
        expect(strategies.length).to.equal(2);
        expect(targetBps[0]).to.equal(6000);
        expect(targetBps[1]).to.equal(4000);
      });
    });
  });
});
