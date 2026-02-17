// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IETHPool
/// @notice Canonical interface for the ETH Pool contract.
/// @dev Consumers: frontend, relay service, monitoring, Fluid rebalancer keeper
interface IETHPool {
    // ── Multi-asset Staking ─────────────────────────────────────────────
    function stake(uint8 tier) external payable returns (uint256 positionId);
    function stakeWithToken(address token, uint256 amount, uint8 tier) external returns (uint256 positionId);
    function unstake(uint256 positionId) external;

    // ── Fluid Strategy ──────────────────────────────────────────────────
    function deployToStrategy(uint256 amount) external;
    function withdrawFromStrategy(uint256 amount) external;
    function totalPoolValue() external view returns (uint256);
    function strategyHealthFactor() external view returns (uint256);
    function strategyPosition() external view returns (
        uint256 collateral,
        uint256 borrowed,
        uint256 principal,
        uint256 netValue
    );
    function totalDeployedToStrategy() external view returns (uint256);

    // ── Stablecoin Config ───────────────────────────────────────────────
    function acceptedStablecoins(address token) external view returns (bool);
    function stablecoinDecimals(address token) external view returns (uint8);

    // ── Pool State ──────────────────────────────────────────────────────
    function sharePrice() external view returns (uint256);
    function totalETHDeposited() external view returns (uint256);
    function totalStablecoinDeposited() external view returns (uint256);
    function totalMUSDMinted() external view returns (uint256);
    function totalSMUSDEIssued() external view returns (uint256);
    function poolCap() external view returns (uint256);
    function canUnstake(address user, uint256 positionId) external view returns (bool);
    function getRemainingLockTime(address user, uint256 positionId) external view returns (uint256);
    function getTierConfig(uint8 tier) external view returns (uint256 duration, uint256 multiplierBps);
    function getPositionCount(address user) external view returns (uint256);
}
