// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IPriceOracle
/// @notice Canonical interface for PriceOracle — superset of all consumer needs.
/// Import this instead of redeclaring inline interfaces.
/// @dev Consumers: BorrowModule, LeverageVault, LiquidationEngine, DepositRouter
interface IPriceOracle {
    /// @notice Get the raw USD price for one full unit of a token (18 decimals)
    function getPrice(address token) external view returns (uint256);

    /// @notice Get USD value for a specific amount of a token
    function getValueUsd(address token, uint256 amount) external view returns (uint256);

    /// @notice Get raw price bypassing circuit breaker (for liquidation paths)
    function getPriceUnsafe(address token) external view returns (uint256);

    /// @notice Get USD value bypassing circuit breaker (for liquidation paths)
    function getValueUsdUnsafe(address token, uint256 amount) external view returns (uint256);
}
