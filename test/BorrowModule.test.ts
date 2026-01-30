/**
 * BorrowModule Test Suite
 * Tests for the CDP (Collateralized Debt Position) borrowing functionality
 * 
 * CRITICAL: This contract has 0% test coverage - these tests are essential
 * before formal audit.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { BorrowModule, CollateralVault, PriceOracle, MUSD, MockERC20 } from "../typechain-types";

describe("BorrowModule", function () {
  async function deployBorrowModuleFixture() {
    const [owner, user1, user2, liquidator] = await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const weth = await MockERC20.deploy("Wrapped Ether", "WETH");
    const wbtc = await MockERC20.deploy("Wrapped Bitcoin", "WBTC");

    // Deploy MUSD
    const MUSD = await ethers.getContractFactory("MUSD");
    const musd = await MUSD.deploy();
    await musd.initialize(owner.address);

    // Deploy PriceOracle
    const PriceOracle = await ethers.getContractFactory("PriceOracle");
    const priceOracle = await PriceOracle.deploy();
    await priceOracle.initialize();

    // Deploy mock Chainlink aggregators
    const MockAggregator = await ethers.getContractFactory("MockAggregatorV3");
    const ethFeed = await MockAggregator.deploy(8); // 8 decimals
    const btcFeed = await MockAggregator.deploy(8);

    // Set prices: ETH = $2000, BTC = $40000
    await ethFeed.setAnswer(200000000000n); // $2000 with 8 decimals
    await btcFeed.setAnswer(4000000000000n); // $40000 with 8 decimals

    // Configure oracle feeds
    await priceOracle.setFeed(await weth.getAddress(), await ethFeed.getAddress(), 3600);
    await priceOracle.setFeed(await wbtc.getAddress(), await btcFeed.getAddress(), 3600);

    // Deploy CollateralVault
    const CollateralVault = await ethers.getContractFactory("CollateralVault");
    const collateralVault = await CollateralVault.deploy();
    await collateralVault.initialize(await priceOracle.getAddress());

    // Add collateral tokens
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

    // Grant roles
    const MINTER_ROLE = await musd.MINTER_ROLE();
    const BORROW_MODULE_ROLE = await collateralVault.BORROW_MODULE_ROLE();
    await musd.grantRole(MINTER_ROLE, await borrowModule.getAddress());
    await collateralVault.grantRole(BORROW_MODULE_ROLE, await borrowModule.getAddress());

    // Mint tokens to users
    await weth.mint(user1.address, ethers.parseEther("100"));
    await wbtc.mint(user1.address, ethers.parseUnits("10", 8)); // BTC has 8 decimals

    return {
      borrowModule,
      collateralVault,
      priceOracle,
      musd,
      weth,
      wbtc,
      ethFeed,
      btcFeed,
      owner,
      user1,
      user2,
      liquidator,
    };
  }

  describe("Deployment", function () {
    it("Should initialize with correct parameters", async function () {
      const { borrowModule, musd, collateralVault, priceOracle } = await loadFixture(
        deployBorrowModuleFixture
      );

      expect(await borrowModule.musd()).to.equal(await musd.getAddress());
      expect(await borrowModule.vault()).to.equal(await collateralVault.getAddress());
      expect(await borrowModule.oracle()).to.equal(await priceOracle.getAddress());
    });

    it("Should set default interest rate", async function () {
      const { borrowModule } = await loadFixture(deployBorrowModuleFixture);
      // Default interest rate should be reasonable (e.g., 5-10% APR)
      const rate = await borrowModule.interestRateBps();
      expect(rate).to.be.lte(1000); // Max 10%
    });
  });

  describe("Borrowing", function () {
    it("Should allow borrowing against collateral", async function () {
      const { borrowModule, collateralVault, musd, weth, user1 } = await loadFixture(
        deployBorrowModuleFixture
      );

      // Deposit 10 ETH as collateral (worth $20,000)
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);

      // Borrow 10,000 mUSD (50% of collateral value, well under 75% LTV)
      const borrowAmount = ethers.parseUnits("10000", 18);
      await borrowModule.connect(user1).borrow(borrowAmount);

      expect(await musd.balanceOf(user1.address)).to.equal(borrowAmount);
    });

    it("Should reject borrow exceeding LTV", async function () {
      const { borrowModule, collateralVault, weth, user1 } = await loadFixture(
        deployBorrowModuleFixture
      );

      // Deposit 10 ETH ($20,000 collateral)
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);

      // Try to borrow 16,000 mUSD (80% of collateral, exceeds 75% LTV)
      const borrowAmount = ethers.parseUnits("16000", 18);
      await expect(borrowModule.connect(user1).borrow(borrowAmount)).to.be.revertedWith(
        "EXCEEDS_BORROW_CAPACITY"
      );
    });

    it("Should reject borrow below minimum debt", async function () {
      const { borrowModule, collateralVault, weth, user1 } = await loadFixture(
        deployBorrowModuleFixture
      );

      // Deposit collateral
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);

      // Try to borrow dust amount
      const borrowAmount = ethers.parseUnits("1", 18); // 1 mUSD
      await expect(borrowModule.connect(user1).borrow(borrowAmount)).to.be.revertedWith(
        "BELOW_MIN_DEBT"
      );
    });
  });

  describe("Repayment", function () {
    it("Should allow full repayment", async function () {
      const { borrowModule, collateralVault, musd, weth, user1 } = await loadFixture(
        deployBorrowModuleFixture
      );

      // Setup: deposit and borrow
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);

      const borrowAmount = ethers.parseUnits("10000", 18);
      await borrowModule.connect(user1).borrow(borrowAmount);

      // Repay full amount
      await musd.connect(user1).approve(await borrowModule.getAddress(), borrowAmount);
      await borrowModule.connect(user1).repay(borrowAmount);

      const position = await borrowModule.getPosition(user1.address);
      expect(position.principal).to.equal(0);
    });

    it("Should apply repayment to interest first", async function () {
      const { borrowModule, collateralVault, musd, weth, user1 } = await loadFixture(
        deployBorrowModuleFixture
      );

      // Setup: deposit and borrow
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);

      const borrowAmount = ethers.parseUnits("10000", 18);
      await borrowModule.connect(user1).borrow(borrowAmount);

      // Advance time to accrue interest
      await ethers.provider.send("evm_increaseTime", [365 * 24 * 60 * 60]); // 1 year
      await ethers.provider.send("evm_mine", []);

      // Get total debt (principal + interest)
      const totalDebt = await borrowModule.totalDebt(user1.address);
      expect(totalDebt).to.be.gt(borrowAmount);

      // Partial repayment (should pay interest first)
      const partialPayment = ethers.parseUnits("500", 18);
      await musd.connect(user1).approve(await borrowModule.getAddress(), partialPayment);
      await borrowModule.connect(user1).repay(partialPayment);

      const position = await borrowModule.getPosition(user1.address);
      expect(position.accruedInterest).to.be.lt(totalDebt - borrowAmount);
    });
  });

  describe("Health Factor", function () {
    it("Should calculate correct health factor", async function () {
      const { borrowModule, collateralVault, weth, user1 } = await loadFixture(
        deployBorrowModuleFixture
      );

      // Deposit 10 ETH ($20,000) and borrow 10,000 mUSD
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);

      const borrowAmount = ethers.parseUnits("10000", 18);
      await borrowModule.connect(user1).borrow(borrowAmount);

      // Health factor = (collateral * liquidation_threshold) / debt
      // = ($20,000 * 0.80) / $10,000 = 1.6
      const hf = await borrowModule.healthFactor(user1.address);
      expect(hf).to.be.closeTo(16000n, 100n); // 1.6 in basis points (with small tolerance)
    });

    it("Should return max health factor with no debt", async function () {
      const { borrowModule, collateralVault, weth, user1 } = await loadFixture(
        deployBorrowModuleFixture
      );

      // Deposit collateral but don't borrow
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);

      const hf = await borrowModule.healthFactor(user1.address);
      expect(hf).to.equal(ethers.MaxUint256);
    });
  });

  describe("Interest Accrual", function () {
    it("Should accrue interest over time", async function () {
      const { borrowModule, collateralVault, weth, user1 } = await loadFixture(
        deployBorrowModuleFixture
      );

      // Setup: deposit and borrow
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);

      const borrowAmount = ethers.parseUnits("10000", 18);
      await borrowModule.connect(user1).borrow(borrowAmount);

      const debtBefore = await borrowModule.totalDebt(user1.address);

      // Advance 1 year
      await ethers.provider.send("evm_increaseTime", [365 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      const debtAfter = await borrowModule.totalDebt(user1.address);
      expect(debtAfter).to.be.gt(debtBefore);
    });
  });

  describe("Collateral Withdrawal", function () {
    it("Should allow withdrawal while maintaining health", async function () {
      const { borrowModule, collateralVault, weth, user1 } = await loadFixture(
        deployBorrowModuleFixture
      );

      // Deposit 10 ETH, borrow 5000 mUSD (25% utilization)
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);

      const borrowAmount = ethers.parseUnits("5000", 18);
      await borrowModule.connect(user1).borrow(borrowAmount);

      // Withdraw 2 ETH (should still be healthy)
      const withdrawAmount = ethers.parseEther("2");
      await borrowModule.connect(user1).withdrawCollateral(await weth.getAddress(), withdrawAmount);

      expect(await weth.balanceOf(user1.address)).to.equal(
        ethers.parseEther("100") - depositAmount + withdrawAmount
      );
    });

    it("Should prevent withdrawal that would make position unhealthy", async function () {
      const { borrowModule, collateralVault, weth, user1 } = await loadFixture(
        deployBorrowModuleFixture
      );

      // Deposit 10 ETH, borrow 14000 mUSD (70% utilization, close to LTV)
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);

      const borrowAmount = ethers.parseUnits("14000", 18);
      await borrowModule.connect(user1).borrow(borrowAmount);

      // Try to withdraw 5 ETH (would push below LTV)
      const withdrawAmount = ethers.parseEther("5");
      await expect(
        borrowModule.connect(user1).withdrawCollateral(await weth.getAddress(), withdrawAmount)
      ).to.be.revertedWith("WITHDRAWAL_WOULD_LIQUIDATE");
    });
  });

  describe("Admin Functions", function () {
    it("Should allow owner to set interest rate", async function () {
      const { borrowModule, owner } = await loadFixture(deployBorrowModuleFixture);

      await borrowModule.connect(owner).setInterestRate(800); // 8%
      expect(await borrowModule.interestRateBps()).to.equal(800);
    });

    it("Should reject interest rate above maximum", async function () {
      const { borrowModule, owner } = await loadFixture(deployBorrowModuleFixture);

      // Assuming max is 50% (5000 bps)
      await expect(borrowModule.connect(owner).setInterestRate(6000)).to.be.revertedWith(
        "RATE_TOO_HIGH"
      );
    });

    it("Should reject non-admin setting interest rate", async function () {
      const { borrowModule, user1 } = await loadFixture(deployBorrowModuleFixture);

      await expect(borrowModule.connect(user1).setInterestRate(800)).to.be.reverted;
    });
  });
});
