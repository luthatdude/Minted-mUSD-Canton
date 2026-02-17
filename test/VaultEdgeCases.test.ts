/**
 * Vault Edge-Case Test Suite
 *
 * Covers identified testing gaps:
 *   1. Multi-collateral liquidation (WETH + WBTC, choose seizure token)
 *   2. Bad debt / insolvency (seized collateral < debt owed)
 *   3. SMUSD donation attack resistance (decimalsOffset=3 proof)
 *   4. Bad-debt socialization — sMUSD-holder impact
 *
 * Note: LeverageVault swap-revert coverage lives in LeverageVault.test.ts
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  timelockSetFeed,
  timelockAddCollateral,
  timelockSetCloseFactor,
  timelockSetFullLiquidationThreshold,
  timelockSetInterestRate,
  timelockSetSMUSD,
  refreshFeeds,
} from "./helpers/timelock";

// ============================================================
//  1. MULTI-COLLATERAL LIQUIDATION
// ============================================================

describe("VaultEdgeCases: Multi-Collateral Liquidation", function () {
  async function deployMultiCollateralFixture() {
    const [owner, user1, liquidator] = await ethers.getSigners();

    // Deploy two collateral tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);
    const wbtc = await MockERC20.deploy("Wrapped Bitcoin", "WBTC", 8);

    // Deploy MUSD
    const MUSD = await ethers.getContractFactory("MUSD");
    const musd = await MUSD.deploy(ethers.parseEther("100000000"), ethers.ZeroAddress);

    // Deploy PriceOracle + feeds
    const PriceOracle = await ethers.getContractFactory("PriceOracle");
    const priceOracle = await PriceOracle.deploy();

    const MockAggregator = await ethers.getContractFactory("MockAggregatorV3");
    const ethFeed = await MockAggregator.deploy(8, 200000000000n); // $2000
    const btcFeed = await MockAggregator.deploy(8, 4000000000000n); // $40000

    await priceOracle.setFeed(await weth.getAddress(), await ethFeed.getAddress(), 3600, 18, 0);
    await priceOracle.setFeed(await wbtc.getAddress(), await btcFeed.getAddress(), 3600, 8, 0);

    // Deploy CollateralVault
    const CollateralVault = await ethers.getContractFactory("CollateralVault");
    const collateralVault = await CollateralVault.deploy(ethers.ZeroAddress);

    // Add WETH: 75% LTV, 80% liqThreshold, 10% penalty
    await collateralVault.addCollateral(await weth.getAddress(), 7500, 8000, 1000);
    // Add WBTC: 70% LTV, 75% liqThreshold, 15% penalty
    await collateralVault.addCollateral(await wbtc.getAddress(), 7000, 7500, 1500);

    // Deploy BorrowModule
    const BorrowModule = await ethers.getContractFactory("BorrowModule");
    const borrowModule = await BorrowModule.deploy(
      await collateralVault.getAddress(),
      await priceOracle.getAddress(),
      await musd.getAddress(),
      500,
      ethers.parseEther("100")
    );

    // Deploy LiquidationEngine
    const LiquidationEngine = await ethers.getContractFactory("LiquidationEngine");
    const liquidationEngine = await LiquidationEngine.deploy(
      await collateralVault.getAddress(),
      await borrowModule.getAddress(),
      await priceOracle.getAddress(),
      await musd.getAddress(),
      5000,
      owner.address
    );

    // Grant roles
    const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
    await musd.grantRole(BRIDGE_ROLE, await borrowModule.getAddress());
    await musd.grantRole(BRIDGE_ROLE, await liquidationEngine.getAddress());
    await musd.grantRole(BRIDGE_ROLE, owner.address);

    await collateralVault.grantRole(await collateralVault.BORROW_MODULE_ROLE(), await borrowModule.getAddress());
    await collateralVault.grantRole(await collateralVault.LIQUIDATION_ROLE(), await liquidationEngine.getAddress());
    await borrowModule.grantRole(await borrowModule.LIQUIDATION_ROLE(), await liquidationEngine.getAddress());

    // Set BorrowModule on CollateralVault for health checks
    await collateralVault.setBorrowModule(await borrowModule.getAddress());

    // Fund users
    await weth.mint(user1.address, ethers.parseEther("100"));
    await wbtc.mint(user1.address, 500000000n); // 5 WBTC (8 decimals)
    await musd.mint(liquidator.address, ethers.parseEther("500000"));

    // User approvals
    await weth.connect(user1).approve(await collateralVault.getAddress(), ethers.MaxUint256);
    await wbtc.connect(user1).approve(await collateralVault.getAddress(), ethers.MaxUint256);
    await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), ethers.MaxUint256);

    return {
      owner, user1, liquidator,
      weth, wbtc, musd, priceOracle,
      ethFeed, btcFeed,
      collateralVault, borrowModule, liquidationEngine,
    };
  }

  it("should liquidate WETH collateral when user has both WETH and WBTC", async function () {
    const f = await loadFixture(deployMultiCollateralFixture);

    // User deposits both collaterals
    await f.collateralVault.connect(f.user1).deposit(await f.weth.getAddress(), ethers.parseEther("10")); // 10 WETH = $20,000
    await f.collateralVault.connect(f.user1).deposit(await f.wbtc.getAddress(), 100000000n); // 1 WBTC = $40,000

    // Borrow near max: total collateral value = $60k, weighted threshold ~$46k
    await f.borrowModule.connect(f.user1).borrow(ethers.parseEther("40000"));

    // Crash ETH price to $500 (from $2000)
    await f.ethFeed.setAnswer(50000000000n);
    await refreshFeeds(f.btcFeed);

    // Now: WETH = $5k, WBTC = $40k, weighted = $5k*0.8 + $40k*0.75 = $34k, debt = $40k → HF < 1
    expect(await f.liquidationEngine.isLiquidatable(f.user1.address)).to.be.true;

    // Liquidator chooses to seize WETH
    const wethBefore = await f.weth.balanceOf(f.liquidator.address);
    await f.liquidationEngine.connect(f.liquidator).liquidate(
      f.user1.address,
      await f.weth.getAddress(),
      ethers.parseEther("4000") // repay 4000 mUSD, seize WETH
    );
    const wethAfter = await f.weth.balanceOf(f.liquidator.address);

    // Liquidator received WETH (with 10% penalty bonus)
    expect(wethAfter).to.be.gt(wethBefore);

    // WBTC collateral untouched
    expect(await f.collateralVault.deposits(f.user1.address, await f.wbtc.getAddress())).to.equal(100000000n);
  });

  it("should liquidate WBTC collateral when liquidator chooses WBTC", async function () {
    const f = await loadFixture(deployMultiCollateralFixture);

    await f.collateralVault.connect(f.user1).deposit(await f.weth.getAddress(), ethers.parseEther("10"));
    await f.collateralVault.connect(f.user1).deposit(await f.wbtc.getAddress(), 100000000n);
    await f.borrowModule.connect(f.user1).borrow(ethers.parseEther("40000"));

    // Crash BTC price to $10,000
    await f.btcFeed.setAnswer(1000000000000n);
    await refreshFeeds(f.ethFeed);

    expect(await f.liquidationEngine.isLiquidatable(f.user1.address)).to.be.true;

    const wbtcBefore = await f.wbtc.balanceOf(f.liquidator.address);
    await f.liquidationEngine.connect(f.liquidator).liquidate(
      f.user1.address,
      await f.wbtc.getAddress(),
      ethers.parseEther("5000")
    );
    const wbtcAfter = await f.wbtc.balanceOf(f.liquidator.address);

    // Liquidator received WBTC (with 15% penalty bonus)
    expect(wbtcAfter).to.be.gt(wbtcBefore);

    // WETH collateral untouched
    expect(await f.collateralVault.deposits(f.user1.address, await f.weth.getAddress())).to.equal(ethers.parseEther("10"));
  });

  it("should apply correct per-token penalty (10% WETH vs 15% WBTC)", async function () {
    const f = await loadFixture(deployMultiCollateralFixture);

    await f.collateralVault.connect(f.user1).deposit(await f.weth.getAddress(), ethers.parseEther("10"));
    await f.collateralVault.connect(f.user1).deposit(await f.wbtc.getAddress(), 100000000n);
    await f.borrowModule.connect(f.user1).borrow(ethers.parseEther("30000"));

    // Crash both prices
    await f.ethFeed.setAnswer(50000000000n); // ETH → $500
    await f.btcFeed.setAnswer(1000000000000n); // BTC → $10,000

    // Liquidate via WETH (10% penalty)
    const wethEstimate = await f.liquidationEngine.estimateSeize(
      f.user1.address, await f.weth.getAddress(), ethers.parseEther("1000")
    );
    // Liquidate via WBTC (15% penalty)
    const wbtcEstimate = await f.liquidationEngine.estimateSeize(
      f.user1.address, await f.wbtc.getAddress(), ethers.parseEther("1000")
    );

    // WBTC seizure should be more valuable due to higher penalty
    // For same $1000 repay: WETH seize = $1100 worth, WBTC seize = $1150 worth
    const wethSeizeValue = (wethEstimate * 50000000000n) / (10n ** 18n); // price * amount / decimals
    const wbtcSeizeValue = (wbtcEstimate * 1000000000000n) / (10n ** 8n);
    // WBTC penalty (15%) > WETH penalty (10%)
    expect(wbtcSeizeValue).to.be.gt(wethSeizeValue);
  });
});

// ============================================================
//  2. BAD DEBT / INSOLVENCY
// ============================================================

describe("VaultEdgeCases: Bad Debt & Insolvency", function () {
  async function deployBadDebtFixture() {
    const [owner, user1, user2, liquidator] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);

    const MUSD = await ethers.getContractFactory("MUSD");
    const musd = await MUSD.deploy(ethers.parseEther("100000000"), ethers.ZeroAddress);

    const PriceOracle = await ethers.getContractFactory("PriceOracle");
    const priceOracle = await PriceOracle.deploy();

    const MockAggregator = await ethers.getContractFactory("MockAggregatorV3");
    const ethFeed = await MockAggregator.deploy(8, 200000000000n);

    await priceOracle.setFeed(await weth.getAddress(), await ethFeed.getAddress(), 3600, 18, 0);

    const CollateralVault = await ethers.getContractFactory("CollateralVault");
    const collateralVault = await CollateralVault.deploy(ethers.ZeroAddress);
    await collateralVault.addCollateral(await weth.getAddress(), 7500, 8000, 1000);

    const BorrowModule = await ethers.getContractFactory("BorrowModule");
    const borrowModule = await BorrowModule.deploy(
      await collateralVault.getAddress(),
      await priceOracle.getAddress(),
      await musd.getAddress(),
      500,
      ethers.parseEther("100")
    );

    const LiquidationEngine = await ethers.getContractFactory("LiquidationEngine");
    const liquidationEngine = await LiquidationEngine.deploy(
      await collateralVault.getAddress(),
      await borrowModule.getAddress(),
      await priceOracle.getAddress(),
      await musd.getAddress(),
      5000,
      owner.address
    );

    const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
    await musd.grantRole(BRIDGE_ROLE, await borrowModule.getAddress());
    await musd.grantRole(BRIDGE_ROLE, await liquidationEngine.getAddress());
    await musd.grantRole(BRIDGE_ROLE, owner.address);
    await collateralVault.grantRole(await collateralVault.BORROW_MODULE_ROLE(), await borrowModule.getAddress());
    await collateralVault.grantRole(await collateralVault.LIQUIDATION_ROLE(), await liquidationEngine.getAddress());
    await borrowModule.grantRole(await borrowModule.LIQUIDATION_ROLE(), await liquidationEngine.getAddress());
    await collateralVault.setBorrowModule(await borrowModule.getAddress());

    // Grant TIMELOCK_ROLEs for admin setters in tests
    const LIQ_TIMELOCK_ROLE = await liquidationEngine.TIMELOCK_ROLE();
    await liquidationEngine.grantRole(LIQ_TIMELOCK_ROLE, owner.address);
    const BORROW_TIMELOCK_ROLE = await borrowModule.TIMELOCK_ROLE();
    await borrowModule.grantRole(BORROW_TIMELOCK_ROLE, owner.address);

    await weth.mint(user1.address, ethers.parseEther("10"));
    await weth.mint(user2.address, ethers.parseEther("100"));
    await musd.mint(liquidator.address, ethers.parseEther("500000"));
    await weth.connect(user1).approve(await collateralVault.getAddress(), ethers.MaxUint256);
    await weth.connect(user2).approve(await collateralVault.getAddress(), ethers.MaxUint256);
    await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), ethers.MaxUint256);

    return {
      owner, user1, user2, liquidator,
      weth, musd, priceOracle, ethFeed,
      collateralVault, borrowModule, liquidationEngine,
    };
  }

  it("should record bad debt when collateral value < debt after price crash", async function () {
    const f = await loadFixture(deployBadDebtFixture);

    // Deposit 5 ETH ($10,000), borrow $7,000
    await f.collateralVault.connect(f.user1).deposit(await f.weth.getAddress(), ethers.parseEther("5"));
    await f.borrowModule.connect(f.user1).borrow(ethers.parseEther("7000"));

    // Enable full liquidation for severely undercollateralized positions
    await timelockSetFullLiquidationThreshold(f.liquidationEngine, f.owner, 5000);

    // Crash ETH to $100 (from $2000) — collateral worth $500, debt $7000
    await f.ethFeed.setAnswer(10000000000n);

    expect(await f.liquidationEngine.isLiquidatable(f.user1.address)).to.be.true;

    const badDebtBefore = await f.liquidationEngine.totalBadDebt();

    // Liquidate — collateral ($500) can't cover debt ($7000)
    await f.liquidationEngine.connect(f.liquidator).liquidate(
      f.user1.address,
      await f.weth.getAddress(),
      ethers.parseEther("7000")
    );

    const badDebtAfter = await f.liquidationEngine.totalBadDebt();

    // Bad debt should have been recorded
    expect(badDebtAfter).to.be.gt(badDebtBefore);
    expect(badDebtAfter).to.be.gt(0);

    // Per-borrower bad debt tracked
    const borrowerBadDebt = await f.liquidationEngine.borrowerBadDebt(f.user1.address);
    expect(borrowerBadDebt).to.be.gt(0);

    // All collateral seized (user has 0 WETH left in vault)
    expect(await f.collateralVault.deposits(f.user1.address, await f.weth.getAddress())).to.equal(0);
  });

  it("should realize socialized bad debt from reserves first, then queue supplier loss", async function () {
    const f = await loadFixture(deployBadDebtFixture);

    // Create protocol reserves first (so socialization has a reserve buffer to use).
    await timelockSetInterestRate(f.borrowModule, f.owner, 5000); // 50% APR
    await f.collateralVault.connect(f.user1).deposit(await f.weth.getAddress(), ethers.parseEther("5"));
    await f.borrowModule.connect(f.user1).borrow(ethers.parseEther("7000"));
    await time.increase(365 * 24 * 60 * 60);
    await f.borrowModule.accrueInterest(f.user1.address);
    // Freeze further accrual so socialization math is deterministic.
    await timelockSetInterestRate(f.borrowModule, f.owner, 0);
    await f.borrowModule.accrueInterest(f.user1.address);

    const reservesBefore = await f.borrowModule.protocolReserves();
    expect(reservesBefore).to.be.gt(0);

    await timelockSetFullLiquidationThreshold(f.liquidationEngine, f.owner, 5000);
    await f.ethFeed.setAnswer(10000000000n); // $100

    await f.liquidationEngine.connect(f.liquidator).liquidate(
      f.user1.address,
      await f.weth.getAddress(),
      ethers.parseEther("7000")
    );

    const recordedBadDebt = await f.liquidationEngine.borrowerBadDebt(f.user1.address);
    expect(recordedBadDebt).to.be.gt(0);

    // Socialize bad debt and realize loss economically.
    await f.liquidationEngine.connect(f.owner).socializeBadDebt(f.user1.address);

    const reserveAbsorbed = reservesBefore > recordedBadDebt ? recordedBadDebt : reservesBefore;
    const queuedForSuppliers = recordedBadDebt - reserveAbsorbed;

    expect(await f.borrowModule.totalBadDebtAbsorbedByReserves()).to.equal(reserveAbsorbed);
    expect(await f.borrowModule.protocolReserves()).to.equal(reservesBefore - reserveAbsorbed);
    expect(await f.borrowModule.badDebtQueuedForSuppliers()).to.equal(queuedForSuppliers);

    // LiquidationEngine accounting cleared.
    expect(await f.liquidationEngine.borrowerBadDebt(f.user1.address)).to.equal(0);
    expect(await f.liquidationEngine.totalBadDebt()).to.equal(0);
  });

  it("should realize queued supplier loss by haircutting future supplier interest", async function () {
    const f = await loadFixture(deployBadDebtFixture);

    // 1) Create bad debt and socialize while reserves are still zero.
    await f.collateralVault.connect(f.user1).deposit(await f.weth.getAddress(), ethers.parseEther("5"));
    await f.borrowModule.connect(f.user1).borrow(ethers.parseEther("7000"));
    await timelockSetFullLiquidationThreshold(f.liquidationEngine, f.owner, 5000);
    await f.ethFeed.setAnswer(10000000000n); // $100

    await f.liquidationEngine.connect(f.liquidator).liquidate(
      f.user1.address,
      await f.weth.getAddress(),
      ethers.parseEther("7000")
    );
    await f.liquidationEngine.connect(f.owner).socializeBadDebt(f.user1.address);

    const queuedBefore = await f.borrowModule.badDebtQueuedForSuppliers();
    expect(queuedBefore).to.be.gt(0);

    // Restore feed to normal so subsequent borrow path doesn't trip circuit breaker.
    await f.ethFeed.setAnswer(200000000000n); // $2000
    await f.priceOracle.updatePrice(await f.weth.getAddress());

    // 2) Wire SMUSD as supplier sink and seed shares.
    const SMUSD = await ethers.getContractFactory("SMUSD");
    const smusd = await SMUSD.deploy(await f.musd.getAddress(), ethers.ZeroAddress);

    await f.musd.connect(f.owner).mint(f.user2.address, ethers.parseEther("50000"));
    await f.musd.connect(f.user2).approve(await smusd.getAddress(), ethers.MaxUint256);
    await smusd.connect(f.user2).deposit(ethers.parseEther("50000"), f.user2.address);

    await smusd.grantRole(await smusd.INTEREST_ROUTER_ROLE(), await f.borrowModule.getAddress());
    await timelockSetSMUSD(f.borrowModule, f.owner, await smusd.getAddress());
    await timelockSetInterestRate(f.borrowModule, f.owner, 500); // 5% APR

    // 3) Open a healthy debt position to generate future interest.
    await f.collateralVault.connect(f.user2).deposit(await f.weth.getAddress(), ethers.parseEther("20"));
    await f.borrowModule.connect(f.user2).borrow(ethers.parseEther("10000"));

    const borrowsBefore = await f.borrowModule.totalBorrows();
    const reservesBefore = await f.borrowModule.protocolReserves();
    const absorbedBefore = await f.borrowModule.totalBadDebtAbsorbedBySuppliers();
    const smusdInterestBefore = await smusd.totalInterestReceived();

    await time.increase(30 * 24 * 60 * 60);
    await f.borrowModule.accrueInterest(f.user2.address);

    const borrowsAfter = await f.borrowModule.totalBorrows();
    const reservesAfter = await f.borrowModule.protocolReserves();
    const absorbedAfter = await f.borrowModule.totalBadDebtAbsorbedBySuppliers();
    const smusdInterestAfter = await smusd.totalInterestReceived();
    const queuedAfter = await f.borrowModule.badDebtQueuedForSuppliers();

    const interestAccrued = borrowsAfter - borrowsBefore;
    const reserveIncrease = reservesAfter - reservesBefore;
    const grossSupplierInterest = interestAccrued - reserveIncrease;
    const supplierAbsorbed = absorbedAfter - absorbedBefore;
    const routedToSuppliers = smusdInterestAfter - smusdInterestBefore;

    expect(supplierAbsorbed).to.be.gt(0);
    const queuedRealization = queuedBefore - queuedAfter;
    const realizationDrift =
      supplierAbsorbed > queuedRealization
        ? supplierAbsorbed - queuedRealization
        : queuedRealization - supplierAbsorbed;
    expect(realizationDrift).to.be.lte(1_000_000n);
    const reconciledSupplierFlow = routedToSuppliers + supplierAbsorbed;
    const drift =
      reconciledSupplierFlow > grossSupplierInterest
        ? reconciledSupplierFlow - grossSupplierInterest
        : grossSupplierInterest - reconciledSupplierFlow;
    // Tiny rounding drift is acceptable across split + accrual math paths.
    expect(drift).to.be.lte(1_000_000n);
  });

  it("should reject socializeBadDebt from non-timelock address", async function () {
    const f = await loadFixture(deployBadDebtFixture);

    await expect(
      f.liquidationEngine.connect(f.liquidator).socializeBadDebt(f.user1.address)
    ).to.be.reverted;
  });
});

// ============================================================
//  3. SMUSD DONATION ATTACK RESISTANCE
// ============================================================

describe("VaultEdgeCases: SMUSD Donation Attack", function () {
  async function deploySMUSDFixture() {
    const [deployer, bridge, yieldManager, user1, attacker] = await ethers.getSigners();

    const MUSDFactory = await ethers.getContractFactory("MUSD");
    const musd = await MUSDFactory.deploy(ethers.parseEther("100000000"), ethers.ZeroAddress);

    const SMUSDFactory = await ethers.getContractFactory("SMUSD");
    const smusd = await SMUSDFactory.deploy(await musd.getAddress(), ethers.ZeroAddress);

    await musd.grantRole(await musd.BRIDGE_ROLE(), bridge.address);
    await smusd.grantRole(await smusd.YIELD_MANAGER_ROLE(), yieldManager.address);

    // Fund users
    await musd.connect(bridge).mint(user1.address, ethers.parseEther("10000"));
    await musd.connect(bridge).mint(attacker.address, ethers.parseEther("100000"));
    await musd.connect(bridge).mint(yieldManager.address, ethers.parseEther("100000"));

    await musd.connect(user1).approve(await smusd.getAddress(), ethers.MaxUint256);
    await musd.connect(attacker).approve(await smusd.getAddress(), ethers.MaxUint256);
    await musd.connect(yieldManager).approve(await smusd.getAddress(), ethers.MaxUint256);

    return { deployer, bridge, yieldManager, user1, attacker, musd, smusd };
  }

  it("should resist donation attack via decimalsOffset=3", async function () {
    const f = await loadFixture(deploySMUSDFixture);

    // User1 deposits 1000 mUSD (gets shares)
    await f.smusd.connect(f.user1).deposit(ethers.parseEther("1000"), f.user1.address);
    const sharesBefore = await f.smusd.balanceOf(f.user1.address);
    expect(sharesBefore).to.be.gt(0);

    // Record share price before attack
    const assetsBefore = await f.smusd.convertToAssets(sharesBefore);

    // Attacker donates mUSD directly to vault (without deposit)
    await f.musd.connect(f.attacker).transfer(await f.smusd.getAddress(), ethers.parseEther("50000"));

    // Share price should NOT spike dramatically due to decimalsOffset=3
    // The virtual shares (1000) absorb the donation proportionally
    const assetsAfter = await f.smusd.convertToAssets(sharesBefore);

    // User1's shares still worth approximately what they deposited
    // The donated mUSD is shared across all shares (including virtual)
    // so the attacker can't profit by front-running
    expect(assetsAfter).to.be.gte(assetsBefore);

    // The donation should not make new depositors get 0 shares
    const newShares = await f.smusd.previewDeposit(ethers.parseEther("1000"));
    expect(newShares).to.be.gt(0);
  });

  it("should prevent first-depositor share manipulation", async function () {
    const f = await loadFixture(deploySMUSDFixture);

    // Attacker is the first depositor with minimal amount
    await f.smusd.connect(f.attacker).deposit(ethers.parseEther("1"), f.attacker.address);

    // Attacker donates large amount directly to inflate share price
    await f.musd.connect(f.attacker).transfer(await f.smusd.getAddress(), ethers.parseEther("10000"));

    // User1 deposits — should NOT get 0 shares due to virtual offset
    const shares = await f.smusd.previewDeposit(ethers.parseEther("1000"));
    expect(shares).to.be.gt(0);

    // Actually deposit and verify
    await f.smusd.connect(f.user1).deposit(ethers.parseEther("1000"), f.user1.address);
    const userShares = await f.smusd.balanceOf(f.user1.address);
    expect(userShares).to.be.gt(0);
  });

  it("should enforce 24h cooldown blocking immediate withdrawal after deposit", async function () {
    const f = await loadFixture(deploySMUSDFixture);

    await f.smusd.connect(f.user1).deposit(ethers.parseEther("1000"), f.user1.address);
    const shares = await f.smusd.balanceOf(f.user1.address);

    // Immediate withdrawal should fail (24h cooldown)
    await expect(
      f.smusd.connect(f.user1).redeem(shares, f.user1.address, f.user1.address)
    ).to.be.reverted;

    // Advance 24 hours + 1 second
    await time.increase(24 * 60 * 60 + 1);

    // Now withdrawal should succeed
    await expect(
      f.smusd.connect(f.user1).redeem(shares, f.user1.address, f.user1.address)
    ).to.not.be.reverted;
  });

  // ── Stronger donation-attack assertions (Codex Gap 2) ──────────

  it("attacker should NOT profit from front-running donation attack", async function () {
    const f = await loadFixture(deploySMUSDFixture);

    const attackerDeposit = 1n; // 1 wei
    const donationAmount = ethers.parseEther("10000");
    const victimDeposit = ethers.parseEther("10000");

    // Attacker deposits 1 wei to get shares
    await f.smusd.connect(f.attacker).deposit(attackerDeposit, f.attacker.address);
    const attackerShares = await f.smusd.balanceOf(f.attacker.address);
    expect(attackerShares).to.be.gt(0);

    // Attacker donates directly to vault (bypasses deposit)
    await f.musd.connect(f.attacker).transfer(await f.smusd.getAddress(), donationAmount);

    // Victim deposits
    await f.smusd.connect(f.user1).deposit(victimDeposit, f.user1.address);
    const victimShares = await f.smusd.balanceOf(f.user1.address);
    expect(victimShares).to.be.gt(0, "Victim received 0 shares — donation attack succeeded");

    // CRITICAL: Attacker's redeemable value <= total cost (deposit + donation)
    const attackerRedeemable = await f.smusd.convertToAssets(attackerShares);
    const attackerTotalCost = attackerDeposit + donationAmount;
    expect(attackerRedeemable).to.be.lte(
      attackerTotalCost,
      "Attacker profited from donation attack"
    );

    // Attacker has a net loss
    const attackerNetLoss = attackerTotalCost - attackerRedeemable;
    expect(attackerNetLoss).to.be.gt(0, "Attacker did not lose money");
  });

  it("victim loss from donation attack should be bounded by decimalsOffset", async function () {
    const f = await loadFixture(deploySMUSDFixture);

    const attackerDeposit = 1n;
    const donationAmount = ethers.parseEther("5000");
    const victimDeposit = ethers.parseEther("5000");

    // Attacker deposits + donates
    await f.smusd.connect(f.attacker).deposit(attackerDeposit, f.attacker.address);
    await f.musd.connect(f.attacker).transfer(await f.smusd.getAddress(), donationAmount);

    // Victim deposits
    await f.smusd.connect(f.user1).deposit(victimDeposit, f.user1.address);
    const victimShares = await f.smusd.balanceOf(f.user1.address);
    expect(victimShares).to.be.gt(0);

    // Check victim's redeemable value vs deposit
    const victimRedeemable = await f.smusd.convertToAssets(victimShares);
    const victimLoss = victimDeposit - victimRedeemable;

    // With decimalsOffset=3, victim loss should be < 1% of deposit
    const maxAcceptableLoss = victimDeposit / 100n;
    expect(victimLoss).to.be.lte(
      maxAcceptableLoss,
      `Victim lost ${ethers.formatEther(victimLoss)} mUSD (>${ethers.formatEther(maxAcceptableLoss)} max acceptable)`
    );
  });

  it("share price distortion from donation should be bounded and proportional", async function () {
    const f = await loadFixture(deploySMUSDFixture);

    // Establish normal share price with legitimate deposit
    await f.smusd.connect(f.user1).deposit(ethers.parseEther("1000"), f.user1.address);
    const priceBefore = await f.smusd.convertToAssets(10n ** 21n); // 1000 shares

    // Attacker donates equal amount directly
    await f.musd.connect(f.attacker).transfer(await f.smusd.getAddress(), ethers.parseEther("1000"));
    const priceAfter = await f.smusd.convertToAssets(10n ** 21n);

    // Price increases (donation adds assets without shares)
    expect(priceAfter).to.be.gt(priceBefore);

    // Distortion should be proportional (~100% when donation = existing assets), not unbounded
    const distortionBps = ((priceAfter - priceBefore) * 10000n) / priceBefore;
    expect(distortionBps).to.be.lte(10100n, "Share price distortion > 101% — unbounded");
    expect(distortionBps).to.be.gte(9900n, "Share price should approximately double");
  });

  it("donation attack is economically irrational across multiple donation sizes", async function () {
    const f = await loadFixture(deploySMUSDFixture);

    // Test across 3 donation sizes — attacker always loses
    const donations = [
      ethers.parseEther("100"),
      ethers.parseEther("1000"),
      ethers.parseEther("10000"),
    ];

    for (const donation of donations) {
      const SMUSDFactory = await ethers.getContractFactory("SMUSD");
      const freshVault = await SMUSDFactory.deploy(await f.musd.getAddress(), ethers.ZeroAddress);

      // Mint fresh balances for each iteration to avoid exhaustion
      await f.musd.connect(f.bridge).mint(f.attacker.address, donation + 1n);
      await f.musd.connect(f.bridge).mint(f.user1.address, donation);

      await f.musd.connect(f.attacker).approve(await freshVault.getAddress(), ethers.MaxUint256);
      await f.musd.connect(f.user1).approve(await freshVault.getAddress(), ethers.MaxUint256);

      // Attacker: deposit 1 wei + donate
      await freshVault.connect(f.attacker).deposit(1n, f.attacker.address);
      const attackerShares = await freshVault.balanceOf(f.attacker.address);
      await f.musd.connect(f.attacker).transfer(await freshVault.getAddress(), donation);

      // Victim deposits same amount
      await freshVault.connect(f.user1).deposit(donation, f.user1.address);

      // Attacker always has negative P&L
      const attackerRedeemable = await freshVault.convertToAssets(attackerShares);
      const attackerCost = 1n + donation;
      expect(attackerRedeemable).to.be.lt(
        attackerCost,
        `Attacker profited with donation=${ethers.formatEther(donation)}`
      );
    }
  });
});

// ============================================================
//  4. BAD-DEBT SOCIALIZATION — sMUSD-HOLDER IMPACT (Codex Gap 3)
// ============================================================

describe("VaultEdgeCases: sMUSD-Holder Bad-Debt Impact", function () {
  async function deployBadDebtImpactFixture() {
    const [owner, borrower, liquidator, staker1, staker2] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);

    const MUSD = await ethers.getContractFactory("MUSD");
    const musd = await MUSD.deploy(ethers.parseEther("100000000"), ethers.ZeroAddress);

    const PriceOracle = await ethers.getContractFactory("PriceOracle");
    const priceOracle = await PriceOracle.deploy();

    const MockAggregator = await ethers.getContractFactory("MockAggregatorV3");
    const ethFeed = await MockAggregator.deploy(8, 200000000000n); // $2000

    await priceOracle.setFeed(await weth.getAddress(), await ethFeed.getAddress(), 3600, 18, 0);

    const CollateralVault = await ethers.getContractFactory("CollateralVault");
    const collateralVault = await CollateralVault.deploy(ethers.ZeroAddress);
    await collateralVault.addCollateral(await weth.getAddress(), 7500, 8000, 1000);

    const BorrowModule = await ethers.getContractFactory("BorrowModule");
    const borrowModule = await BorrowModule.deploy(
      await collateralVault.getAddress(),
      await priceOracle.getAddress(),
      await musd.getAddress(),
      500,
      ethers.parseEther("100")
    );

    const SMUSD = await ethers.getContractFactory("SMUSD");
    const smusd = await SMUSD.deploy(await musd.getAddress(), ethers.ZeroAddress);

    const LiquidationEngine = await ethers.getContractFactory("LiquidationEngine");
    const liquidationEngine = await LiquidationEngine.deploy(
      await collateralVault.getAddress(),
      await borrowModule.getAddress(),
      await priceOracle.getAddress(),
      await musd.getAddress(),
      5000,
      owner.address
    );

    // Grant roles
    const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
    await musd.grantRole(BRIDGE_ROLE, await borrowModule.getAddress());
    await musd.grantRole(BRIDGE_ROLE, await liquidationEngine.getAddress());
    await musd.grantRole(BRIDGE_ROLE, owner.address);
    await collateralVault.grantRole(await collateralVault.BORROW_MODULE_ROLE(), await borrowModule.getAddress());
    await collateralVault.grantRole(await collateralVault.LIQUIDATION_ROLE(), await liquidationEngine.getAddress());
    await borrowModule.grantRole(await borrowModule.LIQUIDATION_ROLE(), await liquidationEngine.getAddress());
    await collateralVault.setBorrowModule(await borrowModule.getAddress());

    // Grant TIMELOCK roles
    const LIQ_TIMELOCK = await liquidationEngine.TIMELOCK_ROLE();
    await liquidationEngine.grantRole(LIQ_TIMELOCK, owner.address);
    const BM_TIMELOCK = await borrowModule.TIMELOCK_ROLE();
    await borrowModule.grantRole(BM_TIMELOCK, owner.address);

    // Wire SMUSD for interest routing
    await smusd.grantRole(await smusd.INTEREST_ROUTER_ROLE(), await borrowModule.getAddress());
    await borrowModule.setSMUSD(await smusd.getAddress());

    // Enable full liquidation for extreme scenarios
    await liquidationEngine.setFullLiquidationThreshold(5000);

    // Fund participants
    await weth.mint(borrower.address, ethers.parseEther("100"));
    await weth.connect(borrower).approve(await collateralVault.getAddress(), ethers.MaxUint256);
    await musd.mint(liquidator.address, ethers.parseEther("1000000"));
    await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), ethers.MaxUint256);
    await musd.mint(staker1.address, ethers.parseEther("100000"));
    await musd.mint(staker2.address, ethers.parseEther("100000"));
    await musd.connect(staker1).approve(await smusd.getAddress(), ethers.MaxUint256);
    await musd.connect(staker2).approve(await smusd.getAddress(), ethers.MaxUint256);

    return {
      owner, borrower, liquidator, staker1, staker2,
      weth, musd, priceOracle, ethFeed,
      collateralVault, borrowModule, liquidationEngine, smusd,
    };
  }

  it("bad debt socialization reduces totalBorrows, lowering future interest to sMUSD stakers", async function () {
    const f = await deployBadDebtImpactFixture();

    // Staker deposits into SMUSD
    await f.smusd.connect(f.staker1).deposit(ethers.parseEther("50000"), f.staker1.address);
    expect(await f.smusd.balanceOf(f.staker1.address)).to.be.gt(0);

    // Borrower creates a large position
    await f.collateralVault.connect(f.borrower).deposit(await f.weth.getAddress(), ethers.parseEther("50"));
    await f.borrowModule.connect(f.borrower).borrow(ethers.parseEther("50000"));

    const totalBorrowsBefore = await f.borrowModule.totalBorrows();
    expect(totalBorrowsBefore).to.be.gt(0);

    // Crash price → liquidate → create bad debt
    await f.ethFeed.setAnswer(10000000000n); // $100

    const fullDebt = await f.borrowModule.totalDebt(f.borrower.address);
    await f.liquidationEngine.connect(f.liquidator).liquidate(
      f.borrower.address,
      await f.weth.getAddress(),
      fullDebt
    );

    const badDebt = await f.liquidationEngine.borrowerBadDebt(f.borrower.address);
    expect(badDebt).to.be.gt(0);

    // Record totalBorrows before socialization
    const totalBorrowsPreSocialize = await f.borrowModule.totalBorrows();

    // Socialize the bad debt
    await f.liquidationEngine.connect(f.owner).socializeBadDebt(f.borrower.address);

    // CRITICAL: totalBorrows decreased
    const totalBorrowsAfterSocialize = await f.borrowModule.totalBorrows();
    expect(totalBorrowsAfterSocialize).to.be.lt(
      totalBorrowsPreSocialize,
      "totalBorrows did not decrease after bad debt socialization"
    );

    // The reduction means lower utilization → less interest → less yield for sMUSD holders
    // This IS the socialization: bad debt absorbed through reduced future yield
  });

  it("sMUSD share price is not directly decreased but future yield is impaired", async function () {
    const f = await deployBadDebtImpactFixture();

    // Staker deposits
    await f.smusd.connect(f.staker1).deposit(ethers.parseEther("10000"), f.staker1.address);

    // Borrower creates position
    await f.collateralVault.connect(f.borrower).deposit(await f.weth.getAddress(), ethers.parseEther("10"));
    await f.borrowModule.connect(f.borrower).borrow(ethers.parseEther("10000"));

    // Crash → liquidate → bad debt
    await f.ethFeed.setAnswer(10000000000n); // $100
    const debt = await f.borrowModule.totalDebt(f.borrower.address);
    await f.liquidationEngine.connect(f.liquidator).liquidate(
      f.borrower.address, await f.weth.getAddress(), debt
    );
    expect(await f.liquidationEngine.borrowerBadDebt(f.borrower.address)).to.be.gt(0);

    // Record share price BEFORE socialization
    const sharePriceBefore = await f.smusd.convertToAssets(ethers.parseEther("1"));

    // Socialize
    await f.liquidationEngine.connect(f.owner).socializeBadDebt(f.borrower.address);

    // Share price NOT directly decreased
    const sharePriceAfter = await f.smusd.convertToAssets(ethers.parseEther("1"));
    expect(sharePriceAfter).to.be.gte(
      sharePriceBefore,
      "Share price decreased directly from socialization"
    );

    // But totalBorrows dropped → future interest will be lower
    const totalBorrowsAfter = await f.borrowModule.totalBorrows();

    // If all debt was socialized, no future interest accrues → zero yield
    if (totalBorrowsAfter === 0n) {
      await time.increase(365 * 24 * 3600);
      const priceOneYearLater = await f.smusd.convertToAssets(ethers.parseEther("1"));
      expect(priceOneYearLater).to.equal(sharePriceAfter);
    }
  });

  it("bad debt impact is shared proportionally across all sMUSD stakers", async function () {
    const f = await deployBadDebtImpactFixture();

    // Two stakers deposit equal amounts
    await f.smusd.connect(f.staker1).deposit(ethers.parseEther("25000"), f.staker1.address);
    await f.smusd.connect(f.staker2).deposit(ethers.parseEther("25000"), f.staker2.address);

    const shares1 = await f.smusd.balanceOf(f.staker1.address);
    const shares2 = await f.smusd.balanceOf(f.staker2.address);
    expect(shares1).to.equal(shares2); // Equal deposits → equal shares

    // Create borrowing → crash → bad debt → socialize
    await f.collateralVault.connect(f.borrower).deposit(await f.weth.getAddress(), ethers.parseEther("10"));
    await f.borrowModule.connect(f.borrower).borrow(ethers.parseEther("10000"));

    await f.ethFeed.setAnswer(10000000000n); // $100
    const debt = await f.borrowModule.totalDebt(f.borrower.address);
    await f.liquidationEngine.connect(f.liquidator).liquidate(
      f.borrower.address, await f.weth.getAddress(), debt
    );
    await f.liquidationEngine.connect(f.owner).socializeBadDebt(f.borrower.address);

    // Both stakers have identical redeemable (proportional impact)
    const redeemable1 = await f.smusd.convertToAssets(shares1);
    const redeemable2 = await f.smusd.convertToAssets(shares2);
    expect(redeemable1).to.equal(redeemable2);
  });

  it("absorbBadDebt uses reserves first before queuing supplier haircut", async function () {
    const f = await deployBadDebtImpactFixture();

    // Generate protocol reserves via interest
    await timelockSetInterestRate(f.borrowModule, f.owner, 5000); // 50% APR
    await f.collateralVault.connect(f.borrower).deposit(await f.weth.getAddress(), ethers.parseEther("10"));
    await f.borrowModule.connect(f.borrower).borrow(ethers.parseEther("10000"));

    // Staker deposits to enable interest routing
    await f.smusd.connect(f.staker1).deposit(ethers.parseEther("50000"), f.staker1.address);

    await time.increase(180 * 24 * 3600); // 6 months → accrue reserves
    await f.borrowModule.accrueInterest(f.borrower.address);

    const reservesBefore = await f.borrowModule.protocolReserves();
    expect(reservesBefore).to.be.gt(0, "No reserves accrued for test");

    // Freeze interest to make math deterministic
    await timelockSetInterestRate(f.borrowModule, f.owner, 0);
    await f.borrowModule.accrueInterest(f.borrower.address);

    // Crash → liquidate → bad debt
    await f.ethFeed.setAnswer(10000000000n);
    const debt = await f.borrowModule.totalDebt(f.borrower.address);
    await f.liquidationEngine.connect(f.liquidator).liquidate(
      f.borrower.address, await f.weth.getAddress(), debt
    );

    const recordedBadDebt = await f.liquidationEngine.borrowerBadDebt(f.borrower.address);
    expect(recordedBadDebt).to.be.gt(0);

    const reservesPreSocialize = await f.borrowModule.protocolReserves();

    // Socialize
    await f.liquidationEngine.connect(f.owner).socializeBadDebt(f.borrower.address);

    // Reserves should be consumed first
    const reservesAfter = await f.borrowModule.protocolReserves();
    const absorbedByReserves = await f.borrowModule.totalBadDebtAbsorbedByReserves();

    if (reservesPreSocialize >= recordedBadDebt) {
      // Reserves fully covered bad debt — no supplier queue
      expect(absorbedByReserves).to.be.gte(recordedBadDebt);
      expect(await f.borrowModule.badDebtQueuedForSuppliers()).to.equal(0);
    } else {
      // Reserves partially covered — residual queued for suppliers
      expect(absorbedByReserves).to.equal(reservesPreSocialize);
      expect(reservesAfter).to.equal(0);
      expect(await f.borrowModule.badDebtQueuedForSuppliers()).to.be.gt(0);
    }
  });
});
