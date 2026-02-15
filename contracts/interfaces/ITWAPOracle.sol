// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @title ITWAPOracle
/// @notice Interface for Uniswap V3 TWAP oracle validation.
///         Used by LeverageVault to verify swap outputs against time-weighted prices.
interface ITWAPOracle {
    /// @notice Get the TWAP price of tokenOut in terms of tokenIn
    /// @param tokenIn Input token address
    /// @param tokenOut Output token address
    /// @param fee Uniswap V3 pool fee tier
    /// @param twapDuration Seconds for TWAP observation window
    /// @param amountIn Amount of tokenIn
    /// @return expectedOut Expected tokenOut amount based on TWAP
    function getTWAPQuote(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint32 twapDuration,
        uint256 amountIn
    ) external view returns (uint256 expectedOut);
}
