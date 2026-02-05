// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title MockWormholeRelayer
 * @notice Mock contract for testing DepositRouter
 * @dev Test-only contract, locked ether is acceptable
 */
// slither-disable-next-line locked-ether
contract MockWormholeRelayer {
    uint64 private _sequence;
    uint256 public bridgeCost;
    
    constructor(uint256 _bridgeCost) {
        bridgeCost = _bridgeCost;
    }

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
    ) external view returns (uint256 nativePriceQuote, uint256 targetChainRefundPerGasUnused) {
        return (bridgeCost, 0);
    }
}
