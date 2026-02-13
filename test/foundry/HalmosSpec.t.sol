// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Test.sol";
import {MUSD} from "../../contracts/MUSD.sol";

/**
 * @title HalmosSpec
 * @notice Symbolic execution tests using Halmos for the Minted Protocol.
 * @dev Run with: halmos --contract HalmosSpec
 *
 * These tests use symbolic inputs to verify properties hold for ALL possible inputs,
 * not just specific test cases. Halmos explores all execution paths.
 */
contract HalmosSpec is Test {
    MUSD musd;
    address admin = address(0xAD);
    address minter = address(0xB0);
    address user1 = address(0xC1);
    address user2 = address(0xC2);

    function setUp() public {
        vm.startPrank(admin);
        musd = new MUSD(100_000_000e18);
        musd.grantRole(musd.BRIDGE_ROLE(), minter);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════
    // SUPPLY CAP INVARIANTS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Mint can never exceed supply cap
    function check_mint_respects_supply_cap(uint256 amount) public {
        vm.assume(amount > 0 && amount <= type(uint128).max);
        
        uint256 capBefore = musd.supplyCap();
        uint256 supplyBefore = musd.totalSupply();
        
        vm.prank(minter);
        try musd.mint(user1, amount) {
            // If mint succeeded, supply must be <= cap
            assert(musd.totalSupply() <= capBefore);
        } catch {
            // If mint reverted, that's fine — cap enforcement working
        }
    }

    /// @notice Total supply can never decrease without a burn
    function check_supply_monotonic_on_mint(uint256 amount) public {
        vm.assume(amount > 0 && amount <= type(uint128).max);
        
        uint256 supplyBefore = musd.totalSupply();
        
        vm.prank(minter);
        try musd.mint(user1, amount) {
            assert(musd.totalSupply() >= supplyBefore);
        } catch {
            // Revert is acceptable
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // TRANSFER CONSERVATION
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Transfer preserves total balance (no tokens created/destroyed)
    function check_transfer_conservation(uint256 mintAmount, uint256 transferAmount) public {
        vm.assume(mintAmount > 0 && mintAmount <= type(uint128).max);
        vm.assume(transferAmount > 0 && transferAmount <= mintAmount);
        vm.assume(user1 != user2);
        
        // Setup: mint to user1
        vm.prank(minter);
        try musd.mint(user1, mintAmount) {} catch { return; }
        
        uint256 totalBefore = musd.balanceOf(user1) + musd.balanceOf(user2);
        
        vm.prank(user1);
        try musd.transfer(user2, transferAmount) {
            uint256 totalAfter = musd.balanceOf(user1) + musd.balanceOf(user2);
            assert(totalAfter == totalBefore);
        } catch {
            // Revert is acceptable
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // ACCESS CONTROL
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Non-minter cannot mint tokens
    function check_only_minter_can_mint(address caller, uint256 amount) public {
        vm.assume(caller != minter && caller != admin);
        vm.assume(amount > 0);
        vm.assume(!musd.hasRole(musd.BRIDGE_ROLE(), caller));
        
        vm.prank(caller);
        try musd.mint(user1, amount) {
            // Should never succeed for non-minter
            assert(false);
        } catch {
            // Expected: revert
        }
    }
}
