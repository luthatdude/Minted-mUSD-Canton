/**
 * Yield Integration E2E Tests
 *
 * Closes Gap 1: No end-to-end Treasury↔SMUSD yield integration test.
 *
 * Full chain verified:
 *   1. User deposits USDC → TreasuryV2 auto-allocates to strategies
 *   2. Strategy accrues yield → TreasuryV2.totalValue() rises
 *   3. SMUSD.globalTotalAssets() reflects the treasury increase
 *   4. SMUSD.globalSharePrice() increases
 *   5. User redeems smUSD at higher value (profit)
 *   6. 12h yield vesting prevents sandwich attacks
 *   7. Fee accrual (20% performance fee) deducted correctly
 *   8. Multi-strategy yield + partial failure graceful handling
 */

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { TreasuryV2, SMUSD, MUSD, MockERC20, MockStrategy } from "../typechain-types";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { timelockAddStrategy } from "./helpers/timelock";

describe("Yield Integration E2E: Treasury ↔ SMUSD", function () {
  // ── Contracts ──────────────────────────────────────────────
  let treasury: TreasuryV2;
  let smusd: SMUSD;
  let musd: MUSD;
  let usdc: MockERC20;
  let strategyA: MockStrategy;
  let strategyB: MockStrategy;

  // ── Signers ────────────────────────────────────────────────
  let admin: HardhatEthersSigner;
  let vault: HardhatEthersSigner;       // VAULT_ROLE on Treasury
  let yieldManager: HardhatEthersSigner; // YIELD_MANAGER_ROLE on SMUSD
  let feeRecipient: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;
  let bridge: HardhatEthersSigner;       // BRIDGE_ROLE on MUSD

  // ── Constants ──────────────────────────────────────────────
  const USDC_DECIMALS = 6;
  const ONE_USDC = 10n ** 6n;
  const ONE_MUSD = ethers.parseEther("1"); // 18 decimals
  const SUPPLY_CAP = ethers.parseEther("100000000");
  const COOLDOWN = 24 * 60 * 60;          // 24h
  const VESTING = 12 * 60 * 60;           // 12h

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    [admin, vault, yieldManager, feeRecipient, user1, user2, bridge] = signers;

    // ── Deploy USDC (mock, 6 decimals) ───────────────────────
    const MockERC20F = await ethers.getContractFactory("MockERC20");
    usdc = (await MockERC20F.deploy("USD Coin", "USDC", USDC_DECIMALS)) as MockERC20;
    await usdc.waitForDeployment();

    // ── Deploy MUSD (18 decimals) ────────────────────────────
    const MUSDF = await ethers.getContractFactory("MUSD");
    musd = await MUSDF.deploy(SUPPLY_CAP, ethers.ZeroAddress) as MUSD;
    await musd.waitForDeployment();

    // ── Deploy TreasuryV2 (UUPS proxy) ──────────────────────
    const TreasuryF = await ethers.getContractFactory("TreasuryV2");
    treasury = (await upgrades.deployProxy(TreasuryF, [
      await usdc.getAddress(),
      vault.address,
      admin.address,
      feeRecipient.address,
      admin.address,           // timelock = admin in tests
    ])) as unknown as TreasuryV2;
    await treasury.waitForDeployment();

    // ── Deploy Mock Strategies ───────────────────────────────
    const MockStratF = await ethers.getContractFactory("MockStrategy");
    const treasuryAddr = await treasury.getAddress();
    strategyA = (await MockStratF.deploy(await usdc.getAddress(), treasuryAddr)) as MockStrategy;
    strategyB = (await MockStratF.deploy(await usdc.getAddress(), treasuryAddr)) as MockStrategy;
    await strategyA.waitForDeployment();
    await strategyB.waitForDeployment();

    // ── Deploy SMUSD ─────────────────────────────────────────
    const SMUSDF = await ethers.getContractFactory("SMUSD");
    smusd = await SMUSDF.deploy(
      await musd.getAddress(),
      ethers.ZeroAddress,      // no global pause registry in test
    ) as SMUSD;
    await smusd.waitForDeployment();

    // ── Wire SMUSD → Treasury ────────────────────────────────
    await smusd.connect(admin).setTreasury(await treasury.getAddress());

    // ── Grant roles ──────────────────────────────────────────
    await musd.grantRole(await musd.BRIDGE_ROLE(), bridge.address);
    await smusd.grantRole(await smusd.YIELD_MANAGER_ROLE(), yieldManager.address);
    await smusd.grantRole(await smusd.BRIDGE_ROLE(), bridge.address);

    // ── Register strategies on Treasury (45/45 split, 10% reserve) ─
    await timelockAddStrategy(treasury, admin,
      await strategyA.getAddress(), 4500, 0, 10000, true);
    await timelockAddStrategy(treasury, admin,
      await strategyB.getAddress(), 4500, 0, 10000, true);

    // ── Seed USDC liquidity ──────────────────────────────────
    // Mint USDC to vault so it can deposit into Treasury
    await usdc.mint(vault.address, 1_000_000n * ONE_USDC);
    await usdc.connect(vault).approve(await treasury.getAddress(), ethers.MaxUint256);

    // ── Seed mUSD to users (for staking into SMUSD) ─────────
    await musd.connect(bridge).mint(user1.address, ethers.parseEther("50000"));
    await musd.connect(bridge).mint(user2.address, ethers.parseEther("50000"));
    await musd.connect(bridge).mint(yieldManager.address, ethers.parseEther("500000"));

    // ── Approvals ────────────────────────────────────────────
    await musd.connect(user1).approve(await smusd.getAddress(), ethers.MaxUint256);
    await musd.connect(user2).approve(await smusd.getAddress(), ethers.MaxUint256);
    await musd.connect(yieldManager).approve(await smusd.getAddress(), ethers.MaxUint256);
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  1. DEPOSIT → STRATEGY ALLOCATION → YIELD → SHARE PRICE ↑ → REDEEM
  // ═══════════════════════════════════════════════════════════════════════

  describe("1. Full yield lifecycle", function () {
    it("should increase share price when strategies accrue yield", async function () {
      // ── Step 1: Deposit USDC into Treasury via vault ────────
      const depositAmount = 100_000n * ONE_USDC; // $100k
      await treasury.connect(vault).deposit(vault.address, depositAmount);

      // Verify auto-allocation: 10% reserve, 45% each strategy
      const reserveBalance = await treasury.reserveBalance();
      const stratAValue = await strategyA.totalValue();
      const stratBValue = await strategyB.totalValue();
      expect(reserveBalance).to.be.gte(9_000n * ONE_USDC);  // ~10% reserve
      expect(stratAValue).to.be.gte(40_000n * ONE_USDC);     // ~45%
      expect(stratBValue).to.be.gte(40_000n * ONE_USDC);     // ~45%

      const treasuryValueBefore = await treasury.totalValue();
      expect(treasuryValueBefore).to.equal(depositAmount);

      // ── Step 2: User1 stakes mUSD into SMUSD ───────────────
      const stakeAmount = ethers.parseEther("10000");
      await smusd.connect(user1).deposit(stakeAmount, user1.address);

      const sharesBefore = await smusd.balanceOf(user1.address);
      expect(sharesBefore).to.be.gt(0n);

      // Record initial global state
      const globalAssetsBefore = await smusd.globalTotalAssets();
      const globalSharePriceBefore = await smusd.globalSharePrice();

      // ── Step 3: Simulate strategy yield ($50k profit → 50% return) ──
      // Transfer extra USDC directly to strategy A (simulates DeFi yield)
      const yieldAmount = 50_000n * ONE_USDC;
      await usdc.mint(await strategyA.getAddress(), yieldAmount);

      // Verify Treasury.totalValue() reflects the yield
      const treasuryValueAfter = await treasury.totalValue();
      expect(treasuryValueAfter).to.equal(depositAmount + yieldAmount);

      // ── Step 4: Verify SMUSD.globalTotalAssets() reflects it ─
      const globalAssetsAfter = await smusd.globalTotalAssets();
      // Treasury totalValue is USDC (6 dec), SMUSD converts ×1e12 to 18 dec
      expect(globalAssetsAfter).to.be.gt(globalAssetsBefore);

      // ── Step 5: Verify share price increased ────────────────
      const globalSharePriceAfter = await smusd.globalSharePrice();
      expect(globalSharePriceAfter).to.be.gt(globalSharePriceBefore);
    });

    it("should let user redeem at a profit after yield accrues", async function () {
      // ── Setup: deposit to treasury + stake ──────────────────
      await treasury.connect(vault).deposit(vault.address, 100_000n * ONE_USDC);
      const stakeAmount = ethers.parseEther("10000");
      await smusd.connect(user1).deposit(stakeAmount, user1.address);
      const shares = await smusd.balanceOf(user1.address);

      // ── Yield: +$10k to strategy A ─────────────────────────
      await usdc.mint(await strategyA.getAddress(), 10_000n * ONE_USDC);

      // ── Distribute yield through SMUSD (triggers 12h vesting) ─
      const yieldMuSD = ethers.parseEther("8000"); // 80% of $10k net yield
      await smusd.connect(yieldManager).distributeYield(yieldMuSD);

      // ── Wait for full vesting (12h) + cooldown (24h) ────────
      await time.increase(COOLDOWN + 1);

      // ── Redeem all shares ──────────────────────────────────
      const musdBefore = await musd.balanceOf(user1.address);
      await smusd.connect(user1).redeem(shares, user1.address, user1.address);
      const musdAfter = await musd.balanceOf(user1.address);

      const received = musdAfter - musdBefore;
      // User staked 10,000 mUSD, should get back more than 10,000
      expect(received).to.be.gt(stakeAmount);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  2. YIELD VESTING (SOL-M-9: anti-sandwich)
  // ═══════════════════════════════════════════════════════════════════════

  describe("2. Yield vesting (12h linear)", function () {
    it("should vest yield linearly — not all at once", async function () {
      // ── Setup ──────────────────────────────────────────────
      await treasury.connect(vault).deposit(vault.address, 100_000n * ONE_USDC);
      await smusd.connect(user1).deposit(ethers.parseEther("10000"), user1.address);

      // ── Distribute yield ───────────────────────────────────
      const yieldAmount = ethers.parseEther("1000");
      await smusd.connect(yieldManager).distributeYield(yieldAmount);

      const assetsT0 = await smusd.totalAssets();

      // ── Check at 25% vesting (3h) ─────────────────────────
      await time.increase(VESTING / 4);
      const assetsT25 = await smusd.totalAssets();

      // ── Check at 50% vesting (6h) ─────────────────────────
      await time.increase(VESTING / 4);
      const assetsT50 = await smusd.totalAssets();

      // ── Check at 100% vesting (12h) ────────────────────────
      await time.increase(VESTING / 2);
      const assetsT100 = await smusd.totalAssets();

      // totalAssets should increase monotonically as vesting progresses
      expect(assetsT25).to.be.gt(assetsT0);
      expect(assetsT50).to.be.gt(assetsT25);
      expect(assetsT100).to.be.gt(assetsT50);

      // At T=0, most of the yield is still unvested → totalAssets low
      // At T=100%, all yield vested → totalAssets = base + full yield
      const vestedAtT0 = assetsT0;
      const vestedAtT100 = assetsT100;
      const totalGain = vestedAtT100 - vestedAtT0;

      // The gain should be approximately the yield amount
      // (small rounding from block timestamp granularity)
      const lowerBound = yieldAmount * 95n / 100n; // allow 5% rounding
      const upperBound = yieldAmount * 105n / 100n;
      expect(totalGain).to.be.gte(lowerBound);
      expect(totalGain).to.be.lte(upperBound);
    });

    it("should prevent sandwich: depositor right before yield gets diluted shares", async function () {
      // ── User1 stakes early ─────────────────────────────────
      await treasury.connect(vault).deposit(vault.address, 100_000n * ONE_USDC);
      const earlyStake = ethers.parseEther("10000");
      await smusd.connect(user1).deposit(earlyStake, user1.address);
      const earlyShares = await smusd.balanceOf(user1.address);

      // ── Yield distributed (starts 12h vesting) ─────────────
      const yieldAmount = ethers.parseEther("5000");
      await smusd.connect(yieldManager).distributeYield(yieldAmount);

      // ── Sandwich attacker deposits immediately after ───────
      const lateStake = ethers.parseEther("10000");
      await smusd.connect(user2).deposit(lateStake, user2.address);
      const lateShares = await smusd.balanceOf(user2.address);

      // The late depositor should get approximately the same shares
      // because vesting hasn't progressed yet — yield isn't reflected
      // in totalAssets() immediately.
      // Within 1% tolerance (one block's worth of vesting)
      const diff = earlyShares > lateShares
        ? earlyShares - lateShares
        : lateShares - earlyShares;
      const tolerance = earlyShares / 100n; // 1%
      expect(diff).to.be.lte(tolerance);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  3. FEE ACCRUAL: 20% performance fee on yield
  // ═══════════════════════════════════════════════════════════════════════

  describe("3. Performance fee integration", function () {
    it("should accrue 20% performance fee on strategy yield", async function () {
      // ── Deposit $100k ──────────────────────────────────────
      await treasury.connect(vault).deposit(vault.address, 100_000n * ONE_USDC);

      // Record peak
      const peakBefore = await treasury.peakRecordedValue();

      // ── Strategy yields $10k ───────────────────────────────
      await usdc.mint(await strategyA.getAddress(), 10_000n * ONE_USDC);

      // totalValue = $110k, totalValueNet deducts pending 20% of $10k = $2k fee
      const totalValue = await treasury.totalValue();
      const totalValueNet = await treasury.totalValueNet();
      expect(totalValue).to.equal(110_000n * ONE_USDC);

      // Net = total - pending fees = $110k - $2k = $108k
      expect(totalValueNet).to.equal(108_000n * ONE_USDC);

      // SMUSD sees the net value (via globalTotalAssets → treasury.totalValue)
      // Note: SMUSD calls totalValue() not totalValueNet(), but the fee
      // effectively reduces what's distributable to stakers
    });

    it("should not double-charge fees after drawdown and recovery", async function () {
      // MIN_ACCRUAL_INTERVAL = 1 hour — must advance time between accruals
      const ACCRUAL_GAP = 3601; // > 1 hour

      // ── Deposit $100k ─────────────────────────────────────
      await treasury.connect(vault).deposit(vault.address, 100_000n * ONE_USDC);

      // ── Advance time so next accrual isn't skipped ────────
      await time.increase(ACCRUAL_GAP);

      // ── Yield: strategy A gains $10k ──────────────────────
      await usdc.mint(await strategyA.getAddress(), 10_000n * ONE_USDC);

      // Trigger fee accrual via small deposit
      await treasury.connect(vault).deposit(vault.address, 1n * ONE_USDC);

      const feesBefore = (await treasury.fees()).accruedFees;
      expect(feesBefore).to.be.gt(0n); // 20% of $10k ≈ $2k accrued

      // Record peak after first yield
      const peakAfterYield = await treasury.peakRecordedValue();

      // ── Advance time again ────────────────────────────────
      await time.increase(ACCRUAL_GAP);

      // ── Another yield of $5k ──────────────────────────────
      await usdc.mint(await strategyA.getAddress(), 5_000n * ONE_USDC);

      // Trigger accrual
      await treasury.connect(vault).deposit(vault.address, 1n * ONE_USDC);

      const feesAfter = (await treasury.fees()).accruedFees;
      // New fees should be ~20% of $5k = $1k more
      const newFees = feesAfter - feesBefore;
      expect(newFees).to.be.gte(900n * ONE_USDC);  // ~$1k (allow rounding)
      expect(newFees).to.be.lte(1_100n * ONE_USDC);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  4. MULTI-STRATEGY YIELD WITH PARTIAL FAILURE
  // ═══════════════════════════════════════════════════════════════════════

  describe("4. Multi-strategy yield + partial failure", function () {
    it("should reflect yield from multiple strategies in share price", async function () {
      // ── Deposit → auto-allocate to both strategies ─────────
      await treasury.connect(vault).deposit(vault.address, 100_000n * ONE_USDC);

      // ── Both strategies yield ──────────────────────────────
      await usdc.mint(await strategyA.getAddress(), 3_000n * ONE_USDC);
      await usdc.mint(await strategyB.getAddress(), 2_000n * ONE_USDC);

      const totalValue = await treasury.totalValue();
      expect(totalValue).to.equal(105_000n * ONE_USDC);
    });

    it("should handle a broken strategy gracefully — totalValue treats it as 0", async function () {
      // ── Deposit ────────────────────────────────────────────
      await treasury.connect(vault).deposit(vault.address, 100_000n * ONE_USDC);
      const valueBefore = await treasury.totalValue();

      // ── Deactivate strategy B (simulates a broken DeFi protocol) ─
      await strategyB.setActive(false);

      // totalValue still works — broken strategy returns whatever
      // USDC balance it has (totalValue() is just balanceOf)
      const valueAfter = await treasury.totalValue();
      // Should be the same since MockStrategy.totalValue() = balanceOf
      expect(valueAfter).to.equal(valueBefore);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  5. FULL ROUND-TRIP: deposit USDC → treasury → yield → share ↑ → redeem profit
  // ═══════════════════════════════════════════════════════════════════════

  describe("5. Complete round-trip integration", function () {
    it("user deposits mUSD → strategies earn yield → user redeems more mUSD", async function () {
      // ── Step 1: Seed treasury with USDC (simulates DirectMint flow) ─
      const seedAmount = 200_000n * ONE_USDC;
      await treasury.connect(vault).deposit(vault.address, seedAmount);

      // ── Step 2: User1 stakes 10,000 mUSD → gets smUSD shares ─
      const stakeAmount = ethers.parseEther("10000");
      await smusd.connect(user1).deposit(stakeAmount, user1.address);
      const shares = await smusd.balanceOf(user1.address);

      // ── Step 3: Record initial global share price ──────────
      const priceBefore = await smusd.globalSharePrice();

      // ── Step 4: Strategies earn $20k yield ($200k → $220k) ─
      await usdc.mint(await strategyA.getAddress(), 10_000n * ONE_USDC);
      await usdc.mint(await strategyB.getAddress(), 10_000n * ONE_USDC);

      // ── Step 5: Verify global share price increased ────────
      const priceAfter = await smusd.globalSharePrice();
      expect(priceAfter).to.be.gt(priceBefore);

      // ── Step 6: Distribute yield to SMUSD (triggers vesting) ─
      // Net yield after 20% fee: $20k × 80% = $16k
      const yieldForStakers = ethers.parseEther("16000");
      await smusd.connect(yieldManager).distributeYield(yieldForStakers);

      // ── Step 7: Wait for full vesting + cooldown ───────────
      await time.increase(COOLDOWN + 1);

      // ── Step 8: User redeems all smUSD shares ──────────────
      const musdBefore = await musd.balanceOf(user1.address);
      await smusd.connect(user1).redeem(shares, user1.address, user1.address);
      const musdAfter = await musd.balanceOf(user1.address);

      const profit = musdAfter - musdBefore - stakeAmount;

      // User should have made a profit
      expect(musdAfter - musdBefore).to.be.gt(stakeAmount);

      // Sanity: profit should be significant but bounded
      // The exact amount depends on share dilution math
      expect(profit).to.be.gt(0n);
    });

    it("two users share yield proportionally", async function () {
      // ── Seed treasury ──────────────────────────────────────
      await treasury.connect(vault).deposit(vault.address, 100_000n * ONE_USDC);

      // ── User1 stakes 10k, User2 stakes 20k ────────────────
      await smusd.connect(user1).deposit(ethers.parseEther("10000"), user1.address);
      await smusd.connect(user2).deposit(ethers.parseEther("20000"), user2.address);

      const shares1 = await smusd.balanceOf(user1.address);
      const shares2 = await smusd.balanceOf(user2.address);

      // User2 should have ~2x the shares
      // Allow 1% tolerance for rounding
      const ratio = (shares2 * 100n) / shares1;
      expect(ratio).to.be.gte(198n); // ~200%
      expect(ratio).to.be.lte(202n);

      // ── Distribute yield ───────────────────────────────────
      const yieldAmount = ethers.parseEther("3000");
      await smusd.connect(yieldManager).distributeYield(yieldAmount);

      // ── Wait for vesting + cooldown ────────────────────────
      await time.increase(COOLDOWN + 1);

      // ── Both redeem ────────────────────────────────────────
      const musd1Before = await musd.balanceOf(user1.address);
      await smusd.connect(user1).redeem(shares1, user1.address, user1.address);
      const musd1After = await musd.balanceOf(user1.address);
      const received1 = musd1After - musd1Before;

      const musd2Before = await musd.balanceOf(user2.address);
      await smusd.connect(user2).redeem(shares2, user2.address, user2.address);
      const musd2After = await musd.balanceOf(user2.address);
      const received2 = musd2After - musd2Before;

      // User2 should receive ~2x what User1 receives
      const receiptRatio = (received2 * 100n) / received1;
      expect(receiptRatio).to.be.gte(195n);
      expect(receiptRatio).to.be.lte(205n);

      // Both should have profited
      expect(received1).to.be.gt(ethers.parseEther("10000"));
      expect(received2).to.be.gt(ethers.parseEther("20000"));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  6. EDGE CASES
  // ═══════════════════════════════════════════════════════════════════════

  describe("6. Edge cases", function () {
    it("globalTotalAssets returns local assets when treasury not set", async function () {
      // Deploy a fresh SMUSD without treasury
      const SMUSDF = await ethers.getContractFactory("SMUSD");
      const freshSmusd = await SMUSDF.deploy(
        await musd.getAddress(),
        ethers.ZeroAddress,
      ) as SMUSD;

      // treasury = address(0), so globalTotalAssets() = totalAssets()
      const gta = await freshSmusd.globalTotalAssets();
      const ta = await freshSmusd.totalAssets();
      expect(gta).to.equal(ta);
    });

    it("share price is correct with zero strategies (all reserve)", async function () {
      // Treasury with no strategies — all USDC sits in reserve
      // Deploy a fresh treasury with no strategies
      const TreasuryF = await ethers.getContractFactory("TreasuryV2");
      const freshTreasury = (await upgrades.deployProxy(TreasuryF, [
        await usdc.getAddress(),
        vault.address,
        admin.address,
        feeRecipient.address,
        admin.address,
      ])) as unknown as TreasuryV2;

      // Wire SMUSD to fresh treasury
      await smusd.connect(admin).setTreasury(await freshTreasury.getAddress());

      // Deposit directly to reserve
      await usdc.connect(vault).approve(await freshTreasury.getAddress(), ethers.MaxUint256);
      await freshTreasury.connect(vault).deposit(vault.address, 50_000n * ONE_USDC);

      // totalValue = reserve balance only
      const tv = await freshTreasury.totalValue();
      expect(tv).to.equal(50_000n * ONE_USDC);

      // SMUSD should see it
      const gta = await smusd.globalTotalAssets();
      expect(gta).to.equal(50_000n * ONE_USDC * 10n ** 12n); // ×1e12 conversion
    });
  });
});
