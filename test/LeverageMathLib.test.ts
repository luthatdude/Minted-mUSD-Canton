// @ts-nocheck
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("LeverageMathLib", function () {
  const WAD = ethers.parseEther("1"); // 1e18
  const BPS = 10_000n;

  async function deployFixture() {
    const Factory = await ethers.getContractFactory("LeverageMathLibHarness");
    const harness = await Factory.deploy();
    return { harness };
  }

  // ───────── calculateFlashLoanAmount ─────────
  describe("calculateFlashLoanAmount", function () {
    it("75% LTV → flash = deposit * 3 (4x leverage)", async function () {
      const { harness } = await loadFixture(deployFixture);
      const deposit = ethers.parseEther("100");
      const flash = await harness.calculateFlashLoanAmount(deposit, 7500);
      // 100 * 7500 / (10000-7500) = 100 * 7500 / 2500 = 300
      expect(flash).to.equal(ethers.parseEther("300"));
    });

    it("50% LTV → flash = deposit * 1 (2x leverage)", async function () {
      const { harness } = await loadFixture(deployFixture);
      const deposit = ethers.parseEther("100");
      const flash = await harness.calculateFlashLoanAmount(deposit, 5000);
      expect(flash).to.equal(ethers.parseEther("100"));
    });

    it("0% LTV → flash = 0", async function () {
      const { harness } = await loadFixture(deployFixture);
      const flash = await harness.calculateFlashLoanAmount(ethers.parseEther("100"), 0);
      expect(flash).to.equal(0n);
    });

    it("100% LTV (>= BPS) → returns 0", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.calculateFlashLoanAmount(ethers.parseEther("100"), 10000)).to.equal(0n);
    });

    it("over 100% LTV → returns 0", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.calculateFlashLoanAmount(ethers.parseEther("100"), 15000)).to.equal(0n);
    });

    it("zero deposit → zero flash", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.calculateFlashLoanAmount(0, 7500)).to.equal(0n);
    });
  });

  // ───────── ltvToLeverage ─────────
  describe("ltvToLeverage", function () {
    it("0% LTV → 1x leverage (100)", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.ltvToLeverage(0)).to.equal(100n);
    });

    it("50% LTV → 2x leverage (200)", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.ltvToLeverage(5000)).to.equal(200n);
    });

    it("75% LTV → 4x leverage (400)", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.ltvToLeverage(7500)).to.equal(400n);
    });

    it("100% LTV (>= BPS) → max uint256", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.ltvToLeverage(10000)).to.equal(ethers.MaxUint256);
    });

    it("over 100% LTV → max uint256", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.ltvToLeverage(20000)).to.equal(ethers.MaxUint256);
    });
  });

  // ───────── calculateLtv ─────────
  describe("calculateLtv", function () {
    it("50% LTV from equal collateral/debt ratio", async function () {
      const { harness } = await loadFixture(deployFixture);
      // debt=50, collateral=100 → 50%
      expect(await harness.calculateLtv(100, 50)).to.equal(5000n);
    });

    it("zero collateral → returns 0", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.calculateLtv(0, 100)).to.equal(0n);
    });

    it("zero debt → returns 0", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.calculateLtv(100, 0)).to.equal(0n);
    });

    it("100% LTV", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.calculateLtv(100, 100)).to.equal(10000n);
    });

    it("> 100% LTV (underwater)", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.calculateLtv(100, 200)).to.equal(20000n);
    });
  });

  // ───────── calculateHealthFactor ─────────
  describe("calculateHealthFactor", function () {
    it("collateral = debt → health factor = 1.0 (WAD)", async function () {
      const { harness } = await loadFixture(deployFixture);
      const col = ethers.parseEther("100");
      expect(await harness.calculateHealthFactor(col, col)).to.equal(WAD);
    });

    it("collateral = 2 * debt → health factor = 2.0", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.calculateHealthFactor(200, 100)).to.equal(2n * WAD);
    });

    it("zero debt → max uint256", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.calculateHealthFactor(100, 0)).to.equal(ethers.MaxUint256);
    });

    it("zero collateral with debt → health factor = 0", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.calculateHealthFactor(0, 100)).to.equal(0n);
    });
  });

  // ───────── calculateNetValue ─────────
  describe("calculateNetValue", function () {
    it("collateral > debt → positive net value", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.calculateNetValue(150, 100)).to.equal(50n);
    });

    it("collateral < debt → floors at 0", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.calculateNetValue(50, 100)).to.equal(0n);
    });

    it("collateral == debt → 0", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.calculateNetValue(100, 100)).to.equal(0n);
    });

    it("zero debt → net value = collateral", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.calculateNetValue(100, 0)).to.equal(100n);
    });
  });

  // ───────── calculateSharePrice ─────────
  describe("calculateSharePrice", function () {
    it("equal value and shares → 1.0 WAD", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.calculateSharePrice(100, 100)).to.equal(WAD);
    });

    it("zero shares → default 1.0 WAD", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.calculateSharePrice(100, 0)).to.equal(WAD);
    });

    it("value > shares → price > 1.0", async function () {
      const { harness } = await loadFixture(deployFixture);
      const price = await harness.calculateSharePrice(200, 100);
      expect(price).to.equal(2n * WAD);
    });

    it("value < shares → price < 1.0", async function () {
      const { harness } = await loadFixture(deployFixture);
      const price = await harness.calculateSharePrice(50, 100);
      expect(price).to.equal(WAD / 2n);
    });

    it("zero value + zero shares → 1.0 WAD", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.calculateSharePrice(0, 0)).to.equal(WAD);
    });
  });

  // ───────── needsRebalance ─────────
  describe("needsRebalance", function () {
    it("within threshold → no rebalance needed", async function () {
      const { harness } = await loadFixture(deployFixture);
      const [needs, over] = await harness.needsRebalance(7500, 7500, 200);
      expect(needs).to.be.false;
      expect(over).to.be.false;
    });

    it("over-leveraged beyond threshold → rebalance + over-leveraged", async function () {
      const { harness } = await loadFixture(deployFixture);
      // current 8000 > target 7500 + threshold 200 = 7700
      const [needs, over] = await harness.needsRebalance(8000, 7500, 200);
      expect(needs).to.be.true;
      expect(over).to.be.true;
    });

    it("under-leveraged beyond threshold → rebalance + not over-leveraged", async function () {
      const { harness } = await loadFixture(deployFixture);
      // current 7000 + threshold 200 = 7200 < target 7500
      const [needs, over] = await harness.needsRebalance(7000, 7500, 200);
      expect(needs).to.be.true;
      expect(over).to.be.false;
    });

    it("at exact threshold boundary → no rebalance", async function () {
      const { harness } = await loadFixture(deployFixture);
      // current = target + threshold exactly
      const [needs] = await harness.needsRebalance(7700, 7500, 200);
      expect(needs).to.be.false;
    });

    it("zero threshold → any difference triggers rebalance", async function () {
      const { harness } = await loadFixture(deployFixture);
      const [needs] = await harness.needsRebalance(7501, 7500, 0);
      expect(needs).to.be.true;
    });
  });

  // ───────── calculateDeleverageAmount ─────────
  describe("calculateDeleverageAmount", function () {
    it("excess debt when over target LTV", async function () {
      const { harness } = await loadFixture(deployFixture);
      // target debt = 100 * 7500 / 10000 = 75; actual = 90 → excess = 15
      expect(await harness.calculateDeleverageAmount(100, 90, 7500)).to.equal(15n);
    });

    it("zero excess when at target LTV", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.calculateDeleverageAmount(100, 75, 7500)).to.equal(0n);
    });

    it("zero excess when under target LTV", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.calculateDeleverageAmount(100, 50, 7500)).to.equal(0n);
    });

    it("zero collateral → target debt = 0, excess = full debt", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.calculateDeleverageAmount(0, 100, 7500)).to.equal(100n);
    });
  });

  // ───────── calculateReleverageAmount ─────────
  describe("calculateReleverageAmount", function () {
    it("deficit when under target LTV", async function () {
      const { harness } = await loadFixture(deployFixture);
      // target debt = 100 * 7500 / 10000 = 75; actual = 50 → deficit = 25
      expect(await harness.calculateReleverageAmount(100, 50, 7500)).to.equal(25n);
    });

    it("zero deficit when at target LTV", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.calculateReleverageAmount(100, 75, 7500)).to.equal(0n);
    });

    it("zero deficit when over target LTV", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.calculateReleverageAmount(100, 90, 7500)).to.equal(0n);
    });

    it("with large WAD-scaled values", async function () {
      const { harness } = await loadFixture(deployFixture);
      const col = ethers.parseEther("1000");
      const debt = ethers.parseEther("500");
      // target = 1000e18 * 7500 / 10000 = 750e18; deficit = 750-500 = 250
      expect(await harness.calculateReleverageAmount(col, debt, 7500))
        .to.equal(ethers.parseEther("250"));
    });
  });

  // ───────── validateSharePrice ─────────
  describe("validateSharePrice", function () {
    it("price above min → valid", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.validateSharePrice(WAD, WAD / 2n)).to.be.true;
    });

    it("price equal to min → valid", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.validateSharePrice(WAD, WAD)).to.be.true;
    });

    it("price below min → invalid", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.validateSharePrice(WAD / 2n, WAD)).to.be.false;
    });

    it("zero price, zero min → valid", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.validateSharePrice(0, 0)).to.be.true;
    });
  });
});
