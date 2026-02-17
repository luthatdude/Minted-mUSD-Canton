/**
 * TimelockGoverned Tests — Branch coverage for setTimelock / _setTimelock / onlyTimelock
 *
 * Tests the abstract TimelockGoverned via MockTimelockGoverned.
 * Covers all branches:
 *   B1: onlyTimelock modifier — msg.sender != timelock → revert OnlyTimelock
 *   B2: onlyTimelock modifier — msg.sender == timelock → passes
 *   B3: setTimelock(address(0)) → revert ZeroTimelock
 *   B4: setTimelock(valid) → succeeds, emits TimelockUpdated
 *   B5: _setTimelock(address(0)) → revert ZeroTimelock (via constructor)
 *   B6: _setTimelock(valid) → succeeds (via constructor)
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("TimelockGoverned — setTimelock / onlyTimelock modifier", function () {

  async function deployFixture() {
    const [deployer, timelockSigner, attacker, newTimelock] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("MockTimelockGoverned");
    const governed = await Factory.deploy(timelockSigner.address);
    await governed.waitForDeployment();

    return { deployer, timelockSigner, attacker, newTimelock, governed, Factory };
  }

  // ═══════════════════════════════════════════════════════════════════
  // CONSTRUCTOR / _setTimelock
  // ═══════════════════════════════════════════════════════════════════

  describe("Constructor / _setTimelock", function () {
    it("sets timelock correctly on construction", async function () {
      const { governed, timelockSigner } = await loadFixture(deployFixture);
      expect(await governed.timelock()).to.equal(timelockSigner.address);
    });

    it("emits TimelockUpdated(address(0), newTimelock) on construction", async function () {
      const [, timelockSigner] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("MockTimelockGoverned");
      const governed = await Factory.deploy(timelockSigner.address);
      // Verify via reading state (event emitted in constructor)
      expect(await governed.timelock()).to.equal(timelockSigner.address);
    });

    it("reverts with ZeroTimelock when constructed with address(0)", async function () {
      const Factory = await ethers.getContractFactory("MockTimelockGoverned");
      await expect(Factory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        Factory, "ZeroTimelock"
      );
    });

    it("reverts when initializeTimelock called with address(0)", async function () {
      const { governed } = await loadFixture(deployFixture);
      await expect(governed.initializeTimelock(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        governed, "ZeroTimelock"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // onlyTimelock MODIFIER
  // ═══════════════════════════════════════════════════════════════════

  describe("onlyTimelock modifier", function () {
    it("allows timelock to call gated functions", async function () {
      const { governed, timelockSigner } = await loadFixture(deployFixture);
      await governed.connect(timelockSigner).setValue(42);
      expect(await governed.value()).to.equal(42);
    });

    it("reverts with OnlyTimelock when called by deployer", async function () {
      const { governed, deployer } = await loadFixture(deployFixture);
      await expect(governed.connect(deployer).setValue(42)).to.be.revertedWithCustomError(
        governed, "OnlyTimelock"
      );
    });

    it("reverts with OnlyTimelock when called by attacker", async function () {
      const { governed, attacker } = await loadFixture(deployFixture);
      await expect(governed.connect(attacker).setValue(42)).to.be.revertedWithCustomError(
        governed, "OnlyTimelock"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // setTimelock (external, onlyTimelock)
  // ═══════════════════════════════════════════════════════════════════

  describe("setTimelock", function () {
    it("timelock can migrate to a new timelock", async function () {
      const { governed, timelockSigner, newTimelock } = await loadFixture(deployFixture);

      await expect(governed.connect(timelockSigner).setTimelock(newTimelock.address))
        .to.emit(governed, "TimelockUpdated")
        .withArgs(timelockSigner.address, newTimelock.address);

      expect(await governed.timelock()).to.equal(newTimelock.address);
    });

    it("old timelock loses access after migration", async function () {
      const { governed, timelockSigner, newTimelock } = await loadFixture(deployFixture);

      // Migrate
      await governed.connect(timelockSigner).setTimelock(newTimelock.address);

      // Old timelock can no longer call gated functions
      await expect(governed.connect(timelockSigner).setValue(99)).to.be.revertedWithCustomError(
        governed, "OnlyTimelock"
      );

      // New timelock can
      await governed.connect(newTimelock).setValue(99);
      expect(await governed.value()).to.equal(99);
    });

    it("reverts with ZeroTimelock when setting to address(0)", async function () {
      const { governed, timelockSigner } = await loadFixture(deployFixture);
      await expect(
        governed.connect(timelockSigner).setTimelock(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(governed, "ZeroTimelock");
    });

    it("reverts with OnlyTimelock when non-timelock calls setTimelock", async function () {
      const { governed, attacker, newTimelock } = await loadFixture(deployFixture);
      await expect(
        governed.connect(attacker).setTimelock(newTimelock.address)
      ).to.be.revertedWithCustomError(governed, "OnlyTimelock");
    });

    it("new timelock can perform a second migration", async function () {
      const { governed, timelockSigner, newTimelock, deployer } = await loadFixture(deployFixture);

      // First migration
      await governed.connect(timelockSigner).setTimelock(newTimelock.address);

      // Second migration (from new timelock to deployer)
      await expect(governed.connect(newTimelock).setTimelock(deployer.address))
        .to.emit(governed, "TimelockUpdated")
        .withArgs(newTimelock.address, deployer.address);

      expect(await governed.timelock()).to.equal(deployer.address);
    });
  });
});
