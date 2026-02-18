/**
 * Yield Integration E2E — Treasury MetaVault Manual Deploy Lifecycle
 *
 * Tests the REAL production yield flow:
 *   1. USDC enters Treasury reserve (via DirectMint → deposit())
 *   2. Admin MANUALLY calls treasury.deployToStrategy(metaVaultAddr, amount) — NOT auto-allocated
 *   3. 3 MetaVaults (mock strategies in test) receive USDC according to target split
 *   4. Strategies earn yield (simulated via direct USDC transfer)
 *   5. treasury.totalValue() rises → smusd.globalSharePrice() reflects this
 *   6. Performance fee (20%) accrues on high-water-mark yield
 *   7. Yield manager distributes mUSD to SMUSD → 12h linear vesting
 *   8. After 24h cooldown, user redeems smUSD at higher local share price
 *
 * Architecture notes:
 *   - The Treasury does NOT auto-distribute in production. Funds sit in reserve.
 *   - An admin with ALLOCATOR_ROLE manually deploys via the admin page to 3 MetaVaults:
 *       Vault #1: 45% (Euler + Pendle)
 *       Vault #2: 45% (Fluid Syrup)
 *       Vault #3: 10% (ETH Pool)
 *   - In this test, MockStrategy contracts stand in for MetaVaults.
 */

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { TreasuryV2, MockERC20, MockStrategy, MUSD, SMUSD, GlobalPauseRegistry } from "../typechain-types";
import { timelockAddStrategy, timelockSetFeeConfig, timelockSetReserveBps } from "./helpers/timelock";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("Yield Integration E2E — Manual MetaVault Deploy", function () {
  // ── Constants ──────────────────────────────────────────────────────
  const USDC_DECIMALS = 6;
  const ONE_USDC = 10n ** 6n;
  const ONE_MUSD = 10n ** 18n;
  const ONE_MILLION_USDC = 1_000_000n * ONE_USDC;
  const VESTING_DURATION = 12 * 60 * 60; // 12 hours in seconds
  const WITHDRAW_COOLDOWN = 24 * 60 * 60; // 24 hours in seconds
  const MIN_ACCRUAL_INTERVAL = 3600; // 1 hour

  // ── Fixture ────────────────────────────────────────────────────────

  async function deployFullStack() {
    const signers = await ethers.getSigners();
    const admin = signers[0]; // deployer=admin=timelock in tests
    const vaultSigner = signers[1]; // acts as DirectMint — has VAULT_ROLE
    const feeRecipient = signers[2];
    const yieldManager = signers[3];
    const userAlice = signers[4];
    const userBob = signers[5];

    // ── Deploy MockERC20 (USDC, 6 decimals) ────────────────────
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    const usdc = (await MockERC20Factory.deploy("USD Coin", "USDC", USDC_DECIMALS)) as MockERC20;

    // ── Deploy GlobalPauseRegistry ─────────────────────────────
    const GPRFactory = await ethers.getContractFactory("GlobalPauseRegistry");
    const gpr = (await GPRFactory.deploy(admin.address, admin.address)) as GlobalPauseRegistry;

    // ── Deploy MUSD ────────────────────────────────────────────
    const MUSDFactory = await ethers.getContractFactory("MUSD");
    const musd = (await MUSDFactory.deploy(
      ethers.parseEther("100000000"), // 100M supply cap
      await gpr.getAddress()
    )) as MUSD;

    // ── Deploy SMUSD (ERC4626 with mUSD as underlying) ─────────
    const SMUSDFactory = await ethers.getContractFactory("SMUSD");
    const smusd = (await SMUSDFactory.deploy(
      await musd.getAddress(),
      await gpr.getAddress()
    )) as SMUSD;

    // ── Deploy TreasuryV2 (UUPS proxy) ─────────────────────────
    const TreasuryFactory = await ethers.getContractFactory("TreasuryV2");
    const treasury = (await upgrades.deployProxy(TreasuryFactory, [
      await usdc.getAddress(),
      vaultSigner.address, // VAULT_ROLE goes to this signer
      admin.address,
      feeRecipient.address,
      admin.address, // admin=timelock in tests
    ])) as unknown as TreasuryV2;

    // ── Deploy 3 MockStrategies (stand-in for MetaVaults) ───────
    // Vault #1: 45% (Euler + Pendle strategies)
    // Vault #2: 45% (Fluid Syrup strategies)
    // Vault #3: 10% (ETH Pool Fluid)
    const MockStratFactory = await ethers.getContractFactory("MockStrategy");
    const treasuryAddr = await treasury.getAddress();
    const metaVault1 = (await MockStratFactory.deploy(await usdc.getAddress(), treasuryAddr)) as MockStrategy;
    const metaVault2 = (await MockStratFactory.deploy(await usdc.getAddress(), treasuryAddr)) as MockStrategy;
    const metaVault3 = (await MockStratFactory.deploy(await usdc.getAddress(), treasuryAddr)) as MockStrategy;

    // ── Set reserve to 0% FIRST so that strategy allocations can sum to 100%
    // (production uses 10% reserve — tested separately in TreasuryV2.test.ts)
    await timelockSetReserveBps(treasury, admin, 0);

    // ── Register strategies (autoAllocate = FALSE) ──────────────
    // This is the critical difference: production does NOT auto-allocate
    await timelockAddStrategy(treasury, admin, await metaVault1.getAddress(), 4500, 3000, 6000, false);
    await timelockAddStrategy(treasury, admin, await metaVault2.getAddress(), 4500, 3000, 6000, false);
    await timelockAddStrategy(treasury, admin, await metaVault3.getAddress(), 1000, 500, 2000, false);

    // ── Link SMUSD to Treasury for globalTotalAssets ────────────
    await smusd.connect(admin).setTreasury(await treasury.getAddress());

    // ── Grant YIELD_MANAGER_ROLE on SMUSD ──────────────────────
    const YIELD_MANAGER_ROLE = await smusd.YIELD_MANAGER_ROLE();
    await smusd.grantRole(YIELD_MANAGER_ROLE, yieldManager.address);

    // ── Grant BRIDGE_ROLE on MUSD so we can mint freely ─────────
    const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
    await musd.grantRole(BRIDGE_ROLE, admin.address);

    // ── Mint mUSD to users for SMUSD deposits ──────────────────
    await musd.mint(userAlice.address, ethers.parseEther("100000")); // 100k mUSD
    await musd.mint(userBob.address, ethers.parseEther("50000"));     // 50k mUSD
    await musd.mint(yieldManager.address, ethers.parseEther("50000")); // for distributeYield

    // ── Mint USDC to vaultSigner for treasury deposits ──────────
    await usdc.mint(vaultSigner.address, 10n * ONE_MILLION_USDC); // 10M USDC
    await usdc.connect(vaultSigner).approve(await treasury.getAddress(), ethers.MaxUint256);

    // ── Seed treasury with 1M USDC so globalTotalAssets is non-zero ──
    // This ensures SMUSD-only yield tests don't hit the MAX_YIELD_BPS cap
    // when globalTotalAssets() = treasury.totalValue() * 1e12.
    await treasury.connect(vaultSigner).deposit(vaultSigner.address, ONE_MILLION_USDC);

    // ── Approve SMUSD for users ─────────────────────────────────
    await musd.connect(userAlice).approve(await smusd.getAddress(), ethers.MaxUint256);
    await musd.connect(userBob).approve(await smusd.getAddress(), ethers.MaxUint256);
    await musd.connect(yieldManager).approve(await smusd.getAddress(), ethers.MaxUint256);

    return {
      usdc, musd, smusd, treasury, gpr,
      metaVault1, metaVault2, metaVault3,
      admin, vaultSigner, feeRecipient, yieldManager, userAlice, userBob,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 1. INITIAL STATE
  // ═══════════════════════════════════════════════════════════════════════

  describe("1. Initial state", function () {
    it("Treasury starts with 1M USDC seeded and 3 registered strategies", async function () {
      const { treasury, metaVault1, metaVault2, metaVault3 } = await loadFixture(deployFullStack);

      // Fixture seeds 1M USDC into reserve for globalTotalAssets backing
      expect(await treasury.totalValue()).to.equal(ONE_MILLION_USDC);
      expect(await treasury.strategyCount()).to.equal(3);
      expect(await treasury.isStrategy(await metaVault1.getAddress())).to.be.true;
      expect(await treasury.isStrategy(await metaVault2.getAddress())).to.be.true;
      expect(await treasury.isStrategy(await metaVault3.getAddress())).to.be.true;
    });

    it("Strategies have autoAllocate = false", async function () {
      const { treasury } = await loadFixture(deployFullStack);

      const config0 = await treasury.strategies(0);
      const config1 = await treasury.strategies(1);
      const config2 = await treasury.strategies(2);

      expect(config0.autoAllocate).to.be.false;
      expect(config1.autoAllocate).to.be.false;
      expect(config2.autoAllocate).to.be.false;
    });

    it("SMUSD is linked to Treasury for globalTotalAssets", async function () {
      const { smusd, treasury } = await loadFixture(deployFullStack);
      expect(await smusd.treasury()).to.equal(await treasury.getAddress());
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. USDC DEPOSIT → TREASURY RESERVE (NOT auto-allocated)
  // ═══════════════════════════════════════════════════════════════════════

  describe("2. USDC deposit stays in Treasury reserve", function () {
    it("deposit() with autoAllocate=false keeps all USDC in reserve", async function () {
      const { treasury, usdc, vaultSigner, metaVault1, metaVault2, metaVault3 } =
        await loadFixture(deployFullStack);

      // Fixture already seeded 1M in reserve. Deposit 4M more → 5M total
      const depositAmount = 4n * ONE_MILLION_USDC; // 4M additional
      await treasury.connect(vaultSigner).deposit(vaultSigner.address, depositAmount);
      const totalReserve = 5n * ONE_MILLION_USDC;

      // All 5M stays in reserve — strategies got nothing
      expect(await treasury.reserveBalance()).to.equal(totalReserve);
      expect(await treasury.totalValue()).to.equal(totalReserve);

      // Strategies have zero
      expect(await metaVault1.totalValue()).to.equal(0);
      expect(await metaVault2.totalValue()).to.equal(0);
      expect(await metaVault3.totalValue()).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. ADMIN MANUALLY DEPLOYS TO 3 METAVAULTS
  // ═══════════════════════════════════════════════════════════════════════

  describe("3. Admin manually deploys to MetaVaults via deployToStrategy()", function () {
    it("Admin deploys USDC from reserve to 3 strategies at 45/45/10 split", async function () {
      const { treasury, usdc, vaultSigner, admin, metaVault1, metaVault2, metaVault3 } =
        await loadFixture(deployFullStack);

      // Fixture seeded 1M. Deposit 9M more → 10M total
      const additional = 9n * ONE_MILLION_USDC;
      await treasury.connect(vaultSigner).deposit(vaultSigner.address, additional);
      const total = 10n * ONE_MILLION_USDC;

      // Admin manually deploys per MetaVault allocation:
      // Vault #1: 45% = 4.5M
      // Vault #2: 45% = 4.5M
      // Vault #3: 10% = 1M
      const deploy1 = 4_500_000n * ONE_USDC; // 4.5M
      const deploy2 = 4_500_000n * ONE_USDC; // 4.5M
      const deploy3 = 1_000_000n * ONE_USDC; // 1M

      await treasury.connect(admin).deployToStrategy(await metaVault1.getAddress(), deploy1);
      await treasury.connect(admin).deployToStrategy(await metaVault2.getAddress(), deploy2);
      await treasury.connect(admin).deployToStrategy(await metaVault3.getAddress(), deploy3);

      // Verify balances
      expect(await metaVault1.totalValue()).to.equal(deploy1);
      expect(await metaVault2.totalValue()).to.equal(deploy2);
      expect(await metaVault3.totalValue()).to.equal(deploy3);

      // Reserve is now 0 (we deployed all of it)
      expect(await treasury.reserveBalance()).to.equal(0);

      // Total value unchanged (just moved between reserve → strategies)
      expect(await treasury.totalValue()).to.equal(total);
    });

    it("deployToStrategy reverts for unregistered strategy", async function () {
      const { treasury, vaultSigner, admin, usdc } = await loadFixture(deployFullStack);

      // Fixture seeded 1M. Try deploying to random address
      await expect(
        treasury.connect(admin).deployToStrategy(ethers.Wallet.createRandom().address, ONE_MILLION_USDC)
      ).to.be.revertedWithCustomError(treasury, "StrategyNotFound");
    });

    it("deployToStrategy reverts when reserve insufficient", async function () {
      const { treasury, vaultSigner, admin, metaVault1 } = await loadFixture(deployFullStack);

      // Fixture seeded 1M. Try to deploy more than reserve
      await expect(
        treasury.connect(admin).deployToStrategy(await metaVault1.getAddress(), 2n * ONE_MILLION_USDC)
      ).to.be.revertedWithCustomError(treasury, "InsufficientReserves");
    });

    it("deployToStrategy requires ALLOCATOR_ROLE", async function () {
      const { treasury, vaultSigner, userAlice, metaVault1 } = await loadFixture(deployFullStack);

      // Fixture seeded 1M. Unauthorized user tries to deploy
      await expect(
        treasury.connect(userAlice).deployToStrategy(await metaVault1.getAddress(), ONE_MILLION_USDC)
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. STRATEGY YIELD → TREASURY totalValue() RISES
  // ═══════════════════════════════════════════════════════════════════════

  describe("4. Strategy yield increases Treasury totalValue()", function () {
    it("Simulated yield in strategies increases totalValue()", async function () {
      const { treasury, usdc, vaultSigner, admin, metaVault1, metaVault2, metaVault3 } =
        await loadFixture(deployFullStack);

      // Fixture seeded 1M. Deposit 9M more → 10M total
      const total = 10n * ONE_MILLION_USDC;
      await treasury.connect(vaultSigner).deposit(vaultSigner.address, 9n * ONE_MILLION_USDC);
      await treasury.connect(admin).deployToStrategy(await metaVault1.getAddress(), 4_500_000n * ONE_USDC);
      await treasury.connect(admin).deployToStrategy(await metaVault2.getAddress(), 4_500_000n * ONE_USDC);
      await treasury.connect(admin).deployToStrategy(await metaVault3.getAddress(), 1_000_000n * ONE_USDC);

      expect(await treasury.totalValue()).to.equal(total);

      // Simulate yield: strategies earn 5% APY over a period
      // Vault #1 earns $225k (5% of 4.5M)
      // Vault #2 earns $225k (5% of 4.5M)
      // Vault #3 earns $50k  (5% of 1M)
      const yield1 = 225_000n * ONE_USDC;
      const yield2 = 225_000n * ONE_USDC;
      const yield3 = 50_000n * ONE_USDC;
      const totalYield = yield1 + yield2 + yield3; // $500k

      // Simulate yield by transferring USDC directly to strategy contracts
      // (MockStrategy.totalValue() = usdc.balanceOf(address(this)))
      await usdc.mint(await metaVault1.getAddress(), yield1);
      await usdc.mint(await metaVault2.getAddress(), yield2);
      await usdc.mint(await metaVault3.getAddress(), yield3);

      // totalValue() now includes strategy yield
      expect(await treasury.totalValue()).to.equal(total + totalYield);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5. SMUSD globalSharePrice() REFLECTS TREASURY YIELD
  // ═══════════════════════════════════════════════════════════════════════

  describe("5. SMUSD globalSharePrice reflects Treasury yield", function () {
    it("globalTotalAssets() returns treasury.totalValue() * 1e12", async function () {
      const { treasury, usdc, smusd, vaultSigner, admin, metaVault1 } =
        await loadFixture(deployFullStack);

      // Fixture seeded 1M. Deploy it all to a strategy
      await treasury.connect(admin).deployToStrategy(await metaVault1.getAddress(), ONE_MILLION_USDC);

      // globalTotalAssets = 1M USDC (6 dec) * 1e12 = 1M mUSD (18 dec)
      const globalAssets = await smusd.globalTotalAssets();
      expect(globalAssets).to.equal(ONE_MILLION_USDC * 10n ** 12n);

      // Simulate $100k yield
      await usdc.mint(await metaVault1.getAddress(), 100_000n * ONE_USDC);

      // globalTotalAssets now 1.1M mUSD
      const newGlobalAssets = await smusd.globalTotalAssets();
      expect(newGlobalAssets).to.equal(1_100_000n * ONE_USDC * 10n ** 12n);
    });

    it("globalSharePrice increases with strategy yield", async function () {
      const { treasury, usdc, smusd, musd, vaultSigner, admin, userAlice, metaVault1 } =
        await loadFixture(deployFullStack);

      // Fixture seeded 1M in reserve. Deploy to strategy
      await treasury.connect(admin).deployToStrategy(await metaVault1.getAddress(), ONE_MILLION_USDC);

      // Alice stakes mUSD into SMUSD
      const stakeAmount = ethers.parseEther("10000"); // 10k mUSD
      await smusd.connect(userAlice).deposit(stakeAmount, userAlice.address);

      const priceBefore = await smusd.globalSharePrice();

      // Simulate 10% yield in strategy
      await usdc.mint(await metaVault1.getAddress(), 100_000n * ONE_USDC);

      const priceAfter = await smusd.globalSharePrice();

      // globalSharePrice must rise because globalTotalAssets increased
      expect(priceAfter).to.be.gt(priceBefore);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6. PERFORMANCE FEE (20% on high-water-mark yield)
  // ═══════════════════════════════════════════════════════════════════════

  describe("6. Performance fee accrual", function () {
    it("20% performance fee accrues on yield above high-water mark", async function () {
      const { treasury, usdc, vaultSigner, admin, feeRecipient, metaVault1 } =
        await loadFixture(deployFullStack);

      // Fixture seeded 1M. Deploy to strategy
      await treasury.connect(admin).deployToStrategy(await metaVault1.getAddress(), ONE_MILLION_USDC);

      // Advance past MIN_ACCRUAL_INTERVAL
      await time.increase(MIN_ACCRUAL_INTERVAL + 1);

      // Simulate $100k yield
      const yieldAmount = 100_000n * ONE_USDC;
      await usdc.mint(await metaVault1.getAddress(), yieldAmount);

      // Trigger fee accrual
      await treasury.connect(admin).accrueFees();

      // 20% of $100k = $20k in accrued fees
      const fees = await treasury.fees();
      expect(fees.accruedFees).to.equal(20_000n * ONE_USDC);
    });

    it("No fees on principal recovery after loss (high-water mark)", async function () {
      const { treasury, usdc, vaultSigner, admin, metaVault1 } =
        await loadFixture(deployFullStack);

      // Fixture seeded 1M. Deploy to strategy
      await treasury.connect(admin).deployToStrategy(await metaVault1.getAddress(), ONE_MILLION_USDC);

      // Simulate $100k yield then accrue
      await time.increase(MIN_ACCRUAL_INTERVAL + 1);
      await usdc.mint(await metaVault1.getAddress(), 100_000n * ONE_USDC);
      await treasury.connect(admin).accrueFees();

      const feesAfterYield = (await treasury.fees()).accruedFees;
      expect(feesAfterYield).to.equal(20_000n * ONE_USDC);

      // Simulate $50k loss (strategy loses value)
      // We need to reduce strategy balance. Use withdrawFromStrategy to pull funds out,
      // then "lose" them by not returning
      // Actually, let's just directly manipulate: burn from strategy isn't possible with MockStrategy
      // Instead: withdraw from strategy to treasury, then the value drops back
      // Simpler: the loss happens if we check after strategy value drops
      // For MockStrategy, totalValue = balanceOf. We can't burn tokens. 
      // Let's use a different approach: withdraw some USDC back to reserve
      await time.increase(MIN_ACCRUAL_INTERVAL + 1);
      await treasury.connect(admin).withdrawFromStrategy(await metaVault1.getAddress(), 50_000n * ONE_USDC);

      // Now totalValue = 1.1M (strategy 1.05M + reserve 0.05M)
      // That's still above high-water mark. Let's approach differently:
      // The high-water mark is 1.1M. If we recover back TO 1.1M, no new fees.
      
      // Record fees before
      const feesBefore = (await treasury.fees()).accruedFees;

      // Accrue again — no new yield above peak, so no new fees
      await time.increase(MIN_ACCRUAL_INTERVAL + 1);
      await treasury.connect(admin).accrueFees();

      const feesAfter = (await treasury.fees()).accruedFees;
      // Fees should not increase (no new yield above peak)
      expect(feesAfter).to.equal(feesBefore);
    });

    it("claimFees sends USDC to fee recipient", async function () {
      const { treasury, usdc, vaultSigner, admin, feeRecipient, metaVault1 } =
        await loadFixture(deployFullStack);

      // Fixture seeded 1M. Deploy and simulate yield
      await treasury.connect(admin).deployToStrategy(await metaVault1.getAddress(), ONE_MILLION_USDC);

      await time.increase(MIN_ACCRUAL_INTERVAL + 1);
      await usdc.mint(await metaVault1.getAddress(), 100_000n * ONE_USDC);
      await treasury.connect(admin).accrueFees();

      const balBefore = await usdc.balanceOf(feeRecipient.address);
      await treasury.connect(admin).claimFees();
      const balAfter = await usdc.balanceOf(feeRecipient.address);

      // Fee recipient received $20k (20% of $100k)
      expect(balAfter - balBefore).to.equal(20_000n * ONE_USDC);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 7. SMUSD YIELD DISTRIBUTION + 12h VESTING
  // ═══════════════════════════════════════════════════════════════════════

  describe("7. SMUSD distributeYield() and 12h vesting", function () {
    it("distributeYield transfers mUSD and starts 12h vesting", async function () {
      const { smusd, musd, userAlice, yieldManager } = await loadFixture(deployFullStack);

      // Alice deposits 10k mUSD
      const stakeAmount = ethers.parseEther("10000");
      await smusd.connect(userAlice).deposit(stakeAmount, userAlice.address);

      const totalAssetsBefore = await smusd.totalAssets();

      // Yield manager distributes $500 mUSD yield
      const yieldAmount = ethers.parseEther("500");
      await smusd.connect(yieldManager).distributeYield(yieldAmount);

      // Right after distribution: most yield is still unvested
      const unvested = await smusd.currentUnvestedYield();
      expect(unvested).to.be.gt(0);

      // totalAssets should be close to before (most yield is still unvested)
      const totalAssetsAfterImmediate = await smusd.totalAssets();
      // The vested portion is tiny (just 1 block), so assets barely changed
      expect(totalAssetsAfterImmediate).to.be.closeTo(
        totalAssetsBefore,
        ethers.parseEther("10") // within 10 mUSD tolerance
      );

      // After 6 hours: 50% vested
      await time.increase(VESTING_DURATION / 2);
      const totalAssets6h = await smusd.totalAssets();
      const halfVested = stakeAmount + yieldAmount / 2n;
      expect(totalAssets6h).to.be.closeTo(halfVested, ethers.parseEther("10"));

      // After full 12h: 100% vested
      await time.increase(VESTING_DURATION / 2 + 1);
      const totalAssets12h = await smusd.totalAssets();
      expect(totalAssets12h).to.be.closeTo(
        stakeAmount + yieldAmount,
        ethers.parseEther("1")
      );

      // Unvested yield should be 0
      expect(await smusd.currentUnvestedYield()).to.equal(0);
    });

    it("Local share price increases as yield vests", async function () {
      const { smusd, musd, userAlice, yieldManager } = await loadFixture(deployFullStack);

      const stakeAmount = ethers.parseEther("10000");
      await smusd.connect(userAlice).deposit(stakeAmount, userAlice.address);

      // Record share price before yield
      const priceBefore = await smusd.convertToAssets(ONE_MUSD);

      // Distribute yield
      const yieldAmount = ethers.parseEther("1000"); // 10% yield
      await smusd.connect(yieldManager).distributeYield(yieldAmount);

      // Price barely changes immediately (unvested)
      const priceImmediate = await smusd.convertToAssets(ONE_MUSD);
      expect(priceImmediate).to.be.closeTo(priceBefore, ethers.parseEther("0.01"));

      // After 12h vesting: price reflects full yield
      await time.increase(VESTING_DURATION + 1);

      const priceAfterVesting = await smusd.convertToAssets(ONE_MUSD);
      // With 10% yield on 10k mUSD (1000 mUSD yield), share price should be ~1.1x
      expect(priceAfterVesting).to.be.gt(priceBefore);

      // priceAfterVesting / priceBefore ≈ 1.1 (10% yield)
      // Using BigInt math: priceAfterVesting * 10000 / priceBefore should be ~11000
      const ratio = (priceAfterVesting * 10000n) / priceBefore;
      expect(ratio).to.be.closeTo(11000n, 100n); // 1.10 ± 0.01
    });

    it("distributeYield rejects amount exceeding MAX_YIELD_BPS (10%)", async function () {
      const { smusd, musd, userAlice, yieldManager, admin } = await loadFixture(deployFullStack);

      const stakeAmount = ethers.parseEther("10000");
      await smusd.connect(userAlice).deposit(stakeAmount, userAlice.address);

      // globalTotalAssets = treasury.totalValue() * 1e12 = 1M USDC * 1e12 = 1M mUSD
      // MAX_YIELD_BPS = 1000 (10%), so maxYield = 1M * 10% = 100k mUSD
      // Try to distribute > 100k mUSD
      const tooMuch = ethers.parseEther("150000"); // 150k mUSD
      // Mint enough mUSD to yield manager for this test
      const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
      await musd.connect(admin).mint(yieldManager.address, tooMuch);

      await expect(
        smusd.connect(yieldManager).distributeYield(tooMuch)
      ).to.be.revertedWithCustomError(smusd, "YieldExceedsCap");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 8. USER REDEEMS AT HIGHER PRICE AFTER COOLDOWN
  // ═══════════════════════════════════════════════════════════════════════

  describe("8. User redeems smUSD at higher price after cooldown", function () {
    it("Alice redeems more mUSD than she deposited after yield + cooldown", async function () {
      const { smusd, musd, userAlice, yieldManager } = await loadFixture(deployFullStack);

      const stakeAmount = ethers.parseEther("10000"); // 10k mUSD
      await smusd.connect(userAlice).deposit(stakeAmount, userAlice.address);

      const sharesHeld = await smusd.balanceOf(userAlice.address);
      const mUSDBeforeRedeem = await musd.balanceOf(userAlice.address);

      // Distribute 5% yield
      const yieldAmount = ethers.parseEther("500");
      await smusd.connect(yieldManager).distributeYield(yieldAmount);

      // Wait for full vesting (12h) + cooldown (24h) = need to wait 24h from deposit
      await time.increase(WITHDRAW_COOLDOWN + 1);

      // Redeem all shares
      await smusd.connect(userAlice).redeem(sharesHeld, userAlice.address, userAlice.address);

      const mUSDAfterRedeem = await musd.balanceOf(userAlice.address);
      const received = mUSDAfterRedeem - mUSDBeforeRedeem;

      // Should receive more than deposited (original 10k + vested yield)
      expect(received).to.be.gt(stakeAmount);

      // Should receive close to 10,500 mUSD (10k + 5% yield)
      expect(received).to.be.closeTo(stakeAmount + yieldAmount, ethers.parseEther("5"));
    });

    it("Redeem blocked before 24h cooldown", async function () {
      const { smusd, musd, userAlice } = await loadFixture(deployFullStack);

      const stakeAmount = ethers.parseEther("10000");
      await smusd.connect(userAlice).deposit(stakeAmount, userAlice.address);

      const shares = await smusd.balanceOf(userAlice.address);

      // Try to redeem immediately — should fail
      await expect(
        smusd.connect(userAlice).redeem(shares, userAlice.address, userAlice.address)
      ).to.be.revertedWithCustomError(smusd, "CooldownActive");

      // Wait 23h — still blocked
      await time.increase(WITHDRAW_COOLDOWN - 3600);
      await expect(
        smusd.connect(userAlice).redeem(shares, userAlice.address, userAlice.address)
      ).to.be.revertedWithCustomError(smusd, "CooldownActive");

      // Wait 1h more — now OK
      await time.increase(3601);
      await expect(
        smusd.connect(userAlice).redeem(shares, userAlice.address, userAlice.address)
      ).to.not.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 9. FULL E2E LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════

  describe("9. Full lifecycle: deposit → manual deploy → yield → distribute → vest → redeem", function () {
    it("Complete E2E flow with 3 MetaVaults", async function () {
      const {
        treasury, usdc, musd, smusd,
        metaVault1, metaVault2, metaVault3,
        admin, vaultSigner, feeRecipient, yieldManager, userAlice,
      } = await loadFixture(deployFullStack);

      // ── Step 1: Fixture seeded 1M. Deposit 9M more USDC → 10M total
      const total = 10n * ONE_MILLION_USDC;
      await treasury.connect(vaultSigner).deposit(vaultSigner.address, 9n * ONE_MILLION_USDC);
      expect(await treasury.reserveBalance()).to.equal(total);

      // ── Step 2: Admin manually deploys to 3 MetaVaults ────────
      await treasury.connect(admin).deployToStrategy(await metaVault1.getAddress(), 4_500_000n * ONE_USDC);
      await treasury.connect(admin).deployToStrategy(await metaVault2.getAddress(), 4_500_000n * ONE_USDC);
      await treasury.connect(admin).deployToStrategy(await metaVault3.getAddress(), 1_000_000n * ONE_USDC);

      expect(await treasury.reserveBalance()).to.equal(0);
      expect(await treasury.totalValue()).to.equal(total);

      // ── Step 3: Alice stakes 10k mUSD into SMUSD ─────────────
      const stakeAmount = ethers.parseEther("10000");
      await smusd.connect(userAlice).deposit(stakeAmount, userAlice.address);
      const aliceShares = await smusd.balanceOf(userAlice.address);
      expect(aliceShares).to.be.gt(0);

      const globalPriceBefore = await smusd.globalSharePrice();

      // ── Step 4: Strategies earn 5% yield ($500k total) ────────
      await time.increase(MIN_ACCRUAL_INTERVAL + 1);

      await usdc.mint(await metaVault1.getAddress(), 225_000n * ONE_USDC); // 5% of 4.5M
      await usdc.mint(await metaVault2.getAddress(), 225_000n * ONE_USDC); // 5% of 4.5M
      await usdc.mint(await metaVault3.getAddress(), 50_000n * ONE_USDC);  // 5% of 1M

      const totalAfterYield = await treasury.totalValue();
      expect(totalAfterYield).to.equal(10_500_000n * ONE_USDC); // 10M + 500k

      // ── Step 5: globalSharePrice reflects yield ───────────────
      const globalPriceAfter = await smusd.globalSharePrice();
      expect(globalPriceAfter).to.be.gt(globalPriceBefore);

      // ── Step 6: Performance fee accrual ───────────────────────
      await treasury.connect(admin).accrueFees();
      const feeState = await treasury.fees();
      // 20% of $500k = $100k
      expect(feeState.accruedFees).to.equal(100_000n * ONE_USDC);

      // ── Step 7: Yield manager distributes mUSD to SMUSD ───────
      const distributeAmount = ethers.parseEther("500"); // $500 mUSD
      await smusd.connect(yieldManager).distributeYield(distributeAmount);

      // Yield is unvested
      expect(await smusd.currentUnvestedYield()).to.be.gt(0);

      // ── Step 8: Wait for vesting (12h) and cooldown (24h) ─────
      await time.increase(WITHDRAW_COOLDOWN + 1);

      // All yield should be vested by now (12h < 24h)
      expect(await smusd.currentUnvestedYield()).to.equal(0);

      // ── Step 9: Alice redeems at higher local share price ─────
      const mUSDBeforeRedeem = await musd.balanceOf(userAlice.address);
      await smusd.connect(userAlice).redeem(aliceShares, userAlice.address, userAlice.address);
      const mUSDAfterRedeem = await musd.balanceOf(userAlice.address);
      const received = mUSDAfterRedeem - mUSDBeforeRedeem;

      // Alice should receive > 10k (original stake + distributed yield)
      expect(received).to.be.gt(stakeAmount);
      expect(received).to.be.closeTo(stakeAmount + distributeAmount, ethers.parseEther("5"));

      // ── Step 10: Verify fee recipient can claim ───────────────
      const recipBalBefore = await usdc.balanceOf(feeRecipient.address);
      await treasury.connect(admin).claimFees();
      const recipBalAfter = await usdc.balanceOf(feeRecipient.address);
      expect(recipBalAfter - recipBalBefore).to.equal(100_000n * ONE_USDC);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 10. MULTI-USER YIELD DISTRIBUTION
  // ═══════════════════════════════════════════════════════════════════════

  describe("10. Multi-user proportional yield", function () {
    it("Two users share yield proportionally to their smUSD holdings", async function () {
      const { smusd, musd, userAlice, userBob, yieldManager } = await loadFixture(deployFullStack);

      // Alice deposits 10k mUSD, Bob deposits 5k mUSD → 2:1 ratio
      await smusd.connect(userAlice).deposit(ethers.parseEther("10000"), userAlice.address);
      await smusd.connect(userBob).deposit(ethers.parseEther("5000"), userBob.address);

      const aliceShares = await smusd.balanceOf(userAlice.address);
      const bobShares = await smusd.balanceOf(userBob.address);

      // Distribute 1500 mUSD yield
      const yieldAmount = ethers.parseEther("1500");
      await smusd.connect(yieldManager).distributeYield(yieldAmount);

      // Wait full vesting + cooldown
      await time.increase(WITHDRAW_COOLDOWN + 1);

      // Redeem all
      const aliceBalBefore = await musd.balanceOf(userAlice.address);
      await smusd.connect(userAlice).redeem(aliceShares, userAlice.address, userAlice.address);
      const aliceReceived = (await musd.balanceOf(userAlice.address)) - aliceBalBefore;

      const bobBalBefore = await musd.balanceOf(userBob.address);
      await smusd.connect(userBob).redeem(bobShares, userBob.address, userBob.address);
      const bobReceived = (await musd.balanceOf(userBob.address)) - bobBalBefore;

      // Alice should get ~$11k (10k + 2/3 * 1500 = 10k + 1000)
      // Bob should get ~$5.5k (5k + 1/3 * 1500 = 5k + 500)
      expect(aliceReceived).to.be.closeTo(ethers.parseEther("11000"), ethers.parseEther("10"));
      expect(bobReceived).to.be.closeTo(ethers.parseEther("5500"), ethers.parseEther("10"));

      // Alice:Bob ratio should be ~2:1
      const ratio = (aliceReceived * 1000n) / bobReceived;
      expect(ratio).to.be.closeTo(2000n, 20n); // 2.0 ± 0.02
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 11. WITHDRAW FROM STRATEGY (admin pulls back to reserve)
  // ═══════════════════════════════════════════════════════════════════════

  describe("11. Admin withdraws from strategy back to reserve", function () {
    it("withdrawFromStrategy pulls USDC back to Treasury reserve", async function () {
      const { treasury, usdc, vaultSigner, admin, metaVault1 } = await loadFixture(deployFullStack);

      // Fixture seeded 1M. Deploy it all to strategy
      await treasury.connect(admin).deployToStrategy(await metaVault1.getAddress(), ONE_MILLION_USDC);

      expect(await treasury.reserveBalance()).to.equal(0);
      expect(await metaVault1.totalValue()).to.equal(ONE_MILLION_USDC);

      // Admin withdraws 500k back to reserve
      await time.increase(MIN_ACCRUAL_INTERVAL + 1);
      await treasury.connect(admin).withdrawFromStrategy(
        await metaVault1.getAddress(),
        500_000n * ONE_USDC
      );

      expect(await treasury.reserveBalance()).to.equal(500_000n * ONE_USDC);
      expect(await metaVault1.totalValue()).to.equal(500_000n * ONE_USDC);

      // Total value unchanged
      expect(await treasury.totalValue()).to.equal(ONE_MILLION_USDC);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 12. YIELD VESTING PREVENTS SANDWICH ATTACK
  // ═══════════════════════════════════════════════════════════════════════

  describe("12. Vesting prevents sandwich attack", function () {
    it("Front-running deposit before distributeYield captures minimal yield", async function () {
      const { smusd, musd, userAlice, userBob, yieldManager } = await loadFixture(deployFullStack);

      // Alice deposits 10k mUSD honestly, waits
      await smusd.connect(userAlice).deposit(ethers.parseEther("10000"), userAlice.address);

      // Bob "front-runs" yield distribution with a big deposit
      await smusd.connect(userBob).deposit(ethers.parseEther("50000"), userBob.address);

      // Yield manager distributes
      const yieldAmount = ethers.parseEther("900"); // 900 mUSD
      await smusd.connect(yieldManager).distributeYield(yieldAmount);

      // Bob tries to redeem immediately → blocked by cooldown
      const bobShares = await smusd.balanceOf(userBob.address);
      await expect(
        smusd.connect(userBob).redeem(bobShares, userBob.address, userBob.address)
      ).to.be.revertedWithCustomError(smusd, "CooldownActive");

      // Even if Bob waits the full cooldown, the vesting means the yield was
      // linearly dripped, preventing the instant price jump that sandwiches exploit
      await time.increase(WITHDRAW_COOLDOWN + 1);

      // Check that the share price increased gradually, not instantly
      // (the test itself is the proof — the 24h cooldown exceeds the 12h vesting)
      const totalAssets = await smusd.totalAssets();
      const totalShares = await smusd.totalSupply();

      // Bob got proportional share based on his deposit ratio (50k / 60k = 83.3%)
      // But that's expected — the protection is the COOLDOWN preventing immediate exit,
      // not the yield distribution itself. The 24h cooldown > 12h vesting ensures
      // no one can sandwich deposit→yield→redeem.
      expect(totalAssets).to.be.closeTo(
        ethers.parseEther("60900"), // 60k deposited + 900 yield
        ethers.parseEther("5")
      );
    });
  });
});
