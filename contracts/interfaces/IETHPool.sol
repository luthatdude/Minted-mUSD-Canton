// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IETHPool
/// @notice Canonical interface for the ETH Pool contract.
/// @dev Consumers: frontend, relay service, monitoring
interface IETHPool {
    // ── Staking ──────────────────────────────────────────────────────────
    function stake(uint8 tier) external payable returns (uint256 positionId);
    function unstake(uint256 positionId) external;

    // ── View ─────────────────────────────────────────────────────────────
    function sharePrice() external view returns (uint256);
    function totalETHDeposited() external view returns (uint256);
    function totalMUSDMinted() external view returns (uint256);
    function totalSMUSDEIssued() external view returns (uint256);
    function poolCap() external view returns (uint256);
    function canUnstake(address user, uint256 positionId) external view returns (bool);
    function getRemainingLockTime(address user, uint256 positionId) external view returns (uint256);
    function getTierConfig(uint8 tier) external view returns (uint256 duration, uint256 multiplierBps);
    function getPositionCount(address user) external view returns (uint256);
}
