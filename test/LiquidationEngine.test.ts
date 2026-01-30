/**
 * LiquidationEngine Test Suite
 * Tests for the liquidation functionality of undercollateralized positions
 * 
 * CRITICAL: This contract has 0% test coverage - these tests are essential
 * before formal audit.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("LiquidationEngine", function () {
  async function deployLiquidationFixture() {
    const [owner, user1, user2, liquidator] = await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const weth = await MockERC20.deploy("Wrapped Ether", "WETH");

    // Deploy MUSD
    const MUSD = await ethers.getContractFactory("MUSD");
    const musd = await MUSD.deploy();
    await musd.initialize(owner.address);

    // Deploy PriceOracle
    const PriceOracle = await ethers.getContractFactory("PriceOracle");
    const priceOracle = await PriceOracle.deploy();
    await priceOracle.initialize();

    // Deploy mock Chainlink aggregator
    const MockAggregator = await ethers.getContractFactory("MockAggregatorV3");
    const ethFeed = await MockAggregator.deploy(8);
    await ethFeed.setAnswer(200000000000n); // $2000

    // Configure oracle
    await priceOracle.setFeed(await weth.getAddress(), await ethFeed.getAddress(), 3600);

    // Deploy CollateralVault
    const CollateralVault = await ethers.getContractFactory("CollateralVault");
    const collateralVault = await CollateralVault.deploy();
    await collateralVault.initialize(await priceOracle.getAddress());

    // Add collateral with 80% liquidation threshold and 10% penalty
    await collateralVault.addCollateral(
      await weth.getAddress(),
      7500, // 75% LTV
      8000, // 80% liquidation threshold
      1000  // 10% liquidation penalty
    );

    // Deploy BorrowModule
    const BorrowModule = await ethers.getContractFactory("BorrowModule");
    const borrowModule = await BorrowModule.deploy();
    await borrowModule.initialize(
      await musd.getAddress(),
      await collateralVault.getAddress(),
      await priceOracle.getAddress()
    );

    // Deploy LiquidationEngine
    const LiquidationEngine = await ethers.getContractFactory("LiquidationEngine");
    const liquidationEngine = await LiquidationEngine.deploy();
    await liquidationEngine.initialize(
      await borrowModule.getAddress(),
      await collateralVault.getAddress(),
      await priceOracle.getAddress()
    );

    // Grant roles
    const MINTER_ROLE = await musd.MINTER_ROLE();
    const BORROW_MODULE_ROLE = await collateralVault.BORROW_MODULE_ROLE();
    const LIQUIDATION_ROLE = await collateralVault.LIQUIDATION_ROLE();

    await musd.grantRole(MINTER_ROLE, await borrowModule.getAddress());
    await collateralVault.grantRole(BORROW_MODULE_ROLE, await borrowModule.getAddress());
    await collateralVault.grantRole(LIQUIDATION_ROLE, await liquidationEngine.getAddress());

    // Connect liquidation engine to borrow module
    await borrowModule.setLiquidationEngine(await liquidationEngine.getAddress());

    // Mint tokens to users
    await weth.mint(user1.address, ethers.parseEther("100"));
    await weth.mint(liquidator.address, ethers.parseEther("100"));

    // Mint mUSD to liquidator for repayment
    await musd.grantRole(MINTER_ROLE, owner.address);
    await musd.mint(liquidator.address, ethers.parseUnits("100000", 18));

    return {
      liquidationEngine,
      borrowModule,
      collateralVault,
      priceOracle,
      musd,
      weth,
      ethFeed,
      owner,
      user1,
      user2,
      liquidator,
    };
  }

  describe("Deployment", function () {
    it("Should initialize with correct parameters", async function () {
      const { liquidationEngine, borrowModule, collateralVault, priceOracle } = await loadFixture(
        deployLiquidationFixture
      );

      expect(await liquidationEngine.borrowModule()).to.equal(await borrowModule.getAddress());
      expect(await liquidationEngine.vault()).to.equal(await collateralVault.getAddress());
      expect(await liquidationEngine.oracle()).to.equal(await priceOracle.getAddress());
    });

    it("Should set default close factor", async function () {
      const { liquidationEngine } = await loadFixture(deployLiquidationFixture);

      const closeFactor = await liquidationEngine.closeFactorBps();
      expect(closeFactor).to.equal(5000); // 50%
    });

    it("Should set full liquidation threshold", async function () {
      const { liquidationEngine } = await loadFixture(deployLiquidationFixture);

      const threshold = await liquidationEngine.fullLiquidationThreshold();
      expect(threshold).to.equal(5000); // HF < 0.5 allows 100% liquidation
    });
  });

  describe("Liquidation Eligibility", function () {
    it("Should correctly identify liquidatable positions", async function () {
      const { liquidationEngine, borrowModule, collateralVault, weth, ethFeed, user1 } =
        await loadFixture(deployLiquidationFixture);

      // Deposit 10 ETH ($20,000) and borrow 14,000 mUSD (70% utilization)
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);
      await borrowModule.connect(user1).borrow(ethers.parseUnits("14000", 18));

      // Not liquidatable yet (health factor > 1.0)
      expect(await liquidationEngine.isLiquidatable(user1.address)).to.equal(false);

      // Drop ETH price to $1500 (25% drop)
      // New collateral value: 10 * 1500 = $15,000
      // Health factor = (15000 * 0.80) / 14000 = 0.857 < 1.0
      await ethFeed.setAnswer(150000000000n); // $1500

      expect(await liquidationEngine.isLiquidatable(user1.address)).to.equal(true);
    });

    it("Should not allow liquidation of healthy positions", async function () {
      const { liquidationEngine, borrowModule, collateralVault, weth, musd, user1, liquidator } =
        await loadFixture(deployLiquidationFixture);

      // Create a healthy position
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);
      await borrowModule.connect(user1).borrow(ethers.parseUnits("5000", 18));

      // Try to liquidate
      const repayAmount = ethers.parseUnits("1000", 18);
      await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), repayAmount);

      await expect(
        liquidationEngine.connect(liquidator).liquidate(
          user1.address,
          await weth.getAddress(),
          repayAmount
        )
      ).to.be.revertedWith("POSITION_HEALTHY");
    });
  });

  describe("Liquidation Execution", function () {
    it("Should execute partial liquidation correctly", async function () {
      const {
        liquidationEngine,
        borrowModule,
        collateralVault,
        weth,
        musd,
        ethFeed,
        user1,
        liquidator,
      } = await loadFixture(deployLiquidationFixture);

      // Setup: deposit and borrow at max
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);
      await borrowModule.connect(user1).borrow(ethers.parseUnits("14000", 18));

      // Make position liquidatable
      await ethFeed.setAnswer(150000000000n); // $1500

      // Liquidate 25% of debt (within close factor)
      const repayAmount = ethers.parseUnits("3500", 18);
      const liquidatorWethBefore = await weth.balanceOf(liquidator.address);
      const liquidatorMusdBefore = await musd.balanceOf(liquidator.address);

      await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), repayAmount);
      await liquidationEngine
        .connect(liquidator)
        .liquidate(user1.address, await weth.getAddress(), repayAmount);

      const liquidatorWethAfter = await weth.balanceOf(liquidator.address);
      const liquidatorMusdAfter = await musd.balanceOf(liquidator.address);

      // Liquidator should receive collateral + penalty
      expect(liquidatorWethAfter).to.be.gt(liquidatorWethBefore);
      // Liquidator should have spent mUSD
      expect(liquidatorMusdAfter).to.be.lt(liquidatorMusdBefore);
    });

    it("Should enforce close factor limit", async function () {
      const {
        liquidationEngine,
        borrowModule,
        collateralVault,
        weth,
        musd,
        ethFeed,
        user1,
        liquidator,
      } = await loadFixture(deployLiquidationFixture);

      // Setup position
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);
      await borrowModule.connect(user1).borrow(ethers.parseUnits("14000", 18));

      // Make liquidatable (but not severely underwater)
      await ethFeed.setAnswer(170000000000n); // $1700, just under threshold

      // Try to liquidate more than 50% (close factor)
      const repayAmount = ethers.parseUnits("10000", 18); // > 50% of 14000

      await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), repayAmount);

      await expect(
        liquidationEngine
          .connect(liquidator)
          .liquidate(user1.address, await weth.getAddress(), repayAmount)
      ).to.be.revertedWith("EXCEEDS_CLOSE_FACTOR");
    });

    it("Should allow full liquidation when severely underwater", async function () {
      const {
        liquidationEngine,
        borrowModule,
        collateralVault,
        weth,
        musd,
        ethFeed,
        user1,
        liquidator,
      } = await loadFixture(deployLiquidationFixture);

      // Setup position
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);
      await borrowModule.connect(user1).borrow(ethers.parseUnits("14000", 18));

      // Make severely underwater (HF < 0.5)
      await ethFeed.setAnswer(80000000000n); // $800

      // Full liquidation should be allowed
      const debt = await borrowModule.totalDebt(user1.address);
      await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), debt);

      // Should not revert with EXCEEDS_CLOSE_FACTOR
      await liquidationEngine
        .connect(liquidator)
        .liquidate(user1.address, await weth.getAddress(), debt);
    });

    it("Should correctly calculate collateral seizure amount", async function () {
      const {
        liquidationEngine,
        borrowModule,
        collateralVault,
        weth,
        ethFeed,
        user1,
      } = await loadFixture(deployLiquidationFixture);

      // Setup position
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);
      await borrowModule.connect(user1).borrow(ethers.parseUnits("14000", 18));

      // Make liquidatable
      await ethFeed.setAnswer(150000000000n); // $1500

      const repayAmount = ethers.parseUnits("3000", 18);
      const seizure = await liquidationEngine.estimateSeize(
        await weth.getAddress(),
        repayAmount
      );

      // Seizure = (repayAmount / ethPrice) * (1 + penalty)
      // = (3000 / 1500) * 1.10 = 2.2 ETH
      const expectedSeizure = ethers.parseEther("2.2");
      expect(seizure).to.be.closeTo(expectedSeizure, ethers.parseEther("0.01"));
    });

    it("Should cap seizure at available collateral", async function () {
      const {
        liquidationEngine,
        borrowModule,
        collateralVault,
        weth,
        musd,
        ethFeed,
        user1,
        liquidator,
      } = await loadFixture(deployLiquidationFixture);

      // Setup position with limited collateral
      const depositAmount = ethers.parseEther("5");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);
      await borrowModule.connect(user1).borrow(ethers.parseUnits("7000", 18));

      // Crash price severely
      await ethFeed.setAnswer(50000000000n); // $500

      // Collateral value now: 5 * 500 = $2500
      // Debt: $7000
      // Even full liquidation can only seize $2500 worth of collateral

      const debt = await borrowModule.totalDebt(user1.address);
      await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), debt);

      const collateralBefore = await collateralVault.getDeposit(
        user1.address,
        await weth.getAddress()
      );

      await liquidationEngine
        .connect(liquidator)
        .liquidate(user1.address, await weth.getAddress(), debt);

      const collateralAfter = await collateralVault.getDeposit(
        user1.address,
        await weth.getAddress()
      );

      // All collateral should be seized
      expect(collateralAfter).to.equal(0);
    });

    it("Should prevent self-liquidation", async function () {
      const {
        liquidationEngine,
        borrowModule,
        collateralVault,
        weth,
        musd,
        ethFeed,
        user1,
        owner,
      } = await loadFixture(deployLiquidationFixture);

      // Setup position
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);
      await borrowModule.connect(user1).borrow(ethers.parseUnits("14000", 18));

      // Make liquidatable
      await ethFeed.setAnswer(150000000000n);

      // Give user1 some mUSD for repayment
      const MINTER_ROLE = await musd.MINTER_ROLE();
      await musd.grantRole(MINTER_ROLE, owner.address);
      await musd.mint(user1.address, ethers.parseUnits("10000", 18));

      const repayAmount = ethers.parseUnits("3000", 18);
      await musd.connect(user1).approve(await liquidationEngine.getAddress(), repayAmount);

      // Self-liquidation should be prevented
      await expect(
        liquidationEngine
          .connect(user1)
          .liquidate(user1.address, await weth.getAddress(), repayAmount)
      ).to.be.revertedWith("CANNOT_SELF_LIQUIDATE");
    });
  });

  describe("Admin Functions", function () {
    it("Should allow owner to set close factor", async function () {
      const { liquidationEngine, owner } = await loadFixture(deployLiquidationFixture);

      await liquidationEngine.connect(owner).setCloseFactor(6000); // 60%
      expect(await liquidationEngine.closeFactorBps()).to.equal(6000);
    });

    it("Should reject close factor above maximum", async function () {
      const { liquidationEngine, owner } = await loadFixture(deployLiquidationFixture);

      await expect(
        liquidationEngine.connect(owner).setCloseFactor(10001)
      ).to.be.revertedWith("INVALID_CLOSE_FACTOR");
    });

    it("Should allow owner to set full liquidation threshold", async function () {
      const { liquidationEngine, owner } = await loadFixture(deployLiquidationFixture);

      await liquidationEngine.connect(owner).setFullLiquidationThreshold(4000);
      expect(await liquidationEngine.fullLiquidationThreshold()).to.equal(4000);
    });
  });

  describe("Events", function () {
    it("Should emit Liquidation event on successful liquidation", async function () {
      const {
        liquidationEngine,
        borrowModule,
        collateralVault,
        weth,
        musd,
        ethFeed,
        user1,
        liquidator,
      } = await loadFixture(deployLiquidationFixture);

      // Setup position
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);
      await borrowModule.connect(user1).borrow(ethers.parseUnits("14000", 18));

      // Make liquidatable
      await ethFeed.setAnswer(150000000000n);

      const repayAmount = ethers.parseUnits("3000", 18);
      await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), repayAmount);

      await expect(
        liquidationEngine
          .connect(liquidator)
          .liquidate(user1.address, await weth.getAddress(), repayAmount)
      )
        .to.emit(liquidationEngine, "Liquidation")
        .withArgs(
          user1.address,
          liquidator.address,
          await weth.getAddress(),
          repayAmount,
          expect.anything() // seized amount
        );
    });
  });
});
