/**
 * LiquidationEngine Test Suite
 * Tests for the liquidation functionality of undercollateralized positions
 * 
 * CRITICAL: This contract has 0% test coverage - these tests are essential
 * before formal audit.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { timelockSetFeed, timelockRemoveFeed, timelockAddCollateral, timelockUpdateCollateral, timelockSetBorrowModule, timelockSetInterestRateModel, timelockSetSMUSD, timelockSetTreasury, timelockSetInterestRate, timelockSetMinDebt, timelockSetCloseFactor, timelockSetFullLiquidationThreshold, timelockAddStrategy, timelockRemoveStrategy, timelockSetFeeConfig, timelockSetReserveBps, timelockSetFees, timelockSetFeeRecipient } from "./helpers/timelock";

describe("LiquidationEngine", function () {
  async function deployLiquidationFixture() {
    const [owner, user1, user2, liquidator] = await ethers.getSigners();

    // Deploy mock tokens (18 decimals for WETH)
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);

    // Deploy MUSD with initial supply cap
    const MUSD = await ethers.getContractFactory("MUSD");
    const musd = await MUSD.deploy(ethers.parseEther("100000000"), ethers.ZeroAddress); // 100M cap

    // Deploy PriceOracle (no constructor args)
    const PriceOracle = await ethers.getContractFactory("PriceOracle");
    const priceOracle = await PriceOracle.deploy();

    // Deploy mock Chainlink aggregator (decimals, initialAnswer)
    const MockAggregator = await ethers.getContractFactory("MockAggregatorV3");
    const ethFeed = await MockAggregator.deploy(8, 200000000000n); // 8 decimals, $2000

    // Configure oracle feed (token, feed, stalePeriod, tokenDecimals)
    await priceOracle.setFeed(await weth.getAddress(), await ethFeed.getAddress(), 3600, 18, 0);

    // Deploy CollateralVault (no constructor args)
    const CollateralVault = await ethers.getContractFactory("CollateralVault");
    const collateralVault = await CollateralVault.deploy(ethers.ZeroAddress);

    // Add collateral with 80% liquidation threshold and 10% penalty
    await collateralVault.addCollateral(
      await weth.getAddress(),
      7500, // 75% LTV (collateral factor)
      8000, // 80% liquidation threshold
      1000  // 10% liquidation penalty
    );

    // Deploy BorrowModule (vault, oracle, musd, interestRateBps, minDebt)
    const BorrowModule = await ethers.getContractFactory("BorrowModule");
    const borrowModule = await BorrowModule.deploy(
      await collateralVault.getAddress(),
      await priceOracle.getAddress(),
      await musd.getAddress(),
      500, // 5% APR
      ethers.parseEther("100") // 100 mUSD min debt
    );

    // Deploy LiquidationEngine (vault, borrowModule, oracle, musd, closeFactorBps)
    const LiquidationEngine = await ethers.getContractFactory("LiquidationEngine");
    const liquidationEngine = await LiquidationEngine.deploy(
      await collateralVault.getAddress(),
      await borrowModule.getAddress(),
      await priceOracle.getAddress(),
      await musd.getAddress(),
      5000, // 50% close factor
      owner.address // timelockController
    );

    // Grant roles
    const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
    const BORROW_MODULE_ROLE = await collateralVault.BORROW_MODULE_ROLE();
    const LIQUIDATION_ROLE_VAULT = await collateralVault.LIQUIDATION_ROLE();
    const LIQUIDATION_ROLE_BORROW = await borrowModule.LIQUIDATION_ROLE();

    await musd.grantRole(BRIDGE_ROLE, await borrowModule.getAddress());
    await musd.grantRole(BRIDGE_ROLE, await liquidationEngine.getAddress());
    await collateralVault.grantRole(BORROW_MODULE_ROLE, await borrowModule.getAddress());
    await collateralVault.grantRole(LIQUIDATION_ROLE_VAULT, await liquidationEngine.getAddress());
    await borrowModule.grantRole(LIQUIDATION_ROLE_BORROW, await liquidationEngine.getAddress());

    // SOL-H-01: Grant TIMELOCK_ROLE for admin setters (setCloseFactor, setFullLiquidationThreshold)
    const TIMELOCK_ROLE_LIQ = await liquidationEngine.TIMELOCK_ROLE();
    await liquidationEngine.grantRole(TIMELOCK_ROLE_LIQ, owner.address);

    // Mint tokens to users
    await weth.mint(user1.address, ethers.parseEther("100"));
    await weth.mint(liquidator.address, ethers.parseEther("100"));

    // Mint mUSD to liquidator for repayment (via owner minting)
    await musd.grantRole(BRIDGE_ROLE, owner.address);
    await musd.mint(liquidator.address, ethers.parseEther("100000"));

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

  async function deployMultiCollateralFixture() {
    const [owner, user1, , liquidator] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);
    const wbtc = await MockERC20.deploy("Wrapped Bitcoin", "WBTC", 8);

    const MUSD = await ethers.getContractFactory("MUSD");
    const musd = await MUSD.deploy(ethers.parseEther("100000000"), ethers.ZeroAddress);

    const PriceOracle = await ethers.getContractFactory("PriceOracle");
    const priceOracle = await PriceOracle.deploy();

    const MockAggregator = await ethers.getContractFactory("MockAggregatorV3");
    const ethFeed = await MockAggregator.deploy(8, 200000000000n); // $2000
    const btcFeed = await MockAggregator.deploy(8, 4000000000000n); // $40000

    await priceOracle.setFeed(await weth.getAddress(), await ethFeed.getAddress(), 3600, 18, 0);
    await priceOracle.setFeed(await wbtc.getAddress(), await btcFeed.getAddress(), 3600, 8, 0);

    const CollateralVault = await ethers.getContractFactory("CollateralVault");
    const collateralVault = await CollateralVault.deploy(ethers.ZeroAddress);
    // WETH: 75% LTV, 80% threshold, 10% penalty
    await collateralVault.addCollateral(await weth.getAddress(), 7500, 8000, 1000);
    // WBTC: 70% LTV, 75% threshold, 15% penalty
    await collateralVault.addCollateral(await wbtc.getAddress(), 7000, 7500, 1500);

    const BorrowModule = await ethers.getContractFactory("BorrowModule");
    const borrowModule = await BorrowModule.deploy(
      await collateralVault.getAddress(),
      await priceOracle.getAddress(),
      await musd.getAddress(),
      500,
      ethers.parseEther("100")
    );

    const LiquidationEngine = await ethers.getContractFactory("LiquidationEngine");
    const liquidationEngine = await LiquidationEngine.deploy(
      await collateralVault.getAddress(),
      await borrowModule.getAddress(),
      await priceOracle.getAddress(),
      await musd.getAddress(),
      5000,
      owner.address
    );

    const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
    await musd.grantRole(BRIDGE_ROLE, await borrowModule.getAddress());
    await musd.grantRole(BRIDGE_ROLE, await liquidationEngine.getAddress());
    await musd.grantRole(BRIDGE_ROLE, owner.address);
    await collateralVault.grantRole(await collateralVault.BORROW_MODULE_ROLE(), await borrowModule.getAddress());
    await collateralVault.grantRole(await collateralVault.LIQUIDATION_ROLE(), await liquidationEngine.getAddress());
    await borrowModule.grantRole(await borrowModule.LIQUIDATION_ROLE(), await liquidationEngine.getAddress());

    await weth.mint(user1.address, ethers.parseEther("100"));
    await wbtc.mint(user1.address, 500000000n); // 5 WBTC
    await musd.mint(liquidator.address, ethers.parseEther("500000"));

    await weth.connect(user1).approve(await collateralVault.getAddress(), ethers.MaxUint256);
    await wbtc.connect(user1).approve(await collateralVault.getAddress(), ethers.MaxUint256);
    await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), ethers.MaxUint256);

    return {
      liquidationEngine,
      borrowModule,
      collateralVault,
      musd,
      weth,
      wbtc,
      ethFeed,
      btcFeed,
      user1,
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

    it("Should set close factor correctly", async function () {
      const { liquidationEngine } = await loadFixture(deployLiquidationFixture);

      expect(await liquidationEngine.closeFactorBps()).to.equal(5000); // 50%
    });

    it("Should set full liquidation threshold", async function () {
      const { liquidationEngine } = await loadFixture(deployLiquidationFixture);

      const threshold = await liquidationEngine.fullLiquidationThreshold();
      expect(threshold).to.equal(5000); // HF < 0.5 allows 100% liquidation
    });
  });

  describe("Liquidation Eligibility", function () {
    it("Should correctly identify liquidatable positions", async function () {
      const { liquidationEngine, borrowModule, collateralVault, priceOracle, weth, ethFeed, user1 } =
        await loadFixture(deployLiquidationFixture);

      // Deposit 10 ETH ($20,000) and borrow 14,000 mUSD (70% utilization)
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);
      await borrowModule.connect(user1).borrow(ethers.parseEther("14000"));

      // Not liquidatable yet (health factor > 1.0)
      expect(await liquidationEngine.isLiquidatable(user1.address)).to.equal(false);

      // Drop ETH price to $1500 (25% drop)
      // New collateral value: 10 * 1500 = $15,000
      // Health factor = (15000 * 0.80) / 14000 = 0.857 < 1.0
      await ethFeed.setAnswer(150000000000n); // $1500
      // Update circuit breaker cache after price change
      await priceOracle.updatePrice(await weth.getAddress());

      expect(await liquidationEngine.isLiquidatable(user1.address)).to.equal(true);
    });

    it("Should return false for healthy positions", async function () {
      const { liquidationEngine, borrowModule, collateralVault, weth, user1 } =
        await loadFixture(deployLiquidationFixture);

      // Deposit 10 ETH ($20,000) and borrow only 5,000 mUSD (25% utilization)
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);
      await borrowModule.connect(user1).borrow(ethers.parseEther("5000"));

      expect(await liquidationEngine.isLiquidatable(user1.address)).to.equal(false);
    });

    it("Should return false for positions with no debt", async function () {
      const { liquidationEngine, collateralVault, weth, user1 } =
        await loadFixture(deployLiquidationFixture);

      // Deposit only, no borrow
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);

      expect(await liquidationEngine.isLiquidatable(user1.address)).to.equal(false);
    });
  });

  describe("Liquidation Execution", function () {
    it("Should liquidate undercollateralized position", async function () {
      const {
        liquidationEngine,
        borrowModule,
        collateralVault,
        priceOracle,
        musd,
        weth,
        ethFeed,
        user1,
        liquidator,
      } = await loadFixture(deployLiquidationFixture);

      // Setup: user1 deposits and borrows
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);
      await borrowModule.connect(user1).borrow(ethers.parseEther("14000"));

      // Make position liquidatable by dropping price
      await ethFeed.setAnswer(150000000000n); // $1500
      await priceOracle.updatePrice(await weth.getAddress());

      // Liquidator repays 5000 mUSD of debt
      const repayAmount = ethers.parseEther("5000");
      await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), repayAmount);

      const liquidatorWethBefore = await weth.balanceOf(liquidator.address);

      await liquidationEngine
        .connect(liquidator)
        .liquidate(user1.address, await weth.getAddress(), repayAmount);

      const liquidatorWethAfter = await weth.balanceOf(liquidator.address);
      expect(liquidatorWethAfter).to.be.gt(liquidatorWethBefore);
    });

    it("Should reduce borrower debt after liquidation", async function () {
      const {
        liquidationEngine,
        borrowModule,
        collateralVault,
        priceOracle,
        musd,
        weth,
        ethFeed,
        user1,
        liquidator,
      } = await loadFixture(deployLiquidationFixture);

      // Setup
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);
      await borrowModule.connect(user1).borrow(ethers.parseEther("14000"));

      const debtBefore = await borrowModule.totalDebt(user1.address);

      // Make liquidatable
      await ethFeed.setAnswer(150000000000n);
      await priceOracle.updatePrice(await weth.getAddress());

      // Liquidate
      const repayAmount = ethers.parseEther("5000");
      await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), repayAmount);
      await liquidationEngine
        .connect(liquidator)
        .liquidate(user1.address, await weth.getAddress(), repayAmount);

      const debtAfter = await borrowModule.totalDebt(user1.address);
      expect(debtAfter).to.be.lt(debtBefore);
    });

    it("Should reject liquidation of healthy position", async function () {
      const { liquidationEngine, borrowModule, collateralVault, musd, weth, user1, liquidator } =
        await loadFixture(deployLiquidationFixture);

      // Setup healthy position
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);
      await borrowModule.connect(user1).borrow(ethers.parseEther("5000")); // Low utilization

      const repayAmount = ethers.parseEther("1000");
      await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), repayAmount);

      await expect(
        liquidationEngine
          .connect(liquidator)
          .liquidate(user1.address, await weth.getAddress(), repayAmount)
      ).to.be.reverted;
    });

    it("Should reject self-liquidation", async function () {
      const { liquidationEngine, borrowModule, collateralVault, priceOracle, musd, weth, ethFeed, user1 } =
        await loadFixture(deployLiquidationFixture);

      // Setup
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);
      await borrowModule.connect(user1).borrow(ethers.parseEther("14000"));

      // Make liquidatable
      await ethFeed.setAnswer(150000000000n);
      await priceOracle.updatePrice(await weth.getAddress());

      // Try to self-liquidate
      const repayAmount = ethers.parseEther("5000");
      await musd.connect(user1).approve(await liquidationEngine.getAddress(), repayAmount);

      await expect(
        liquidationEngine
          .connect(user1)
          .liquidate(user1.address, await weth.getAddress(), repayAmount)
      ).to.be.reverted;
    });

    it("Should emit Liquidation event", async function () {
      const {
        liquidationEngine,
        borrowModule,
        collateralVault,
        priceOracle,
        musd,
        weth,
        ethFeed,
        user1,
        liquidator,
      } = await loadFixture(deployLiquidationFixture);

      // Setup
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);
      await borrowModule.connect(user1).borrow(ethers.parseEther("14000"));

      // Make liquidatable
      await ethFeed.setAnswer(150000000000n);
      await priceOracle.updatePrice(await weth.getAddress());

      const repayAmount = ethers.parseEther("5000");
      await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), repayAmount);

      await expect(
        liquidationEngine
          .connect(liquidator)
          .liquidate(user1.address, await weth.getAddress(), repayAmount)
      ).to.emit(liquidationEngine, "Liquidation");
    });
  });

  describe("Edge Cases: Multi-Collateral and Insolvency", function () {
    it("Should liquidate selected WETH collateral while leaving WBTC untouched", async function () {
      const { liquidationEngine, borrowModule, collateralVault, weth, wbtc, ethFeed, user1, liquidator } =
        await loadFixture(deployMultiCollateralFixture);

      await collateralVault.connect(user1).deposit(await weth.getAddress(), ethers.parseEther("10"));
      await collateralVault.connect(user1).deposit(await wbtc.getAddress(), 100000000n); // 1 WBTC
      await borrowModule.connect(user1).borrow(ethers.parseEther("40000"));

      // Crash ETH price to make position liquidatable.
      await ethFeed.setAnswer(50000000000n); // $500
      expect(await liquidationEngine.isLiquidatable(user1.address)).to.equal(true);

      const liquidatorWethBefore = await weth.balanceOf(liquidator.address);
      await liquidationEngine
        .connect(liquidator)
        .liquidate(user1.address, await weth.getAddress(), ethers.parseEther("2000"));
      const liquidatorWethAfter = await weth.balanceOf(liquidator.address);

      expect(liquidatorWethAfter).to.be.gt(liquidatorWethBefore);
      expect(await collateralVault.deposits(user1.address, await wbtc.getAddress())).to.equal(100000000n);
    });

    it("Should liquidate selected WBTC collateral while leaving WETH untouched", async function () {
      const { liquidationEngine, borrowModule, collateralVault, weth, wbtc, btcFeed, user1, liquidator } =
        await loadFixture(deployMultiCollateralFixture);

      await collateralVault.connect(user1).deposit(await weth.getAddress(), ethers.parseEther("10"));
      await collateralVault.connect(user1).deposit(await wbtc.getAddress(), 100000000n); // 1 WBTC
      await borrowModule.connect(user1).borrow(ethers.parseEther("40000"));

      // Crash BTC price to make position liquidatable.
      await btcFeed.setAnswer(1000000000000n); // $10,000
      expect(await liquidationEngine.isLiquidatable(user1.address)).to.equal(true);

      const liquidatorWbtcBefore = await wbtc.balanceOf(liquidator.address);
      await liquidationEngine
        .connect(liquidator)
        .liquidate(user1.address, await wbtc.getAddress(), ethers.parseEther("2000"));
      const liquidatorWbtcAfter = await wbtc.balanceOf(liquidator.address);

      expect(liquidatorWbtcAfter).to.be.gt(liquidatorWbtcBefore);
      expect(await collateralVault.deposits(user1.address, await weth.getAddress())).to.equal(ethers.parseEther("10"));
    });

    it("Should apply higher seize value for higher-penalty collateral", async function () {
      const { liquidationEngine, borrowModule, collateralVault, weth, wbtc, ethFeed, btcFeed, user1 } =
        await loadFixture(deployMultiCollateralFixture);

      await collateralVault.connect(user1).deposit(await weth.getAddress(), ethers.parseEther("10"));
      await collateralVault.connect(user1).deposit(await wbtc.getAddress(), 100000000n); // 1 WBTC
      await borrowModule.connect(user1).borrow(ethers.parseEther("30000"));

      await ethFeed.setAnswer(50000000000n); // $500
      await btcFeed.setAnswer(1000000000000n); // $10,000

      const repay = ethers.parseEther("1000");
      const wethEstimate = await liquidationEngine.estimateSeize(user1.address, await weth.getAddress(), repay);
      const wbtcEstimate = await liquidationEngine.estimateSeize(user1.address, await wbtc.getAddress(), repay);

      // Normalize seized amount into USD value at the same spot prices.
      const wethSeizeUsd = (wethEstimate * 50000000000n) / (10n ** 18n);
      const wbtcSeizeUsd = (wbtcEstimate * 1000000000000n) / (10n ** 8n);
      expect(wbtcSeizeUsd).to.be.gt(wethSeizeUsd);
    });

    it("Should leave residual debt when collateral is insufficient (insolvency edge case)", async function () {
      const { liquidationEngine, borrowModule, collateralVault, weth, ethFeed, user1, liquidator } =
        await loadFixture(deployMultiCollateralFixture);

      await collateralVault.connect(user1).deposit(await weth.getAddress(), ethers.parseEther("5")); // $10k
      await borrowModule.connect(user1).borrow(ethers.parseEther("7000"));

      // Severe crash: collateral now worth only $500.
      await ethFeed.setAnswer(10000000000n); // $100
      expect(await liquidationEngine.isLiquidatable(user1.address)).to.equal(true);

      const debtBefore = await borrowModule.totalDebt(user1.address);
      await liquidationEngine
        .connect(liquidator)
        .liquidate(user1.address, await weth.getAddress(), debtBefore);
      const debtAfter = await borrowModule.totalDebt(user1.address);

      expect(await collateralVault.deposits(user1.address, await weth.getAddress())).to.equal(0);
      expect(debtAfter).to.be.gt(0);
      expect(debtAfter).to.be.lt(debtBefore);

      await expect(
        liquidationEngine
          .connect(liquidator)
          .liquidate(user1.address, await weth.getAddress(), ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(liquidationEngine, "NothingToSeize");
    });
  });

  describe("Close Factor Limits", function () {
    it("Should respect close factor when position is not severely undercollateralized", async function () {
      const {
        liquidationEngine,
        borrowModule,
        collateralVault,
        priceOracle,
        musd,
        weth,
        ethFeed,
        user1,
        liquidator,
      } = await loadFixture(deployLiquidationFixture);

      // Setup
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);
      await borrowModule.connect(user1).borrow(ethers.parseEther("14000"));

      // Make slightly liquidatable (HF ~0.86, above fullLiquidationThreshold of 0.5)
      await ethFeed.setAnswer(150000000000n);
      await priceOracle.updatePrice(await weth.getAddress());

      // Try to repay 100% of debt (should be capped at close factor 50%)
      const fullDebt = await borrowModule.totalDebt(user1.address);
      await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), fullDebt);

      const debtBefore = await borrowModule.totalDebt(user1.address);
      await liquidationEngine
        .connect(liquidator)
        .liquidate(user1.address, await weth.getAddress(), fullDebt);
      const debtAfter = await borrowModule.totalDebt(user1.address);

      // Should have only liquidated ~50% (close factor)
      const reduction = debtBefore - debtAfter;
      expect(reduction).to.be.lte((debtBefore * 5100n) / 10000n); // ~50% with small tolerance
    });
  });

  describe("Estimate Functions", function () {
    it("Should estimate collateral seizure correctly", async function () {
      const { liquidationEngine, borrowModule, collateralVault, priceOracle, weth, ethFeed, user1 } =
        await loadFixture(deployLiquidationFixture);

      // Setup position
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);
      await borrowModule.connect(user1).borrow(ethers.parseEther("14000"));

      // Make liquidatable
      await ethFeed.setAnswer(150000000000n);
      await priceOracle.updatePrice(await weth.getAddress());

      const repayAmount = ethers.parseEther("5000");
      const estimate = await liquidationEngine.estimateSeize(
        user1.address,
        await weth.getAddress(),
        repayAmount
      );

      // Should return a positive amount
      expect(estimate).to.be.gt(0);
    });
  });

  describe("Admin Functions", function () {
    it("Should allow admin to update close factor", async function () {
      const { liquidationEngine, owner } = await loadFixture(deployLiquidationFixture);

      await timelockSetCloseFactor(liquidationEngine, owner, 6000); // 60%
      expect(await liquidationEngine.closeFactorBps()).to.equal(6000);
    });

    it("Should reject invalid close factor", async function () {
      const { liquidationEngine, owner } = await loadFixture(deployLiquidationFixture);

      // 0% and > 100% should be rejected
      await expect(liquidationEngine.connect(owner).setCloseFactor(0)).to.be.reverted;
      await expect(liquidationEngine.connect(owner).setCloseFactor(10001)).to.be.reverted;
    });

    it("Should allow admin to update full liquidation threshold", async function () {
      const { liquidationEngine, owner } = await loadFixture(deployLiquidationFixture);

      await timelockSetFullLiquidationThreshold(liquidationEngine, owner, 4000); // 40%
      expect(await liquidationEngine.fullLiquidationThreshold()).to.equal(4000);
    });

    it("Should reject non-admin setting close factor", async function () {
      const { liquidationEngine, user1 } = await loadFixture(deployLiquidationFixture);

      await expect(liquidationEngine.connect(user1).setCloseFactor(6000)).to.be.reverted;
    });
  });
});
