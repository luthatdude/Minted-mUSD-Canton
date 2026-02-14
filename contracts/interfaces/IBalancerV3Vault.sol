// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title IBalancerV3Vault
 * @notice Interface for Balancer V3 vault flash loans
 */
interface IBalancerV3Vault {
    function flashLoan(
        address recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

/**
 * @title IBalancerV3FlashLoanRecipient
 * @notice Callback interface for Balancer V3 flash loan recipients
 */
interface IBalancerV3FlashLoanRecipient {
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external;
}
