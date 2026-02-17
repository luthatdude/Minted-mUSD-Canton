// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ITokenBridge
/// @notice Interface for Wormhole Token Bridge transfer completion.
/// Import this instead of redeclaring inline.
/// @dev Consumer: TreasuryReceiver
interface ITokenBridge {
    function completeTransfer(bytes memory encodedVm) external;
    function completeTransferAndUnwrapETH(bytes memory encodedVm) external;
}
