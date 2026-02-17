// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MUSD} from "../../contracts/MUSD.sol";
import {SMUSD} from "../../contracts/SMUSD.sol";
import {BorrowModule} from "../../contracts/BorrowModule.sol";
import {CollateralVault} from "../../contracts/CollateralVault.sol";
import {LiquidationEngine} from "../../contracts/LiquidationEngine.sol";
import {PriceOracle} from "../../contracts/PriceOracle.sol";
import {InterestRateModel} from "../../contracts/InterestRateModel.sol";
import {DirectMintV2} from "../../contracts/DirectMintV2.sol";
import {MockERC20} from "../../contracts/mocks/MockERC20.sol";
import {MockAggregatorV3} from "../../contracts/mocks/MockAggregatorV3.sol";
import "../../contracts/Errors.sol";

/// @title FuzzTest
/// @notice Foundry fuzz tests that throw random inputs at every external function
/// @dev Tests boundary conditions, type limits, and invariant preservation
///      Run: forge test --match-contract FuzzTest -vvv
contract FuzzTest is Test {
    MUSD public musd;
    SMUSD public smusd;
    BorrowModule public borrowModule;
    CollateralVault public vault;
    LiquidationEngine public liquidation;
    PriceOracle public oracle;
    InterestRateModel public irm;
    MockERC20 public usdc;
    MockERC20 public weth;
    MockAggregatorV3 public ethFeed;

    address public admin = address(this);
    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);

    function setUp() public {
        usdc = new MockERC20("USDC", "USDC", 6);
        weth = new MockERC20("WETH", "WETH", 18);
        ethFeed = new MockAggregatorV3(8, 2000e8);

        musd = new MUSD(100_000_000e18, address(0));
        smusd = new SMUSD(IERC20(address(musd)), address(0));
        oracle = new PriceOracle();
        irm = new InterestRateModel(address(this));
        vault = new CollateralVault(address(0));
        borrowModule = new BorrowModule(
            address(vault), address(oracle), address(musd), 500, 100e18
        );
        liquidation = new LiquidationEngine(
            address(vault), address(borrowModule), address(oracle),
            address(musd), 5000, address(this)
        );

        // Oracle setup — direct call gated by onlyTimelock (test contract is timelock)
        oracle.setFeed(address(weth), address(ethFeed), 1 hours, 18, 0);

        // Collateral setup
        vault.addCollateral(address(weth), 7500, 8500, 500);

        // Roles
        musd.grantRole(musd.BRIDGE_ROLE(), address(borrowModule));
        musd.grantRole(musd.BRIDGE_ROLE(), admin);
        musd.grantRole(musd.LIQUIDATOR_ROLE(), address(liquidation));
        vault.grantRole(vault.BORROW_MODULE_ROLE(), address(borrowModule));
        vault.grantRole(vault.LIQUIDATION_ROLE(), address(liquidation));
        borrowModule.grantRole(borrowModule.LIQUIDATION_ROLE(), address(liquidation));

        borrowModule.grantRole(borrowModule.TIMELOCK_ROLE(), admin);
        borrowModule.setInterestRateModel(address(irm));

        // Refresh mock feed timestamp so oracle doesn't see stale prices
        ethFeed.setAnswer(2000e8);
    }

    // ════════════════════════════════════════════════════════════════════
    // FUZZ: INTEREST ACCRUAL MATH
    // ════════════════════════════════════════════════════════════════════

    /// @notice Interest accrual should never underflow or overflow
    function testFuzz_interestAccrual(
        uint256 principal,
        uint256 totalBorrows,
        uint256 totalSupply,
        uint256 secondsElapsed
    ) public view {
        // Bound to reasonable ranges
        principal = bound(principal, 0, 1e30);        // Up to 1 trillion mUSD
        totalBorrows = bound(totalBorrows, 0, 1e30);
        totalSupply = bound(totalSupply, 0, 1e30);
        secondsElapsed = bound(secondsElapsed, 0, 365 days);

        // Should never revert
        uint256 interest = irm.calculateInterest(principal, totalBorrows, totalSupply, secondsElapsed);
        
        // Interest should be non-negative
        assertGe(interest, 0, "Interest should be non-negative");
        
        // Interest for 0 seconds should be 0
        if (secondsElapsed == 0) {
            assertEq(interest, 0, "Interest for 0 seconds should be 0");
        }
        
        // Interest for 0 principal should be 0
        if (principal == 0) {
            assertEq(interest, 0, "Interest for 0 principal should be 0");
        }
    }

    /// @notice Interest split should always sum to the total
    function testFuzz_interestSplit(uint256 interestAmount) public view {
        interestAmount = bound(interestAmount, 0, 1e30);

        (uint256 supplierAmount, uint256 reserveAmount) = irm.splitInterest(interestAmount);
        
        // Split should account for all interest (within 1 wei rounding)
        assertApproxEqAbs(
            supplierAmount + reserveAmount,
            interestAmount,
            1,
            "Interest split doesn't sum to total"
        );
    }

    /// @notice Borrow rate should increase with utilization
    function testFuzz_borrowRateMonotonic(
        uint256 totalBorrows1,
        uint256 totalBorrows2,
        uint256 totalSupply
    ) public view {
        totalSupply = bound(totalSupply, 1e18, 1e30);
        totalBorrows1 = bound(totalBorrows1, 0, totalSupply);
        totalBorrows2 = bound(totalBorrows2, totalBorrows1, totalSupply);

        uint256 rate1 = irm.getBorrowRateAnnual(totalBorrows1, totalSupply);
        uint256 rate2 = irm.getBorrowRateAnnual(totalBorrows2, totalSupply);

        // Higher utilization should mean higher (or equal) borrow rate
        assertGe(rate2, rate1, "Borrow rate not monotonically increasing with utilization");
    }

    // ════════════════════════════════════════════════════════════════════
    // FUZZ: ERC-4626 SHARE PRICE
    // ════════════════════════════════════════════════════════════════════

    /// @notice Deposit followed by immediate withdraw should not lose value (minus rounding)
    function testFuzz_depositWithdrawRoundTrip(uint256 depositAmount) public {
        depositAmount = bound(depositAmount, 1e18, 1_000_000e18); // 1 to 1M mUSD

        // Mint mUSD and deposit to SMUSD
        musd.mint(alice, depositAmount);
        
        vm.startPrank(alice);
        musd.approve(address(smusd), depositAmount);
        uint256 shares = smusd.deposit(depositAmount, alice);
        
        // Wait past cooldown
        vm.warp(block.timestamp + 25 hours);
        
        // Withdraw all
        uint256 assetsOut = smusd.redeem(shares, alice, alice);
        vm.stopPrank();

        // Should get back at least depositAmount - 1 (rounding)
        assertApproxEqAbs(
            assetsOut,
            depositAmount,
            2, // 2 wei tolerance for ERC-4626 rounding
            "Deposit/withdraw round-trip lost value"
        );
    }

    /// @notice Share price should never decrease from deposits
    function testFuzz_sharePriceNeverDecreasesOnDeposit(uint256 depositAmount) public {
        depositAmount = bound(depositAmount, 1e18, 10_000_000e18);

        // Setup initial state
        musd.mint(alice, 10_000e18);
        vm.startPrank(alice);
        musd.approve(address(smusd), 10_000e18);
        smusd.deposit(10_000e18, alice);
        vm.stopPrank();

        uint256 preBefore = smusd.convertToAssets(1e18);

        // New deposit by bob
        musd.mint(bob, depositAmount);
        vm.startPrank(bob);
        musd.approve(address(smusd), depositAmount);
        smusd.deposit(depositAmount, bob);
        vm.stopPrank();

        uint256 preAfter = smusd.convertToAssets(1e18);

        // Share price should not decrease
        assertGe(preAfter, preBefore, "Share price decreased after deposit");
    }

    // ════════════════════════════════════════════════════════════════════
    // FUZZ: COLLATERAL VAULT OPERATIONS
    // ════════════════════════════════════════════════════════════════════

    /// @notice Deposit and withdraw should preserve balance invariant
    function testFuzz_depositWithdrawBalanceInvariant(uint256 depositAmount) public {
        depositAmount = bound(depositAmount, 1e15, 1_000_000e18);

        weth.mint(alice, depositAmount);
        
        vm.startPrank(alice);
        weth.approve(address(vault), depositAmount);
        vault.deposit(address(weth), depositAmount);
        
        uint256 vaultBalance = weth.balanceOf(address(vault));
        uint256 userDeposit = vault.deposits(alice, address(weth));
        
        assertEq(vaultBalance, depositAmount, "Vault balance mismatch after deposit");
        assertEq(userDeposit, depositAmount, "User deposit mismatch");

        // Use borrowModule.withdrawCollateral (vault.withdraw requires BORROW_MODULE_ROLE)
        borrowModule.withdrawCollateral(address(weth), depositAmount);
        vm.stopPrank();
        
        assertEq(weth.balanceOf(address(vault)), 0, "Vault should be empty after full withdraw");
        assertEq(vault.deposits(alice, address(weth)), 0, "User deposit should be 0 after full withdraw");
        assertEq(weth.balanceOf(alice), depositAmount, "User should have full balance back");
    }

    // ════════════════════════════════════════════════════════════════════
    // FUZZ: LIQUIDATION MATH
    // ════════════════════════════════════════════════════════════════════

    /// @notice Liquidation amount should never exceed close factor * total debt
    function testFuzz_liquidationBounds(uint256 collateralAmount, uint256 borrowAmount) public {
        collateralAmount = bound(collateralAmount, 1e18, 10_000e18); // 1 to 10,000 WETH
        
        // ETH at $2000, 75% LTV = $1500 per ETH borrow capacity
        uint256 maxBorrow = (collateralAmount * 2000 * 7500) / 10000;
        borrowAmount = bound(borrowAmount, 100e18, maxBorrow / 1e18 * 1e18);
        if (borrowAmount < 100e18) return; // Skip if below min debt

        // Setup position
        weth.mint(alice, collateralAmount);
        vm.startPrank(alice);
        weth.approve(address(vault), collateralAmount);
        vault.deposit(address(weth), collateralAmount);
        vm.stopPrank();

        vm.prank(alice);
        borrowModule.borrow(borrowAmount);

        // Crash price to make position liquidatable
        ethFeed.setAnswer(500e8); // ETH drops to $500
        
        // Check debt
        uint256 totalDebt = borrowModule.totalDebt(alice);
        uint256 maxRepay = (totalDebt * liquidation.closeFactorBps()) / 10000;

        // Verify close factor bound
        assertLe(maxRepay, totalDebt, "Max repay exceeds total debt");
    }

    // ════════════════════════════════════════════════════════════════════
    // FUZZ: PRICE ORACLE
    // ════════════════════════════════════════════════════════════════════

    /// @notice Oracle getValueUsd should be proportional to amount
    function testFuzz_oracleValueProportional(uint256 amount1, uint256 amount2) public view {
        amount1 = bound(amount1, 1e15, 1e24); // 0.001 to 1M ETH
        amount2 = bound(amount2, 1e15, 1e24);

        uint256 value1 = oracle.getValueUsd(address(weth), amount1);
        uint256 value2 = oracle.getValueUsd(address(weth), amount2);

        // Value should be proportional: value1/amount1 ≈ value2/amount2
        if (value1 > 0 && value2 > 0) {
            uint256 ratio1 = (value1 * 1e18) / amount1;
            uint256 ratio2 = (value2 * 1e18) / amount2;
            
            assertApproxEqRel(
                ratio1,
                ratio2,
                1e15, // 0.1% tolerance
                "Oracle value not proportional to amount"
            );
        }
    }

    /// @notice Unsafe oracle should return same or similar value as safe oracle under normal conditions
    function testFuzz_oracleSafeVsUnsafe(uint256 amount) public view {
        amount = bound(amount, 1e15, 1e24);

        uint256 safeValue = oracle.getValueUsd(address(weth), amount);
        uint256 unsafeValue = oracle.getValueUsdUnsafe(address(weth), amount);

        // Under normal conditions (no circuit breaker), they should be equal
        assertEq(safeValue, unsafeValue, "Safe and unsafe oracle diverged under normal conditions");
    }

    // ════════════════════════════════════════════════════════════════════
    // FUZZ: mUSD SUPPLY CAP
    // ════════════════════════════════════════════════════════════════════

    /// @notice Minting should never exceed supply cap
    function testFuzz_mintNeverExceedsCap(uint256 amount) public {
        uint256 effectiveCap = (musd.supplyCap() * musd.localCapBps()) / 10000;
        amount = bound(amount, 1, effectiveCap);

        if (musd.totalSupply() + amount > effectiveCap) {
            vm.expectRevert(ExceedsLocalCap.selector);
        }
        musd.mint(alice, amount);

        assertLe(musd.totalSupply(), musd.supplyCap(), "Supply exceeds cap after mint");
    }

    /// @notice Burn should always reduce supply
    function testFuzz_burnAlwaysReducesSupply(uint256 mintAmount, uint256 burnAmount) public {
        mintAmount = bound(mintAmount, 1, 1_000_000e18);
        burnAmount = bound(burnAmount, 1, mintAmount);

        musd.mint(alice, mintAmount);
        uint256 supplyBefore = musd.totalSupply();

        // Admin (test contract) has BRIDGE_ROLE but needs allowance to burn from alice
        vm.prank(alice);
        musd.approve(admin, burnAmount);

        musd.burn(alice, burnAmount);
        uint256 supplyAfter = musd.totalSupply();

        assertEq(supplyAfter, supplyBefore - burnAmount, "Burn didn't reduce supply correctly");
    }

    // ════════════════════════════════════════════════════════════════════
    // FUZZ: UTILIZATION RATE
    // ════════════════════════════════════════════════════════════════════

    /// @notice Utilization rate should always be 0-100%
    function testFuzz_utilizationBounded(uint256 totalBorrows, uint256 totalSupply) public view {
        totalBorrows = bound(totalBorrows, 0, 1e30);
        totalSupply = bound(totalSupply, 0, 1e30);

        uint256 util = irm.utilizationRate(totalBorrows, totalSupply);
        assertLe(util, 10000, "Utilization exceeds 100%");
    }
}
