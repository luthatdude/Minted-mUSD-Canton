/**
 * TreasuryV2 Integration Tests
 * Tests auto-allocation, strategy management, fee accrual, rebalancing,
 * and emergency operations.
 */

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { TreasuryV2, MockERC20, MockStrategy } from "../typechain-types";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { timelockAddStrategy, timelockRemoveStrategy, timelockSetFeeConfig, timelockSetReserveBps } from "./helpers/timelock";

describe("TreasuryV2", function () {
  let treasury: TreasuryV2;
  let usdc: MockERC20;
  let strategyA: MockStrategy;
  let strategyB: MockStrategy;
  let strategyC: MockStrategy;
  let admin: HardhatEthersSigner;
  let vault: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let guardian: HardhatEthersSigner;

  const USDC_DECIMALS = 6;
  const ONE_USDC = 10n ** 6n;
  const ONE_MILLION = 1_000_000n * ONE_USDC;

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    admin = signers[0];
    vault = signers[1];
    feeRecipient = signers[2];
    user = signers[3];
    guardian = signers[4];

    // Deploy mock USDC
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    usdc = (await MockERC20Factory.deploy("USD Coin", "USDC", USDC_DECIMALS)) as MockERC20;
    await usdc.waitForDeployment();

    // Deploy TreasuryV2
    const TreasuryV2Factory = await ethers.getContractFactory("TreasuryV2");
    treasury = (await upgrades.deployProxy(TreasuryV2Factory, [
      await usdc.getAddress(),
      vault.address,
      admin.address,
      feeRecipient.address,
    ])) as unknown as TreasuryV2;
    await treasury.waitForDeployment();

    // Deploy mock strategies
    const MockStratFactory = await ethers.getContractFactory("MockStrategy");
    const treasuryAddr = await treasury.getAddress();
    strategyA = (await MockStratFactory.deploy(await usdc.getAddress(), treasuryAddr)) as MockStrategy;
    strategyB = (await MockStratFactory.deploy(await usdc.getAddress(), treasuryAddr)) as MockStrategy;
    strategyC = (await MockStratFactory.deploy(await usdc.getAddress(), treasuryAddr)) as MockStrategy;
    await strategyA.waitForDeployment();
    await strategyB.waitForDeployment();
    await strategyC.waitForDeployment();

    // Grant guardian role
    const GUARDIAN_ROLE = await treasury.GUARDIAN_ROLE();
    await treasury.grantRole(GUARDIAN_ROLE, guardian.address);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════

  describe("Initialization", function () {
    it("Should initialize with correct defaults", async function () {
      expect(await treasury.asset()).to.equal(await usdc.getAddress());
      expect(await treasury.vault()).to.equal(vault.address);
      expect(await treasury.reserveBps()).to.equal(1000); // 10%
      expect(await treasury.minAutoAllocateAmount()).to.equal(1000n * ONE_USDC);

      const fees = await treasury.fees();
      expect(fees.performanceFeeBps).to.equal(4000); // 40% — stakers get ~6% on 10% gross
      expect(fees.feeRecipient).to.equal(feeRecipient.address);
    });

    it("Should reject zero addresses on init", async function () {
      const Factory = await ethers.getContractFactory("TreasuryV2");
      await expect(
        upgrades.deployProxy(Factory, [
          ethers.ZeroAddress,
          vault.address,
          admin.address,
          feeRecipient.address,
        ])
      ).to.be.revertedWithCustomError(treasury, "ZeroAddress");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STRATEGY MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════

  describe("Strategy Management", function () {
    it("Should add a strategy", async function () {
      const addr = await strategyA.getAddress();
      await timelockAddStrategy(treasury, admin, addr, 4000, 2000, 5000, true);

      expect(await treasury.isStrategy(addr)).to.be.true;
      expect(await treasury.strategyCount()).to.equal(1);

      const config = await treasury.strategies(0);
      expect(config.strategy).to.equal(addr);
      expect(config.targetBps).to.equal(4000);
      expect(config.active).to.be.true;
      expect(config.autoAllocate).to.be.true;
    });

    it("Should add multiple strategies with correct allocation", async function () {
      // 40% + 30% + 20% + 10% reserve = 100%
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 4000, 2000, 5000, true);
      await timelockAddStrategy(treasury, admin, await strategyB.getAddress(), 3000, 1000, 4000, true);
      await timelockAddStrategy(treasury, admin, await strategyC.getAddress(), 2000, 500, 3000, true);

      expect(await treasury.strategyCount()).to.equal(3);
    });

    it("Should reject duplicate strategy", async function () {
      const addr = await strategyA.getAddress();
      await timelockAddStrategy(treasury, admin, addr, 4000, 2000, 5000, true);

      await expect(
        treasury.requestAddStrategy(addr, 3000, 1000, 4000, true)
      ).to.be.revertedWithCustomError(treasury, "StrategyExists");
    });

    it("Should reject allocation exceeding 100%", async function () {
      // reserveBps = 1000 (10%), try adding 9500 (95%) → 105% total
      // Request goes through, but execute validates total allocation
      await treasury.requestAddStrategy(await strategyA.getAddress(), 9500, 1000, 10000, true);
      await time.increase(48 * 3600);
      await expect(
        treasury.executeAddStrategy()
      ).to.be.revertedWithCustomError(treasury, "TotalAllocationInvalid");
    });

    it("Should reject more than MAX_STRATEGIES", async function () {
      const Factory = await ethers.getContractFactory("MockStrategy");
      for (let i = 0; i < 10; i++) {
        const strat = await Factory.deploy(await usdc.getAddress(), await treasury.getAddress());
        await strat.waitForDeployment();
        await timelockAddStrategy(treasury, admin, await strat.getAddress(), 100, 0, 500, true); // 1% each
      }

      const extraStrat = await Factory.deploy(await usdc.getAddress(), await treasury.getAddress());
      await extraStrat.waitForDeployment();
      await expect(
        treasury.requestAddStrategy(await extraStrat.getAddress(), 100, 0, 500, true)
      ).to.be.revertedWithCustomError(treasury, "MaxStrategiesReached");
    });

    it("Should remove a strategy and withdraw funds", async function () {
      const addr = await strategyA.getAddress();
      await timelockAddStrategy(treasury, admin, addr, 4000, 2000, 5000, true);

      // Deposit some USDC to the strategy directly (simulating allocation)
      await usdc.mint(addr, 100_000n * ONE_USDC);

      await timelockRemoveStrategy(treasury, admin, addr);
      expect(await treasury.isStrategy(addr)).to.be.false;

      const config = await treasury.strategies(0);
      expect(config.active).to.be.false;
      expect(config.targetBps).to.equal(0);
    });

    it("Should update strategy allocation", async function () {
      const addr = await strategyA.getAddress();
      await timelockAddStrategy(treasury, admin, addr, 4000, 2000, 5000, true);

      await treasury.updateStrategy(addr, 5000, 3000, 6000, false);

      const config = await treasury.strategies(0);
      expect(config.targetBps).to.equal(5000);
      expect(config.autoAllocate).to.be.false;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AUTO-ALLOCATION
  // ═══════════════════════════════════════════════════════════════════════

  describe("Auto-Allocation", function () {
    beforeEach(async function () {
      // Setup: 40% stratA, 30% stratB, 20% stratC, 10% reserve
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 4000, 2000, 5000, true);
      await timelockAddStrategy(treasury, admin, await strategyB.getAddress(), 3000, 1000, 4000, true);
      await timelockAddStrategy(treasury, admin, await strategyC.getAddress(), 2000, 500, 3000, true);
    });

    it("Should auto-allocate deposit across strategies", async function () {
      const depositAmount = 100_000n * ONE_USDC; // 100K USDC

      // Mint USDC to vault and approve treasury
      await usdc.mint(vault.address, depositAmount);
      await usdc.connect(vault).approve(await treasury.getAddress(), depositAmount);

      // Deposit using legacy interface
      await treasury.connect(vault).deposit(vault.address, depositAmount);

      // 10% reserve = 10K, 40% of 90K = 40K, 30% of 90K = 30K, 20% of 90K = 20K
      // (approximately — rounding may differ slightly)
      const reserveBal = await usdc.balanceOf(await treasury.getAddress());
      const stratABal = await usdc.balanceOf(await strategyA.getAddress());
      const stratBBal = await usdc.balanceOf(await strategyB.getAddress());
      const stratCBal = await usdc.balanceOf(await strategyC.getAddress());

      // Reserve should have ~10K
      expect(reserveBal).to.be.closeTo(10_000n * ONE_USDC, 100n * ONE_USDC);
      // Strategy A should have ~40K
      expect(stratABal).to.be.closeTo(40_000n * ONE_USDC, 100n * ONE_USDC);
      // Strategy B should have ~30K (gets remainder, may be slightly more)
      expect(stratBBal).to.be.closeTo(30_000n * ONE_USDC, 1000n * ONE_USDC);
      // Strategy C should have ~20K
      expect(stratCBal).to.be.closeTo(20_000n * ONE_USDC, 1000n * ONE_USDC);

      // Total should still be 100K
      const total = reserveBal + stratABal + stratBBal + stratCBal;
      expect(total).to.equal(depositAmount);
    });

    it("Should keep small deposits in reserve", async function () {
      const smallDeposit = 500n * ONE_USDC; // Below 1000 USDC minimum

      await usdc.mint(vault.address, smallDeposit);
      await usdc.connect(vault).approve(await treasury.getAddress(), smallDeposit);

      await treasury.connect(vault).deposit(vault.address, smallDeposit);

      // All should be in reserve
      const reserveBal = await usdc.balanceOf(await treasury.getAddress());
      expect(reserveBal).to.equal(smallDeposit);
    });

    it("Should handle strategy deposit failure gracefully", async function () {
      await strategyA.setDepositShouldFail(true);

      const depositAmount = 10_000n * ONE_USDC;
      await usdc.mint(vault.address, depositAmount);
      await usdc.connect(vault).approve(await treasury.getAddress(), depositAmount);

      // Should not revert — failed strategy portion stays in reserve
      await treasury.connect(vault).deposit(vault.address, depositAmount);

      // Strategy A should have 0
      const stratABal = await usdc.balanceOf(await strategyA.getAddress());
      expect(stratABal).to.equal(0);

      // Total value should still be full deposit
      expect(await treasury.totalValue()).to.equal(depositAmount);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // WITHDRAWAL
  // ═══════════════════════════════════════════════════════════════════════

  describe("Withdrawal", function () {
    beforeEach(async function () {
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 4000, 2000, 5000, true);
      await timelockAddStrategy(treasury, admin, await strategyB.getAddress(), 3000, 1000, 4000, true);

      // Deposit 100K
      const depositAmount = 100_000n * ONE_USDC;
      await usdc.mint(vault.address, depositAmount);
      await usdc.connect(vault).approve(await treasury.getAddress(), depositAmount);
      await treasury.connect(vault).deposit(vault.address, depositAmount);
    });

    it("Should withdraw from reserve when sufficient", async function () {
      // Reserve has ~10K, withdraw 5K
      const withdrawAmount = 5_000n * ONE_USDC;
      await treasury.connect(vault).withdraw(user.address, withdrawAmount);

      expect(await usdc.balanceOf(user.address)).to.equal(withdrawAmount);
    });

    it("Should withdraw from strategies when reserve insufficient", async function () {
      // Reserve has ~10K, withdraw 50K → must pull from strategies
      const withdrawAmount = 50_000n * ONE_USDC;
      await treasury.connect(vault).withdraw(user.address, withdrawAmount);

      expect(await usdc.balanceOf(user.address)).to.equal(withdrawAmount);
    });

    it("Should revert on insufficient total balance", async function () {
      const tooMuch = 200_000n * ONE_USDC;
      await expect(
        treasury.connect(vault).withdraw(user.address, tooMuch)
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // VAULT INTERFACE (depositFromVault / withdrawToVault)
  // ═══════════════════════════════════════════════════════════════════════

  describe("Vault Interface", function () {
    beforeEach(async function () {
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 4500, 2000, 6000, true);
      await timelockAddStrategy(treasury, admin, await strategyB.getAddress(), 4500, 2000, 6000, true);
    });

    it("Should depositFromVault with auto-allocation", async function () {
      const amount = 50_000n * ONE_USDC;
      await usdc.mint(vault.address, amount);
      await usdc.connect(vault).approve(await treasury.getAddress(), amount);

      await treasury.connect(vault).depositFromVault(amount);

      expect(await treasury.totalValue()).to.equal(amount);
    });

    it("Should withdrawToVault from reserve + strategies", async function () {
      // First deposit
      const amount = 50_000n * ONE_USDC;
      await usdc.mint(vault.address, amount);
      await usdc.connect(vault).approve(await treasury.getAddress(), amount);
      await treasury.connect(vault).depositFromVault(amount);

      // Withdraw most of it
      const withdrawAmount = 40_000n * ONE_USDC;
      const balBefore = await usdc.balanceOf(vault.address);
      await treasury.connect(vault).withdrawToVault(withdrawAmount);
      const balAfter = await usdc.balanceOf(vault.address);

      expect(balAfter - balBefore).to.equal(withdrawAmount);
    });

    it("Should reject deposits from non-vault", async function () {
      await usdc.mint(user.address, 1000n * ONE_USDC);
      await usdc.connect(user).approve(await treasury.getAddress(), 1000n * ONE_USDC);

      await expect(
        treasury.connect(user).depositFromVault(1000n * ONE_USDC)
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // FEE ACCRUAL
  // ═══════════════════════════════════════════════════════════════════════

  describe("Fee Accrual", function () {
    it("Should accrue fees on yield", async function () {
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 9000, 5000, 10000, true);

      // Deposit 100K
      const depositAmount = 100_000n * ONE_USDC;
      await usdc.mint(vault.address, depositAmount);
      await usdc.connect(vault).approve(await treasury.getAddress(), depositAmount);
      await treasury.connect(vault).deposit(vault.address, depositAmount);

      // Simulate yield: mint 10K USDC to strategy A
      const yieldAmount = 10_000n * ONE_USDC;
      await usdc.mint(await strategyA.getAddress(), yieldAmount);

      // Trigger fee accrual
      await treasury.accrueFees();

      // 40% of 10K yield = 4K fees (stakers get 6K = ~6% target)
      const pending = await treasury.pendingFees();
      expect(pending).to.be.closeTo(4_000n * ONE_USDC, 100n * ONE_USDC);
    });

    it("Should claim fees to recipient", async function () {
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 9000, 5000, 10000, true);

      // Deposit
      const depositAmount = 100_000n * ONE_USDC;
      await usdc.mint(vault.address, depositAmount);
      await usdc.connect(vault).approve(await treasury.getAddress(), depositAmount);
      await treasury.connect(vault).deposit(vault.address, depositAmount);

      // Simulate yield
      await usdc.mint(await strategyA.getAddress(), 10_000n * ONE_USDC);

      // FIX: Advance time by > 1 hour to satisfy MIN_ACCRUAL_INTERVAL
      await ethers.provider.send("evm_increaseTime", [3601]);
      await ethers.provider.send("evm_mine", []);

      // Claim fees
      await treasury.claimFees();

      const recipientBal = await usdc.balanceOf(feeRecipient.address);
      expect(recipientBal).to.be.closeTo(4_000n * ONE_USDC, 100n * ONE_USDC);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // REBALANCING
  // ═══════════════════════════════════════════════════════════════════════

  describe("Rebalancing", function () {
    it("Should rebalance from over-allocated to under-allocated", async function () {
      // Setup 50/50 split
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 4500, 2000, 6000, true);
      await timelockAddStrategy(treasury, admin, await strategyB.getAddress(), 4500, 2000, 6000, true);

      // Deposit
      const depositAmount = 100_000n * ONE_USDC;
      await usdc.mint(vault.address, depositAmount);
      await usdc.connect(vault).approve(await treasury.getAddress(), depositAmount);
      await treasury.connect(vault).deposit(vault.address, depositAmount);

      // Simulate: A has double what it should (big yield)
      await usdc.mint(await strategyA.getAddress(), 50_000n * ONE_USDC);

      // Rebalance
      await treasury.rebalance();

      // After rebalance, allocations should be closer to targets
      const totalVal = await treasury.totalValue();
      const stratAVal = await usdc.balanceOf(await strategyA.getAddress());
      const stratBVal = await usdc.balanceOf(await strategyB.getAddress());

      // Both should be approximately 45% of total
      const targetVal = (totalVal * 4500n) / 10000n;
      expect(stratAVal).to.be.closeTo(targetVal, 5_000n * ONE_USDC);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // EMERGENCY
  // ═══════════════════════════════════════════════════════════════════════

  describe("Emergency", function () {
    it("Should emergency withdraw all from strategies", async function () {
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 4500, 2000, 6000, true);
      await timelockAddStrategy(treasury, admin, await strategyB.getAddress(), 4500, 2000, 6000, true);

      // Deposit
      const depositAmount = 100_000n * ONE_USDC;
      await usdc.mint(vault.address, depositAmount);
      await usdc.connect(vault).approve(await treasury.getAddress(), depositAmount);
      await treasury.connect(vault).deposit(vault.address, depositAmount);

      // Emergency withdraw
      await treasury.connect(guardian).emergencyWithdrawAll();

      // All funds should be in reserve now
      const reserveBal = await usdc.balanceOf(await treasury.getAddress());
      expect(reserveBal).to.equal(depositAmount);

      const stratABal = await usdc.balanceOf(await strategyA.getAddress());
      const stratBBal = await usdc.balanceOf(await strategyB.getAddress());
      expect(stratABal).to.equal(0);
      expect(stratBBal).to.equal(0);
    });

    it("Should pause and unpause", async function () {
      await treasury.connect(guardian).pause();

      await usdc.mint(vault.address, 1000n * ONE_USDC);
      await usdc.connect(vault).approve(await treasury.getAddress(), 1000n * ONE_USDC);

      await expect(
        treasury.connect(vault).deposit(vault.address, 1000n * ONE_USDC)
      ).to.be.reverted;

      await treasury.connect(admin).unpause();

      // Should work now
      await treasury.connect(vault).deposit(vault.address, 1000n * ONE_USDC);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // ADMIN
  // ═══════════════════════════════════════════════════════════════════════

  describe("Admin", function () {
    it("Should update fee config", async function () {
      await timelockSetFeeConfig(treasury, admin, 1000, feeRecipient.address);
      const fees = await treasury.fees();
      expect(fees.performanceFeeBps).to.equal(1000);
    });

    it("Should reject fee too high", async function () {
      await expect(
        treasury.requestFeeConfig(6000, feeRecipient.address) // 60% > 50% max
      ).to.be.revertedWith("Fee too high");
    });

    it("Should update reserve bps", async function () {
      await timelockSetReserveBps(treasury, admin, 2000);
      expect(await treasury.reserveBps()).to.equal(2000);
    });

    it("Should reject reserve too high", async function () {
      await expect(
        treasury.requestReserveBps(4000) // 40% > 30% max
      ).to.be.revertedWith("Reserve too high");
    });

    it("Should update vault address via timelock", async function () {
      const newVault = user;
      // Request vault change
      await treasury.requestVaultChange(newVault.address);
      expect(await treasury.pendingVault()).to.equal(newVault.address);
      
      // Cannot execute before timelock expires
      await expect(
        treasury.executeVaultChange()
      ).to.be.revertedWith("VAULT_TIMELOCK_ACTIVE");
      
      // Advance time past 48h timelock
      await ethers.provider.send("evm_increaseTime", [48 * 3600 + 1]);
      await ethers.provider.send("evm_mine", []);
      
      // Execute vault change
      await treasury.executeVaultChange();
      expect(await treasury.vault()).to.equal(newVault.address);
    });

    it("Should cancel pending vault change", async function () {
      const newVault = user;
      await treasury.requestVaultChange(newVault.address);
      await treasury.cancelVaultChange();
      expect(await treasury.pendingVault()).to.equal(ethers.ZeroAddress);
    });

    it("Should update min auto-allocate", async function () {
      await treasury.setMinAutoAllocate(5000n * ONE_USDC);
      expect(await treasury.minAutoAllocateAmount()).to.equal(5000n * ONE_USDC);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // VIEW FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════════

  describe("View Functions", function () {
    it("Should report correct totalValue", async function () {
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 4500, 2000, 6000, true);

      const depositAmount = 50_000n * ONE_USDC;
      await usdc.mint(vault.address, depositAmount);
      await usdc.connect(vault).approve(await treasury.getAddress(), depositAmount);
      await treasury.connect(vault).deposit(vault.address, depositAmount);

      expect(await treasury.totalValue()).to.equal(depositAmount);
    });

    it("Should report totalValueNet minus fees", async function () {
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 9000, 5000, 10000, true);

      const depositAmount = 100_000n * ONE_USDC;
      await usdc.mint(vault.address, depositAmount);
      await usdc.connect(vault).approve(await treasury.getAddress(), depositAmount);
      await treasury.connect(vault).deposit(vault.address, depositAmount);

      // Simulate yield
      await usdc.mint(await strategyA.getAddress(), 10_000n * ONE_USDC);

      const totalNet = await treasury.totalValueNet();
      const total = await treasury.totalValue();

      // Net should be less than gross by ~fee amount
      expect(totalNet).to.be.lt(total);
    });

    it("Should return correct current allocations", async function () {
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 4500, 2000, 6000, true);
      await timelockAddStrategy(treasury, admin, await strategyB.getAddress(), 4500, 2000, 6000, true);

      const depositAmount = 100_000n * ONE_USDC;
      await usdc.mint(vault.address, depositAmount);
      await usdc.connect(vault).approve(await treasury.getAddress(), depositAmount);
      await treasury.connect(vault).deposit(vault.address, depositAmount);

      const [addrs, currentBps, targetBps] = await treasury.getCurrentAllocations();
      expect(addrs.length).to.equal(2);
      expect(targetBps[0]).to.equal(4500);
      expect(targetBps[1]).to.equal(4500);
    });

    it("Should report strategies via getAllStrategies", async function () {
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 4000, 2000, 5000, true);
      await timelockAddStrategy(treasury, admin, await strategyB.getAddress(), 3000, 1000, 4000, true);

      const all = await treasury.getAllStrategies();
      expect(all.length).to.equal(2);
      expect(all[0].strategy).to.equal(await strategyA.getAddress());
      expect(all[1].strategy).to.equal(await strategyB.getAddress());
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STRATEGY ROLLOVER
  // ═══════════════════════════════════════════════════════════════════════

  describe("Strategy Rollover", function () {
    it("Should remove a funded strategy (funds returned) and add a replacement", async function () {
      // Setup: add strategyA at 45%, deposit & allocate
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 4500, 2000, 6000, true);

      const depositAmount = 100_000n * ONE_USDC;
      await usdc.mint(vault.address, depositAmount);
      await usdc.connect(vault).approve(await treasury.getAddress(), depositAmount);
      await treasury.connect(vault).deposit(vault.address, depositAmount);

      // Verify strategyA received funds
      const stratAValue = await strategyA.totalValue();
      expect(stratAValue).to.be.gt(0);

      // Remove strategyA — should withdrawAll back to treasury
      const treasuryAddr = await treasury.getAddress();
      const treasuryBalBefore = await usdc.balanceOf(treasuryAddr);
      await timelockRemoveStrategy(treasury, admin, await strategyA.getAddress());
      const treasuryBalAfter = await usdc.balanceOf(treasuryAddr);

      // Funds should have been returned to treasury
      expect(treasuryBalAfter - treasuryBalBefore).to.equal(stratAValue);

      // strategyA should be deactivated
      expect(await treasury.isStrategy(await strategyA.getAddress())).to.be.false;

      // Add strategyB as replacement at the same allocation
      await timelockAddStrategy(treasury, admin, await strategyB.getAddress(), 4500, 2000, 6000, true);

      // Rebalance to push funds to the new strategy
      await treasury.rebalance();

      // strategyB should now hold funds
      const stratBValue = await strategyB.totalValue();
      expect(stratBValue).to.be.gt(0);

      // Total value should be approximately unchanged
      const totalAfter = await treasury.totalValue();
      expect(totalAfter).to.be.closeTo(depositAmount, ONE_USDC); // within 1 USDC
    });

    it("Should handle rollover when old strategy withdraw fails", async function () {
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 4500, 2000, 6000, true);

      const depositAmount = 50_000n * ONE_USDC;
      await usdc.mint(vault.address, depositAmount);
      await usdc.connect(vault).approve(await treasury.getAddress(), depositAmount);
      await treasury.connect(vault).deposit(vault.address, depositAmount);

      // Make strategy withdraw fail
      await strategyA.setWithdrawShouldFail(true);

      // Remove should still succeed (strategy is force-deactivated)
      await treasury.requestRemoveStrategy(await strategyA.getAddress());
      await time.increase(48 * 3600);
      await expect(treasury.executeRemoveStrategy())
        .to.emit(treasury, "StrategyForceDeactivated");

      // Strategy should be deactivated despite withdraw failure
      expect(await treasury.isStrategy(await strategyA.getAddress())).to.be.false;
    });

    it("Should remove an empty strategy cleanly", async function () {
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 4500, 2000, 6000, true);

      // Don't deposit anything — strategy has 0 value
      await timelockRemoveStrategy(treasury, admin, await strategyA.getAddress());

      expect(await treasury.isStrategy(await strategyA.getAddress())).to.be.false;

      // Can re-add the same strategy address
      await timelockAddStrategy(treasury, admin, await strategyA.getAddress(), 4500, 2000, 6000, true);
      expect(await treasury.isStrategy(await strategyA.getAddress())).to.be.true;
    });
  });
});
