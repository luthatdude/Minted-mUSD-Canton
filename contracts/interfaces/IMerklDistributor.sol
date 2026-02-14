// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title IMerklDistributor
 * @notice Interface for Angle Protocol's Merkl reward distributor
 * @dev Merkl distributes reward tokens to liquidity providers across DeFi protocols
 *      Mainnet: 0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae
 *
 * Flow: claim(users, tokens, amounts, proofs) → rewards sent to user
 * Off-chain: Merkl API provides merkle proofs for accumulated rewards
 */
interface IMerklDistributor {
    /// @notice Claim accumulated rewards for multiple tokens
    /// @param users Array of addresses to claim for
    /// @param tokens Array of reward token addresses
    /// @param amounts Array of amounts to claim
    /// @param proofs Array of merkle proofs (concatenated 32-byte hashes)
    function claim(
        address[] calldata users,
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes32[][] calldata proofs
    ) external;

    /// @notice Check if a claim has already been made
    /// @param user The user address
    /// @param token The reward token address
    /// @return claimed Amount already claimed
    function claimed(address user, address token) external view returns (uint256 claimed);

    /// @notice Toggle trusted operator status for a user
    /// @param operator The operator address to toggle
    function toggleOperator(address user, address operator) external;

    /// @notice Check if operator is trusted by user
    function operators(address user, address operator) external view returns (uint256);
}
