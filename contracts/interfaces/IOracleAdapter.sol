// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title IOracleAdapter
 * @notice Modular oracle adapter interface for pluggable price feeds
 * @dev Each adapter wraps a single oracle protocol (Chainlink, API3, Pyth, etc.)
 *      Adapters are stateless view contracts — they never hold funds
 */
interface IOracleAdapter {
    /// @notice Get the USD price of a token, normalized to 18 decimals
    /// @param token The token address to price
    /// @return price USD price per token unit, scaled to 18 decimals
    /// @return updatedAt Timestamp of the latest price update
    function getPrice(address token) external view returns (uint256 price, uint256 updatedAt);

    /// @notice Check if this adapter supports a given token
    /// @param token The token address to check
    /// @return supported True if this adapter can price the token
    function supportsToken(address token) external view returns (bool supported);

    /// @notice Get the adapter's source identifier
    /// @return source Human-readable source name (e.g., "Chainlink", "API3")
    function source() external pure returns (string memory);

    /// @notice Check if the price feed is healthy (responding, fresh data)
    /// @param token The token to check
    /// @return healthy True if the feed is active and fresh
    function isHealthy(address token) external view returns (bool healthy);
}
