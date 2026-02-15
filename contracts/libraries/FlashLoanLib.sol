// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../interfaces/IFlashLoanProvider.sol";

/**
 * @title FlashLoanLib
 * @notice Library for flash loan fee calculations and provider utilities
 */
library FlashLoanLib {
    /**
     * @notice Calculate the flash loan fee for a given provider and amount
     * @param provider The flash loan provider
     * @param amount The loan amount
     * @return fee The fee amount
     */
    function calculateFlashLoanFee(
        IFlashLoanProvider.FlashLoanProvider provider,
        uint256 amount
    ) internal pure returns (uint256 fee) {
        if (provider == IFlashLoanProvider.FlashLoanProvider.AaveV3) {
            fee = (amount * 5) / 10000; // 0.05%
        } else if (provider == IFlashLoanProvider.FlashLoanProvider.BalancerV3) {
            fee = 0; // FREE!
        } else if (provider == IFlashLoanProvider.FlashLoanProvider.UniswapV3) {
            fee = (amount * 5) / 10000; // 0.05%
        }
    }

    /**
     * @notice Validate that a provider enum value is valid
     * @param provider The flash loan provider to validate
     * @return True if the provider is valid
     */
    function validateProvider(
        IFlashLoanProvider.FlashLoanProvider provider
    ) internal pure returns (bool) {
        return provider == IFlashLoanProvider.FlashLoanProvider.AaveV3
            || provider == IFlashLoanProvider.FlashLoanProvider.BalancerV3
            || provider == IFlashLoanProvider.FlashLoanProvider.UniswapV3;
    }

    /**
     * @notice Check if a provider offers zero-fee flash loans
     * @param provider The flash loan provider
     * @return True if the provider charges no fee
     */
    function isFreeLoan(
        IFlashLoanProvider.FlashLoanProvider provider
    ) internal pure returns (bool) {
        return provider == IFlashLoanProvider.FlashLoanProvider.BalancerV3;
    }
}
