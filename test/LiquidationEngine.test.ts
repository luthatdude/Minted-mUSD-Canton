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
import { timelockSetFeed, timelockRemoveFeed, timelockAddCollateral, timelockUpdateCollateral, timelockSetBorrowModule, timelockSetInterestRateModel, timelockSetSMUSD, timelockSetTreasury, timelockSetInterestRate, timelockSetMinDebt, timelockSetCloseFactor, timelockSetFullLiquidationThreshold, timelockAddStrategy, timelockRemoveStrategy, timelockSetFeeConfig, timelockSetReserveBps, timelockSetFees, timelockSetFeeRecipient, refreshFeeds } from "./helpers/timelock";

describe("LiquidationEngine", function () {
  async function deployLiquidationFixture() {
    const [owner, user1, user2, liquidator] = await ethers.getSigners();

    // Deploy mock tokens (18 decimals for WETH)
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);

    // Deploy MUSD with initial supply cap
    const MUSD = await ethers.getContractFactory("MUSD");
    const musd = await MUSD.deploy(ethers.parseEther("100000000")); // 100M cap

    // Deploy PriceOracle (no constructor args)
    const PriceOracle = await ethers.getContractFactory("PriceOracle");
    const priceOracle = await PriceOracle.deploy();

    // Deploy mock Chainlink aggregator (decimals, initialAnswer)
    const MockAggregator = await ethers.getContractFactory("MockAggregatorV3");
    const ethFeed = await MockAggregator.deploy(8, 200000000000n); // 8 decimals, $2000

    // Configure oracle feed (token, feed, stalePeriod, tokenDecimals)
    await timelockSetFeed(priceOracle, owner, await weth.getAddress(), await ethFeed.getAddress(), 3600, 18);

    // Deploy CollateralVault (no constructor args)
    const CollateralVault = await ethers.getContractFactory("CollateralVault");
    const collateralVault = await CollateralVault.deploy();

    // Add collateral with 80% liquidation threshold and 10% penalty
    await timelockAddCollateral(collateralVault, owner,
      await weth.getAddress(),
      7500, // 75% LTV (collateral factor)
      8000, // 80% liquidation threshold
      1000  // 10% liquidation penalty
    );

    await refreshFeeds(ethFeed);

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
      5000 // 50% close factor
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
      // FIX: Update circuit breaker cache after price change
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
      await expect(liquidationEngine.connect(owner).requestCloseFactor(0)).to.be.reverted;
      await expect(liquidationEngine.connect(owner).requestCloseFactor(10001)).to.be.reverted;
    });

    it("Should allow admin to update full liquidation threshold", async function () {
      const { liquidationEngine, owner } = await loadFixture(deployLiquidationFixture);

      await timelockSetFullLiquidationThreshold(liquidationEngine, owner, 4000); // 40%
      expect(await liquidationEngine.fullLiquidationThreshold()).to.equal(4000);
    });

    it("Should reject non-admin setting close factor", async function () {
      const { liquidationEngine, user1 } = await loadFixture(deployLiquidationFixture);

      await expect(liquidationEngine.connect(user1).requestCloseFactor(6000)).to.be.reverted;
    });
  });

  // ================================================================
  // FIX C-02: Bad Debt Detection & Socialization Tests
  // ================================================================
  describe("Bad Debt Detection (C-02)", function () {
    it("Should detect and record bad debt when liquidation exhausts all collateral", async function () {
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

      // User deposits 1 ETH ($2000) and borrows near max: 1400 mUSD (70% of $2000)
      const depositAmount = ethers.parseEther("1");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);
      await borrowModule.connect(user1).borrow(ethers.parseEther("1400"));

      // Crash ETH price to $100 — now 1 ETH = $100, debt = $1400
      // Collateral value ($100) << debt ($1400) → deep underwater
      await ethFeed.setAnswer(10000000000n); // $100
      await priceOracle.updatePrice(await weth.getAddress());

      // The position is liquidatable
      expect(await liquidationEngine.isLiquidatable(user1.address)).to.equal(true);

      // Full liquidation threshold (HF < 0.5) allows 100% close factor
      // seize = min(repayAmount * (1+penalty) / price, available)
      // With $100 ETH, all 1 ETH collateral gets seized, but debt remains

      // Liquidator tries to repay 1400 mUSD — but all collateral is only worth $100
      const repayAmount = ethers.parseEther("1400");
      await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), repayAmount);

      const tx = await liquidationEngine
        .connect(liquidator)
        .liquidate(user1.address, await weth.getAddress(), repayAmount);

      // Should emit BadDebtDetected
      await expect(tx).to.emit(liquidationEngine, "BadDebtDetected");

      // Should emit BadDebtRecorded on BorrowModule
      await expect(tx).to.emit(borrowModule, "BadDebtRecorded");

      // User should have zero collateral and zero debt (written off)
      expect(await collateralVault.deposits(user1.address, await weth.getAddress())).to.equal(0);
      expect(await borrowModule.totalDebt(user1.address)).to.equal(0);

      // Bad debt accumulator should be non-zero
      expect(await borrowModule.badDebt()).to.be.gt(0);
      expect(await borrowModule.cumulativeBadDebt()).to.be.gt(0);
    });

    it("Should NOT record bad debt when collateral remains after partial liquidation", async function () {
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

      // User deposits 10 ETH ($20,000) and borrows 14,000 mUSD
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);
      await borrowModule.connect(user1).borrow(ethers.parseEther("14000"));

      // Drop ETH price to $1500 — collateral = $15,000, debt = $14,000
      // Position is liquidatable but NOT underwater (collateral > debt)
      await ethFeed.setAnswer(150000000000n); // $1500
      await priceOracle.updatePrice(await weth.getAddress());

      // Partial liquidation (50% close factor caps it)
      const repayAmount = ethers.parseEther("5000");
      await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), repayAmount);

      const tx = await liquidationEngine
        .connect(liquidator)
        .liquidate(user1.address, await weth.getAddress(), repayAmount);

      // Should NOT emit BadDebtDetected
      await expect(tx).to.not.emit(liquidationEngine, "BadDebtDetected");

      // User should still have collateral remaining
      expect(await collateralVault.deposits(user1.address, await weth.getAddress())).to.be.gt(0);

      // No bad debt should be recorded
      expect(await borrowModule.badDebt()).to.equal(0);
    });

    it("Should cover bad debt by burning mUSD from reserves", async function () {
      const {
        liquidationEngine,
        borrowModule,
        collateralVault,
        priceOracle,
        musd,
        weth,
        ethFeed,
        owner,
        user1,
        liquidator,
      } = await loadFixture(deployLiquidationFixture);

      // Create a bad debt scenario
      const depositAmount = ethers.parseEther("1");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);
      await borrowModule.connect(user1).borrow(ethers.parseEther("1400"));

      // Crash ETH price to $100
      await ethFeed.setAnswer(10000000000n); // $100
      await priceOracle.updatePrice(await weth.getAddress());

      // Liquidate — creates bad debt
      const repayAmount = ethers.parseEther("1400");
      await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), repayAmount);
      await liquidationEngine
        .connect(liquidator)
        .liquidate(user1.address, await weth.getAddress(), repayAmount);

      const badDebtAmount = await borrowModule.badDebt();
      expect(badDebtAmount).to.be.gt(0);

      // Admin transfers mUSD to BorrowModule to cover bad debt
      await musd.mint(owner.address, badDebtAmount);
      await musd.connect(owner).transfer(await borrowModule.getAddress(), badDebtAmount);

      // Cover bad debt
      const tx = await borrowModule.connect(owner).coverBadDebt(badDebtAmount);
      await expect(tx).to.emit(borrowModule, "BadDebtCovered");

      // Bad debt should be zero now
      expect(await borrowModule.badDebt()).to.equal(0);
      // Cumulative should still reflect historical bad debt
      expect(await borrowModule.cumulativeBadDebt()).to.be.gt(0);
    });

    it("Should socialize bad debt as last resort", async function () {
      const {
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
      } = await loadFixture(deployLiquidationFixture);

      // Create a bad debt scenario
      const depositAmount = ethers.parseEther("1");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);
      await borrowModule.connect(user1).borrow(ethers.parseEther("1400"));

      // Crash ETH price
      await ethFeed.setAnswer(10000000000n); // $100
      await priceOracle.updatePrice(await weth.getAddress());

      // Liquidate — creates bad debt
      const repayAmount = ethers.parseEther("1400");
      await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), repayAmount);
      await liquidationEngine
        .connect(liquidator)
        .liquidate(user1.address, await weth.getAddress(), repayAmount);

      const badDebtAmount = await borrowModule.badDebt();
      expect(badDebtAmount).to.be.gt(0);

      // Socialize the bad debt (last resort)
      const tx = await borrowModule.connect(owner).socializeBadDebt(badDebtAmount);
      await expect(tx).to.emit(borrowModule, "BadDebtSocialized");

      // Bad debt accumulator should be cleared
      expect(await borrowModule.badDebt()).to.equal(0);
    });

    it("Should reject recordBadDebt from non-LIQUIDATION_ROLE", async function () {
      const { borrowModule, user1 } = await loadFixture(deployLiquidationFixture);

      await expect(borrowModule.connect(user1).recordBadDebt(user1.address)).to.be.reverted;
    });

    it("Should reject coverBadDebt from non-admin", async function () {
      const { borrowModule, user1 } = await loadFixture(deployLiquidationFixture);

      await expect(
        borrowModule.connect(user1).coverBadDebt(ethers.parseEther("100"))
      ).to.be.reverted;
    });

    it("Should reject socializeBadDebt from non-admin", async function () {
      const { borrowModule, user1 } = await loadFixture(deployLiquidationFixture);

      await expect(
        borrowModule.connect(user1).socializeBadDebt(ethers.parseEther("100"))
      ).to.be.reverted;
    });

    it("Should reject coverBadDebt when no bad debt exists", async function () {
      const { borrowModule, owner } = await loadFixture(deployLiquidationFixture);

      await expect(
        borrowModule.connect(owner).coverBadDebt(ethers.parseEther("100"))
      ).to.be.revertedWith("NO_BAD_DEBT");
    });

    it("Should reject socializeBadDebt when no bad debt exists", async function () {
      const { borrowModule, owner } = await loadFixture(deployLiquidationFixture);

      await expect(
        borrowModule.connect(owner).socializeBadDebt(ethers.parseEther("100"))
      ).to.be.revertedWith("NO_BAD_DEBT");
    });
  });
});
