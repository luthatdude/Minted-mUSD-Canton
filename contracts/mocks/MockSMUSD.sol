// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal mock for SMUSDPriceAdapter tests — returns a controllable share price
contract MockSMUSD {
    uint256 private _assetsPerShare;

    constructor(uint256 assetsPerShare_) {
        _assetsPerShare = assetsPerShare_;
    }

    /// @notice Returns controllable value for assets per 1e18 shares
    function convertToAssets(uint256 shares) external view returns (uint256) {
        return (_assetsPerShare * shares) / 1e18;
    }

    /// @notice Setter for tests to adjust the share price
    function setAssetsPerShare(uint256 assetsPerShare_) external {
        _assetsPerShare = assetsPerShare_;
    }
}
