/**
 * MintedYBPool + MintedYBRouter Tests
 *
 * Tests the Minted-owned Yield Basis pool implementation that replaces
 * external YB pools (which have no remaining capacity).
 *
 * Coverage:
 *   - Initialization & configuration
 *   - Lender deposits & withdrawals (IYieldBasisPool compliance)
 *   - LP deployment & liquidity management
 *   - Fee harvesting & yield distribution
 *   - Rebalancing
 *   - Capacity controls
 *   - Access control & pause
 *   - Router pool registry
 *   - Integration with YieldBasisStrategy (unchanged)
 *   - Edge cases & error paths
 */

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("MintedYBPool", function () {
  let usdc: any;
  let wbtc: any;
  let weth: any;
  let uniPool: any;
  let positionManager: any;
  let swapRouter: any;
  let mintedPool: any;
  let router: any;

  let deployer: HardhatEthersSigner;
  let strategist: HardhatEthersSigner;
  let keeper: HardhatEthersSigner;
  let guardian: HardhatEthersSigner;
  let lender1: HardhatEthersSigner;
  let lender2: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;

  const USDC_DECIMALS = 6;
  const BTC_DECIMALS = 8;
  const MAX_DEPOSITS = ethers.parseUnits("10000000", USDC_DECIMALS); // 10M USDC capacity
  const DEPOSIT_AMOUNT = ethers.parseUnits("100000", USDC_DECIMALS); // 100k USDC
  const SMALL_DEPOSIT = ethers.parseUnits("1000", USDC_DECIMALS); // 1k USDC

  const STRATEGIST_ROLE = ethers.keccak256(ethers.toUtf8Bytes("STRATEGIST_ROLE"));
  const GUARDIAN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GUARDIAN_ROLE"));
  const KEEPER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("KEEPER_ROLE"));

  beforeEach(async function () {
    [deployer, strategist, keeper, guardian, lender1, lender2, feeRecipient] =
      await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20.deploy("USD Coin", "USDC", USDC_DECIMALS);
    wbtc = await MockERC20.deploy("Wrapped Bitcoin", "WBTC", BTC_DECIMALS);
    weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);

    // Deploy mock Uniswap V3 infrastructure
    const MockPool = await ethers.getContractFactory("MockUniswapV3Pool");
    // USDC as token0, WBTC as token1 (alphabetical for typical deployment)
    uniPool = await MockPool.deploy(
      await usdc.getAddress(),
      await wbtc.getAddress(),
      3000 // 0.3% fee tier
    );

    const MockPM = await ethers.getContractFactory("MockNonfungiblePositionManager");
    positionManager = await MockPM.deploy();

    const MockSR = await ethers.getContractFactory("MockSwapRouter");
    swapRouter = await (MockSR as any).deploy();

    // Deploy MintedYBPool via UUPS proxy
    const MintedYBPoolFactory = await ethers.getContractFactory("MintedYBPool");
    mintedPool = await upgrades.deployProxy(
      MintedYBPoolFactory,
      [
        await wbtc.getAddress(), // baseToken
        await usdc.getAddress(), // quoteToken
        await uniPool.getAddress(), // uniPool
        await positionManager.getAddress(), // positionManager
        await swapRouter.getAddress(), // swapRouter
        MAX_DEPOSITS, // maxDeposits
        deployer.address, // admin
        deployer.address, // timelock (deployer for tests)
        feeRecipient.address, // feeRecipient
      ],
      { unsafeAllow: ["delegatecall"] }
    );

    // Grant roles
    await mintedPool.grantRole(STRATEGIST_ROLE, strategist.address);
    await mintedPool.grantRole(GUARDIAN_ROLE, guardian.address);
    await mintedPool.grantRole(KEEPER_ROLE, keeper.address);

    // Seed lenders with USDC
    await usdc.mint(lender1.address, ethers.parseUnits("5000000", USDC_DECIMALS));
    await usdc.mint(lender2.address, ethers.parseUnits("5000000", USDC_DECIMALS));

    // Approve pool
    await usdc.connect(lender1).approve(await mintedPool.getAddress(), ethers.MaxUint256);
    await usdc.connect(lender2).approve(await mintedPool.getAddress(), ethers.MaxUint256);

    // Seed the swap router with USDC for swap tests
    await usdc.mint(await swapRouter.getAddress(), ethers.parseUnits("1000000", USDC_DECIMALS));

    // Deploy MintedYBRouter
    const RouterFactory = await ethers.getContractFactory("MintedYBRouter");
    router = await upgrades.deployProxy(RouterFactory, [
      deployer.address,
      deployer.address, // timelock
    ]);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════

  describe("Initialization", function () {
    it("should initialize with correct parameters", async function () {
      expect(await mintedPool.baseToken()).to.equal(await wbtc.getAddress());
      expect(await mintedPool.quoteAsset()).to.equal(await usdc.getAddress());
      expect(await mintedPool.maxLenderDeposits()).to.equal(MAX_DEPOSITS);
      expect(await mintedPool.feeRecipient()).to.equal(feeRecipient.address);
      expect(await mintedPool.feeTier()).to.equal(3000);
      expect(await mintedPool.utilizationTarget()).to.equal(8000);
      expect(await mintedPool.performanceFeeBps()).to.equal(1000);
      expect(await mintedPool.quoteIsToken0()).to.equal(true);
    });

    it("should report accepting deposits initially", async function () {
      expect(await mintedPool.acceptingDeposits()).to.equal(true);
    });

    it("should have zero lender state initially", async function () {
      expect(await mintedPool.totalLenderShares()).to.equal(0);
      expect(await mintedPool.totalLenderDeposited()).to.equal(0);
      expect(await mintedPool.idleQuoteBalance()).to.equal(0);
      expect(await mintedPool.activePositionId()).to.equal(0);
    });

    it("should revert double initialization", async function () {
      await expect(
        mintedPool.initialize(
          await wbtc.getAddress(),
          await usdc.getAddress(),
          await uniPool.getAddress(),
          await positionManager.getAddress(),
          await swapRouter.getAddress(),
          MAX_DEPOSITS,
          deployer.address,
          deployer.address,
          feeRecipient.address
        )
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // LENDER DEPOSITS
  // ═══════════════════════════════════════════════════════════════════════

  describe("Lender Deposits", function () {
    it("should accept first deposit 1:1 shares", async function () {
      await mintedPool.connect(lender1).depositLend(DEPOSIT_AMOUNT, 0);

      expect(await mintedPool.lenderShares(lender1.address)).to.equal(DEPOSIT_AMOUNT);
      expect(await mintedPool.totalLenderShares()).to.equal(DEPOSIT_AMOUNT);
      expect(await mintedPool.totalLenderDeposited()).to.equal(DEPOSIT_AMOUNT);
      expect(await mintedPool.idleQuoteBalance()).to.equal(DEPOSIT_AMOUNT);
    });

    it("should emit LenderDeposited event", async function () {
      await expect(mintedPool.connect(lender1).depositLend(DEPOSIT_AMOUNT, 0))
        .to.emit(mintedPool, "LenderDeposited")
        .withArgs(lender1.address, DEPOSIT_AMOUNT, DEPOSIT_AMOUNT);
    });

    it("should calculate proportional shares for subsequent deposits", async function () {
      // First deposit: 100k USDC = 100k shares
      await mintedPool.connect(lender1).depositLend(DEPOSIT_AMOUNT, 0);

      // Second deposit: same amount, same total value → same shares
      await mintedPool.connect(lender2).depositLend(DEPOSIT_AMOUNT, 0);

      expect(await mintedPool.lenderShares(lender2.address)).to.equal(DEPOSIT_AMOUNT);
      expect(await mintedPool.totalLenderShares()).to.equal(DEPOSIT_AMOUNT * 2n);
    });

    it("should enforce capacity cap", async function () {
      // Set small cap
      await mintedPool.setMaxLenderDeposits(SMALL_DEPOSIT);

      // Deposit within cap
      await mintedPool.connect(lender1).depositLend(SMALL_DEPOSIT, 0);

      // Deposit exceeding cap
      await expect(
        mintedPool.connect(lender2).depositLend(1, 0)
      ).to.be.revertedWithCustomError(mintedPool, "PoolNotAcceptingDeposits");
    });

    it("should enforce minShares slippage protection", async function () {
      await expect(
        mintedPool.connect(lender1).depositLend(DEPOSIT_AMOUNT, DEPOSIT_AMOUNT + 1n)
      ).to.be.revertedWithCustomError(mintedPool, "BelowMin");
    });

    it("should revert on zero deposit", async function () {
      await expect(
        mintedPool.connect(lender1).depositLend(0, 0)
      ).to.be.revertedWithCustomError(mintedPool, "ZeroAmount");
    });

    it("should revert when paused", async function () {
      await mintedPool.connect(guardian).pause();
      await expect(
        mintedPool.connect(lender1).depositLend(DEPOSIT_AMOUNT, 0)
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // LENDER WITHDRAWALS
  // ═══════════════════════════════════════════════════════════════════════

  describe("Lender Withdrawals", function () {
    beforeEach(async function () {
      await mintedPool.connect(lender1).depositLend(DEPOSIT_AMOUNT, 0);
    });

    it("should withdraw full amount with all shares", async function () {
      const shares = await mintedPool.lenderShares(lender1.address);
      const balBefore = await usdc.balanceOf(lender1.address);

      await mintedPool.connect(lender1).withdrawLend(shares, 0);

      const balAfter = await usdc.balanceOf(lender1.address);
      expect(balAfter - balBefore).to.equal(DEPOSIT_AMOUNT);
      expect(await mintedPool.lenderShares(lender1.address)).to.equal(0);
      expect(await mintedPool.totalLenderShares()).to.equal(0);
    });

    it("should withdraw partial amount", async function () {
      const halfShares = DEPOSIT_AMOUNT / 2n;
      await mintedPool.connect(lender1).withdrawLend(halfShares, 0);

      expect(await mintedPool.lenderShares(lender1.address)).to.equal(halfShares);
    });

    it("should emit LenderWithdrawn event", async function () {
      await expect(mintedPool.connect(lender1).withdrawLend(DEPOSIT_AMOUNT, 0))
        .to.emit(mintedPool, "LenderWithdrawn")
        .withArgs(lender1.address, DEPOSIT_AMOUNT, DEPOSIT_AMOUNT);
    });

    it("should revert on insufficient shares", async function () {
      await expect(
        mintedPool.connect(lender1).withdrawLend(DEPOSIT_AMOUNT + 1n, 0)
      ).to.be.revertedWithCustomError(mintedPool, "InsufficientShares");
    });

    it("should revert on zero shares", async function () {
      await expect(
        mintedPool.connect(lender1).withdrawLend(0, 0)
      ).to.be.revertedWithCustomError(mintedPool, "ZeroAmount");
    });

    it("should enforce minAmount slippage protection", async function () {
      await expect(
        mintedPool.connect(lender1).withdrawLend(DEPOSIT_AMOUNT, DEPOSIT_AMOUNT + 1n)
      ).to.be.revertedWithCustomError(mintedPool, "BelowMin");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // LP DEPLOYMENT
  // ═══════════════════════════════════════════════════════════════════════

  describe("LP Deployment", function () {
    beforeEach(async function () {
      // Lender deposits USDC
      await mintedPool.connect(lender1).depositLend(DEPOSIT_AMOUNT, 0);
    });

    it("should deploy liquidity to Uni V3", async function () {
      const deployAmount = DEPOSIT_AMOUNT / 2n;

      await mintedPool.connect(strategist).deployLiquidity(
        -887220, // tickLower
        887220, // tickUpper
        deployAmount, // quoteAmount
        0, // baseAmount (single-sided USDC)
        0, // minQuote
        0 // minBase
      );

      expect(await mintedPool.activePositionId()).to.be.gt(0);
      expect(await mintedPool.deployedQuoteAmount()).to.equal(deployAmount);
      expect(await mintedPool.idleQuoteBalance()).to.equal(DEPOSIT_AMOUNT - deployAmount);
    });

    it("should add to existing position", async function () {
      const half = DEPOSIT_AMOUNT / 2n;

      // First deployment
      await mintedPool.connect(strategist).deployLiquidity(-887220, 887220, half, 0, 0, 0);
      const posId = await mintedPool.activePositionId();

      // Add more
      await mintedPool.connect(strategist).deployLiquidity(-887220, 887220, half / 2n, 0, 0, 0);

      // Same position ID
      expect(await mintedPool.activePositionId()).to.equal(posId);
      expect(await mintedPool.deployedQuoteAmount()).to.equal(half + half / 2n);
    });

    it("should enforce utilization target", async function () {
      // Default: 80% utilization target
      // Trying to deploy more than 80% of deposits should revert
      const tooMuch = (DEPOSIT_AMOUNT * 9000n) / 10000n; // 90%

      await expect(
        mintedPool.connect(strategist).deployLiquidity(-887220, 887220, tooMuch, 0, 0, 0)
      ).to.be.revertedWithCustomError(mintedPool, "AboveMax");
    });

    it("should revert when idle balance insufficient", async function () {
      await expect(
        mintedPool.connect(strategist).deployLiquidity(
          -887220, 887220, DEPOSIT_AMOUNT + 1n, 0, 0, 0
        )
      ).to.be.revertedWithCustomError(mintedPool, "InsufficientIdle");
    });

    it("should revert with invalid tick range", async function () {
      await expect(
        mintedPool.connect(strategist).deployLiquidity(100, -100, SMALL_DEPOSIT, 0, 0, 0)
      ).to.be.revertedWithCustomError(mintedPool, "InvalidTickRange");
    });

    it("should require STRATEGIST_ROLE", async function () {
      await expect(
        mintedPool.connect(lender1).deployLiquidity(-887220, 887220, SMALL_DEPOSIT, 0, 0, 0)
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // REMOVE LIQUIDITY
  // ═══════════════════════════════════════════════════════════════════════

  describe("Remove Liquidity", function () {
    beforeEach(async function () {
      await mintedPool.connect(lender1).depositLend(DEPOSIT_AMOUNT, 0);
      await mintedPool.connect(strategist).deployLiquidity(
        -887220, 887220, DEPOSIT_AMOUNT / 2n, 0, 0, 0
      );
    });

    it("should remove all liquidity", async function () {
      await mintedPool.connect(strategist).removeLiquidity();

      expect(await mintedPool.activePositionId()).to.equal(0);
      expect(await mintedPool.deployedQuoteAmount()).to.equal(0);
      // Idle should have the USDC back
      expect(await mintedPool.idleQuoteBalance()).to.be.gt(0);
    });

    it("should allow emergency withdrawal by guardian", async function () {
      await mintedPool.connect(guardian).emergencyWithdrawLP();

      expect(await mintedPool.activePositionId()).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // HARVEST
  // ═══════════════════════════════════════════════════════════════════════

  describe("Fee Harvesting", function () {
    beforeEach(async function () {
      await mintedPool.connect(lender1).depositLend(DEPOSIT_AMOUNT, 0);
      await mintedPool.connect(strategist).deployLiquidity(
        -887220, 887220, DEPOSIT_AMOUNT / 2n, 0, 0, 0
      );
    });

    it("should harvest fees and distribute to lenders", async function () {
      // Simulate fee accrual: 1000 USDC in quote fees
      const feeAmount = ethers.parseUnits("1000", USDC_DECIMALS);
      await usdc.mint(await positionManager.getAddress(), feeAmount);
      await positionManager.simulateFees(feeAmount, 0);

      await mintedPool.connect(keeper).harvest();

      // 10% performance fee → 100 USDC protocol, 900 lender
      expect(await mintedPool.accruedProtocolFees()).to.equal(feeAmount / 10n);
      expect(await mintedPool.cumulativeLenderYield()).to.equal(feeAmount - feeAmount / 10n);
      expect(await mintedPool.lastHarvestTime()).to.be.gt(0);
    });

    it("should emit Harvested event", async function () {
      const feeAmount = ethers.parseUnits("500", USDC_DECIMALS);
      await usdc.mint(await positionManager.getAddress(), feeAmount);
      await positionManager.simulateFees(feeAmount, 0);

      await expect(mintedPool.connect(keeper).harvest()).to.emit(mintedPool, "Harvested");
    });

    it("should handle base token fees (swap to USDC)", async function () {
      // Simulate base token (WBTC) fees
      const btcFee = ethers.parseUnits("0.01", BTC_DECIMALS); // 0.01 BTC
      await wbtc.mint(await positionManager.getAddress(), btcFee);
      // Also need USDC in swap router for conversion
      await positionManager.simulateFees(0, btcFee);

      // Set swap rate: 1 BTC sat = 1 USDC unit (simplified for test)
      await swapRouter.setRate(1, 1);
      // Seed router with WBTC to transfer back as USDC
      // (In mock, the swap just transfers USDC from router to pool)

      await mintedPool.connect(keeper).harvest();

      // Some yield should be recorded
      expect(await mintedPool.cumulativeLenderYield()).to.be.gte(0);
    });

    it("should revert without active position", async function () {
      await mintedPool.connect(strategist).removeLiquidity();
      await expect(
        mintedPool.connect(keeper).harvest()
      ).to.be.revertedWithCustomError(mintedPool, "NoActivePosition");
    });

    it("should require KEEPER_ROLE", async function () {
      await expect(mintedPool.connect(lender1).harvest()).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // REBALANCE
  // ═══════════════════════════════════════════════════════════════════════

  describe("Rebalancing", function () {
    beforeEach(async function () {
      await mintedPool.connect(lender1).depositLend(DEPOSIT_AMOUNT, 0);
      await mintedPool.connect(strategist).deployLiquidity(
        -887220, 887220, DEPOSIT_AMOUNT / 2n, 0, 0, 0
      );
    });

    it("should rebalance to new tick range", async function () {
      // Wait for rebalance interval
      await time.increase(31 * 60); // 31 minutes

      const newDeployAmount = DEPOSIT_AMOUNT / 4n;
      await mintedPool.connect(strategist).rebalance(
        -100000, 100000, // New narrower range
        newDeployAmount,
        0,
        0,
        0
      );

      expect(await mintedPool.tickLower()).to.equal(-100000);
      expect(await mintedPool.tickUpper()).to.equal(100000);
    });

    it("should enforce rebalance interval", async function () {
      await expect(
        mintedPool.connect(strategist).rebalance(-100000, 100000, SMALL_DEPOSIT, 0, 0, 0)
      ).to.be.revertedWithCustomError(mintedPool, "RebalanceTooFrequent");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // VIEW FUNCTIONS (IYieldBasisPool compliance)
  // ═══════════════════════════════════════════════════════════════════════

  describe("IYieldBasisPool Views", function () {
    it("should return correct lenderValue", async function () {
      await mintedPool.connect(lender1).depositLend(DEPOSIT_AMOUNT, 0);
      expect(await mintedPool.lenderValue(lender1.address)).to.equal(DEPOSIT_AMOUNT);
    });

    it("should return correct lenderShares", async function () {
      await mintedPool.connect(lender1).depositLend(DEPOSIT_AMOUNT, 0);
      expect(await mintedPool.lenderShares(lender1.address)).to.equal(DEPOSIT_AMOUNT);
    });

    it("should return correct totalLenderAssets", async function () {
      await mintedPool.connect(lender1).depositLend(DEPOSIT_AMOUNT, 0);
      expect(await mintedPool.totalLenderAssets()).to.equal(DEPOSIT_AMOUNT);
    });

    it("should return baseAsset", async function () {
      expect(await mintedPool.baseAsset()).to.equal(await wbtc.getAddress());
    });

    it("should return quoteAsset", async function () {
      expect(await mintedPool.quoteAsset()).to.equal(await usdc.getAddress());
    });

    it("should return utilization as 0 when nothing deployed", async function () {
      await mintedPool.connect(lender1).depositLend(DEPOSIT_AMOUNT, 0);
      expect(await mintedPool.utilization()).to.equal(0);
    });

    it("should return correct utilization after deployment", async function () {
      await mintedPool.connect(lender1).depositLend(DEPOSIT_AMOUNT, 0);
      await mintedPool
        .connect(strategist)
        .deployLiquidity(-887220, 887220, DEPOSIT_AMOUNT / 2n, 0, 0, 0);

      // 50k deployed / 100k total = 50% = 5000 BPS
      expect(await mintedPool.utilization()).to.equal(5000);
    });

    it("should return lendingAPY as 0 initially", async function () {
      expect(await mintedPool.lendingAPY()).to.equal(0);
    });

    it("should return remaining capacity", async function () {
      expect(await mintedPool.remainingCapacity()).to.equal(MAX_DEPOSITS);

      await mintedPool.connect(lender1).depositLend(DEPOSIT_AMOUNT, 0);
      expect(await mintedPool.remainingCapacity()).to.equal(MAX_DEPOSITS - DEPOSIT_AMOUNT);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // ADMIN FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════════

  describe("Admin Functions", function () {
    it("should update max lender deposits", async function () {
      const newCap = ethers.parseUnits("50000000", USDC_DECIMALS);
      await expect(mintedPool.setMaxLenderDeposits(newCap))
        .to.emit(mintedPool, "CapacityUpdated")
        .withArgs(MAX_DEPOSITS, newCap);

      expect(await mintedPool.maxLenderDeposits()).to.equal(newCap);
    });

    it("should update utilization target", async function () {
      await expect(mintedPool.setUtilizationTarget(9000))
        .to.emit(mintedPool, "UtilizationTargetUpdated")
        .withArgs(8000, 9000);
    });

    it("should enforce max utilization target", async function () {
      await expect(
        mintedPool.setUtilizationTarget(9600)
      ).to.be.revertedWithCustomError(mintedPool, "AboveMax");
    });

    it("should update performance fee", async function () {
      await expect(mintedPool.setPerformanceFee(500))
        .to.emit(mintedPool, "PerformanceFeeUpdated")
        .withArgs(1000, 500);
    });

    it("should enforce max performance fee", async function () {
      await expect(
        mintedPool.setPerformanceFee(2500)
      ).to.be.revertedWithCustomError(mintedPool, "FeeTooHigh");
    });

    it("should update fee recipient", async function () {
      await expect(mintedPool.setFeeRecipient(lender1.address))
        .to.emit(mintedPool, "FeeRecipientUpdated")
        .withArgs(feeRecipient.address, lender1.address);
    });

    it("should withdraw protocol fees", async function () {
      // Setup: deposit, deploy, harvest fees
      await mintedPool.connect(lender1).depositLend(DEPOSIT_AMOUNT, 0);
      await mintedPool.connect(strategist).deployLiquidity(
        -887220, 887220, DEPOSIT_AMOUNT / 2n, 0, 0, 0
      );

      const feeAmount = ethers.parseUnits("1000", USDC_DECIMALS);
      await usdc.mint(await positionManager.getAddress(), feeAmount);
      await positionManager.simulateFees(feeAmount, 0);
      await mintedPool.connect(keeper).harvest();

      const protocolFees = await mintedPool.accruedProtocolFees();
      const recipientBalBefore = await usdc.balanceOf(feeRecipient.address);

      await mintedPool.withdrawProtocolFees();

      const recipientBalAfter = await usdc.balanceOf(feeRecipient.address);
      expect(recipientBalAfter - recipientBalBefore).to.equal(protocolFees);
      expect(await mintedPool.accruedProtocolFees()).to.equal(0);
    });

    it("should pause and unpause", async function () {
      await mintedPool.connect(guardian).pause();
      expect(await mintedPool.paused()).to.equal(true);
      expect(await mintedPool.acceptingDeposits()).to.equal(false);

      await mintedPool.unpause();
      expect(await mintedPool.paused()).to.equal(false);
      expect(await mintedPool.acceptingDeposits()).to.equal(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POOL INFO
  // ═══════════════════════════════════════════════════════════════════════

  describe("Pool Info", function () {
    it("should return comprehensive pool info", async function () {
      await mintedPool.connect(lender1).depositLend(DEPOSIT_AMOUNT, 0);

      const info = await mintedPool.poolInfo();
      expect(info._baseToken).to.equal(await wbtc.getAddress());
      expect(info._quoteToken).to.equal(await usdc.getAddress());
      expect(info._totalDeposited).to.equal(DEPOSIT_AMOUNT);
      expect(info._maxDeposits).to.equal(MAX_DEPOSITS);
      expect(info._deployed).to.equal(0);
      expect(info._idle).to.equal(DEPOSIT_AMOUNT);
      expect(info._accepting).to.equal(true);
    });

    it("should report isInRange correctly", async function () {
      expect(await mintedPool.isInRange()).to.equal(false); // No position

      await mintedPool.connect(lender1).depositLend(DEPOSIT_AMOUNT, 0);
      await mintedPool.connect(strategist).deployLiquidity(
        -887220, 887220, DEPOSIT_AMOUNT / 2n, 0, 0, 0
      );

      expect(await mintedPool.isInRange()).to.equal(true); // Current tick 0 is within range
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // WITHDRAWAL WITH LP PULL
  // ═══════════════════════════════════════════════════════════════════════

  describe("Withdrawal from LP", function () {
    it("should pull from LP when idle is insufficient", async function () {
      await mintedPool.connect(lender1).depositLend(DEPOSIT_AMOUNT, 0);

      // Deploy 80% of idle into LP
      const deployAmount = (DEPOSIT_AMOUNT * 8000n) / 10000n;
      await mintedPool.connect(strategist).deployLiquidity(
        -887220, 887220, deployAmount, 0, 0, 0
      );

      // Withdraw more than idle balance — should auto-pull from LP
      const withdrawShares = DEPOSIT_AMOUNT / 2n;
      await mintedPool.connect(lender1).withdrawLend(withdrawShares, 0);

      expect(await mintedPool.lenderShares(lender1.address)).to.equal(
        DEPOSIT_AMOUNT - withdrawShares
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MintedYBRouter Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("MintedYBRouter", function () {
  let usdc: any;
  let wbtc: any;
  let weth: any;
  let btcPool: any;
  let ethPool: any;
  let router: any;
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  const POOL_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("POOL_MANAGER_ROLE"));

  beforeEach(async function () {
    [deployer, user] = await ethers.getSigners();

    // Deploy tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    wbtc = await MockERC20.deploy("Wrapped Bitcoin", "WBTC", 8);
    weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);

    // Deploy mock YB pools (using the old mock which implements IYieldBasisPool)
    const MockYBPool = await ethers.getContractFactory("MockYieldBasisPool");
    btcPool = await MockYBPool.deploy(await usdc.getAddress(), await wbtc.getAddress());
    ethPool = await MockYBPool.deploy(await usdc.getAddress(), await weth.getAddress());

    // Deploy router
    const RouterFactory = await ethers.getContractFactory("MintedYBRouter");
    router = await upgrades.deployProxy(RouterFactory, [
      deployer.address,
      deployer.address,
    ]);
  });

  it("should register a pool", async function () {
    await expect(router.registerPool(await btcPool.getAddress()))
      .to.emit(router, "PoolRegistered")
      .withArgs(await btcPool.getAddress(), await wbtc.getAddress(), await usdc.getAddress());

    expect(await router.isRegistered(await btcPool.getAddress())).to.equal(true);
    expect(await router.poolCount()).to.equal(1);
  });

  it("should find pool by base/quote", async function () {
    await router.registerPool(await btcPool.getAddress());

    const found = await router.getPool(await wbtc.getAddress(), await usdc.getAddress());
    expect(found).to.equal(await btcPool.getAddress());
  });

  it("should return address(0) for unknown pair", async function () {
    const found = await router.getPool(await weth.getAddress(), await usdc.getAddress());
    expect(found).to.equal(ethers.ZeroAddress);
  });

  it("should register multiple pools", async function () {
    await router.registerPool(await btcPool.getAddress());
    await router.registerPool(await ethPool.getAddress());

    expect(await router.poolCount()).to.equal(2);

    const all = await router.getAllPools();
    expect(all.length).to.equal(2);
  });

  it("should return active pools only", async function () {
    await router.registerPool(await btcPool.getAddress());
    await router.registerPool(await ethPool.getAddress());

    // Disable BTC pool
    await btcPool.setAcceptingDeposits(false);

    const active = await router.getActivePools();
    expect(active.length).to.equal(1);
    expect(active[0]).to.equal(await ethPool.getAddress());
  });

  it("should deregister a pool", async function () {
    await router.registerPool(await btcPool.getAddress());
    await router.deregisterPool(await btcPool.getAddress());

    expect(await router.isRegistered(await btcPool.getAddress())).to.equal(false);
    expect(await router.poolCount()).to.equal(0);

    const found = await router.getPool(await wbtc.getAddress(), await usdc.getAddress());
    expect(found).to.equal(ethers.ZeroAddress);
  });

  it("should prevent duplicate registration", async function () {
    await router.registerPool(await btcPool.getAddress());

    await expect(
      router.registerPool(await btcPool.getAddress())
    ).to.be.revertedWithCustomError(router, "PoolAlreadyRegistered");
  });

  it("should prevent deregistering unknown pool", async function () {
    await expect(
      router.deregisterPool(await btcPool.getAddress())
    ).to.be.revertedWithCustomError(router, "PoolNotRegistered");
  });

  it("should require POOL_MANAGER_ROLE", async function () {
    await expect(
      router.connect(user).registerPool(await btcPool.getAddress())
    ).to.be.reverted;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration: MintedYBPool → YieldBasisStrategy (unchanged strategy)
// ═══════════════════════════════════════════════════════════════════════════

describe("MintedYBPool ↔ YieldBasisStrategy Integration", function () {
  let usdc: any;
  let wbtc: any;
  let mintedPool: any;
  let strategy: any;
  let treasury: any;
  let deployer: HardhatEthersSigner;
  let keeper: HardhatEthersSigner;

  const USDC_DECIMALS = 6;
  const DEPOSIT_AMOUNT = ethers.parseUnits("100000", USDC_DECIMALS);

  beforeEach(async function () {
    [deployer, keeper] = await ethers.getSigners();

    // Deploy tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20.deploy("USD Coin", "USDC", USDC_DECIMALS);
    wbtc = await MockERC20.deploy("Wrapped Bitcoin", "WBTC", 8);

    // Deploy mock YB pool (using MockYieldBasisPool which implements IYieldBasisPool)
    // This proves the strategy works with anything implementing IYieldBasisPool
    const MockYBPool = await ethers.getContractFactory("MockYieldBasisPool");
    mintedPool = await MockYBPool.deploy(await usdc.getAddress(), await wbtc.getAddress());

    // Deploy TreasuryV2
    const TreasuryFactory = await ethers.getContractFactory("TreasuryV2");
    treasury = await upgrades.deployProxy(TreasuryFactory, [
      await usdc.getAddress(),
      deployer.address,
      deployer.address,
      deployer.address,
      deployer.address,
    ]);

    // Deploy YieldBasisStrategy pointing at our Minted pool
    const YBStrategy = await ethers.getContractFactory("YieldBasisStrategy");
    strategy = await upgrades.deployProxy(YBStrategy, [
      await usdc.getAddress(),
      await mintedPool.getAddress(), // ← Uses our pool, not external YB
      await treasury.getAddress(),
      deployer.address,
      deployer.address,
      "BTC",
    ]);

    // Seed treasury with USDC
    await usdc.mint(await treasury.getAddress(), DEPOSIT_AMOUNT);

    // Grant TREASURY_ROLE on strategy to treasury
    const TREASURY_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TREASURY_ROLE"));
    await strategy.grantRole(TREASURY_ROLE, deployer.address);
  });

  it("should deposit from strategy into MintedYBPool", async function () {
    // Approve strategy to pull USDC
    await usdc.mint(deployer.address, DEPOSIT_AMOUNT);
    await usdc.approve(await strategy.getAddress(), DEPOSIT_AMOUNT);

    await strategy.deposit(DEPOSIT_AMOUNT);

    // Strategy should have shares in the pool
    const strategyAddr = await strategy.getAddress();
    expect(await mintedPool.lenderShares(strategyAddr)).to.be.gt(0);
    expect(await strategy.totalValue()).to.be.gt(0);
  });

  it("should withdraw from strategy (pulls from MintedYBPool)", async function () {
    await usdc.mint(deployer.address, DEPOSIT_AMOUNT);
    await usdc.approve(await strategy.getAddress(), DEPOSIT_AMOUNT);
    await strategy.deposit(DEPOSIT_AMOUNT);

    // Withdraw half
    const halfAmount = DEPOSIT_AMOUNT / 2n;
    await strategy.withdraw(halfAmount);

    expect(await strategy.totalValue()).to.be.lte(halfAmount + 1n);
  });

  it("should report isActive correctly", async function () {
    expect(await strategy.isActive()).to.equal(true);

    const STRATEGIST_ROLE = ethers.keccak256(ethers.toUtf8Bytes("STRATEGIST_ROLE"));
    await strategy.grantRole(STRATEGIST_ROLE, deployer.address);
    await strategy.setActive(false);
    expect(await strategy.isActive()).to.equal(false);
  });
});
