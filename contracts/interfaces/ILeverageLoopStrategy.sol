// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "./IStrategy.sol";

/**
 * @title ILeverageLoopStrategy
 * @notice Extended interface for leveraged looping strategies
 * @dev Adds health monitoring, rebalancing, and Merkl reward claiming
 *      on top of the base IStrategy interface.
 *
 * All leverage loop strategies:
 *   1. Deposit USDC → Supply as collateral → Borrow → Re-supply → Loop
 *   2. Monitor health factor and rebalance when needed
 *   3. Claim Merkl rewards and compound into position
 *   4. Emergency deleverage if health drops below threshold
 */
interface ILeverageLoopStrategy is IStrategy {
    // ═══════════════════════════════════════════════════════════════════
    // HEALTH & POSITION VIEW
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Current health factor (1e18 = 1.0x)
    function getHealthFactor() external view returns (uint256);

    /// @notice Current leverage ratio (100 = 1.0x, 333 = 3.33x)
    function getCurrentLeverage() external view returns (uint256 leverageX100);

    /// @notice Full position snapshot
    /// @return collateral Total collateral supplied
    /// @return borrowed Total debt outstanding
    /// @return principal Original USDC deposited (before leverage)
    /// @return netValue collateral - borrowed
    function getPosition() external view returns (
        uint256 collateral,
        uint256 borrowed,
        uint256 principal,
        uint256 netValue
    );

    /// @notice Target LTV in basis points (e.g., 7000 = 70%)
    function targetLtvBps() external view returns (uint256);

    /// @notice Number of supply/borrow loops
    function targetLoops() external view returns (uint256);

    // ═══════════════════════════════════════════════════════════════════
    // REAL SHARE PRICE & TVL (Stability DAO pattern)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Real share price accounting for all debt and fees
    /// @return priceWad Share price in WAD (1e18 = 1.0)
    /// @return trusted Whether the price comes from a healthy oracle/feed
    function realSharePrice() external view returns (uint256 priceWad, bool trusted);

    /// @notice Real TVL (Total Value Locked) net of all debt
    /// @return tvl Net TVL in asset terms (e.g., USDC 6 decimals)
    /// @return trusted Whether the TVL calculation is from healthy sources
    function realTvl() external view returns (uint256 tvl, bool trusted);

    // ═══════════════════════════════════════════════════════════════════
    // REBALANCE & REWARDS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Rebalance debt to restore target LTV
    /// @dev Called by keeper/guardian when LTV drifts from target
    function rebalance() external;

    /// @notice Adjust leverage to a new LTV with share price protection
    /// @param newLtvBps New target LTV in basis points
    /// @param minSharePrice Minimum acceptable share price post-adjustment (WAD)
    /// @dev Reverts if post-adjustment share price drops below minSharePrice
    function adjustLeverage(uint256 newLtvBps, uint256 minSharePrice) external;

    /// @notice Claim Merkl rewards and compound into position
    /// @param tokens Reward token addresses
    /// @param amounts Reward amounts to claim
    /// @param proofs Merkle proofs for each claim
    function claimAndCompound(
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes32[][] calldata proofs
    ) external;

    /// @notice Emergency deleverage — fully unwind position
    function emergencyDeleverage() external;

    // ═══════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event Leveraged(uint256 principal, uint256 totalSupplied, uint256 leverage, uint256 loops);
    event Rebalanced(uint256 oldLtv, uint256 newLtv, uint256 adjustment);
    event RewardsClaimed(address indexed token, uint256 amount);
    event RewardsCompounded(uint256 totalCompounded, uint256 newLeverage);
    event EmergencyDeleveraged(uint256 healthBefore, uint256 healthAfter);
}
