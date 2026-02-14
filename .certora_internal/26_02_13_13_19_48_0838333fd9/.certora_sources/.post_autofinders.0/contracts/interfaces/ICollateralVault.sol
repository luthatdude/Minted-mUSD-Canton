// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ICollateralVault
/// @notice Canonical interface for CollateralVault — superset of all consumer needs.
/// Import this instead of redeclaring inline interfaces.
/// @dev Consumers: BorrowModule, LeverageVault, LiquidationEngine
interface ICollateralVault {
    // ── Read functions ─────────────────────────────────────────────────
    function deposits(address user, address token) external view returns (uint256);
    function getSupportedTokens() external view returns (address[] memory);
    function getConfig(address token) external view returns (
        bool enabled,
        uint256 collateralFactorBps,
        uint256 liquidationThresholdBps,
        uint256 liquidationPenaltyBps
    );

    // ── Write functions (BorrowModule) ─────────────────────────────────
    function withdraw(address token, uint256 amount, address user) external;

    // ── Write functions (LeverageVault) ────────────────────────────────
    function depositFor(address user, address token, uint256 amount) external;
    function withdrawFor(
        address user,
        address token,
        uint256 amount,
        address recipient,
        bool skipHealthCheck
    ) external;

    // ── Write functions (LiquidationEngine) ────────────────────────────
    function seize(address user, address token, uint256 amount, address liquidator) external;
}
