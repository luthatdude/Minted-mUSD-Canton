/**
 * YieldBasisStrategy + YBStakingVault Tests
 * Tests the Yield Basis integration: USDC lending strategy and mUSD staking vaults
 */

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("YieldBasis Integration", function () {
  let usdc: any;
  let musd: any;
  let wbtc: any;
  let weth: any;
  let ybBtcPool: any;
  let ybEthPool: any;
  let ybBtcStrategy: any;
  let ybEthStrategy: any;
  let ybBtcVault: any;
  let ybEthVault: any;
  let treasury: any;
  let deployer: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;
  let guardian: HardhatEthersSigner;

  const USDC_DECIMALS = 6;
  const INITIAL_USDC = ethers.parseUnits("1000000", USDC_DECIMALS); // 1M USDC
  const SUPPLY_CAP = ethers.parseEther("10000000"); // 10M mUSD
  const DEPOSIT_AMOUNT = ethers.parseUnits("100000", USDC_DECIMALS); // 100k USDC
  const MUSD_DEPOSIT = ethers.parseEther("100000"); // 100k mUSD

  beforeEach(async function () {
    [deployer, user1, user2, guardian] = await ethers.getSigners();

    // Deploy tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20.deploy("USD Coin", "USDC", USDC_DECIMALS);
    wbtc = await MockERC20.deploy("Wrapped Bitcoin", "WBTC", 8);
    weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);

    const MUSDFactory = await ethers.getContractFactory("MUSD");
    musd = await MUSDFactory.deploy(SUPPLY_CAP);

    // Deploy mock YB pools
    const MockYBPool = await ethers.getContractFactory("MockYieldBasisPool");
    ybBtcPool = await MockYBPool.deploy(await usdc.getAddress(), await wbtc.getAddress());
    ybEthPool = await MockYBPool.deploy(await usdc.getAddress(), await weth.getAddress());

    // Deploy TreasuryV2
    const TreasuryFactory = await ethers.getContractFactory("TreasuryV2");
    treasury = (await upgrades.deployProxy(TreasuryFactory, [
      await usdc.getAddress(),
      deployer.address,
      deployer.address,
      deployer.address,
      deployer.address,
    ])) as any;

    // Deploy YieldBasisStrategy instances (BTC + ETH)
    const YBStrategy = await ethers.getContractFactory("YieldBasisStrategy");

    ybBtcStrategy = (await upgrades.deployProxy(YBStrategy, [
      await usdc.getAddress(),
      await ybBtcPool.getAddress(),
      await treasury.getAddress(),
      deployer.address,
      deployer.address, // timelock = deployer for tests
      "BTC",
    ])) as any;

    ybEthStrategy = (await upgrades.deployProxy(YBStrategy, [
      await usdc.getAddress(),
      await ybEthPool.getAddress(),
      await treasury.getAddress(),
      deployer.address,
      deployer.address,
      "ETH",
    ])) as any;

    // Deploy YBStakingVault instances (now UUPS upgradeable)
    const YBVault = await ethers.getContractFactory("YBStakingVault");
    ybBtcVault = (await upgrades.deployProxy(YBVault, [
      await musd.getAddress(),
      await ybBtcPool.getAddress(),
      "Yield Basis BTC Staked mUSD",
      "ybBTC",
      ethers.parseEther("10000000"), // 10M cap
      deployer.address,
      deployer.address, // timelock = deployer for tests
    ])) as any;
    ybEthVault = (await upgrades.deployProxy(YBVault, [
      await musd.getAddress(),
      await ybEthPool.getAddress(),
      "Yield Basis ETH Staked mUSD",
      "ybETH",
      ethers.parseEther("10000000"),
      deployer.address,
      deployer.address,
    ])) as any;

    // Setup roles
    const TREASURY_ROLE = await ybBtcStrategy.TREASURY_ROLE();
    await ybBtcStrategy.grantRole(TREASURY_ROLE, deployer.address);
    await ybEthStrategy.grantRole(TREASURY_ROLE, deployer.address);

    const YIELD_MANAGER_ROLE = await ybBtcVault.YIELD_MANAGER_ROLE();
    await ybBtcVault.grantRole(YIELD_MANAGER_ROLE, deployer.address);
    await ybEthVault.grantRole(YIELD_MANAGER_ROLE, deployer.address);

    // Mint tokens
    await usdc.mint(deployer.address, INITIAL_USDC);
    await usdc.mint(user1.address, INITIAL_USDC);

    // Mint mUSD to users (for staking vault deposits)
    const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
    await musd.grantRole(BRIDGE_ROLE, deployer.address);
    await musd.mint(user1.address, ethers.parseEther("500000"));
    await musd.mint(user2.address, ethers.parseEther("500000"));

    // Fund YB pools with USDC for yield payments
    await usdc.mint(await ybBtcPool.getAddress(), ethers.parseUnits("100000", USDC_DECIMALS));
    await usdc.mint(await ybEthPool.getAddress(), ethers.parseUnits("100000", USDC_DECIMALS));
  });

  // ═══════════════════════════════════════════════════════════════════════
  // YieldBasisStrategy Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe("YieldBasisStrategy", function () {
    describe("Initialization", function () {
      it("should initialize with correct parameters", async function () {
        expect(await ybBtcStrategy.usdc()).to.equal(await usdc.getAddress());
        expect(await ybBtcStrategy.poolLabel()).to.equal("BTC");
        expect(await ybBtcStrategy.active()).to.be.true;
        expect(await ybBtcStrategy.asset()).to.equal(await usdc.getAddress());
        expect(await ybBtcStrategy.isActive()).to.be.true;
      });

      it("should have separate BTC and ETH instances", async function () {
        expect(await ybBtcStrategy.poolLabel()).to.equal("BTC");
        expect(await ybEthStrategy.poolLabel()).to.equal("ETH");
        expect(await ybBtcStrategy.baseAsset()).to.equal(await wbtc.getAddress());
        expect(await ybEthStrategy.baseAsset()).to.equal(await weth.getAddress());
      });

      it("should reject initialization with wrong quote asset", async function () {
        const YBStrategy = await ethers.getContractFactory("YieldBasisStrategy");
        const MockYBPool = await ethers.getContractFactory("MockYieldBasisPool");
        const badPool = await MockYBPool.deploy(await weth.getAddress(), await wbtc.getAddress());

        await expect(
          upgrades.deployProxy(YBStrategy, [
            await usdc.getAddress(),
            await badPool.getAddress(),
            await treasury.getAddress(),
            deployer.address,
            deployer.address,
            "BAD",
          ])
        ).to.be.revertedWithCustomError(YBStrategy, "InvalidPool");
      });
    });

    describe("Deposits", function () {
      it("should deposit USDC into YB pool", async function () {
        await usdc.approve(await ybBtcStrategy.getAddress(), DEPOSIT_AMOUNT);
        await ybBtcStrategy.deposit(DEPOSIT_AMOUNT);

        expect(await ybBtcStrategy.totalValue()).to.equal(DEPOSIT_AMOUNT);
        expect(await ybBtcStrategy.totalDeposited()).to.equal(DEPOSIT_AMOUNT);
      });

      it("should reject zero deposit", async function () {
        await expect(ybBtcStrategy.deposit(0))
          .to.be.revertedWithCustomError(ybBtcStrategy, "ZeroAmount");
      });

      it("should reject deposit when inactive", async function () {
        await ybBtcStrategy.setActive(false);
        await usdc.approve(await ybBtcStrategy.getAddress(), DEPOSIT_AMOUNT);
        await expect(ybBtcStrategy.deposit(DEPOSIT_AMOUNT))
          .to.be.revertedWithCustomError(ybBtcStrategy, "NotActive");
      });

      it("should reject deposit when pool not accepting", async function () {
        await ybBtcPool.setAcceptingDeposits(false);
        await usdc.approve(await ybBtcStrategy.getAddress(), DEPOSIT_AMOUNT);
        await expect(ybBtcStrategy.deposit(DEPOSIT_AMOUNT))
          .to.be.revertedWithCustomError(ybBtcStrategy, "PoolNotAcceptingDeposits");
      });

      it("should reject deposit when utilization too high", async function () {
        await ybBtcPool.setUtilization(9600); // 96% > 95% cap
        await usdc.approve(await ybBtcStrategy.getAddress(), DEPOSIT_AMOUNT);
        await expect(ybBtcStrategy.deposit(DEPOSIT_AMOUNT))
          .to.be.revertedWithCustomError(ybBtcStrategy, "PoolUtilizationTooHigh");
      });

      it("should reject deposit from non-treasury", async function () {
        await usdc.connect(user1).approve(await ybBtcStrategy.getAddress(), DEPOSIT_AMOUNT);
        await expect(ybBtcStrategy.connect(user1).deposit(DEPOSIT_AMOUNT))
          .to.be.reverted; // AccessControl revert
      });
    });

    describe("Withdrawals", function () {
      beforeEach(async function () {
        await usdc.approve(await ybBtcStrategy.getAddress(), DEPOSIT_AMOUNT);
        await ybBtcStrategy.deposit(DEPOSIT_AMOUNT);
      });

      it("should withdraw USDC from YB pool", async function () {
        const balBefore = await usdc.balanceOf(deployer.address);
        const halfAmount = DEPOSIT_AMOUNT / 2n;
        await ybBtcStrategy.withdraw(halfAmount);
        const balAfter = await usdc.balanceOf(deployer.address);

        expect(balAfter - balBefore).to.equal(halfAmount);
      });

      it("should withdrawAll from YB pool", async function () {
        const balBefore = await usdc.balanceOf(deployer.address);
        await ybBtcStrategy.withdrawAll();
        const balAfter = await usdc.balanceOf(deployer.address);

        expect(balAfter - balBefore).to.equal(DEPOSIT_AMOUNT);
        expect(await ybBtcStrategy.totalValue()).to.equal(0);
      });

      it("should reject zero withdraw", async function () {
        await expect(ybBtcStrategy.withdraw(0))
          .to.be.revertedWithCustomError(ybBtcStrategy, "ZeroAmount");
      });
    });

    describe("Yield Accrual", function () {
      it("should reflect yield from YB pool in totalValue", async function () {
        await usdc.approve(await ybBtcStrategy.getAddress(), DEPOSIT_AMOUNT);
        await ybBtcStrategy.deposit(DEPOSIT_AMOUNT);

        // Simulate 5% yield
        const yieldAmount = DEPOSIT_AMOUNT / 20n; // 5%
        await ybBtcPool.setAccruedYield(yieldAmount);

        const value = await ybBtcStrategy.totalValue();
        expect(value).to.equal(DEPOSIT_AMOUNT + yieldAmount);
      });

      it("should track P&L correctly", async function () {
        await usdc.approve(await ybBtcStrategy.getAddress(), DEPOSIT_AMOUNT);
        await ybBtcStrategy.deposit(DEPOSIT_AMOUNT);

        await ybBtcPool.setAccruedYield(ethers.parseUnits("5000", USDC_DECIMALS)); // 5k yield

        const pnl = await ybBtcStrategy.netPnL();
        expect(pnl).to.equal(ethers.parseUnits("5000", USDC_DECIMALS));
      });

      it("should harvest and track yield", async function () {
        await usdc.approve(await ybBtcStrategy.getAddress(), DEPOSIT_AMOUNT);
        await ybBtcStrategy.deposit(DEPOSIT_AMOUNT);

        await ybBtcPool.setAccruedYield(ethers.parseUnits("10000", USDC_DECIMALS));

        await expect(ybBtcStrategy.harvest())
          .to.emit(ybBtcStrategy, "Harvested");

        expect(await ybBtcStrategy.totalHarvested()).to.be.gt(0);
      });
    });

    describe("View Functions", function () {
      it("should expose current APY", async function () {
        const apy = await ybBtcStrategy.currentAPY();
        expect(apy).to.equal(ethers.parseUnits("0.08", 18)); // 8%
      });

      it("should expose current utilization", async function () {
        const util = await ybBtcStrategy.currentUtilization();
        expect(util).to.equal(5000); // 50%
      });
    });

    describe("Admin Functions", function () {
      it("should toggle active state", async function () {
        await ybBtcStrategy.setActive(false);
        expect(await ybBtcStrategy.isActive()).to.be.false;

        await ybBtcStrategy.setActive(true);
        expect(await ybBtcStrategy.isActive()).to.be.true;
      });

      it("should update utilization cap", async function () {
        await ybBtcStrategy.setUtilizationCap(8000);
        expect(await ybBtcStrategy.utilizationCap()).to.equal(8000);
      });

      it("should reject utilization cap below 50%", async function () {
        await expect(ybBtcStrategy.setUtilizationCap(4000))
          .to.be.revertedWithCustomError(ybBtcStrategy, "UtilizationCapTooLow");
      });

      it("should pause and unpause", async function () {
        const GUARDIAN_ROLE = await ybBtcStrategy.GUARDIAN_ROLE();
        await ybBtcStrategy.grantRole(GUARDIAN_ROLE, guardian.address);

        await ybBtcStrategy.connect(guardian).pause();
        expect(await ybBtcStrategy.isActive()).to.be.false;

        await ybBtcStrategy.unpause();
        expect(await ybBtcStrategy.isActive()).to.be.true;
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // YBStakingVault Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe("YBStakingVault", function () {
    describe("Initialization", function () {
      it("should have correct name and symbol for BTC vault", async function () {
        expect(await ybBtcVault.name()).to.equal("Yield Basis BTC Staked mUSD");
        expect(await ybBtcVault.symbol()).to.equal("ybBTC");
      });

      it("should have correct name and symbol for ETH vault", async function () {
        expect(await ybEthVault.name()).to.equal("Yield Basis ETH Staked mUSD");
        expect(await ybEthVault.symbol()).to.equal("ybETH");
      });

      it("should accept mUSD as underlying asset", async function () {
        expect(await ybBtcVault.asset()).to.equal(await musd.getAddress());
      });

      it("should expose the base asset (WBTC/WETH)", async function () {
        expect(await ybBtcVault.baseAsset()).to.equal(await wbtc.getAddress());
        expect(await ybEthVault.baseAsset()).to.equal(await weth.getAddress());
      });
    });

    describe("Deposits (Staking mUSD)", function () {
      it("should accept mUSD deposits and issue shares", async function () {
        await musd.connect(user1).approve(await ybBtcVault.getAddress(), MUSD_DEPOSIT);
        await ybBtcVault.connect(user1).deposit(MUSD_DEPOSIT, user1.address);

        const shares = await ybBtcVault.balanceOf(user1.address);
        expect(shares).to.be.gt(0);
        expect(await ybBtcVault.totalAssets()).to.equal(MUSD_DEPOSIT);
      });

      it("should set cooldown on deposit", async function () {
        await musd.connect(user1).approve(await ybBtcVault.getAddress(), MUSD_DEPOSIT);
        await ybBtcVault.connect(user1).deposit(MUSD_DEPOSIT, user1.address);

        expect(await ybBtcVault.canWithdraw(user1.address)).to.be.false;
        const cooldown = await ybBtcVault.getRemainingCooldown(user1.address);
        expect(cooldown).to.be.gt(0);
      });

      it("should reject deposits exceeding cap", async function () {
        const smallCap = ethers.parseEther("1000");
        await ybBtcVault.setMaxTotalDeposits(smallCap);

        await musd.connect(user1).approve(await ybBtcVault.getAddress(), MUSD_DEPOSIT);
        await expect(
          ybBtcVault.connect(user1).deposit(MUSD_DEPOSIT, user1.address)
        ).to.be.revertedWithCustomError(ybBtcVault, "DepositCapReached");
      });

      it("should allow deposits into both BTC and ETH vaults", async function () {
        const halfDeposit = MUSD_DEPOSIT / 2n;

        await musd.connect(user1).approve(await ybBtcVault.getAddress(), halfDeposit);
        await ybBtcVault.connect(user1).deposit(halfDeposit, user1.address);

        await musd.connect(user1).approve(await ybEthVault.getAddress(), halfDeposit);
        await ybEthVault.connect(user1).deposit(halfDeposit, user1.address);

        expect(await ybBtcVault.balanceOf(user1.address)).to.be.gt(0);
        expect(await ybEthVault.balanceOf(user1.address)).to.be.gt(0);
      });
    });

    describe("Withdrawals (Unstaking)", function () {
      beforeEach(async function () {
        await musd.connect(user1).approve(await ybBtcVault.getAddress(), MUSD_DEPOSIT);
        await ybBtcVault.connect(user1).deposit(MUSD_DEPOSIT, user1.address);
      });

      it("should reject withdrawal during cooldown", async function () {
        const shares = await ybBtcVault.balanceOf(user1.address);
        await expect(
          ybBtcVault.connect(user1).redeem(shares, user1.address, user1.address)
        ).to.be.revertedWithCustomError(ybBtcVault, "CooldownActive");
      });

      it("should allow withdrawal after cooldown", async function () {
        await time.increase(24 * 3600 + 1); // 24h + 1s

        const shares = await ybBtcVault.balanceOf(user1.address);
        const balBefore = await musd.balanceOf(user1.address);
        await ybBtcVault.connect(user1).redeem(shares, user1.address, user1.address);
        const balAfter = await musd.balanceOf(user1.address);

        expect(balAfter - balBefore).to.equal(MUSD_DEPOSIT);
      });

      it("should propagate cooldown on transfer", async function () {
        // user1 has a fresh deposit → cooldown active
        const shares = await ybBtcVault.balanceOf(user1.address);
        await ybBtcVault.connect(user1).transfer(user2.address, shares / 2n);

        // user2 should inherit user1's cooldown
        expect(await ybBtcVault.canWithdraw(user2.address)).to.be.false;
      });
    });

    describe("Yield Distribution", function () {
      beforeEach(async function () {
        await musd.connect(user1).approve(await ybBtcVault.getAddress(), MUSD_DEPOSIT);
        await ybBtcVault.connect(user1).deposit(MUSD_DEPOSIT, user1.address);
      });

      it("should increase share price when yield is distributed", async function () {
        const sharesBefore = await ybBtcVault.balanceOf(user1.address);
        const assetsBefore = await ybBtcVault.convertToAssets(sharesBefore);

        // Distribute 5% yield
        const yieldAmount = MUSD_DEPOSIT / 20n;
        await musd.mint(deployer.address, yieldAmount);
        await musd.approve(await ybBtcVault.getAddress(), yieldAmount);
        await ybBtcVault.distributeYield(yieldAmount);

        const assetsAfter = await ybBtcVault.convertToAssets(sharesBefore);
        expect(assetsAfter).to.be.gt(assetsBefore);
      });

      it("should reject yield exceeding cap", async function () {
        // MAX_YIELD_BPS = 1000 (10%), so > 10% of total assets should fail
        const tooMuchYield = MUSD_DEPOSIT; // 100% of assets
        await musd.mint(deployer.address, tooMuchYield);
        await musd.approve(await ybBtcVault.getAddress(), tooMuchYield);

        await expect(ybBtcVault.distributeYield(tooMuchYield))
          .to.be.revertedWithCustomError(ybBtcVault, "YieldExceedsCap");
      });

      it("should reject yield when no shares exist", async function () {
        // Deploy a fresh vault (now UUPS upgradeable)
        const YBVault = await ethers.getContractFactory("YBStakingVault");
        const emptyVault = (await upgrades.deployProxy(YBVault, [
          await musd.getAddress(),
          await ybBtcPool.getAddress(),
          "Empty", "EMPTY",
          ethers.parseEther("10000000"),
          deployer.address,
          deployer.address,
        ])) as any;
        const YIELD_MANAGER_ROLE = await emptyVault.YIELD_MANAGER_ROLE();
        await emptyVault.grantRole(YIELD_MANAGER_ROLE, deployer.address);

        const yieldAmount = ethers.parseEther("1000");
        await musd.mint(deployer.address, yieldAmount);
        await musd.approve(await emptyVault.getAddress(), yieldAmount);

        await expect(emptyVault.distributeYield(yieldAmount))
          .to.be.revertedWithCustomError(emptyVault, "NoSharesExist");
      });

      it("should track total yield received", async function () {
        const yieldAmount = ethers.parseEther("5000");
        await musd.mint(deployer.address, yieldAmount);
        await musd.approve(await ybBtcVault.getAddress(), yieldAmount);
        await ybBtcVault.distributeYield(yieldAmount);

        expect(await ybBtcVault.totalYieldReceived()).to.equal(yieldAmount);
      });
    });

    describe("ERC-4626 Compliance", function () {
      it("should return 0 for maxDeposit when paused", async function () {
        const PAUSER_ROLE = await ybBtcVault.PAUSER_ROLE();
        await ybBtcVault.grantRole(PAUSER_ROLE, deployer.address);
        await ybBtcVault.pause();
        expect(await ybBtcVault.maxDeposit(user1.address)).to.equal(0);
      });

      it("should return 0 for maxWithdraw during cooldown", async function () {
        await musd.connect(user1).approve(await ybBtcVault.getAddress(), MUSD_DEPOSIT);
        await ybBtcVault.connect(user1).deposit(MUSD_DEPOSIT, user1.address);
        expect(await ybBtcVault.maxWithdraw(user1.address)).to.equal(0);
      });

      it("should return correct maxDeposit based on remaining cap", async function () {
        const cap = ethers.parseEther("200000");
        await ybBtcVault.setMaxTotalDeposits(cap);

        await musd.connect(user1).approve(await ybBtcVault.getAddress(), MUSD_DEPOSIT);
        await ybBtcVault.connect(user1).deposit(MUSD_DEPOSIT, user1.address);

        const remaining = await ybBtcVault.maxDeposit(user2.address);
        expect(remaining).to.equal(cap - MUSD_DEPOSIT);
      });
    });

    describe("Canton Cross-Chain Sync", function () {
      it("should sync Canton shares", async function () {
        await musd.connect(user1).approve(await ybBtcVault.getAddress(), MUSD_DEPOSIT);
        await ybBtcVault.connect(user1).deposit(MUSD_DEPOSIT, user1.address);

        const BRIDGE_ROLE = await ybBtcVault.BRIDGE_ROLE();
        await ybBtcVault.grantRole(BRIDGE_ROLE, deployer.address);

        const cantonShares = ethers.parseEther("50000");
        await ybBtcVault.syncCantonShares(cantonShares, 1);

        expect(await ybBtcVault.cantonTotalShares()).to.equal(cantonShares);
        expect(await ybBtcVault.globalTotalShares()).to.be.gt(await ybBtcVault.totalSupply());
      });

      it("should reject out-of-order epochs", async function () {
        const BRIDGE_ROLE = await ybBtcVault.BRIDGE_ROLE();
        await ybBtcVault.grantRole(BRIDGE_ROLE, deployer.address);

        await musd.connect(user1).approve(await ybBtcVault.getAddress(), MUSD_DEPOSIT);
        await ybBtcVault.connect(user1).deposit(MUSD_DEPOSIT, user1.address);

        await ybBtcVault.syncCantonShares(ethers.parseEther("50000"), 1);
        await time.increase(3601);

        await expect(ybBtcVault.syncCantonShares(ethers.parseEther("52000"), 1))
          .to.be.revertedWithCustomError(ybBtcVault, "EpochNotSequential");
      });
    });

    describe("View Functions", function () {
      it("should expose current APY from YB pool", async function () {
        expect(await ybBtcVault.currentAPY()).to.equal(ethers.parseUnits("0.08", 18));
      });

      it("should expose current utilization", async function () {
        expect(await ybBtcVault.currentUtilization()).to.equal(5000);
      });
    });

    describe("Admin", function () {
      it("should update max total deposits", async function () {
        const newMax = ethers.parseEther("5000000");
        await ybBtcVault.setMaxTotalDeposits(newMax);
        expect(await ybBtcVault.maxTotalDeposits()).to.equal(newMax);
      });

      it("should reject zero max deposits", async function () {
        await expect(ybBtcVault.setMaxTotalDeposits(0))
          .to.be.revertedWithCustomError(ybBtcVault, "ZeroAmount");
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // End-to-End Flow Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe("End-to-End: Mint → Stake → Earn → Unstake", function () {
    it("should complete full BTC staking lifecycle", async function () {
      // 1. User has mUSD (already minted in setup)
      const initialMusd = await musd.balanceOf(user1.address);

      // 2. Stake mUSD into ybBTC vault
      const stakeAmount = ethers.parseEther("50000");
      await musd.connect(user1).approve(await ybBtcVault.getAddress(), stakeAmount);
      await ybBtcVault.connect(user1).deposit(stakeAmount, user1.address);

      const ybBtcShares = await ybBtcVault.balanceOf(user1.address);
      expect(ybBtcShares).to.be.gt(0);

      // 3. Yield is distributed (simulating YB pool earnings)
      const yield_ = ethers.parseEther("2500"); // 5% yield
      await musd.mint(deployer.address, yield_);
      await musd.approve(await ybBtcVault.getAddress(), yield_);
      await ybBtcVault.distributeYield(yield_);

      // 4. Wait for cooldown
      await time.increase(24 * 3600 + 1);

      // 5. Unstake — should receive more mUSD than deposited
      await ybBtcVault.connect(user1).redeem(ybBtcShares, user1.address, user1.address);
      const finalMusd = await musd.balanceOf(user1.address);

      // User should have earned yield
      expect(finalMusd).to.be.gt(initialMusd);
    });

    it("should allow user to stake in both BTC and ETH simultaneously", async function () {
      const perVault = ethers.parseEther("25000");

      // Stake in BTC vault
      await musd.connect(user1).approve(await ybBtcVault.getAddress(), perVault);
      await ybBtcVault.connect(user1).deposit(perVault, user1.address);

      // Stake in ETH vault
      await musd.connect(user1).approve(await ybEthVault.getAddress(), perVault);
      await ybEthVault.connect(user1).deposit(perVault, user1.address);

      expect(await ybBtcVault.balanceOf(user1.address)).to.be.gt(0);
      expect(await ybEthVault.balanceOf(user1.address)).to.be.gt(0);

      // Total staked = 50k across both vaults
      expect(await ybBtcVault.totalAssets()).to.equal(perVault);
      expect(await ybEthVault.totalAssets()).to.equal(perVault);
    });

    it("should handle different yield rates for BTC and ETH", async function () {
      const stakeAmount = ethers.parseEther("50000");

      // Stake in both
      await musd.connect(user1).approve(await ybBtcVault.getAddress(), stakeAmount);
      await ybBtcVault.connect(user1).deposit(stakeAmount, user1.address);

      await musd.connect(user2).approve(await ybEthVault.getAddress(), stakeAmount);
      await ybEthVault.connect(user2).deposit(stakeAmount, user2.address);

      // BTC vault gets 8% yield, ETH vault gets 5%
      const btcYield = ethers.parseEther("4000"); // 8%
      const ethYield = ethers.parseEther("2500"); // 5%

      await musd.mint(deployer.address, btcYield + ethYield);
      await musd.approve(await ybBtcVault.getAddress(), btcYield);
      await ybBtcVault.distributeYield(btcYield);

      await musd.approve(await ybEthVault.getAddress(), ethYield);
      await ybEthVault.distributeYield(ethYield);

      // BTC vault should have higher share price
      const btcShares = await ybBtcVault.balanceOf(user1.address);
      const ethShares = await ybEthVault.balanceOf(user2.address);

      const btcValue = await ybBtcVault.convertToAssets(btcShares);
      const ethValue = await ybEthVault.convertToAssets(ethShares);

      expect(btcValue).to.be.gt(ethValue);
    });
  });
});
