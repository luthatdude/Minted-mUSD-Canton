/**
 * ETHPoolYieldDistributor — MetaVault #3 Yield → Canton ETH Pool Bridge Tests
 *
 * Tests the ETH Pool yield return path:
 *   1. MetaVault #3 totalValue() increases (yield accrues in strategy)
 *   2. Keeper calls distributeETHPoolYield()
 *   3. mUSD minted directly (backed by yield USDC in strategy)
 *   4. mUSD burned via BLEBridge.bridgeToCanton(ethPoolRecipient)
 *   5. ETHPoolYieldBridged event emitted → relay credits Canton ETH Pool
 *
 * The yield USDC stays in MetaVault #3. mUSD is minted then immediately
 * burned (net supply Δ = 0) — it's purely a bridge vehicle.
 *
 * Audit-fix coverage:
 *   - HIGH-01: Yield cap per epoch (maxYieldBps)
 *   - HIGH-01: Multi-block yield persistence (yieldMaturityBlocks)
 *   - MEDIUM-01: HWM desync detection (checkHwmDesync, hwmDesyncFlagged)
 *   - LOW-01: rescueToken mUSD restriction
 *   - LOW-03: Centralized errors in Errors.sol
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  ETHPoolYieldDistributor,
  MUSD,
  MockERC20,
  MockStrategy,
  MockBLEBridge,
  GlobalPauseRegistry,
} from "../typechain-types";
import { time, mine, loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("ETHPoolYieldDistributor — MetaVault #3 → Canton ETH Pool", function () {
  const ONE_USDC = 10n ** 6n;
  const ONE_MUSD = 10n ** 18n;
  const SUPPLY_CAP = ethers.parseEther("100000000"); // 100M mUSD

  /**
   * Base fixture — deploys full stack with yield maturity DISABLED
   * (yieldMaturityBlocks = 0) so existing core tests work without mining.
   */
  async function deployFullStack() {
    const signers = await ethers.getSigners();
    const admin = signers[0];
    const keeper = signers[1];
    const user = signers[2];

    // ── Deploy MockERC20 (USDC) ────────────────────────────────
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    const usdc = (await MockERC20Factory.deploy("USD Coin", "USDC", 6)) as MockERC20;

    // ── Deploy GlobalPauseRegistry ─────────────────────────────
    const PauseFactory = await ethers.getContractFactory("GlobalPauseRegistry");
    const pause = (await PauseFactory.deploy(admin.address, admin.address)) as GlobalPauseRegistry;

    // ── Deploy mUSD (non-upgradeable) ──────────────────────────
    const MUSDFactory = await ethers.getContractFactory("MUSD");
    const musd = (await MUSDFactory.deploy(SUPPLY_CAP, await pause.getAddress())) as MUSD;

    // ── Deploy MockStrategy as MetaVault #3 ────────────────────
    const StrategyFactory = await ethers.getContractFactory("MockStrategy");
    const metaVault3 = (await StrategyFactory.deploy(
      await usdc.getAddress(),
      admin.address,
    )) as MockStrategy;

    // Seed strategy with 100,000 USDC (simulates ETH Pool deposits)
    const seedAmount = 100_000n * ONE_USDC;
    await usdc.mint(await metaVault3.getAddress(), seedAmount);

    // ── Deploy MockBLEBridge ───────────────────────────────────
    const BridgeFactory = await ethers.getContractFactory("MockBLEBridge");
    const bridge = (await BridgeFactory.deploy(
      await musd.getAddress(),
    )) as MockBLEBridge;

    // ── Deploy ETHPoolYieldDistributor ──────────────────────────
    const DistFactory = await ethers.getContractFactory("ETHPoolYieldDistributor");
    const distributor = (await DistFactory.deploy(
      await musd.getAddress(),
      await bridge.getAddress(),
      await metaVault3.getAddress(),
      admin.address,
      admin.address, // timelock = admin in tests
    )) as ETHPoolYieldDistributor;

    // ── Wire roles ─────────────────────────────────────────────
    const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
    const KEEPER_ROLE = await distributor.KEEPER_ROLE();

    await musd.grantRole(BRIDGE_ROLE, await distributor.getAddress());
    await musd.grantRole(BRIDGE_ROLE, await bridge.getAddress());
    await distributor.grantRole(KEEPER_ROLE, keeper.address);

    // Set the ETH Pool recipient
    const ETHPOOL_PARTY = "ethpool-operator::1220abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567";
    await distributor.setEthPoolRecipient(ETHPOOL_PARTY);

    // ── Disable yield maturity for backward-compatible tests ───
    await distributor.setYieldMaturityBlocks(0);

    // ── Disable yield cap for backward-compatible tests ────────
    await distributor.setMaxYieldBps(0);

    return {
      admin, keeper, user,
      usdc, musd, metaVault3, bridge, distributor,
      ETHPOOL_PARTY,
    };
  }

  /**
   * Fixture with yield maturity and cap ENABLED (default constructor values).
   * Used for audit-fix specific tests.
   */
  async function deployWithAuditFixes() {
    const base = await deployFullStack();
    // Re-enable yield maturity (10 blocks) and cap (5% of HWM)
    await base.distributor.setYieldMaturityBlocks(10);
    await base.distributor.setMaxYieldBps(500);
    return base;
  }

  // ════════════════════════════════════════════════════════════════════
  //  CORE DISTRIBUTION
  // ════════════════════════════════════════════════════════════════════

  describe("distributeETHPoolYield", function () {
    it("Should distribute MetaVault #3 yield to Canton ETH Pool via bridge", async function () {
      const { keeper, metaVault3, distributor, bridge, usdc, musd, ETHPOOL_PARTY } =
        await loadFixture(deployFullStack);

      // Simulate MetaVault #3 yield: add 1000 USDC
      const yieldAmount = 1_000n * ONE_USDC;
      await usdc.mint(await metaVault3.getAddress(), yieldAmount);

      // Wait for cooldown
      await time.increase(3601);

      // mUSD supply before
      const supplyBefore = await musd.totalSupply();

      // Execute distribution
      const tx = await distributor.connect(keeper).distributeETHPoolYield();

      // Check event
      await expect(tx)
        .to.emit(distributor, "ETHPoolYieldBridged")
        .withArgs(1, yieldAmount, yieldAmount * 10n ** 12n, ETHPOOL_PARTY);

      // Check state updates
      expect(await distributor.distributionCount()).to.equal(1);
      expect(await distributor.totalDistributed()).to.equal(yieldAmount * 10n ** 12n);

      // Check mUSD was burned via bridge (net supply Δ = 0)
      const supplyAfter = await musd.totalSupply();
      expect(supplyAfter).to.equal(supplyBefore);

      // Check bridge recorded the burn
      expect(await bridge.totalBridgedOut()).to.equal(yieldAmount * 10n ** 12n);

      // Check HWM was updated
      expect(await distributor.lastRecordedValue()).to.equal(101_000n * ONE_USDC);
    });

    it("Should track high-water mark correctly across multiple distributions", async function () {
      const { keeper, metaVault3, distributor, usdc } =
        await loadFixture(deployFullStack);

      // First yield: 500 USDC
      await usdc.mint(await metaVault3.getAddress(), 500n * ONE_USDC);
      await time.increase(3601);
      await distributor.connect(keeper).distributeETHPoolYield();

      // HWM should be 100,500
      expect(await distributor.lastRecordedValue()).to.equal(100_500n * ONE_USDC);

      // Second yield: 300 USDC more → strategy now has 100,800
      await usdc.mint(await metaVault3.getAddress(), 300n * ONE_USDC);
      await time.increase(3601);
      await distributor.connect(keeper).distributeETHPoolYield();

      // HWM should be 100,800
      expect(await distributor.lastRecordedValue()).to.equal(100_800n * ONE_USDC);
      expect(await distributor.distributionCount()).to.equal(2);
      // Total: 500 + 300 = 800 USDC → 800 mUSD
      expect(await distributor.totalDistributed()).to.equal(800n * ONE_MUSD);
    });

    it("Should revert if no yield available (value unchanged)", async function () {
      const { keeper, distributor } = await loadFixture(deployFullStack);

      await time.increase(3601);

      await expect(
        distributor.connect(keeper).distributeETHPoolYield()
      ).to.be.revertedWithCustomError(distributor, "NoYieldAvailable");
    });

    it("Should revert if yield below minimum", async function () {
      const { keeper, metaVault3, distributor, usdc } =
        await loadFixture(deployFullStack);

      // Add only $10 yield (below $50 minimum)
      await usdc.mint(await metaVault3.getAddress(), 10n * ONE_USDC);
      await time.increase(3601);

      await expect(
        distributor.connect(keeper).distributeETHPoolYield()
      ).to.be.revertedWithCustomError(distributor, "BelowMinYield");
    });

    it("Should revert if cooldown not elapsed", async function () {
      const { keeper, metaVault3, distributor, usdc } =
        await loadFixture(deployFullStack);

      // Add yield and distribute once
      await usdc.mint(await metaVault3.getAddress(), 500n * ONE_USDC);
      await time.increase(3601);
      await distributor.connect(keeper).distributeETHPoolYield();

      // Add more yield but don't wait for cooldown
      await usdc.mint(await metaVault3.getAddress(), 500n * ONE_USDC);

      await expect(
        distributor.connect(keeper).distributeETHPoolYield()
      ).to.be.revertedWithCustomError(distributor, "CooldownNotElapsed");
    });

    it("Should revert if recipient not set", async function () {
      const { admin, keeper, metaVault3, usdc, musd, bridge } =
        await loadFixture(deployFullStack);

      // Deploy fresh distributor without setting recipient
      const DistFactory = await ethers.getContractFactory("ETHPoolYieldDistributor");
      const dist2 = await DistFactory.deploy(
        await musd.getAddress(),
        await bridge.getAddress(),
        await metaVault3.getAddress(),
        admin.address,
        admin.address, // timelock = admin in tests
      ) as ETHPoolYieldDistributor;

      await dist2.grantRole(await dist2.KEEPER_ROLE(), keeper.address);
      await musd.grantRole(await musd.BRIDGE_ROLE(), await dist2.getAddress());
      await dist2.setYieldMaturityBlocks(0);
      await dist2.setMaxYieldBps(0);

      // Add yield after deploying dist2 (so it's above the HWM)
      await usdc.mint(await metaVault3.getAddress(), 500n * ONE_USDC);
      await time.increase(3601);

      await expect(
        dist2.connect(keeper).distributeETHPoolYield()
      ).to.be.revertedWithCustomError(dist2, "RecipientNotSet");
    });
  });

  // ════════════════════════════════════════════════════════════════════
  //  PREVIEW
  // ════════════════════════════════════════════════════════════════════

  describe("previewYield", function () {
    it("Should return available yield and distributability", async function () {
      const { metaVault3, distributor, usdc } = await loadFixture(deployFullStack);

      // No yield initially
      let [yieldUsdc, canDistribute] = await distributor.previewYield();
      expect(yieldUsdc).to.equal(0);
      expect(canDistribute).to.be.false;

      // Add yield
      await usdc.mint(await metaVault3.getAddress(), 200n * ONE_USDC);
      await time.increase(3601);

      [yieldUsdc, canDistribute] = await distributor.previewYield();
      expect(yieldUsdc).to.equal(200n * ONE_USDC);
      expect(canDistribute).to.be.true;
    });

    it("Should not be distributable during cooldown", async function () {
      const { keeper, metaVault3, distributor, usdc } = await loadFixture(deployFullStack);

      // Distribute once
      await usdc.mint(await metaVault3.getAddress(), 200n * ONE_USDC);
      await time.increase(3601);
      await distributor.connect(keeper).distributeETHPoolYield();

      // Add more yield but don't wait for cooldown
      await usdc.mint(await metaVault3.getAddress(), 100n * ONE_USDC);
      const [yieldUsdc, canDistribute] = await distributor.previewYield();
      expect(yieldUsdc).to.equal(100n * ONE_USDC);
      expect(canDistribute).to.be.false; // Cooldown not elapsed
    });
  });

  // ════════════════════════════════════════════════════════════════════
  //  ACCESS CONTROL
  // ════════════════════════════════════════════════════════════════════

  describe("Access Control", function () {
    it("Should reject non-keeper calling distributeETHPoolYield", async function () {
      const { user, distributor } = await loadFixture(deployFullStack);

      await expect(
        distributor.connect(user).distributeETHPoolYield()
      ).to.be.reverted;
    });

    it("Should reject non-keeper calling observeYield", async function () {
      const { user, distributor } = await loadFixture(deployFullStack);

      await expect(
        distributor.connect(user).observeYield()
      ).to.be.reverted;
    });

    it("Should reject non-governor calling setEthPoolRecipient", async function () {
      const { user, distributor } = await loadFixture(deployFullStack);

      await expect(
        distributor.connect(user).setEthPoolRecipient("new-party")
      ).to.be.reverted;
    });

    it("Should reject non-governor calling governance functions", async function () {
      const { user, distributor } = await loadFixture(deployFullStack);

      // Role-gated functions (GOVERNOR_ROLE)
      await expect(distributor.connect(user).syncHighWaterMark()).to.be.reverted;
      await expect(distributor.connect(user).pause()).to.be.reverted;
    });

    it("Should reject non-timelock calling timelocked functions", async function () {
      const { user, distributor } = await loadFixture(deployFullStack);

      await expect(distributor.connect(user).setMinYield(0))
        .to.be.revertedWithCustomError(distributor, "OnlyTimelock");
      await expect(distributor.connect(user).setCooldown(0))
        .to.be.revertedWithCustomError(distributor, "OnlyTimelock");
      await expect(distributor.connect(user).setMaxYieldBps(100))
        .to.be.revertedWithCustomError(distributor, "OnlyTimelock");
      await expect(distributor.connect(user).setYieldMaturityBlocks(5))
        .to.be.revertedWithCustomError(distributor, "OnlyTimelock");
      await expect(distributor.connect(user).unpause())
        .to.be.revertedWithCustomError(distributor, "OnlyTimelock");
      await expect(distributor.connect(user).rescueToken(ethers.ZeroAddress, 0))
        .to.be.revertedWithCustomError(distributor, "OnlyTimelock");
    });
  });

  // ════════════════════════════════════════════════════════════════════
  //  GOVERNANCE
  // ════════════════════════════════════════════════════════════════════

  describe("Governance", function () {
    it("Should allow governor to update parameters", async function () {
      const { distributor } = await loadFixture(deployFullStack);

      await distributor.setMinYield(100n * ONE_USDC);
      expect(await distributor.minYieldUsdc()).to.equal(100n * ONE_USDC);

      await distributor.setCooldown(7200);
      expect(await distributor.distributionCooldown()).to.equal(7200);
    });

    it("Should sync high-water mark manually", async function () {
      const { metaVault3, distributor, usdc } = await loadFixture(deployFullStack);

      // Add value but sync without distributing
      await usdc.mint(await metaVault3.getAddress(), 1_000n * ONE_USDC);

      const valueBefore = await distributor.lastRecordedValue();
      await distributor.syncHighWaterMark();
      const valueAfter = await distributor.lastRecordedValue();

      expect(valueAfter).to.be.gt(valueBefore);
      expect(valueAfter).to.equal(101_000n * ONE_USDC);
    });

    it("Should pause and unpause", async function () {
      const { keeper, metaVault3, distributor, usdc } =
        await loadFixture(deployFullStack);

      await distributor.pause();

      await usdc.mint(await metaVault3.getAddress(), 500n * ONE_USDC);
      await time.increase(3601);

      await expect(
        distributor.connect(keeper).distributeETHPoolYield()
      ).to.be.reverted;

      await distributor.unpause();
      await distributor.connect(keeper).distributeETHPoolYield();
      expect(await distributor.distributionCount()).to.equal(1);
    });

    it("Should reject empty recipient", async function () {
      const { distributor } = await loadFixture(deployFullStack);

      await expect(
        distributor.setEthPoolRecipient("")
      ).to.be.revertedWithCustomError(distributor, "InvalidRecipient");
    });
  });

  // ════════════════════════════════════════════════════════════════════
  //  AUDIT FIX: YIELD CAP (HIGH-01 / MEDIUM-03)
  // ════════════════════════════════════════════════════════════════════

  describe("Yield Cap (HIGH-01 / MEDIUM-03)", function () {
    it("Should cap yield at maxYieldBps of HWM", async function () {
      const { keeper, metaVault3, distributor, usdc } =
        await loadFixture(deployWithAuditFixes);

      // HWM = 100,000 USDC, maxYieldBps = 500 (5%) → max yield = 5,000 USDC
      // Add 10,000 USDC yield (exceeds cap)
      await usdc.mint(await metaVault3.getAddress(), 10_000n * ONE_USDC);

      // Observe yield + wait for maturity
      await distributor.connect(keeper).observeYield();
      await mine(11);
      await time.increase(3601);

      const tx = await distributor.connect(keeper).distributeETHPoolYield();

      // Should emit YieldCapped event
      await expect(tx)
        .to.emit(distributor, "YieldCapped")
        .withArgs(10_000n * ONE_USDC, 5_000n * ONE_USDC, 5_000n * ONE_USDC);

      // HWM advances by capped amount only (100k + 5k = 105k)
      expect(await distributor.lastRecordedValue()).to.equal(105_000n * ONE_USDC);

      // Total distributed = 5,000 USDC worth of mUSD
      expect(await distributor.totalDistributed()).to.equal(5_000n * ONE_MUSD);
    });

    it("Should allow excess yield to roll to next epoch", async function () {
      const { keeper, metaVault3, distributor, usdc } =
        await loadFixture(deployWithAuditFixes);

      // Add 10,000 USDC yield (100k HWM, 5% cap = 5k max)
      await usdc.mint(await metaVault3.getAddress(), 10_000n * ONE_USDC);

      // Epoch 1: distribute 5k cap
      await distributor.connect(keeper).observeYield();
      await mine(11);
      await time.increase(3601);
      await distributor.connect(keeper).distributeETHPoolYield();

      // HWM = 105k, remaining = 5k, new cap = 105k * 5% = 5,250
      // Epoch 2: remaining 5k < new cap 5,250 → distribute all 5k
      await distributor.connect(keeper).observeYield();
      await mine(11);
      await time.increase(3601);
      await distributor.connect(keeper).distributeETHPoolYield();

      // HWM should now be 110,000 (fully caught up)
      expect(await distributor.lastRecordedValue()).to.equal(110_000n * ONE_USDC);
      expect(await distributor.distributionCount()).to.equal(2);
    });

    it("Should not cap yield when maxYieldBps is 0 (disabled)", async function () {
      const { keeper, metaVault3, distributor, usdc } =
        await loadFixture(deployFullStack);

      // maxYieldBps = 0 (disabled in deployFullStack)
      await usdc.mint(await metaVault3.getAddress(), 10_000n * ONE_USDC);
      await time.increase(3601);

      await distributor.connect(keeper).distributeETHPoolYield();

      // Full yield distributed
      expect(await distributor.lastRecordedValue()).to.equal(110_000n * ONE_USDC);
      expect(await distributor.totalDistributed()).to.equal(10_000n * ONE_MUSD);
    });

    it("Should allow governor to update maxYieldBps", async function () {
      const { distributor } = await loadFixture(deployFullStack);

      await distributor.setMaxYieldBps(1000); // 10%
      expect(await distributor.maxYieldBps()).to.equal(1000);

      await expect(distributor.setMaxYieldBps(0)).to.not.be.reverted;
      expect(await distributor.maxYieldBps()).to.equal(0);
    });

    it("Should emit YieldCapDisabled when cap set to 0 (MEDIUM-N1)", async function () {
      const { distributor } = await loadFixture(deployFullStack);

      // First enable a cap
      await distributor.setMaxYieldBps(500);

      // Disabling should emit both MaxYieldBpsUpdated and YieldCapDisabled
      await expect(distributor.setMaxYieldBps(0))
        .to.emit(distributor, "YieldCapDisabled")
        .and.to.emit(distributor, "MaxYieldBpsUpdated")
        .withArgs(500, 0);
    });

    it("Should NOT emit YieldCapDisabled when cap set to non-zero", async function () {
      const { distributor } = await loadFixture(deployFullStack);

      await expect(distributor.setMaxYieldBps(1000))
        .to.not.emit(distributor, "YieldCapDisabled");
    });

    it("Should revert if maxYieldBps exceeds MAX_YIELD_BPS_CAP", async function () {
      const { distributor } = await loadFixture(deployFullStack);

      await expect(
        distributor.setMaxYieldBps(2001) // > 2000 cap
      ).to.be.revertedWithCustomError(distributor, "AboveMax");
    });

    it("Should emit MaxYieldBpsUpdated event", async function () {
      const { distributor } = await loadFixture(deployFullStack);

      await expect(distributor.setMaxYieldBps(1000))
        .to.emit(distributor, "MaxYieldBpsUpdated")
        .withArgs(0, 1000); // 0 from deployFullStack fixture
    });

    it("Should apply cap in previewYield", async function () {
      const { metaVault3, distributor, usdc } =
        await loadFixture(deployWithAuditFixes);

      // Add 10,000 USDC yield, cap = 5% of 100k = 5,000
      await usdc.mint(await metaVault3.getAddress(), 10_000n * ONE_USDC);

      const [yieldUsdc] = await distributor.previewYield();
      expect(yieldUsdc).to.equal(5_000n * ONE_USDC);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  //  AUDIT FIX: YIELD PERSISTENCE (HIGH-01)
  // ════════════════════════════════════════════════════════════════════

  describe("Yield Persistence (HIGH-01)", function () {
    it("Should revert YieldNotMature on first call (before observeYield)", async function () {
      const { keeper, metaVault3, distributor, usdc } =
        await loadFixture(deployWithAuditFixes);

      await usdc.mint(await metaVault3.getAddress(), 1_000n * ONE_USDC);
      await time.increase(3601);

      // Without calling observeYield first, distributeETHPoolYield reverts
      await expect(
        distributor.connect(keeper).distributeETHPoolYield()
      ).to.be.revertedWithCustomError(distributor, "YieldNotMature");

      // yieldFirstObservedBlock should still be 0 (revert rolled back state)
      expect(await distributor.yieldFirstObservedBlock()).to.equal(0);
    });

    it("Should revert YieldNotMature if not enough blocks elapsed", async function () {
      const { keeper, metaVault3, distributor, usdc } =
        await loadFixture(deployWithAuditFixes);

      await usdc.mint(await metaVault3.getAddress(), 1_000n * ONE_USDC);
      await time.increase(3601);

      // Record observation
      await expect(
        distributor.connect(keeper).distributeETHPoolYield()
      ).to.be.revertedWithCustomError(distributor, "YieldNotMature");

      // Mine only 5 blocks (need 10)
      await mine(5);

      await expect(
        distributor.connect(keeper).distributeETHPoolYield()
      ).to.be.revertedWithCustomError(distributor, "YieldNotMature");
    });

    it("Should succeed after observeYield + maturity blocks elapsed", async function () {
      const { keeper, metaVault3, distributor, usdc } =
        await loadFixture(deployWithAuditFixes);

      await usdc.mint(await metaVault3.getAddress(), 1_000n * ONE_USDC);
      await time.increase(3601);

      // Keeper observes yield to start maturity timer
      await distributor.connect(keeper).observeYield();
      expect(await distributor.yieldFirstObservedBlock()).to.be.gt(0);

      // Mine 11 blocks to surpass maturity (10 blocks)
      await mine(11);

      // Should succeed now
      await expect(
        distributor.connect(keeper).distributeETHPoolYield()
      ).to.not.be.reverted;

      // yieldFirstObservedBlock reset after successful distribution
      expect(await distributor.yieldFirstObservedBlock()).to.equal(0);
    });

    it("Should allow keeper to call observeYield to start timer", async function () {
      const { keeper, metaVault3, distributor, usdc } =
        await loadFixture(deployWithAuditFixes);

      await usdc.mint(await metaVault3.getAddress(), 1_000n * ONE_USDC);

      // observeYield records the block
      await distributor.connect(keeper).observeYield();
      expect(await distributor.yieldFirstObservedBlock()).to.be.gt(0);

      // Calling again is a no-op
      const blockBefore = await distributor.yieldFirstObservedBlock();
      await distributor.connect(keeper).observeYield();
      expect(await distributor.yieldFirstObservedBlock()).to.equal(blockBefore);
    });

    it("Should not observe yield if no yield above HWM", async function () {
      const { keeper, distributor } = await loadFixture(deployWithAuditFixes);

      // No yield added — observeYield should not set the block
      await distributor.connect(keeper).observeYield();
      expect(await distributor.yieldFirstObservedBlock()).to.equal(0);
    });

    it("Should allow governor to update yieldMaturityBlocks", async function () {
      const { distributor } = await loadFixture(deployFullStack);

      await distributor.setYieldMaturityBlocks(20);
      expect(await distributor.yieldMaturityBlocks()).to.equal(20);

      // Can disable
      await distributor.setYieldMaturityBlocks(0);
      expect(await distributor.yieldMaturityBlocks()).to.equal(0);
    });

    it("Should emit YieldMaturityBlocksUpdated event", async function () {
      const { distributor } = await loadFixture(deployFullStack);

      await expect(distributor.setYieldMaturityBlocks(20))
        .to.emit(distributor, "YieldMaturityBlocksUpdated")
        .withArgs(0, 20);
    });

    it("Should show not-distributable in preview when yield not mature", async function () {
      const { metaVault3, distributor, usdc } =
        await loadFixture(deployWithAuditFixes);

      await usdc.mint(await metaVault3.getAddress(), 1_000n * ONE_USDC);
      await time.increase(3601);

      // yield exists but yieldFirstObservedBlock = 0 → not mature
      const [yieldUsdc, canDistribute] = await distributor.previewYield();
      expect(yieldUsdc).to.be.gt(0);
      expect(canDistribute).to.be.false;
    });
  });

  // ════════════════════════════════════════════════════════════════════
  //  AUDIT FIX: HWM DESYNC DETECTION (MEDIUM-01)
  // ════════════════════════════════════════════════════════════════════

  describe("HWM Desync Detection (MEDIUM-01)", function () {
    it("Should flag desync when strategy value drops below HWM", async function () {
      const { admin, keeper, metaVault3, distributor, usdc } =
        await loadFixture(deployFullStack);

      // HWM = 100,000 USDC. Simulate withdrawal — reduce strategy value
      // Burn USDC from strategy to simulate loss/rebalance
      await usdc.burn(await metaVault3.getAddress(), 1_000n * ONE_USDC);

      await time.increase(3601);

      // distributeETHPoolYield returns silently (no revert) but flags desync
      const tx = await distributor.connect(keeper).distributeETHPoolYield();

      // Should emit HWMDesyncDetected event
      await expect(tx)
        .to.emit(distributor, "HWMDesyncDetected")
        .withArgs(99_000n * ONE_USDC, 100_000n * ONE_USDC);

      // hwmDesyncFlagged should be true
      expect(await distributor.hwmDesyncFlagged()).to.be.true;

      // No distribution occurred
      expect(await distributor.distributionCount()).to.equal(0);
    });

    it("Should return desync status from checkHwmDesync view", async function () {
      const { admin, metaVault3, distributor, usdc } =
        await loadFixture(deployFullStack);

      // Before any desync
      let [desynced, currentValue, hwm] = await distributor.checkHwmDesync();
      expect(desynced).to.be.false;
      expect(currentValue).to.equal(hwm);

      // Simulate withdrawal — burn USDC from strategy
      await usdc.burn(await metaVault3.getAddress(), 5_000n * ONE_USDC);

      [desynced, currentValue, hwm] = await distributor.checkHwmDesync();
      expect(desynced).to.be.true;
      expect(currentValue).to.equal(95_000n * ONE_USDC);
      expect(hwm).to.equal(100_000n * ONE_USDC);
    });

    it("Should resolve desync when value recovers above HWM", async function () {
      const { admin, keeper, metaVault3, distributor, usdc } =
        await loadFixture(deployFullStack);

      // Cause desync — burn 1k USDC from strategy
      await usdc.burn(await metaVault3.getAddress(), 1_000n * ONE_USDC);
      await time.increase(3601);

      // This returns silently (flags desync)
      await distributor.connect(keeper).distributeETHPoolYield();
      expect(await distributor.hwmDesyncFlagged()).to.be.true;

      // Recover — add yield above HWM
      await usdc.mint(await metaVault3.getAddress(), 2_000n * ONE_USDC);
      // Now value = 99,000 + 2,000 = 101,000 > HWM 100,000
      await time.increase(3601);

      const tx = await distributor.connect(keeper).distributeETHPoolYield();

      // Should emit HWMDesyncResolved
      await expect(tx).to.emit(distributor, "HWMDesyncResolved");

      // hwmDesyncFlagged should be cleared
      expect(await distributor.hwmDesyncFlagged()).to.be.false;
    });

    it("Should resolve desync via syncHighWaterMark", async function () {
      const { admin, keeper, metaVault3, distributor, usdc } =
        await loadFixture(deployFullStack);

      // Cause desync — burn 1k USDC from strategy
      await usdc.burn(await metaVault3.getAddress(), 1_000n * ONE_USDC);
      await time.increase(3601);

      // This returns silently (flags desync)
      await distributor.connect(keeper).distributeETHPoolYield();
      expect(await distributor.hwmDesyncFlagged()).to.be.true;

      // Governor calls syncHighWaterMark
      await distributor.syncHighWaterMark();

      expect(await distributor.hwmDesyncFlagged()).to.be.false;
      expect(await distributor.lastRecordedValue()).to.equal(99_000n * ONE_USDC);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  //  AUDIT FIX: RESCUE TOKEN RESTRICTION (LOW-01)
  // ════════════════════════════════════════════════════════════════════

  describe("rescueToken Restriction (LOW-01)", function () {
    it("Should revert when trying to rescue mUSD", async function () {
      const { distributor, musd } = await loadFixture(deployFullStack);

      await expect(
        distributor.rescueToken(await musd.getAddress(), 100n)
      ).to.be.revertedWithCustomError(distributor, "CannotRescueMusd");
    });

    it("Should allow rescuing non-mUSD tokens", async function () {
      const { admin, distributor, usdc } = await loadFixture(deployFullStack);

      // Send some USDC to distributor (stuck tokens scenario)
      const distAddr = await distributor.getAddress();
      await usdc.mint(distAddr, 1000n * ONE_USDC);

      const balBefore = await usdc.balanceOf(admin.address);
      await distributor.rescueToken(await usdc.getAddress(), 1000n * ONE_USDC);
      const balAfter = await usdc.balanceOf(admin.address);

      expect(balAfter - balBefore).to.equal(1000n * ONE_USDC);
    });
  });
});
