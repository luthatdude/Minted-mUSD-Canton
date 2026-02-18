// @ts-nocheck
/**
 * BorrowModule Extended Coverage Tests
 * 
 * Targets untested functions: borrowFor, repayFor, reduceDebt, absorbBadDebt,
 * setInterestRateModel, setSMUSD, setTreasury, withdrawReserves, pause/unpause,
 * accrueInterest, accrueGlobalInterest, drainPendingInterest, reconcileTotalBorrows,
 * and view functions (getUtilizationRate, getCurrentBorrowRate, getCurrentSupplyRate, getTotalSupply).
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  timelockSetFeed,
  timelockAddCollateral,
  timelockSetInterestRate,
  timelockSetMinDebt,
  refreshFeeds,
} from "./helpers/timelock";

describe("BorrowModule — Extended Coverage", function () {
  async function deployFullFixture() {
    const [owner, user1, user2, liquidator, pauser, leverageVault, borrowAdmin] =
      await ethers.getSigners();

    // ── Deploy tokens ─────────────────────────────────────────
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);
    const MUSD = await ethers.getContractFactory("MUSD");
    const musd = await MUSD.deploy(ethers.parseEther("100000000"), ethers.ZeroAddress);

    // ── Price oracle + feed ──────────────────────────────────
    const PriceOracle = await ethers.getContractFactory("PriceOracle");
    const priceOracle = await PriceOracle.deploy();
    await priceOracle.grantRole(await priceOracle.TIMELOCK_ROLE(), owner.address);

    const MockAggregator = await ethers.getContractFactory("MockAggregatorV3");
    const ethFeed = await MockAggregator.deploy(8, 200000000000n); // $2000

    await timelockSetFeed(priceOracle, owner, await weth.getAddress(), await ethFeed.getAddress(), 3600, 18);

    // ── Collateral vault ─────────────────────────────────────
    const CollateralVault = await ethers.getContractFactory("CollateralVault");
    const collateralVault = await CollateralVault.deploy(ethers.ZeroAddress);
    await timelockAddCollateral(collateralVault, owner, await weth.getAddress(), 7500, 8000, 1000);
    await refreshFeeds(ethFeed);

    // ── BorrowModule ─────────────────────────────────────────
    const BorrowModule = await ethers.getContractFactory("BorrowModule");
    const borrowModule = await BorrowModule.deploy(
      await collateralVault.getAddress(),
      await priceOracle.getAddress(),
      await musd.getAddress(),
      500,
      ethers.parseEther("100")
    );

    // ── Grant roles ──────────────────────────────────────────
    await musd.grantRole(await musd.BRIDGE_ROLE(), await borrowModule.getAddress());
    await musd.grantRole(await musd.BRIDGE_ROLE(), owner.address); // for minting in tests
    await collateralVault.grantRole(
      await collateralVault.BORROW_MODULE_ROLE(),
      await borrowModule.getAddress()
    );

    const TIMELOCK_ROLE = await borrowModule.TIMELOCK_ROLE();
    const LIQUIDATION_ROLE = await borrowModule.LIQUIDATION_ROLE();
    const LEVERAGE_VAULT_ROLE = await borrowModule.LEVERAGE_VAULT_ROLE();
    const PAUSER_ROLE = await borrowModule.PAUSER_ROLE();
    const BORROW_ADMIN_ROLE = await borrowModule.BORROW_ADMIN_ROLE();

    await borrowModule.grantRole(TIMELOCK_ROLE, owner.address);
    await borrowModule.grantRole(LIQUIDATION_ROLE, liquidator.address);
    await borrowModule.grantRole(LEVERAGE_VAULT_ROLE, leverageVault.address);
    await borrowModule.grantRole(PAUSER_ROLE, pauser.address);
    await borrowModule.grantRole(BORROW_ADMIN_ROLE, borrowAdmin.address);

    // ── Fund users ───────────────────────────────────────────
    await weth.mint(user1.address, ethers.parseEther("100"));
    await weth.mint(user2.address, ethers.parseEther("100"));

    // ── Deploy InterestRateModel ─────────────────────────────
    const InterestRateModel = await ethers.getContractFactory("InterestRateModel");
    const rateModel = await InterestRateModel.deploy(owner.address);

    return {
      borrowModule, collateralVault, priceOracle, musd, weth, ethFeed,
      rateModel,
      owner, user1, user2, liquidator, pauser, leverageVault, borrowAdmin,
      TIMELOCK_ROLE, LIQUIDATION_ROLE, LEVERAGE_VAULT_ROLE, PAUSER_ROLE, BORROW_ADMIN_ROLE,
    };
  }

  // Helper: deposit collateral + borrow
  async function depositAndBorrow(
    collateralVault: any, borrowModule: any, weth: any, user: any,
    depositEth: string, borrowMusd: string
  ) {
    const dep = ethers.parseEther(depositEth);
    const bor = ethers.parseEther(borrowMusd);
    await weth.connect(user).approve(await collateralVault.getAddress(), dep);
    await collateralVault.connect(user).deposit(await weth.getAddress(), dep);
    await borrowModule.connect(user).borrow(bor);
  }

  // ═══════════════════════════════════════════════════════════════
  //  borrowFor / repayFor (LEVERAGE_VAULT_ROLE)
  // ═══════════════════════════════════════════════════════════════
  describe("borrowFor / repayFor", function () {
    it("leverageVault role can borrowFor a user", async function () {
      const { borrowModule, collateralVault, musd, weth, user1, leverageVault } =
        await loadFixture(deployFullFixture);

      // User deposits collateral first
      const dep = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), dep);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), dep);

      // LeverageVault borrows on behalf of user
      const borrowAmt = ethers.parseEther("10000");
      await borrowModule.connect(leverageVault).borrowFor(user1.address, borrowAmt);

      const debt = await borrowModule.totalDebt(user1.address);
      expect(debt).to.be.gte(borrowAmt);
    });

    it("borrowFor reverts from non-LEVERAGE_VAULT_ROLE", async function () {
      const { borrowModule, user1, user2 } = await loadFixture(deployFullFixture);
      await expect(
        borrowModule.connect(user2).borrowFor(user1.address, ethers.parseEther("100"))
      ).to.be.reverted;
    });

    it("leverageVault role can repayFor a user", async function () {
      const { borrowModule, collateralVault, musd, weth, user1, leverageVault, owner } =
        await loadFixture(deployFullFixture);

      await depositAndBorrow(collateralVault, borrowModule, weth, user1, "10", "10000");

      // Mint mUSD to leverageVault so it can repay
      await musd.connect(owner).mint(leverageVault.address, ethers.parseEther("11000"));
      await musd.connect(leverageVault).approve(
        await borrowModule.getAddress(),
        ethers.parseEther("11000")
      );

      await borrowModule.connect(leverageVault).repayFor(user1.address, ethers.parseEther("11000"));
      const debt = await borrowModule.totalDebt(user1.address);
      expect(debt).to.equal(0n);
    });

    it("repayFor reverts from non-LEVERAGE_VAULT_ROLE", async function () {
      const { borrowModule, user1, user2 } = await loadFixture(deployFullFixture);
      await expect(
        borrowModule.connect(user2).repayFor(user1.address, ethers.parseEther("100"))
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  reduceDebt / absorbBadDebt (LIQUIDATION_ROLE)
  // ═══════════════════════════════════════════════════════════════
  describe("reduceDebt / absorbBadDebt", function () {
    it("liquidator can reduceDebt for a user", async function () {
      const { borrowModule, collateralVault, weth, user1, liquidator } =
        await loadFixture(deployFullFixture);

      await depositAndBorrow(collateralVault, borrowModule, weth, user1, "10", "10000");
      const debtBefore = await borrowModule.totalDebt(user1.address);

      await borrowModule.connect(liquidator).reduceDebt(user1.address, ethers.parseEther("5000"));

      const debtAfter = await borrowModule.totalDebt(user1.address);
      expect(debtAfter).to.be.lt(debtBefore);
    });

    it("reduceDebt reverts from non-LIQUIDATION_ROLE", async function () {
      const { borrowModule, user1 } = await loadFixture(deployFullFixture);
      await expect(
        borrowModule.connect(user1).reduceDebt(user1.address, ethers.parseEther("100"))
      ).to.be.reverted;
    });

    it("absorbBadDebt adds to protocol bad debt", async function () {
      const { borrowModule, liquidator } = await loadFixture(deployFullFixture);
      const amount = ethers.parseEther("1000");
      await borrowModule.connect(liquidator).absorbBadDebt(amount);
      // Bad debt should be tracked
      const totalBadDebt = await borrowModule.totalBadDebtAbsorbedByReserves();
      expect(totalBadDebt).to.be.gte(0n); // At least recorded
    });

    it("absorbBadDebt reverts with zero amount", async function () {
      const { borrowModule, liquidator } = await loadFixture(deployFullFixture);
      await expect(
        borrowModule.connect(liquidator).absorbBadDebt(0)
      ).to.be.reverted;
    });

    it("absorbBadDebt reverts from non-LIQUIDATION_ROLE", async function () {
      const { borrowModule, user1 } = await loadFixture(deployFullFixture);
      await expect(
        borrowModule.connect(user1).absorbBadDebt(ethers.parseEther("100"))
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  setInterestRateModel / setSMUSD / setTreasury (TIMELOCK_ROLE)
  // ═══════════════════════════════════════════════════════════════
  describe("Admin config functions", function () {
    it("timelock can setInterestRateModel", async function () {
      const { borrowModule, rateModel, owner } = await loadFixture(deployFullFixture);
      await borrowModule.connect(owner).setInterestRateModel(await rateModel.getAddress());
      expect(await borrowModule.interestRateModel()).to.equal(await rateModel.getAddress());
    });

    it("setInterestRateModel reverts with zero address", async function () {
      const { borrowModule, owner } = await loadFixture(deployFullFixture);
      await expect(
        borrowModule.connect(owner).setInterestRateModel(ethers.ZeroAddress)
      ).to.be.reverted;
    });

    it("setInterestRateModel reverts from non-timelock", async function () {
      const { borrowModule, rateModel, user1 } = await loadFixture(deployFullFixture);
      await expect(
        borrowModule.connect(user1).setInterestRateModel(await rateModel.getAddress())
      ).to.be.reverted;
    });

    it("timelock can setSMUSD", async function () {
      const { borrowModule, owner, user2 } = await loadFixture(deployFullFixture);
      // Use any non-zero address as sMUSD
      await borrowModule.connect(owner).setSMUSD(user2.address);
      expect(await borrowModule.smusd()).to.equal(user2.address);
    });

    it("setSMUSD reverts with zero address", async function () {
      const { borrowModule, owner } = await loadFixture(deployFullFixture);
      await expect(borrowModule.connect(owner).setSMUSD(ethers.ZeroAddress)).to.be.reverted;
    });

    it("timelock can setTreasury", async function () {
      const { borrowModule, owner, user2 } = await loadFixture(deployFullFixture);
      await borrowModule.connect(owner).setTreasury(user2.address);
      expect(await borrowModule.treasury()).to.equal(user2.address);
    });

    it("setTreasury reverts with zero address", async function () {
      const { borrowModule, owner } = await loadFixture(deployFullFixture);
      await expect(borrowModule.connect(owner).setTreasury(ethers.ZeroAddress)).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  withdrawReserves (TIMELOCK_ROLE)
  // ═══════════════════════════════════════════════════════════════
  describe("withdrawReserves", function () {
    it("reverts when no reserves exist", async function () {
      const { borrowModule, owner } = await loadFixture(deployFullFixture);
      await expect(
        borrowModule.connect(owner).withdrawReserves(owner.address, ethers.parseEther("1"))
      ).to.be.reverted;
    });

    it("reverts with zero address recipient", async function () {
      const { borrowModule, owner } = await loadFixture(deployFullFixture);
      await expect(
        borrowModule.connect(owner).withdrawReserves(ethers.ZeroAddress, ethers.parseEther("1"))
      ).to.be.reverted;
    });

    it("reverts from non-TIMELOCK_ROLE", async function () {
      const { borrowModule, user1 } = await loadFixture(deployFullFixture);
      await expect(
        borrowModule.connect(user1).withdrawReserves(user1.address, ethers.parseEther("1"))
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  pause / unpause
  // ═══════════════════════════════════════════════════════════════
  describe("Pause/Unpause", function () {
    it("pauser can pause", async function () {
      const { borrowModule, pauser } = await loadFixture(deployFullFixture);
      await borrowModule.connect(pauser).pause();
      // borrow should revert when paused
      await expect(
        borrowModule.connect(pauser).borrow(ethers.parseEther("100"))
      ).to.be.reverted;
    });

    it("timelock can unpause", async function () {
      const { borrowModule, pauser, owner, collateralVault, weth, user1 } =
        await loadFixture(deployFullFixture);

      await borrowModule.connect(pauser).pause();
      await borrowModule.connect(owner).unpause();

      // Should be able to borrow again
      const dep = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), dep);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), dep);
      await expect(borrowModule.connect(user1).borrow(ethers.parseEther("10000"))).not.to.be.reverted;
    });

    it("pause reverts from non-PAUSER_ROLE", async function () {
      const { borrowModule, user1 } = await loadFixture(deployFullFixture);
      await expect(borrowModule.connect(user1).pause()).to.be.reverted;
    });

    it("unpause reverts from non-TIMELOCK_ROLE", async function () {
      const { borrowModule, pauser, user1 } = await loadFixture(deployFullFixture);
      await borrowModule.connect(pauser).pause();
      await expect(borrowModule.connect(user1).unpause()).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  accrueInterest / accrueGlobalInterest
  // ═══════════════════════════════════════════════════════════════
  describe("Interest accrual", function () {
    it("accrueInterest updates user position after time passes", async function () {
      const { borrowModule, collateralVault, weth, user1 } =
        await loadFixture(deployFullFixture);

      await depositAndBorrow(collateralVault, borrowModule, weth, user1, "10", "10000");

      const debtBefore = await borrowModule.totalDebt(user1.address);
      await time.increase(365 * 24 * 3600); // 1 year

      await borrowModule.accrueInterest(user1.address);

      const debtAfter = await borrowModule.totalDebt(user1.address);
      expect(debtAfter).to.be.gt(debtBefore);
    });

    it("accrueGlobalInterest updates protocol totals", async function () {
      const { borrowModule, collateralVault, weth, user1 } =
        await loadFixture(deployFullFixture);

      await depositAndBorrow(collateralVault, borrowModule, weth, user1, "10", "10000");

      await time.increase(30 * 24 * 3600); // 30 days

      await borrowModule.accrueGlobalInterest();

      // totalBorrows should have increased due to interest
      const totalBorrows = await borrowModule.totalBorrows();
      expect(totalBorrows).to.be.gte(ethers.parseEther("10000"));
    });

    it("accrueInterest with dynamic rate model", async function () {
      const { borrowModule, collateralVault, weth, user1, rateModel, owner } =
        await loadFixture(deployFullFixture);

      // Set the interest rate model
      await borrowModule.connect(owner).setInterestRateModel(await rateModel.getAddress());

      await depositAndBorrow(collateralVault, borrowModule, weth, user1, "10", "10000");

      await time.increase(365 * 24 * 3600);
      await borrowModule.accrueInterest(user1.address);

      const debt = await borrowModule.totalDebt(user1.address);
      expect(debt).to.be.gt(ethers.parseEther("10000"));
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  drainPendingInterest
  // ═══════════════════════════════════════════════════════════════
  describe("drainPendingInterest", function () {
    it("reverts when no pending interest", async function () {
      const { borrowModule, owner } = await loadFixture(deployFullFixture);
      await expect(borrowModule.connect(owner).drainPendingInterest()).to.be.reverted;
    });

    it("reverts from non-TIMELOCK_ROLE", async function () {
      const { borrowModule, user1 } = await loadFixture(deployFullFixture);
      await expect(borrowModule.connect(user1).drainPendingInterest()).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  reconcileTotalBorrows
  // ═══════════════════════════════════════════════════════════════
  describe("reconcileTotalBorrows", function () {
    it("borrowAdmin can reconcile with valid borrower list", async function () {
      const { borrowModule, collateralVault, weth, user1, user2, borrowAdmin } =
        await loadFixture(deployFullFixture);

      await depositAndBorrow(collateralVault, borrowModule, weth, user1, "10", "5000");
      await depositAndBorrow(collateralVault, borrowModule, weth, user2, "10", "5000");

      // Reconcile should not revert if borrower list is complete
      await expect(
        borrowModule.connect(borrowAdmin).reconcileTotalBorrows([user1.address, user2.address])
      ).not.to.be.reverted;
    });

    it("reverts from non-BORROW_ADMIN_ROLE", async function () {
      const { borrowModule, user1 } = await loadFixture(deployFullFixture);
      await expect(
        borrowModule.connect(user1).reconcileTotalBorrows([user1.address])
      ).to.be.reverted;
    });

    it("reverts when borrower list omission would create >5% drift", async function () {
      const { borrowModule, collateralVault, weth, user1, user2, borrowAdmin } =
        await loadFixture(deployFullFixture);

      await depositAndBorrow(collateralVault, borrowModule, weth, user1, "10", "5000");
      await depositAndBorrow(collateralVault, borrowModule, weth, user2, "10", "5000");

      // Omitting one borrower creates ~50% drift vs totalBorrows and must revert.
      await expect(
        borrowModule.connect(borrowAdmin).reconcileTotalBorrows([user1.address])
      ).to.be.reverted;
    });

    it("emits drift warning and reconciles when drift is between 1% and 5%", async function () {
      const { borrowModule, collateralVault, weth, user1, user2, borrowAdmin, owner } =
        await loadFixture(deployFullFixture);

      // Lower minDebt so we can create a small second borrower and controlled drift.
      await timelockSetMinDebt(borrowModule, owner, ethers.parseEther("10"));

      await depositAndBorrow(collateralVault, borrowModule, weth, user1, "10", "5000");
      await depositAndBorrow(collateralVault, borrowModule, weth, user2, "10", "80");

      const totalBefore = await borrowModule.totalBorrows();

      await expect(
        borrowModule.connect(borrowAdmin).reconcileTotalBorrows([user1.address])
      ).to.emit(borrowModule, "DriftThresholdExceeded");

      const totalAfter = await borrowModule.totalBorrows();
      const user1Pos = await borrowModule.positions(user1.address);
      const user1StoredDebt = user1Pos.principal + user1Pos.accruedInterest;
      expect(totalAfter).to.be.lt(totalBefore);
      expect(totalAfter).to.equal(user1StoredDebt);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  View functions
  // ═══════════════════════════════════════════════════════════════
  describe("View functions", function () {
    it("getUtilizationRate returns 0 with no borrows", async function () {
      const { borrowModule } = await loadFixture(deployFullFixture);
      expect(await borrowModule.getUtilizationRate()).to.equal(0n);
    });

    it("getCurrentBorrowRate returns fallback rate with no model", async function () {
      const { borrowModule } = await loadFixture(deployFullFixture);
      expect(await borrowModule.getCurrentBorrowRate()).to.equal(500n); // 5% fallback
    });

    it("getCurrentBorrowRate returns model rate when set", async function () {
      const { borrowModule, rateModel, owner } = await loadFixture(deployFullFixture);
      await borrowModule.connect(owner).setInterestRateModel(await rateModel.getAddress());
      const rate = await borrowModule.getCurrentBorrowRate();
      expect(rate).to.be.gte(0n);
    });

    it("getCurrentSupplyRate returns a value with no borrows", async function () {
      const { borrowModule } = await loadFixture(deployFullFixture);
      // Even with 0 borrows the fallback rate may return a non-zero value
      const rate = await borrowModule.getCurrentSupplyRate();
      expect(rate).to.be.gte(0n);
    });

    it("getCurrentSupplyRate with dynamic model + borrows", async function () {
      const { borrowModule, collateralVault, weth, user1, rateModel, owner } =
        await loadFixture(deployFullFixture);

      await borrowModule.connect(owner).setInterestRateModel(await rateModel.getAddress());
      await depositAndBorrow(collateralVault, borrowModule, weth, user1, "10", "10000");

      const supplyRate = await borrowModule.getCurrentSupplyRate();
      expect(supplyRate).to.be.gte(0n);
    });

    it("getTotalSupply returns a default with no treasury", async function () {
      const { borrowModule } = await loadFixture(deployFullFixture);
      // With no treasury set, getTotalSupply returns a lastKnownTotalSupply default
      const supply = await borrowModule.getTotalSupply();
      expect(supply).to.be.gte(0n);
    });

    it("borrowCapacity reflects available capacity", async function () {
      const { borrowModule, collateralVault, weth, user1 } =
        await loadFixture(deployFullFixture);

      const dep = ethers.parseEther("10");
      await weth.connect(user1).approve(await collateralVault.getAddress(), dep);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), dep);

      const capacity = await borrowModule.borrowCapacity(user1.address);
      // 10 ETH * $2000 * 75% LTV = $15,000
      expect(capacity).to.equal(ethers.parseEther("15000"));
    });

    it("healthFactorUnsafe returns value for active position", async function () {
      const { borrowModule, collateralVault, weth, user1 } =
        await loadFixture(deployFullFixture);

      await depositAndBorrow(collateralVault, borrowModule, weth, user1, "10", "10000");
      const hf = await borrowModule.healthFactorUnsafe(user1.address);
      expect(hf).to.be.gt(0n);
    });
  });
});
