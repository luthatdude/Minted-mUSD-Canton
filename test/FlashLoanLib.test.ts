// @ts-nocheck
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("FlashLoanLib", function () {
  // Provider enum values
  const AaveV3 = 0;
  const BalancerV3 = 1;
  const UniswapV3 = 2;

  async function deployFixture() {
    const Factory = await ethers.getContractFactory("FlashLoanLibHarness");
    const harness = await Factory.deploy();
    return { harness };
  }

  describe("calculateFlashLoanFee", function () {
    it("AaveV3 charges 0.05% fee", async function () {
      const { harness } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("1000");
      const fee = await harness.calculateFlashLoanFee(AaveV3, amount);
      // 0.05% = 5/10000
      expect(fee).to.equal(amount * 5n / 10000n);
    });

    it("BalancerV3 charges zero fee", async function () {
      const { harness } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("1000");
      const fee = await harness.calculateFlashLoanFee(BalancerV3, amount);
      expect(fee).to.equal(0n);
    });

    it("UniswapV3 charges 0.05% fee", async function () {
      const { harness } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("1000");
      const fee = await harness.calculateFlashLoanFee(UniswapV3, amount);
      expect(fee).to.equal(amount * 5n / 10000n);
    });

    it("returns 0 for zero amount (all providers)", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.calculateFlashLoanFee(AaveV3, 0)).to.equal(0n);
      expect(await harness.calculateFlashLoanFee(BalancerV3, 0)).to.equal(0n);
      expect(await harness.calculateFlashLoanFee(UniswapV3, 0)).to.equal(0n);
    });

    it("handles very large amounts without overflow", async function () {
      const { harness } = await loadFixture(deployFixture);
      const large = ethers.MaxUint256 / 10n; // avoid overflow in 5*amount
      const fee = await harness.calculateFlashLoanFee(AaveV3, large);
      expect(fee).to.equal(large * 5n / 10000n);
    });

    it("rounds down for small amounts", async function () {
      const { harness } = await loadFixture(deployFixture);
      // 1999 * 5 / 10000 = 0 (integer division)
      expect(await harness.calculateFlashLoanFee(AaveV3, 1999)).to.equal(0n);
      // 2000 * 5 / 10000 = 1
      expect(await harness.calculateFlashLoanFee(AaveV3, 2000)).to.equal(1n);
    });
  });

  describe("validateProvider", function () {
    it("AaveV3 is valid", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.validateProvider(AaveV3)).to.be.true;
    });

    it("BalancerV3 is valid", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.validateProvider(BalancerV3)).to.be.true;
    });

    it("UniswapV3 is valid", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.validateProvider(UniswapV3)).to.be.true;
    });
  });

  describe("isFreeLoan", function () {
    it("BalancerV3 is free", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.isFreeLoan(BalancerV3)).to.be.true;
    });

    it("AaveV3 is NOT free", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.isFreeLoan(AaveV3)).to.be.false;
    });

    it("UniswapV3 is NOT free", async function () {
      const { harness } = await loadFixture(deployFixture);
      expect(await harness.isFreeLoan(UniswapV3)).to.be.false;
    });
  });
});
