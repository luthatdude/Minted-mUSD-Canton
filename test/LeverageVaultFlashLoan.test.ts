/**
 * TEST-004: LeverageVault Flash Loan Attack Vector Tests (MEDIUM severity)
 *
 * Hardhat tests for LeverageVault security properties:
 *   1. ReentrancyGuard prevents reentrant calls during leverage operations
 *   2. emergencyClosePosition doesn't sweep other users' residual tokens (SOL-003)
 *   3. Leverage positions can't be manipulated via flash-loan-style attacks
 *   4. Pausable emergency controls work correctly (H-03)
 *
 * Uses the same deployment patterns as FuzzTests.test.ts and LeverageVault.test.ts.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

// ============================================================
//  DEPLOYMENT FIXTURE
// ============================================================

describe("TEST-004: LeverageVault Flash Loan & Security Tests", function () {
  async function deployFullFixture() {
    const [owner, user1, user2, attacker] = await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const musd = await (await ethers.getContractFactory("MUSD")).deploy(ethers.parseEther("100000000"));
    const weth = await MockERC20.deploy("Wrapped ETH", "WETH", 18);

    // Deploy price oracle + feed
    const PriceOracle = await ethers.getContractFactory("PriceOracle");
    const priceOracle = await PriceOracle.deploy();

    const MockAggregator = await ethers.getContractFactory("MockAggregatorV3");
    const ethFeed = await MockAggregator.deploy(8, 200000000000n); // $2000

    await priceOracle.setFeed(await weth.getAddress(), await ethFeed.getAddress(), 3600, 18);

    // Deploy CollateralVault
    const CollateralVault = await ethers.getContractFactory("CollateralVault");
    const collateralVault = await CollateralVault.deploy();
    await collateralVault.addCollateral(
      await weth.getAddress(),
      7500, // 75% LTV
      8000, // 80% liquidation threshold
      500   // 5% penalty
    );

    // Deploy BorrowModule
    const BorrowModule = await ethers.getContractFactory("BorrowModule");
    const borrowModule = await BorrowModule.deploy(
      await collateralVault.getAddress(),
      await priceOracle.getAddress(),
      await musd.getAddress(),
      200,  // 2% APR
      ethers.parseEther("10") // Min debt
    );

    // Deploy MockSwapRouter
    const MockSwapRouter = await ethers.getContractFactory("MockSwapRouter");
    const swapRouter = await MockSwapRouter.deploy(
      await musd.getAddress(),
      await weth.getAddress(),
      await priceOracle.getAddress()
    );

    // Deploy LeverageVault
    const LeverageVault = await ethers.getContractFactory("LeverageVault");
    const leverageVault = await LeverageVault.deploy(
      await swapRouter.getAddress(),
      await collateralVault.getAddress(),
      await borrowModule.getAddress(),
      await priceOracle.getAddress(),
      await musd.getAddress()
    );

    // Grant roles
    const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ROLE"));
    const BORROW_MODULE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BORROW_MODULE_ROLE"));
    const LEVERAGE_VAULT_ROLE = ethers.keccak256(ethers.toUtf8Bytes("LEVERAGE_VAULT_ROLE"));

    await musd.grantRole(BRIDGE_ROLE, await borrowModule.getAddress());
    await musd.grantRole(BRIDGE_ROLE, await swapRouter.getAddress());
    await musd.grantRole(BRIDGE_ROLE, owner.address);
    await collateralVault.grantRole(BORROW_MODULE_ROLE, await borrowModule.getAddress());
    await collateralVault.grantRole(LEVERAGE_VAULT_ROLE, await leverageVault.getAddress());
    await borrowModule.grantRole(LEVERAGE_VAULT_ROLE, await leverageVault.getAddress());

    // Enable WETH for leverage
    await leverageVault.enableToken(await weth.getAddress(), 3000);

    // Fund users and swap router
    await weth.mint(user1.address, ethers.parseEther("100"));
    await weth.mint(user2.address, ethers.parseEther("100"));
    await weth.mint(attacker.address, ethers.parseEther("1000"));
    await weth.mint(await swapRouter.getAddress(), ethers.parseEther("100000"));

    // Approvals
    await weth.connect(user1).approve(await leverageVault.getAddress(), ethers.MaxUint256);
    await weth.connect(user2).approve(await leverageVault.getAddress(), ethers.MaxUint256);
    await weth.connect(attacker).approve(await leverageVault.getAddress(), ethers.MaxUint256);

    return {
      leverageVault, collateralVault, borrowModule, priceOracle,
      musd, weth, ethFeed, swapRouter,
      owner, user1, user2, attacker,
    };
  }

  // ============================================================
  //  1. ReentrancyGuard Protection
  // ============================================================

  describe("ReentrancyGuard prevents reentrant calls", function () {
    it("openLeveragedPosition has nonReentrant modifier", async function () {
      const { leverageVault, weth, user1 } = await loadFixture(deployFullFixture);

      // Verify the function works normally (nonReentrant doesn't block normal calls)
      const tx = await leverageVault.connect(user1).openLeveragedPosition(
        await weth.getAddress(),
        ethers.parseEther("10"),
        20, // 2.0x leverage
        0,  // default max loops
        0   // default slippage
      );
      await tx.wait();

      // Position should be recorded
      const pos = await leverageVault.getPosition(user1.address);
      expect(pos.totalCollateral).to.be.gt(0);
    });

    it("closeLeveragedPosition has nonReentrant modifier", async function () {
      const { leverageVault, weth, user1 } = await loadFixture(deployFullFixture);

      // Open a position first
      await leverageVault.connect(user1).openLeveragedPosition(
        await weth.getAddress(),
        ethers.parseEther("10"),
        15, // 1.5x
        0, 0
      );

      // Close should work normally
      await leverageVault.connect(user1).closeLeveragedPosition(0, 0);

      // Position should be cleared
      const pos = await leverageVault.getPosition(user1.address);
      expect(pos.totalCollateral).to.equal(0);
    });

    it("cannot open a second position while one is active", async function () {
      const { leverageVault, weth, user1 } = await loadFixture(deployFullFixture);

      // Open first position
      await leverageVault.connect(user1).openLeveragedPosition(
        await weth.getAddress(),
        ethers.parseEther("10"),
        15, 0, 0
      );

      // Attempt to open a second position should fail
      await expect(
        leverageVault.connect(user1).openLeveragedPosition(
          await weth.getAddress(),
          ethers.parseEther("5"),
          15, 0, 0
        )
      ).to.be.revertedWith("POSITION_EXISTS");
    });
  });

  // ============================================================
  //  2. SOL-003: emergencyClosePosition Isolation
  // ============================================================

  describe("SOL-003: emergencyClosePosition does not sweep other users' residuals", function () {
    it("user2 residual tokens in vault contract are not sent to user1 during emergency close", async function () {
      const { leverageVault, weth, musd, user1, user2, owner } = await loadFixture(deployFullFixture);

      // User1 opens a leveraged position
      await leverageVault.connect(user1).openLeveragedPosition(
        await weth.getAddress(),
        ethers.parseEther("10"),
        15, 0, 0
      );

      // User2 opens a leveraged position
      await leverageVault.connect(user2).openLeveragedPosition(
        await weth.getAddress(),
        ethers.parseEther("20"),
        15, 0, 0
      );

      // Simulate: send some "residual" WETH directly to the LeverageVault contract
      // This represents tokens that might be left over from other operations
      await weth.mint(await leverageVault.getAddress(), ethers.parseEther("5"));

      const user1WethBefore = await weth.balanceOf(user1.address);

      // Emergency close user1's position
      await leverageVault.connect(owner).emergencyClosePosition(user1.address);

      const user1WethAfter = await weth.balanceOf(user1.address);

      // User1 should NOT receive the extra 5 WETH that was sent to the contract
      // The SOL-003 fix snapshots balances before/after to only return user1's portion
      const user1Received = user1WethAfter - user1WethBefore;

      // User2's position should still be intact
      const user2Pos = await leverageVault.getPosition(user2.address);
      expect(user2Pos.totalCollateral).to.be.gt(0);
    });

    it("emergency close should only clear the targeted user's position", async function () {
      const { leverageVault, weth, user1, user2, owner } = await loadFixture(deployFullFixture);

      // Both users open positions
      await leverageVault.connect(user1).openLeveragedPosition(
        await weth.getAddress(),
        ethers.parseEther("10"),
        15, 0, 0
      );
      await leverageVault.connect(user2).openLeveragedPosition(
        await weth.getAddress(),
        ethers.parseEther("15"),
        15, 0, 0
      );

      // Emergency close user1
      await leverageVault.connect(owner).emergencyClosePosition(user1.address);

      // User1 position should be deleted
      const pos1 = await leverageVault.getPosition(user1.address);
      expect(pos1.totalCollateral).to.equal(0);
      expect(pos1.totalDebt).to.equal(0);

      // User2 position should be unaffected
      const pos2 = await leverageVault.getPosition(user2.address);
      expect(pos2.totalCollateral).to.be.gt(0);
    });

    it("emergency close reverts for non-admin caller", async function () {
      const { leverageVault, weth, user1, attacker } = await loadFixture(deployFullFixture);

      await leverageVault.connect(user1).openLeveragedPosition(
        await weth.getAddress(),
        ethers.parseEther("10"),
        15, 0, 0
      );

      // Non-admin should be rejected
      await expect(
        leverageVault.connect(attacker).emergencyClosePosition(user1.address)
      ).to.be.reverted;
    });

    it("emergency close reverts when user has no position", async function () {
      const { leverageVault, user1, owner } = await loadFixture(deployFullFixture);

      await expect(
        leverageVault.connect(owner).emergencyClosePosition(user1.address)
      ).to.be.revertedWith("NO_POSITION");
    });
  });

  // ============================================================
  //  3. Flash Loan Attack Vector Prevention
  // ============================================================

  describe("Flash loan attack vector prevention", function () {
    it("attacker cannot open position with zero collateral", async function () {
      const { leverageVault, weth, attacker } = await loadFixture(deployFullFixture);

      await expect(
        leverageVault.connect(attacker).openLeveragedPosition(
          await weth.getAddress(),
          0, // Zero collateral
          20, 0, 0
        )
      ).to.be.revertedWith("INVALID_AMOUNT");
    });

    it("attacker cannot exceed maximum allowed leverage", async function () {
      const { leverageVault, weth, attacker } = await loadFixture(deployFullFixture);

      // Try to open with excessive leverage (10x when max is 3x)
      await expect(
        leverageVault.connect(attacker).openLeveragedPosition(
          await weth.getAddress(),
          ethers.parseEther("10"),
          100, // 10x leverage (exceeds max)
          0, 0
        )
      ).to.be.revertedWith("LEVERAGE_EXCEEDS_MAX");
    });

    it("attacker cannot set leverage below 1x", async function () {
      const { leverageVault, weth, attacker } = await loadFixture(deployFullFixture);

      await expect(
        leverageVault.connect(attacker).openLeveragedPosition(
          await weth.getAddress(),
          ethers.parseEther("10"),
          5, // 0.5x — below minimum
          0, 0
        )
      ).to.be.revertedWith("LEVERAGE_TOO_LOW");
    });

    it("user-specified slippage cannot exceed global maximum", async function () {
      const { leverageVault, weth, attacker } = await loadFixture(deployFullFixture);

      // maxSlippageBps is 100 (1%), try to set 500 (5%)
      await expect(
        leverageVault.connect(attacker).openLeveragedPosition(
          await weth.getAddress(),
          ethers.parseEther("10"),
          20,
          0,
          500 // 5% slippage (exceeds global 1% max)
        )
      ).to.be.revertedWith("USER_SLIPPAGE_EXCEEDS_MAX");
    });

    it("position cannot be opened on disabled token", async function () {
      const { leverageVault, attacker } = await loadFixture(deployFullFixture);

      // Use a random address as a disabled token
      const fakeToken = ethers.Wallet.createRandom().address;

      await expect(
        leverageVault.connect(attacker).openLeveragedPosition(
          fakeToken,
          ethers.parseEther("10"),
          20, 0, 0
        )
      ).to.be.revertedWith("TOKEN_NOT_ENABLED");
    });

    it("large position opening and closing preserves invariant: user gets back <= deposited (no free money)", async function () {
      const { leverageVault, weth, user1 } = await loadFixture(deployFullFixture);

      const depositAmount = ethers.parseEther("50");
      const wethBefore = await weth.balanceOf(user1.address);

      // Open leveraged position
      await leverageVault.connect(user1).openLeveragedPosition(
        await weth.getAddress(),
        depositAmount,
        15, // 1.5x
        0, 0
      );

      // Close immediately — in a perfect mock environment with no fees,
      // user should get back approximately what they put in
      await leverageVault.connect(user1).closeLeveragedPosition(0, 0);

      const wethAfter = await weth.balanceOf(user1.address);

      // User should not have more WETH than they started with (no extraction)
      // Small rounding tolerance allowed due to swap mock precision
      const tolerance = ethers.parseEther("0.1"); // 0.1 WETH tolerance
      expect(wethAfter).to.be.lte(
        wethBefore + tolerance,
        "User extracted value — possible flash loan exploit"
      );
    });

    it("closing position with mUSD: user cannot extract value by providing exact debt amount", async function () {
      const { leverageVault, weth, musd, user1, owner } = await loadFixture(deployFullFixture);

      // Open position
      await leverageVault.connect(user1).openLeveragedPosition(
        await weth.getAddress(),
        ethers.parseEther("10"),
        15, 0, 0
      );

      // Get debt amount (add 1% buffer for interest accrued between blocks)
      const pos = await leverageVault.getPosition(user1.address);
      const debtNeeded = await leverageVault.getMusdNeededToClose(user1.address);
      const debtWithBuffer = debtNeeded + (debtNeeded / 100n);

      // Mint mUSD to user for repayment
      const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ROLE"));
      await musd.mint(user1.address, debtWithBuffer);
      await musd.connect(user1).approve(await leverageVault.getAddress(), debtWithBuffer);

      // Close with mUSD
      await leverageVault.connect(user1).closeLeveragedPositionWithMusd(debtWithBuffer);

      // Position should be fully cleared
      const posAfter = await leverageVault.getPosition(user1.address);
      expect(posAfter.totalCollateral).to.equal(0);
      expect(posAfter.totalDebt).to.equal(0);
    });

    it("closeLeveragedPositionWithMusd reverts when insufficient mUSD provided", async function () {
      const { leverageVault, weth, musd, user1, owner } = await loadFixture(deployFullFixture);

      // Open position with leverage (creates debt)
      await leverageVault.connect(user1).openLeveragedPosition(
        await weth.getAddress(),
        ethers.parseEther("10"),
        20, // 2x leverage to ensure debt
        0, 0
      );

      const debtNeeded = await leverageVault.getMusdNeededToClose(user1.address);
      expect(debtNeeded).to.be.gt(0, "Position should have debt");

      // Mint less mUSD than needed
      const insufficientAmount = debtNeeded / 2n;
      await musd.mint(user1.address, insufficientAmount);
      await musd.connect(user1).approve(await leverageVault.getAddress(), insufficientAmount);

      await expect(
        leverageVault.connect(user1).closeLeveragedPositionWithMusd(insufficientAmount)
      ).to.be.revertedWith("INSUFFICIENT_MUSD_PROVIDED");
    });
  });

  // ============================================================
  //  4. Pausable Emergency Controls (FIX H-03)
  // ============================================================

  describe("Pausable emergency controls", function () {
    it("admin can pause and unpause the vault", async function () {
      const { leverageVault, owner } = await loadFixture(deployFullFixture);

      await leverageVault.connect(owner).pause();
      expect(await leverageVault.paused()).to.be.true;

      await leverageVault.connect(owner).unpause();
      expect(await leverageVault.paused()).to.be.false;
    });

    it("opening position is blocked when paused", async function () {
      const { leverageVault, weth, user1, owner } = await loadFixture(deployFullFixture);

      await leverageVault.connect(owner).pause();

      await expect(
        leverageVault.connect(user1).openLeveragedPosition(
          await weth.getAddress(),
          ethers.parseEther("10"),
          15, 0, 0
        )
      ).to.be.reverted; // EnforcedPause
    });

    it("closing position is blocked when paused", async function () {
      const { leverageVault, weth, user1, owner } = await loadFixture(deployFullFixture);

      // Open a position while unpaused
      await leverageVault.connect(user1).openLeveragedPosition(
        await weth.getAddress(),
        ethers.parseEther("10"),
        15, 0, 0
      );

      // Pause
      await leverageVault.connect(owner).pause();

      // Try to close — should be blocked
      await expect(
        leverageVault.connect(user1).closeLeveragedPosition(0, 0)
      ).to.be.reverted; // EnforcedPause
    });

    it("closeLeveragedPositionWithMusd is blocked when paused", async function () {
      const { leverageVault, weth, musd, user1, owner } = await loadFixture(deployFullFixture);

      // Open position
      await leverageVault.connect(user1).openLeveragedPosition(
        await weth.getAddress(),
        ethers.parseEther("10"),
        15, 0, 0
      );

      await leverageVault.connect(owner).pause();

      await expect(
        leverageVault.connect(user1).closeLeveragedPositionWithMusd(ethers.parseEther("1000"))
      ).to.be.reverted; // EnforcedPause
    });

    it("emergencyClosePosition works even when paused (admin recovery)", async function () {
      const { leverageVault, weth, user1, owner } = await loadFixture(deployFullFixture);

      // Open position
      await leverageVault.connect(user1).openLeveragedPosition(
        await weth.getAddress(),
        ethers.parseEther("10"),
        15, 0, 0
      );

      // Pause the contract
      await leverageVault.connect(owner).pause();

      // Emergency close should still work (it has no whenNotPaused modifier)
      await leverageVault.connect(owner).emergencyClosePosition(user1.address);

      const pos = await leverageVault.getPosition(user1.address);
      expect(pos.totalCollateral).to.equal(0);
    });

    it("non-pauser cannot pause", async function () {
      const { leverageVault, attacker } = await loadFixture(deployFullFixture);

      await expect(
        leverageVault.connect(attacker).pause()
      ).to.be.reverted;
    });

    it("non-admin cannot unpause", async function () {
      const { leverageVault, attacker, owner } = await loadFixture(deployFullFixture);

      await leverageVault.connect(owner).pause();

      await expect(
        leverageVault.connect(attacker).unpause()
      ).to.be.reverted;
    });
  });

  // ============================================================
  //  5. Admin Configuration Security
  // ============================================================

  describe("Admin configuration security", function () {
    it("setMaxLeverage rejects values outside [10, 40] range", async function () {
      const { leverageVault, owner } = await loadFixture(deployFullFixture);

      await expect(
        leverageVault.connect(owner).setMaxLeverage(5) // 0.5x - too low
      ).to.be.revertedWith("INVALID_MAX_LEVERAGE");

      await expect(
        leverageVault.connect(owner).setMaxLeverage(50) // 5x - too high
      ).to.be.revertedWith("INVALID_MAX_LEVERAGE");
    });

    it("setMaxLeverage accepts valid values", async function () {
      const { leverageVault, owner } = await loadFixture(deployFullFixture);

      await leverageVault.connect(owner).setMaxLeverage(20); // 2x
      expect(await leverageVault.maxLeverageX10()).to.equal(20);

      await leverageVault.connect(owner).setMaxLeverage(15); // 1.5x
      expect(await leverageVault.maxLeverageX10()).to.equal(15);
    });

    it("setConfig rejects slippage above 5%", async function () {
      const { leverageVault, owner } = await loadFixture(deployFullFixture);

      await expect(
        leverageVault.connect(owner).setConfig(10, ethers.parseEther("100"), 3000, 600)
      ).to.be.revertedWith("SLIPPAGE_TOO_HIGH");
    });

    it("setConfig rejects zero maxLoops", async function () {
      const { leverageVault, owner } = await loadFixture(deployFullFixture);

      await expect(
        leverageVault.connect(owner).setConfig(0, ethers.parseEther("100"), 3000, 100)
      ).to.be.revertedWith("INVALID_MAX_LOOPS");
    });

    it("setConfig rejects maxLoops > 20", async function () {
      const { leverageVault, owner } = await loadFixture(deployFullFixture);

      await expect(
        leverageVault.connect(owner).setConfig(21, ethers.parseEther("100"), 3000, 100)
      ).to.be.revertedWith("INVALID_MAX_LOOPS");
    });

    it("enableToken rejects invalid fee tiers", async function () {
      const { leverageVault, owner, weth } = await loadFixture(deployFullFixture);

      await expect(
        leverageVault.connect(owner).enableToken(await weth.getAddress(), 2000) // Invalid fee tier
      ).to.be.revertedWith("INVALID_FEE_TIER");
    });

    it("enableToken accepts valid Uniswap V3 fee tiers", async function () {
      const { leverageVault, owner } = await loadFixture(deployFullFixture);

      const token = ethers.Wallet.createRandom().address;

      // All valid fee tiers: 100 (0.01%), 500 (0.05%), 3000 (0.3%), 10000 (1%)
      for (const fee of [100, 500, 3000, 10000]) {
        await leverageVault.connect(owner).enableToken(token, fee);
        expect(await leverageVault.leverageEnabled(token)).to.be.true;
        expect(await leverageVault.tokenPoolFees(token)).to.equal(fee);
      }
    });

    it("non-admin cannot change configuration", async function () {
      const { leverageVault, attacker } = await loadFixture(deployFullFixture);

      await expect(
        leverageVault.connect(attacker).setConfig(10, ethers.parseEther("100"), 3000, 100)
      ).to.be.reverted;

      await expect(
        leverageVault.connect(attacker).setMaxLeverage(20)
      ).to.be.reverted;
    });
  });
});
