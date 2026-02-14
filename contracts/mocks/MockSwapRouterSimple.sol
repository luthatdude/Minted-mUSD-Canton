// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockSwapRouterSimple
 * @notice Simple mock Uniswap V3 router for ContangoLoopStrategy tests
 * @dev Returns 1:1 swaps (minus 1% fee simulation) for any token pair.
 *      Matches the ISwapRouterV3Contango interface (no deadline field).
 */
contract MockSwapRouterSimple {
    using SafeERC20 for IERC20;

    IERC20 public outputToken;

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    constructor(address _outputToken) {
        outputToken = IERC20(_outputToken);
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut)
    {
        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);

        // Simple 1:1 swap (good enough for unit tests)
        amountOut = params.amountIn;

        require(amountOut >= params.amountOutMinimum, "INSUFFICIENT_OUTPUT");

        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
    }
}
