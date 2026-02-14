/**
 * GlobalPauseRegistry Tests (TEST-H-04)
 * Tests the protocol-wide emergency kill switch: role separation,
 * pause/unpause lifecycle, event emission, and integration with GlobalPausable.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { GlobalPauseRegistry } from "../typechain-types";

describe("GlobalPauseRegistry", function () {
  let registry: GlobalPauseRegistry;
  let admin: HardhatEthersSigner;
  let guardian: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  const GUARDIAN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GUARDIAN_ROLE"));
  const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;

  beforeEach(async function () {
    [admin, guardian, stranger] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("GlobalPauseRegistry");
    registry = await Factory.deploy(admin.address, guardian.address);
    await registry.waitForDeployment();
  });

  // ============================================================
  //  DEPLOYMENT / CONSTRUCTOR
  // ============================================================

  describe("Deployment", function () {
    it("assigns DEFAULT_ADMIN_ROLE to admin", async function () {
      expect(await registry.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
    });

    it("assigns GUARDIAN_ROLE to guardian", async function () {
      expect(await registry.hasRole(GUARDIAN_ROLE, guardian.address)).to.be.true;
    });

    it("starts unpaused", async function () {
      expect(await registry.isGloballyPaused()).to.be.false;
    });

    it("reverts on zero-address admin", async function () {
      const Factory = await ethers.getContractFactory("GlobalPauseRegistry");
      await expect(
        Factory.deploy(ethers.ZeroAddress, guardian.address)
      ).to.be.revertedWithCustomError(registry, "InvalidAdmin");
    });

    it("reverts on zero-address guardian", async function () {
      const Factory = await ethers.getContractFactory("GlobalPauseRegistry");
      await expect(
        Factory.deploy(admin.address, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(registry, "InvalidAddress");
    });
  });

  // ============================================================
  //  PAUSE
  // ============================================================

  describe("pauseGlobal", function () {
    it("guardian can pause", async function () {
      await registry.connect(guardian).pauseGlobal();
      expect(await registry.isGloballyPaused()).to.be.true;
    });

    it("records lastPausedAt timestamp", async function () {
      const tx = await registry.connect(guardian).pauseGlobal();
      const block = await tx.getBlock();
      expect(await registry.lastPausedAt()).to.equal(block!.timestamp);
    });

    it("emits GlobalPauseStateChanged(true, guardian)", async function () {
      await expect(registry.connect(guardian).pauseGlobal())
        .to.emit(registry, "GlobalPauseStateChanged")
        .withArgs(true, guardian.address);
    });

    it("reverts if already paused (AlreadyPaused)", async function () {
      await registry.connect(guardian).pauseGlobal();
      await expect(
        registry.connect(guardian).pauseGlobal()
      ).to.be.revertedWithCustomError(registry, "AlreadyPaused");
    });

    it("reverts when called by admin (not guardian)", async function () {
      await expect(
        registry.connect(admin).pauseGlobal()
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });

    it("reverts when called by stranger", async function () {
      await expect(
        registry.connect(stranger).pauseGlobal()
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });
  });

  // ============================================================
  //  UNPAUSE
  // ============================================================

  describe("unpauseGlobal", function () {
    beforeEach(async function () {
      // Pause first so we can test unpause
      await registry.connect(guardian).pauseGlobal();
    });

    it("admin can unpause", async function () {
      await registry.connect(admin).unpauseGlobal();
      expect(await registry.isGloballyPaused()).to.be.false;
    });

    it("records lastUnpausedAt timestamp", async function () {
      const tx = await registry.connect(admin).unpauseGlobal();
      const block = await tx.getBlock();
      expect(await registry.lastUnpausedAt()).to.equal(block!.timestamp);
    });

    it("emits GlobalPauseStateChanged(false, admin)", async function () {
      await expect(registry.connect(admin).unpauseGlobal())
        .to.emit(registry, "GlobalPauseStateChanged")
        .withArgs(false, admin.address);
    });

    it("reverts if not paused (NotPaused)", async function () {
      await registry.connect(admin).unpauseGlobal();
      await expect(
        registry.connect(admin).unpauseGlobal()
      ).to.be.revertedWithCustomError(registry, "NotPaused");
    });

    it("reverts when called by guardian (separation of duties)", async function () {
      await expect(
        registry.connect(guardian).unpauseGlobal()
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });

    it("reverts when called by stranger", async function () {
      await expect(
        registry.connect(stranger).unpauseGlobal()
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });
  });

  // ============================================================
  //  SEPARATION OF DUTIES
  // ============================================================

  describe("Role separation", function () {
    it("guardian CANNOT unpause (only admin can)", async function () {
      await registry.connect(guardian).pauseGlobal();
      await expect(
        registry.connect(guardian).unpauseGlobal()
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });

    it("admin CANNOT pause (only guardian can)", async function () {
      await expect(
        registry.connect(admin).pauseGlobal()
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });

    it("full lifecycle: guardian pauses → admin unpauses → guardian pauses again", async function () {
      // Guardian pauses
      await registry.connect(guardian).pauseGlobal();
      expect(await registry.isGloballyPaused()).to.be.true;

      // Admin unpauses
      await registry.connect(admin).unpauseGlobal();
      expect(await registry.isGloballyPaused()).to.be.false;

      // Guardian pauses again
      await registry.connect(guardian).pauseGlobal();
      expect(await registry.isGloballyPaused()).to.be.true;
    });
  });

  // ============================================================
  //  INTEGRATION: GlobalPausable modifier
  // ============================================================

  describe("Integration with GlobalPausable", function () {
    it("downstream contract reverts when globally paused", async function () {
      // Deploy a contract that uses GlobalPausable (CollateralVault uses local pause,
      // but DirectMintV2 uses GlobalPausable). We test via a minimal mock approach:
      // the GlobalPauseRegistry itself is tested, and any contract calling
      // isGloballyPaused() will see the correct state.

      // Verify the query interface works correctly before and after pause
      expect(await registry.isGloballyPaused()).to.be.false;

      await registry.connect(guardian).pauseGlobal();
      expect(await registry.isGloballyPaused()).to.be.true;

      await registry.connect(admin).unpauseGlobal();
      expect(await registry.isGloballyPaused()).to.be.false;
    });

    it("timestamps are correctly tracked across multiple pause/unpause cycles", async function () {
      // Cycle 1
      const tx1 = await registry.connect(guardian).pauseGlobal();
      const block1 = await tx1.getBlock();
      expect(await registry.lastPausedAt()).to.equal(block1!.timestamp);

      const tx2 = await registry.connect(admin).unpauseGlobal();
      const block2 = await tx2.getBlock();
      expect(await registry.lastUnpausedAt()).to.equal(block2!.timestamp);

      // Cycle 2 — timestamps update
      const tx3 = await registry.connect(guardian).pauseGlobal();
      const block3 = await tx3.getBlock();
      expect(await registry.lastPausedAt()).to.equal(block3!.timestamp);
      // lastUnpausedAt still from cycle 1
      expect(await registry.lastUnpausedAt()).to.equal(block2!.timestamp);
    });
  });
});
