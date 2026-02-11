// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal mock for SMUSDPriceAdapter tests — returns a controllable share price
contract MockSMUSD {
    uint256 private _assetsPerShare;
    uint256 private _totalSupply = 1000e18; // Default: 1000 shares — well above minTotalSupply
    uint256 private _totalAssets = 1000e18; // Default: 1000 mUSD

    constructor(uint256 assetsPerShare_) {
        _assetsPerShare = assetsPerShare_;
    }

    /// @notice Returns controllable value for assets per 1e18 shares
    function convertToAssets(uint256 shares) external view returns (uint256) {
        return (_assetsPerShare * shares) / 1e18;
    }

    /// @notice Returns mock total supply
    function totalSupply() external view returns (uint256) {
        return _totalSupply;
    }

    /// @notice Returns mock total assets
    function totalAssets() external view returns (uint256) {
        return _totalAssets;
    }

    /// @notice Setter for tests to adjust the share price
    function setAssetsPerShare(uint256 assetsPerShare_) external {
        _assetsPerShare = assetsPerShare_;
    }

    /// @notice Setter for tests to adjust totalSupply
    function setTotalSupply(uint256 totalSupply_) external {
        _totalSupply = totalSupply_;
    }

    /// @notice Setter for tests to adjust totalAssets
    function setTotalAssets(uint256 totalAssets_) external {
        _totalAssets = totalAssets_;
    }
}
