// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title DummyUSDC — Certora harness for the USDC token
/// @notice Minimal ERC20 implementation so the prover can resolve
///         all external calls made by RedemptionQueue via SafeERC20.
///         Linked to RedemptionQueue:usdc.
/// @dev All arithmetic is unchecked to prevent underflow reverts in
///      arbitrary Prover states (same rationale as DummyMUSD).
contract DummyUSDC {
    mapping(address => uint256) internal _balances;

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        unchecked {
            _balances[from] -= amount;
            _balances[to] += amount;
        }
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        unchecked {
            _balances[msg.sender] -= amount;
            _balances[to] += amount;
        }
        return true;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function approve(address, uint256) external returns (bool) {
        return true;
    }
}
