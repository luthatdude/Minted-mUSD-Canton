// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title IMintedTimelockController
 * @notice Interface for the central MintedTimelockController.
 * @dev Used by contracts that need to verify operations are coming through the timelock.
 */
interface IMintedTimelockController {
    function isOperationReady(bytes32 id) external view returns (bool);
    function isOperationPending(bytes32 id) external view returns (bool);
    function isOperationDone(bytes32 id) external view returns (bool);
    function getTimestamp(bytes32 id) external view returns (uint256);
    function getMinDelay() external view returns (uint256);
}
