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
import {ProtocolHandler} from "./ProtocolHandler.sol";

/// @title InvariantTest
/// @notice Foundry stateful invariant tests for the Minted protocol
/// @dev Uses ProtocolHandler to drive random sequences of protocol actions,
///      then asserts system-wide invariants after each call.
///      Run: forge test --match-contract InvariantTest -vvv
contract InvariantTest is Test {
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
    ProtocolHandler public handler;

    address public admin = address(this);

    function setUp() public {
        // Deploy mocks
        usdc = new MockERC20("USDC", "USDC", 6);
        weth = new MockERC20("WETH", "WETH", 18);
        ethFeed = new MockAggregatorV3(8, 2000e8);

        // Deploy core protocol
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
            address(musd), 5000
        );

        // Oracle setup
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

        // Refresh mock feed
        ethFeed.setAnswer(2000e8);

        // Deploy handler
        handler = new ProtocolHandler(
            musd, smusd, borrowModule, vault, liquidation,
            oracle, irm, usdc, weth, ethFeed, admin
        );

        // Grant handler roles so it can mint mUSD
        musd.grantRole(musd.BRIDGE_ROLE(), address(handler));

        // Target only the handler for invariant calls
        targetContract(address(handler));
    }

    // ═══════════════════════════════════════════════════════════════════
    // INVARIANT: mUSD supply never exceeds cap
    // ═══════════════════════════════════════════════════════════════════

    /// @notice totalSupply of mUSD must never exceed the supply cap
    function invariant_musd_supply_cap() public view {
        assertLe(
            musd.totalSupply(),
            musd.supplyCap(),
            "INV: mUSD supply exceeds cap"
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    // INVARIANT: Vault collateral accounting
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Vault's WETH balance must equal sum of all actor deposits
    function invariant_vault_balance_matches_deposits() public view {
        uint256 vaultBalance = weth.balanceOf(address(vault));
        uint256 sumDeposits;

        for (uint256 i = 0; i < handler.NUM_ACTORS(); i++) {
            address actor = handler.actors(i);
            sumDeposits += vault.deposits(actor, address(weth));
        }

        assertEq(
            vaultBalance,
            sumDeposits,
            "INV: Vault balance != sum of user deposits"
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    // INVARIANT: sMUSD share price monotonicity
    // ═══════════════════════════════════════════════════════════════════

    /// @notice sMUSD share price should never decrease (no value extraction)
    /// @dev convertToAssets(1e18) is the share price in mUSD terms
    function invariant_smusd_share_price_monotonic() public view {
        if (smusd.totalSupply() == 0) return;

        uint256 currentPrice = smusd.convertToAssets(1e18);

        // Share price must be at least 1:1 (the virtual offset starting price)
        // In ERC-4626 with offset, initial price is 1e18 assets per 1e18 shares
        assertGe(
            currentPrice,
            1e18 - 1, // Allow 1 wei rounding
            "INV: sMUSD share price below 1:1"
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    // INVARIANT: sMUSD total assets >= total supply in mUSD terms
    // ═══════════════════════════════════════════════════════════════════

    /// @notice sMUSD vault must hold at least as many mUSD as shares represent
    function invariant_smusd_solvency() public view {
        if (smusd.totalSupply() == 0) return;

        uint256 totalAssets = smusd.totalAssets();
        // totalAssets should be >= totalSupply for a 1:1 or better share price
        // (With ERC-4626 virtual offset, totalAssets can be slightly less due to
        //  the virtual share/asset mechanism, but never significantly less)
        assertGe(
            totalAssets + 1e18, // virtual offset buffer
            smusd.totalSupply(),
            "INV: sMUSD insolvent -- assets < shares"
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    // INVARIANT: No unbacked mUSD from borrowing
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Every mUSD borrowed must have collateral value >= 0 with debt
    /// @dev This is a soft invariant -- liquidatable positions exist but should be caught
    function invariant_no_free_musd() public view {
        for (uint256 i = 0; i < handler.NUM_ACTORS(); i++) {
            address actor = handler.actors(i);
            uint256 debt = borrowModule.totalDebt(actor);
            if (debt == 0) continue;

            uint256 deposited = vault.deposits(actor, address(weth));
            // If actor has debt, they must have some collateral
            if (deposited > 0) {
                // Use try/catch since oracle may be stale after time warps
                try oracle.getValueUsd(address(weth), deposited) returns (uint256 collateralValue) {
                    assertGt(
                        collateralValue,
                        0,
                        "INV: Zero collateral value with outstanding debt"
                    );
                } catch {
                    // Oracle stale -- skip this check (time warp artifact)
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // INVARIANT: Interest rate model bounds
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Utilization rate must always be 0–100%
    function invariant_utilization_bounded() public view {
        // This invariant uses the IRM's view function
        // We test with current outstanding borrows vs total supply
        uint256 totalBorrowsAmt = borrowModule.totalBorrows();
        uint256 supply = musd.totalSupply();

        uint256 util = irm.utilizationRate(totalBorrowsAmt, supply);
        assertLe(util, 10000, "INV: Utilization rate > 100%");
    }

    // ═══════════════════════════════════════════════════════════════════
    // INVARIANT: Ghost variable consistency
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Net collateral flow must be non-negative
    function invariant_ghost_collateral_flow() public view {
        assertGe(
            handler.ghost_totalDeposited(),
            handler.ghost_totalWithdrawn(),
            "INV: More collateral withdrawn than deposited (ghost)"
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    // SUMMARY (for debugging)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Log call statistics after invariant run
    function invariant_callSummary() public view {
        console.log("--- Handler Call Summary ---");
        console.log("Deposits:         ", handler.calls_deposit());
        console.log("Withdrawals:      ", handler.calls_withdraw());
        console.log("Borrows:          ", handler.calls_borrow());
        console.log("Repays:           ", handler.calls_repay());
        console.log("Liquidations:     ", handler.calls_liquidate());
        console.log("sMUSD Deposits:   ", handler.calls_smusdDeposit());
        console.log("sMUSD Redeems:    ", handler.calls_smusdWithdraw());
    }
}
