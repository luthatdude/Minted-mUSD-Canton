// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockSkyPSM
 * @notice Mock Sky Peg Stability Module for testing SkySUSDSStrategy.
 * @dev Simulates 1:1 USDC <-> USDS swaps (like MakerDAO's PSM).
 *      In production, Sky PSM converts between USDC (6 decimals) and USDS (18 decimals).
 */
contract MockSkyPSM {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    IERC20 public immutable usds;

    /// @notice Fee in basis points (default 0 for 1:1 peg)
    uint256 public feeBps = 0;

    constructor(address _usdc, address _usds) {
        usdc = IERC20(_usdc);
        usds = IERC20(_usds);
    }

    /// @notice Set swap fee
    function setFee(uint256 _feeBps) external {
        require(_feeBps <= 100, "FEE_TOO_HIGH"); // Max 1%
        feeBps = _feeBps;
    }

    /// @notice Swap USDC for USDS (sell USDC, buy USDS)
    /// @param usr Recipient of USDS
    /// @param usdcAmount Amount of USDC to sell (6 decimals)
    function sellGem(address usr, uint256 usdcAmount) external {
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        // Convert 6 decimals -> 18 decimals, minus fee
        uint256 usdsAmount = usdcAmount * 1e12;
        if (feeBps > 0) {
            usdsAmount = usdsAmount - (usdsAmount * feeBps / 10000);
        }
        usds.safeTransfer(usr, usdsAmount);
    }

    /// @notice Swap USDS for USDC (buy USDC, sell USDS)
    /// @param usr Recipient of USDC
    /// @param usdcAmount Amount of USDC to buy (6 decimals)
    function buyGem(address usr, uint256 usdcAmount) external {
        // Convert 6 decimals -> 18 decimals for USDS input
        uint256 usdsNeeded = usdcAmount * 1e12;
        if (feeBps > 0) {
            usdsNeeded = usdsNeeded + (usdsNeeded * feeBps / 10000);
        }
        usds.safeTransferFrom(msg.sender, address(this), usdsNeeded);
        usdc.safeTransfer(usr, usdcAmount);
    }
}
