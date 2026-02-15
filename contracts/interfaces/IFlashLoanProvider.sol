// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title IFlashLoanProvider
 * @notice Unified interface for multi-provider flash loan support
 */
interface IFlashLoanProvider {
    enum FlashLoanProvider {
        AaveV3,
        BalancerV3,
        UniswapV3
    }

    event FlashLoanRequested(FlashLoanProvider provider, address asset, uint256 amount);

    function requestFlashLoan(address asset, uint256 amount, bytes calldata params) external;

    function getFlashLoanFee(address asset, uint256 amount) external view returns (uint256);
}
