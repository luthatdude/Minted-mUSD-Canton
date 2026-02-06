// SPDX-License-Identifier: MIT
// BLE Protocol - Price Oracle Aggregator
// Wraps Chainlink feeds for ETH/BTC price data used by CollateralVault and LiquidationEngine

pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";

interface IAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
    function decimals() external view returns (uint8);
}

/// @title PriceOracle
/// @notice Aggregates Chainlink price feeds for collateral assets (ETH, BTC, etc.)
/// @dev All prices are normalized to 18 decimals (USD value per 1 full token unit)
contract PriceOracle is AccessControl {
    bytes32 public constant ORACLE_ADMIN_ROLE = keccak256("ORACLE_ADMIN_ROLE");

    struct FeedConfig {
        IAggregatorV3 feed;
        uint256 stalePeriod;  // Max age in seconds before data is considered stale
        uint8 tokenDecimals;  // Decimals of the collateral token (e.g., 18 for ETH, 8 for WBTC)
        bool enabled;
    }

    // collateral token address => feed config
    mapping(address => FeedConfig) public feeds;
    
    /// @dev FIX S-H01: Circuit breaker - track last known prices and max deviation
    mapping(address => uint256) public lastKnownPrice;
    uint256 public maxDeviationBps = 2000; // 20% max price change per update
    bool public circuitBreakerEnabled = true;

    event FeedUpdated(address indexed token, address feed, uint256 stalePeriod, uint8 tokenDecimals);
    event FeedRemoved(address indexed token);
    /// @dev FIX S-H01: Event for circuit breaker triggers
    event CircuitBreakerTriggered(address indexed token, uint256 oldPrice, uint256 newPrice, uint256 deviationBps);
    event MaxDeviationUpdated(uint256 oldBps, uint256 newBps);
    event CircuitBreakerToggled(bool enabled);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ORACLE_ADMIN_ROLE, msg.sender);
    }

    /// @dev FIX S-H01: Set max deviation for circuit breaker (in basis points)
    function setMaxDeviation(uint256 _maxDeviationBps) external onlyRole(ORACLE_ADMIN_ROLE) {
        require(_maxDeviationBps >= 100 && _maxDeviationBps <= 5000, "DEVIATION_OUT_OF_RANGE"); // 1% to 50%
        emit MaxDeviationUpdated(maxDeviationBps, _maxDeviationBps);
        maxDeviationBps = _maxDeviationBps;
    }

    /// @dev FIX S-H01: Toggle circuit breaker on/off
    function setCircuitBreakerEnabled(bool _enabled) external onlyRole(ORACLE_ADMIN_ROLE) {
        circuitBreakerEnabled = _enabled;
        emit CircuitBreakerToggled(_enabled);
    }

    /// @dev FIX S-H01: Manually update last known price (for recovery after circuit breaker trip)
    function resetLastKnownPrice(address token) external onlyRole(ORACLE_ADMIN_ROLE) {
        FeedConfig storage config = feeds[token];
        require(config.enabled, "FEED_NOT_ENABLED");
        (, int256 answer, , , ) = config.feed.latestRoundData();
        require(answer > 0, "INVALID_PRICE");
        uint8 feedDecimals = config.feed.decimals();
        lastKnownPrice[token] = uint256(answer) * (10 ** (18 - feedDecimals));
    }

    /// @notice Register or update a Chainlink price feed for a collateral token
    /// @param token The collateral token address
    /// @param feed The Chainlink aggregator address
    /// @param stalePeriod Maximum acceptable age of price data in seconds
    /// @param tokenDecimals The number of decimals the collateral token uses
    function setFeed(
        address token,
        address feed,
        uint256 stalePeriod,
        uint8 tokenDecimals
    ) external onlyRole(ORACLE_ADMIN_ROLE) {
        require(token != address(0), "INVALID_TOKEN");
        require(feed != address(0), "INVALID_FEED");
        require(stalePeriod > 0, "INVALID_STALE_PERIOD");
        // FIX H-1: Validate tokenDecimals at config time to prevent precision issues
        require(tokenDecimals <= 18, "TOKEN_DECIMALS_TOO_HIGH");

        feeds[token] = FeedConfig({
            feed: IAggregatorV3(feed),
            stalePeriod: stalePeriod,
            tokenDecimals: tokenDecimals,
            enabled: true
        });

        // FIX S-M07: Auto-initialize lastKnownPrice from the feed to prevent stale fallback gaps
        try IAggregatorV3(feed).latestRoundData() returns (
            uint80, int256 answer, uint256, uint256, uint80
        ) {
            if (answer > 0) {
                uint256 feedDecimals = IAggregatorV3(feed).decimals();
                lastKnownPrice[token] = uint256(answer) * (10 ** (18 - feedDecimals));
            }
        } catch {
            // Feed not yet reporting — lastKnownPrice stays 0 until first getPrice() call
        }

        emit FeedUpdated(token, feed, stalePeriod, tokenDecimals);
    }

    /// @notice Remove a price feed
    function removeFeed(address token) external onlyRole(ORACLE_ADMIN_ROLE) {
        require(feeds[token].enabled, "FEED_NOT_FOUND");
        delete feeds[token];
        emit FeedRemoved(token);
    }

    /// @notice Get the USD price of a collateral token, normalized to 18 decimals
    /// @param token The collateral token address
    /// @return price USD value of 1 full token unit, scaled to 18 decimals
    function getPrice(address token) external view returns (uint256 price) {
        FeedConfig storage config = feeds[token];
        require(config.enabled, "FEED_NOT_ENABLED");

        // FIX M-23: Capture roundId and answeredInRound for staleness check
        (
            uint80 roundId,
            int256 answer,
            ,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = config.feed.latestRoundData();

        require(answer > 0, "INVALID_PRICE");
        require(block.timestamp - updatedAt <= config.stalePeriod, "STALE_PRICE");
        // FIX M-23: Ensure the round was fully answered (not incomplete)
        require(answeredInRound >= roundId, "STALE_ROUND");

        uint8 feedDecimals = config.feed.decimals();
        require(feedDecimals <= 18, "UNSUPPORTED_FEED_DECIMALS");

        // Chainlink answer is price per 1 token unit in USD, scaled to feedDecimals
        // Normalize to 18 decimals
        price = uint256(answer) * (10 ** (18 - feedDecimals));

        // FIX S-H01: Circuit breaker check (view-compatible - checks against cached price)
        if (circuitBreakerEnabled && lastKnownPrice[token] > 0) {
            uint256 oldPrice = lastKnownPrice[token];
            uint256 diff = price > oldPrice ? price - oldPrice : oldPrice - price;
            uint256 deviationBps = (diff * 10000) / oldPrice;
            require(deviationBps <= maxDeviationBps, "CIRCUIT_BREAKER_TRIGGERED");
        }
        // Note: lastKnownPrice is updated via updatePrice() or admin resetLastKnownPrice()
    }

    /// @notice FIX S-H01: Update cached price (call before getPrice if circuit breaker trips)
    /// @dev This allows keepers to update the price after verifying the deviation is legitimate
    function updatePrice(address token) external onlyRole(ORACLE_ADMIN_ROLE) {
        FeedConfig storage config = feeds[token];
        require(config.enabled, "FEED_NOT_ENABLED");
        
        (, int256 answer, , uint256 updatedAt, ) = config.feed.latestRoundData();
        require(answer > 0, "INVALID_PRICE");
        require(block.timestamp - updatedAt <= config.stalePeriod, "STALE_PRICE");
        
        uint8 feedDecimals = config.feed.decimals();
        uint256 newPrice = uint256(answer) * (10 ** (18 - feedDecimals));
        uint256 oldPrice = lastKnownPrice[token];
        
        if (oldPrice > 0) {
            uint256 diff = newPrice > oldPrice ? newPrice - oldPrice : oldPrice - newPrice;
            uint256 deviationBps = (diff * 10000) / oldPrice;
            emit CircuitBreakerTriggered(token, oldPrice, newPrice, deviationBps);
        }
        
        lastKnownPrice[token] = newPrice;
    }

    /// @notice Get the USD value of a specific amount of collateral
    /// @param token The collateral token address
    /// @param amount The amount of collateral (in token's native decimals)
    /// @return valueUsd USD value scaled to 18 decimals
    function getValueUsd(address token, uint256 amount) external view returns (uint256 valueUsd) {
        FeedConfig storage config = feeds[token];
        require(config.enabled, "FEED_NOT_ENABLED");

        // FIX M-23: Capture roundId and answeredInRound for staleness check
        (
            uint80 roundId,
            int256 answer,
            ,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = config.feed.latestRoundData();

        require(answer > 0, "INVALID_PRICE");
        require(block.timestamp - updatedAt <= config.stalePeriod, "STALE_PRICE");
        // FIX M-23: Ensure the round was fully answered (not incomplete)
        require(answeredInRound >= roundId, "STALE_ROUND");

        uint8 feedDecimals = config.feed.decimals();
        require(feedDecimals <= 18, "UNSUPPORTED_FEED_DECIMALS");

        // price per token in 18 decimals
        uint256 priceNormalized = uint256(answer) * (10 ** (18 - feedDecimals));

        // value = amount * price / 10^tokenDecimals
        valueUsd = (amount * priceNormalized) / (10 ** config.tokenDecimals);
    }

    /// @notice FIX P1-H4: Get price WITHOUT circuit breaker check, for liquidation paths
    /// @dev During market crashes (>20% move), the circuit breaker blocks getPrice(),
    ///      which prevents liquidations. This function allows liquidation to proceed
    ///      using the raw Chainlink price, ensuring bad debt doesn't accumulate.
    function getPriceUnsafe(address token) external view returns (uint256 price) {
        FeedConfig storage config = feeds[token];
        require(config.enabled, "FEED_NOT_ENABLED");

        (uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) = config.feed.latestRoundData();
        require(answer > 0, "INVALID_PRICE");
        require(block.timestamp - updatedAt <= config.stalePeriod, "STALE_PRICE");
        require(answeredInRound >= roundId, "STALE_ROUND");

        uint8 feedDecimals = config.feed.decimals();
        require(feedDecimals <= 18, "UNSUPPORTED_FEED_DECIMALS");
        price = uint256(answer) * (10 ** (18 - feedDecimals));
        // No circuit breaker check — raw Chainlink price
    }

    /// @notice FIX P1-H4: Get USD value WITHOUT circuit breaker, for liquidation paths
    function getValueUsdUnsafe(address token, uint256 amount) external view returns (uint256 valueUsd) {
        FeedConfig storage config = feeds[token];
        require(config.enabled, "FEED_NOT_ENABLED");

        (uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) = config.feed.latestRoundData();
        require(answer > 0, "INVALID_PRICE");
        require(block.timestamp - updatedAt <= config.stalePeriod, "STALE_PRICE");
        require(answeredInRound >= roundId, "STALE_ROUND");

        uint8 feedDecimals = config.feed.decimals();
        require(feedDecimals <= 18, "UNSUPPORTED_FEED_DECIMALS");
        uint256 priceNormalized = uint256(answer) * (10 ** (18 - feedDecimals));
        valueUsd = (amount * priceNormalized) / (10 ** config.tokenDecimals);
    }

    /// @notice Check if a feed is active and returning fresh data
    function isFeedHealthy(address token) external view returns (bool) {
        FeedConfig storage config = feeds[token];
        if (!config.enabled) return false;

        try config.feed.latestRoundData() returns (
            uint80, int256 answer, uint256, uint256 updatedAt, uint80
        ) {
            return answer > 0 && (block.timestamp - updatedAt <= config.stalePeriod);
        } catch {
            return false;
        }
    }
}
