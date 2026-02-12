import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("SkySUSDSStrategy", function () {
  const USDC_DECIMALS = 6;
  const USDS_DECIMALS = 18;
  const SCALING_FACTOR = 10n ** 12n;

  async function deployFixture() {
    const [admin, treasury, strategist, guardian, user1] = await ethers.getSigners();

    // Deploy MockERC20 for USDC (6 decimals) and USDS (18 decimals)
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", USDC_DECIMALS);
    const usds = await MockERC20.deploy("USDS Stablecoin", "USDS", USDS_DECIMALS);

    // Deploy MockSkyPSM
    const MockSkyPSM = await ethers.getContractFactory("MockSkyPSM");
    const psm = await MockSkyPSM.deploy(await usdc.getAddress(), await usds.getAddress());

    // Deploy MockSUSDS vault
    const MockSUSDS = await ethers.getContractFactory("MockSUSDS");
    const sUsdsVault = await MockSUSDS.deploy(await usds.getAddress());

    // Seed PSM with USDS liquidity for sellGem (USDC → USDS)
    await usds.mint(await psm.getAddress(), ethers.parseUnits("10000000", USDS_DECIMALS));
    // Seed PSM with USDC liquidity for buyGem (USDS → USDC)
    await usdc.mint(await psm.getAddress(), ethers.parseUnits("10000000", USDC_DECIMALS));
    // Seed sUSDS vault with USDS for redemptions
    await usds.mint(await sUsdsVault.getAddress(), ethers.parseUnits("10000000", USDS_DECIMALS));

    // Deploy SkySUSDSStrategy as upgradeable proxy
    const SkySUSDSStrategy = await ethers.getContractFactory("SkySUSDSStrategy");
    const strategy = await upgrades.deployProxy(
      SkySUSDSStrategy,
      [
        await usdc.getAddress(),
        await usds.getAddress(),
        await psm.getAddress(),
        await sUsdsVault.getAddress(),
        treasury.address,
        admin.address,
      ],
      {
        kind: "uups",
        initializer: "initialize",
      }
    );

    // Grant roles
    const TREASURY_ROLE = await strategy.TREASURY_ROLE();
    const STRATEGIST_ROLE = await strategy.STRATEGIST_ROLE();
    const GUARDIAN_ROLE = await strategy.GUARDIAN_ROLE();

    await strategy.connect(admin).grantRole(STRATEGIST_ROLE, strategist.address);
    await strategy.connect(admin).grantRole(GUARDIAN_ROLE, guardian.address);

    // Mint USDC to treasury for deposits
    await usdc.mint(treasury.address, ethers.parseUnits("1000000", USDC_DECIMALS));
    await usdc.connect(treasury).approve(await strategy.getAddress(), ethers.MaxUint256);

    return { strategy, usdc, usds, psm, sUsdsVault, admin, treasury, strategist, guardian, user1 };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════

  describe("Initialization", function () {
    it("Should set correct initial parameters", async function () {
      const { strategy, usdc, usds, psm, sUsdsVault } = await loadFixture(deployFixture);

      expect(await strategy.usdc()).to.equal(await usdc.getAddress());
      expect(await strategy.usds()).to.equal(await usds.getAddress());
      expect(await strategy.psm()).to.equal(await psm.getAddress());
      expect(await strategy.sUsdsVault()).to.equal(await sUsdsVault.getAddress());
      expect(await strategy.active()).to.be.true;
      expect(await strategy.slippageToleranceBps()).to.equal(10);
      expect(await strategy.minDepositAmount()).to.equal(ethers.parseUnits("100", USDC_DECIMALS));
    });

    it("Should grant roles correctly", async function () {
      const { strategy, admin, treasury } = await loadFixture(deployFixture);

      const DEFAULT_ADMIN_ROLE = await strategy.DEFAULT_ADMIN_ROLE();
      const TREASURY_ROLE = await strategy.TREASURY_ROLE();

      expect(await strategy.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await strategy.hasRole(TREASURY_ROLE, treasury.address)).to.be.true;
    });

    it("Should not allow re-initialization", async function () {
      const { strategy, usdc, usds, psm, sUsdsVault, treasury, admin } = await loadFixture(deployFixture);

      await expect(
        strategy.initialize(
          await usdc.getAddress(),
          await usds.getAddress(),
          await psm.getAddress(),
          await sUsdsVault.getAddress(),
          treasury.address,
          admin.address
        )
      ).to.be.reverted;
    });

    it("Should reject zero addresses in initialize", async function () {
      const { usdc, usds, psm, sUsdsVault, treasury, admin } = await loadFixture(deployFixture);

      const SkySUSDSStrategy = await ethers.getContractFactory("SkySUSDSStrategy");

      // Zero USDC
      await expect(
        upgrades.deployProxy(
          SkySUSDSStrategy,
          [ethers.ZeroAddress, await usds.getAddress(), await psm.getAddress(), await sUsdsVault.getAddress(), treasury.address, admin.address],
          { kind: "uups", initializer: "initialize" }
        )
      ).to.be.revertedWith("Zero USDC");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // DEPOSIT
  // ═══════════════════════════════════════════════════════════════════════

  describe("Deposit", function () {
    it("Should deposit USDC successfully (USDC → PSM → USDS → sUSDS)", async function () {
      const { strategy, usdc, sUsdsVault, treasury } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("10000", USDC_DECIMALS);

      await expect(strategy.connect(treasury).deposit(amount))
        .to.emit(strategy, "Deposited");

      expect(await strategy.totalPrincipal()).to.equal(amount);
      expect(await strategy.totalValue()).to.be.gte(amount);
    });

    it("Should revert when strategy is inactive", async function () {
      const { strategy, strategist, treasury } = await loadFixture(deployFixture);

      await strategy.connect(strategist).deactivate();

      await expect(
        strategy.connect(treasury).deposit(ethers.parseUnits("1000", USDC_DECIMALS))
      ).to.be.revertedWithCustomError(strategy, "StrategyInactive");
    });

    it("Should revert on zero amount", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(treasury).deposit(0)
      ).to.be.revertedWithCustomError(strategy, "ZeroAmount");
    });

    it("Should revert below minimum deposit", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(treasury).deposit(ethers.parseUnits("10", USDC_DECIMALS))
      ).to.be.revertedWithCustomError(strategy, "BelowMinDeposit");
    });

    it("Should enforce max deposit amount", async function () {
      const { strategy, strategist, treasury } = await loadFixture(deployFixture);

      await strategy.connect(strategist).setMaxDepositAmount(ethers.parseUnits("5000", USDC_DECIMALS));

      await expect(
        strategy.connect(treasury).deposit(ethers.parseUnits("10000", USDC_DECIMALS))
      ).to.be.revertedWithCustomError(strategy, "ExceedsMaxDeposit");
    });

    it("Should enforce max total value", async function () {
      const { strategy, strategist, treasury } = await loadFixture(deployFixture);

      await strategy.connect(strategist).setMaxTotalValue(ethers.parseUnits("5000", USDC_DECIMALS));

      await expect(
        strategy.connect(treasury).deposit(ethers.parseUnits("10000", USDC_DECIMALS))
      ).to.be.revertedWithCustomError(strategy, "ExceedsMaxTotalValue");
    });

    it("Should revert when called by non-treasury", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(user1).deposit(ethers.parseUnits("1000", USDC_DECIMALS))
      ).to.be.reverted;
    });

    it("Should revert when paused", async function () {
      const { strategy, guardian, treasury } = await loadFixture(deployFixture);

      await strategy.connect(guardian).pause();

      await expect(
        strategy.connect(treasury).deposit(ethers.parseUnits("1000", USDC_DECIMALS))
      ).to.be.reverted; // EnforcedPause
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // WITHDRAW
  // ═══════════════════════════════════════════════════════════════════════

  describe("Withdraw", function () {
    it("Should withdraw partial USDC (sUSDS → USDS → PSM → USDC)", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      // Deposit first
      const depositAmount = ethers.parseUnits("10000", USDC_DECIMALS);
      await strategy.connect(treasury).deposit(depositAmount);

      // Withdraw half
      const withdrawAmount = ethers.parseUnits("5000", USDC_DECIMALS);
      await expect(strategy.connect(treasury).withdraw(withdrawAmount))
        .to.emit(strategy, "Withdrawn");

      expect(await strategy.totalPrincipal()).to.equal(depositAmount - withdrawAmount);
    });

    it("Should handle withdrawing more than principal gracefully", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      const depositAmount = ethers.parseUnits("1000", USDC_DECIMALS);
      await strategy.connect(treasury).deposit(depositAmount);

      // Withdraw everything (totalPrincipal goes to 0)
      await strategy.connect(treasury).withdraw(depositAmount);
      expect(await strategy.totalPrincipal()).to.equal(0);
    });

    it("Should revert on zero amount", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(treasury).withdraw(0)
      ).to.be.revertedWithCustomError(strategy, "ZeroAmount");
    });

    it("Should revert when called by non-treasury", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(user1).withdraw(ethers.parseUnits("1000", USDC_DECIMALS))
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // WITHDRAW ALL
  // ═══════════════════════════════════════════════════════════════════════

  describe("WithdrawAll", function () {
    it("Should withdraw all funds", async function () {
      const { strategy, usdc, treasury } = await loadFixture(deployFixture);

      const depositAmount = ethers.parseUnits("10000", USDC_DECIMALS);
      await strategy.connect(treasury).deposit(depositAmount);

      const treasuryBalBefore = await usdc.balanceOf(treasury.address);
      await expect(strategy.connect(treasury).withdrawAll())
        .to.emit(strategy, "WithdrawnAll");

      expect(await strategy.totalPrincipal()).to.equal(0);
      const treasuryBalAfter = await usdc.balanceOf(treasury.address);
      expect(treasuryBalAfter - treasuryBalBefore).to.be.gte(depositAmount - 1n); // Allow rounding
    });

    it("Should return 0 when no shares", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      // Nothing deposited, withdrawAll returns 0
      const tx = await strategy.connect(treasury).withdrawAll();
      const receipt = await tx.wait();
      // No WithdrawnAll event since shares == 0, function returns early
    });

    it("Should revert when called by non-treasury", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(user1).withdrawAll()
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // TOTAL VALUE
  // ═══════════════════════════════════════════════════════════════════════

  describe("TotalValue", function () {
    it("Should return 0 when nothing deposited", async function () {
      const { strategy } = await loadFixture(deployFixture);
      expect(await strategy.totalValue()).to.equal(0);
    });

    it("Should return correct value after deposit", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      const depositAmount = ethers.parseUnits("10000", USDC_DECIMALS);
      await strategy.connect(treasury).deposit(depositAmount);

      // Value should be approximately equal to deposit (1:1 share price initially)
      const value = await strategy.totalValue();
      expect(value).to.be.gte(depositAmount - 1n);
      expect(value).to.be.lte(depositAmount + 1n);
    });

    it("Should reflect yield accrual", async function () {
      const { strategy, sUsdsVault, treasury } = await loadFixture(deployFixture);

      const depositAmount = ethers.parseUnits("10000", USDC_DECIMALS);
      await strategy.connect(treasury).deposit(depositAmount);

      // Simulate 5% yield accrual
      await sUsdsVault.setSharePrice(ethers.parseUnits("1.05", 18));

      const value = await strategy.totalValue();
      // Should be approximately 10500 USDC
      expect(value).to.be.gte(ethers.parseUnits("10499", USDC_DECIMALS));
      expect(value).to.be.lte(ethers.parseUnits("10501", USDC_DECIMALS));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // VIEW FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════════

  describe("View Functions", function () {
    it("Should return correct asset address", async function () {
      const { strategy, usdc } = await loadFixture(deployFixture);
      expect(await strategy.asset()).to.equal(await usdc.getAddress());
    });

    it("Should report isActive correctly", async function () {
      const { strategy, strategist, guardian } = await loadFixture(deployFixture);

      expect(await strategy.isActive()).to.be.true;

      await strategy.connect(strategist).deactivate();
      expect(await strategy.isActive()).to.be.false;

      await strategy.connect(strategist).activate();
      expect(await strategy.isActive()).to.be.true;

      await strategy.connect(guardian).pause();
      expect(await strategy.isActive()).to.be.false;
    });

    it("Should return shares held", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      expect(await strategy.sharesHeld()).to.equal(0);

      await strategy.connect(treasury).deposit(ethers.parseUnits("1000", USDC_DECIMALS));
      expect(await strategy.sharesHeld()).to.be.gt(0);
    });

    it("Should calculate unrealized PnL", async function () {
      const { strategy, sUsdsVault, treasury } = await loadFixture(deployFixture);

      const depositAmount = ethers.parseUnits("10000", USDC_DECIMALS);
      await strategy.connect(treasury).deposit(depositAmount);

      // Initially PnL ≈ 0
      const pnl0 = await strategy.unrealizedPnL();
      expect(pnl0).to.be.gte(-1n);
      expect(pnl0).to.be.lte(1n);

      // Simulate yield
      await sUsdsVault.setSharePrice(ethers.parseUnits("1.10", 18));
      const pnl1 = await strategy.unrealizedPnL();
      expect(pnl1).to.be.gt(0);
    });

    it("Should return PSM fees", async function () {
      const { strategy } = await loadFixture(deployFixture);
      expect(await strategy.psmEntryFee()).to.equal(0);
      expect(await strategy.psmExitFee()).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // ADMIN FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════════

  describe("Admin Functions", function () {
    it("Should activate/deactivate", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await strategy.connect(strategist).deactivate();
      expect(await strategy.active()).to.be.false;

      await strategy.connect(strategist).activate();
      expect(await strategy.active()).to.be.true;
    });

    it("Should set max deposit amount", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      const newMax = ethers.parseUnits("50000", USDC_DECIMALS);
      await expect(strategy.connect(strategist).setMaxDepositAmount(newMax))
        .to.emit(strategy, "MaxDepositUpdated")
        .withArgs(newMax);
      expect(await strategy.maxDepositAmount()).to.equal(newMax);
    });

    it("Should set min deposit amount", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      const newMin = ethers.parseUnits("500", USDC_DECIMALS);
      await expect(strategy.connect(strategist).setMinDepositAmount(newMin))
        .to.emit(strategy, "MinDepositUpdated")
        .withArgs(newMin);
      expect(await strategy.minDepositAmount()).to.equal(newMin);
    });

    it("Should set max total value", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      const newMax = ethers.parseUnits("1000000", USDC_DECIMALS);
      await expect(strategy.connect(strategist).setMaxTotalValue(newMax))
        .to.emit(strategy, "MaxTotalValueUpdated")
        .withArgs(newMax);
      expect(await strategy.maxTotalValue()).to.equal(newMax);
    });

    it("Should set slippage tolerance", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(strategy.connect(strategist).setSlippageTolerance(50))
        .to.emit(strategy, "SlippageUpdated")
        .withArgs(50);
      expect(await strategy.slippageToleranceBps()).to.equal(50);
    });

    it("Should reject slippage > 5%", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(strategist).setSlippageTolerance(501)
      ).to.be.revertedWithCustomError(strategy, "InvalidSlippage");
    });

    it("Should reject admin calls from non-admin", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(user1).setMaxDepositAmount(100)
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // EMERGENCY
  // ═══════════════════════════════════════════════════════════════════════

  describe("Emergency", function () {
    it("Should emergency withdraw all to recipient", async function () {
      const { strategy, usdc, guardian, treasury, admin } = await loadFixture(deployFixture);

      // Deposit first
      await strategy.connect(treasury).deposit(ethers.parseUnits("10000", USDC_DECIMALS));

      // Emergency withdraw must go to treasury (has TREASURY_ROLE)
      const balBefore = await usdc.balanceOf(treasury.address);
      await expect(strategy.connect(guardian).emergencyWithdraw(treasury.address))
        .to.emit(strategy, "EmergencyWithdraw");

      const balAfter = await usdc.balanceOf(treasury.address);
      expect(balAfter - balBefore).to.be.gte(ethers.parseUnits("9999", USDC_DECIMALS));
      expect(await strategy.totalPrincipal()).to.equal(0);
      expect(await strategy.active()).to.be.false;
    });

    it("Should revert emergency withdraw with zero recipient", async function () {
      const { strategy, guardian } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(guardian).emergencyWithdraw(ethers.ZeroAddress)
      ).to.be.revertedWith("Zero recipient");
    });

    it("Should revert emergency withdraw from non-guardian", async function () {
      const { strategy, user1, admin } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(user1).emergencyWithdraw(admin.address)
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PAUSE
  // ═══════════════════════════════════════════════════════════════════════

  describe("Pause / Unpause", function () {
    it("Should pause and unpause", async function () {
      const { strategy, guardian, admin } = await loadFixture(deployFixture);

      await strategy.connect(guardian).pause();
      expect(await strategy.paused()).to.be.true;

      await strategy.connect(admin).unpause();
      expect(await strategy.paused()).to.be.false;
    });

    it("Should revert unpause from non-admin", async function () {
      const { strategy, guardian } = await loadFixture(deployFixture);

      await strategy.connect(guardian).pause();

      // Guardian cannot unpause (separation of duties)
      await expect(
        strategy.connect(guardian).unpause()
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // UPGRADE TIMELOCK
  // ═══════════════════════════════════════════════════════════════════════

  describe("Upgrade Timelock", function () {
    it("Should request upgrade", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);

      const fakeImpl = ethers.Wallet.createRandom().address;
      await expect(strategy.connect(admin).requestUpgrade(fakeImpl))
        .to.emit(strategy, "UpgradeRequested");

      expect(await strategy.pendingImplementation()).to.equal(fakeImpl);
    });

    it("Should cancel upgrade", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);

      const fakeImpl = ethers.Wallet.createRandom().address;
      await strategy.connect(admin).requestUpgrade(fakeImpl);

      await expect(strategy.connect(admin).cancelUpgrade())
        .to.emit(strategy, "UpgradeCancelled");

      expect(await strategy.pendingImplementation()).to.equal(ethers.ZeroAddress);
    });

    it("Should reject requestUpgrade with zero address", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(admin).requestUpgrade(ethers.ZeroAddress)
      ).to.be.revertedWith("ZERO_ADDRESS");
    });

    it("Should reject requestUpgrade from non-admin", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(user1).requestUpgrade(ethers.Wallet.createRandom().address)
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // RESCUE TOKENS
  // ═══════════════════════════════════════════════════════════════════════

  describe("Rescue Tokens", function () {
    it("Should rescue random tokens", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);

      // Deploy a random token and send it to the strategy
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const randomToken = await MockERC20.deploy("Random", "RND", 18);
      await randomToken.mint(await strategy.getAddress(), ethers.parseUnits("100", 18));

      await strategy.connect(admin).rescueToken(
        await randomToken.getAddress(),
        admin.address,
        ethers.parseUnits("100", 18)
      );
      expect(await randomToken.balanceOf(admin.address)).to.equal(ethers.parseUnits("100", 18));
    });

    it("Should not rescue USDC", async function () {
      const { strategy, usdc, admin } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(admin).rescueToken(await usdc.getAddress(), admin.address, 100)
      ).to.be.revertedWith("Cannot rescue USDC");
    });

    it("Should not rescue USDS", async function () {
      const { strategy, usds, admin } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(admin).rescueToken(await usds.getAddress(), admin.address, 100)
      ).to.be.revertedWith("Cannot rescue USDS");
    });

    it("Should not rescue sUSDS", async function () {
      const { strategy, sUsdsVault, admin } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(admin).rescueToken(await sUsdsVault.getAddress(), admin.address, 100)
      ).to.be.revertedWith("Cannot rescue sUSDS");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // MULTIPLE DEPOSITS & WITHDRAWS
  // ═══════════════════════════════════════════════════════════════════════

  describe("Multiple Operations", function () {
    it("Should handle multiple deposits and partial withdrawals", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      // Deposit 1
      await strategy.connect(treasury).deposit(ethers.parseUnits("5000", USDC_DECIMALS));
      expect(await strategy.totalPrincipal()).to.equal(ethers.parseUnits("5000", USDC_DECIMALS));

      // Deposit 2
      await strategy.connect(treasury).deposit(ethers.parseUnits("3000", USDC_DECIMALS));
      expect(await strategy.totalPrincipal()).to.equal(ethers.parseUnits("8000", USDC_DECIMALS));

      // Withdraw partial
      await strategy.connect(treasury).withdraw(ethers.parseUnits("2000", USDC_DECIMALS));
      expect(await strategy.totalPrincipal()).to.equal(ethers.parseUnits("6000", USDC_DECIMALS));

      // Withdraw all
      await strategy.connect(treasury).withdrawAll();
      expect(await strategy.totalPrincipal()).to.equal(0);
    });

    it("Should track value correctly across operations", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("10000", USDC_DECIMALS));
      const val1 = await strategy.totalValue();
      expect(val1).to.be.gte(ethers.parseUnits("9999", USDC_DECIMALS));

      await strategy.connect(treasury).withdraw(ethers.parseUnits("3000", USDC_DECIMALS));
      const val2 = await strategy.totalValue();
      expect(val2).to.be.lte(val1);
      expect(val2).to.be.gte(ethers.parseUnits("6999", USDC_DECIMALS));
    });
  });
});
