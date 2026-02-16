// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ISMUSDE
/// @notice Canonical interface for SMUSDE (smUSD-E) — ETH Pool staked mUSD.
/// @dev Consumers: ETHPool (mint/burn), CollateralVault (balance checks)
interface ISMUSDE {
    // ── Pool operations ──────────────────────────────────────────────────
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;

    // ── ERC-20 reads ─────────────────────────────────────────────────────
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
