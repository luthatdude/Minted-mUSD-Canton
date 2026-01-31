// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title MockPendleMarket
 * @notice Mock Pendle market for testing PendleMarketSelector
 */
contract MockPendleMarket {
    address public sy;
    address public pt;
    address public yt;
    uint256 public expiry;
    bool public expired;
    
    int128 public totalPt;
    int128 public totalSy;
    uint96 public lastLnImpliedRate;
    
    constructor(
        address _sy,
        address _pt,
        address _yt,
        uint256 _expiry
    ) {
        sy = _sy;
        pt = _pt;
        yt = _yt;
        expiry = _expiry;
        expired = false;
        
        // Default values for testing
        totalPt = 100_000_000e18;  // 100M PT
        totalSy = 100_000_000e18;  // 100M SY
        lastLnImpliedRate = 100_000_000;  // ~10% APY
    }
    
    function readTokens() external view returns (address, address, address) {
        return (sy, pt, yt);
    }
    
    function isExpired() external view returns (bool) {
        return expired || block.timestamp >= expiry;
    }
    
    function _storage() external view returns (
        int128,
        int128,
        uint96,
        uint16,
        uint16,
        uint16
    ) {
        return (totalPt, totalSy, lastLnImpliedRate, 0, 0, 0);
    }
    
    // Test helpers
    function setExpired(bool _expired) external {
        expired = _expired;
    }
    
    function setStorage(int128 _totalPt, int128 _totalSy, uint96 _lastLnImpliedRate) external {
        totalPt = _totalPt;
        totalSy = _totalSy;
        lastLnImpliedRate = _lastLnImpliedRate;
    }
    
    function setExpiry(uint256 _expiry) external {
        expiry = _expiry;
    }
}
