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
import {MockERC20} from "../../contracts/mocks/MockERC20.sol";
import {MockAggregatorV3} from "../../contracts/mocks/MockAggregatorV3.sol";

/// @title ProtocolHandler
/// @notice Stateful handler for Foundry invariant testing.
/// @dev Exposes bounded protocol actions that the invariant fuzzer calls randomly.
///      Each function represents a user action (deposit, borrow, repay, liquidate, etc.)
///      The fuzzer chains these in random order to explore state space.
contract ProtocolHandler is Test {
    // ═══════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════

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

    address public admin;
    address[] public actors;
    uint256 public constant NUM_ACTORS = 5;

    // Ghost variables for invariant tracking
    uint256 public ghost_totalDeposited;
    uint256 public ghost_totalWithdrawn;
    uint256 public ghost_totalBorrowed;
    uint256 public ghost_totalRepaid;
    uint256 public ghost_totalMinted;
    uint256 public ghost_totalBurned;
    uint256 public ghost_totalSeized;
    uint256 public ghost_sharePriceAtLastDeposit;

    // Call counters
    uint256 public calls_deposit;
    uint256 public calls_withdraw;
    uint256 public calls_borrow;
    uint256 public calls_repay;
    uint256 public calls_liquidate;
    uint256 public calls_smusdDeposit;
    uint256 public calls_smusdWithdraw;

    // ═══════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(
        MUSD _musd,
        SMUSD _smusd,
        BorrowModule _borrowModule,
        CollateralVault _vault,
        LiquidationEngine _liquidation,
        PriceOracle _oracle,
        InterestRateModel _irm,
        MockERC20 _usdc,
        MockERC20 _weth,
        MockAggregatorV3 _ethFeed,
        address _admin
    ) {
        musd = _musd;
        smusd = _smusd;
        borrowModule = _borrowModule;
        vault = _vault;
        liquidation = _liquidation;
        oracle = _oracle;
        irm = _irm;
        usdc = _usdc;
        weth = _weth;
        ethFeed = _ethFeed;
        admin = _admin;

        // Create actor addresses
        for (uint256 i = 0; i < NUM_ACTORS; i++) {
            actors.push(address(uint160(0x1000 + i)));
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function _getActor(uint256 seed) internal view returns (address) {
        return actors[seed % NUM_ACTORS];
    }

    // ═══════════════════════════════════════════════════════════════════
    // HANDLER ACTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Deposit WETH collateral
    function depositCollateral(uint256 actorSeed, uint256 amount) external {
        address actor = _getActor(actorSeed);
        amount = bound(amount, 1e15, 100e18); // 0.001 to 100 ETH

        weth.mint(actor, amount);

        vm.startPrank(actor);
        weth.approve(address(vault), amount);
        vault.deposit(address(weth), amount);
        vm.stopPrank();

        ghost_totalDeposited += amount;
        calls_deposit++;
    }

    /// @notice Withdraw WETH collateral
    function withdrawCollateral(uint256 actorSeed, uint256 amount) external {
        address actor = _getActor(actorSeed);
        uint256 deposited = vault.deposits(actor, address(weth));
        if (deposited == 0) return;

        amount = bound(amount, 1, deposited);

        vm.startPrank(actor);
        try borrowModule.withdrawCollateral(address(weth), amount) {
            ghost_totalWithdrawn += amount;
            calls_withdraw++;
        } catch {
            // Health factor check may prevent withdrawal
        }
        vm.stopPrank();
    }

    /// @notice Borrow mUSD against collateral
    function borrow(uint256 actorSeed, uint256 amount) external {
        address actor = _getActor(actorSeed);
        uint256 deposited = vault.deposits(actor, address(weth));
        if (deposited == 0) return;

        // ETH at ~$2000, 75% LTV, conservative bound
        uint256 maxBorrow = (deposited * 2000 * 7500) / (10000 * 1e18) * 1e18;
        uint256 existingDebt = borrowModule.totalDebt(actor);
        if (maxBorrow <= existingDebt) return;

        uint256 available = maxBorrow - existingDebt;
        amount = bound(amount, 100e18, available);
        if (amount < 100e18) return; // min debt

        vm.prank(actor);
        try borrowModule.borrow(amount) {
            ghost_totalBorrowed += amount;
            calls_borrow++;
        } catch {
            // May fail due to health factor
        }
    }

    /// @notice Repay mUSD debt
    function repay(uint256 actorSeed, uint256 amount) external {
        address actor = _getActor(actorSeed);
        uint256 debt = borrowModule.totalDebt(actor);
        if (debt == 0) return;

        amount = bound(amount, 1, debt);

        // Give actor mUSD to repay
        vm.prank(admin);
        musd.mint(actor, amount);

        vm.startPrank(actor);
        musd.approve(address(borrowModule), amount);
        try borrowModule.repay(amount) {
            ghost_totalRepaid += amount;
            calls_repay++;
        } catch {}
        vm.stopPrank();
    }

    /// @notice Deposit mUSD into sMUSD vault
    function smusdDeposit(uint256 actorSeed, uint256 amount) external {
        address actor = _getActor(actorSeed);
        amount = bound(amount, 1e18, 100_000e18);

        vm.prank(admin);
        musd.mint(actor, amount);

        vm.startPrank(actor);
        musd.approve(address(smusd), amount);
        uint256 priceBefore = smusd.totalSupply() > 0
            ? smusd.convertToAssets(1e18)
            : 1e18;

        try smusd.deposit(amount, actor) {
            ghost_totalMinted += amount;
            calls_smusdDeposit++;

            uint256 priceAfter = smusd.convertToAssets(1e18);
            // Track share price -- it should never decrease on deposit
            ghost_sharePriceAtLastDeposit = priceAfter;
            assert(priceAfter >= priceBefore);
        } catch {}
        vm.stopPrank();
    }

    /// @notice Redeem sMUSD shares
    function smusdRedeem(uint256 actorSeed, uint256 shares) external {
        address actor = _getActor(actorSeed);
        uint256 balance = smusd.balanceOf(actor);
        if (balance == 0) return;

        shares = bound(shares, 1, balance);

        vm.startPrank(actor);
        // Must pass cooldown (25 hours)
        vm.warp(block.timestamp + 25 hours);
        try smusd.redeem(shares, actor, actor) returns (uint256 assets) {
            ghost_totalBurned += assets;
            calls_smusdWithdraw++;
        } catch {}
        vm.stopPrank();
    }

    /// @notice Attempt liquidation (crash price first)
    function liquidate(uint256 actorSeed, uint256 liquidatorSeed) external {
        address actor = _getActor(actorSeed);
        address liquidator = _getActor(liquidatorSeed);
        uint256 debt = borrowModule.totalDebt(actor);
        if (debt == 0) return;

        // Drop price to trigger liquidation
        ethFeed.setAnswer(500e8); // ETH drops to $500

        uint256 repayAmount = (debt * 5000) / 10000; // 50% close factor

        vm.prank(admin);
        musd.mint(liquidator, repayAmount);

        vm.startPrank(liquidator);
        musd.approve(address(liquidation), repayAmount);
        try liquidation.liquidate(actor, address(weth), repayAmount) {
            ghost_totalSeized += repayAmount;
            calls_liquidate++;
        } catch {}
        vm.stopPrank();

        // Restore price for next actions
        ethFeed.setAnswer(2000e8);
    }

    /// @notice Warp time forward (for interest accrual)
    function warpTime(uint256 seconds_) external {
        seconds_ = bound(seconds_, 1, 7 days);
        vm.warp(block.timestamp + seconds_);
        // Refresh mock feed so oracle doesn't see stale prices
        ethFeed.setAnswer(2000e8);
    }
}
