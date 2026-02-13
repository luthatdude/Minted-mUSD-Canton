// SPDX-License-Identifier: BUSL-1.1
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

/// @dev Minimal ERC-20 interface for balance checks
interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
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

    /// @notice Maximum blocks for rate limiter (~1 hour at 12s blocks)
    uint256 private constant MAX_RATE_LIMIT_BLOCKS = 300;

    /// @notice Minimum valid share price (0.95 USD) — protects against vault manipulation
    uint256 public minSharePrice = 0.95e8;

    /// @notice Maximum valid share price (2.0 USD) — protects against donation attacks
    uint256 public maxSharePrice = 2.0e8;

    /// @notice Minimum totalSupply to trust convertToAssets (anti-donation-attack)
    /// @dev If totalSupply < this, the vault is too small and share price is unreliable
    uint256 public minTotalSupply = 1000e18;

    /// @notice Maximum allowed price change per block (rate limiter, 8 decimals)
    /// @dev Prevents single-block donation from moving price more than 5%
    uint256 public maxPriceChangePerBlock = 0.05e8; // 5 cents = 5% on a $1 token

    /// @notice Cached price from the last query (for rate limiting)
    uint256 private _lastPrice;

    /// @notice Block number of the last query (used for rate limiting)
    uint256 private _lastPriceBlock;

    /// @notice Timestamp of the last cache update (used for Chainlink output)
    uint256 private _lastPriceTimestamp;

    /// @notice Internal round tracking
    uint80 private _roundId;

    event SharePriceBoundsUpdated(uint256 minPrice, uint256 maxPrice);
    event DonationProtectionUpdated(uint256 minTotalSupply, uint256 maxPriceChangePerBlock);

    error InvalidSharePrice(uint256 price);
    error SMUSDZeroAddress();
    error VaultTotalSupplyTooLow(uint256 totalSupply, uint256 minRequired);

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
    /// @dev Returns price as `view` for AggregatorV3 interface compliance.
    ///      The rate limiter cache is updated via the separate `updateCachedPrice()` function
    ///      which should be called by a keeper or before any price-sensitive operation.
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

        // Return cached timestamp so downstream staleness checks work correctly.
        // If never cached, return current block.timestamp as fallback.
        uint256 cachedTimestamp = _lastPriceTimestamp > 0 ? _lastPriceTimestamp : block.timestamp;
        
        return (
            _roundId,
            int256(price),
            cachedTimestamp,
            cachedTimestamp,
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

    event SharePriceClamped(uint256 rawPrice, uint256 clampedPrice);

    /// @notice Derive sMUSD price in USD (8 decimals) from vault share price
    /// @dev SPA-M01: Round is managed via incrementRound() admin function.
    function _getSharePriceUsd() internal view returns (uint256) {
        // With very few shares, a small donation can wildly inflate convertToAssets
        uint256 totalSupply = ISMUSD(smusd).totalSupply();
        if (totalSupply < minTotalSupply) {
            // Vault too small to trust — return last known price or minSharePrice
            return _lastPrice > 0 ? _lastPrice : minSharePrice;
        }

        // If totalAssets greatly exceeds the vault's actual token balance, someone donated
        // Note: totalAssets is used implicitly via convertToAssets; the totalSupply check
        // above is the primary guard since donation attacks work by inflating assets/shares ratio

        // convertToAssets(1e18) returns how much mUSD (18 decimals) 1 sMUSD is worth
        uint256 assetsPerShare = ISMUSD(smusd).convertToAssets(ONE_SHARE);

        // Convert from 18 decimals (mUSD) to 8 decimals (Chainlink USD)
        uint256 priceUsd = assetsPerShare / 1e10;

        if (priceUsd < minSharePrice) {
            priceUsd = minSharePrice;
        } else if (priceUsd > maxSharePrice) {
            priceUsd = maxSharePrice;
        }

        // If the price jumped too much from last block, clamp the change
        if (_lastPrice > 0 && _lastPriceBlock < block.number) {
            uint256 blocksSinceLast = block.number - _lastPriceBlock;
            // After MAX_RATE_LIMIT_BLOCKS, the rate limiter becomes ineffective
            if (blocksSinceLast > MAX_RATE_LIMIT_BLOCKS) {
                blocksSinceLast = MAX_RATE_LIMIT_BLOCKS;
            }
            uint256 maxAllowedChange = maxPriceChangePerBlock * blocksSinceLast;
            if (priceUsd > _lastPrice + maxAllowedChange) {
                priceUsd = _lastPrice + maxAllowedChange;
            } else if (_lastPrice > maxAllowedChange && priceUsd < _lastPrice - maxAllowedChange) {
                priceUsd = _lastPrice - maxAllowedChange;
            }
        }

        return priceUsd;
    }

    /// @notice Public function to update the cached price (callable by anyone)
    /// @dev Any price consumer can trigger a cache update before reading.
    /// @dev Also increments roundId so consumers can detect updates
    function updateCachedPrice() external {
        uint256 price = _getSharePriceUsd();
        _lastPrice = price;
        _lastPriceBlock = block.number;
        _lastPriceTimestamp = block.timestamp;
        _roundId++;
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

    /// @notice Update donation attack protection parameters
    /// @param _minTotalSupply Minimum totalSupply to trust vault price
    /// @param _maxPriceChangePerBlock Max price delta allowed per block (8 decimals)
    function setDonationProtection(
        uint256 _minTotalSupply,
        uint256 _maxPriceChangePerBlock
    ) external onlyRole(ADAPTER_ADMIN_ROLE) {
        require(_minTotalSupply > 0, "MIN_SUPPLY_ZERO");
        require(_maxPriceChangePerBlock > 0, "MAX_CHANGE_ZERO");
        require(_maxPriceChangePerBlock <= 0.50e8, "MAX_CHANGE_TOO_HIGH"); // Cap at 50%

        minTotalSupply = _minTotalSupply;
        maxPriceChangePerBlock = _maxPriceChangePerBlock;

        emit DonationProtectionUpdated(_minTotalSupply, _maxPriceChangePerBlock);
    }

    /// @notice Increment round (for keepers/admin to signal fresh data)
    function incrementRound() external onlyRole(ADAPTER_ADMIN_ROLE) {
        _roundId++;
    }
}
