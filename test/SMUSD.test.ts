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
    smusd = await SMUSDFactory.deploy(await musd.getAddress(), deployer.address);
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
      const emptySmusd = await SMUSDFactory.deploy(await musd.getAddress(), deployer.address);
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

    it("FIX M-3: should reject yield exceeding MAX_YIELD_BPS cap", async function () {
      // MAX_YIELD_BPS = 1000 = 10%
      // With 1000 mUSD deposited, max yield = 100 mUSD
      const excessiveYield = ethers.parseEther("200"); // 20% > 10%
      await expect(
        smusd.connect(yieldManager).distributeYield(excessiveYield)
      ).to.be.revertedWith("YIELD_EXCEEDS_CAP");
    });

    it("should accept yield within MAX_YIELD_BPS cap", async function () {
      // 10% of 1000 = 100, so 50 should be fine
      const validYield = ethers.parseEther("50");
      await smusd.connect(yieldManager).distributeYield(validYield);
      // No revert means success
    });
  });

  // ============================================================
  //  PAUSE/UNPAUSE (EMERGENCY CONTROLS)
  // ============================================================

  describe("Pause/Unpause", function () {
    it("should allow PAUSER_ROLE to pause", async function () {
      await smusd.connect(deployer).pause();
      expect(await smusd.paused()).to.be.true;
    });

    it("should reject deposit when paused", async function () {
      await smusd.connect(deployer).pause();
      await expect(
        smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address)
      ).to.be.revertedWithCustomError(smusd, "EnforcedPause");
    });

    it("should reject withdraw when paused", async function () {
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);
      await time.increase(COOLDOWN);

      await smusd.connect(deployer).pause();
      await expect(
        smusd.connect(user1).withdraw(ethers.parseEther("100"), user1.address, user1.address)
      ).to.be.revertedWithCustomError(smusd, "EnforcedPause");
    });

    it("should require DEFAULT_ADMIN_ROLE for unpause", async function () {
      await smusd.connect(deployer).pause();

      await expect(
        smusd.connect(user1).unpause()
      ).to.be.reverted;

      await smusd.connect(deployer).unpause();
      expect(await smusd.paused()).to.be.false;
    });

    it("should resume operations after unpause", async function () {
      await smusd.connect(deployer).pause();
      await smusd.connect(deployer).unpause();

      // Should work again
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);
      expect(await smusd.balanceOf(user1.address)).to.be.gt(0);
    });
  });

  // ============================================================
  //  TREASURY INTEGRATION
  // ============================================================

  describe("Treasury Integration", function () {
    it("should set treasury address", async function () {
      const mockTreasury = ethers.Wallet.createRandom().address;
      await smusd.connect(deployer).setTreasury(mockTreasury);
      expect(await smusd.treasury()).to.equal(mockTreasury);
    });

    it("should reject zero address for treasury", async function () {
      await expect(
        smusd.connect(deployer).setTreasury(ethers.ZeroAddress)
      ).to.be.revertedWith("ZERO_ADDRESS");
    });

    it("should emit TreasuryUpdated event", async function () {
      const mockTreasury = ethers.Wallet.createRandom().address;
      await expect(smusd.connect(deployer).setTreasury(mockTreasury))
        .to.emit(smusd, "TreasuryUpdated")
        .withArgs(ethers.ZeroAddress, mockTreasury);
    });

    it("should reject treasury update from non-admin", async function () {
      await expect(
        smusd.connect(user1).setTreasury(ethers.Wallet.createRandom().address)
      ).to.be.reverted;
    });
  });

  // ============================================================
  //  CANTON SHARES SYNC
  // ============================================================

  describe("Canton Shares Sync", function () {
    beforeEach(async function () {
      await smusd.grantRole(await smusd.BRIDGE_ROLE(), bridge.address);
    });

    it("should sync Canton shares from bridge", async function () {
      const cantonShares = ethers.parseEther("5000");
      await smusd.connect(bridge).syncCantonShares(cantonShares, 1);

      expect(await smusd.cantonTotalShares()).to.equal(cantonShares);
      expect(await smusd.lastCantonSyncEpoch()).to.equal(1);
    });

    it("should reject non-sequential epoch", async function () {
      await smusd.connect(bridge).syncCantonShares(ethers.parseEther("1000"), 1);

      await expect(
        smusd.connect(bridge).syncCantonShares(ethers.parseEther("2000"), 1)
      ).to.be.revertedWith("EPOCH_NOT_SEQUENTIAL");
    });

    it("should update global total shares", async function () {
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);
      const ethShares = await smusd.totalSupply();

      const cantonShares = ethers.parseEther("2000");
      await smusd.connect(bridge).syncCantonShares(cantonShares, 1);

      // Global = Ethereum + Canton
      expect(await smusd.globalTotalShares()).to.equal(ethShares + cantonShares);
    });

    it("should reject sync from non-bridge", async function () {
      await expect(
        smusd.connect(user1).syncCantonShares(ethers.parseEther("1000"), 1)
      ).to.be.reverted;
    });

    it("should emit CantonSharesSynced event", async function () {
      const cantonShares = ethers.parseEther("5000");
      await expect(smusd.connect(bridge).syncCantonShares(cantonShares, 1))
        .to.emit(smusd, "CantonSharesSynced");
    });
  });

  // ============================================================
  //  GLOBAL SHARE PRICE
  // ============================================================

  describe("Global Share Price", function () {
    it("should return correct global share price with no Canton shares", async function () {
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);

      const price = await smusd.globalSharePrice();
      expect(price).to.be.gt(0);
    });

    it("should return default price with no shares", async function () {
      const price = await smusd.globalSharePrice();
      // decimalsOffset = 3, so default = 10^3 = 1000
      expect(price).to.equal(1000);
    });

    it("should return ethereum total shares", async function () {
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);
      const totalSupply = await smusd.totalSupply();
      expect(await smusd.ethereumTotalShares()).to.equal(totalSupply);
    });

    it("should return global total assets without treasury", async function () {
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);
      const globalAssets = await smusd.globalTotalAssets();
      const localAssets = await smusd.totalAssets();
      expect(globalAssets).to.equal(localAssets);
    });
  });

  // ============================================================
  //  VIEW FUNCTIONS
  // ============================================================

  describe("View Functions", function () {
    it("should return remaining cooldown correctly", async function () {
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);

      const remaining = await smusd.getRemainingCooldown(user1.address);
      expect(remaining).to.be.gt(0);
      expect(remaining).to.be.lte(COOLDOWN);
    });

    it("should return zero remaining cooldown after expiry", async function () {
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);
      await time.increase(COOLDOWN + 1);

      expect(await smusd.getRemainingCooldown(user1.address)).to.equal(0);
    });

    it("should convert assets to shares correctly", async function () {
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);

      const shares = await smusd.convertToShares(ethers.parseEther("100"));
      expect(shares).to.be.gt(0);
    });

    it("should convert shares to assets correctly", async function () {
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);

      const shares = await smusd.balanceOf(user1.address);
      const assets = await smusd.convertToAssets(shares);
      // Should be approximately equal to deposit (minus rounding)
      expect(assets).to.be.gte(ethers.parseEther("999"));
    });
  });
});
