// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IBalancerV3Vault.sol";

/**
 * @title MockBalancerV3Vault
 * @notice Mock Balancer V3 vault for testing flash loans with zero fees
 */
contract MockBalancerV3Vault is IBalancerV3Vault {
    using SafeERC20 for IERC20;

    IERC20 public token;

    constructor(address _token) {
        token = IERC20(_token);
    }

    /**
     * @notice Execute a flash loan with zero fees (Balancer V3 style)
     * @param recipient The address receiving the flash loan
     * @param tokens The token addresses to flash loan
     * @param amounts The amounts of each token to flash loan
     * @param userData Arbitrary data passed to the recipient callback
     */
    function flashLoan(
        address recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external override {
        uint256 len = tokens.length;
        uint256[] memory feeAmounts = new uint256[](len);

        // Record balances before
        uint256[] memory balancesBefore = new uint256[](len);
        for (uint256 i = 0; i < len; i++) {
            balancesBefore[i] = IERC20(tokens[i]).balanceOf(address(this));
            // Transfer tokens to recipient
            IERC20(tokens[i]).safeTransfer(recipient, amounts[i]);
            // Fees are 0 (FREE!)
            feeAmounts[i] = 0;
        }

        // Call the recipient callback
        IBalancerV3FlashLoanRecipient(recipient).receiveFlashLoan(
            tokens,
            amounts,
            feeAmounts,
            userData
        );

        // Verify tokens were returned (no premium required)
        for (uint256 i = 0; i < len; i++) {
            uint256 balanceAfter = IERC20(tokens[i]).balanceOf(address(this));
            require(balanceAfter >= balancesBefore[i], "MockBalancerV3Vault: tokens not returned");
        }
    }

    /**
     * @notice Seed liquidity into the vault for testing
     * @param amount The amount of tokens to seed
     */
    function seedLiquidity(uint256 amount) external {
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    /**
     * @notice Pull tokens from the caller into the vault
     * @param amount The amount of tokens to pull
     */
    function fundFromOwner(uint256 amount) external {
        token.safeTransferFrom(msg.sender, address(this), amount);
    }
}
