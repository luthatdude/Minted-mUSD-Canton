// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockTokenBridge
 * @notice Mock Wormhole Token Bridge for testing
 */
contract MockTokenBridge {
    uint64 private _sequence;

    function transferTokens(
        address,
        uint256,
        uint16,
        bytes32,
        uint256,
        uint32
    ) external payable returns (uint64 sequence) {
        _sequence++;
        return _sequence;
    }

    function wrappedAsset(uint16, bytes32) external pure returns (address) {
        return address(0);
    }
}
