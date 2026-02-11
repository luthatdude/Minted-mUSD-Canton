// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MockSkyPSM
/// @notice Mock Peg Stability Module for tests. Converts USDC ↔ USDS at 1:1 (no fee).
contract MockSkyPSM {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;  // 6 decimals
    IERC20 public immutable usds;  // 18 decimals
    uint256 public constant SCALING = 1e12;

    uint256 public tinFee;  // Fee on sellGem (typically 0)
    uint256 public toutFee; // Fee on buyGem (typically 0)

    constructor(address _usdc, address _usds) {
        usdc = IERC20(_usdc);
        usds = IERC20(_usds);
    }

    /// @notice Sell USDC for USDS (6→18 decimals, 1:1)
    function sellGem(address usr, uint256 gemAmt) external {
        usdc.safeTransferFrom(msg.sender, address(this), gemAmt);
        // Mint equivalent USDS (scaled 6→18 decimals)
        uint256 usdsAmount = gemAmt * SCALING;
        // Mock: just transfer from PSM's balance
        usds.safeTransfer(usr, usdsAmount);
    }

    /// @notice Buy USDC with USDS (18→6 decimals, 1:1)
    function buyGem(address usr, uint256 gemAmt) external {
        uint256 usdsAmount = gemAmt * SCALING;
        usds.safeTransferFrom(msg.sender, address(this), usdsAmount);
        usdc.safeTransfer(usr, gemAmt);
    }

    function tin() external view returns (uint256) {
        return tinFee;
    }

    function tout() external view returns (uint256) {
        return toutFee;
    }

    function setFees(uint256 _tin, uint256 _tout) external {
        tinFee = _tin;
        toutFee = _tout;
    }
}
