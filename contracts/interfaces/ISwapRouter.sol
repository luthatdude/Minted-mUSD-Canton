// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ISwapRouter
/// @notice Uniswap V3 SwapRouter interface.
/// Import this instead of redeclaring inline.
/// @dev Consumer: LeverageVault
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}
