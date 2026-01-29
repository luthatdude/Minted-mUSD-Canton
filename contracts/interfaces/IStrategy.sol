// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title IStrategy
 * @notice Interface for yield strategies that TreasuryV2 deploys USDC into
 * @dev Each strategy wraps a DeFi protocol (Pendle, Morpho, Sky sUSDS, etc.)
 *      and exposes a uniform deposit/withdraw/value interface.
 *
 * Strategy implementations must:
 *   1. Accept USDC deposits via deposit()
 *   2. Return USDC on withdraw()/withdrawAll()
 *   3. Report accurate totalValue() in USDC terms
 *   4. Handle approve/transferFrom for deposits from Treasury
 */
interface IStrategy {
    /// @notice Deposit USDC into the strategy
    /// @param amount Amount of USDC to deposit
    /// @return deposited Actual amount deposited (may differ due to slippage)
    function deposit(uint256 amount) external returns (uint256 deposited);

    /// @notice Withdraw USDC from the strategy
    /// @param amount Amount of USDC to withdraw
    /// @return withdrawn Actual amount withdrawn
    function withdraw(uint256 amount) external returns (uint256 withdrawn);

    /// @notice Withdraw all USDC from the strategy
    /// @return withdrawn Total amount withdrawn
    function withdrawAll() external returns (uint256 withdrawn);

    /// @notice Total value of assets held by this strategy (in USDC terms)
    /// @return Total value in USDC (6 decimals)
    function totalValue() external view returns (uint256);

    /// @notice The underlying asset this strategy accepts (should be USDC)
    function asset() external view returns (address);

    /// @notice Whether the strategy is currently accepting deposits
    function isActive() external view returns (bool);
}
