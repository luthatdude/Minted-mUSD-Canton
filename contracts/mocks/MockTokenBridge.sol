// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title MockTokenBridge
 * @notice Mock Wormhole Token Bridge for testing
 * @dev Test-only contract, locked ether is acceptable
 */
// slither-disable-next-line locked-ether
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
