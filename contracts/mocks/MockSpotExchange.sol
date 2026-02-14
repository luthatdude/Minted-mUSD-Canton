// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockSpotExchange
 * @notice Mock spot exchange for testing BasisTradingStrategy
 */
contract MockSpotExchange {
    using SafeERC20 for IERC20;

    IERC20 public usdc;

    // Mock spot prices (6 decimals, USDC per unit)
    mapping(address => uint256) public spotPrices;

    constructor(address _usdc) {
        usdc = IERC20(_usdc);
    }

    function setSpotPrice(address asset, uint256 price) external {
        spotPrices[asset] = price;
    }

    function buySpot(
        address asset,
        uint256 usdcAmount,
        uint256 /* minAmountOut */
    ) external returns (uint256 amountOut) {
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);

        uint256 price = spotPrices[asset];
        require(price > 0, "Price not set");

        // amountOut = usdcAmount / price (both 6 decimals)
        amountOut = (usdcAmount * 1e6) / price;

        // Mint mock tokens (simplified — assumes asset is MockERC20)
        (bool success,) = asset.call(abi.encodeWithSignature("mint(address,uint256)", msg.sender, amountOut));
        require(success, "Mint failed");
    }

    function sellSpot(
        address asset,
        uint256 amount,
        uint256 /* minUsdcOut */
    ) external returns (uint256 usdcOut) {
        uint256 price = spotPrices[asset];
        require(price > 0, "Price not set");

        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);

        usdcOut = (amount * price) / 1e6;
        usdc.safeTransfer(msg.sender, usdcOut);
    }

    function getSpotPrice(address asset) external view returns (uint256) {
        return spotPrices[asset];
    }
}
