// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IDirectMint
/// @notice Interface for DirectMintV2 minting on behalf of users.
/// Import this instead of redeclaring inline.
/// @dev Consumer: TreasuryReceiver
interface IDirectMint {
    function mintFor(address recipient, uint256 usdcAmount) external returns (uint256 musdMinted);
}
