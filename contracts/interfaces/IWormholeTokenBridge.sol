// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IWormholeTokenBridge
/// @notice Interface for Wormhole Token Bridge.
/// Import this instead of redeclaring inline.
/// @dev Consumer: DepositRouter
interface IWormholeTokenBridge {
    function transferTokens(
        address token,
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        uint256 arbiterFee,
        uint32 nonce
    ) external payable returns (uint64 sequence);

    /// @notice Transfer tokens with an arbitrary payload (for recipient data)
    function transferTokensWithPayload(
        address token,
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        uint32 nonce,
        bytes memory payload
    ) external payable returns (uint64 sequence);

    function wrappedAsset(uint16 tokenChainId, bytes32 tokenAddress)
        external
        view
        returns (address);
}
