// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ISkyPSM
/// @notice Sky/Maker Peg Stability Module interface.
/// Import this instead of redeclaring inline.
/// @dev Consumer: SkySUSDSStrategy
interface ISkyPSM {
    /// @notice Swap USDC for USDS (scales 6→18 decimals internally)
    function sellGem(address usr, uint256 gemAmt) external;

    /// @notice Swap USDS for USDC (scales 18→6 decimals internally)
    function buyGem(address usr, uint256 gemAmt) external;

    /// @notice Fee on sellGem (typically 0 for USDC)
    function tin() external view returns (uint256);

    /// @notice Fee on buyGem (typically 0 for USDC)
    function tout() external view returns (uint256);
}
