// Test suite for InterestRateModel.sol
// Tests utilization-based interest rate calculations

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { InterestRateModel } from "../typechain-types";
import { timelockSetIRMParams } from "./helpers/timelock";

describe("InterestRateModel", function () {
  async function deployFixture() {
    const [admin, user] = await ethers.getSigners();

    const InterestRateModel = await ethers.getContractFactory("InterestRateModel");
    const model = await InterestRateModel.deploy(admin.address, admin.address);

    return { model, admin, user };
  }

  describe("Initialization", function () {
    it("Should set correct default parameters", async function () {
      const { model } = await loadFixture(deployFixture);

      expect(await model.baseRateBps()).to.equal(200);          // 2%
      expect(await model.multiplierBps()).to.equal(1000);       // 10%
      expect(await model.kinkBps()).to.equal(8000);             // 80%
      expect(await model.jumpMultiplierBps()).to.equal(5000);   // 50%
      expect(await model.reserveFactorBps()).to.equal(1000);    // 10%
    });

    it("Should grant RATE_ADMIN_ROLE to admin", async function () {
      const { model, admin } = await loadFixture(deployFixture);

      const RATE_ADMIN_ROLE = await model.RATE_ADMIN_ROLE();
      expect(await model.hasRole(RATE_ADMIN_ROLE, admin.address)).to.be.true;
    });
  });

  describe("Utilization Rate", function () {
    it("Should return 0 when no supply", async function () {
      const { model } = await loadFixture(deployFixture);

      expect(await model.utilizationRate(0, 0)).to.equal(0);
    });

    it("Should calculate utilization correctly", async function () {
      const { model } = await loadFixture(deployFixture);

      // 50% utilization
      const supply = ethers.parseEther("1000");
      const borrows = ethers.parseEther("500");
      expect(await model.utilizationRate(borrows, supply)).to.equal(5000);
    });

    it("Should cap at 100% utilization", async function () {
      const { model } = await loadFixture(deployFixture);

      // 150% borrows vs supply
      const supply = ethers.parseEther("1000");
      const borrows = ethers.parseEther("1500");
      expect(await model.utilizationRate(borrows, supply)).to.equal(10000);
    });
  });

  describe("Borrow Rate", function () {
    it("Should return base rate at 0% utilization", async function () {
      const { model } = await loadFixture(deployFixture);

      const supply = ethers.parseEther("1000");
      const borrows = ethers.parseEther("0");
      
      expect(await model.getBorrowRateAnnual(borrows, supply)).to.equal(200);
    });

    it("Should increase linearly below kink", async function () {
      const { model } = await loadFixture(deployFixture);

      const supply = ethers.parseEther("1000");
      
      // At 50% utilization: 200 + (5000 * 1000 / 10000) = 200 + 500 = 700
      const borrows50 = ethers.parseEther("500");
      expect(await model.getBorrowRateAnnual(borrows50, supply)).to.equal(700);

      // At 80% utilization (kink): 200 + (8000 * 1000 / 10000) = 200 + 800 = 1000
      const borrows80 = ethers.parseEther("800");
      expect(await model.getBorrowRateAnnual(borrows80, supply)).to.equal(1000);
    });

    it("Should jump above kink", async function () {
      const { model } = await loadFixture(deployFixture);

      const supply = ethers.parseEther("1000");
      
      // At 90% utilization:
      // normalRate = 200 + (8000 * 1000 / 10000) = 1000
      // excessUtil = 9000 - 8000 = 1000
      // total = 1000 + (1000 * 5000 / 10000) = 1000 + 500 = 1500
      const borrows90 = ethers.parseEther("900");
      expect(await model.getBorrowRateAnnual(borrows90, supply)).to.equal(1500);

      // At 100% utilization:
      // normalRate = 1000
      // excessUtil = 2000
      // total = 1000 + (2000 * 5000 / 10000) = 1000 + 1000 = 2000 (20%)
      const borrows100 = ethers.parseEther("1000");
      expect(await model.getBorrowRateAnnual(borrows100, supply)).to.equal(2000);
    });
  });

  describe("Supply Rate", function () {
    it("Should return 0 at 0% utilization", async function () {
      const { model } = await loadFixture(deployFixture);

      const supply = ethers.parseEther("1000");
      const borrows = ethers.parseEther("0");
      
      expect(await model.getSupplyRateAnnual(borrows, supply)).to.equal(0);
    });

    it("Should account for reserve factor", async function () {
      const { model } = await loadFixture(deployFixture);

      const supply = ethers.parseEther("1000");
      const borrows = ethers.parseEther("500"); // 50% util
      
      // BorrowRate = 700 bps
      // SupplyRate = 700 * 5000 * 9000 / (10000 * 10000) = 315 bps
      expect(await model.getSupplyRateAnnual(borrows, supply)).to.equal(315);
    });
  });

  describe("Interest Calculation", function () {
    it("Should calculate interest correctly", async function () {
      const { model } = await loadFixture(deployFixture);

      const principal = ethers.parseEther("1000");
      const supply = ethers.parseEther("10000");
      const borrows = ethers.parseEther("5000"); // 50% util
      const oneYear = 365 * 24 * 60 * 60;

      // At 50% util, borrow rate = 700 bps (7%)
      // Interest = 1000 * 0.07 = 70
      const interest = await model.calculateInterest(principal, borrows, supply, oneYear);
      expect(interest).to.be.closeTo(ethers.parseEther("70"), ethers.parseEther("1"));
    });

    it("Should return 0 for 0 principal or time", async function () {
      const { model } = await loadFixture(deployFixture);

      expect(await model.calculateInterest(0, 1000, 2000, 3600)).to.equal(0);
      expect(await model.calculateInterest(1000, 1000, 2000, 0)).to.equal(0);
    });
  });

  describe("Interest Splitting", function () {
    it("Should split interest according to reserve factor", async function () {
      const { model } = await loadFixture(deployFixture);

      const interest = ethers.parseEther("100");
      const [supplierAmount, reserveAmount] = await model.splitInterest(interest);

      // 10% reserve factor
      expect(reserveAmount).to.equal(ethers.parseEther("10"));
      expect(supplierAmount).to.equal(ethers.parseEther("90"));
    });
  });

  describe("Admin Functions", function () {
    it("Should allow RATE_ADMIN to update params", async function () {
      const { model, admin } = await loadFixture(deployFixture);

      await timelockSetIRMParams(model, admin, 300, 1500, 7500, 6000, 1500);

      expect(await model.baseRateBps()).to.equal(300);
      expect(await model.multiplierBps()).to.equal(1500);
      expect(await model.kinkBps()).to.equal(7500);
      expect(await model.jumpMultiplierBps()).to.equal(6000);
      expect(await model.reserveFactorBps()).to.equal(1500);
    });

    it("Should reject kink above 100%", async function () {
      const { model, admin } = await loadFixture(deployFixture);

      await expect(
        model.connect(admin).setParams(200, 1000, 15000, 5000, 1000)
      ).to.be.revertedWithCustomError(model, "KinkTooHigh");
    });

    it("Should reject reserve factor above 50%", async function () {
      const { model, admin } = await loadFixture(deployFixture);

      await expect(
        model.connect(admin).setParams(200, 1000, 8000, 5000, 6000)
      ).to.be.revertedWithCustomError(model, "ReserveFactorTooHigh");
    });

    it("Should reject max rate above 100%", async function () {
      const { model, admin } = await loadFixture(deployFixture);

      // maxRate = 2000 + (8000*5000)/10000 + (2000*10000)/10000 = 2000+4000+2000 = 8000 → OK
      // maxRate = 2000 + (8000*5000)/10000 + (2000*30000)/10000 = 2000+4000+6000 = 12000 → > 10000
      await expect(
        model.connect(admin).setParams(2000, 5000, 8000, 30000, 1000)
      ).to.be.revertedWithCustomError(model, "InvalidParameter");
    });

    it("Should reject non-admin updates", async function () {
      const { model, user } = await loadFixture(deployFixture);

      await expect(
        model.connect(user).setParams(300, 1500, 7500, 6000, 1500)
      ).to.be.reverted;
    });
  });

  describe("Rate Curve View", function () {
    it("Should return rate curve at 10% increments", async function () {
      const { model } = await loadFixture(deployFixture);

      const curve = await model.getRateCurve();

      // Verify 11 data points (0% to 100%)
      expect(curve.length).to.equal(11);

      // First point should be 0% util
      expect(curve[0][0]).to.equal(0);
      expect(curve[0][1]).to.equal(200); // Base rate
      expect(curve[0][2]).to.equal(0);   // Supply rate at 0 util

      // Last point should be 100% util
      expect(curve[10][0]).to.equal(10000);
      expect(curve[10][1]).to.equal(2000); // 20% borrow rate
    });
  });

  describe("View Functions", function () {
    it("Should return all params in one call", async function () {
      const { model } = await loadFixture(deployFixture);

      const [baseRate, multiplier, kink, jump, reserve] = await model.getParams();

      expect(baseRate).to.equal(200);
      expect(multiplier).to.equal(1000);
      expect(kink).to.equal(8000);
      expect(jump).to.equal(5000);
      expect(reserve).to.equal(1000);
    });
  });

  // ================================================================
  //  Per-Second Rate Tests (IRM-01 / IRM-02 regression)
  // ================================================================
  describe("Per-Second Rates (WAD-scaled)", function () {
    it("getBorrowRatePerSecond should NOT return 0 at typical utilization", async function () {
      const { model } = await loadFixture(deployFixture);

      const supply = ethers.parseEther("1000");
      const borrows = ethers.parseEther("500"); // 50% util → 700 BPS annual

      const perSecond = await model.getBorrowRatePerSecond(borrows, supply);
      // 700 * 1e18 / 31536000 ≈ 2.219e13 — must be > 0
      expect(perSecond).to.be.gt(0n);

      // Verify range: annual 700 BPS → per-second ≈ 2.219e13
      expect(perSecond).to.be.gt(2n * 10n ** 13n);
      expect(perSecond).to.be.lt(3n * 10n ** 13n);
    });

    it("getSupplyRatePerSecond should NOT return 0 at typical utilization", async function () {
      const { model } = await loadFixture(deployFixture);

      const supply = ethers.parseEther("1000");
      const borrows = ethers.parseEther("500"); // 50% util → supply rate 315 BPS annual

      const perSecond = await model.getSupplyRatePerSecond(borrows, supply);
      expect(perSecond).to.be.gt(0n);

      // 315 * 1e18 / 31536000 ≈ 9.99e12
      expect(perSecond).to.be.gt(9n * 10n ** 12n);
      expect(perSecond).to.be.lt(11n * 10n ** 12n);
    });

    it("Per-second borrow rate at 100% util should be highest", async function () {
      const { model } = await loadFixture(deployFixture);

      const supply = ethers.parseEther("1000");
      const rate50 = await model.getBorrowRatePerSecond(ethers.parseEther("500"), supply);
      const rate90 = await model.getBorrowRatePerSecond(ethers.parseEther("900"), supply);
      const rate100 = await model.getBorrowRatePerSecond(ethers.parseEther("1000"), supply);

      expect(rate100).to.be.gt(rate90);
      expect(rate90).to.be.gt(rate50);
    });

    it("Per-second rates at 0% utilization: borrow > 0 (base rate), supply = 0", async function () {
      const { model } = await loadFixture(deployFixture);

      const supply = ethers.parseEther("1000");
      const borrows = 0n;

      const borrowPerSec = await model.getBorrowRatePerSecond(borrows, supply);
      const supplyPerSec = await model.getSupplyRatePerSecond(borrows, supply);

      // Base rate 200 BPS → per-second > 0
      expect(borrowPerSec).to.be.gt(0n);
      // Supply rate at 0% util = 0 (no borrowing activity)
      expect(supplyPerSec).to.equal(0n);
    });
  });

  // ================================================================
  //  Enhanced Parameter Validation Tests (IRM-03/04/06)
  // ================================================================
  describe("Enhanced Parameter Validation", function () {
    it("Should reject baseRateBps > 2000 (20%)", async function () {
      const { model, admin } = await loadFixture(deployFixture);

      await expect(
        model.connect(admin).setParams(2100, 1000, 8000, 5000, 1000)
      ).to.be.revertedWithCustomError(model, "BaseRateTooHigh");
    });

    it("Should reject kinkBps < 1000 (10%)", async function () {
      const { model, admin } = await loadFixture(deployFixture);

      await expect(
        model.connect(admin).setParams(200, 1000, 500, 5000, 1000)
      ).to.be.revertedWithCustomError(model, "KinkTooLow");
    });

    it("Should reject multiplierBps = 0", async function () {
      const { model, admin } = await loadFixture(deployFixture);

      await expect(
        model.connect(admin).setParams(200, 0, 8000, 5000, 1000)
      ).to.be.revertedWithCustomError(model, "MultiplierZero");
    });

    it("Should reject jumpMultiplierBps = 0", async function () {
      const { model, admin } = await loadFixture(deployFixture);

      await expect(
        model.connect(admin).setParams(200, 1000, 8000, 0, 1000)
      ).to.be.revertedWithCustomError(model, "MultiplierZero");
    });

    it("Should accept valid params at boundary", async function () {
      const { model, admin } = await loadFixture(deployFixture);

      // Max allowed: baseRate=2000, kink=1000 (minimum), multiplier=1, jump=1
      // maxRate = 2000 + (1000*1)/10000 + ((10000-1000)*1)/10000 = 2000 + 0 + 0 = 2000
      await timelockSetIRMParams(model, admin, 2000, 1, 1000, 1, 0);
      expect(await model.baseRateBps()).to.equal(2000);
      expect(await model.kinkBps()).to.equal(1000);
    });
  });
});
