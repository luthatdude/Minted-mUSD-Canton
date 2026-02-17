// @ts-nocheck
/**
 * SkySUSDSStrategy — Extended Coverage Tests
 * 
 * Tests happy-path deposit/withdraw/withdrawAll flows using proper MockSkyPSM and MockSUSDS,
 * plus totalValue, sUsdsShares, unrealizedYield, emergencyWithdraw, and recoverToken success.
 */

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";

describe("SkySUSDSStrategy — Happy Path", function () {
  const TREASURY_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TREASURY_ROLE"));
  const GUARDIAN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GUARDIAN_ROLE"));
  const TIMELOCK_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TIMELOCK_ROLE"));

  async function deployWithMocks() {
    const [admin, treasury, guardian, attacker] = await ethers.getSigners();

    // ── Deploy tokens ────────────────────────────────────────
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USDC", "USDC", 6);
    const usds = await MockERC20.deploy("USDS", "USDS", 18);

    // ── Deploy real mocks for PSM and sUSDS ──────────────────
    const MockSkyPSM = await ethers.getContractFactory("MockSkyPSM");
    const psm = await MockSkyPSM.deploy(await usdc.getAddress(), await usds.getAddress());

    const MockSUSDS = await ethers.getContractFactory("MockSUSDS");
    const sUsds = await MockSUSDS.deploy(await usds.getAddress());

    // ── Fund PSM with USDS so sellGem can transfer USDS out ──
    await usds.mint(await psm.getAddress(), ethers.parseEther("10000000")); // 10M USDS

    // ── Fund sUSDS with USDS so redeem can transfer USDS out ─
    await usds.mint(await sUsds.getAddress(), ethers.parseEther("10000000"));

    // ── Fund PSM with USDC so buyGem can transfer USDC out ───
    await usdc.mint(await psm.getAddress(), 10_000_000n * 10n ** 6n); // 10M USDC

    // ── Deploy strategy via proxy ────────────────────────────
    const Factory = await ethers.getContractFactory("SkySUSDSStrategy");
    const strategy = await upgrades.deployProxy(
      Factory,
      [
        await usdc.getAddress(),
        await usds.getAddress(),
        await psm.getAddress(),
        await sUsds.getAddress(),
        treasury.address,
        admin.address,
        admin.address, // timelock = admin in tests
      ],
      { kind: "uups" }
    );

    return { strategy, usdc, usds, psm, sUsds, admin, treasury, guardian, attacker };
  }

  // ═══════════════════════════════════════════════════════════════
  //  DEPOSIT — Happy Path
  // ═══════════════════════════════════════════════════════════════
  describe("deposit (happy path)", function () {
    it("deposits USDC → PSM → sUSDS successfully", async function () {
      const { strategy, usdc, sUsds, treasury } = await deployWithMocks();

      const depositAmount = 1_000n * 10n ** 6n; // 1,000 USDC
      await usdc.mint(treasury.address, depositAmount);
      await usdc.connect(treasury).approve(await strategy.getAddress(), depositAmount);

      await expect(strategy.connect(treasury).deposit(depositAmount))
        .to.emit(strategy, "Deposited");

      // Strategy should hold sUSDS shares
      const shares = await sUsds.balanceOf(await strategy.getAddress());
      expect(shares).to.be.gt(0n);
    });

    it("updates totalPrincipal after deposit", async function () {
      const { strategy, usdc, treasury } = await deployWithMocks();

      const depositAmount = 5_000n * 10n ** 6n;
      await usdc.mint(treasury.address, depositAmount);
      await usdc.connect(treasury).approve(await strategy.getAddress(), depositAmount);

      await strategy.connect(treasury).deposit(depositAmount);
      expect(await strategy.totalPrincipal()).to.equal(depositAmount);
    });

    it("multiple deposits accumulate principal", async function () {
      const { strategy, usdc, treasury } = await deployWithMocks();

      const amount1 = 1_000n * 10n ** 6n;
      const amount2 = 2_000n * 10n ** 6n;

      await usdc.mint(treasury.address, amount1 + amount2);
      await usdc.connect(treasury).approve(await strategy.getAddress(), amount1 + amount2);

      await strategy.connect(treasury).deposit(amount1);
      await strategy.connect(treasury).deposit(amount2);

      expect(await strategy.totalPrincipal()).to.equal(amount1 + amount2);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  WITHDRAW — Happy Path
  // ═══════════════════════════════════════════════════════════════
  describe("withdraw (happy path)", function () {
    it("withdraws USDC back to treasury", async function () {
      const { strategy, usdc, treasury } = await deployWithMocks();

      // Deposit first
      const depositAmount = 1_000n * 10n ** 6n;
      await usdc.mint(treasury.address, depositAmount);
      await usdc.connect(treasury).approve(await strategy.getAddress(), depositAmount);
      await strategy.connect(treasury).deposit(depositAmount);

      // Now withdraw
      const usdcBefore = await usdc.balanceOf(treasury.address);
      await strategy.connect(treasury).withdraw(500n * 10n ** 6n);
      const usdcAfter = await usdc.balanceOf(treasury.address);

      expect(usdcAfter - usdcBefore).to.equal(500n * 10n ** 6n);
    });

    it("emits Withdrawn event", async function () {
      const { strategy, usdc, treasury } = await deployWithMocks();

      const depositAmount = 1_000n * 10n ** 6n;
      await usdc.mint(treasury.address, depositAmount);
      await usdc.connect(treasury).approve(await strategy.getAddress(), depositAmount);
      await strategy.connect(treasury).deposit(depositAmount);

      await expect(strategy.connect(treasury).withdraw(500n * 10n ** 6n))
        .to.emit(strategy, "Withdrawn");
    });

    it("withdraw zero amount reverts", async function () {
      const { strategy, treasury } = await deployWithMocks();
      await expect(strategy.connect(treasury).withdraw(0))
        .to.be.revertedWithCustomError(strategy, "ZeroAmount");
    });

    it("updates totalPrincipal after withdrawal", async function () {
      const { strategy, usdc, treasury } = await deployWithMocks();

      const depositAmount = 1_000n * 10n ** 6n;
      await usdc.mint(treasury.address, depositAmount);
      await usdc.connect(treasury).approve(await strategy.getAddress(), depositAmount);
      await strategy.connect(treasury).deposit(depositAmount);

      await strategy.connect(treasury).withdraw(400n * 10n ** 6n);

      expect(await strategy.totalPrincipal()).to.equal(600n * 10n ** 6n);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  WITHDRAWALL — Happy Path
  // ═══════════════════════════════════════════════════════════════
  describe("withdrawAll (happy path)", function () {
    it("withdraws all USDC and resets principal", async function () {
      const { strategy, usdc, treasury } = await deployWithMocks();

      const depositAmount = 2_000n * 10n ** 6n;
      await usdc.mint(treasury.address, depositAmount);
      await usdc.connect(treasury).approve(await strategy.getAddress(), depositAmount);
      await strategy.connect(treasury).deposit(depositAmount);

      const usdcBefore = await usdc.balanceOf(treasury.address);
      await strategy.connect(treasury).withdrawAll();
      const usdcAfter = await usdc.balanceOf(treasury.address);

      expect(usdcAfter - usdcBefore).to.equal(depositAmount);
      expect(await strategy.totalPrincipal()).to.equal(0n);
    });

    it("withdrawAll with zero shares returns dust", async function () {
      const { strategy, treasury } = await deployWithMocks();
      // No deposit, so zero shares
      const result = await strategy.connect(treasury).withdrawAll.staticCall();
      expect(result).to.equal(0n);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  VIEW FUNCTIONS
  // ═══════════════════════════════════════════════════════════════
  describe("totalValue", function () {
    it("returns deposited amount (1:1 exchange rate)", async function () {
      const { strategy, usdc, treasury } = await deployWithMocks();

      const depositAmount = 1_000n * 10n ** 6n;
      await usdc.mint(treasury.address, depositAmount);
      await usdc.connect(treasury).approve(await strategy.getAddress(), depositAmount);
      await strategy.connect(treasury).deposit(depositAmount);

      const totalVal = await strategy.totalValue();
      expect(totalVal).to.equal(depositAmount);
    });

    it("reflects yield when exchange rate increases", async function () {
      const { strategy, usdc, sUsds, treasury } = await deployWithMocks();

      const depositAmount = 1_000n * 10n ** 6n;
      await usdc.mint(treasury.address, depositAmount);
      await usdc.connect(treasury).approve(await strategy.getAddress(), depositAmount);
      await strategy.connect(treasury).deposit(depositAmount);

      // Simulate 5% yield by increasing exchange rate
      await sUsds.setExchangeRate(ethers.parseEther("1.05"));

      const totalVal = await strategy.totalValue();
      // 1000 USDC * 1.05 = 1050 USDC
      expect(totalVal).to.be.gte(1_050n * 10n ** 6n);
    });
  });

  describe("sUsdsShares", function () {
    it("returns non-zero after deposit", async function () {
      const { strategy, usdc, treasury } = await deployWithMocks();

      const depositAmount = 1_000n * 10n ** 6n;
      await usdc.mint(treasury.address, depositAmount);
      await usdc.connect(treasury).approve(await strategy.getAddress(), depositAmount);
      await strategy.connect(treasury).deposit(depositAmount);

      expect(await strategy.sUsdsShares()).to.be.gt(0n);
    });
  });

  describe("unrealizedYield", function () {
    it("returns 0 when exchange rate is 1:1", async function () {
      const { strategy, usdc, treasury } = await deployWithMocks();

      const depositAmount = 1_000n * 10n ** 6n;
      await usdc.mint(treasury.address, depositAmount);
      await usdc.connect(treasury).approve(await strategy.getAddress(), depositAmount);
      await strategy.connect(treasury).deposit(depositAmount);

      expect(await strategy.unrealizedYield()).to.equal(0n);
    });

    it("returns positive yield when exchange rate increases", async function () {
      const { strategy, usdc, sUsds, treasury } = await deployWithMocks();

      const depositAmount = 1_000n * 10n ** 6n;
      await usdc.mint(treasury.address, depositAmount);
      await usdc.connect(treasury).approve(await strategy.getAddress(), depositAmount);
      await strategy.connect(treasury).deposit(depositAmount);

      // 10% yield
      await sUsds.setExchangeRate(ethers.parseEther("1.10"));

      const yield_ = await strategy.unrealizedYield();
      expect(yield_).to.be.gte(99n * 10n ** 6n); // ~100 USDC yield (rounding)
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  EMERGENCY WITHDRAW
  // ═══════════════════════════════════════════════════════════════
  describe("emergencyWithdraw", function () {
    it("redeems all sUSDS, holds USDC in contract, pauses", async function () {
      const { strategy, usdc, sUsds, admin, treasury } = await deployWithMocks();

      const depositAmount = 2_000n * 10n ** 6n;
      await usdc.mint(treasury.address, depositAmount);
      await usdc.connect(treasury).approve(await strategy.getAddress(), depositAmount);
      await strategy.connect(treasury).deposit(depositAmount);

      expect(await sUsds.balanceOf(await strategy.getAddress())).to.be.gt(0n);

      await expect(strategy.connect(admin).emergencyWithdraw())
        .to.emit(strategy, "EmergencyWithdrawn");

      // sUSDS shares should be 0
      expect(await sUsds.balanceOf(await strategy.getAddress())).to.equal(0n);

      // USDC should be held in strategy (not sent to treasury yet)
      const strategyUsdc = await usdc.balanceOf(await strategy.getAddress());
      expect(strategyUsdc).to.be.gte(depositAmount);

      // Strategy should be paused
      expect(await strategy.isActive()).to.be.false;
    });

    it("emergencyWithdraw resets totalPrincipal to 0", async function () {
      const { strategy, usdc, admin, treasury } = await deployWithMocks();

      const depositAmount = 1_000n * 10n ** 6n;
      await usdc.mint(treasury.address, depositAmount);
      await usdc.connect(treasury).approve(await strategy.getAddress(), depositAmount);
      await strategy.connect(treasury).deposit(depositAmount);

      await strategy.connect(admin).emergencyWithdraw();
      expect(await strategy.totalPrincipal()).to.equal(0n);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  recoverToken — success path
  // ═══════════════════════════════════════════════════════════════
  describe("recoverToken (success)", function () {
    it("recovers a non-protected ERC20", async function () {
      const { strategy, admin } = await deployWithMocks();

      // Deploy a random token
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const randomToken = await MockERC20.deploy("Random", "RND", 18);

      // Send some to strategy
      await randomToken.mint(await strategy.getAddress(), ethers.parseEther("100"));

      const before = await randomToken.balanceOf(admin.address);
      await strategy.connect(admin).recoverToken(await randomToken.getAddress(), ethers.parseEther("100"));
      const after_ = await randomToken.balanceOf(admin.address);

      expect(after_ - before).to.equal(ethers.parseEther("100"));
    });

    it("reverts when recovering sUSDS", async function () {
      const { strategy, sUsds, admin } = await deployWithMocks();
      await expect(
        strategy.connect(admin).recoverToken(await sUsds.getAddress(), 1)
      ).to.be.revertedWithCustomError(strategy, "CannotRecoverSusds");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  isActive reflects paused state
  // ═══════════════════════════════════════════════════════════════
  describe("isActive", function () {
    it("returns false when paused even if active flag is true", async function () {
      const { strategy, admin } = await deployWithMocks();
      expect(await strategy.isActive()).to.be.true;
      await strategy.connect(admin).pause();
      expect(await strategy.isActive()).to.be.false;
    });

    it("returns false when active flag is false even if not paused", async function () {
      const { strategy, admin } = await deployWithMocks();
      await strategy.connect(admin).setActive(false);
      expect(await strategy.isActive()).to.be.false;
    });
  });
});
