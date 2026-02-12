// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Test.sol";
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
/// @notice Foundry invariant handler that drives protocol state transitions
/// @dev Each public function represents an action the fuzzer can call
contract ProtocolHandler is Test {
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

    address[] public actors;
    address internal currentActor;

    // Ghost variables for tracking invariants
    uint256 public ghost_totalDeposits;
    uint256 public ghost_totalBorrows;
    uint256 public ghost_totalRepaid;
    uint256 public ghost_totalLiquidated;
    uint256 public ghost_musdMinted;
    uint256 public ghost_musdBurned;

    modifier useActor(uint256 seed) {
        currentActor = actors[seed % actors.length];
        vm.startPrank(currentActor);
        _;
        vm.stopPrank();
    }

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
        MockAggregatorV3 _ethFeed
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

        // Create 5 actors
        for (uint256 i = 1; i <= 5; i++) {
            address actor = address(uint160(i * 1000));
            actors.push(actor);
        }
    }

    // ============================================================
    //                  HANDLER ACTIONS
    // ============================================================

    /// @notice Deposit WETH collateral (bounded between 0.01 and 100 WETH)
    function depositCollateral(uint256 actorSeed, uint256 amount) external useActor(actorSeed) {
        amount = bound(amount, 0.01 ether, 100 ether);

        weth.mint(currentActor, amount);
        weth.approve(address(vault), amount);
        vault.deposit(address(weth), amount);

        ghost_totalDeposits += amount;
    }

    /// @notice Borrow mUSD against deposited collateral
    function borrow(uint256 actorSeed, uint256 amount) external useActor(actorSeed) {
        amount = bound(amount, 100e18, 10_000e18); // 100 to 10k mUSD

        // Check if actor has enough collateral
        uint256 maxBorrowable = borrowModule.maxBorrow(currentActor);
        if (maxBorrowable < amount) return;

        uint256 currentDebt = borrowModule.totalDebt(currentActor);
        if (currentDebt + amount < borrowModule.minDebt()) return;

        try borrowModule.borrow(amount) {
            ghost_totalBorrows += amount;
            ghost_musdMinted += amount;
        } catch {}
    }

    /// @notice Repay mUSD debt
    function repay(uint256 actorSeed, uint256 amount) external useActor(actorSeed) {
        uint256 debt = borrowModule.totalDebt(currentActor);
        if (debt == 0) return;

        amount = bound(amount, 1e18, debt);

        // Need mUSD to repay — mint via bridge role
        vm.stopPrank();
        vm.prank(address(this));
        try musd.mint(currentActor, amount) {} catch { return; }
        vm.startPrank(currentActor);

        musd.approve(address(borrowModule), amount);
        try borrowModule.repay(amount) {
            ghost_totalRepaid += amount;
            ghost_musdBurned += amount;
        } catch {}
    }

    /// @notice Withdraw collateral (bounded to what's safe)
    function withdrawCollateral(uint256 actorSeed, uint256 amount) external useActor(actorSeed) {
        uint256 deposited = vault.deposits(currentActor, address(weth));
        if (deposited == 0) return;

        amount = bound(amount, 1, deposited);

        try borrowModule.withdrawCollateral(address(weth), amount) {
            ghost_totalDeposits -= amount;
        } catch {}
    }

    /// @notice Attempt to liquidate an actor
    function liquidate(uint256 actorSeed, uint256 targetSeed) external useActor(actorSeed) {
        address target = actors[targetSeed % actors.length];
        if (target == currentActor) return;

        uint256 debt = borrowModule.totalDebt(target);
        if (debt == 0) return;

        // Check if target is liquidatable
        try borrowModule.healthFactorUnsafe(target) returns (uint256 hf) {
            if (hf >= 10000) return;
        } catch { return; }

        uint256 liquidateAmount = debt / 2; // Close factor is 50%
        if (liquidateAmount < 100e18) return; // Min liquidation amount

        // Mint mUSD for liquidator
        vm.stopPrank();
        vm.prank(address(this));
        try musd.mint(currentActor, liquidateAmount) {} catch { return; }
        vm.startPrank(currentActor);

        musd.approve(address(liquidation), liquidateAmount);

        try liquidation.liquidate(target, address(weth), liquidateAmount) {
            ghost_totalLiquidated += liquidateAmount;
        } catch {}
    }

    /// @notice Move time forward (bounded 1 minute to 7 days)
    function warpTime(uint256 seconds_) external {
        seconds_ = bound(seconds_, 60, 7 days);
        vm.warp(block.timestamp + seconds_);
        // Refresh mock feed timestamp so oracle doesn't see stale prices after warp
        (, int256 currentPrice,,,) = ethFeed.latestRoundData();
        ethFeed.setAnswer(currentPrice);
    }

    /// @notice Change ETH price (bounded to +/- 15% of current)
    function setEthPrice(uint256 newPrice) external {
        (, int256 currentPrice,,,) = ethFeed.latestRoundData();
        uint256 current = uint256(currentPrice);
        if (current == 0) return;

        // Bound to +/- 15% to stay within circuit breaker
        uint256 lower = current * 85 / 100;
        uint256 upper = current * 115 / 100;
        if (lower == 0) lower = 1;
        newPrice = bound(newPrice, lower, upper);

        ethFeed.setAnswer(int256(newPrice));

        // Update oracle's lastKnownPrice (may revert if circuit breaker trips)
        try oracle.resetLastKnownPrice(address(weth)) {} catch {}
    }

    /// @notice Get all actor addresses for invariant checks
    function getActors() external view returns (address[] memory) {
        return actors;
    }
}
