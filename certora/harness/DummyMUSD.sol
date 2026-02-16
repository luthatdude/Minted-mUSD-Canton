// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title DummyMUSD — Certora harness for the mUSD token
/// @notice Minimal ERC20 + burn implementation so the prover can resolve
///         all external calls made by RedemptionQueue via SafeERC20.
///         Linked to RedemptionQueue:musd and RedemptionQueue:musdBurnable.
contract DummyMUSD {
    mapping(address => uint256) internal _balances;

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _balances[from] -= amount;
        _balances[to] += amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _balances[msg.sender] -= amount;
        _balances[to] += amount;
        return true;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function approve(address, uint256) external returns (bool) {
        return true;
    }

    /// @dev IMUSDBurnable.burn — reduces balance
    function burn(address from, uint256 amount) external {
        _balances[from] -= amount;
    }
}
