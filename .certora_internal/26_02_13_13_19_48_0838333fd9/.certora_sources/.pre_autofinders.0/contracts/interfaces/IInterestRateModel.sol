// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IInterestRateModel
/// @notice Canonical interface for InterestRateModel.
/// Import this instead of redeclaring inline.
/// @dev Consumer: BorrowModule
interface IInterestRateModel {
    function calculateInterest(
        uint256 principal,
        uint256 totalBorrows,
        uint256 totalSupply,
        uint256 secondsElapsed
    ) external view returns (uint256);

    function splitInterest(uint256 interestAmount)
        external view returns (uint256 supplierAmount, uint256 reserveAmount);

    function getBorrowRateAnnual(uint256 totalBorrows, uint256 totalSupply)
        external view returns (uint256);

    function getSupplyRateAnnual(uint256 totalBorrows, uint256 totalSupply)
        external view returns (uint256);

    function utilizationRate(uint256 totalBorrows, uint256 totalSupply)
        external pure returns (uint256);
}
