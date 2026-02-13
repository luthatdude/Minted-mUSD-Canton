// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IWormholeRelayer
/// @notice Minimal interface for Wormhole's automatic relayer.
/// Import this instead of redeclaring inline.
/// @dev Consumer: DepositRouter
interface IWormholeRelayer {
    function sendPayloadToEvm(
        uint16 targetChain,
        address targetAddress,
        bytes memory payload,
        uint256 receiverValue,
        uint256 gasLimit
    ) external payable returns (uint64 sequence);

    function quoteEVMDeliveryPrice(
        uint16 targetChain,
        uint256 receiverValue,
        uint256 gasLimit
    ) external view returns (uint256 nativePriceQuote, uint256 targetChainRefundPerGasUnused);
}
