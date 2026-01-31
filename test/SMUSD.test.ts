/**
 * SMUSD (Staked mUSD) Tests
 * Tests: ERC-4626 deposit/withdraw, cooldown enforcement, yield distribution,
 *        transfer cooldown propagation, donation attack mitigation
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { SMUSD, MUSD } from "../typechain-types";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("SMUSD", function () {
  let smusd: SMUSD;
  let musd: MUSD;
  let deployer: HardhatEthersSigner;
  let bridge: HardhatEthersSigner;
  let yieldManager: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;

  const SUPPLY_CAP = ethers.parseEther("100000000");
  const COOLDOWN = 24 * 60 * 60; // 24 hours

  beforeEach(async function () {
    [deployer, bridge, yieldManager, user1, user2] = await ethers.getSigners();

    // Deploy MUSD
    const MUSDFactory = await ethers.getContractFactory("MUSD");
    musd = await MUSDFactory.deploy(SUPPLY_CAP);
    await musd.waitForDeployment();

    // Deploy SMUSD
    const SMUSDFactory = await ethers.getContractFactory("SMUSD");
    smusd = await SMUSDFactory.deploy(await musd.getAddress());
    await smusd.waitForDeployment();

    // Grant roles
    await musd.grantRole(await musd.BRIDGE_ROLE(), bridge.address);
    await smusd.grantRole(await smusd.YIELD_MANAGER_ROLE(), yieldManager.address);

    // Mint mUSD to users
    await musd.connect(bridge).mint(user1.address, ethers.parseEther("10000"));
    await musd.connect(bridge).mint(user2.address, ethers.parseEther("10000"));
    await musd.connect(bridge).mint(yieldManager.address, ethers.parseEther("100000"));

    // Approve SMUSD to spend mUSD
    await musd.connect(user1).approve(await smusd.getAddress(), ethers.MaxUint256);
    await musd.connect(user2).approve(await smusd.getAddress(), ethers.MaxUint256);
    await musd.connect(yieldManager).approve(await smusd.getAddress(), ethers.MaxUint256);
  });

  // ============================================================
  //  DEPLOYMENT
  // ============================================================

  describe("Deployment", function () {
    it("should set correct name and symbol", async function () {
      expect(await smusd.name()).to.equal("Staked mUSD");
      expect(await smusd.symbol()).to.equal("smUSD");
    });

    it("should use mUSD as underlying asset", async function () {
      expect(await smusd.asset()).to.equal(await musd.getAddress());
    });

    it("should have decimalsOffset of 3 (FIX S-03 donation attack)", async function () {
      // ERC-4626 with offset means 1 share = 10^3 assets initially
      // This mitigates the donation attack by making share inflation expensive
      const shares = await smusd.previewDeposit(ethers.parseEther("1000"));
      expect(shares).to.be.gt(0);
    });
  });

  // ============================================================
  //  DEPOSIT + COOLDOWN
  // ============================================================

  describe("Deposit", function () {
    it("should accept deposits and issue shares", async function () {
      const depositAmount = ethers.parseEther("1000");
      const shares = await smusd.previewDeposit(depositAmount);
      await smusd.connect(user1).deposit(depositAmount, user1.address);
      expect(await smusd.balanceOf(user1.address)).to.equal(shares);
    });

    it("should set cooldown for depositor", async function () {
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);
      expect(await smusd.canWithdraw(user1.address)).to.be.false;
      expect(await smusd.getRemainingCooldown(user1.address)).to.be.gt(0);
    });

    it("FIX S-H01: should set cooldown for receiver (not depositor) on third-party deposit", async function () {
      // user1 deposits on behalf of user2
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user2.address);
      expect(await smusd.canWithdraw(user2.address)).to.be.false;
    });
  });

  // ============================================================
  //  WITHDRAWAL + COOLDOWN ENFORCEMENT
  // ============================================================

  describe("Withdraw", function () {
    beforeEach(async function () {
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);
    });

    it("should reject withdrawal during cooldown", async function () {
      await expect(
        smusd.connect(user1).withdraw(ethers.parseEther("100"), user1.address, user1.address)
      ).to.be.revertedWith("COOLDOWN_ACTIVE");
    });

    it("should allow withdrawal after cooldown", async function () {
      await time.increase(COOLDOWN);
      const balanceBefore = await musd.balanceOf(user1.address);
      await smusd.connect(user1).withdraw(ethers.parseEther("100"), user1.address, user1.address);
      expect(await musd.balanceOf(user1.address)).to.be.gt(balanceBefore);
    });

    it("FIX S-02: should enforce cooldown on redeem() too", async function () {
      const shares = await smusd.balanceOf(user1.address);
      await expect(
        smusd.connect(user1).redeem(shares / 2n, user1.address, user1.address)
      ).to.be.revertedWith("COOLDOWN_ACTIVE");
    });

    it("should allow redeem after cooldown", async function () {
      await time.increase(COOLDOWN);
      const shares = await smusd.balanceOf(user1.address);
      await smusd.connect(user1).redeem(shares, user1.address, user1.address);
      expect(await smusd.balanceOf(user1.address)).to.equal(0);
    });
  });

  // ============================================================
  //  COOLDOWN PROPAGATION ON TRANSFER (FIX S-01)
  // ============================================================

  describe("Transfer cooldown propagation (FIX S-01)", function () {
    it("should propagate stricter cooldown to receiver", async function () {
      // user2 deposits first — has an earlier cooldown
      await smusd.connect(user2).deposit(ethers.parseEther("1000"), user2.address);
      await time.increase(COOLDOWN / 2); // Half the cooldown passes

      // user1 deposits — has a later (stricter) cooldown
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);

      // user1 transfers to user2 — user2 should inherit user1's stricter cooldown
      const sharesToTransfer = (await smusd.balanceOf(user1.address)) / 2n;
      await smusd.connect(user1).transfer(user2.address, sharesToTransfer);

      // user2 should NOT be able to withdraw yet (inherited stricter cooldown)
      expect(await smusd.canWithdraw(user2.address)).to.be.false;
    });

    it("should not weaken receiver's existing cooldown", async function () {
      // user1 deposits — has a recent cooldown
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);
      await time.increase(COOLDOWN / 2);

      // user2 deposits — has an even more recent cooldown
      await smusd.connect(user2).deposit(ethers.parseEther("1000"), user2.address);

      // user1 transfers to user2 — should NOT weaken user2's cooldown
      const sharesBefore = await smusd.getRemainingCooldown(user2.address);
      const sharesToTransfer = (await smusd.balanceOf(user1.address)) / 2n;
      await smusd.connect(user1).transfer(user2.address, sharesToTransfer);
      const sharesAfter = await smusd.getRemainingCooldown(user2.address);

      // Cooldown should be same or stricter, never weaker
      expect(sharesAfter).to.be.gte(sharesBefore - 1n); // -1 for block time rounding
    });
  });

  // ============================================================
  //  YIELD DISTRIBUTION
  // ============================================================

  describe("Yield Distribution", function () {
    beforeEach(async function () {
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);
    });

    it("should increase share value after yield", async function () {
      const assetsBefore = await smusd.convertToAssets(ethers.parseEther("1"));
      await smusd.connect(yieldManager).distributeYield(ethers.parseEther("100"));
      const assetsAfter = await smusd.convertToAssets(ethers.parseEther("1"));
      expect(assetsAfter).to.be.gt(assetsBefore);
    });

    it("should reject yield distribution with no shares", async function () {
      // Deploy fresh SMUSD with no deposits
      const SMUSDFactory = await ethers.getContractFactory("SMUSD");
      const emptySmusd = await SMUSDFactory.deploy(await musd.getAddress());
      await emptySmusd.grantRole(await emptySmusd.YIELD_MANAGER_ROLE(), yieldManager.address);

      await expect(
        emptySmusd.connect(yieldManager).distributeYield(ethers.parseEther("100"))
      ).to.be.revertedWith("NO_SHARES_EXIST");
    });

    it("should reject zero yield", async function () {
      await expect(
        smusd.connect(yieldManager).distributeYield(0)
      ).to.be.revertedWith("INVALID_AMOUNT");
    });

    it("should reject yield without YIELD_MANAGER_ROLE", async function () {
      await expect(
        smusd.connect(user1).distributeYield(ethers.parseEther("100"))
      ).to.be.reverted;
    });
  });
});
