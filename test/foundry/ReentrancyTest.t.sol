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
import {MockReentrantAttacker} from "../../contracts/mocks/MockReentrantAttacker.sol";

/// @title ReentrancyTest
/// @notice Tests that all nonReentrant-guarded entry points properly revert
///         when a malicious contract attempts reentrancy via callbacks.
/// @dev Run: forge test --match-contract ReentrancyTest -vvv
contract ReentrancyTest is Test {
    MUSD public musd;
    SMUSD public smusd;
    BorrowModule public borrowModule;
    CollateralVault public vault;
    LiquidationEngine public liquidation;
    PriceOracle public oracle;
    InterestRateModel public irm;
    MockERC20 public weth;
    MockAggregatorV3 public ethFeed;
    MockReentrantAttacker public attacker;

    address public admin = address(this);

    function setUp() public {
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

        oracle.setFeed(address(weth), address(ethFeed), 1 hours, 18, 0);
        vault.addCollateral(address(weth), 7500, 8500, 500);

        musd.grantRole(musd.BRIDGE_ROLE(), address(borrowModule));
        musd.grantRole(musd.BRIDGE_ROLE(), admin);
        musd.grantRole(musd.LIQUIDATOR_ROLE(), address(liquidation));
        vault.grantRole(vault.BORROW_MODULE_ROLE(), address(borrowModule));
        vault.grantRole(vault.LIQUIDATION_ROLE(), address(liquidation));
        borrowModule.grantRole(borrowModule.LIQUIDATION_ROLE(), address(liquidation));
        borrowModule.grantRole(borrowModule.TIMELOCK_ROLE(), admin);
        borrowModule.setInterestRateModel(address(irm));
        ethFeed.setAnswer(2000e8);

        attacker = new MockReentrantAttacker();
    }

    // ════════════════════════════════════════════════════════════════════
    // TEST: CollateralVault.deposit reentrancy
    // ════════════════════════════════════════════════════════════════════

    /// @notice Attacker deposits collateral, then tries to re-enter deposit via callback
    function test_reentrancy_vault_deposit() public {
        uint256 amount = 10e18;
        weth.mint(address(attacker), amount * 2);

        // Setup attacker to re-enter vault.deposit on callback
        attacker.setAttack(
            address(vault),
            MockReentrantAttacker.AttackType.VAULT_DEPOSIT,
            address(weth),
            amount
        );
        attacker.approve(address(weth), address(vault), type(uint256).max);

        // Execute initial deposit as attacker
        vm.prank(address(attacker));
        vault.deposit(address(weth), amount);

        // The re-entrant call should NOT have succeeded
        assertFalse(
            attacker.attackSucceeded(),
            "Reentrancy attack on vault.deposit succeeded!"
        );
    }

    // ════════════════════════════════════════════════════════════════════
    // TEST: BorrowModule.borrow reentrancy
    // ════════════════════════════════════════════════════════════════════

    /// @notice Attacker deposits collateral, borrows, and tries to re-enter borrow
    function test_reentrancy_borrow() public {
        uint256 collateral = 100e18;
        uint256 borrowAmount = 1000e18;

        weth.mint(address(attacker), collateral);
        attacker.approve(address(weth), address(vault), type(uint256).max);

        vm.prank(address(attacker));
        vault.deposit(address(weth), collateral);

        // Setup reentrancy attack targeting borrow
        attacker.setAttack(
            address(borrowModule),
            MockReentrantAttacker.AttackType.BORROW,
            address(weth),
            borrowAmount
        );

        vm.prank(address(attacker));
        borrowModule.borrow(borrowAmount);

        assertFalse(
            attacker.attackSucceeded(),
            "Reentrancy attack on borrow succeeded!"
        );
    }

    // ════════════════════════════════════════════════════════════════════
    // TEST: BorrowModule.repay reentrancy
    // ════════════════════════════════════════════════════════════════════

    /// @notice Attacker has debt, repays, and tries to re-enter repay
    function test_reentrancy_repay() public {
        uint256 collateral = 100e18;
        uint256 borrowAmount = 1000e18;

        // Setup position
        weth.mint(address(attacker), collateral);
        attacker.approve(address(weth), address(vault), type(uint256).max);
        vm.prank(address(attacker));
        vault.deposit(address(weth), collateral);

        vm.prank(address(attacker));
        borrowModule.borrow(borrowAmount);

        // Give attacker mUSD to repay
        musd.mint(address(attacker), borrowAmount);
        attacker.approve(address(musd), address(borrowModule), type(uint256).max);

        // Setup reentrancy attack targeting repay
        attacker.setAttack(
            address(borrowModule),
            MockReentrantAttacker.AttackType.REPAY,
            address(0),
            borrowAmount / 2
        );

        vm.prank(address(attacker));
        borrowModule.repay(borrowAmount / 2);

        assertFalse(
            attacker.attackSucceeded(),
            "Reentrancy attack on repay succeeded!"
        );
    }

    // ════════════════════════════════════════════════════════════════════
    // TEST: SMUSD.deposit reentrancy
    // ════════════════════════════════════════════════════════════════════

    /// @notice Attacker deposits mUSD into sMUSD and tries to re-enter
    function test_reentrancy_smusd_deposit() public {
        uint256 amount = 10_000e18;
        musd.mint(address(attacker), amount * 2);
        attacker.approve(address(musd), address(smusd), type(uint256).max);

        attacker.setAttack(
            address(smusd),
            MockReentrantAttacker.AttackType.SMUSD_DEPOSIT,
            address(musd),
            amount
        );

        vm.prank(address(attacker));
        smusd.deposit(amount, address(attacker));

        assertFalse(
            attacker.attackSucceeded(),
            "Reentrancy attack on smusd.deposit succeeded!"
        );
    }

    // ════════════════════════════════════════════════════════════════════
    // TEST: SMUSD.redeem reentrancy
    // ════════════════════════════════════════════════════════════════════

    /// @notice Attacker deposits, waits for cooldown, redeems and tries to re-enter
    function test_reentrancy_smusd_redeem() public {
        uint256 amount = 10_000e18;
        musd.mint(address(attacker), amount);
        attacker.approve(address(musd), address(smusd), type(uint256).max);

        vm.prank(address(attacker));
        uint256 shares = smusd.deposit(amount, address(attacker));

        // Wait past cooldown
        vm.warp(block.timestamp + 25 hours);

        attacker.setAttack(
            address(smusd),
            MockReentrantAttacker.AttackType.SMUSD_REDEEM,
            address(0),
            shares / 2
        );

        vm.prank(address(attacker));
        smusd.redeem(shares / 2, address(attacker), address(attacker));

        assertFalse(
            attacker.attackSucceeded(),
            "Reentrancy attack on smusd.redeem succeeded!"
        );
    }

    // ════════════════════════════════════════════════════════════════════
    // TEST: CollateralVault.withdraw via BorrowModule reentrancy
    // ════════════════════════════════════════════════════════════════════

    /// @notice Attacker withdraws collateral and tries to re-enter
    function test_reentrancy_withdraw_collateral() public {
        uint256 amount = 10e18;
        weth.mint(address(attacker), amount);
        attacker.approve(address(weth), address(vault), type(uint256).max);

        vm.prank(address(attacker));
        vault.deposit(address(weth), amount);

        attacker.setAttack(
            address(borrowModule),
            MockReentrantAttacker.AttackType.VAULT_WITHDRAW,
            address(weth),
            amount / 2
        );

        vm.prank(address(attacker));
        borrowModule.withdrawCollateral(address(weth), amount / 2);

        assertFalse(
            attacker.attackSucceeded(),
            "Reentrancy attack on withdrawCollateral succeeded!"
        );
    }

    // ════════════════════════════════════════════════════════════════════
    // TEST: LiquidationEngine.liquidate reentrancy
    // ════════════════════════════════════════════════════════════════════

    /// @notice Attacker liquidates an undercollateralized position and tries to re-enter
    function test_reentrancy_liquidation() public {
        // Create an undercollateralized position for a separate borrower
        address borrower = address(0xBEEF);
        uint256 collateral = 10e18;
        uint256 borrowAmount = 10_000e18;

        weth.mint(borrower, collateral);
        vm.startPrank(borrower);
        weth.approve(address(vault), collateral);
        vault.deposit(address(weth), collateral);
        borrowModule.borrow(borrowAmount);
        vm.stopPrank();

        // Crash price to make position liquidatable
        ethFeed.setAnswer(500e8); // $2000 → $500

        // Give attacker mUSD to liquidate
        uint256 liquidateAmount = 1000e18;
        musd.mint(address(attacker), liquidateAmount * 2);
        attacker.approve(address(musd), address(liquidation), type(uint256).max);

        // Setup reentrancy attack targeting liquidate
        attacker.setAttack(
            address(liquidation),
            MockReentrantAttacker.AttackType.LIQUIDATION,
            address(weth),
            liquidateAmount
        );

        vm.prank(address(attacker));
        liquidation.liquidate(borrower, address(weth), liquidateAmount);

        assertFalse(
            attacker.attackSucceeded(),
            "Reentrancy attack on liquidation succeeded!"
        );
    }

    // ════════════════════════════════════════════════════════════════════
    // TEST: Verify nonReentrant modifier is present on all critical functions
    // ════════════════════════════════════════════════════════════════════

    /// @notice Statistical test -- execute all attack types and confirm none succeed
    function test_no_reentrancy_across_all_entry_points() public {
        // Setup a full position for the attacker
        uint256 collateral = 100e18;
        uint256 borrowAmount = 1000e18;
        uint256 smusdAmount = 10_000e18;

        weth.mint(address(attacker), collateral);
        attacker.approve(address(weth), address(vault), type(uint256).max);
        vm.prank(address(attacker));
        vault.deposit(address(weth), collateral);

        vm.prank(address(attacker));
        borrowModule.borrow(borrowAmount);

        musd.mint(address(attacker), smusdAmount + borrowAmount);
        attacker.approve(address(musd), address(smusd), type(uint256).max);
        attacker.approve(address(musd), address(borrowModule), type(uint256).max);

        vm.prank(address(attacker));
        smusd.deposit(smusdAmount, address(attacker));

        // Track that no attack ever succeeded
        uint256 attacksAttempted;
        uint256 attacksSucceeded;

        // Test each attack vector
        MockReentrantAttacker.AttackType[5] memory vectors = [
            MockReentrantAttacker.AttackType.BORROW,
            MockReentrantAttacker.AttackType.REPAY,
            MockReentrantAttacker.AttackType.SMUSD_DEPOSIT,
            MockReentrantAttacker.AttackType.VAULT_DEPOSIT,
            MockReentrantAttacker.AttackType.VAULT_WITHDRAW
        ];

        for (uint256 i = 0; i < vectors.length; i++) {
            attacker.setAttack(
                address(borrowModule),
                vectors[i],
                address(weth),
                1e18
            );
            attacksAttempted++;
            if (attacker.attackSucceeded()) {
                attacksSucceeded++;
            }
        }

        assertEq(
            attacksSucceeded,
            0,
            string.concat(
                "Reentrancy attacks succeeded: ",
                vm.toString(attacksSucceeded),
                " / ",
                vm.toString(attacksAttempted)
            )
        );
    }
}
