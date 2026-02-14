// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IMerklDistributor.sol";

/**
 * @title MockMerklDistributor
 * @notice Simplified mock of the Angle Protocol Merkl reward distributor for testing.
 *         Allows funding with tokens and claiming without requiring real merkle proofs.
 */
contract MockMerklDistributor is IMerklDistributor {
    using SafeERC20 for IERC20;

    // token => total available balance for distribution
    mapping(address => uint256) public available;

    // user => token => claimed amount
    mapping(address => mapping(address => uint256)) private _claimed;

    // user => operator => trusted (1 = trusted)
    mapping(address => mapping(address => uint256)) private _operators;

    /// @notice Fund the distributor with reward tokens (test helper)
    function fund(address token, uint256 amount) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        available[token] += amount;
    }

    /// @notice Claim rewards — in mock we skip proof verification and just send tokens
    function claim(
        address[] calldata users,
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes32[][] calldata /* proofs */
    ) external override {
        require(users.length == tokens.length && tokens.length == amounts.length, "length mismatch");

        for (uint256 i = 0; i < users.length; i++) {
            uint256 alreadyClaimed = _claimed[users[i]][tokens[i]];
            uint256 toClaim = amounts[i] > alreadyClaimed ? amounts[i] - alreadyClaimed : 0;

            if (toClaim > 0 && available[tokens[i]] >= toClaim) {
                _claimed[users[i]][tokens[i]] += toClaim;
                available[tokens[i]] -= toClaim;
                IERC20(tokens[i]).safeTransfer(users[i], toClaim);
            }
        }
    }

    function claimed(address user, address token) external view override returns (uint256) {
        return _claimed[user][token];
    }

    function toggleOperator(address user, address operator) external override {
        _operators[user][operator] = _operators[user][operator] == 0 ? 1 : 0;
    }

    function operators(address user, address operator) external view override returns (uint256) {
        return _operators[user][operator];
    }
}
