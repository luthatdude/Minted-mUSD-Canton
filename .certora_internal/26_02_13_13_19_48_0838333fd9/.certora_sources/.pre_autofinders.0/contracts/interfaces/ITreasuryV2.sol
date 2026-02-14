// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ITreasuryV2
/// @notice Canonical interface for TreasuryV2 — superset of all consumer needs.
/// Replaces inline ITreasury, ITreasuryV2, ITreasuryV2_Withdraw definitions.
/// @dev Consumers: DirectMintV2, BorrowModule, SMUSD, InterestRateModel, TreasuryReceiver
interface ITreasuryV2 {
    function deposit(address from, uint256 amount) external;
    function withdraw(address to, uint256 amount) external;
    function availableReserves() external view returns (uint256);
    function totalValue() external view returns (uint256);
    function totalValueNet() external view returns (uint256);
}
