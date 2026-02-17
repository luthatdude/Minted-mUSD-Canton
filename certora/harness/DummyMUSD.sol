// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title DummyMUSD — Certora harness for the mUSD token
/// @notice Minimal ERC20 + burn implementation so the prover can resolve
///         all external calls made by RedemptionQueue via SafeERC20.
///         Linked to RedemptionQueue:musd and RedemptionQueue:musdBurnable.
/// @dev All arithmetic is unchecked to prevent underflow reverts in
///      arbitrary Prover states. Solidity 0.8.26 uses checked arithmetic
///      by default — without unchecked, _balances[from] -= amount reverts
///      when the Prover picks _balances[from] = 0, making every
///      SafeERC20 call fail and all rules vacuous.
contract DummyMUSD {
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

    /// @dev IMUSDBurnable.burn — reduces balance
    function burn(address from, uint256 amount) external {
        unchecked {
            _balances[from] -= amount;
        }
    }
}
