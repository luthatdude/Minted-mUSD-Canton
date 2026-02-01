// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockWormholeRelayer
 * @notice Mock contract for testing DepositRouter
 * @dev Test-only contract, locked ether is acceptable
 */
// slither-disable-next-line locked-ether
contract MockWormholeRelayer {
    uint64 private _sequence;

    function sendPayloadToEvm(
        uint16,
        address,
        bytes memory,
        uint256,
        uint256
    ) external payable returns (uint64 sequence) {
        _sequence++;
        return _sequence;
    }

    function quoteEVMDeliveryPrice(
        uint16,
        uint256,
        uint256
    ) external pure returns (uint256 nativePriceQuote, uint256 targetChainRefundPerGasUnused) {
        return (0.01 ether, 0);
    }
}
