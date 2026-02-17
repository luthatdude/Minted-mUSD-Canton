/**
 * GlobalPausable Tests — whenNotGloballyPaused modifier coverage
 *
 * Tests the abstract GlobalPausable mixin via MockGlobalPausableConsumer.
 * Covers all branches:
 *   B1: registry == address(0) → modifier is no-op → function executes
 *   B2: registry != address(0) && !isGloballyPaused → function executes
 *   B3: registry != address(0) && isGloballyPaused  → reverts GloballyPaused
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("GlobalPausable — whenNotGloballyPaused modifier", function () {
  const GUARDIAN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GUARDIAN_ROLE"));

  // ───────────────────────────────────────────────────────────────
  // Fixture: deploy registry + consumer with valid registry
  // ───────────────────────────────────────────────────────────────

  async function deployWithRegistryFixture() {
    const [admin, guardian, user] = await ethers.getSigners();

    const RegistryFactory = await ethers.getContractFactory("GlobalPauseRegistry");
    const registry = await RegistryFactory.deploy(admin.address, guardian.address);
    await registry.waitForDeployment();

    const ConsumerFactory = await ethers.getContractFactory("MockGlobalPausableConsumer");
    const consumer = await ConsumerFactory.deploy(await registry.getAddress());
    await consumer.waitForDeployment();

    return { admin, guardian, user, registry, consumer };
  }

  // ───────────────────────────────────────────────────────────────
  // Fixture: deploy consumer with registry = address(0)
  // ───────────────────────────────────────────────────────────────

  async function deployWithoutRegistryFixture() {
    const [admin, user] = await ethers.getSigners();

    const ConsumerFactory = await ethers.getContractFactory("MockGlobalPausableConsumer");
    const consumer = await ConsumerFactory.deploy(ethers.ZeroAddress);
    await consumer.waitForDeployment();

    return { admin, user, consumer };
  }

  // ═══════════════════════════════════════════════════════════════════
  // B1: registry == address(0) → modifier is no-op
  // ═══════════════════════════════════════════════════════════════════

  describe("No registry (address(0))", function () {
    it("globalPauseRegistry returns address(0)", async function () {
      const { consumer } = await loadFixture(deployWithoutRegistryFixture);
      expect(await consumer.globalPauseRegistry()).to.equal(ethers.ZeroAddress);
    });

    it("guarded function succeeds (modifier is no-op)", async function () {
      const { consumer } = await loadFixture(deployWithoutRegistryFixture);
      await consumer.doSomething();
      expect(await consumer.counter()).to.equal(1);
    });

    it("multiple calls succeed", async function () {
      const { consumer } = await loadFixture(deployWithoutRegistryFixture);
      await consumer.doSomething();
      await consumer.doSomething();
      await consumer.doSomething();
      expect(await consumer.counter()).to.equal(3);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // B2: registry != address(0) && !isGloballyPaused → passes
  // ═══════════════════════════════════════════════════════════════════

  describe("Registry deployed and NOT paused", function () {
    it("globalPauseRegistry is set", async function () {
      const { consumer, registry } = await loadFixture(deployWithRegistryFixture);
      expect(await consumer.globalPauseRegistry()).to.equal(await registry.getAddress());
    });

    it("guarded function succeeds when not paused", async function () {
      const { consumer } = await loadFixture(deployWithRegistryFixture);
      await consumer.doSomething();
      expect(await consumer.counter()).to.equal(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // B3: registry != address(0) && isGloballyPaused → reverts
  // ═══════════════════════════════════════════════════════════════════

  describe("Registry deployed and PAUSED", function () {
    it("guarded function reverts with GloballyPaused", async function () {
      const { consumer, registry, guardian } = await loadFixture(deployWithRegistryFixture);

      // Pause the registry
      await registry.connect(guardian).pauseGlobal();
      expect(await registry.isGloballyPaused()).to.be.true;

      // Consumer's guarded function should now revert
      await expect(consumer.doSomething()).to.be.revertedWithCustomError(consumer, "GloballyPaused");
    });

    it("unguarded function still succeeds when paused", async function () {
      const { consumer, registry, guardian } = await loadFixture(deployWithRegistryFixture);

      await registry.connect(guardian).pauseGlobal();
      // Unguarded function doesn't use the modifier
      expect(await consumer.doUnguarded()).to.be.true;
    });

    it("guarded function resumes after unpause", async function () {
      const { consumer, registry, admin, guardian } = await loadFixture(deployWithRegistryFixture);

      // Pause
      await registry.connect(guardian).pauseGlobal();
      await expect(consumer.doSomething()).to.be.revertedWithCustomError(consumer, "GloballyPaused");

      // Unpause
      await registry.connect(admin).unpauseGlobal();
      expect(await registry.isGloballyPaused()).to.be.false;

      // Should work again
      await consumer.doSomething();
      expect(await consumer.counter()).to.equal(1);
    });

    it("full lifecycle: unpaused → paused → reverts → unpaused → succeeds", async function () {
      const { consumer, registry, admin, guardian } = await loadFixture(deployWithRegistryFixture);

      // Step 1: Works when unpaused
      await consumer.doSomething();
      expect(await consumer.counter()).to.equal(1);

      // Step 2: Pause
      await registry.connect(guardian).pauseGlobal();

      // Step 3: Reverts when paused
      await expect(consumer.doSomething()).to.be.revertedWithCustomError(consumer, "GloballyPaused");
      expect(await consumer.counter()).to.equal(1); // counter didn't increment

      // Step 4: Unpause
      await registry.connect(admin).unpauseGlobal();

      // Step 5: Works again
      await consumer.doSomething();
      expect(await consumer.counter()).to.equal(2);
    });
  });
});
