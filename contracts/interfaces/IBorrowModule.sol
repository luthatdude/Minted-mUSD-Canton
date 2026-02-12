// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IBorrowModule
/// @notice Canonical interface for BorrowModule — superset of all consumer needs.
/// Import this instead of redeclaring inline interfaces.
/// @dev Consumers: CollateralVault, LeverageVault, LiquidationEngine
interface IBorrowModule {
    // ── Read functions ─────────────────────────────────────────────────
    function totalDebt(address user) external view returns (uint256);
    function healthFactor(address user) external view returns (uint256);
    /// @dev Unsafe variant bypasses circuit breaker for liquidation paths
    function healthFactorUnsafe(address user) external view returns (uint256);
    function borrowCapacity(address user) external view returns (uint256);
    function maxBorrow(address user) external view returns (uint256);

    // ── Write functions ────────────────────────────────────────────────
    function borrowFor(address user, uint256 amount) external;
    function repay(uint256 amount) external;
    function repayFor(address user, uint256 amount) external;
    function reduceDebt(address user, uint256 amount) external;
    function recordBadDebt(address user) external;
}
