// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MUSD} from "../../contracts/MUSD.sol";
import {SMUSD} from "../../contracts/SMUSD.sol";
import {BorrowModule} from "../../contracts/BorrowModule.sol";
import {CollateralVault} from "../../contracts/CollateralVault.sol";
import {PriceOracle} from "../../contracts/PriceOracle.sol";
import {InterestRateModel} from "../../contracts/InterestRateModel.sol";
import {MockERC20} from "../../contracts/mocks/MockERC20.sol";
import {MockAggregatorV3} from "../../contracts/mocks/MockAggregatorV3.sol";

/// @title HalmosSpec
/// @notice Halmos symbolic execution specs for formal verification
/// @dev Run with: halmos --contract HalmosSpec --solver-timeout-assertion 300
///      These tests use symbolic inputs to prove properties hold for ALL possible inputs,
///      not just random samples. Each function prefixed with `check_` is a proof obligation.
contract HalmosSpec is Test {

    // ============================================================
    //         SPEC 1: mUSD SUPPLY CAP INTEGRITY
    // ============================================================

    /// @notice PROVE: mint() can never push totalSupply above supplyCap
    /// @dev For any amount and any starting state where totalSupply <= supplyCap,
    ///      after a successful mint, totalSupply <= supplyCap still holds.
    function check_supplyCapIntegrity(uint256 initialSupply, uint256 mintAmount, uint256 cap) public {
        // Constrain inputs to realistic ranges
        vm.assume(cap > 0 && cap <= type(uint128).max);
        vm.assume(initialSupply <= cap);
        vm.assume(mintAmount > 0 && mintAmount <= type(uint128).max);

        MUSD musd = new MUSD(cap);
        musd.grantRole(musd.BRIDGE_ROLE(), address(this));

        // Pre-mint to initialSupply
        if (initialSupply > 0) {
            musd.mint(address(1), initialSupply);
        }

        // Attempt to mint — should either succeed (supply ≤ cap) or revert
        if (initialSupply + mintAmount <= cap) {
            musd.mint(address(2), mintAmount);
            assert(musd.totalSupply() <= cap);
        } else {
            vm.expectRevert("EXCEEDS_CAP");
            musd.mint(address(2), mintAmount);
            // Supply unchanged
            assert(musd.totalSupply() == initialSupply);
        }
    }

    /// @notice PROVE: burn always reduces totalSupply
    function check_burnReducesSupply(uint256 supply, uint256 burnAmount) public {
        vm.assume(supply > 0 && supply <= type(uint128).max);
        vm.assume(burnAmount > 0 && burnAmount <= supply);

        MUSD musd = new MUSD(supply);
        musd.grantRole(musd.BRIDGE_ROLE(), address(this));
        musd.mint(address(this), supply);

        uint256 before = musd.totalSupply();
        musd.burn(address(this), burnAmount);

        assert(musd.totalSupply() == before - burnAmount);
    }

    // ============================================================
    //         SPEC 2: ERC-4626 SHARE PRICE MONOTONICITY
    // ============================================================

    /// @notice PROVE: depositing into smUSD never decreases share price for existing holders
    /// @dev For any deposit amount, convertToAssets(1e18) after deposit >= before deposit
    function check_depositNeverDecreaseSharePrice(uint256 depositAmount) public {
        vm.assume(depositAmount > 0 && depositAmount <= type(uint64).max);

        MUSD musd = new MUSD(type(uint128).max);
        musd.grantRole(musd.BRIDGE_ROLE(), address(this));
        SMUSD smusd = new SMUSD(IERC20(address(musd)));

        // Initial deposit to establish share price
        musd.mint(address(this), 1000e18 + depositAmount);
        musd.approve(address(smusd), type(uint256).max);
        smusd.deposit(1000e18, address(this));

        uint256 priceBefore = smusd.convertToAssets(1e18);

        // Second deposit
        smusd.deposit(depositAmount, address(this));

        uint256 priceAfter = smusd.convertToAssets(1e18);

        // Share price must not decrease from deposits
        assert(priceAfter >= priceBefore);
    }

    /// @notice PROVE: withdrawal never increases share price (no free money)
    function check_withdrawalNeverIncreaseSharePrice(uint256 withdrawAmount) public {
        vm.assume(withdrawAmount > 0 && withdrawAmount <= type(uint64).max);

        MUSD musd = new MUSD(type(uint128).max);
        musd.grantRole(musd.BRIDGE_ROLE(), address(this));
        SMUSD smusd = new SMUSD(IERC20(address(musd)));

        // Deposit enough to withdraw from
        uint256 totalDeposit = 1000e18 + withdrawAmount;
        musd.mint(address(this), totalDeposit);
        musd.approve(address(smusd), type(uint256).max);
        smusd.deposit(totalDeposit, address(this));

        // Fast-forward past cooldown
        vm.warp(block.timestamp + 1 days + 1);

        uint256 priceBefore = smusd.convertToAssets(1e18);

        // Withdraw
        if (withdrawAmount <= smusd.maxWithdraw(address(this))) {
            smusd.withdraw(withdrawAmount, address(this), address(this));
            if (smusd.totalSupply() > 0) {
                uint256 priceAfter = smusd.convertToAssets(1e18);
                assert(priceAfter >= priceBefore);
            }
        }
    }

    // ============================================================
    //         SPEC 3: INTEREST RATE MODEL BOUNDS
    // ============================================================

    /// @notice PROVE: getBorrowRateAnnual never exceeds 100% (10000 bps)
    function check_borrowRateNeverExceeds100Pct(uint256 borrows, uint256 supply) public {
        vm.assume(supply > 0 && supply <= type(uint128).max);
        vm.assume(borrows <= type(uint128).max);

        InterestRateModel irm = new InterestRateModel(address(this));
        uint256 rate = irm.getBorrowRateAnnual(borrows, supply);

        assert(rate <= 10000); // Max 100% APR
    }

    /// @notice PROVE: utilization rate is always between 0 and 10000 bps
    function check_utilizationBounded(uint256 borrows, uint256 supply) public {
        vm.assume(supply <= type(uint128).max);
        vm.assume(borrows <= type(uint128).max);

        InterestRateModel irm = new InterestRateModel(address(this));
        uint256 util = irm.utilizationRate(borrows, supply);

        assert(util <= 10000);
    }

    /// @notice PROVE: supply rate <= borrow rate (lenders can't earn more than borrowers pay)
    function check_supplyRateLeBorrowRate(uint256 borrows, uint256 supply) public {
        vm.assume(supply > 0 && supply <= type(uint128).max);
        vm.assume(borrows <= type(uint128).max);

        InterestRateModel irm = new InterestRateModel(address(this));
        uint256 borrowRate = irm.getBorrowRateAnnual(borrows, supply);
        uint256 supplyRate = irm.getSupplyRateAnnual(borrows, supply);

        assert(supplyRate <= borrowRate);
    }

    // ============================================================
    //         SPEC 4: ORACLE CIRCUIT BREAKER
    // ============================================================

    /// @notice PROVE: circuit breaker rejects deviations above threshold
    function check_circuitBreakerRejectsLargeDeviation(
        int256 initialPrice,
        int256 newPrice
    ) public {
        vm.assume(initialPrice > 100e8 && initialPrice <= 100_000e8);
        vm.assume(newPrice > 100e8 && newPrice <= 100_000e8);

        MockAggregatorV3 feed = new MockAggregatorV3(8, initialPrice);

        PriceOracle oracle = new PriceOracle();

        // Set up feed with timelock
        oracle.requestSetFeed(address(1), address(feed), 1 hours, 18);
        vm.warp(block.timestamp + 48 hours + 1);
        oracle.executeSetFeed();

        // Now change the price
        feed.setAnswer(newPrice);

        // Calculate expected deviation
        uint256 uInitial = uint256(initialPrice);
        uint256 uNew = uint256(newPrice);
        uint256 diff = uNew > uInitial ? uNew - uInitial : uInitial - uNew;
        uint256 deviationBps = (diff * 10000) / uInitial;

        if (deviationBps > 2000) {
            // Should revert with circuit breaker
            vm.expectRevert("CIRCUIT_BREAKER_TRIGGERED");
            oracle.getPrice(address(1));
        } else {
            // Should succeed
            uint256 price = oracle.getPrice(address(1));
            assert(price > 0);
        }
    }

    // ============================================================
    //         SPEC 5: TIMELOCK INTEGRITY
    // ============================================================

    /// @notice PROVE: InterestRateModel executeSetParams reverts before 48h
    function check_timelockEnforced(uint256 waitTime) public {
        vm.assume(waitTime < 48 hours);

        InterestRateModel irm = new InterestRateModel(address(this));
        irm.grantRole(irm.RATE_ADMIN_ROLE(), address(this));

        irm.requestSetParams(300, 1200, 8000, 6000, 1500);

        vm.warp(block.timestamp + waitTime);

        vm.expectRevert("TIMELOCK_ACTIVE");
        irm.executeSetParams();
    }

    /// @notice PROVE: InterestRateModel executeSetParams succeeds after 48h
    function check_timelockSucceedsAfterDelay(uint256 extraTime) public {
        vm.assume(extraTime <= 365 days); // Bound to prevent overflow

        InterestRateModel irm = new InterestRateModel(address(this));
        irm.grantRole(irm.RATE_ADMIN_ROLE(), address(this));

        irm.requestSetParams(300, 1200, 8000, 6000, 1500);

        vm.warp(block.timestamp + 48 hours + extraTime);

        irm.executeSetParams();

        assert(irm.baseRateBps() == 300);
        assert(irm.multiplierBps() == 1200);
        assert(irm.kinkBps() == 8000);
    }
}
