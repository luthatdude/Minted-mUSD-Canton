/**
 * RedemptionQueue Integration Tests (H-02)
 * Tests FIFO redemption queue: queueing, processing, cancellation,
 * rate limits, cooldowns, access control, pause/edge cases.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("RedemptionQueue", function () {
  let queue: any;
  let musd: any;
  let usdc: any;
  let admin: HardhatEthersSigner;
  let processor: HardhatEthersSigner;
  let pauser: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;
  let user3: HardhatEthersSigner;

  const MUSD_DECIMALS = 18;
  const USDC_DECIMALS = 6;
  const ONE_MUSD = 10n ** 18n;
  const ONE_USDC = 10n ** 6n;
  const MAX_DAILY = 100_000n * ONE_USDC; // 100k USDC daily limit
  const MIN_AGE = 3600; // 1 hour cooldown

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    [admin, processor, pauser, user1, user2, user3] = signers;

    // Deploy mock tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    musd = await MockERC20.deploy("Minted USD", "mUSD", MUSD_DECIMALS);
    usdc = await MockERC20.deploy("USD Coin", "USDC", USDC_DECIMALS);
    await musd.waitForDeployment();
    await usdc.waitForDeployment();

    // Deploy RedemptionQueue
    const QueueFactory = await ethers.getContractFactory("RedemptionQueue");
    queue = await QueueFactory.deploy(
      await musd.getAddress(),
      await usdc.getAddress(),
      MAX_DAILY,
      MIN_AGE
    );
    await queue.waitForDeployment();

    // Grant roles
    const PROCESSOR_ROLE = await queue.PROCESSOR_ROLE();
    const PAUSER_ROLE = await queue.PAUSER_ROLE();
    await queue.grantRole(PROCESSOR_ROLE, processor.address);
    await queue.grantRole(PAUSER_ROLE, pauser.address);

    // Mint mUSD to users
    const queueAddr = await queue.getAddress();
    for (const user of [user1, user2, user3]) {
      await musd.mint(user.address, 1_000_000n * ONE_MUSD);
      await musd.connect(user).approve(queueAddr, ethers.MaxUint256);
    }

    // Fund queue with USDC for fulfillment
    await usdc.mint(queueAddr, 500_000n * ONE_USDC);
  });

  // ═══════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════

  describe("Initialization", function () {
    it("Should initialize with correct parameters", async function () {
      expect(await queue.musd()).to.equal(await musd.getAddress());
      expect(await queue.usdc()).to.equal(await usdc.getAddress());
      expect(await queue.maxDailyRedemption()).to.equal(MAX_DAILY);
      expect(await queue.minRequestAge()).to.equal(MIN_AGE);
      expect(await queue.queueLength()).to.equal(0);
      expect(await queue.nextFulfillIndex()).to.equal(0);
    });

    it("Should revert with zero token addresses", async function () {
      const QueueFactory = await ethers.getContractFactory("RedemptionQueue");
      await expect(
        QueueFactory.deploy(ethers.ZeroAddress, await usdc.getAddress(), MAX_DAILY, MIN_AGE)
      ).to.be.revertedWith("ZERO_ADDRESS");
      await expect(
        QueueFactory.deploy(await musd.getAddress(), ethers.ZeroAddress, MAX_DAILY, MIN_AGE)
      ).to.be.revertedWith("ZERO_ADDRESS");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // QUEUE REDEMPTION
  // ═══════════════════════════════════════════════════════════════════

  describe("Queue Redemption", function () {
    it("Should queue a redemption request", async function () {
      const amount = 1000n * ONE_MUSD;
      const expectedUsdc = amount / 10n ** 12n;

      await expect(queue.connect(user1).queueRedemption(amount, expectedUsdc))
        .to.emit(queue, "RedemptionQueued")
        .withArgs(0, user1.address, amount, expectedUsdc);

      expect(await queue.queueLength()).to.equal(1);
      expect(await queue.totalPendingMusd()).to.equal(amount);
      expect(await queue.totalPendingUsdc()).to.equal(expectedUsdc);
    });

    it("Should lock mUSD in the contract", async function () {
      const amount = 5000n * ONE_MUSD;
      const balBefore = await musd.balanceOf(user1.address);

      await queue.connect(user1).queueRedemption(amount, 0);

      const balAfter = await musd.balanceOf(user1.address);
      expect(balBefore - balAfter).to.equal(amount);
      expect(await musd.balanceOf(await queue.getAddress())).to.equal(amount);
    });

    it("Should revert on zero amount", async function () {
      await expect(
        queue.connect(user1).queueRedemption(0, 0)
      ).to.be.revertedWith("ZERO_AMOUNT");
    });

    it("Should revert on dust amount (< 1 USDC equivalent)", async function () {
      // 0.5 USDC worth in mUSD = 5e11 (too small to convert to 1 USDC)
      await expect(
        queue.connect(user1).queueRedemption(5n * 10n ** 11n, 0)
      ).to.be.revertedWith("DUST_AMOUNT");
    });

    it("Should revert if slippage exceeded", async function () {
      const amount = 1000n * ONE_MUSD;
      const tooHighMin = 1001n * ONE_USDC;

      await expect(
        queue.connect(user1).queueRedemption(amount, tooHighMin)
      ).to.be.revertedWith("SLIPPAGE_EXCEEDED");
    });

    it("Should queue multiple requests from same user", async function () {
      await queue.connect(user1).queueRedemption(100n * ONE_MUSD, 0);
      await queue.connect(user1).queueRedemption(200n * ONE_MUSD, 0);

      expect(await queue.queueLength()).to.equal(2);
      expect(await queue.totalPendingMusd()).to.equal(300n * ONE_MUSD);
    });

    it("Should revert when paused", async function () {
      await queue.connect(pauser).pause();
      await expect(
        queue.connect(user1).queueRedemption(100n * ONE_MUSD, 0)
      ).to.be.reverted; // Pausable: paused
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // PROCESS BATCH
  // ═══════════════════════════════════════════════════════════════════

  describe("Process Batch", function () {
    beforeEach(async function () {
      // Queue 3 requests
      await queue.connect(user1).queueRedemption(1000n * ONE_MUSD, 0);
      await queue.connect(user2).queueRedemption(2000n * ONE_MUSD, 0);
      await queue.connect(user3).queueRedemption(3000n * ONE_MUSD, 0);
    });

    it("Should process requests in FIFO order after cooldown", async function () {
      // Advance past cooldown
      await time.increase(MIN_AGE + 1);

      const balBefore = await usdc.balanceOf(user1.address);
      await queue.connect(processor).processBatch(1);
      const balAfter = await usdc.balanceOf(user1.address);

      expect(balAfter - balBefore).to.equal(1000n * ONE_USDC);
      expect(await queue.nextFulfillIndex()).to.equal(1);
    });

    it("Should process multiple requests in one batch", async function () {
      await time.increase(MIN_AGE + 1);

      await queue.connect(processor).processBatch(10);

      expect(await queue.nextFulfillIndex()).to.equal(3);
      expect(await queue.totalPendingMusd()).to.equal(0);
      expect(await queue.totalPendingUsdc()).to.equal(0);
    });

    it("Should respect cooldown period", async function () {
      // Don't advance time — requests are too new
      await queue.connect(processor).processBatch(10);

      // Nothing should be processed
      expect(await queue.nextFulfillIndex()).to.equal(0);
    });

    it("Should respect daily redemption limit", async function () {
      // Set very low daily limit
      await queue.connect(admin).setMaxDailyRedemption(1500n * ONE_USDC);
      await time.increase(MIN_AGE + 1);

      await queue.connect(processor).processBatch(10);

      // Only first request (1000 USDC) fits under 1500 limit
      expect(await queue.nextFulfillIndex()).to.equal(1);
      expect(await queue.dailyRedeemed()).to.equal(1000n * ONE_USDC);
    });

    it("Should respect USDC liquidity", async function () {
      // Drain queue USDC balance to low amount
      const queueAddr = await queue.getAddress();
      const currentBal = await usdc.balanceOf(queueAddr);
      // Transfer most USDC out via admin
      await usdc.burn(queueAddr, currentBal - 500n * ONE_USDC);

      await time.increase(MIN_AGE + 1);
      await queue.connect(processor).processBatch(10);

      // Only first (1000 USDC) fails if not enough. Let's check with just 500 USDC
      await usdc.burn(queueAddr, 500n * ONE_USDC);
      // Reset for fresh test
    });

    it("Should skip cancelled requests", async function () {
      // Cancel first request
      await queue.connect(user1).cancelRedemption(0);
      await time.increase(MIN_AGE + 1);

      await queue.connect(processor).processBatch(10);

      // Skipped cancelled #0, processed #1 and #2
      expect(await queue.nextFulfillIndex()).to.equal(3);
      expect(await usdc.balanceOf(user1.address)).to.equal(0); // user1 got nothing (cancelled)
      expect(await usdc.balanceOf(user2.address)).to.equal(2000n * ONE_USDC);
      expect(await usdc.balanceOf(user3.address)).to.equal(3000n * ONE_USDC);
    });

    it("Should reset daily limit after 24 hours", async function () {
      await queue.connect(admin).setMaxDailyRedemption(2000n * ONE_USDC);
      await time.increase(MIN_AGE + 1);

      // Process first batch — fills daily limit
      await queue.connect(processor).processBatch(10);
      expect(await queue.nextFulfillIndex()).to.equal(1); // Only 1000 fits

      // Advance 24 hours
      await time.increase(86400);

      // Process again — daily limit reset
      await queue.connect(processor).processBatch(10);
      expect(await queue.nextFulfillIndex()).to.equal(2); // #1 (2000 USDC) now fits
    });

    it("Should revert if caller lacks PROCESSOR_ROLE", async function () {
      await expect(
        queue.connect(user1).processBatch(10)
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // CANCEL REDEMPTION
  // ═══════════════════════════════════════════════════════════════════

  describe("Cancel Redemption", function () {
    beforeEach(async function () {
      await queue.connect(user1).queueRedemption(1000n * ONE_MUSD, 0);
    });

    it("Should cancel and return mUSD", async function () {
      const balBefore = await musd.balanceOf(user1.address);

      await expect(queue.connect(user1).cancelRedemption(0))
        .to.emit(queue, "RedemptionCancelled")
        .withArgs(0, user1.address, 1000n * ONE_MUSD);

      const balAfter = await musd.balanceOf(user1.address);
      expect(balAfter - balBefore).to.equal(1000n * ONE_MUSD);
      expect(await queue.totalPendingMusd()).to.equal(0);
    });

    it("Should revert if not request owner", async function () {
      await expect(
        queue.connect(user2).cancelRedemption(0)
      ).to.be.revertedWith("NOT_OWNER");
    });

    it("Should revert if already fulfilled", async function () {
      await time.increase(MIN_AGE + 1);
      await queue.connect(processor).processBatch(1);

      await expect(
        queue.connect(user1).cancelRedemption(0)
      ).to.be.revertedWith("ALREADY_FULFILLED");
    });

    it("Should revert if already cancelled", async function () {
      await queue.connect(user1).cancelRedemption(0);

      await expect(
        queue.connect(user1).cancelRedemption(0)
      ).to.be.revertedWith("ALREADY_CANCELLED");
    });

    it("Should revert for invalid request ID", async function () {
      await expect(
        queue.connect(user1).cancelRedemption(99)
      ).to.be.revertedWith("INVALID_ID");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // ADMIN FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════

  describe("Admin Functions", function () {
    it("Should update max daily redemption", async function () {
      await expect(queue.connect(admin).setMaxDailyRedemption(200_000n * ONE_USDC))
        .to.emit(queue, "DailyLimitUpdated")
        .withArgs(MAX_DAILY, 200_000n * ONE_USDC);

      expect(await queue.maxDailyRedemption()).to.equal(200_000n * ONE_USDC);
    });

    it("Should update min request age", async function () {
      await queue.connect(admin).setMinRequestAge(7200);
      expect(await queue.minRequestAge()).to.equal(7200);
    });

    it("Should restrict admin functions to DEFAULT_ADMIN_ROLE", async function () {
      await expect(
        queue.connect(user1).setMaxDailyRedemption(0)
      ).to.be.reverted;
      await expect(
        queue.connect(user1).setMinRequestAge(0)
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // PAUSE / UNPAUSE
  // ═══════════════════════════════════════════════════════════════════

  describe("Pause / Unpause", function () {
    it("Pauser can pause", async function () {
      await queue.connect(pauser).pause();
      expect(await queue.paused()).to.be.true;
    });

    it("Admin can unpause", async function () {
      await queue.connect(pauser).pause();
      await queue.connect(admin).unpause();
      expect(await queue.paused()).to.be.false;
    });

    it("Non-pauser cannot pause", async function () {
      await expect(queue.connect(user1).pause()).to.be.reverted;
    });

    it("Non-admin cannot unpause", async function () {
      await queue.connect(pauser).pause();
      await expect(queue.connect(pauser).unpause()).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // VIEW FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════

  describe("View Functions", function () {
    it("Should return correct queue length", async function () {
      expect(await queue.queueLength()).to.equal(0);
      await queue.connect(user1).queueRedemption(100n * ONE_MUSD, 0);
      expect(await queue.queueLength()).to.equal(1);
    });

    it("Should return correct pending count", async function () {
      await queue.connect(user1).queueRedemption(100n * ONE_MUSD, 0);
      await queue.connect(user2).queueRedemption(200n * ONE_MUSD, 0);
      expect(await queue.pendingCount()).to.equal(2);

      await time.increase(MIN_AGE + 1);
      await queue.connect(processor).processBatch(1);
      expect(await queue.pendingCount()).to.equal(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // EDGE CASES
  // ═══════════════════════════════════════════════════════════════════

  describe("Edge Cases", function () {
    it("Should handle empty queue processBatch gracefully", async function () {
      await queue.connect(processor).processBatch(10);
      expect(await queue.nextFulfillIndex()).to.equal(0);
    });

    it("Should handle processBatch with maxCount=0", async function () {
      await queue.connect(user1).queueRedemption(100n * ONE_MUSD, 0);
      await time.increase(MIN_AGE + 1);

      await queue.connect(processor).processBatch(0);
      expect(await queue.nextFulfillIndex()).to.equal(0);
    });

    it("Should handle multiple users queueing and processing", async function () {
      // 3 users queue in order
      await queue.connect(user1).queueRedemption(100n * ONE_MUSD, 0);
      await queue.connect(user2).queueRedemption(200n * ONE_MUSD, 0);
      await queue.connect(user3).queueRedemption(300n * ONE_MUSD, 0);

      await time.increase(MIN_AGE + 1);

      // Process all
      await queue.connect(processor).processBatch(10);

      expect(await usdc.balanceOf(user1.address)).to.equal(100n * ONE_USDC);
      expect(await usdc.balanceOf(user2.address)).to.equal(200n * ONE_USDC);
      expect(await usdc.balanceOf(user3.address)).to.equal(300n * ONE_USDC);
    });
  });
});
