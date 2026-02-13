// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title MockSMUSDAdapter
 * @notice Minimal sMUSD mock for testing SMUSDPriceAdapter.
 * @dev Implements the ISMUSD interface with controllable share price.
 *      Unlike MockSMUSD (which is a full ERC-4626 vault mock), this
 *      contract only exposes the view functions the adapter reads.
 */
contract MockSMUSDAdapter {
    uint256 private _assetsPerShare;

    constructor(uint256 initialAssetsPerShare) {
        _assetsPerShare = initialAssetsPerShare;
    }

    /// @notice Set the assets returned per share (test helper)
    function setAssetsPerShare(uint256 newAssetsPerShare) external {
        _assetsPerShare = newAssetsPerShare;
    }

    /// @notice Convert shares to assets based on current price
    function convertToAssets(uint256 shares) external view returns (uint256) {
        return (shares * _assetsPerShare) / 1e18;
    }

    /// @notice Returns total assets (fixed high value for testing)
    function totalAssets() external pure returns (uint256) {
        return 100_000e18;
    }

    /// @notice Returns total supply (fixed high value to pass minTotalSupply check)
    function totalSupply() external pure returns (uint256) {
        return 100_000e18;
    }

    /// @notice Returns decimals offset (0 for testing)
    function decimalsOffset() external pure returns (uint8) {
        return 0;
    }
}
