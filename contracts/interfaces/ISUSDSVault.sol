// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ISUSDSVault
/// @notice ERC-4626 sUSDS Vault interface for Sky Savings Rate.
/// Import this instead of redeclaring inline.
/// @dev Consumer: SkySUSDSStrategy
interface ISUSDSVault {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function convertToShares(uint256 assets) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function totalAssets() external view returns (uint256);
    function previewDeposit(uint256 assets) external view returns (uint256);
    function previewRedeem(uint256 shares) external view returns (uint256);
    function maxDeposit(address) external view returns (uint256);
    function maxRedeem(address) external view returns (uint256);
    function asset() external view returns (address);
}
