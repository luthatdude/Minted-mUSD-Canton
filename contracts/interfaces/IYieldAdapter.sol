// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title IYieldAdapter
 * @notice Modular interface for on-chain yield verification per protocol.
 * @dev Each adapter reads live rate data from a single DeFi protocol.
 *      Adapters are view-only and never hold funds.
 */
interface IYieldAdapter {
    /// @notice Verify the current yield from a protocol venue
    /// @param venue The protocol contract address (pool / comet / vault / market)
    /// @param extraData Protocol-specific data (e.g., marketId for Morpho)
    /// @return supplyApyBps Current supply APY in basis points
    /// @return borrowApyBps Current borrow APY in bps (0 if N/A)
    /// @return tvlUsd6 Total value locked in 6-decimal USD terms
    /// @return utilizationBps Current utilization in bps
    /// @return available Whether the venue accepts new deposits
    function verify(
        address venue,
        bytes32 extraData
    ) external view returns (
        uint256 supplyApyBps,
        uint256 borrowApyBps,
        uint256 tvlUsd6,
        uint256 utilizationBps,
        bool available
    );

    /// @return name Human-readable protocol adapter name
    function protocolName() external view returns (string memory name);

    /// @return id Protocol ID matching the YieldScanner.Protocol enum
    function protocolId() external view returns (uint256 id);
}
