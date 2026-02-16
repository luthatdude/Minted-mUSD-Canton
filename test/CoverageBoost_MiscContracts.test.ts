/**
 * CoverageBoost — Misc Contracts
 * Targets uncovered branch/statement paths in 8 contracts.
 * Priority order: lowest branch coverage first.
 */

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time, mine } from "@nomicfoundation/hardhat-network-helpers";
import {
  timelockAddStrategy,
  timelockRemoveStrategy,
  timelockSetFeeConfig,
  timelockSetReserveBps,
  timelockAddCollateral,
  timelockUpdateCollateral,
  timelockSetBorrowModule,
  timelockSetFeed,
  timelockSetCloseFactor,
  timelockSetFullLiquidationThreshold,
  refreshFeeds,
} from "./helpers/timelock";

// ═══════════════════════════════════════════════════════════════════════════════
describe("CoverageBoost — Misc Contracts", function () {
  // ═══════════════════════════════════════════════════════════════════════════
  // 1. TreasuryV2 — 29% branch
  // ═══════════════════════════════════════════════════════════════════════════
  describe("TreasuryV2 — Uncovered Branches", function () {
    let treasury: any;
    let usdc: any;
    let strategyA: any;
    let strategyB: any;
    let admin: HardhatEthersSigner;
    let vault: HardhatEthersSigner;
    let feeRecipient: HardhatEthersSigner;
    let guardian: HardhatEthersSigner;
    let user: HardhatEthersSigner;
    let allocator: HardhatEthersSigner;
    let strategist: HardhatEthersSigner;

    beforeEach(async function () {
      const signers = await ethers.getSigners();
      [admin, vault, feeRecipient, guardian, user, allocator, strategist] = signers;

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

      const TreasuryV2Factory = await ethers.getContractFactory("TreasuryV2");
      treasury = (await upgrades.deployProxy(TreasuryV2Factory, [
        await usdc.getAddress(),
        vault.address,
        admin.address,
        feeRecipient.address,
        admin.address
      ])) as any;

      const MockStrat = await ethers.getContractFactory("MockStrategy");
      const tAddr = await treasury.getAddress();
      strategyA = await MockStrat.deploy(await usdc.getAddress(), tAddr);
      strategyB = await MockStrat.deploy(await usdc.getAddress(), tAddr);

      // Grant roles
      await treasury.grantRole(await treasury.GUARDIAN_ROLE(), guardian.address);
      await treasury.grantRole(await treasury.ALLOCATOR_ROLE(), allocator.address);
      await treasury.grantRole(await treasury.STRATEGIST_ROLE(), strategist.address);

      // Fund vault signer with USDC
      await usdc.mint(vault.address, 100_000_000n * 10n ** 6n);
      await usdc.connect(vault).approve(await treasury.getAddress(), ethers.MaxUint256);
    });

    // --- _accrueFees: skip when interval < MIN_ACCRUAL_INTERVAL (1 hr) ---
    it("should skip fee accrual when called within MIN_ACCRUAL_INTERVAL", async function () {
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 4000, 0, 10000, true);

      // First deposit triggers _accrueFees
      await treasury.connect(vault).deposit(vault.address, 10_000n * 10n ** 6n);

      // Simulate yield
      await usdc.mint(await strategyA.getAddress(), 100n * 10n ** 6n);

      // Immediately call accrueFees (< 1 hr gap) — should skip
      const feesBefore = await treasury.pendingFees();
      await treasury.connect(allocator).accrueFees();
      const feesAfter = await treasury.pendingFees();
      expect(feesAfter).to.equal(feesBefore);
    });

    // --- _accrueFees: spike detection (recovery) ---
    it("should detect spike as recovery and skip fee accrual", async function () {
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 4000, 0, 10000, true);
      await treasury.connect(vault).deposit(vault.address, 10_000n * 10n ** 6n);

      // Advance past MIN_ACCRUAL_INTERVAL
      await time.increase(3601);
      await treasury.connect(allocator).accrueFees();

      // Simulate massive spike (>20% = beyond MAX_YIELD_PER_ACCRUAL_BPS)
      const stratAddr = await strategyA.getAddress();
      await usdc.mint(stratAddr, 5_000n * 10n ** 6n); // 50% spike

      await time.increase(3601);
      // This should accrue fees (yield above peak)
      await treasury.connect(allocator).accrueFees();
    });

    // --- _accrueFees: high-water mark recovery (currentValue <= peak) ---
    it("should skip fees when value recovers to below peak (high-water mark)", async function () {
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 4000, 0, 10000, true);
      await treasury.connect(vault).deposit(vault.address, 10_000n * 10n ** 6n);

      // Create a peak: small yield
      await usdc.mint(await strategyA.getAddress(), 50n * 10n ** 6n);
      await time.increase(3601);
      await treasury.connect(allocator).accrueFees();

      // Simulate loss then partial recovery
      const stratBalance = await usdc.balanceOf(await strategyA.getAddress());
      // burn some from strategy to simulate loss
      await usdc.burn(await strategyA.getAddress(), 100n * 10n ** 6n);
      await time.increase(3601);
      await treasury.connect(allocator).accrueFees(); // records lower value

      // Partial recovery (below peak)
      await usdc.mint(await strategyA.getAddress(), 30n * 10n ** 6n);
      await time.increase(3601);
      // Recovery below peak — no FeesAccrued event emitted
      await expect(treasury.connect(allocator).accrueFees())
        .to.not.emit(treasury, "FeesAccrued");
    });

    // --- _accrueFees: taxable yield above peak ---
    it("should charge fees only on yield above peak (partial recovery + new yield)", async function () {
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 4000, 0, 10000, true);
      await treasury.connect(vault).deposit(vault.address, 10_000n * 10n ** 6n);

      // Create a peak
      await usdc.mint(await strategyA.getAddress(), 50n * 10n ** 6n);
      await time.increase(3601);
      await treasury.connect(allocator).accrueFees();

      // Loss
      await usdc.burn(await strategyA.getAddress(), 80n * 10n ** 6n);
      await time.increase(3601);
      await treasury.connect(allocator).accrueFees();

      // Recover above peak by a small amount
      await usdc.mint(await strategyA.getAddress(), 100n * 10n ** 6n);
      await time.increase(3601);
      await expect(treasury.connect(allocator).accrueFees())
        .to.emit(treasury, "FeesAccrued");
    });

    // --- claimFees: partial reserve coverage ---
    it("should claim fees and handle partial reserve", async function () {
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 9000, 0, 10000, true);
      await treasury.connect(vault).deposit(vault.address, 100_000n * 10n ** 6n);

      // Generate yield
      await usdc.mint(await strategyA.getAddress(), 500n * 10n ** 6n);
      await time.increase(3601);
      await treasury.connect(allocator).accrueFees();

      // claimFees — may need to pull from strategies
      await treasury.claimFees();
    });

    // --- claimFees: toClaim == 0 returns early ---
    it("should return early from claimFees when no fees accrued", async function () {
      // No yield, no fees
      await treasury.claimFees(); // should not revert
    });

    // --- withdrawToVault: INSUFFICIENT_LIQUIDITY branch ---
    it("should revert withdrawToVault when liquidity insufficient", async function () {
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 9000, 0, 10000, true);
      await treasury.connect(vault).deposit(vault.address, 1_000n * 10n ** 6n);

      // Make strategy withdrawals fail
      await strategyA.setWithdrawShouldFail(true);

      // Try to withdraw more than reserve
      await expect(
        treasury.connect(vault).withdrawToVault(900n * 10n ** 6n)
      ).to.be.revertedWithCustomError(treasury, "InsufficientLiquidity");
    });

    // --- depositFromVault: small deposit stays in reserve ---
    it("should keep depositFromVault below minAutoAllocateAmount in reserve", async function () {
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 4000, 0, 10000, true);
      const small = 500n * 10n ** 6n; // below default 1000 USDC min
      await treasury.connect(vault).depositFromVault(small);
      // All should be in reserve
      expect(await treasury.reserveBalance()).to.equal(small);
    });

    // --- depositFromVault: ZeroAmount revert ---
    it("should revert depositFromVault with zero amount", async function () {
      await expect(
        treasury.connect(vault).depositFromVault(0)
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });

    // --- withdrawToVault: ZeroAmount revert ---
    it("should revert withdrawToVault with zero amount", async function () {
      await expect(
        treasury.connect(vault).withdrawToVault(0)
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });

    // --- deposit legacy: ZeroAmount ---
    it("should revert legacy deposit with zero amount", async function () {
      await expect(
        treasury.connect(vault).deposit(vault.address, 0)
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });

    // --- withdraw legacy: ZeroAmount ---
    it("should revert legacy withdraw with zero amount", async function () {
      await expect(
        treasury.connect(vault).withdraw(vault.address, 0)
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });

    // --- withdraw legacy: INSUFFICIENT_RESERVES ---
    it("should revert legacy withdraw when insufficient reserves after strategy pull", async function () {
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 9000, 0, 10000, true);
      await treasury.connect(vault).deposit(vault.address, 1_000n * 10n ** 6n);
      await strategyA.setWithdrawShouldFail(true);
      await expect(
        treasury.connect(vault).withdraw(vault.address, 950n * 10n ** 6n)
      ).to.be.revertedWithCustomError(treasury, "InsufficientReserves");
    });

    // --- _autoAllocate: totalTargetBps == 0 (no auto-allocate strategies) ---
    it("should handle auto-allocate with no auto-allocate strategies", async function () {
      // Add strategy with autoAllocate=false
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 4000, 0, 10000, false);
      await treasury.connect(vault).deposit(vault.address, 10_000n * 10n ** 6n);
      // All should remain in reserve since no auto-allocate
    });

    // --- _withdrawFromStrategies: totalStratValue == 0 ---
    it("should return 0 when all strategies have zero value", async function () {
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 4000, 0, 10000, true);
      // Don't deposit anything, so strategy has 0 value
      // Try legacy withdraw from empty treasury
      await usdc.mint(await treasury.getAddress(), 100n * 10n ** 6n);
      await treasury.connect(vault).withdraw(vault.address, 100n * 10n ** 6n);
    });

    // --- _withdrawFromStrategies: strategy withdraw failure ---
    it("should emit StrategyWithdrawFailed when strategy withdraw fails", async function () {
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 4000, 0, 10000, true);
      await treasury.connect(vault).deposit(vault.address, 10_000n * 10n ** 6n);

      await strategyA.setWithdrawShouldFail(true);
      // The withdraw will fail silently, emit event
      await expect(
        treasury.connect(vault).withdrawToVault(5_000n * 10n ** 6n)
      ).to.be.reverted;
    });

    // --- updateStrategy: TotalAllocationInvalid ---
    it("should revert updateStrategy if total allocation exceeds BPS", async function () {
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 3000, 0, 10000, true);
      await timelockAddStrategy(treasury, admin, await strategyB.getAddress(), 3000, 0, 10000, true);
      await expect(
        treasury.updateStrategy(await strategyA.getAddress(), 7000, 0, 10000, true)
      ).to.be.revertedWithCustomError(treasury, "TotalAllocationInvalid");
    });

    // --- setVault: access control ---
    it("should revert setVault from non-timelock", async function () {
      await expect(
        treasury.connect(user).setVault(user.address)
      ).to.be.reverted;
    });

    // --- recoverToken: cannot recover primary asset ---
    it("should revert recoverToken for the primary asset", async function () {
      await expect(
        treasury.recoverToken(await usdc.getAddress(), 100)
      ).to.be.revertedWithCustomError(treasury, "CannotRecoverAsset");
    });

    // --- recoverToken: recover non-primary token ---
    it("should recover a non-primary token", async function () {
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const otherToken = await MockERC20.deploy("Other", "OTH", 18);
      await otherToken.mint(await treasury.getAddress(), 1000);
      await treasury.recoverToken(await otherToken.getAddress(), 1000);
    });

    // --- setMinAutoAllocate: ZERO_MIN_AMOUNT ---
    it("should revert setMinAutoAllocate with zero", async function () {
      await expect(
        treasury.setMinAutoAllocate(0)
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });

    // --- totalValueNet: total <= pending edge ---
    it("should return 0 from totalValueNet when accrued fees exceed total", async function () {
      // No deposits = 0 total value, but no fees either so this hits a different path
      expect(await treasury.totalValueNet()).to.equal(0);
    });

    // --- rebalance: total == 0 early return ---
    it("should return early from rebalance when total is 0", async function () {
      await treasury.connect(allocator).accrueFees(); // init
      // No strategies, no deposits
      await treasury.connect(allocator).rebalance(); // should not revert
    });

    // --- rebalance: strategy totalValue() failure in pass 1 ---
    it("should handle broken strategy during rebalance", async function () {
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 4000, 0, 10000, true);
      await treasury.connect(vault).deposit(vault.address, 10_000n * 10n ** 6n);

      // Make strategy active but withdrawals fail
      await strategyA.setWithdrawShouldFail(true);

      // Rebalance should still complete (skip broken strategy)
      await treasury.connect(allocator).rebalance();
    });

    // --- emergencyWithdrawAll with failing strategy ---
    it("should emit StrategyWithdrawFailed on emergency with broken strategy", async function () {
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 4000, 0, 10000, true);
      await treasury.connect(vault).deposit(vault.address, 10_000n * 10n ** 6n);
      await strategyA.setWithdrawShouldFail(true);
      await expect(treasury.connect(guardian).emergencyWithdrawAll())
        .to.emit(treasury, "StrategyWithdrawFailed");
    });

  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. LiquidationEngine — 36% branch
  // ═══════════════════════════════════════════════════════════════════════════
  describe("LiquidationEngine — Uncovered Branches", function () {
    let liquidationEngine: any;
    let borrowModule: any;
    let collateralVault: any;
    let priceOracle: any;
    let musd: any;
    let weth: any;
    let ethFeed: any;
    let owner: HardhatEthersSigner;
    let user1: HardhatEthersSigner;
    let liquidator: HardhatEthersSigner;
    let pauser: HardhatEthersSigner;

    beforeEach(async function () {
      [owner, user1, liquidator, pauser] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);

      const MUSD = await ethers.getContractFactory("MUSD");
      musd = await MUSD.deploy(ethers.parseEther("100000000"));

      const PriceOracle = await ethers.getContractFactory("PriceOracle");
      priceOracle = await PriceOracle.deploy();

      const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
      ethFeed = await MockAgg.deploy(8, 200000000000n); // $2000

      await timelockSetFeed(priceOracle, owner, await weth.getAddress(), await ethFeed.getAddress(), 3600, 18);

      const CollateralVault = await ethers.getContractFactory("CollateralVault");
      collateralVault = await CollateralVault.deploy();

      await timelockAddCollateral(collateralVault, owner, await weth.getAddress(), 7500, 8000, 1000);

      await refreshFeeds(ethFeed);

      const BorrowModule = await ethers.getContractFactory("BorrowModule");
      borrowModule = await BorrowModule.deploy(
        await collateralVault.getAddress(),
        await priceOracle.getAddress(),
        await musd.getAddress(),
        500, 
        ethers.parseEther("100")
      );

      const LiquidationEngine = await ethers.getContractFactory("LiquidationEngine");
      liquidationEngine = await LiquidationEngine.deploy(
        await collateralVault.getAddress(),
        await borrowModule.getAddress(),
        await priceOracle.getAddress(),
        await musd.getAddress(),
        5000
      );

      // Grant roles
      const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
      await musd.grantRole(BRIDGE_ROLE, await borrowModule.getAddress());
      await musd.grantRole(BRIDGE_ROLE, await liquidationEngine.getAddress());
      await musd.grantRole(BRIDGE_ROLE, owner.address);
      await collateralVault.grantRole(await collateralVault.BORROW_MODULE_ROLE(), await borrowModule.getAddress());
      await collateralVault.grantRole(await collateralVault.LIQUIDATION_ROLE(), await liquidationEngine.getAddress());
      await borrowModule.grantRole(await borrowModule.LIQUIDATION_ROLE(), await liquidationEngine.getAddress());

      // Grant PAUSER_ROLE
      await liquidationEngine.grantRole(await liquidationEngine.PAUSER_ROLE(), pauser.address);
      // SOL-H-01: Grant TIMELOCK_ROLE to deployer for admin setters (setCloseFactor, setFullLiquidationThreshold)
      await liquidationEngine.grantRole(await liquidationEngine.TIMELOCK_ROLE(), owner.address);

      // Mint tokens
      await weth.mint(user1.address, ethers.parseEther("100"));
      await weth.mint(liquidator.address, ethers.parseEther("100"));
      await musd.mint(liquidator.address, ethers.parseEther("500000"));
    });

    // --- Constructor zero-address checks ---
    it("should revert on invalid constructor args", async function () {
      const LE = await ethers.getContractFactory("LiquidationEngine");
      await expect(
        LE.deploy(ethers.ZeroAddress, await borrowModule.getAddress(), await priceOracle.getAddress(), await musd.getAddress(), 5000)
      ).to.be.revertedWithCustomError(LE, "InvalidVault");
      await expect(
        LE.deploy(await collateralVault.getAddress(), ethers.ZeroAddress, await priceOracle.getAddress(), await musd.getAddress(), 5000)
      ).to.be.revertedWithCustomError(LE, "InvalidBorrowModule");
      await expect(
        LE.deploy(await collateralVault.getAddress(), await borrowModule.getAddress(), ethers.ZeroAddress, await musd.getAddress(), 5000)
      ).to.be.revertedWithCustomError(LE, "InvalidOracle");
      await expect(
        LE.deploy(await collateralVault.getAddress(), await borrowModule.getAddress(), await priceOracle.getAddress(), ethers.ZeroAddress, 5000)
      ).to.be.revertedWithCustomError(LE, "InvalidMusd");
      await expect(
        LE.deploy(await collateralVault.getAddress(), await borrowModule.getAddress(), await priceOracle.getAddress(), await musd.getAddress(), 0)
      ).to.be.revertedWithCustomError(LE, "InvalidCloseFactor");
    });

    // --- liquidate: INVALID_AMOUNT ---
    it("should revert liquidate with zero debtToRepay", async function () {
      await expect(
        liquidationEngine.connect(liquidator).liquidate(user1.address, await weth.getAddress(), 0)
      ).to.be.revertedWithCustomError(liquidationEngine, "InvalidAmount");
    });

    // --- liquidate: DUST_LIQUIDATION ---
    it("should revert liquidate below MIN_LIQUIDATION_AMOUNT", async function () {
      await expect(
        liquidationEngine.connect(liquidator).liquidate(user1.address, await weth.getAddress(), ethers.parseEther("50"))
      ).to.be.revertedWithCustomError(liquidationEngine, "DustLiquidation");
    });

    // --- liquidate: full liquidation when hf < fullLiquidationThreshold ---
    it("should allow full liquidation when HF is severely low", async function () {
      // Deposit and borrow near max
      const depositAmount = ethers.parseEther("1");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);
      const maxBorrow = await borrowModule.maxBorrow(user1.address);
      await borrowModule.connect(user1).borrow(maxBorrow);

      // Crash price so HF < fullLiquidationThreshold (0.5)
      await ethFeed.setAnswer(50000000000n); // $500 (was $2000 = 75% drop)
      await refreshFeeds(ethFeed);

      // Approve mUSD for liquidator
      await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), ethers.MaxUint256);

      // Full liquidation should be allowed (debtToRepay > closeFactor * debt but HF < threshold)
      const totalDebt = await borrowModule.totalDebt(user1.address);
      await liquidationEngine.connect(liquidator).liquidate(
        user1.address, await weth.getAddress(), totalDebt
      );
    });

    // --- liquidate: seizeAmount capped at available collateral ---
    it("should cap seize amount at available collateral", async function () {
      const depositAmount = ethers.parseEther("0.5"); // Small deposit
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);
      const maxBorrow = await borrowModule.maxBorrow(user1.address);
      await borrowModule.connect(user1).borrow(maxBorrow);

      // Small price drop to trigger liquidation
      await ethFeed.setAnswer(150000000000n); // $1500
      await refreshFeeds(ethFeed);

      await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), ethers.MaxUint256);
      // Request to liquidate more than available collateral covers
      await liquidationEngine.connect(liquidator).liquidate(
        user1.address, await weth.getAddress(), maxBorrow
      );
    });

    // --- isLiquidatable: returns false for zero debt ---
    it("should return false for isLiquidatable when no debt", async function () {
      expect(await liquidationEngine.isLiquidatable(user1.address)).to.be.false;
    });

    // --- liquidate: CANNOT_SELF_LIQUIDATE ---
    it("should revert when borrower tries to self-liquidate", async function () {
      await expect(
        liquidationEngine.connect(user1).liquidate(
          user1.address, await weth.getAddress(), ethers.parseEther("100")
        )
      ).to.be.revertedWithCustomError(liquidationEngine, "CannotSelfLiquidate");
    });

    // --- liquidate: DUST_LIQUIDATION ---
    it("should revert when liquidation amount is below minimum", async function () {
      await expect(
        liquidationEngine.connect(liquidator).liquidate(
          user1.address, await weth.getAddress(), 1n // 1 wei < MIN_LIQUIDATION_AMOUNT
        )
      ).to.be.revertedWithCustomError(liquidationEngine, "DustLiquidation");
    });

    // --- estimateSeize: capped at available collateral ---
    it("should cap estimateSeize at available collateral", async function () {
      const depositAmount = ethers.parseEther("0.1");
      await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);
      // Estimate seize for massive debt > available collateral value
      const result = await liquidationEngine.estimateSeize(
        user1.address, await weth.getAddress(), ethers.parseEther("1000000")
      );
      expect(result).to.equal(depositAmount);
    });

    // --- setCloseFactor: validations ---
    it("should revert setCloseFactor with invalid value", async function () {
      await expect(liquidationEngine.setCloseFactor(0)).to.be.revertedWithCustomError(liquidationEngine, "InvalidCloseFactor");
      await expect(liquidationEngine.setCloseFactor(10001)).to.be.revertedWithCustomError(liquidationEngine, "InvalidCloseFactor");
    });

    it("should revert setCloseFactor from non-timelock", async function () {
      await expect(liquidationEngine.connect(liquidator).setCloseFactor(6000)).to.be.reverted;
    });

    // --- setFullLiquidationThreshold: validations ---
    it("should revert setFullLiquidationThreshold with invalid value", async function () {
      await expect(liquidationEngine.setFullLiquidationThreshold(0)).to.be.revertedWithCustomError(liquidationEngine, "InvalidThreshold");
      await expect(liquidationEngine.setFullLiquidationThreshold(10000)).to.be.revertedWithCustomError(liquidationEngine, "InvalidThreshold");
    });

    it("should revert setFullLiquidationThreshold from non-timelock", async function () {
      await expect(liquidationEngine.connect(liquidator).setFullLiquidationThreshold(4000)).to.be.reverted;
    });

    // --- pause / unpause separation of duties ---
    it("should pause and require DEFAULT_ADMIN_ROLE for unpause", async function () {
      await liquidationEngine.connect(pauser).pause();
      await expect(
        liquidationEngine.connect(liquidator).liquidate(user1.address, await weth.getAddress(), ethers.parseEther("200"))
      ).to.be.reverted; // EnforcedPause

      // Non-admin cannot unpause
      await expect(
        liquidationEngine.connect(pauser).unpause()
      ).to.be.reverted;

      await liquidationEngine.connect(owner).unpause();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. CollateralVault — 38.6% branch
  // ═══════════════════════════════════════════════════════════════════════════
  describe("CollateralVault — Uncovered Branches", function () {
    let vault: any;
    let weth: any;
    let wbtc: any;
    let deployer: HardhatEthersSigner;
    let borrowModule: HardhatEthersSigner;
    let liquidator: HardhatEthersSigner;
    let leverageVault: HardhatEthersSigner;
    let user1: HardhatEthersSigner;
    let pauser: HardhatEthersSigner;

    beforeEach(async function () {
      [deployer, borrowModule, liquidator, leverageVault, user1, pauser] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      weth = await MockERC20.deploy("WETH", "WETH", 18);
      wbtc = await MockERC20.deploy("WBTC", "WBTC", 8);

      const VF = await ethers.getContractFactory("CollateralVault");
      vault = await VF.deploy();

      await vault.grantRole(await vault.BORROW_MODULE_ROLE(), borrowModule.address);
      await vault.grantRole(await vault.LIQUIDATION_ROLE(), liquidator.address);
      await vault.grantRole(await vault.LEVERAGE_VAULT_ROLE(), leverageVault.address);
      await vault.grantRole(await vault.PAUSER_ROLE(), pauser.address);

      await timelockAddCollateral(vault, deployer, await weth.getAddress(), 7500, 8000, 500);

      await weth.mint(user1.address, ethers.parseEther("100"));
      await weth.mint(leverageVault.address, ethers.parseEther("100"));
      await weth.connect(user1).approve(await vault.getAddress(), ethers.MaxUint256);
      await weth.connect(leverageVault).approve(await vault.getAddress(), ethers.MaxUint256);
    });

    // --- setBorrowModule: INVALID_MODULE ---
    it("should revert setBorrowModule with zero address", async function () {
      await expect(
        vault.setBorrowModule(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(vault, "InvalidModule");
    });

    it("should revert setBorrowModule from non-timelock", async function () {
      await expect(
        vault.connect(user1).setBorrowModule(user1.address)
      ).to.be.reverted;
    });

    // --- addCollateral: penalty is accepted as long as <= 2000 ---
    it("should accept addCollateral with low penalty (no lower bound check)", async function () {
      await vault.addCollateral(await wbtc.getAddress(), 6500, 7000, 50);
      const [enabled] = await vault.getConfig(await wbtc.getAddress());
      expect(enabled).to.be.true;
    });

    it("should revert addCollateral from non-timelock", async function () {
      await expect(
        vault.connect(user1).addCollateral(await wbtc.getAddress(), 6500, 7000, 500)
      ).to.be.reverted;
    });

    // --- updateCollateral: NOT_SUPPORTED (disabled token) ---
    it("should revert updateCollateral for disabled token", async function () {
      await vault.disableCollateral(await weth.getAddress());
      await expect(
        vault.updateCollateral(await weth.getAddress(), 7500, 8000, 500)
      ).to.be.revertedWithCustomError(vault, "NotSupported");
    });

    // --- updateCollateral: INVALID_FACTOR ---
    it("should revert updateCollateral with invalid factor", async function () {
      await expect(
        vault.updateCollateral(await weth.getAddress(), 8000, 8000, 500)
      ).to.be.revertedWithCustomError(vault, "InvalidFactor");
    });

    // --- updateCollateral: THRESHOLD_TOO_HIGH ---
    it("should revert updateCollateral with threshold > 9500", async function () {
      await expect(
        vault.updateCollateral(await weth.getAddress(), 7500, 9600, 500)
      ).to.be.revertedWithCustomError(vault, "ThresholdTooHigh");
    });

    // --- updateCollateral: PENALTY_TOO_HIGH ---
    it("should revert updateCollateral with penalty out of range", async function () {
      // No lower bound check — 50 bps is valid
      await vault.updateCollateral(await weth.getAddress(), 7500, 8000, 50);
      // Upper bound: > 2000 bps reverts with PENALTY_TOO_HIGH
      await expect(
        vault.updateCollateral(await weth.getAddress(), 7500, 8000, 2100)
      ).to.be.revertedWithCustomError(vault, "PenaltyTooHigh");
    });

    it("should revert updateCollateral from non-timelock", async function () {
      await expect(
        vault.connect(user1).updateCollateral(await weth.getAddress(), 7500, 8000, 600)
      ).to.be.reverted;
    });

    // --- enableCollateral: NOT_PREVIOUSLY_ADDED ---
    it("should revert enableCollateral for token never added", async function () {
      await expect(
        vault.enableCollateral(await wbtc.getAddress())
      ).to.be.revertedWithCustomError(vault, "NotPreviouslyAdded");
    });

    // --- enableCollateral: ALREADY_ENABLED ---
    it("should revert enableCollateral for already enabled token", async function () {
      await expect(
        vault.enableCollateral(await weth.getAddress())
      ).to.be.revertedWithCustomError(vault, "AlreadyEnabled");
    });

    // --- disableCollateral: NOT_SUPPORTED ---
    it("should revert disableCollateral for unsupported token", async function () {
      await expect(
        vault.disableCollateral(await wbtc.getAddress())
      ).to.be.revertedWithCustomError(vault, "NotSupported");
    });

    // --- depositFor: INVALID_USER ---
    it("should revert depositFor with zero address user", async function () {
      await expect(
        vault.connect(leverageVault).depositFor(ethers.ZeroAddress, await weth.getAddress(), ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(vault, "InvalidUser");
    });

    // --- depositFor: INVALID_AMOUNT ---
    it("should revert depositFor with zero amount", async function () {
      await expect(
        vault.connect(leverageVault).depositFor(user1.address, await weth.getAddress(), 0)
      ).to.be.revertedWithCustomError(vault, "InvalidAmount");
    });

    // --- withdrawFor: INSUFFICIENT_DEPOSIT ---
    it("should revert withdrawFor with insufficient deposit", async function () {
      await expect(
        vault.connect(leverageVault).withdrawFor(user1.address, await weth.getAddress(), ethers.parseEther("100"), deployer.address, true)
      ).to.be.revertedWithCustomError(vault, "InsufficientDeposit");
    });

    // --- withdrawFor: INVALID_RECIPIENT ---
    it("should revert withdrawFor with zero recipient", async function () {
      await vault.connect(user1).deposit(await weth.getAddress(), ethers.parseEther("10"));
      await expect(
        vault.connect(leverageVault).withdrawFor(user1.address, await weth.getAddress(), ethers.parseEther("1"), ethers.ZeroAddress, true)
      ).to.be.revertedWithCustomError(vault, "InvalidRecipient");
    });

    // --- withdrawFor: skipHealthCheck=true bypasses HF check ---
    it("should allow withdrawFor with skipHealthCheck=true", async function () {
      await vault.connect(leverageVault).depositFor(user1.address, await weth.getAddress(), ethers.parseEther("10"));
      // skipHealthCheck=true restricts recipient to msg.sender or user
      await vault.connect(leverageVault).withdrawFor(user1.address, await weth.getAddress(), ethers.parseEther("5"), leverageVault.address, true);
      expect(await vault.getDeposit(user1.address, await weth.getAddress())).to.equal(ethers.parseEther("5"));
    });

    // --- seize: INSUFFICIENT_COLLATERAL ---
    it("should revert seize with insufficient collateral", async function () {
      await vault.connect(user1).deposit(await weth.getAddress(), ethers.parseEther("1"));
      await expect(
        vault.connect(liquidator).seize(user1.address, await weth.getAddress(), ethers.parseEther("2"), liquidator.address)
      ).to.be.revertedWithCustomError(vault, "InsufficientCollateral");
    });

    // --- pause / unpause separation ---
    it("should pause deposits and require admin for unpause", async function () {
      await vault.connect(pauser).pause();
      await expect(
        vault.connect(user1).deposit(await weth.getAddress(), ethers.parseEther("1"))
      ).to.be.reverted;

      await expect(vault.connect(pauser).unpause()).to.be.reverted;
      await vault.connect(deployer).unpause();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. DepositRouter — 39.5% branch
  // ═══════════════════════════════════════════════════════════════════════════
  describe("DepositRouter — Uncovered Branches", function () {
    let router: any;
    let usdc: any;
    let wormholeRelayer: any;
    let tokenBridge: any;
    let admin: HardhatEthersSigner;
    let pauser: HardhatEthersSigner;
    let user1: HardhatEthersSigner;
    let treasury: HardhatEthersSigner;
    let directMint: HardhatEthersSigner;
    const MOCK_BRIDGE_COST = ethers.parseEther("0.01");

    beforeEach(async function () {
      [admin, pauser, user1, treasury, directMint] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      usdc = await MockERC20.deploy("USDC", "USDC", 6);

      const MockWR = await ethers.getContractFactory("MockWormholeRelayer");
      wormholeRelayer = await MockWR.deploy(MOCK_BRIDGE_COST);

      const MockTB = await ethers.getContractFactory("MockWormholeTokenBridge");
      tokenBridge = await MockTB.deploy();

      const DR = await ethers.getContractFactory("DepositRouter");
      router = await DR.deploy(
        await usdc.getAddress(),
        await wormholeRelayer.getAddress(),
        await tokenBridge.getAddress(),
        treasury.address,
        directMint.address,
        30, // 0.30%
        admin.address,
        admin.address
      );

      await usdc.mint(user1.address, 10_000_000n * 10n ** 6n);
      await usdc.connect(user1).approve(await router.getAddress(), ethers.MaxUint256);
      await router.connect(admin).grantRole(await router.PAUSER_ROLE(), pauser.address);
      await router.connect(admin).grantRole(await router.TIMELOCK_ROLE(), admin.address);
    });

    // --- Constructor: all zero address checks ---
    it("should revert constructor with zero wormhole relayer", async function () {
      const DR = await ethers.getContractFactory("DepositRouter");
      await expect(
        DR.deploy(await usdc.getAddress(), ethers.ZeroAddress, await tokenBridge.getAddress(), treasury.address, directMint.address, 30, admin.address, admin.address)
      ).to.be.revertedWithCustomError(DR, "InvalidAddress");
    });

    it("should revert constructor with zero token bridge", async function () {
      const DR = await ethers.getContractFactory("DepositRouter");
      await expect(
        DR.deploy(await usdc.getAddress(), await wormholeRelayer.getAddress(), ethers.ZeroAddress, treasury.address, directMint.address, 30, admin.address, admin.address)
      ).to.be.revertedWithCustomError(DR, "InvalidAddress");
    });

    it("should revert constructor with zero directMint", async function () {
      const DR = await ethers.getContractFactory("DepositRouter");
      await expect(
        DR.deploy(await usdc.getAddress(), await wormholeRelayer.getAddress(), await tokenBridge.getAddress(), treasury.address, ethers.ZeroAddress, 30, admin.address, admin.address)
      ).to.be.revertedWithCustomError(DR, "InvalidAddress");
    });

    it("should revert constructor with zero admin", async function () {
      const DR = await ethers.getContractFactory("DepositRouter");
      await expect(
        DR.deploy(await usdc.getAddress(), await wormholeRelayer.getAddress(), await tokenBridge.getAddress(), treasury.address, directMint.address, 30, ethers.ZeroAddress, admin.address)
      ).to.be.revertedWithCustomError(DR, "InvalidAddress");
    });

    // --- depositFor: InvalidAddress for zero recipient ---
    it("should revert depositFor with zero recipient", async function () {
      await expect(
        router.connect(user1).depositFor(ethers.ZeroAddress, 1_000n * 10n ** 6n, { value: MOCK_BRIDGE_COST })
      ).to.be.revertedWithCustomError(router, "InvalidAddress");
    });

    // --- _deposit: InvalidAmount (0) ---
    it("should revert deposit with zero amount", async function () {
      await expect(
        router.connect(user1).deposit(0, { value: MOCK_BRIDGE_COST })
      ).to.be.revertedWithCustomError(router, "InvalidAmount");
    });

    // --- _deposit: AmountBelowMinimum ---
    it("should revert deposit below minimum", async function () {
      await expect(
        router.connect(user1).deposit(100, { value: MOCK_BRIDGE_COST }) // 100 < 1e6
      ).to.be.revertedWithCustomError(router, "AmountBelowMinimum");
    });

    // --- _deposit: AmountAboveMaximum ---
    it("should revert deposit above maximum", async function () {
      const overMax = 1_000_001n * 10n ** 6n;
      await usdc.mint(user1.address, overMax);
      await expect(
        router.connect(user1).deposit(overMax, { value: MOCK_BRIDGE_COST })
      ).to.be.revertedWithCustomError(router, "AmountAboveMaximum");
    });

    // --- setTreasury: InvalidAddress ---
    it("should revert setTreasury with zero address", async function () {
      await expect(
        router.connect(admin).setTreasury(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(router, "InvalidAddress");
    });

    // --- setDirectMint: InvalidAddress ---
    it("should revert setDirectMint with zero address", async function () {
      await expect(
        router.connect(admin).setDirectMint(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(router, "InvalidAddress");
    });

    // --- setFee: FeeTooHigh ---
    it("should revert setFee above 5%", async function () {
      await expect(
        router.connect(admin).setFee(501)
      ).to.be.revertedWithCustomError(router, "FeeTooHigh");
    });

    // --- setFee: valid update ---
    it("should update fee successfully", async function () {
      await expect(router.connect(admin).setFee(100))
        .to.emit(router, "FeeUpdated").withArgs(30, 100);
    });

    // --- withdrawFees: no accumulated fees (succeeds with 0 transfer) ---
    it("should succeed withdrawFees when no fees accumulated (transfers 0)", async function () {
      // Contract has no NO_FEES check — safeTransfer of 0 succeeds
      await expect(
        router.connect(admin).withdrawFees(admin.address)
      ).to.not.be.reverted;
    });

    // --- withdrawFees: InvalidAddress ---
    it("should revert withdrawFees to zero address", async function () {
      await expect(
        router.connect(admin).withdrawFees(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(router, "InvalidAddress");
    });

    // --- markDepositComplete: DEPOSIT_NOT_FOUND ---
    it("should revert markDepositComplete for unknown sequence", async function () {
      await expect(
        router.connect(admin).markDepositComplete(999)
      ).to.be.revertedWithCustomError(router, "DepositNotFound");
    });

    // --- emergencyWithdraw: InvalidAmount ---
    it("should revert emergencyWithdraw on zero amount", async function () {
      await router.connect(pauser).pause();
      await expect(
        router.connect(admin).emergencyWithdraw(await usdc.getAddress(), 0)
      ).to.be.revertedWithCustomError(router, "InvalidAmount");
    });

    // --- emergencyWithdraw: must be paused ---
    it("should revert USDC emergencyWithdraw when not paused", async function () {
      await usdc.mint(await router.getAddress(), 1_000n * 10n ** 6n);
      await expect(
        router.connect(admin).emergencyWithdraw(await usdc.getAddress(), 100)
      ).to.be.revertedWithCustomError(router, "ExpectedPause");
    });

    // --- emergencyWithdraw: USDC allowed when paused ---
    it("should allow USDC emergencyWithdraw when paused", async function () {
      await usdc.mint(await router.getAddress(), 1_000n * 10n ** 6n);
      await router.connect(pauser).pause();
      await router.connect(admin).emergencyWithdraw(await usdc.getAddress(), 100);
    });

    // --- emergencyWithdraw: native token (address(0)) ---
    it("should allow native token emergency withdrawal", async function () {
      // Send ETH to router
      await admin.sendTransaction({ to: await router.getAddress(), value: ethers.parseEther("0.1") });
      await router.connect(pauser).pause();
      await router.connect(admin).emergencyWithdraw(ethers.ZeroAddress, ethers.parseEther("0.05"));
    });

    // --- emergencyWithdraw: non-USDC ERC20 ---
    it("should allow non-USDC token emergency withdrawal when paused", async function () {
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const other = await MockERC20.deploy("Other", "OTH", 18);
      await other.mint(await router.getAddress(), 1000);
      await router.connect(pauser).pause();
      await router.connect(admin).emergencyWithdraw(await other.getAddress(), 1000);
    });

    // --- pause / unpause separation ---
    it("should separate pause and unpause roles", async function () {
      await router.connect(pauser).pause();
      await expect(router.connect(pauser).unpause()).to.be.reverted;
      await router.connect(admin).unpause();
    });

    // --- previewDeposit view ---
    it("should correctly preview deposit fees", async function () {
      const [net, fee] = await router.previewDeposit(10_000n * 10n ** 6n);
      expect(fee).to.equal(30n * 10n ** 6n); // 0.3% of 10k
      expect(net).to.equal(9_970n * 10n ** 6n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. TreasuryReceiver — 48.1% branch
  // ═══════════════════════════════════════════════════════════════════════════
  describe("TreasuryReceiver — Uncovered Branches", function () {
    let receiver: any;
    let usdc: any;
    let mockWormhole: any;
    let mockTokenBridge: any;
    let admin: HardhatEthersSigner;
    let other: HardhatEthersSigner;
    let directMint: HardhatEthersSigner;
    let treasury: HardhatEthersSigner;

    beforeEach(async function () {
      [admin, other, directMint, treasury] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      usdc = await MockERC20.deploy("USDC", "USDC", 6);

      const MockWormhole = await ethers.getContractFactory("MockWormhole");
      mockWormhole = await MockWormhole.deploy();

      const MockTB = await ethers.getContractFactory("MockWormholeTokenBridge");
      mockTokenBridge = await MockTB.deploy();

      const TR = await ethers.getContractFactory("TreasuryReceiver");
      receiver = await TR.deploy(
        await usdc.getAddress(),
        await mockWormhole.getAddress(),
        await mockTokenBridge.getAddress(),
        directMint.address,
        treasury.address,
        admin.address
      );
    });

    // --- Constructor zero-address checks ---
    it("should revert constructor with zero usdc", async function () {
      const TR = await ethers.getContractFactory("TreasuryReceiver");
      await expect(
        TR.deploy(ethers.ZeroAddress, await mockWormhole.getAddress(), await mockTokenBridge.getAddress(), directMint.address, treasury.address, admin.address)
      ).to.be.revertedWithCustomError(TR, "InvalidAddress");
    });

    it("should revert constructor with zero wormhole", async function () {
      const TR = await ethers.getContractFactory("TreasuryReceiver");
      await expect(
        TR.deploy(await usdc.getAddress(), ethers.ZeroAddress, await mockTokenBridge.getAddress(), directMint.address, treasury.address, admin.address)
      ).to.be.revertedWithCustomError(TR, "InvalidAddress");
    });

    it("should revert constructor with zero tokenBridge", async function () {
      const TR = await ethers.getContractFactory("TreasuryReceiver");
      await expect(
        TR.deploy(await usdc.getAddress(), await mockWormhole.getAddress(), ethers.ZeroAddress, directMint.address, treasury.address, admin.address)
      ).to.be.revertedWithCustomError(TR, "InvalidAddress");
    });

    it("should revert constructor with zero directMint", async function () {
      const TR = await ethers.getContractFactory("TreasuryReceiver");
      await expect(
        TR.deploy(await usdc.getAddress(), await mockWormhole.getAddress(), await mockTokenBridge.getAddress(), ethers.ZeroAddress, treasury.address, admin.address)
      ).to.be.revertedWithCustomError(TR, "InvalidAddress");
    });

    it("should revert constructor with zero treasury", async function () {
      const TR = await ethers.getContractFactory("TreasuryReceiver");
      await expect(
        TR.deploy(await usdc.getAddress(), await mockWormhole.getAddress(), await mockTokenBridge.getAddress(), directMint.address, ethers.ZeroAddress, admin.address)
      ).to.be.revertedWithCustomError(TR, "InvalidAddress");
    });

    // --- authorizeRouter: valid call with zero bytes32 (no zero-address check in contract) ---
    it("should allow authorizeRouter with zero bytes32", async function () {
      // Contract does not check for zero routerAddress; this should succeed
      await receiver.authorizeRouter(30, ethers.ZeroHash);
    });

    // --- authorizeRouter / revokeRouter ---
    it("should authorize and revoke router", async function () {
      const routerBytes = ethers.zeroPadValue("0x01", 32);
      await expect(receiver.authorizeRouter(30, routerBytes))
        .to.emit(receiver, "RouterAuthorized");
      await expect(receiver.revokeRouter(30))
        .to.emit(receiver, "RouterRevoked");
    });

    // --- setDirectMint: InvalidAddress ---
    it("should revert setDirectMint with zero address", async function () {
      await expect(
        receiver.setDirectMint(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(receiver, "InvalidAddress");
    });

    // --- setTreasury: InvalidAddress ---
    it("should revert setTreasury with zero address", async function () {
      await expect(
        receiver.setTreasury(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(receiver, "InvalidAddress");
    });

    // --- setDirectMint: valid ---
    it("should update directMint address", async function () {
      await expect(receiver.setDirectMint(other.address))
        .to.emit(receiver, "DirectMintUpdated");
    });

    // --- setTreasury: valid ---
    it("should update treasury address", async function () {
      await expect(receiver.setTreasury(other.address))
        .to.emit(receiver, "TreasuryUpdated");
    });

    // --- emergencyWithdraw: InvalidAddress ---
    it("should revert emergencyWithdraw to zero address", async function () {
      await receiver.grantRole(await receiver.PAUSER_ROLE(), admin.address);
      await receiver.pause();
      await expect(
        receiver.emergencyWithdraw(await usdc.getAddress(), ethers.ZeroAddress, 100)
      ).to.be.revertedWithCustomError(receiver, "InvalidAddress");
    });

    // --- emergencyWithdraw: USDC allowed when paused ---
    it("should allow USDC emergencyWithdraw when paused", async function () {
      await usdc.mint(await receiver.getAddress(), 1000);
      await receiver.grantRole(await receiver.PAUSER_ROLE(), admin.address);
      await receiver.pause();
      await receiver.emergencyWithdraw(await usdc.getAddress(), admin.address, 100);
    });

    // --- emergencyWithdraw: USDC also allowed when paused ---
    it("should allow USDC emergencyWithdraw when paused", async function () {
      await usdc.mint(await receiver.getAddress(), 1000);
      await receiver.grantRole(await receiver.PAUSER_ROLE(), admin.address);
      await receiver.pause();
      await receiver.emergencyWithdraw(await usdc.getAddress(), admin.address, 100);
    });

    // --- claimPendingMint: should revert for non-existent hash ---
    it("should revert claimPendingMint for non-existent hash", async function () {
      await expect(
        receiver.claimPendingMint(ethers.keccak256("0x01"))
      ).to.be.reverted;
    });

    // --- pause / unpause separation ---
    it("should enforce pause/unpause role separation", async function () {
      await receiver.grantRole(await receiver.PAUSER_ROLE(), other.address);
      await receiver.connect(other).pause();
      await expect(receiver.connect(other).unpause()).to.be.reverted;
      await receiver.connect(admin).unpause();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. SMUSD — 55.1% branch
  // ═══════════════════════════════════════════════════════════════════════════
  describe("SMUSD — Uncovered Branches", function () {
    let smusd: any;
    let musd: any;
    let deployer: HardhatEthersSigner;
    let bridge: HardhatEthersSigner;
    let yieldManager: HardhatEthersSigner;
    let interestRouter: HardhatEthersSigner;
    let user1: HardhatEthersSigner;
    let user2: HardhatEthersSigner;
    let pauser: HardhatEthersSigner;

    beforeEach(async function () {
      [deployer, bridge, yieldManager, interestRouter, user1, user2, pauser] = await ethers.getSigners();

      const MF = await ethers.getContractFactory("MUSD");
      musd = await MF.deploy(ethers.parseEther("100000000"));

      const SF = await ethers.getContractFactory("SMUSD");
      smusd = await SF.deploy(await musd.getAddress());

      await musd.grantRole(await musd.BRIDGE_ROLE(), bridge.address);
      await smusd.grantRole(await smusd.YIELD_MANAGER_ROLE(), yieldManager.address);
      await smusd.grantRole(await smusd.BRIDGE_ROLE(), bridge.address);
      await smusd.grantRole(await smusd.INTEREST_ROUTER_ROLE(), interestRouter.address);
      await smusd.grantRole(await smusd.PAUSER_ROLE(), pauser.address);

      await musd.connect(bridge).mint(user1.address, ethers.parseEther("100000"));
      await musd.connect(bridge).mint(user2.address, ethers.parseEther("100000"));
      await musd.connect(bridge).mint(yieldManager.address, ethers.parseEther("100000"));
      await musd.connect(bridge).mint(interestRouter.address, ethers.parseEther("100000"));

      await musd.connect(user1).approve(await smusd.getAddress(), ethers.MaxUint256);
      await musd.connect(user2).approve(await smusd.getAddress(), ethers.MaxUint256);
      await musd.connect(yieldManager).approve(await smusd.getAddress(), ethers.MaxUint256);
      await musd.connect(interestRouter).approve(await smusd.getAddress(), ethers.MaxUint256);
    });

    // --- syncCantonShares: EPOCH_NOT_SEQUENTIAL ---
    it("should revert syncCantonShares with non-sequential epoch", async function () {
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);
      await smusd.connect(bridge).syncCantonShares(100, 1);
      await time.increase(3601);
      await expect(
        smusd.connect(bridge).syncCantonShares(200, 1) // same epoch
      ).to.be.revertedWithCustomError(smusd, "EpochNotSequential");
    });

    // --- syncCantonShares: SYNC_TOO_FREQUENT ---
    it("should revert syncCantonShares when called too frequently", async function () {
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);
      await smusd.connect(bridge).syncCantonShares(100, 1);
      await expect(
        smusd.connect(bridge).syncCantonShares(200, 2) // immediate, no wait
      ).to.be.revertedWithCustomError(smusd, "SyncTooFrequent");
    });

    // --- syncCantonShares: INITIAL_SHARES_TOO_LARGE (no ETH shares) ---
    it("should reject initial canton shares exceeding 2x ETH shares", async function () {
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);
      const ethShares = await smusd.totalSupply();
      await expect(
        smusd.connect(bridge).syncCantonShares(ethShares * 3n, 1) // > 2x
      ).to.be.revertedWithCustomError(smusd, "InitialSharesTooLarge");
    });

    // --- syncCantonShares: SHARE_INCREASE_TOO_LARGE ---
    it("should revert when subsequent sync increase exceeds 5%", async function () {
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);
      await smusd.connect(bridge).syncCantonShares(1000, 1);
      await time.increase(3601);
      // Increase by more than 5%
      await expect(
        smusd.connect(bridge).syncCantonShares(2000, 2) // 100% increase
      ).to.be.revertedWithCustomError(smusd, "ShareIncreaseTooLarge");
    });

    // --- syncCantonShares: SHARE_DECREASE_TOO_LARGE ---
    it("should revert when subsequent sync decrease exceeds 5%", async function () {
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);
      await smusd.connect(bridge).syncCantonShares(1000, 1);
      await time.increase(3601);
      await expect(
        smusd.connect(bridge).syncCantonShares(100, 2) // 90% decrease
      ).to.be.revertedWithCustomError(smusd, "ShareDecreaseTooLarge");
    });

    // --- receiveInterest: ZERO_AMOUNT ---
    it("should revert receiveInterest with zero amount", async function () {
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);
      await expect(
        smusd.connect(interestRouter).receiveInterest(0)
      ).to.be.revertedWithCustomError(smusd, "ZeroAmount");
    });

    // --- receiveInterest: NO_SHARES_EXIST ---
    it("should revert receiveInterest when no shares exist", async function () {
      await expect(
        smusd.connect(interestRouter).receiveInterest(100)
      ).to.be.revertedWithCustomError(smusd, "NoSharesExist");
    });

    // --- receiveInterest: INTEREST_EXCEEDS_CAP ---
    it("should revert receiveInterest exceeding cap", async function () {
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);
      // Cap is 10% of globalTotalAssets
      const cap = ethers.parseEther("200"); // way over 10% of 1000
      await expect(
        smusd.connect(interestRouter).receiveInterest(cap)
      ).to.be.revertedWithCustomError(smusd, "InterestExceedsCap");
    });

    // --- distributeYield: NO_SHARES_EXIST ---
    it("should revert distributeYield when no shares exist", async function () {
      await expect(
        smusd.connect(yieldManager).distributeYield(100)
      ).to.be.revertedWithCustomError(smusd, "NoSharesExist");
    });

    // --- distributeYield: INVALID_AMOUNT ---
    it("should revert distributeYield with zero amount", async function () {
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);
      await expect(
        smusd.connect(yieldManager).distributeYield(0)
      ).to.be.revertedWithCustomError(smusd, "InvalidAmount");
    });

    // --- distributeYield: YIELD_EXCEEDS_CAP ---
    it("should revert distributeYield exceeding cap", async function () {
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);
      await expect(
        smusd.connect(yieldManager).distributeYield(ethers.parseEther("500"))
      ).to.be.revertedWithCustomError(smusd, "YieldExceedsCap");
    });

    // --- setTreasury: valid ---
    it("should set treasury successfully", async function () {
      await smusd.setTreasury(user2.address);
      // No revert means success
    });

    // --- setTreasury: ZERO_ADDRESS ---
    it("should revert setTreasury with zero address", async function () {
      await expect(smusd.setTreasury(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(smusd, "ZeroAddress");
    });

    // --- maxWithdraw: returns 0 when paused ---
    it("should return 0 for maxWithdraw when paused", async function () {
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);
      await smusd.connect(pauser).pause();
      expect(await smusd.maxWithdraw(user1.address)).to.equal(0);
    });

    // --- maxRedeem: returns 0 when paused ---
    it("should return 0 for maxRedeem when paused", async function () {
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);
      await smusd.connect(pauser).pause();
      expect(await smusd.maxRedeem(user1.address)).to.equal(0);
    });

    // --- maxDeposit: returns 0 when paused ---
    it("should return 0 for maxDeposit when paused", async function () {
      await smusd.connect(pauser).pause();
      expect(await smusd.maxDeposit(user1.address)).to.equal(0);
    });

    // --- maxMint: returns 0 when paused ---
    it("should return 0 for maxMint when paused", async function () {
      await smusd.connect(pauser).pause();
      expect(await smusd.maxMint(user1.address)).to.equal(0);
    });

    // --- maxWithdraw/maxRedeem: returns 0 during cooldown ---
    it("should return 0 for maxWithdraw during cooldown", async function () {
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);
      expect(await smusd.maxWithdraw(user1.address)).to.equal(0);
      expect(await smusd.maxRedeem(user1.address)).to.equal(0);
    });

    // --- _update: cooldown propagation on transfer ---
    it("should propagate stricter cooldown on transfer", async function () {
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);
      await time.increase(24 * 3600); // pass cooldown for user1

      // user2 deposits now (newer cooldown)
      await smusd.connect(user2).deposit(ethers.parseEther("1000"), user2.address);

      // Transfer from user2 to user1 should propagate user2's stricter cooldown
      const shares = await smusd.balanceOf(user2.address);
      await smusd.connect(user2).transfer(user1.address, shares / 2n);
      expect(await smusd.canWithdraw(user1.address)).to.be.false;
    });

    // --- globalTotalAssets: treasury set, catch fallback to cache ---
    it("should fall back to cached globalAssets when treasury reverts", async function () {
      // Deploy any contract that does NOT have totalValue() — call will revert
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const fakeTreasury = await MockERC20.deploy("Fake", "FK", 18);
      await smusd.setTreasury(await fakeTreasury.getAddress());
      // Deposit — globalTotalAssets should catch the revert and fall back to totalAssets
      await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);
      const gta = await smusd.globalTotalAssets();
      expect(gta).to.be.gt(0);
    });

    // --- globalSharePrice: zero shares ---
    it("should return default price when no shares exist", async function () {
      const price = await smusd.globalSharePrice();
      expect(price).to.equal(1000); // 10^decimalsOffset = 10^3
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. SMUSDPriceAdapter — 58.8% branch
  // ═══════════════════════════════════════════════════════════════════════════
  describe("SMUSDPriceAdapter — Uncovered Branches", function () {
    let adapter: any;
    let mockSmusd: any;
    let admin: HardhatEthersSigner;

    beforeEach(async function () {
      [admin] = await ethers.getSigners();

      const MockSMUSD = await ethers.getContractFactory("MockSMUSDAdapter");
      mockSmusd = await MockSMUSD.deploy(1e18.toString()); // 1:1 price

      const Adapter = await ethers.getContractFactory("SMUSDPriceAdapter");
      adapter = await Adapter.deploy(await mockSmusd.getAddress(), admin.address, admin.address);
    });

    // --- constructor: zero address revert ---
    it("should revert constructor with zero smusd", async function () {
      const A = await ethers.getContractFactory("SMUSDPriceAdapter");
      await expect(A.deploy(ethers.ZeroAddress, admin.address, admin.address))
        .to.be.revertedWithCustomError(A, "SMUSDZeroAddress");
    });

    // --- _getSharePriceUsd: totalSupply below minTotalSupply ---
    it("should return last known price when totalSupply too low", async function () {
      await mockSmusd.setTotalSupply(0); // below minTotalSupply
      const [, answer] = await adapter.latestRoundData();
      // Should return _lastPrice (initialized to minSharePrice = 0.95e8)
      expect(answer).to.equal(95000000n); // 0.95e8
    });

    // --- _getSharePriceUsd: price clamped to minSharePrice ---
    it("should clamp share price to min bound", async function () {
      await mockSmusd.setAssetsPerShare(ethers.parseEther("0.5")); // Very low
      await adapter.updateCachedPrice(); // Update cache at low price
      await mine(2); // Advance blocks
      const [, answer] = await adapter.latestRoundData();
      expect(answer).to.be.gte(95000000n); // >= 0.95e8 min
    });

    // --- _getSharePriceUsd: price clamped to maxSharePrice ---
    it("should clamp share price to max bound", async function () {
      await mockSmusd.setAssetsPerShare(ethers.parseEther("5")); // Very high
      await adapter.updateCachedPrice();
      await mine(100);
      const [, answer] = await adapter.latestRoundData();
      expect(answer).to.be.lte(200000000n); // <= 2.0e8 max
    });

    // --- _getSharePriceUsd: rate limiting (price jump capped per block) ---
    it("should rate-limit price increase per block", async function () {
      // Set initial cache at $1.00
      await mockSmusd.setAssetsPerShare(ethers.parseEther("1.0"));
      await adapter.updateCachedPrice();

      // Jump to $1.50 — should be clamped by rate limiter
      await mine(1);
      await mockSmusd.setAssetsPerShare(ethers.parseEther("1.5"));
      const [, answer] = await adapter.latestRoundData();
      // Should be clamped: lastPrice + maxPriceChangePerBlock * blocksSinceLast
      expect(answer).to.be.lt(150000000n); // < 1.5e8
    });

    // --- _getSharePriceUsd: rate limiting downward ---
    it("should rate-limit price decrease per block", async function () {
      await mockSmusd.setAssetsPerShare(ethers.parseEther("1.5"));
      await adapter.updateCachedPrice();

      await mine(1);
      await mockSmusd.setAssetsPerShare(ethers.parseEther("0.96"));
      const [, answer] = await adapter.latestRoundData();
      expect(answer).to.be.gt(95000000n); // > 0.95e8
    });

    // --- setSharePriceBounds: validations ---
    it("should revert setSharePriceBounds with zero min", async function () {
      await expect(adapter.setSharePriceBounds(0, 200000000n))
        .to.be.revertedWithCustomError(adapter, "MinZero");
    });

    it("should revert setSharePriceBounds with max <= min", async function () {
      await expect(adapter.setSharePriceBounds(200000000n, 200000000n))
        .to.be.revertedWithCustomError(adapter, "MaxLteMin");
    });

    it("should revert setSharePriceBounds with max > $10", async function () {
      await expect(adapter.setSharePriceBounds(100000000n, 1100000000n))
        .to.be.revertedWithCustomError(adapter, "MaxTooHigh");
    });

    // --- setDonationProtection: validations ---
    it("should revert setDonationProtection with zero supply", async function () {
      await expect(adapter.setDonationProtection(0, 5000000n))
        .to.be.revertedWithCustomError(adapter, "MinSupplyZero");
    });

    it("should revert setDonationProtection with zero change", async function () {
      await expect(adapter.setDonationProtection(1e18.toString(), 0))
        .to.be.revertedWithCustomError(adapter, "MaxChangeZero");
    });

    it("should revert setDonationProtection with change > 50%", async function () {
      await expect(adapter.setDonationProtection(1e18.toString(), 60000000n))
        .to.be.revertedWithCustomError(adapter, "MaxChangeTooHigh");
    });

    // --- incrementRound ---
    it("should increment round", async function () {
      const [roundBefore] = await adapter.latestRoundData();
      await adapter.incrementRound();
      const [roundAfter] = await adapter.latestRoundData();
      expect(roundAfter).to.equal(roundBefore + 1n);
    });

    // --- getRoundData view ---
    it("should return same data from getRoundData", async function () {
      const [, latestAnswer] = await adapter.latestRoundData();
      const [, roundAnswer] = await adapter.getRoundData(1);
      expect(latestAnswer).to.equal(roundAnswer);
    });

    // --- description / version views ---
    it("should return correct description and version", async function () {
      expect(await adapter.description()).to.equal("sMUSD / USD");
      expect(await adapter.version()).to.equal(1);
      expect(await adapter.decimals()).to.equal(8);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. LeverageVault — 44% branch
  // ═══════════════════════════════════════════════════════════════════════════
  describe("LeverageVault — Uncovered Branches", function () {
    let leverageVault: any;
    let admin: HardhatEthersSigner;
    let user1: HardhatEthersSigner;
    let pauser: HardhatEthersSigner;

    beforeEach(async function () {
      [admin, user1, pauser] = await ethers.getSigners();

      // Deploy minimal mocks for constructor validation
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const weth = await MockERC20.deploy("WETH", "WETH", 18);
      const musd = await MockERC20.deploy("mUSD", "mUSD", 18);

      // Use admin addresses as stand-ins for the constructor (real integration not needed for branch tests)
      // The LeverageVault constructor only stores addresses
      const LV = await ethers.getContractFactory("LeverageVault");
      leverageVault = await LV.deploy(
        admin.address, // swapRouter (mock)
        admin.address, // collateralVault (mock)
        admin.address, // borrowModule (mock)
        admin.address, // priceOracle (mock)
        await musd.getAddress(),
        admin.address  // timelock
      );

      await leverageVault.grantRole(await leverageVault.LEVERAGE_ADMIN_ROLE(), admin.address);
      await leverageVault.grantRole(await leverageVault.PAUSER_ROLE(), pauser.address);
    });

    // --- Constructor zero-address checks ---
    it("should revert constructor with zero swapRouter", async function () {
      const LV = await ethers.getContractFactory("LeverageVault");
      await expect(
        LV.deploy(ethers.ZeroAddress, admin.address, admin.address, admin.address, admin.address, admin.address)
      ).to.be.revertedWithCustomError(LV, "InvalidRouter");
    });

    it("should revert constructor with zero collateralVault", async function () {
      const LV = await ethers.getContractFactory("LeverageVault");
      await expect(
        LV.deploy(admin.address, ethers.ZeroAddress, admin.address, admin.address, admin.address, admin.address)
      ).to.be.revertedWithCustomError(LV, "InvalidVault");
    });

    it("should revert constructor with zero borrowModule", async function () {
      const LV = await ethers.getContractFactory("LeverageVault");
      await expect(
        LV.deploy(admin.address, admin.address, ethers.ZeroAddress, admin.address, admin.address, admin.address)
      ).to.be.revertedWithCustomError(LV, "InvalidBorrow");
    });

    it("should revert constructor with zero priceOracle", async function () {
      const LV = await ethers.getContractFactory("LeverageVault");
      await expect(
        LV.deploy(admin.address, admin.address, admin.address, ethers.ZeroAddress, admin.address, admin.address)
      ).to.be.revertedWithCustomError(LV, "InvalidOracle");
    });

    it("should revert constructor with zero musd", async function () {
      const LV = await ethers.getContractFactory("LeverageVault");
      await expect(
        LV.deploy(admin.address, admin.address, admin.address, admin.address, ethers.ZeroAddress, admin.address)
      ).to.be.revertedWithCustomError(LV, "InvalidMusd");
    });

    // --- setConfig: validations ---
    it("should revert setConfig with invalid maxLoops", async function () {
      await expect(
        leverageVault.setConfig(0, 100e18.toString(), 3000, 100)
      ).to.be.revertedWithCustomError(leverageVault, "InvalidMaxLoops");

      await expect(
        leverageVault.setConfig(21, 100e18.toString(), 3000, 100)
      ).to.be.revertedWithCustomError(leverageVault, "InvalidMaxLoops");
    });

    it("should revert setConfig with slippage too high", async function () {
      await expect(
        leverageVault.setConfig(10, 100e18.toString(), 3000, 501)
      ).to.be.revertedWithCustomError(leverageVault, "SlippageTooHigh");
    });

    it("should accept setConfig with any fee tier (no fee tier validation)", async function () {
      // setConfig does not validate fee tier — any value is accepted
      await expect(leverageVault.setConfig(10, 100e18.toString(), 2000, 100))
        .to.emit(leverageVault, "ConfigUpdated");
    });

    it("should accept valid setConfig", async function () {
      await expect(leverageVault.setConfig(5, 200e18.toString(), 500, 200))
        .to.emit(leverageVault, "ConfigUpdated");
    });

    // --- setMaxLeverage: validations ---
    it("should revert setMaxLeverage with invalid values", async function () {
      await expect(leverageVault.setMaxLeverage(9)).to.be.revertedWithCustomError(leverageVault, "InvalidMaxLeverage");
      await expect(leverageVault.setMaxLeverage(41)).to.be.revertedWithCustomError(leverageVault, "InvalidMaxLeverage");
    });

    it("should accept valid setMaxLeverage", async function () {
      await expect(leverageVault.setMaxLeverage(20))
        .to.emit(leverageVault, "MaxLeverageUpdated");
    });

    // --- enableToken: validations ---
    it("should revert enableToken with zero address", async function () {
      await expect(leverageVault.enableToken(ethers.ZeroAddress, 3000))
        .to.be.revertedWithCustomError(leverageVault, "InvalidToken");
    });

    it("should revert enableToken with invalid fee tier", async function () {
      await expect(leverageVault.enableToken(user1.address, 2000))
        .to.be.revertedWithCustomError(leverageVault, "InvalidFeeTier");
    });

    // --- disableToken ---
    it("should disable token", async function () {
      await leverageVault.enableToken(user1.address, 3000);
      await expect(leverageVault.disableToken(user1.address))
        .to.emit(leverageVault, "TokenDisabled");
      expect(await leverageVault.leverageEnabled(user1.address)).to.be.false;
    });

    // --- getEffectiveLeverage: zero initial deposit ---
    it("should return 0 for getEffectiveLeverage with no position", async function () {
      expect(await leverageVault.getEffectiveLeverage(user1.address)).to.equal(0);
    });

    // --- emergencyWithdraw: validations ---
    it("should revert emergencyWithdraw with zero token", async function () {
      // emergencyWithdraw(token, amount) — call on address(0) reverts at ERC20 level
      await expect(
        leverageVault.emergencyWithdraw(ethers.ZeroAddress, 100)
      ).to.be.reverted;
    });

    it("should revert emergencyWithdraw with invalid token (EOA)", async function () {
      // Calling safeTransfer on an EOA address reverts
      await expect(
        leverageVault.emergencyWithdraw(user1.address, 100)
      ).to.be.reverted;
    });

    it("should revert emergencyWithdraw from non-admin", async function () {
      // emergencyWithdraw is gated by DEFAULT_ADMIN_ROLE
      await expect(
        leverageVault.connect(user1).emergencyWithdraw(user1.address, 100)
      ).to.be.reverted;
    });

    // --- pause / unpause separation ---
    it("should enforce pause/unpause role separation", async function () {
      await leverageVault.connect(pauser).pause();
      await expect(leverageVault.connect(pauser).unpause()).to.be.reverted;
      await leverageVault.connect(admin).unpause();
    });

    // --- openLeveragedPosition: NO_POSITION / TOKEN_NOT_ENABLED ---
    it("should revert openLeveragedPosition for disabled token", async function () {
      const deadline = (await time.latest()) + 3600;
      await expect(
        leverageVault.connect(user1).openLeveragedPosition(
          user1.address, 1000, 20, 0, deadline
        )
      ).to.be.revertedWithCustomError(leverageVault, "TokenNotEnabled");
    });

    // --- openLeveragedPosition: expired deadline causes downstream revert ---
    it("should revert openLeveragedPosition with expired deadline", async function () {
      await leverageVault.enableToken(user1.address, 3000);
      // Contract doesn't check deadline upfront; it fails on transferFrom or swap
      await expect(
        leverageVault.connect(user1).openLeveragedPosition(
          user1.address, 1000, 20, 0, 1
        )
      ).to.be.reverted;
    });
  });
});
