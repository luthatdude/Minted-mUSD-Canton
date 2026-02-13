// SPDX-License-Identifier: BUSL-1.1
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
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    struct FeedConfig {
        IAggregatorV3 feed;
        uint256 stalePeriod;  // Max age in seconds before data is considered stale
        uint8 tokenDecimals;  // Decimals of the collateral token (e.g., 18 for ETH, 8 for WBTC)
        bool enabled;
    }

    // collateral token address => feed config
    mapping(address => FeedConfig) public feeds;
    
    mapping(address => uint256) public lastKnownPrice;
    uint256 public maxDeviationBps = 2000; // 20% max price change per update
    bool public circuitBreakerEnabled = true;

    mapping(address => uint256) public circuitBreakerTrippedAt;
    uint256 public circuitBreakerCooldown = 1 hours;

    event FeedUpdated(address indexed token, address feed, uint256 stalePeriod, uint8 tokenDecimals);
    event FeedRemoved(address indexed token);
    event CircuitBreakerTriggered(address indexed token, uint256 oldPrice, uint256 newPrice, uint256 deviationBps);
    event MaxDeviationUpdated(uint256 oldBps, uint256 newBps);
    event CircuitBreakerToggled(bool enabled);
    event CircuitBreakerAutoRecovered(address indexed token, uint256 newPrice);
    event CircuitBreakerCooldownUpdated(uint256 oldCooldown, uint256 newCooldown);
    event KeeperRecovery(address indexed token, address indexed keeper, uint256 newPrice);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ORACLE_ADMIN_ROLE, msg.sender);
        _grantRole(KEEPER_ROLE, msg.sender);
    }

    function setCircuitBreakerCooldown(uint256 _cooldown) external onlyRole(ORACLE_ADMIN_ROLE) {
        require(_cooldown >= 15 minutes && _cooldown <= 24 hours, "COOLDOWN_OUT_OF_RANGE");
        emit CircuitBreakerCooldownUpdated(circuitBreakerCooldown, _cooldown);
        circuitBreakerCooldown = _cooldown;
    }

    ///      before allowing circuit breaker reset (less privilege than ORACLE_ADMIN)
    function keeperResetPrice(address token) external onlyRole(KEEPER_ROLE) {
        require(circuitBreakerTrippedAt[token] > 0, "CB_NOT_TRIPPED");
        require(block.timestamp >= circuitBreakerTrippedAt[token] + circuitBreakerCooldown, "COOLDOWN_NOT_ELAPSED");
        
        FeedConfig storage config = feeds[token];
        require(config.enabled, "FEED_NOT_ENABLED");
        (, int256 answer, , uint256 updatedAt, ) = config.feed.latestRoundData();
        require(answer > 0, "INVALID_PRICE");
        require(block.timestamp - updatedAt <= config.stalePeriod, "STALE_PRICE");
        
        uint8 feedDecimals = config.feed.decimals();
        uint256 newPrice = uint256(answer) * (10 ** (18 - feedDecimals));
        lastKnownPrice[token] = newPrice;
        circuitBreakerTrippedAt[token] = 0;
        
        emit KeeperRecovery(token, msg.sender, newPrice);
    }

    function setMaxDeviation(uint256 _maxDeviationBps) external onlyRole(ORACLE_ADMIN_ROLE) {
        require(_maxDeviationBps >= 100 && _maxDeviationBps <= 5000, "DEVIATION_OUT_OF_RANGE"); // 1% to 50%
        emit MaxDeviationUpdated(maxDeviationBps, _maxDeviationBps);
        maxDeviationBps = _maxDeviationBps;
    }

    function setCircuitBreakerEnabled(bool _enabled) external onlyRole(ORACLE_ADMIN_ROLE) {
        circuitBreakerEnabled = _enabled;
        emit CircuitBreakerToggled(_enabled);
    }

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
        require(stalePeriod <= 48 hours, "STALE_PERIOD_TOO_LONG");
        require(tokenDecimals <= 18, "TOKEN_DECIMALS_TOO_HIGH");

        feeds[token] = FeedConfig({
            feed: IAggregatorV3(feed),
            stalePeriod: stalePeriod,
            tokenDecimals: tokenDecimals,
            enabled: true
        });

        // in getPrice() where we compute 10 ** (18 - feedDecimals).
        // A feed with > 18 decimals would revert at query time, not at config time.
        {
            uint8 fd = IAggregatorV3(feed).decimals();
            require(fd <= 18, "FEED_DECIMALS_TOO_HIGH");
        }

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
    ///      state if the same token is later re-added with a new feed.
    function removeFeed(address token) external onlyRole(ORACLE_ADMIN_ROLE) {
        require(feeds[token].enabled, "FEED_NOT_FOUND");
        delete feeds[token];
        delete lastKnownPrice[token];
        emit FeedRemoved(token);
    }

    /// @notice Get the USD price of a collateral token, normalized to 18 decimals
    /// @param token The collateral token address
    /// @return price USD value of 1 full token unit, scaled to 18 decimals
    function getPrice(address token) external view returns (uint256 price) {
        FeedConfig storage config = feeds[token];
        require(config.enabled, "FEED_NOT_ENABLED");

        (
            uint80 roundId,
            int256 answer,
            ,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = config.feed.latestRoundData();

        require(answer > 0, "INVALID_PRICE");
        require(block.timestamp - updatedAt <= config.stalePeriod, "STALE_PRICE");
        require(answeredInRound >= roundId, "STALE_ROUND");

        uint8 feedDecimals = config.feed.decimals();
        require(feedDecimals <= 18, "UNSUPPORTED_FEED_DECIMALS");

        // Chainlink answer is price per 1 token unit in USD, scaled to feedDecimals
        // Normalize to 18 decimals
        price = uint256(answer) * (10 ** (18 - feedDecimals));

        // FIX HIGH-05: Anchor spot price against lastKnownPrice to mitigate
        // flash loan manipulation of Chainlink round data. If the current price
        // deviates more than maxDeviationBps from the last accepted price,
        // trigger the circuit breaker instead of returning a potentially manipulated price.
        if (circuitBreakerEnabled && lastKnownPrice[token] > 0) {
            uint256 oldPrice = lastKnownPrice[token];
            uint256 diff = price > oldPrice ? price - oldPrice : oldPrice - price;
            uint256 deviationBps = (diff * 10000) / oldPrice;

            if (deviationBps > maxDeviationBps) {
                if (circuitBreakerTrippedAt[token] > 0 &&
                    block.timestamp >= circuitBreakerTrippedAt[token] + circuitBreakerCooldown) {
                    // Auto-recovery: cooldown elapsed from formal trip time
                } else if (circuitBreakerTrippedAt[token] == 0 &&
                           block.timestamp >= updatedAt + circuitBreakerCooldown) {
                    // FIX P1-CODEX: Auto-recovery when circuit breaker was never formally
                    // tripped by updatePrice() but the Chainlink feed has been at the new
                    // level for >cooldown. Without this, getPrice() permanently reverts
                    // if no keeper calls updatePrice() after a legitimate large price move.
                } else {
                    revert("CIRCUIT_BREAKER_TRIGGERED");
                }
            }
        }
        // Note: lastKnownPrice is updated via updatePrice(), keeperResetPrice(), or admin resetLastKnownPrice()
    }

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
            if (deviationBps > maxDeviationBps && circuitBreakerTrippedAt[token] == 0) {
                circuitBreakerTrippedAt[token] = block.timestamp;
            }
        }
        
        lastKnownPrice[token] = newPrice;
        circuitBreakerTrippedAt[token] = 0;
    }

    /// @notice Get the USD value of a specific amount of collateral
    /// @param token The collateral token address
    /// @param amount The amount of collateral (in token's native decimals)
    /// @return valueUsd USD value scaled to 18 decimals
    /// Previously read the feed directly, bypassing the circuit breaker check.
    function getValueUsd(address token, uint256 amount) external view returns (uint256 valueUsd) {
        uint256 priceNormalized = this.getPrice(token);
        valueUsd = (amount * priceNormalized) / (10 ** feeds[token].tokenDecimals);
    }

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

    /// @notice Keeperless price refresh after circuit breaker cooldown.
    /// @dev    Anyone can call this once the cooldown has elapsed for a tripped token.
    ///         Reads the current Chainlink answer, validates freshness, and resets the
    ///         circuit breaker — no KEEPER_ROLE required. This ensures the oracle
    ///         recovers even when no keeper bot is running.
    /// @param token The collateral token whose price to refresh
    function refreshPrice(address token) external {
        require(circuitBreakerTrippedAt[token] > 0, "CB_NOT_TRIPPED");
        require(
            block.timestamp >= circuitBreakerTrippedAt[token] + circuitBreakerCooldown,
            "COOLDOWN_NOT_ELAPSED"
        );

        FeedConfig storage config = feeds[token];
        require(config.enabled, "FEED_NOT_ENABLED");

        (, int256 answer, , uint256 updatedAt, ) = config.feed.latestRoundData();
        require(answer > 0, "INVALID_PRICE");
        require(block.timestamp - updatedAt <= config.stalePeriod, "STALE_PRICE");

        uint8 feedDecimals = config.feed.decimals();
        uint256 newPrice = uint256(answer) * (10 ** (18 - feedDecimals));

        lastKnownPrice[token] = newPrice;
        circuitBreakerTrippedAt[token] = 0;

        emit CircuitBreakerAutoRecovered(token, newPrice);
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
