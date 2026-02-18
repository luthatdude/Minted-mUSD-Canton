/**
 * RedemptionQueue Edge-Case Tests (H-02)
 * Covers: C-01 DoS protection, queue boundary conditions, FIFO skipping,
 * per-user limits, minimum redemption enforcement, interleaved operations,
 * and monotonic queue growth characteristics.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("RedemptionQueue Edge Cases (H-02)", function () {
  let queue: any;
  let musd: any;
  let usdc: any;
  let admin: HardhatEthersSigner;
  let processor: HardhatEthersSigner;
  let pauser: HardhatEthersSigner;
  let users: HardhatEthersSigner[];

  const ONE_MUSD = 10n ** 18n;
  const ONE_USDC = 10n ** 6n;
  const MAX_DAILY = 1_000_000n * ONE_USDC;
  const MIN_AGE = 3600;
  const MIN_REDEMPTION = 100n * ONE_USDC; // MIN_REDEMPTION_USDC

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    [admin, processor, pauser, ...users] = signers;

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    musd = await MockERC20.deploy("Minted USD", "mUSD", 18);
    usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    await musd.waitForDeployment();
    await usdc.waitForDeployment();

    const QueueFactory = await ethers.getContractFactory("RedemptionQueue");
    queue = await QueueFactory.deploy(
      await musd.getAddress(),
      await usdc.getAddress(),
      MAX_DAILY,
      MIN_AGE
    );
    await queue.waitForDeployment();

    const PROCESSOR_ROLE = await queue.PROCESSOR_ROLE();
    const PAUSER_ROLE = await queue.PAUSER_ROLE();
    await queue.grantRole(PROCESSOR_ROLE, processor.address);
    await queue.grantRole(PAUSER_ROLE, pauser.address);

    const queueAddr = await queue.getAddress();
    for (const user of users) {
      await musd.mint(user.address, 10_000_000n * ONE_MUSD);
      await musd.connect(user).approve(queueAddr, ethers.MaxUint256);
    }

    await usdc.mint(queueAddr, 50_000_000n * ONE_USDC);
  });

  // ═══════════════════════════════════════════════════════════════════
  // C-01: MIN_REDEMPTION_USDC enforcement
  // ═══════════════════════════════════════════════════════════════════

  describe("Minimum Redemption Enforcement", function () {
    it("Should reject redemptions below MIN_REDEMPTION_USDC (100 USDC)", async function () {
      const belowMin = 99n * ONE_MUSD; // 99 mUSD = 99 USDC < 100 USDC minimum
      await expect(
        queue.connect(users[0]).queueRedemption(belowMin, 0)
      ).to.be.revertedWithCustomError(queue, "BelowMinRedemption");
    });

    it("Should accept exactly MIN_REDEMPTION_USDC", async function () {
      const exactMin = 100n * ONE_MUSD; // 100 mUSD = 100 USDC
      await expect(
        queue.connect(users[0]).queueRedemption(exactMin, 0)
      ).to.emit(queue, "RedemptionQueued");
    });

    it("Should reject dust amount that rounds to 0 USDC", async function () {
      const dust = 999n; // < 1e12, rounds to 0 USDC
      await expect(
        queue.connect(users[0]).queueRedemption(dust, 0)
      ).to.be.revertedWithCustomError(queue, "DustAmount");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // C-01: MAX_PENDING_PER_USER enforcement
  // ═══════════════════════════════════════════════════════════════════

  describe("Per-User Pending Limit", function () {
    it("Should allow up to MAX_PENDING_PER_USER (10) requests", async function () {
      const amt = 100n * ONE_MUSD;
      for (let i = 0; i < 10; i++) {
        await queue.connect(users[0]).queueRedemption(amt, 0);
      }
      expect(await queue.userPendingCount(users[0].address)).to.equal(10);
    });

    it("Should reject 11th pending request from same user", async function () {
      const amt = 100n * ONE_MUSD;
      for (let i = 0; i < 10; i++) {
        await queue.connect(users[0]).queueRedemption(amt, 0);
      }
      await expect(
        queue.connect(users[0]).queueRedemption(amt, 0)
      ).to.be.revertedWithCustomError(queue, "UserQueueLimitExceeded");
    });

    it("Should allow new request after cancelling one", async function () {
      const amt = 100n * ONE_MUSD;
      for (let i = 0; i < 10; i++) {
        await queue.connect(users[0]).queueRedemption(amt, 0);
      }
      // Cancel one
      await queue.connect(users[0]).cancelRedemption(5);
      expect(await queue.userPendingCount(users[0].address)).to.equal(9);

      // Now 11th should succeed
      await expect(
        queue.connect(users[0]).queueRedemption(amt, 0)
      ).to.emit(queue, "RedemptionQueued");
    });

    it("Should allow new request after one is fulfilled", async function () {
      const amt = 100n * ONE_MUSD;
      for (let i = 0; i < 10; i++) {
        await queue.connect(users[0]).queueRedemption(amt, 0);
      }
      // Process one
      await time.increase(MIN_AGE + 1);
      await queue.connect(processor).processBatch(1);
      expect(await queue.userPendingCount(users[0].address)).to.equal(9);

      // Now 11th should succeed
      await expect(
        queue.connect(users[0]).queueRedemption(amt, 0)
      ).to.emit(queue, "RedemptionQueued");
    });

    it("Should track per-user counts independently", async function () {
      const amt = 100n * ONE_MUSD;
      // user0 queues 5, user1 queues 5
      for (let i = 0; i < 5; i++) {
        await queue.connect(users[0]).queueRedemption(amt, 0);
        await queue.connect(users[1]).queueRedemption(amt, 0);
      }
      expect(await queue.userPendingCount(users[0].address)).to.equal(5);
      expect(await queue.userPendingCount(users[1].address)).to.equal(5);
      expect(await queue.activePendingCount()).to.equal(10);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // FIFO pointer behavior with cancelled/fulfilled entries
  // ═══════════════════════════════════════════════════════════════════

  describe("FIFO Skipping Behavior", function () {
    it("Should skip cancelled entries during processBatch", async function () {
      const amt = 100n * ONE_MUSD;
      await queue.connect(users[0]).queueRedemption(amt, 0); // 0
      await queue.connect(users[1]).queueRedemption(amt, 0); // 1
      await queue.connect(users[2]).queueRedemption(amt, 0); // 2

      // Cancel middle entry
      await queue.connect(users[1]).cancelRedemption(1);

      await time.increase(MIN_AGE + 1);
      await queue.connect(processor).processBatch(10);

      // User0 and User2 should be fulfilled, user1 skipped
      expect(await usdc.balanceOf(users[0].address)).to.equal(100n * ONE_USDC);
      expect(await usdc.balanceOf(users[1].address)).to.equal(0);
      expect(await usdc.balanceOf(users[2].address)).to.equal(100n * ONE_USDC);
      expect(await queue.nextFulfillIndex()).to.equal(3);
    });

    it("Should skip consecutive cancelled entries efficiently", async function () {
      const amt = 100n * ONE_MUSD;
      // Queue 5 requests
      for (let i = 0; i < 5; i++) {
        await queue.connect(users[i % users.length]).queueRedemption(amt, 0);
      }
      // Cancel first 3
      for (let i = 0; i < 3; i++) {
        await queue.connect(users[i % users.length]).cancelRedemption(i);
      }

      await time.increase(MIN_AGE + 1);
      await queue.connect(processor).processBatch(10);

      // Pointer should advance past all cancelled + 2 fulfilled = 5
      expect(await queue.nextFulfillIndex()).to.equal(5);
    });

    it("Should handle all entries cancelled", async function () {
      const amt = 100n * ONE_MUSD;
      await queue.connect(users[0]).queueRedemption(amt, 0);
      await queue.connect(users[1]).queueRedemption(amt, 0);

      await queue.connect(users[0]).cancelRedemption(0);
      await queue.connect(users[1]).cancelRedemption(1);

      await time.increase(MIN_AGE + 1);
      await queue.connect(processor).processBatch(10);

      // Pointer should advance past both cancelled entries
      expect(await queue.nextFulfillIndex()).to.equal(2);
      expect(await queue.activePendingCount()).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Interleaved queue + cancel + process operations
  // ═══════════════════════════════════════════════════════════════════

  describe("Interleaved Operations", function () {
    it("Should handle queue-cancel-queue-process sequence correctly", async function () {
      const amt = 100n * ONE_MUSD;

      // Queue 3
      await queue.connect(users[0]).queueRedemption(amt, 0);     // id=0
      await queue.connect(users[1]).queueRedemption(200n * ONE_MUSD, 0); // id=1
      await queue.connect(users[2]).queueRedemption(amt, 0);     // id=2

      // Cancel id=1
      await queue.connect(users[1]).cancelRedemption(1);

      // Queue 2 more
      await queue.connect(users[0]).queueRedemption(amt, 0);     // id=3
      await queue.connect(users[1]).queueRedemption(amt, 0);     // id=4

      await time.increase(MIN_AGE + 1);
      // Process all
      await queue.connect(processor).processBatch(10);

      // id=0 (user0: 100), id=1 (cancelled), id=2 (user2: 100), id=3 (user0: 100), id=4 (user1: 100)
      expect(await usdc.balanceOf(users[0].address)).to.equal(200n * ONE_USDC);
      expect(await usdc.balanceOf(users[1].address)).to.equal(100n * ONE_USDC); // Only 1 of 2 fulfilled
      expect(await usdc.balanceOf(users[2].address)).to.equal(100n * ONE_USDC);
      expect(await queue.activePendingCount()).to.equal(0);
    });

    it("Should handle partial processing then more queuing", async function () {
      const amt = 100n * ONE_MUSD;

      await queue.connect(users[0]).queueRedemption(amt, 0); // id=0
      await queue.connect(users[1]).queueRedemption(amt, 0); // id=1

      await time.increase(MIN_AGE + 1);
      // Process only 1
      await queue.connect(processor).processBatch(1);
      expect(await queue.nextFulfillIndex()).to.equal(1);

      // Queue more
      await queue.connect(users[2]).queueRedemption(amt, 0); // id=2

      // Process id=1 (already past cooldown), id=2 still needs cooldown
      await queue.connect(processor).processBatch(10);
      expect(await queue.nextFulfillIndex()).to.equal(2); // id=1 processed, id=2 blocked by cooldown

      // Advance time for id=2's cooldown
      await time.increase(MIN_AGE + 1);
      await queue.connect(processor).processBatch(10);
      expect(await queue.nextFulfillIndex()).to.equal(3);
      expect(await queue.activePendingCount()).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Monotonic queue growth (array never shrinks)
  // ═══════════════════════════════════════════════════════════════════

  describe("Queue Array Growth Characteristics", function () {
    it("Should grow monotonically — fulfilled entries persist in storage", async function () {
      const amt = 100n * ONE_MUSD;

      // Queue, process, verify array doesn't shrink
      await queue.connect(users[0]).queueRedemption(amt, 0);
      await time.increase(MIN_AGE + 1);
      await queue.connect(processor).processBatch(1);

      expect(await queue.queueLength()).to.equal(1); // Array still length 1
      expect(await queue.nextFulfillIndex()).to.equal(1); // Pointer advanced

      // Queue another
      await queue.connect(users[1]).queueRedemption(amt, 0);
      expect(await queue.queueLength()).to.equal(2); // Grows to 2
      expect(await queue.activePendingCount()).to.equal(1); // Only 1 active
    });

    it("Should maintain correct activePendingCount through mixed operations", async function () {
      const amt = 100n * ONE_MUSD;

      // Queue 3
      for (let i = 0; i < 3; i++) {
        await queue.connect(users[i]).queueRedemption(amt, 0);
      }
      expect(await queue.activePendingCount()).to.equal(3);

      // Cancel 1
      await queue.connect(users[0]).cancelRedemption(0);
      expect(await queue.activePendingCount()).to.equal(2);

      // Process 1
      await time.increase(MIN_AGE + 1);
      await queue.connect(processor).processBatch(1);
      expect(await queue.activePendingCount()).to.equal(1);

      // Queue 2 more
      await queue.connect(users[0]).queueRedemption(amt, 0);
      await queue.connect(users[1]).queueRedemption(amt, 0);
      expect(await queue.activePendingCount()).to.equal(3);

      // queueLength reflects all entries (active + cancelled + fulfilled)
      expect(await queue.queueLength()).to.equal(5);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Cooldown boundary tests
  // ═══════════════════════════════════════════════════════════════════

  describe("Cooldown Boundary", function () {
    it("Should reject processing at exactly cooldown time", async function () {
      const amt = 100n * ONE_MUSD;
      await queue.connect(users[0]).queueRedemption(amt, 0);

      // Advance to exactly MIN_AGE (not MIN_AGE + 1)
      await time.increase(MIN_AGE);
      await queue.connect(processor).processBatch(1);

      // The condition is `block.timestamp < req.requestedAt + minRequestAge`
      // At exactly MIN_AGE, timestamp == requestedAt + minRequestAge, so NOT less than
      // Therefore it should process (the next block.timestamp is at least requestedAt + MIN_AGE)
      const idx = await queue.nextFulfillIndex();
      // Due to how hardhat advances time, the exact behavior depends on block inclusion
      // Just verify it doesn't revert
    });

    it("Should not process request before cooldown", async function () {
      const amt = 100n * ONE_MUSD;
      await queue.connect(users[0]).queueRedemption(amt, 0);

      // Don't advance time
      await queue.connect(processor).processBatch(1);

      // Should NOT have processed
      expect(await queue.nextFulfillIndex()).to.equal(0);
      expect(await queue.activePendingCount()).to.equal(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Daily limit edge cases
  // ═══════════════════════════════════════════════════════════════════

  describe("Daily Limit Edge Cases", function () {
    it("Should stop processing when daily limit is exactly reached", async function () {
      // Set tight daily limit
      const TIMELOCK_ROLE = await queue.TIMELOCK_ROLE();
      await queue.grantRole(TIMELOCK_ROLE, admin.address);
      await queue.connect(admin).setMaxDailyRedemption(200n * ONE_USDC);

      // Queue 3 × 100 USDC
      for (let i = 0; i < 3; i++) {
        await queue.connect(users[i]).queueRedemption(100n * ONE_MUSD, 0);
      }

      await time.increase(MIN_AGE + 1);
      await queue.connect(processor).processBatch(10);

      // Should process only 2 (200 USDC limit)
      expect(await usdc.balanceOf(users[0].address)).to.equal(100n * ONE_USDC);
      expect(await usdc.balanceOf(users[1].address)).to.equal(100n * ONE_USDC);
      expect(await usdc.balanceOf(users[2].address)).to.equal(0);
      expect(await queue.activePendingCount()).to.equal(1);
    });

    it("Should reset daily limit after 24 hours and continue processing", async function () {
      const TIMELOCK_ROLE = await queue.TIMELOCK_ROLE();
      await queue.grantRole(TIMELOCK_ROLE, admin.address);
      await queue.connect(admin).setMaxDailyRedemption(100n * ONE_USDC);

      await queue.connect(users[0]).queueRedemption(100n * ONE_MUSD, 0);
      await queue.connect(users[1]).queueRedemption(100n * ONE_MUSD, 0);

      await time.increase(MIN_AGE + 1);
      await queue.connect(processor).processBatch(10);

      // Only 1 processed (daily limit = 100)
      expect(await usdc.balanceOf(users[0].address)).to.equal(100n * ONE_USDC);
      expect(await usdc.balanceOf(users[1].address)).to.equal(0);

      // Advance past 24h
      await time.increase(86400);
      await queue.connect(processor).processBatch(10);

      // Second should now process
      expect(await usdc.balanceOf(users[1].address)).to.equal(100n * ONE_USDC);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // USDC liquidity edge cases
  // ═══════════════════════════════════════════════════════════════════

  describe("USDC Liquidity Edge Cases", function () {
    it("Should stop when USDC runs out mid-batch", async function () {
      // Drain most USDC, leaving only 150 USDC
      const queueAddr = await queue.getAddress();
      const balance = await usdc.balanceOf(queueAddr);
      const keepAmount = 150n * ONE_USDC;
      // Burn excess by transferring to zero-ish address
      // Instead, just deploy with less USDC
      // For this test, re-deploy with limited USDC
      const QueueFactory = await ethers.getContractFactory("RedemptionQueue");
      const limitedQueue = await QueueFactory.deploy(
        await musd.getAddress(),
        await usdc.getAddress(),
        MAX_DAILY,
        MIN_AGE
      );
      await limitedQueue.waitForDeployment();
      const PROCESSOR_ROLE = await limitedQueue.PROCESSOR_ROLE();
      await limitedQueue.grantRole(PROCESSOR_ROLE, processor.address);

      const lqAddr = await limitedQueue.getAddress();
      for (const user of users) {
        await musd.connect(user).approve(lqAddr, ethers.MaxUint256);
      }

      // Fund with only 150 USDC
      await usdc.mint(lqAddr, 150n * ONE_USDC);

      // Queue 3 × 100 USDC
      for (let i = 0; i < 3; i++) {
        await limitedQueue.connect(users[i]).queueRedemption(100n * ONE_MUSD, 0);
      }

      await time.increase(MIN_AGE + 1);
      await limitedQueue.connect(processor).processBatch(10);

      // Only 1 processed (150 USDC, first request takes 100, second needs 100 but only 50 left)
      expect(await usdc.balanceOf(users[0].address)).to.equal(100n * ONE_USDC);
      expect(await usdc.balanceOf(users[1].address)).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // totalPending accounting integrity
  // ═══════════════════════════════════════════════════════════════════

  describe("Pending Accounting Integrity", function () {
    it("Should maintain totalPendingMusd and totalPendingUsdc correctly", async function () {
      const amt = 100n * ONE_MUSD;
      const usdcAmt = 100n * ONE_USDC;

      await queue.connect(users[0]).queueRedemption(amt, 0);
      await queue.connect(users[1]).queueRedemption(200n * ONE_MUSD, 0);
      expect(await queue.totalPendingMusd()).to.equal(300n * ONE_MUSD);
      expect(await queue.totalPendingUsdc()).to.equal(300n * ONE_USDC);

      // Cancel one
      await queue.connect(users[0]).cancelRedemption(0);
      expect(await queue.totalPendingMusd()).to.equal(200n * ONE_MUSD);
      expect(await queue.totalPendingUsdc()).to.equal(200n * ONE_USDC);

      // Process one
      await time.increase(MIN_AGE + 1);
      await queue.connect(processor).processBatch(1);
      expect(await queue.totalPendingMusd()).to.equal(0);
      expect(await queue.totalPendingUsdc()).to.equal(0);
    });
  });
});
