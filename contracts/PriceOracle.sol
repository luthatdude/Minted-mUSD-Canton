// SPDX-License-Identifier: BUSL-1.1
// BLE Protocol - Price Oracle Aggregator
// Wraps Chainlink feeds for ETH/BTC price data used by CollateralVault and LiquidationEngine

pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "./Errors.sol";

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
    /// @notice SOL-H-04: Critical feed/circuit-breaker changes require 48h timelock
    bytes32 public constant TIMELOCK_ROLE = keccak256("TIMELOCK_ROLE");

    struct FeedConfig {
        IAggregatorV3 feed;
        uint256 stalePeriod;  // Max age in seconds before data is considered stale
        uint8 tokenDecimals;  // Decimals of the collateral token (e.g., 18 for ETH, 8 for WBTC)
        uint8 feedDecimals;   // GAS-H-01: cached from feed.decimals() at setFeed time
        bool enabled;
        uint256 maxDeviationBps; // Per-asset circuit breaker threshold (0 = use global)
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

    /// @dev SOL-H-04: Timelock-gated — cooldown affects circuit breaker recovery timing
    function setCircuitBreakerCooldown(uint256 _cooldown) external onlyRole(TIMELOCK_ROLE) {
        if (_cooldown < 15 minutes || _cooldown > 24 hours) revert CooldownOutOfRange();
        emit CircuitBreakerCooldownUpdated(circuitBreakerCooldown, _cooldown);
        circuitBreakerCooldown = _cooldown;
    }

    ///      before allowing circuit breaker reset (less privilege than ORACLE_ADMIN)
    function keeperResetPrice(address token) external onlyRole(KEEPER_ROLE) {
        if (circuitBreakerTrippedAt[token] == 0) revert CbNotTripped();
        if (block.timestamp < circuitBreakerTrippedAt[token] + circuitBreakerCooldown) revert CooldownNotElapsed();
        
        FeedConfig storage config = feeds[token];
        if (!config.enabled) revert FeedNotEnabled();
        (, int256 answer, , uint256 updatedAt, ) = config.feed.latestRoundData();
        if (answer <= 0) revert InvalidPrice();
        if (block.timestamp - updatedAt > config.stalePeriod) revert StalePrice();
        
        uint256 newPrice = uint256(answer) * (10 ** (18 - config.feedDecimals));
        lastKnownPrice[token] = newPrice;
        circuitBreakerTrippedAt[token] = 0;
        
        emit KeeperRecovery(token, msg.sender, newPrice);
    }

    /// @dev SOL-H-04: Timelock-gated — deviation threshold is a critical safety parameter
    function setMaxDeviation(uint256 _maxDeviationBps) external onlyRole(TIMELOCK_ROLE) {
        if (_maxDeviationBps < 100 || _maxDeviationBps > 5000) revert DeviationOutOfRange();
        emit MaxDeviationUpdated(maxDeviationBps, _maxDeviationBps);
        maxDeviationBps = _maxDeviationBps;
    }

    /// @dev SOL-H-04: Timelock-gated — toggling circuit breaker is irreversible for current block
    function setCircuitBreakerEnabled(bool _enabled) external onlyRole(TIMELOCK_ROLE) {
        circuitBreakerEnabled = _enabled;
        emit CircuitBreakerToggled(_enabled);
    }

    /// @dev SOL-H-04: Kept on KEEPER_ROLE (not timelock) for emergency circuit breaker recovery
    function resetLastKnownPrice(address token) external onlyRole(KEEPER_ROLE) {
        FeedConfig storage config = feeds[token];
        if (!config.enabled) revert FeedNotEnabled();
        (, int256 answer, , , ) = config.feed.latestRoundData();
        if (answer <= 0) revert InvalidPrice();
        lastKnownPrice[token] = uint256(answer) * (10 ** (18 - config.feedDecimals));
    }

    /// @notice Register or update a Chainlink price feed for a collateral token
    /// @param token The collateral token address
    /// @param feed The Chainlink aggregator address
    /// @param stalePeriod Maximum acceptable age of price data in seconds
    /// @param tokenDecimals The number of decimals the collateral token uses
    /// @param assetMaxDeviationBps Per-asset circuit breaker threshold (0 = use global)
    function setFeed(
        address token,
        address feed,
        uint256 stalePeriod,
        uint8 tokenDecimals,
        uint256 assetMaxDeviationBps
    ) external onlyRole(TIMELOCK_ROLE) {
        // SOL-H-04: Feed changes are timelock-gated to prevent single-block oracle swap attacks
        if (token == address(0)) revert InvalidToken();
        if (feed == address(0)) revert InvalidFeed();
        if (stalePeriod == 0) revert InvalidStalePeriod();
        if (stalePeriod > 48 hours) revert StalePeriodTooLong();
        if (tokenDecimals > 18) revert TokenDecimalsTooHigh();
        if (assetMaxDeviationBps > 0) {
            if (assetMaxDeviationBps < 100 || assetMaxDeviationBps > 5000) revert AssetDeviationOutOfRange();
        }

        // GAS-H-01: cache feedDecimals at registration time to avoid external call on every price read
        uint8 fd = IAggregatorV3(feed).decimals();
        if (fd > 18) revert FeedDecimalsTooHigh();

        feeds[token] = FeedConfig({
            feed: IAggregatorV3(feed),
            stalePeriod: stalePeriod,
            tokenDecimals: tokenDecimals,
            feedDecimals: fd,
            enabled: true,
            maxDeviationBps: assetMaxDeviationBps
        });

        try IAggregatorV3(feed).latestRoundData() returns (
            uint80, int256 answer, uint256, uint256, uint80
        ) {
            if (answer > 0) {
                lastKnownPrice[token] = uint256(answer) * (10 ** (18 - fd));
            }
        } catch {
            // Feed not yet reporting — lastKnownPrice stays 0 until first getPrice() call
        }

        emit FeedUpdated(token, feed, stalePeriod, tokenDecimals);
    }

    /// @notice Remove a price feed
    ///      state if the same token is later re-added with a new feed.
    /// @dev SOL-H-04: Timelock-gated — removing a feed breaks all pricing for the asset
    function removeFeed(address token) external onlyRole(TIMELOCK_ROLE) {
        if (!feeds[token].enabled) revert FeedNotFound();
        delete feeds[token];
        delete lastKnownPrice[token];
        emit FeedRemoved(token);
    }

    /// @notice Get the USD price of a collateral token, normalized to 18 decimals
    /// @param token The collateral token address
    /// @return price USD value of 1 full token unit, scaled to 18 decimals
    function getPrice(address token) external view returns (uint256 price) {
        return _getPrice(token);
    }

    /// @dev Internal price fetch — avoids external CALL opcode when used by
    ///      getValueUsd() and other internal consumers. Saves ~2,600 gas per call.
    ///      GAS-01 optimization.
    function _getPrice(address token) internal view returns (uint256 price) {
        FeedConfig storage config = feeds[token];
        if (!config.enabled) revert FeedNotEnabled();

        (
            uint80 roundId,
            int256 answer,
            ,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = config.feed.latestRoundData();

        if (answer <= 0) revert InvalidPrice();
        if (block.timestamp - updatedAt > config.stalePeriod) revert StalePrice();
        if (answeredInRound < roundId) revert StaleRound();

        // GAS-H-01: use cached feedDecimals instead of external call
        uint8 feedDecimals = config.feedDecimals;
        if (feedDecimals > 18) revert UnsupportedFeedDecimals();

        // Chainlink answer is price per 1 token unit in USD, scaled to feedDecimals
        // Normalize to 18 decimals
        price = uint256(answer) * (10 ** (18 - feedDecimals));

        // Anchor spot price against lastKnownPrice to mitigate
        // flash loan manipulation. Per-asset deviation thresholds allow tighter bounds
        // for stablecoins vs volatile assets (e.g., 500bps for WBTC, 2000bps for ETH).
        if (circuitBreakerEnabled && lastKnownPrice[token] > 0) {
            uint256 effectiveDeviation = config.maxDeviationBps > 0 ? config.maxDeviationBps : maxDeviationBps;
            uint256 oldPrice = lastKnownPrice[token];
            uint256 diff = price > oldPrice ? price - oldPrice : oldPrice - price;
            uint256 deviationBps = (diff * 10000) / oldPrice;

            if (deviationBps > effectiveDeviation) {
                if (circuitBreakerTrippedAt[token] > 0 &&
                    block.timestamp >= circuitBreakerTrippedAt[token] + circuitBreakerCooldown) {
                    // Auto-recovery: cooldown elapsed from formal trip time
                } else if (circuitBreakerTrippedAt[token] == 0 &&
                           block.timestamp >= updatedAt + circuitBreakerCooldown) {
                    // Auto-recovery when circuit breaker was never formally
                    // tripped by updatePrice() but the Chainlink feed has been at the new
                    // level for >cooldown. Without this, getPrice() permanently reverts
                    // if no keeper calls updatePrice() after a legitimate large price move.
                } else {
                    revert CircuitBreakerActive();
                }
            }
        }
        // Note: lastKnownPrice is updated via updatePrice(), keeperResetPrice(), or admin resetLastKnownPrice()
    }

    /// @dev This allows keepers to update the price after verifying the deviation is legitimate
    function updatePrice(address token) external onlyRole(ORACLE_ADMIN_ROLE) {
        FeedConfig storage config = feeds[token];
        if (!config.enabled) revert FeedNotEnabled();
        
        (, int256 answer, , uint256 updatedAt, ) = config.feed.latestRoundData();
        if (answer <= 0) revert InvalidPrice();
        if (block.timestamp - updatedAt > config.stalePeriod) revert StalePrice();
        
        uint256 newPrice = uint256(answer) * (10 ** (18 - config.feedDecimals));
        uint256 oldPrice = lastKnownPrice[token];
        
        if (oldPrice > 0) {
            uint256 diff = newPrice > oldPrice ? newPrice - oldPrice : oldPrice - newPrice;
            uint256 deviationBps = (diff * 10000) / oldPrice;
            // Use per-asset deviation threshold with global fallback
            uint256 effectiveDevUp = config.maxDeviationBps > 0 ? config.maxDeviationBps : maxDeviationBps;
            emit CircuitBreakerTriggered(token, oldPrice, newPrice, deviationBps);
            if (deviationBps > effectiveDevUp) {
                // Only set the circuit breaker when deviation exceeds threshold.
                if (circuitBreakerTrippedAt[token] == 0) {
                    circuitBreakerTrippedAt[token] = block.timestamp;
                }
                // Do NOT clear — the circuit breaker must persist until
                // manually reset by an admin after verifying the price move is legitimate.
                lastKnownPrice[token] = newPrice;
                return;
            }
        }
        
        lastKnownPrice[token] = newPrice;
        // Only clear circuit breaker when price is within bounds
        circuitBreakerTrippedAt[token] = 0;
    }

    /// @notice Get the USD value of a specific amount of collateral
    /// @param token The collateral token address
    /// @param amount The amount of collateral (in token's native decimals)
    /// @return valueUsd USD value scaled to 18 decimals
    /// Previously read the feed directly, bypassing the circuit breaker check.
    /// GAS-01: Uses internal _getPrice() instead of external this.getPrice() to avoid CALL opcode (~2,600 gas saved)
    function getValueUsd(address token, uint256 amount) external view returns (uint256 valueUsd) {
        uint256 priceNormalized = _getPrice(token);
        valueUsd = (amount * priceNormalized) / (10 ** feeds[token].tokenDecimals);
    }

    /// @dev During market crashes (>20% move), the circuit breaker blocks getPrice(),
    ///      which prevents liquidations. This function allows liquidation to proceed
    ///      using the raw Chainlink price, ensuring bad debt doesn't accumulate.
    function getPriceUnsafe(address token) external view returns (uint256 price) {
        return _getPriceUnsafe(token);
    }

    /// @dev Internal unsafe price fetch — avoids external CALL opcode when used by
    ///      getValueUsdUnsafe(). Saves ~2,600 gas per call. GAS-01 optimization.
    function _getPriceUnsafe(address token) internal view returns (uint256 price) {
        FeedConfig storage config = feeds[token];
        if (!config.enabled) revert FeedNotEnabled();

        (uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) = config.feed.latestRoundData();
        if (answer <= 0) revert InvalidPrice();
        if (block.timestamp - updatedAt > config.stalePeriod) revert StalePrice();
        if (answeredInRound < roundId) revert StaleRound();

        // GAS-H-01: use cached feedDecimals instead of external call
        uint8 feedDecimals = config.feedDecimals;
        if (feedDecimals > 18) revert UnsupportedFeedDecimals();
        price = uint256(answer) * (10 ** (18 - feedDecimals));
        // No circuit breaker check — raw Chainlink price
    }

    /// GAS-01: Uses internal _getPriceUnsafe() instead of duplicating feed logic (~2,600 gas saved)
    function getValueUsdUnsafe(address token, uint256 amount) external view returns (uint256 valueUsd) {
        uint256 priceNormalized = _getPriceUnsafe(token);
        valueUsd = (amount * priceNormalized) / (10 ** feeds[token].tokenDecimals);
    }

    /// @notice Keeperless price refresh after circuit breaker cooldown.
    /// @dev    Anyone can call this once the cooldown has elapsed for a tripped token.
    ///         Reads the current Chainlink answer, validates freshness, and resets the
    ///         circuit breaker — no KEEPER_ROLE required. This ensures the oracle
    ///         recovers even when no keeper bot is running.
    /// @param token The collateral token whose price to refresh
    function refreshPrice(address token) external {
        if (circuitBreakerTrippedAt[token] == 0) revert CbNotTripped();
        if (block.timestamp < circuitBreakerTrippedAt[token] + circuitBreakerCooldown) revert CooldownNotElapsed();

        FeedConfig storage config = feeds[token];
        if (!config.enabled) revert FeedNotEnabled();

        (, int256 answer, , uint256 updatedAt, ) = config.feed.latestRoundData();
        if (answer <= 0) revert InvalidPrice();
        if (block.timestamp - updatedAt > config.stalePeriod) revert StalePrice();

        uint256 newPrice = uint256(answer) * (10 ** (18 - config.feedDecimals));

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
