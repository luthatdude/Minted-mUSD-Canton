// SPDX-License-Identifier: MIT
// Mock Uniswap V3 Swap Router for testing

pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IPriceOracle {
    function getValueUsd(address token, uint256 amount) external view returns (uint256);
}

interface IMintableToken {
    function mint(address to, uint256 amount) external;
}

/// @title MockSwapRouter
/// @notice Mock Uniswap V3 router for testing LeverageVault
contract MockSwapRouter {
    using SafeERC20 for IERC20;

    IERC20 public immutable musd;
    IERC20 public immutable weth;
    IPriceOracle public immutable oracle;

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

    constructor(address _musd, address _weth, address _oracle) {
        musd = IERC20(_musd);
        weth = IERC20(_weth);
        oracle = IPriceOracle(_oracle);
    }

    /// @notice Mock swap implementation using oracle prices
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut) {
        require(block.timestamp <= params.deadline, "EXPIRED");

        // Transfer tokens in
        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);

        // Calculate output based on oracle prices
        if (params.tokenIn == address(musd)) {
            // mUSD → collateral: mUSD is $1, so amount = amountIn / collateralPrice
            uint256 oneUnit = 10 ** 18;
            uint256 collateralPriceUsd = oracle.getValueUsd(params.tokenOut, oneUnit);
            amountOut = (params.amountIn * oneUnit) / collateralPriceUsd;
        } else {
            // collateral → mUSD: output = collateral value in USD
            amountOut = oracle.getValueUsd(params.tokenIn, params.amountIn);
        }

        require(amountOut >= params.amountOutMinimum, "INSUFFICIENT_OUTPUT");

        // Transfer tokens out
        if (params.tokenOut == address(musd)) {
            // Mint mUSD to recipient
            IMintableToken(params.tokenOut).mint(params.recipient, amountOut);
        } else {
            IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
        }

        return amountOut;
    }
}
