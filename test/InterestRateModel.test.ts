// Test suite for InterestRateModel.sol
// Tests utilization-based interest rate calculations

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { InterestRateModel } from "../typechain-types";

describe("InterestRateModel", function () {
  async function deployFixture() {
    const [admin, user] = await ethers.getSigners();

    const InterestRateModel = await ethers.getContractFactory("InterestRateModel");
    const model = await InterestRateModel.deploy(admin.address);

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

      await model.connect(admin).setParams(
        300,   // 3% base
        1500,  // 15% multiplier
        7500,  // 75% kink
        6000,  // 60% jump
        1500   // 15% reserve
      );

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

      // Params that would result in > 100% max rate
      await expect(
        model.connect(admin).setParams(5000, 5000, 8000, 10000, 1000)
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
});
