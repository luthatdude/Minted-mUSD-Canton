// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IMUSD
/// @notice Canonical interface for MUSD token — superset of all consumer needs.
/// Import this instead of redeclaring inline interfaces (IMUSDMint, IMUSD_V2, IMUSDBurn, etc.)
/// @dev Consumers: BorrowModule, LeverageVault, LiquidationEngine, DirectMintV2, BLEBridgeV9, TreasuryV2
interface IMUSD {
    // ── ERC-20 standard ────────────────────────────────────────────────
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    // ── Minting / Burning ──────────────────────────────────────────────
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;

    // ── Supply management ──────────────────────────────────────────────
    function supplyCap() external view returns (uint256);
    function setSupplyCap(uint256 cap) external;
}
