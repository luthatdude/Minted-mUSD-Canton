// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ISMUSD
/// @notice Canonical interface for SMUSD (staked mUSD) — superset of all consumer needs.
/// Import this instead of redeclaring inline interfaces.
/// @dev Consumers: BorrowModule (receiveInterest), SMUSDPriceAdapter (ERC-4626 reads)
interface ISMUSD {
    // ── Interest routing (BorrowModule) ────────────────────────────────
    function receiveInterest(uint256 amount) external;

    // ── Yield distribution (YIELD_MANAGER_ROLE callers) ───────────────
    function distributeYield(uint256 amount) external;

    // ── ERC-4626 reads (SMUSDPriceAdapter) ─────────────────────────────
    function convertToAssets(uint256 shares) external view returns (uint256);
    function convertToShares(uint256 assets) external view returns (uint256);
    function totalAssets() external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function decimalsOffset() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
}
