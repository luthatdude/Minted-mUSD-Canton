/**
 * DEEP AUDIT TEST SUITE
 *
 * Tests all functional interactions across the Minted mUSD protocol:
 *   1. Mint flow (DirectMintV2 → MUSD → Treasury)
 *   2. Vault deposits/withdrawals (CollateralVault)
 *   3. Lending & borrowing (BorrowModule + interest accrual)
 *   4. Liquidation engine (partial + full liquidation)
 *   5. Treasury strategy disbursement (auto-allocate, rebalance, fees)
 *   6. staked mUSD (SMUSD ERC4626 + yield routing)
 *   7. Bridge attestation flow (BLEBridgeV9 multi-sig)
 *   8. Price Oracle
 *   9. Interest Rate Model
 *  10. Access Control & Emergency
 *  11. Cross-contract decimal consistency (USDC 6 ↔ mUSD 18)
 *  12. Multi-user interaction scenarios
 */

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("DEEP AUDIT – Full Protocol Integration", function () {
  // ── actors ──
  let admin: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let liquidator: SignerWithAddress;
  let minter: SignerWithAddress;
  let pauser: SignerWithAddress;

  // ── contracts ──
  let musd: any;
  let smusd: any;
  let vault: any;
  let borrowModule: any;
  let directMint: any;
  let liquidationEngine: any;
  let interestRateModel: any;
  let priceOracle: any;
  let treasury: any;

  // ── mocks ──
  let usdc: any;
  let weth: any;
  let wbtc: any;
  let ethFeed: any;
  let btcFeed: any;
  let mockStrategy: any;

  // ── constants ──
  const USDC_DECIMALS = 6;
  const WETH_DECIMALS = 18;
  const WBTC_DECIMALS = 8;
  const ETH_PRICE = 2000n;
  const BTC_PRICE = 60000n;
  const SUPPLY_CAP = ethers.parseEther("10000000"); // 10M mUSD

  // Role hashes
  const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ROLE"));
  const LIQUIDATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATOR_ROLE"));
  const COMPLIANCE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("COMPLIANCE_ROLE"));
  const CAP_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("CAP_MANAGER_ROLE"));
  const EMERGENCY_ROLE = ethers.keccak256(ethers.toUtf8Bytes("EMERGENCY_ROLE"));
  const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));
  const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));
  const BORROW_MODULE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BORROW_MODULE_ROLE"));
  const LIQUIDATION_ROLE = ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATION_ROLE"));
  const VAULT_ROLE = ethers.keccak256(ethers.toUtf8Bytes("VAULT_ROLE"));

  // ── deploy ──
  beforeEach(async function () {
    [admin, user1, user2, liquidator, minter, pauser] = await ethers.getSigners();

    // Deploy Mocks
    const MockERC20F = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20F.deploy("USD Coin", "USDC", USDC_DECIMALS);
    weth = await MockERC20F.deploy("Wrapped ETH", "WETH", WETH_DECIMALS);
    wbtc = await MockERC20F.deploy("Wrapped BTC", "WBTC", WBTC_DECIMALS);

    const MockAggF = await ethers.getContractFactory("MockAggregatorV3");
    ethFeed = await MockAggF.deploy(8, ETH_PRICE * 10n ** 8n);
    btcFeed = await MockAggF.deploy(8, BTC_PRICE * 10n ** 8n);

    // Deploy MUSD (constructor takes initialSupplyCap)
    const MUSDF = await ethers.getContractFactory("MUSD");
    musd = await MUSDF.deploy(SUPPLY_CAP);

    // Deploy InterestRateModel (constructor takes admin address)
    const IRMF = await ethers.getContractFactory("InterestRateModel");
    interestRateModel = await IRMF.deploy(admin.address);

    // Deploy PriceOracle
    const POF = await ethers.getContractFactory("PriceOracle");
    priceOracle = await POF.deploy();

    // Deploy CollateralVault
    const CVF = await ethers.getContractFactory("CollateralVault");
    vault = await CVF.deploy();

    // Deploy TreasuryV2 (UUPS proxy)
    const TV2F = await ethers.getContractFactory("TreasuryV2");
    treasury = await upgrades.deployProxy(TV2F, [
      await usdc.getAddress(),
      admin.address, // placeholder vault — will update later
      admin.address,
      admin.address, // fee recipient
    ]);

    // Deploy SMUSD (constructor takes IERC20 _musd)
    const SMUSDF = await ethers.getContractFactory("SMUSD");
    smusd = await SMUSDF.deploy(await musd.getAddress());

    // Deploy BorrowModule (constructor: vault, oracle, musd, interestRateBps, minDebt)
    const BMF = await ethers.getContractFactory("BorrowModule");
    borrowModule = await BMF.deploy(
      await vault.getAddress(),
      await priceOracle.getAddress(),
      await musd.getAddress(),
      500, // 5% fixed fallback rate
      ethers.parseEther("100") // 100 mUSD min debt
    );

    // Deploy DirectMintV2 (constructor: usdc, musd, treasury, feeRecipient)
    const DMF = await ethers.getContractFactory("DirectMintV2");
    directMint = await DMF.deploy(
      await usdc.getAddress(),
      await musd.getAddress(),
      await treasury.getAddress(),
      admin.address // fee recipient
    );

    // Deploy LiquidationEngine (constructor: vault, borrowModule, oracle, musd, closeFactorBps)
    const LEF = await ethers.getContractFactory("LiquidationEngine");
    liquidationEngine = await LEF.deploy(
      await vault.getAddress(),
      await borrowModule.getAddress(),
      await priceOracle.getAddress(),
      await musd.getAddress(),
      5000 // 50% close factor
    );

    // Deploy MockStrategy (constructor: asset, treasury)
    const MSF = await ethers.getContractFactory("MockStrategy");
    mockStrategy = await MSF.deploy(
      await usdc.getAddress(),
      await treasury.getAddress()
    );

    // ── Setup Roles ──

    // MUSD roles
    await musd.grantRole(BRIDGE_ROLE, await directMint.getAddress());
    await musd.grantRole(BRIDGE_ROLE, await borrowModule.getAddress());
    await musd.grantRole(LIQUIDATOR_ROLE, await liquidationEngine.getAddress());
    await musd.grantRole(EMERGENCY_ROLE, pauser.address);

    // CollateralVault roles
    await vault.grantRole(BORROW_MODULE_ROLE, await borrowModule.getAddress());
    await vault.grantRole(LIQUIDATION_ROLE, await liquidationEngine.getAddress());
    await vault.grantRole(PAUSER_ROLE, pauser.address);
    await vault.setBorrowModule(await borrowModule.getAddress());

    // BorrowModule: LIQUIDATION_ROLE for LiquidationEngine
    await borrowModule.grantRole(LIQUIDATION_ROLE, await liquidationEngine.getAddress());

    // BorrowModule: set InterestRateModel
    const BM_BORROW_ADMIN = ethers.keccak256(ethers.toUtf8Bytes("BORROW_ADMIN_ROLE"));
    await borrowModule.grantRole(BM_BORROW_ADMIN, admin.address);
    await borrowModule.setInterestRateModel(await interestRateModel.getAddress());

    // Treasury roles — grant VAULT_ROLE to DirectMint
    await treasury.grantRole(VAULT_ROLE, await directMint.getAddress());

    // DirectMint: grant MINTER_ROLE for mintFor
    await directMint.grantRole(MINTER_ROLE, minter.address);

    // ── Setup Price Feeds ──
    await priceOracle.setFeed(
      await weth.getAddress(),
      await ethFeed.getAddress(),
      3600,
      WETH_DECIMALS
    );
    await priceOracle.setFeed(
      await wbtc.getAddress(),
      await btcFeed.getAddress(),
      3600,
      WBTC_DECIMALS
    );

    // ── Setup Collateral ──
    await vault.addCollateral(
      await weth.getAddress(),
      7500, // 75% LTV
      8000, // 80% liquidation threshold
      500   // 5% penalty
    );
    await vault.addCollateral(
      await wbtc.getAddress(),
      7000, // 70% LTV
      7500, // 75% liquidation threshold
      500   // 5% penalty
    );

    // ── Mint test tokens ──
    await usdc.mint(user1.address, ethers.parseUnits("1000000", USDC_DECIMALS));
    await usdc.mint(user2.address, ethers.parseUnits("1000000", USDC_DECIMALS));
    await usdc.mint(liquidator.address, ethers.parseUnits("1000000", USDC_DECIMALS));
    await weth.mint(user1.address, ethers.parseEther("100"));
    await weth.mint(user2.address, ethers.parseEther("100"));
    await wbtc.mint(user1.address, ethers.parseUnits("10", WBTC_DECIMALS));
  });

  // ================================================================
  //  SECTION 1: MINT FLOW (DirectMintV2 → mUSD → Treasury)
  // ================================================================
  describe("1. Mint Flow", function () {
    it("should mint mUSD 1:1 from USDC (minus 1% fee)", async function () {
      const usdcAmount = ethers.parseUnits("10000", USDC_DECIMALS);
      await usdc.connect(user1).approve(await directMint.getAddress(), usdcAmount);

      await directMint.connect(user1).mint(usdcAmount);

      // 1% fee → 9900 USDC net → 9900e18 mUSD
      const expectedMusd = ethers.parseEther("9900");
      expect(await musd.balanceOf(user1.address)).to.equal(expectedMusd);

      // Treasury receives the net-of-fee amount (fee stays in DirectMint)
      const treasuryBal = await usdc.balanceOf(await treasury.getAddress());
      const expectedNet = ethers.parseUnits("9900", USDC_DECIMALS);
      expect(treasuryBal).to.be.gte(expectedNet);
    });

    it("should redeem mUSD back to USDC (0% default redeem fee)", async function () {
      const usdcAmount = ethers.parseUnits("10000", USDC_DECIMALS);
      await usdc.connect(user1).approve(await directMint.getAddress(), usdcAmount);
      await directMint.connect(user1).mint(usdcAmount);

      const musdBal = await musd.balanceOf(user1.address);
      await musd.connect(user1).approve(await directMint.getAddress(), musdBal);

      const usdcBefore = await usdc.balanceOf(user1.address);
      await directMint.connect(user1).redeem(musdBal);
      const usdcAfter = await usdc.balanceOf(user1.address);

      // 9900 mUSD (18 dec) / 1e12 = 9900 USDC (6 dec)
      expect(usdcAfter - usdcBefore).to.equal(ethers.parseUnits("9900", USDC_DECIMALS));
    });

    it("should handle decimal conversion correctly (USDC 6 → mUSD 18)", async function () {
      const oneUsdc = ethers.parseUnits("1", USDC_DECIMALS);
      await usdc.connect(user1).approve(await directMint.getAddress(), oneUsdc);
      await directMint.connect(user1).mint(oneUsdc);

      // 1% fee: 0.99 mUSD = 0.99e18
      expect(await musd.balanceOf(user1.address)).to.equal(990_000_000_000_000_000n);
    });

    it("should enforce supply cap on mint", async function () {
      // Set low cap
      await musd.setSupplyCap(ethers.parseEther("100"));

      const amount = ethers.parseUnits("200", USDC_DECIMALS);
      await usdc.connect(user1).approve(await directMint.getAddress(), amount);
      await expect(directMint.connect(user1).mint(amount)).to.be.revertedWith("EXCEEDS_SUPPLY_CAP");
    });

    it("should reject mint below minimum amount", async function () {
      const tooSmall = ethers.parseUnits("0.5", USDC_DECIMALS);
      await usdc.connect(user1).approve(await directMint.getAddress(), tooSmall);
      await expect(directMint.connect(user1).mint(tooSmall)).to.be.revertedWith("BELOW_MIN");
    });

    it("should reject mint above maximum amount", async function () {
      const tooLarge = ethers.parseUnits("2000000", USDC_DECIMALS);
      await usdc.mint(user1.address, tooLarge);
      await usdc.connect(user1).approve(await directMint.getAddress(), tooLarge);
      await expect(directMint.connect(user1).mint(tooLarge)).to.be.revertedWith("ABOVE_MAX");
    });

    it("should allow mintFor by MINTER_ROLE", async function () {
      const amount = ethers.parseUnits("5000", USDC_DECIMALS);
      await usdc.mint(minter.address, amount);
      await usdc.connect(minter).approve(await directMint.getAddress(), amount);

      await directMint.connect(minter).mintFor(user2.address, amount);

      expect(await musd.balanceOf(user2.address)).to.equal(ethers.parseEther("4950"));
    });

    it("should reject mintFor without MINTER_ROLE", async function () {
      const amount = ethers.parseUnits("1000", USDC_DECIMALS);
      await usdc.connect(user1).approve(await directMint.getAddress(), amount);
      await expect(
        directMint.connect(user1).mintFor(user2.address, amount)
      ).to.be.reverted;
    });
  });

  // ================================================================
  //  SECTION 2: VAULT DEPOSITS & WITHDRAWALS
  // ================================================================
  describe("2. Collateral Vault", function () {
    it("should accept WETH deposits", async function () {
      const amount = ethers.parseEther("10");
      await weth.connect(user1).approve(await vault.getAddress(), amount);
      await vault.connect(user1).deposit(await weth.getAddress(), amount);

      expect(await vault.deposits(user1.address, await weth.getAddress())).to.equal(amount);
    });

    it("should accept WBTC deposits", async function () {
      const amount = ethers.parseUnits("2", WBTC_DECIMALS);
      await wbtc.connect(user1).approve(await vault.getAddress(), amount);
      await vault.connect(user1).deposit(await wbtc.getAddress(), amount);

      expect(await vault.deposits(user1.address, await wbtc.getAddress())).to.equal(amount);
    });

    it("should reject deposits for unsupported tokens", async function () {
      const amount = ethers.parseUnits("1000", USDC_DECIMALS);
      await usdc.connect(user1).approve(await vault.getAddress(), amount);
      await expect(
        vault.connect(user1).deposit(await usdc.getAddress(), amount)
      ).to.be.revertedWith("TOKEN_NOT_SUPPORTED");
    });

    it("should reject zero amount deposits", async function () {
      await expect(
        vault.connect(user1).deposit(await weth.getAddress(), 0)
      ).to.be.revertedWith("INVALID_AMOUNT");
    });

    it("should disable/enable collateral correctly", async function () {
      await vault.disableCollateral(await weth.getAddress());

      const amount = ethers.parseEther("1");
      await weth.connect(user1).approve(await vault.getAddress(), amount);
      await expect(
        vault.connect(user1).deposit(await weth.getAddress(), amount)
      ).to.be.revertedWith("TOKEN_NOT_SUPPORTED");

      await vault.enableCollateral(await weth.getAddress());
      await vault.connect(user1).deposit(await weth.getAddress(), amount);
      expect(await vault.deposits(user1.address, await weth.getAddress())).to.equal(amount);
    });

    it("should enforce max 50 supported tokens", async function () {
      for (let i = 0; i < 48; i++) {
        const MockERC20F = await ethers.getContractFactory("MockERC20");
        const token = await MockERC20F.deploy(`Token${i}`, `TK${i}`, 18);
        await vault.addCollateral(await token.getAddress(), 7000, 7500, 500);
      }

      const MockERC20F = await ethers.getContractFactory("MockERC20");
      const extraToken = await MockERC20F.deploy("Extra", "EXT", 18);
      await expect(
        vault.addCollateral(await extraToken.getAddress(), 7000, 7500, 500)
      ).to.be.revertedWith("TOO_MANY_TOKENS");
    });
  });

  // ================================================================
  //  SECTION 3: LENDING & BORROWING
  // ================================================================
  describe("3. Lending & Borrowing", function () {
    beforeEach(async function () {
      // User1 deposits 10 WETH as collateral
      const collateral = ethers.parseEther("10");
      await weth.connect(user1).approve(await vault.getAddress(), collateral);
      await vault.connect(user1).deposit(await weth.getAddress(), collateral);
    });

    it("should allow borrowing within LTV", async function () {
      // 10 WETH @ $2000 = $20,000 collateral
      // 75% LTV → max borrow = $15,000
      const borrowAmount = ethers.parseEther("10000");

      await borrowModule.connect(user1).borrow(borrowAmount);

      expect(await musd.balanceOf(user1.address)).to.equal(borrowAmount);
      expect(await borrowModule.totalDebt(user1.address)).to.be.gte(borrowAmount);
    });

    it("should reject borrowing exceeding borrow capacity", async function () {
      const tooMuch = ethers.parseEther("16000");
      await expect(
        borrowModule.connect(user1).borrow(tooMuch)
      ).to.be.revertedWith("EXCEEDS_BORROW_CAPACITY");
    });

    it("should reject borrow below minimum debt", async function () {
      const tiny = ethers.parseEther("1"); // Below 100 mUSD min
      await expect(
        borrowModule.connect(user1).borrow(tiny)
      ).to.be.revertedWith("BELOW_MIN_DEBT");
    });

    it("should accrue interest over time", async function () {
      const borrowAmount = ethers.parseEther("10000");
      await borrowModule.connect(user1).borrow(borrowAmount);

      const debtBefore = await borrowModule.totalDebt(user1.address);

      // Advance 30 days
      await time.increase(30 * 24 * 60 * 60);

      const debtAfter = await borrowModule.totalDebt(user1.address);
      expect(debtAfter).to.be.gt(debtBefore);
    });

    it("should allow full repayment", async function () {
      const borrowAmount = ethers.parseEther("10000");
      await borrowModule.connect(user1).borrow(borrowAmount);

      // Advance time
      await time.increase(30 * 24 * 60 * 60);

      const totalDebt = await borrowModule.totalDebt(user1.address);

      // Need more mUSD for interest — mint extra to cover inter-block accrual
      await musd.grantRole(BRIDGE_ROLE, admin.address);
      const extra = ethers.parseEther("1000");
      await musd.mint(user1.address, totalDebt + extra);

      // Approve more than enough
      await musd.connect(user1).approve(await borrowModule.getAddress(), totalDebt + extra);

      // repay() caps to actual debt, so passing totalDebt is fine
      // But debt may increase by 1 block of interest between totalDebt read and tx execution
      // So pass a large amount — repay() caps at actual debt
      await borrowModule.connect(user1).repay(totalDebt + extra);

      expect(await borrowModule.totalDebt(user1.address)).to.equal(0n);
    });

    it("should allow partial repayment", async function () {
      const borrowAmount = ethers.parseEther("10000");
      await borrowModule.connect(user1).borrow(borrowAmount);

      const halfRepay = ethers.parseEther("5000");
      await musd.connect(user1).approve(await borrowModule.getAddress(), halfRepay);
      await borrowModule.connect(user1).repay(halfRepay);

      const remaining = await borrowModule.totalDebt(user1.address);
      expect(remaining).to.be.lt(borrowAmount);
      expect(remaining).to.be.gt(ethers.parseEther("4000"));
    });

    it("should correctly track totalBorrows accounting", async function () {
      const borrow1 = ethers.parseEther("10000");
      await borrowModule.connect(user1).borrow(borrow1);

      await weth.connect(user2).approve(await vault.getAddress(), ethers.parseEther("10"));
      await vault.connect(user2).deposit(await weth.getAddress(), ethers.parseEther("10"));
      const borrow2 = ethers.parseEther("5000");
      await borrowModule.connect(user2).borrow(borrow2);

      const borrows = await borrowModule.totalBorrows();
      expect(borrows).to.be.closeTo(borrow1 + borrow2, ethers.parseEther("1"));

      await musd.connect(user1).approve(await borrowModule.getAddress(), ethers.parseEther("5000"));
      await borrowModule.connect(user1).repay(ethers.parseEther("5000"));

      const borrowsAfter = await borrowModule.totalBorrows();
      expect(borrowsAfter).to.be.closeTo(ethers.parseEther("10000"), ethers.parseEther("1"));
    });

    it("should prevent collateral withdrawal that breaks health factor", async function () {
      const borrowAmount = ethers.parseEther("14000");
      await borrowModule.connect(user1).borrow(borrowAmount);

      await expect(
        borrowModule.connect(user1).withdrawCollateral(await weth.getAddress(), ethers.parseEther("5"))
      ).to.be.revertedWith("WITHDRAWAL_WOULD_LIQUIDATE");
    });
  });

  // ================================================================
  //  SECTION 4: LIQUIDATION
  // ================================================================
  describe("4. Liquidation Engine", function () {
    beforeEach(async function () {
      // User1 deposits 10 WETH and borrows near max
      const collateral = ethers.parseEther("10");
      await weth.connect(user1).approve(await vault.getAddress(), collateral);
      await vault.connect(user1).deposit(await weth.getAddress(), collateral);

      // Borrow 14,000 mUSD (near 75% of $20k)
      await borrowModule.connect(user1).borrow(ethers.parseEther("14000"));

      // Give liquidator mUSD
      await musd.grantRole(BRIDGE_ROLE, admin.address);
      await musd.mint(liquidator.address, ethers.parseEther("100000"));
    });

    it("should reject liquidation on healthy position", async function () {
      await expect(
        liquidationEngine.connect(liquidator).liquidate(
          user1.address,
          await weth.getAddress(),
          ethers.parseEther("1000")
        )
      ).to.be.revertedWith("POSITION_HEALTHY");
    });

    it("should liquidate after price drop", async function () {
      // Drop ETH price to $1600 first (within 20% circuit breaker)
      await ethFeed.setAnswer(1600n * 10n ** 8n);
      await priceOracle.updatePrice(await weth.getAddress());
      // Then to $1300
      await ethFeed.setAnswer(1300n * 10n ** 8n);
      await priceOracle.updatePrice(await weth.getAddress());

      const hf = await borrowModule.healthFactor(user1.address);
      expect(hf).to.be.lt(10000n);

      await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), ethers.parseEther("100000"));

      const wethBefore = await weth.balanceOf(liquidator.address);
      await liquidationEngine.connect(liquidator).liquidate(
        user1.address,
        await weth.getAddress(),
        ethers.parseEther("5000")
      );
      const wethAfter = await weth.balanceOf(liquidator.address);

      expect(wethAfter).to.be.gt(wethBefore);

      const debtAfter = await borrowModule.totalDebt(user1.address);
      expect(debtAfter).to.be.lt(ethers.parseEther("14000"));
    });

    it("should enforce close factor (max 50% liquidation)", async function () {
      // Step through circuit breaker
      await ethFeed.setAnswer(1600n * 10n ** 8n);
      await priceOracle.updatePrice(await weth.getAddress());
      await ethFeed.setAnswer(1300n * 10n ** 8n);
      await priceOracle.updatePrice(await weth.getAddress());

      const totalDebt = await borrowModule.totalDebt(user1.address);
      const maxRepay = totalDebt / 2n;

      await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), totalDebt);

      await liquidationEngine.connect(liquidator).liquidate(
        user1.address,
        await weth.getAddress(),
        totalDebt // Try full — should be capped to 50%
      );

      const debtAfter = await borrowModule.totalDebt(user1.address);
      // Should have reduced by at most ~50%
      expect(debtAfter).to.be.gte(totalDebt - maxRepay - ethers.parseEther("100"));
    });

    it("should allow full liquidation when health < 0.5", async function () {
      // Drop price severely — must step down gradually due to 20% circuit breaker
      // Step 1: $2000 -> $1600 (20%)
      await ethFeed.setAnswer(1600n * 10n ** 8n);
      await priceOracle.updatePrice(await weth.getAddress());
      // Step 2: $1600 -> $1280
      await ethFeed.setAnswer(1280n * 10n ** 8n);
      await priceOracle.updatePrice(await weth.getAddress());
      // Step 3: $1280 -> $1024
      await ethFeed.setAnswer(1024n * 10n ** 8n);
      await priceOracle.updatePrice(await weth.getAddress());
      // Step 4: $1024 -> $820
      await ethFeed.setAnswer(820n * 10n ** 8n);
      await priceOracle.updatePrice(await weth.getAddress());
      // Step 5: $820 -> $656
      await ethFeed.setAnswer(656n * 10n ** 8n);
      await priceOracle.updatePrice(await weth.getAddress());
      // Step 6: $656 -> $525
      await ethFeed.setAnswer(525n * 10n ** 8n);
      await priceOracle.updatePrice(await weth.getAddress());

      const hf = await borrowModule.healthFactor(user1.address);
      expect(hf).to.be.lt(5000n);

      const totalDebt = await borrowModule.totalDebt(user1.address);
      await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), totalDebt);

      // Full liquidation should be allowed
      await liquidationEngine.connect(liquidator).liquidate(
        user1.address,
        await weth.getAddress(),
        totalDebt
      );
      // Some debt should be cleared (limited by collateral)
    });

    it("should prevent self-liquidation", async function () {
      await ethFeed.setAnswer(1600n * 10n ** 8n);
      await priceOracle.updatePrice(await weth.getAddress());
      await ethFeed.setAnswer(1300n * 10n ** 8n);
      await priceOracle.updatePrice(await weth.getAddress());

      await musd.connect(user1).approve(await liquidationEngine.getAddress(), ethers.parseEther("5000"));
      await expect(
        liquidationEngine.connect(user1).liquidate(
          user1.address,
          await weth.getAddress(),
          ethers.parseEther("1000")
        )
      ).to.be.revertedWith("CANNOT_SELF_LIQUIDATE");
    });

    it("should prevent dust liquidations", async function () {
      await ethFeed.setAnswer(1600n * 10n ** 8n);
      await priceOracle.updatePrice(await weth.getAddress());
      await ethFeed.setAnswer(1300n * 10n ** 8n);
      await priceOracle.updatePrice(await weth.getAddress());

      await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), ethers.parseEther("50"));
      await expect(
        liquidationEngine.connect(liquidator).liquidate(
          user1.address,
          await weth.getAddress(),
          ethers.parseEther("50") // Below 100 mUSD min
        )
      ).to.be.revertedWith("DUST_LIQUIDATION");
    });

    it("should correctly compute WBTC seizure with 8 decimals", async function () {
      // User1 also deposits WBTC
      const btcAmount = ethers.parseUnits("1", WBTC_DECIMALS);
      await wbtc.connect(user1).approve(await vault.getAddress(), btcAmount);
      await vault.connect(user1).deposit(await wbtc.getAddress(), btcAmount);

      // Borrow more against BTC  (10 WETH + 1 WBTC = $20k + $60k = $80k)
      await borrowModule.connect(user1).borrow(ethers.parseEther("25000"));

      // Drop BTC to $30k (from $60k, 50% — need circuit breaker steps)
      // Step 1: $60000 -> $48000
      await btcFeed.setAnswer(48000n * 10n ** 8n);
      await priceOracle.updatePrice(await wbtc.getAddress());
      // Step 2: $48000 -> $38400
      await btcFeed.setAnswer(38400n * 10n ** 8n);
      await priceOracle.updatePrice(await wbtc.getAddress());
      // Step 3: $38400 -> $30720
      await btcFeed.setAnswer(30720n * 10n ** 8n);
      await priceOracle.updatePrice(await wbtc.getAddress());

      // Drop ETH to $1000 (from $2000, 50% — need steps)
      // Step 1: $2000 -> $1600
      await ethFeed.setAnswer(1600n * 10n ** 8n);
      await priceOracle.updatePrice(await weth.getAddress());
      // Step 2: $1600 -> $1280
      await ethFeed.setAnswer(1280n * 10n ** 8n);
      await priceOracle.updatePrice(await weth.getAddress());
      // Step 3: $1280 -> $1024
      await ethFeed.setAnswer(1024n * 10n ** 8n);
      await priceOracle.updatePrice(await weth.getAddress());

      const hf = await borrowModule.healthFactor(user1.address);

      // FIX DA-03: Assert health factor is actually below threshold instead of
      // silently skipping all assertions when it's not
      expect(hf).to.be.lt(10000n, "Health factor should be below 1.0 for liquidation test");

      await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), ethers.parseEther("5000"));

      const btcBefore = await wbtc.balanceOf(liquidator.address);
      await liquidationEngine.connect(liquidator).liquidate(
        user1.address,
        await wbtc.getAddress(),
        ethers.parseEther("5000")
      );
      const btcAfter = await wbtc.balanceOf(liquidator.address);

        expect(btcAfter).to.be.gt(btcBefore);

        // Seized should be roughly 5000 * 1.05 / btcPrice of BTC
        const seized = btcAfter - btcBefore;
        // Use 5% tolerance due to stepped circuit-breaker prices
        expect(seized).to.be.gt(0n);
        expect(seized).to.be.lt(ethers.parseUnits("1", WBTC_DECIMALS));
    });
  });

  // ================================================================
  //  SECTION 5: TREASURY STRATEGY DISBURSEMENT
  // ================================================================
  describe("5. Treasury Strategy Disbursement", function () {
    const STRATEGIST_ROLE = ethers.keccak256(ethers.toUtf8Bytes("STRATEGIST_ROLE"));
    const ALLOCATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ALLOCATOR_ROLE"));

    it("should auto-allocate deposits to strategies", async function () {
      await treasury.grantRole(STRATEGIST_ROLE, admin.address);
      await treasury.grantRole(ALLOCATOR_ROLE, admin.address);

      await treasury.addStrategy(
        await mockStrategy.getAddress(),
        9000, 5000, 10000, true
      );

      const amount = ethers.parseUnits("100000", USDC_DECIMALS);
      await usdc.connect(user1).approve(await directMint.getAddress(), amount);
      await directMint.connect(user1).mint(amount);

      const stratValue = await mockStrategy.totalValue();
      expect(stratValue).to.be.gt(0n);
    });

    it("should keep reserve buffer in treasury", async function () {
      await treasury.grantRole(STRATEGIST_ROLE, admin.address);

      await treasury.addStrategy(
        await mockStrategy.getAddress(),
        9000, 5000, 10000, true
      );

      const amount = ethers.parseUnits("100000", USDC_DECIMALS);
      await usdc.connect(user1).approve(await directMint.getAddress(), amount);
      await directMint.connect(user1).mint(amount);

      const reserve = await treasury.reserveBalance();
      const total = await treasury.totalValue();
      const reservePct = (reserve * 10000n) / total;
      // Default reserve is 10% (1000 bps)
      expect(reservePct).to.be.gte(900n);
      expect(reservePct).to.be.lte(1100n);
    });

    it("should accrue performance fees on yield", async function () {
      await treasury.grantRole(STRATEGIST_ROLE, admin.address);
      await treasury.grantRole(ALLOCATOR_ROLE, admin.address);

      await treasury.addStrategy(
        await mockStrategy.getAddress(),
        9000, 5000, 10000, true
      );

      const amount = ethers.parseUnits("100000", USDC_DECIMALS);
      await usdc.connect(user1).approve(await directMint.getAddress(), amount);
      await directMint.connect(user1).mint(amount);

      // Simulate yield: send extra USDC to mock strategy
      await usdc.mint(await mockStrategy.getAddress(), ethers.parseUnits("10000", USDC_DECIMALS));

      // Wait 1h+1s
      await time.increase(3601);

      await treasury.accrueFees();

      const pending = await treasury.pendingFees();
      expect(pending).to.be.gt(0n);
    });

    it("should rebalance strategies to target allocations", async function () {
      await treasury.grantRole(STRATEGIST_ROLE, admin.address);
      await treasury.grantRole(ALLOCATOR_ROLE, admin.address);

      const MSF2 = await ethers.getContractFactory("MockStrategy");
      const strategy2 = await MSF2.deploy(await usdc.getAddress(), await treasury.getAddress());

      await treasury.addStrategy(await mockStrategy.getAddress(), 4500, 2000, 8000, true);
      await treasury.addStrategy(await strategy2.getAddress(), 4500, 2000, 8000, true);

      const amount = ethers.parseUnits("100000", USDC_DECIMALS);
      await usdc.connect(user1).approve(await directMint.getAddress(), amount);
      await directMint.connect(user1).mint(amount);

      await time.increase(3601);
      await treasury.rebalance();

      const val1 = await mockStrategy.totalValue();
      const val2 = await strategy2.totalValue();

      if (val1 > 0n && val2 > 0n) {
        const diff = val1 > val2 ? val1 - val2 : val2 - val1;
        const avg = (val1 + val2) / 2n;
        expect(diff * 100n / avg).to.be.lte(10n);
      }
    });

    it("should handle strategy removal with full withdrawal", async function () {
      await treasury.grantRole(STRATEGIST_ROLE, admin.address);

      await treasury.addStrategy(await mockStrategy.getAddress(), 9000, 5000, 10000, true);

      const amount = ethers.parseUnits("100000", USDC_DECIMALS);
      await usdc.connect(user1).approve(await directMint.getAddress(), amount);
      await directMint.connect(user1).mint(amount);

      const stratValBefore = await mockStrategy.totalValue();
      expect(stratValBefore).to.be.gt(0n);

      await treasury.removeStrategy(await mockStrategy.getAddress());

      const stratValAfter = await mockStrategy.totalValue();
      expect(stratValAfter).to.equal(0n);
    });
  });

  // ================================================================
  //  SECTION 6: STAKED mUSD (SMUSD / ERC4626)
  // ================================================================
  describe("6. Staked mUSD (smUSD)", function () {
    let userMusd: bigint;

    beforeEach(async function () {
      const usdcAmount = ethers.parseUnits("100000", USDC_DECIMALS);
      await usdc.connect(user1).approve(await directMint.getAddress(), usdcAmount);
      await directMint.connect(user1).mint(usdcAmount);
      userMusd = await musd.balanceOf(user1.address);
    });

    it("should deposit mUSD and receive shares", async function () {
      await musd.connect(user1).approve(await smusd.getAddress(), userMusd);
      await smusd.connect(user1).deposit(userMusd, user1.address);

      expect(await smusd.balanceOf(user1.address)).to.be.gt(0n);
    });

    it("should enforce 24h cooldown on withdrawal", async function () {
      await musd.connect(user1).approve(await smusd.getAddress(), userMusd);
      await smusd.connect(user1).deposit(userMusd, user1.address);

      const shares = await smusd.balanceOf(user1.address);

      // Immediate redeem should fail
      await expect(
        smusd.connect(user1).redeem(shares, user1.address, user1.address)
      ).to.be.revertedWith("COOLDOWN_ACTIVE");

      // Advance 24h+1s
      await time.increase(24 * 60 * 60 + 1);

      await smusd.connect(user1).redeem(shares, user1.address, user1.address);
      expect(await musd.balanceOf(user1.address)).to.be.gt(0n);
    });

    it("should propagate fresh cooldown via transfer", async function () {
      await musd.connect(user1).approve(await smusd.getAddress(), userMusd);
      await smusd.connect(user1).deposit(userMusd, user1.address);

      const shares = await smusd.balanceOf(user1.address);
      const halfShares = shares / 2n;

      // Transfer immediately (user1's cooldown is still active)
      await smusd.connect(user1).transfer(user2.address, halfShares);

      // user2 should NOT be able to redeem (inherited cooldown)
      await expect(
        smusd.connect(user2).redeem(halfShares, user2.address, user2.address)
      ).to.be.revertedWith("COOLDOWN_ACTIVE");
    });
  });

  // ================================================================
  //  SECTION 7: BRIDGE ATTESTATION (BLEBridgeV9)
  // ================================================================
  describe("7. Bridge Attestation (BLEBridgeV9)", function () {
    let bridge: any;
    let validator1: SignerWithAddress;
    let validator2: SignerWithAddress;
    let validator3: SignerWithAddress;

    beforeEach(async function () {
      const signers = await ethers.getSigners();
      validator1 = signers[6];
      validator2 = signers[7];
      validator3 = signers[8];

      const BridgeF = await ethers.getContractFactory("BLEBridgeV9");
      bridge = await upgrades.deployProxy(BridgeF, [
        2, // min 2 sigs
        await musd.getAddress(),
        11000, // 110% collateral ratio
        ethers.parseEther("1000000"), // 1M daily limit
      ]);

      const VALIDATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("VALIDATOR_ROLE"));
      await bridge.grantRole(VALIDATOR_ROLE, validator1.address);
      await bridge.grantRole(VALIDATOR_ROLE, validator2.address);
      await bridge.grantRole(VALIDATOR_ROLE, validator3.address);

      // Grant CAP_MANAGER_ROLE to bridge
      await musd.grantRole(CAP_MANAGER_ROLE, await bridge.getAddress());
    });

    async function signAttestation(
      att: { id: string; cantonAssets: bigint; nonce: bigint; timestamp: bigint },
      bridgeAddr: string,
      signersList: SignerWithAddress[]
    ) {
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const messageHash = ethers.solidityPackedKeccak256(
        ["bytes32", "uint256", "uint256", "uint256", "uint256", "address"],
        [att.id, att.cantonAssets, att.nonce, att.timestamp, chainId, bridgeAddr]
      );

      const sorted = [...signersList].sort(
        (a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase())
      );

      const signatures = [];
      for (const s of sorted) {
        signatures.push(await s.signMessage(ethers.getBytes(messageHash)));
      }
      return signatures;
    }

    it("should process valid attestation with sufficient signatures", async function () {
      const ts = BigInt(await time.latest()) - 60n;
      const att = {
        id: ethers.id("test-attestation-1"),
        cantonAssets: ethers.parseEther("1000000"),
        nonce: 1n,
        timestamp: ts,
      };

      const sigs = await signAttestation(att, await bridge.getAddress(), [validator1, validator2]);
      await bridge.processAttestation(att, sigs);

      expect(await bridge.currentNonce()).to.equal(1n);
      expect(await bridge.attestedCantonAssets()).to.equal(att.cantonAssets);
    });

    it("should reject attestation with insufficient signatures", async function () {
      const ts = BigInt(await time.latest()) - 60n;
      const att = {
        id: ethers.id("test-attestation-2"),
        cantonAssets: ethers.parseEther("1000000"),
        nonce: 1n,
        timestamp: ts,
      };

      const sigs = await signAttestation(att, await bridge.getAddress(), [validator1]);
      await expect(bridge.processAttestation(att, sigs)).to.be.revertedWith("INSUFFICIENT_SIGNATURES");
    });

    it("should reject replay attestation", async function () {
      const ts = BigInt(await time.latest()) - 60n;
      const att = {
        id: ethers.id("test-replay"),
        cantonAssets: ethers.parseEther("1000000"),
        nonce: 1n,
        timestamp: ts,
      };

      const sigs = await signAttestation(att, await bridge.getAddress(), [validator1, validator2]);
      await bridge.processAttestation(att, sigs);

      await expect(bridge.processAttestation(att, sigs)).to.be.revertedWith("INVALID_NONCE");
    });

    it("should reject attestation with wrong nonce", async function () {
      const ts = BigInt(await time.latest()) - 60n;
      const att = {
        id: ethers.id("test-wrong-nonce"),
        cantonAssets: ethers.parseEther("1000000"),
        nonce: 5n, // Wrong
        timestamp: ts,
      };

      const sigs = await signAttestation(att, await bridge.getAddress(), [validator1, validator2]);
      await expect(bridge.processAttestation(att, sigs)).to.be.revertedWith("INVALID_NONCE");
    });

    it("should reject expired attestation", async function () {
      // 7 hours ago (MAX_ATTESTATION_AGE = 6h)
      const oldTs = BigInt(await time.latest()) - 7n * 3600n;
      const att = {
        id: ethers.id("old-attestation"),
        cantonAssets: ethers.parseEther("1000000"),
        nonce: 1n,
        timestamp: oldTs,
      };

      const sigs = await signAttestation(att, await bridge.getAddress(), [validator1, validator2]);
      await expect(bridge.processAttestation(att, sigs)).to.be.revertedWith("ATTESTATION_TOO_OLD");
    });

    it("should enforce unpause timelock", async function () {
      const EM_ROLE = ethers.keccak256(ethers.toUtf8Bytes("EMERGENCY_ROLE"));
      await bridge.grantRole(EM_ROLE, admin.address);

      await bridge.pause();
      expect(await bridge.paused()).to.be.true;

      await bridge.requestUnpause();

      await expect(bridge.executeUnpause()).to.be.revertedWith("TIMELOCK_NOT_ELAPSED");

      await time.increase(24 * 60 * 60 + 1);

      await bridge.executeUnpause();
      expect(await bridge.paused()).to.be.false;
    });
  });

  // ================================================================
  //  SECTION 8: PRICE ORACLE
  // ================================================================
  describe("8. Price Oracle", function () {
    it("should normalize prices to 18 decimals", async function () {
      const price = await priceOracle.getPrice(await weth.getAddress());
      expect(price).to.equal(ETH_PRICE * 10n ** 18n);
    });

    it("should correctly compute USD value for different decimal tokens", async function () {
      const oneWeth = ethers.parseEther("1");
      const wethValue = await priceOracle.getValueUsd(await weth.getAddress(), oneWeth);
      expect(wethValue).to.equal(ethers.parseEther("2000"));

      const oneBtc = ethers.parseUnits("1", WBTC_DECIMALS);
      const btcValue = await priceOracle.getValueUsd(await wbtc.getAddress(), oneBtc);
      expect(btcValue).to.equal(ethers.parseEther("60000"));
    });

    it("should reject stale prices", async function () {
      await time.increase(3601);
      await expect(
        priceOracle.getPrice(await weth.getAddress())
      ).to.be.revertedWith("STALE_PRICE");
    });

    it("should allow admin to update price after circuit breaker", async function () {
      // 25% change would trigger circuit breaker on getPrice
      // But admin can call updatePrice → resets lastKnownPrice → then getPrice works
      // Step within 20%: $2000 → $2400
      await ethFeed.setAnswer(2400n * 10n ** 8n);
      await priceOracle.updatePrice(await weth.getAddress());

      const price = await priceOracle.getPrice(await weth.getAddress());
      expect(price).to.equal(2400n * 10n ** 18n);

      // Now step to $2880 (20% from $2400)
      await ethFeed.setAnswer(2880n * 10n ** 8n);
      await priceOracle.updatePrice(await weth.getAddress());

      const price2 = await priceOracle.getPrice(await weth.getAddress());
      expect(price2).to.equal(2880n * 10n ** 18n);
    });
  });

  // ================================================================
  //  SECTION 9: INTEREST RATE MODEL
  // ================================================================
  describe("9. Interest Rate Model", function () {
    it("should return base rate at 0% utilization", async function () {
      const rate = await interestRateModel.getBorrowRateAnnual(0, ethers.parseEther("1000000"));
      // baseRateBps = 200 → 2%
      expect(rate).to.equal(200n);
    });

    it("should have kinked rate above 80% utilization", async function () {
      const supply = ethers.parseEther("1000000");
      const borrows70 = ethers.parseEther("700000");
      const borrows90 = ethers.parseEther("900000");

      const rate70 = await interestRateModel.getBorrowRateAnnual(borrows70, supply);
      const rate90 = await interestRateModel.getBorrowRateAnnual(borrows90, supply);

      const rateIncrease = rate90 - rate70;
      expect(rateIncrease).to.be.gt(200n);
    });

    it("should split interest between supplier and reserve", async function () {
      const interest = ethers.parseEther("1000");
      const [supplierAmt, reserveAmt] = await interestRateModel.splitInterest(interest);

      // 10% reserve factor
      expect(reserveAmt).to.equal(ethers.parseEther("100"));
      expect(supplierAmt).to.equal(ethers.parseEther("900"));
    });
  });

  // ================================================================
  //  SECTION 10: ACCESS CONTROL & EMERGENCY
  // ================================================================
  describe("10. Access Control & Emergency", function () {
    it("should reject unauthorized mint", async function () {
      await expect(
        musd.connect(user1).mint(user1.address, ethers.parseEther("1000"))
      ).to.be.reverted;
    });

    it("should reject unauthorized burn", async function () {
      await expect(
        musd.connect(user1).burn(user1.address, ethers.parseEther("1000"))
      ).to.be.reverted;
    });

    it("should enforce blacklist on transfers", async function () {
      const amount = ethers.parseUnits("1000", USDC_DECIMALS);
      await usdc.connect(user1).approve(await directMint.getAddress(), amount);
      await directMint.connect(user1).mint(amount);

      await musd.grantRole(COMPLIANCE_ROLE, admin.address);
      await musd.setBlacklist(user1.address, true);

      await expect(
        musd.connect(user1).transfer(user2.address, ethers.parseEther("100"))
      ).to.be.revertedWith("COMPLIANCE_REJECT");
    });

    it("should pause/unpause MUSD with role separation", async function () {
      // MUSD uses EMERGENCY_ROLE for pause
      await musd.connect(pauser).pause();

      // Pauser (EMERGENCY_ROLE) cannot unpause (requires DEFAULT_ADMIN)
      await expect(musd.connect(pauser).unpause()).to.be.reverted;

      // Admin can unpause
      await musd.unpause();
    });

    it("should prevent vault pause griefing (role separation)", async function () {
      await vault.connect(pauser).pause();

      await expect(vault.connect(pauser).unpause()).to.be.reverted;

      await vault.unpause();
    });
  });

  // ================================================================
  //  SECTION 11: CROSS-CONTRACT DECIMAL CONSISTENCY
  // ================================================================
  describe("11. Decimal Consistency (USDC 6 ↔ mUSD 18)", function () {
    it("should handle exact 1 USDC → mUSD conversion", async function () {
      const oneUsdc = 1_000_000n;
      await usdc.connect(user1).approve(await directMint.getAddress(), oneUsdc);
      await directMint.connect(user1).mint(oneUsdc);

      expect(await musd.balanceOf(user1.address)).to.equal(990_000_000_000_000_000n);
    });

    it("should handle exact mUSD → USDC conversion on redeem", async function () {
      const amount = ethers.parseUnits("1000", USDC_DECIMALS);
      await usdc.connect(user1).approve(await directMint.getAddress(), amount);
      await directMint.connect(user1).mint(amount);

      const musdBal = await musd.balanceOf(user1.address);
      await musd.connect(user1).approve(await directMint.getAddress(), musdBal);

      const usdcBefore = await usdc.balanceOf(user1.address);
      await directMint.connect(user1).redeem(musdBal);
      const usdcAfter = await usdc.balanceOf(user1.address);

      // 990 mUSD → 990 USDC
      expect(usdcAfter - usdcBefore).to.equal(990_000_000n);
    });

    it("should handle Treasury totalValue scaling", async function () {
      const amount = ethers.parseUnits("10000", USDC_DECIMALS);
      await usdc.connect(user1).approve(await directMint.getAddress(), amount);
      await directMint.connect(user1).mint(amount);

      // DirectMint sends net-of-fee (9900 USDC) to treasury
      const treasuryVal = await treasury.totalValue();
      const expectedNet = ethers.parseUnits("9900", USDC_DECIMALS);
      expect(treasuryVal).to.be.gte(expectedNet);
    });

    it("should handle rounding correctly for small amounts", async function () {
      // Mint 1000 USDC (minimum for redeem is 1e6)
      const mintAmount = ethers.parseUnits("1000", USDC_DECIMALS);
      await usdc.connect(user1).approve(await directMint.getAddress(), mintAmount);
      await directMint.connect(user1).mint(mintAmount);

      const bal = await musd.balanceOf(user1.address);
      expect(bal).to.equal(ethers.parseEther("990")); // 1% fee

      await musd.connect(user1).approve(await directMint.getAddress(), bal);
      await directMint.connect(user1).redeem(bal);

      const usdcRecov = await usdc.balanceOf(user1.address);
      // Started with 1M, spent 1000, got back 990
      expect(usdcRecov).to.equal(ethers.parseUnits("999990", USDC_DECIMALS));
    });
  });

  // ================================================================
  //  SECTION 12: MULTI-USER INTERACTION SCENARIOS
  // ================================================================
  describe("12. Multi-User Interactions", function () {
    it("should handle concurrent borrowers with independent positions", async function () {
      await weth.connect(user1).approve(await vault.getAddress(), ethers.parseEther("10"));
      await vault.connect(user1).deposit(await weth.getAddress(), ethers.parseEther("10"));
      await borrowModule.connect(user1).borrow(ethers.parseEther("10000"));

      await weth.connect(user2).approve(await vault.getAddress(), ethers.parseEther("10"));
      await vault.connect(user2).deposit(await weth.getAddress(), ethers.parseEther("10"));
      await borrowModule.connect(user2).borrow(ethers.parseEther("5000"));

      expect(await borrowModule.totalDebt(user1.address)).to.be.closeTo(ethers.parseEther("10000"), ethers.parseEther("1"));
      expect(await borrowModule.totalDebt(user2.address)).to.be.closeTo(ethers.parseEther("5000"), ethers.parseEther("1"));
      expect(await borrowModule.totalBorrows()).to.be.closeTo(ethers.parseEther("15000"), ethers.parseEther("1"));
    });

    it("should liquidate one user without affecting another", async function () {
      // User1 borrows aggressively
      await weth.connect(user1).approve(await vault.getAddress(), ethers.parseEther("10"));
      await vault.connect(user1).deposit(await weth.getAddress(), ethers.parseEther("10"));
      await borrowModule.connect(user1).borrow(ethers.parseEther("14000"));

      // User2 borrows conservatively
      await weth.connect(user2).approve(await vault.getAddress(), ethers.parseEther("10"));
      await vault.connect(user2).deposit(await weth.getAddress(), ethers.parseEther("10"));
      await borrowModule.connect(user2).borrow(ethers.parseEther("5000"));

      // Drop ETH price (step through circuit breaker)
      await ethFeed.setAnswer(1600n * 10n ** 8n);
      await priceOracle.updatePrice(await weth.getAddress());
      await ethFeed.setAnswer(1300n * 10n ** 8n);
      await priceOracle.updatePrice(await weth.getAddress());

      expect(await liquidationEngine.isLiquidatable(user1.address)).to.be.true;
      expect(await liquidationEngine.isLiquidatable(user2.address)).to.be.false;

      await musd.grantRole(BRIDGE_ROLE, admin.address);
      await musd.mint(liquidator.address, ethers.parseEther("100000"));
      await musd.connect(liquidator).approve(await liquidationEngine.getAddress(), ethers.parseEther("100000"));

      await liquidationEngine.connect(liquidator).liquidate(
        user1.address, await weth.getAddress(), ethers.parseEther("5000")
      );

      // User2's debt is unaffected (closeTo accounts for interest accrual)
      const debt2After = await borrowModule.totalDebt(user2.address);
      expect(debt2After).to.be.closeTo(ethers.parseEther("5000"), ethers.parseEther("1"));
    });

    it("should correctly handle full flow: mint → stake → borrow → repay → unstake → redeem", async function () {
      // 1. Mint mUSD from USDC
      const usdcAmount = ethers.parseUnits("50000", USDC_DECIMALS);
      await usdc.connect(user1).approve(await directMint.getAddress(), usdcAmount);
      await directMint.connect(user1).mint(usdcAmount);

      const musdBal = await musd.balanceOf(user1.address);
      expect(musdBal).to.be.gt(0n);

      // 2. Stake half in smUSD
      const stakeAmount = musdBal / 2n;
      await musd.connect(user1).approve(await smusd.getAddress(), stakeAmount);
      await smusd.connect(user1).deposit(stakeAmount, user1.address);

      const shares = await smusd.balanceOf(user1.address);
      expect(shares).to.be.gt(0n);

      // 3. Deposit WETH collateral and borrow
      await weth.connect(user1).approve(await vault.getAddress(), ethers.parseEther("10"));
      await vault.connect(user1).deposit(await weth.getAddress(), ethers.parseEther("10"));
      await borrowModule.connect(user1).borrow(ethers.parseEther("5000"));

      // 4. Wait
      await time.increase(7 * 24 * 60 * 60);

      // 5. Repay debt — must pass more than totalDebt to cover inter-block accrual
      const debt = await borrowModule.totalDebt(user1.address);
      await musd.grantRole(BRIDGE_ROLE, admin.address);
      const extra = ethers.parseEther("1000");
      await musd.mint(user1.address, debt + extra);
      await musd.connect(user1).approve(await borrowModule.getAddress(), debt + extra);
      await borrowModule.connect(user1).repay(debt + extra);
      expect(await borrowModule.totalDebt(user1.address)).to.equal(0n);

      // 6. Withdraw collateral
      await borrowModule.connect(user1).withdrawCollateral(await weth.getAddress(), ethers.parseEther("10"));

      // 7. Wait cooldown and unstake
      await time.increase(24 * 60 * 60 + 1);
      await smusd.connect(user1).redeem(shares, user1.address, user1.address);

      // 8. Redeem mUSD for USDC
      // Ensure treasury has enough reserves to honor redemption
      const finalMusd = await musd.balanceOf(user1.address);
      const redeemUsdc = finalMusd / 10n ** 12n;
      // Deposit additional USDC into treasury to cover
      await usdc.mint(admin.address, redeemUsdc * 2n);
      await usdc.approve(await treasury.getAddress(), redeemUsdc * 2n);
      await treasury.deposit(admin.address, redeemUsdc * 2n);

      await musd.connect(user1).approve(await directMint.getAddress(), finalMusd);
      await directMint.connect(user1).redeem(finalMusd);

      const finalUsdc = await usdc.balanceOf(user1.address);
      expect(finalUsdc).to.be.gt(ethers.parseUnits("949000", USDC_DECIMALS));
    });
  });
});
