// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../interfaces/IOracleAdapter.sol";

/// @title MockOracleAdapter
/// @notice Mock implementation of IOracleAdapter for testing PriceAggregator
contract MockOracleAdapter is IOracleAdapter {
    string public _source;
    uint256 public _price;

    constructor(string memory source_, uint256 price_) {
        _source = source_;
        _price = price_;
    }

    function setPrice(uint256 price_) external {
        _price = price_;
    }

    function getPrice(address) external view override returns (uint256 price, uint256 updatedAt) {
        return (_price, block.timestamp);
    }

    function supportsToken(address) external pure override returns (bool) {
        return true;
    }

    function source() external pure override returns (string memory) {
        return "MockOracle";
    }

    function isHealthy(address) external pure override returns (bool) {
        return true;
    }
}
