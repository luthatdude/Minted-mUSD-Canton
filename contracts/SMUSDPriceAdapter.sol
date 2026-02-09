// SPDX-License-Identifier: MIT
// Minted mUSD Protocol - sMUSD Price Adapter
// Chainlink-compatible price feed for sMUSD (ERC-4626 vault token)
// Reports the USD value of 1 sMUSD based on the vault's share price

pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";

/// @dev ERC-4626 interface for reading share price
interface ISMUSD {
    /// @notice Convert 1 share to assets (mUSD)
    function convertToAssets(uint256 shares) external view returns (uint256);
    /// @notice Total assets under management
    function totalAssets() external view returns (uint256);
    /// @notice Total shares outstanding
    function totalSupply() external view returns (uint256);
    /// @notice Decimals offset used in share price
    function decimalsOffset() external view returns (uint8);
}

/// @title SMUSDPriceAdapter
/// @notice Chainlink AggregatorV3-compatible price feed for sMUSD.
///         Reports: USD price of 1 sMUSD = sharePrice × mUSD_price.
///         Since mUSD is pegged 1:1 to USD, sharePrice ≈ sMUSD price in USD.
/// @dev Used by PriceOracle to value sMUSD collateral in the CollateralVault.
///      The share price is derived from the ERC-4626 vault's convertToAssets(),
///      which accounts for accrued interest from borrowers.
contract SMUSDPriceAdapter is AccessControl {
    bytes32 public constant ADAPTER_ADMIN_ROLE = keccak256("ADAPTER_ADMIN_ROLE");

    /// @notice The SMUSD ERC-4626 vault
    address public immutable smusd;

    /// @notice Price decimals (matches Chainlink convention: 8 decimals)
    uint8 public constant DECIMALS = 8;

    /// @notice 1 full sMUSD share (18 decimals)
    uint256 private constant ONE_SHARE = 1e18;

    /// @notice Minimum valid share price (0.95 USD) — protects against vault manipulation
    uint256 public minSharePrice = 0.95e8;

    /// @notice Maximum valid share price (2.0 USD) — protects against donation attacks
    uint256 public maxSharePrice = 2.0e8;

    /// @notice Internal round tracking
    uint80 private _roundId;

    event SharePriceBoundsUpdated(uint256 minPrice, uint256 maxPrice);

    error InvalidSharePrice(uint256 price);
    error SMUSDZeroAddress();

    constructor(address _smusd, address _admin) {
        if (_smusd == address(0)) revert SMUSDZeroAddress();

        smusd = _smusd;
        _roundId = 1;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ADAPTER_ADMIN_ROLE, _admin);
    }

    // ============================================================
    //                  AGGREGATOR V3 INTERFACE
    // ============================================================

    /// @notice Returns 8 (standard Chainlink USD feed decimals)
    function decimals() external pure returns (uint8) {
        return DECIMALS;
    }

    /// @notice Returns the description of this feed
    function description() external pure returns (string memory) {
        return "sMUSD / USD";
    }

    /// @notice Returns the version of this feed
    function version() external pure returns (uint256) {
        return 1;
    }

    /// @notice Get the latest price data in Chainlink AggregatorV3 format
    /// @return roundId Incrementing round counter
    /// @return answer sMUSD price in USD with 8 decimals (e.g., 1.05e8 = $1.05)
    /// @return startedAt Current block timestamp
    /// @return updatedAt Current block timestamp (always fresh — derived from on-chain state)
    /// @return answeredInRound Same as roundId (always complete)
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        uint256 price = _getSharePriceUsd();
        return (
            _roundId,
            int256(price),
            block.timestamp,
            block.timestamp,  // Always "fresh" since it's derived from on-chain vault state
            _roundId
        );
    }

    /// @notice Get data for a specific round (returns latest for all rounds)
    function getRoundData(uint80 /* _roundId_ */)
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        uint256 price = _getSharePriceUsd();
        return (
            _roundId,
            int256(price),
            block.timestamp,
            block.timestamp,
            _roundId
        );
    }

    // ============================================================
    //                  INTERNAL
    // ============================================================

    /// @notice Derive sMUSD price in USD (8 decimals) from vault share price
    /// @dev sharePrice = convertToAssets(1e18) / 1e18 (in mUSD terms)
    ///      Since mUSD ≈ $1, sharePrice in mUSD ≈ sharePrice in USD
    ///      Convert from 18 decimals to 8 decimals for Chainlink compatibility
    function _getSharePriceUsd() internal view returns (uint256) {
        // convertToAssets(1e18) returns how much mUSD (18 decimals) 1 sMUSD is worth
        uint256 assetsPerShare = ISMUSD(smusd).convertToAssets(ONE_SHARE);

        // Convert from 18 decimals (mUSD) to 8 decimals (Chainlink USD)
        // assetsPerShare is in 1e18, we want 1e8
        uint256 priceUsd = assetsPerShare / 1e10;

        // Sanity bounds — protect against vault manipulation
        if (priceUsd < minSharePrice || priceUsd > maxSharePrice) {
            revert InvalidSharePrice(priceUsd);
        }

        return priceUsd;
    }

    // ============================================================
    //                  ADMIN
    // ============================================================

    /// @notice Update share price bounds (governance-controlled)
    /// @param _minPrice Minimum valid price (8 decimals)
    /// @param _maxPrice Maximum valid price (8 decimals)
    function setSharePriceBounds(
        uint256 _minPrice,
        uint256 _maxPrice
    ) external onlyRole(ADAPTER_ADMIN_ROLE) {
        require(_minPrice > 0, "MIN_ZERO");
        require(_maxPrice > _minPrice, "MAX_LTE_MIN");
        require(_maxPrice <= 10e8, "MAX_TOO_HIGH"); // Cap at $10

        minSharePrice = _minPrice;
        maxSharePrice = _maxPrice;

        emit SharePriceBoundsUpdated(_minPrice, _maxPrice);
    }

    /// @notice Increment round (for keepers/admin to signal fresh data)
    function incrementRound() external onlyRole(ADAPTER_ADMIN_ROLE) {
        _roundId++;
    }
}
