// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title MockSY
 * @notice Mock Standardized Yield token for Pendle testing
 */
contract MockSY {
    address public yieldToken;
    address[] private _tokensIn;
    address[] private _tokensOut;
    uint256 public exchangeRate;
    
    constructor(address _yieldToken) {
        yieldToken = _yieldToken;
        exchangeRate = 1e18;  // 1:1 default
        _tokensIn.push(_yieldToken);
        _tokensOut.push(_yieldToken);
    }
    
    function getTokensIn() external view returns (address[] memory) {
        return _tokensIn;
    }
    
    function getTokensOut() external view returns (address[] memory) {
        return _tokensOut;
    }
    
    function setExchangeRate(uint256 _rate) external {
        exchangeRate = _rate;
    }
    
    function addTokenIn(address token) external {
        _tokensIn.push(token);
    }
    
    function addTokenOut(address token) external {
        _tokensOut.push(token);
    }
}
