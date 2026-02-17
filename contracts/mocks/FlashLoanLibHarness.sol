// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../libraries/FlashLoanLib.sol";
import "../interfaces/IFlashLoanProvider.sol";

/**
 * @title FlashLoanLibHarness
 * @notice Test harness that exposes FlashLoanLib internal functions as public
 */
contract FlashLoanLibHarness {
    function calculateFlashLoanFee(
        IFlashLoanProvider.FlashLoanProvider provider,
        uint256 amount
    ) external pure returns (uint256) {
        return FlashLoanLib.calculateFlashLoanFee(provider, amount);
    }

    function validateProvider(
        IFlashLoanProvider.FlashLoanProvider provider
    ) external pure returns (bool) {
        return FlashLoanLib.validateProvider(provider);
    }

    function isFreeLoan(
        IFlashLoanProvider.FlashLoanProvider provider
    ) external pure returns (bool) {
        return FlashLoanLib.isFreeLoan(provider);
    }
}
