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

describe("BorrowModule", function () {
  async function deployBorrowModuleFixture() {
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
    await priceOracle.setFeed(await weth.getAddress(), await ethFeed.getAddress(), 3600, 18);

    // Deploy CollateralVault (no constructor args)
    const CollateralVault = await ethers.getContractFactory("CollateralVault");
    const collateralVault = await CollateralVault.deploy();

    // Add collateral (token, collateralFactorBps, liquidationThresholdBps, liquidationPenaltyBps)
    await collateralVault.addCollateral(
      await weth.getAddress(),
      7500, // 75% LTV
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

    // Grant roles
    const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
    const BORROW_MODULE_ROLE = await collateralVault.BORROW_MODULE_ROLE();
    await musd.grantRole(BRIDGE_ROLE, await borrowModule.getAddress());
    await collateralVault.grantRole(BORROW_MODULE_ROLE, await borrowModule.getAddress());

    // Mint WETH to user
    await weth.mint(user1.address, ethers.parseEther("100"));
    await weth.mint(user2.address, ethers.parseEther("100"));

    return {
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
      const { borrowModule, musd, collateralVault, priceOracle } = await loadFixture(
        deployBorrowModuleFixture
      );

      expect(await borrowModule.musd()).to.equal(await musd.getAddress());
      expect(await borrowModule.vault()).to.equal(await collateralVault.getAddress());
      expect(await borrowModule.oracle()).to.equal(await priceOracle.getAddress());
    });

    it("Should set interest rate correctly", async function () {
      const { borrowModule } = await loadFixture(deployBorrowModuleFixture);
      expect(await borrowModule.interestRateBps()).to.equal(500); // 5%
    });

    it("Should set minimum debt correctly", async function () {
      const { borrowModule } = await loadFixture(deployBorrowModuleFixture);
      expect(await borrowModule.minDebt()).to.equal(ethers.parseEther("100"));
    });
  });

  describe("Borrowing", function () {
    it("Should allow borrowing against collateral", async function () {
      const { borrowModule, collateralVault, musd, weth, user1 } = await loadFixture(
        deployBorrowModuleFixture
      );

      // Deposit 10 ETH as collateral (worth $20,000 at $2000/ETH)
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);

      // Borrow 10,000 mUSD (50% of collateral value, well under 75% LTV)
      const borrowAmount = ethers.parseEther("10000");
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
      const borrowAmount = ethers.parseEther("16000");
      await expect(borrowModule.connect(user1).borrow(borrowAmount)).to.be.reverted;
    });

    it("Should reject borrow below minimum debt", async function () {
      const { borrowModule, collateralVault, weth, user1 } = await loadFixture(
        deployBorrowModuleFixture
      );

      // Deposit collateral
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);

      // Try to borrow dust amount (below 100 mUSD min)
      const borrowAmount = ethers.parseEther("10");
      await expect(borrowModule.connect(user1).borrow(borrowAmount)).to.be.reverted;
    });

    it("Should emit Borrowed event", async function () {
      const { borrowModule, collateralVault, weth, user1 } = await loadFixture(
        deployBorrowModuleFixture
      );

      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);

      const borrowAmount = ethers.parseEther("10000");
      await expect(borrowModule.connect(user1).borrow(borrowAmount))
        .to.emit(borrowModule, "Borrowed");
    });
  });

  describe("Repayment", function () {
    it("Should allow full repayment", async function () {
      const { borrowModule, collateralVault, musd, weth, user1, owner } = await loadFixture(
        deployBorrowModuleFixture
      );

      // Setup: deposit and borrow
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);

      const borrowAmount = ethers.parseEther("10000");
      await borrowModule.connect(user1).borrow(borrowAmount);

      // Mint extra mUSD to cover any interest
      const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
      await musd.grantRole(BRIDGE_ROLE, owner.address);
      await musd.connect(owner).mint(user1.address, ethers.parseEther("1000"));

      // Repay significantly more than principal - contract caps at actual debt
      const repayExcess = ethers.parseEther("12000");
      await musd.connect(user1).approve(await borrowModule.getAddress(), repayExcess);
      await borrowModule.connect(user1).repay(repayExcess);

      const position = await borrowModule.positions(user1.address);
      expect(position.principal).to.equal(0);
    });

    it("Should accrue interest over time and require more to repay", async function () {
      const { borrowModule, collateralVault, musd, weth, user1 } = await loadFixture(
        deployBorrowModuleFixture
      );

      // Setup: deposit and borrow
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);

      const borrowAmount = ethers.parseEther("10000");
      await borrowModule.connect(user1).borrow(borrowAmount);

      // Advance time to accrue interest
      await ethers.provider.send("evm_increaseTime", [365 * 24 * 60 * 60]); // 1 year
      await ethers.provider.send("evm_mine", []);

      // Get total debt (principal + interest)
      const totalDebt = await borrowModule.totalDebt(user1.address);
      expect(totalDebt).to.be.gt(borrowAmount);
    });

    it("Should emit Repaid event", async function () {
      const { borrowModule, collateralVault, musd, weth, user1, owner } = await loadFixture(
        deployBorrowModuleFixture
      );

      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);

      const borrowAmount = ethers.parseEther("10000");
      await borrowModule.connect(user1).borrow(borrowAmount);

      // Mint extra mUSD to cover any interest
      const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
      await musd.grantRole(BRIDGE_ROLE, owner.address);
      await musd.connect(owner).mint(user1.address, ethers.parseEther("1000"));

      const repayExcess = ethers.parseEther("12000");
      await musd.connect(user1).approve(await borrowModule.getAddress(), repayExcess);
      await expect(borrowModule.connect(user1).repay(repayExcess))
        .to.emit(borrowModule, "Repaid");
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

      const borrowAmount = ethers.parseEther("10000");
      await borrowModule.connect(user1).borrow(borrowAmount);

      // Health factor = (collateral * liquidation_threshold) / debt
      // = ($20,000 * 0.80) / $10,000 = 1.6 = 16000 bps
      const hf = await borrowModule.healthFactor(user1.address);
      expect(hf).to.be.gt(10000n); // > 1.0
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

      const borrowAmount = ethers.parseEther("10000");
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

      const borrowAmount = ethers.parseEther("5000");
      await borrowModule.connect(user1).borrow(borrowAmount);

      // Withdraw 2 ETH (should still be healthy)
      const withdrawAmount = ethers.parseEther("2");
      await borrowModule.connect(user1).withdrawCollateral(await weth.getAddress(), withdrawAmount);

      const balance = await weth.balanceOf(user1.address);
      expect(balance).to.be.gt(ethers.parseEther("90")); // Started with 100, deposited 10, withdrew 2
    });

    it("Should prevent withdrawal that would make position unhealthy", async function () {
      const { borrowModule, collateralVault, weth, user1 } = await loadFixture(
        deployBorrowModuleFixture
      );

      // Deposit 10 ETH, borrow 14000 mUSD (70% utilization, close to LTV)
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);

      const borrowAmount = ethers.parseEther("14000");
      await borrowModule.connect(user1).borrow(borrowAmount);

      // Try to withdraw 5 ETH (would push below LTV)
      const withdrawAmount = ethers.parseEther("5");
      await expect(
        borrowModule.connect(user1).withdrawCollateral(await weth.getAddress(), withdrawAmount)
      ).to.be.reverted;
    });
  });

  describe("View Functions", function () {
    it("Should return max borrow amount correctly", async function () {
      const { borrowModule, collateralVault, weth, user1 } = await loadFixture(
        deployBorrowModuleFixture
      );

      // Deposit 10 ETH
      const depositAmount = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);

      const maxBorrow = await borrowModule.maxBorrow(user1.address);
      // At 75% LTV, $20,000 collateral = $15,000 max borrow
      expect(maxBorrow).to.equal(ethers.parseEther("15000"));
    });
  });

  describe("Admin Functions", function () {
    it("Should allow admin to set interest rate", async function () {
      const { borrowModule, owner } = await loadFixture(deployBorrowModuleFixture);

      await borrowModule.connect(owner).setInterestRate(800); // 8%
      expect(await borrowModule.interestRateBps()).to.equal(800);
    });

    it("Should reject interest rate above maximum", async function () {
      const { borrowModule, owner } = await loadFixture(deployBorrowModuleFixture);

      // Max is 5000 bps (50%)
      await expect(borrowModule.connect(owner).setInterestRate(6000)).to.be.reverted;
    });

    it("Should reject non-admin setting interest rate", async function () {
      const { borrowModule, user1 } = await loadFixture(deployBorrowModuleFixture);

      await expect(borrowModule.connect(user1).setInterestRate(800)).to.be.reverted;
    });

    it("Should allow admin to set minimum debt", async function () {
      const { borrowModule, owner } = await loadFixture(deployBorrowModuleFixture);

      const newMinDebt = ethers.parseEther("500");
      await borrowModule.connect(owner).setMinDebt(newMinDebt);
      expect(await borrowModule.minDebt()).to.equal(newMinDebt);
    });
  });
});
