// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Mock Chainlink Aggregator V3
/// @notice For testing NAV oracle functionality
contract MockAggregatorV3 {
    uint8 private _decimals;
    int256 private _answer;
    uint256 private _updatedAt;
    uint80 private _roundId;

    constructor(uint8 decimals_, int256 initialAnswer) {
        _decimals = decimals_;
        _answer = initialAnswer;
        _updatedAt = block.timestamp;
        _roundId = 1;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }

    // Test helpers
    function setAnswer(int256 answer) external {
        _answer = answer;
        _updatedAt = block.timestamp;
        _roundId++;
    }

    function setUpdatedAt(uint256 timestamp) external {
        _updatedAt = timestamp;
    }

    function setDecimals(uint8 decimals_) external {
        _decimals = decimals_;
    }
}
