// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title MockPendleOracle
 * @notice Mock Pendle Oracle for testing PendleMarketSelector
 */
contract MockPendleOracle {
    mapping(address => uint256) public ptToSyRates;
    mapping(address => uint256) public syToAssetRates;
    
    constructor() {
        // Default rates
    }
    
    function getPtToSyRate(address market, uint32 /* duration */) external view returns (uint256) {
        uint256 rate = ptToSyRates[market];
        // Return 1:1 if not set
        return rate == 0 ? 1e18 : rate;
    }
    
    function getYtToSyRate(address /* market */, uint32 /* duration */) external pure returns (uint256) {
        return 1e18;  // 1:1 for simplicity
    }
    
    // Test helpers
    function setPtToSyRate(address market, uint256 rate) external {
        ptToSyRates[market] = rate;
    }
    
    function setSyToAssetRate(address market, uint256 rate) external {
        syToAssetRates[market] = rate;
    }
}
