// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IPendleSY
/// @notice Pendle Standardized Yield token interface.
/// Import this instead of redeclaring inline.
/// @dev Consumer: PendleStrategyV2
interface IPendleSY {
    function redeem(
        address receiver,
        uint256 amountSharesToRedeem,
        address tokenOut,
        uint256 minTokenOut,
        bool burnFromInternalBalance
    ) external returns (uint256 amountTokenOut);

    function deposit(
        address receiver,
        address tokenIn,
        uint256 amountTokenIn,
        uint256 minSharesOut
    ) external payable returns (uint256 amountSharesOut);

    function exchangeRate() external view returns (uint256);
    function yieldToken() external view returns (address);
    function getTokensIn() external view returns (address[] memory);
    function getTokensOut() external view returns (address[] memory);
}
