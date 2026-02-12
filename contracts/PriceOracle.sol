// SPDX-License-Identifier: BUSL-1.1
// BLE Protocol - Price Oracle Aggregator
// Wraps Chainlink feeds for ETH/BTC price data used by CollateralVault and LiquidationEngine

pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "./interfaces/IAggregatorV3.sol";
import "./TimelockGoverned.sol";

/// @title PriceOracle
/// @notice Aggregates Chainlink price feeds for collateral assets (ETH, BTC, etc.)
/// @dev All prices are normalized to 18 decimals (USD value per 1 full token unit)
contract PriceOracle is AccessControl, TimelockGoverned {
 bytes32 public constant ORACLE_ADMIN_ROLE = keccak256("ORACLE_ADMIN_ROLE");

 struct FeedConfig {
 IAggregatorV3 feed;
 uint256 stalePeriod; // Max age in seconds before data is considered stale
 uint8 tokenDecimals; // Decimals of the collateral token (e.g., 18 for ETH, 8 for WBTC)
 bool enabled;
 }

 // collateral token address => feed config
 mapping(address => FeedConfig) public feeds;

 /// @dev Maximum allowed staleness period (24 hours)
 uint256 public constant MAX_STALE_PERIOD = 24 hours;
 
 /// @dev Circuit breaker - track last known prices and max deviation
 mapping(address => uint256) public lastKnownPrice;
 uint256 public maxDeviationBps = 2000; // 20% max price change per update
 bool public circuitBreakerEnabled = true;

 /// @dev Cooldown for circuit breaker toggle to prevent per-transaction manipulation
 uint256 public constant CIRCUIT_BREAKER_COOLDOWN = 1 hours;
 uint256 public lastCircuitBreakerToggle;

 // ── L2 Sequencer Uptime Check ──
 /// @dev Chainlink L2 sequencer uptime feed (set to address(0) on L1 / if not needed)
 IAggregatorV3 public sequencerUptimeFeed;
 /// @dev Grace period after sequencer restarts before prices are trusted
 uint256 public constant SEQUENCER_GRACE_PERIOD = 1 hours;

 event SequencerUptimeFeedUpdated(address indexed oldFeed, address indexed newFeed);

 event FeedUpdated(address indexed token, address feed, uint256 stalePeriod, uint8 tokenDecimals);
 event FeedRemoved(address indexed token);
 /// @dev Event for circuit breaker triggers
 event CircuitBreakerTriggered(address indexed token, uint256 oldPrice, uint256 newPrice, uint256 deviationBps);
 event MaxDeviationUpdated(uint256 oldBps, uint256 newBps);
 event CircuitBreakerToggled(bool enabled);
 /// @dev Emitted when permissionless refreshPrice() advances cached price
 event PriceRefreshed(address indexed token, uint256 oldPrice, uint256 newPrice);

 // ═══════════════════════════════════════════════════════════════════════
 // ADMIN — all setters gated by MintedTimelockController
 // ═══════════════════════════════════════════════════════════════════════

 constructor(address _timelock) {
 _setTimelock(_timelock);
 _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
 _grantRole(ORACLE_ADMIN_ROLE, msg.sender);
 }

 /// @notice Set or clear the L2 sequencer uptime feed (timelocked)
 /// @param _feed Address of the Chainlink sequencer uptime feed, or address(0) to disable
 function setSequencerUptimeFeed(address _feed) external onlyTimelock {
 address oldFeed = address(sequencerUptimeFeed);
 sequencerUptimeFeed = IAggregatorV3(_feed);
 emit SequencerUptimeFeedUpdated(oldFeed, _feed);
 }

 /// @dev Revert if the L2 sequencer is down or still within the grace period
 function _checkSequencerUptime() internal view {
 if (address(sequencerUptimeFeed) == address(0)) return; // L1 or not configured
 (, int256 answer, , uint256 startedAt, ) = sequencerUptimeFeed.latestRoundData();
 // answer == 0 means sequencer is up; answer == 1 means sequencer is down
 require(answer == 0, "SEQUENCER_DOWN");
 require(block.timestamp - startedAt >= SEQUENCER_GRACE_PERIOD, "SEQUENCER_GRACE_PERIOD_NOT_OVER");
 }

 /// @notice Set max deviation (timelocked via MintedTimelockController)
 function setMaxDeviation(uint256 _maxDeviationBps) external onlyTimelock {
 require(_maxDeviationBps >= 100 && _maxDeviationBps <= 5000, "DEVIATION_OUT_OF_RANGE");
 emit MaxDeviationUpdated(maxDeviationBps, _maxDeviationBps);
 maxDeviationBps = _maxDeviationBps;
 }

 /// @notice Set circuit breaker enabled/disabled (timelocked via MintedTimelockController)
 function setCircuitBreakerEnabled(bool _enabled) external onlyTimelock {
 require(block.timestamp >= lastCircuitBreakerToggle + CIRCUIT_BREAKER_COOLDOWN, "CIRCUIT_BREAKER_COOLDOWN_ACTIVE");
 circuitBreakerEnabled = _enabled;
 lastCircuitBreakerToggle = block.timestamp;
 emit CircuitBreakerToggled(_enabled);
 }

 /// @dev Manually update last known price (for recovery after circuit breaker trip)
 function resetLastKnownPrice(address token) external onlyRole(ORACLE_ADMIN_ROLE) {
 FeedConfig storage config = feeds[token];
 require(config.enabled, "FEED_NOT_ENABLED");
 // Validate freshness before resetting circuit breaker reference
 (uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) = config.feed.latestRoundData();
 require(answer > 0, "INVALID_PRICE");
 require(block.timestamp - updatedAt <= config.stalePeriod, "STALE_PRICE");
 require(answeredInRound >= roundId, "STALE_ROUND");
 uint8 feedDecimals = config.feed.decimals();
 lastKnownPrice[token] = uint256(answer) * (10 ** (18 - feedDecimals));
 }

 /// @notice Register or update a Chainlink price feed (timelocked via MintedTimelockController)
 function setFeed(
 address token,
 address feed,
 uint256 stalePeriod,
 uint8 tokenDecimals
 ) external onlyTimelock {
 require(token != address(0), "INVALID_TOKEN");
 require(feed != address(0), "INVALID_FEED");
 require(stalePeriod > 0, "INVALID_STALE_PERIOD");
 require(stalePeriod <= MAX_STALE_PERIOD, "STALE_PERIOD_TOO_HIGH");
 require(tokenDecimals <= 18, "TOKEN_DECIMALS_TOO_HIGH");
 {
 uint8 fd = IAggregatorV3(feed).decimals();
 require(fd <= 18, "FEED_DECIMALS_TOO_HIGH");
 }

 feeds[token] = FeedConfig({
 feed: IAggregatorV3(feed),
 stalePeriod: stalePeriod,
 tokenDecimals: tokenDecimals,
 enabled: true
 });

 // Auto-initialize lastKnownPrice from the feed
 try IAggregatorV3(feed).latestRoundData() returns (
 uint80, int256 answer, uint256, uint256, uint80
 ) {
 if (answer > 0) {
 uint256 feedDecimals = IAggregatorV3(feed).decimals();
 lastKnownPrice[token] = uint256(answer) * (10 ** (18 - feedDecimals));
 }
 } catch {}

 emit FeedUpdated(token, feed, stalePeriod, tokenDecimals);
 }

 /// @notice Remove a price feed (timelocked via MintedTimelockController)
 function removeFeed(address token) external onlyTimelock {
 require(feeds[token].enabled, "FEED_NOT_FOUND");
 delete feeds[token];
 delete lastKnownPrice[token];
 emit FeedRemoved(token);
 }

 /// @notice Get the USD price of a collateral token, normalized to 18 decimals
 /// @dev PO-M01: lastKnownPrice is updated via updatePrice() / resetLastKnownPrice() / setFeed() / refreshPrice().
 /// Keeping getPrice as view ensures interface compatibility.
 function getPrice(address token) external view returns (uint256 price) {
 _checkSequencerUptime();
 FeedConfig storage config = feeds[token];
 require(config.enabled, "FEED_NOT_ENABLED");

 (uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) = config.feed.latestRoundData();
 require(answer > 0, "INVALID_PRICE");
 require(block.timestamp - updatedAt <= config.stalePeriod, "STALE_PRICE");
 require(answeredInRound >= roundId, "STALE_ROUND");

 uint8 feedDecimals = config.feed.decimals();
 require(feedDecimals <= 18, "UNSUPPORTED_FEED_DECIMALS");
 price = uint256(answer) * (10 ** (18 - feedDecimals));

 // Circuit breaker check
 if (circuitBreakerEnabled && lastKnownPrice[token] > 0) {
 uint256 oldPrice = lastKnownPrice[token];
 uint256 diff = price > oldPrice ? price - oldPrice : oldPrice - price;
 uint256 deviationBps = (diff * 10000) / oldPrice;
 require(deviationBps <= maxDeviationBps, "CIRCUIT_BREAKER_TRIGGERED");
 }
 }

 /// @notice Update cached price (call before getPrice if circuit breaker trips)
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

 /// @notice Permissionless price refresh — anyone can call to advance
 /// lastKnownPrice when the current feed price is within deviation tolerance.
 /// @dev Solves the circuit breaker freeze: after a legitimate market move that stays
 /// within maxDeviationBps, bots/keepers call refreshPrice() to ratchet the
 /// cached price forward. For moves ABOVE the threshold, admin updatePrice()
 /// is still required (intentional — large deviations need human review).
 /// Without this, a series of small moves (each <threshold) that accumulate
 /// beyond the threshold would permanently freeze getPrice().
 function refreshPrice(address token) external {
 _checkSequencerUptime();
 FeedConfig storage config = feeds[token];
 require(config.enabled, "FEED_NOT_ENABLED");

 (uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) = config.feed.latestRoundData();
 require(answer > 0, "INVALID_PRICE");
 require(block.timestamp - updatedAt <= config.stalePeriod, "STALE_PRICE");
 require(answeredInRound >= roundId, "STALE_ROUND");

 uint8 feedDecimals = config.feed.decimals();
 uint256 newPrice = uint256(answer) * (10 ** (18 - feedDecimals));

 // Only update if within deviation tolerance (same check as getPrice)
 if (circuitBreakerEnabled && lastKnownPrice[token] > 0) {
 uint256 oldPrice = lastKnownPrice[token];
 uint256 diff = newPrice > oldPrice ? newPrice - oldPrice : oldPrice - newPrice;
 uint256 deviationBps = (diff * 10000) / oldPrice;
 require(deviationBps <= maxDeviationBps, "DEVIATION_TOO_LARGE");
 }

 lastKnownPrice[token] = newPrice;
 emit PriceRefreshed(token, lastKnownPrice[token], newPrice);
 }

 /// @notice Get the USD value of a specific amount of collateral
 /// @param token The collateral token address
 /// @param amount The amount of collateral (in token's native decimals)
 /// @return valueUsd USD value scaled to 18 decimals
 /// Now calls _getPriceInternal() to avoid external self-call gas overhead.
 /// Previously used this.getPrice(token) which is an external self-call.
 function getValueUsd(address token, uint256 amount) external view returns (uint256 valueUsd) {
 uint256 priceNormalized = _getPriceInternal(token);
 valueUsd = (amount * priceNormalized) / (10 ** feeds[token].tokenDecimals);
 }

 /// @notice Internal price function to avoid external self-calls
 /// @dev Same logic as getPrice() but callable internally without external call overhead
 function _getPriceInternal(address token) internal view returns (uint256 price) {
 _checkSequencerUptime();
 FeedConfig storage config = feeds[token];
 require(config.enabled, "FEED_NOT_ENABLED");

 (uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) = config.feed.latestRoundData();
 require(answer > 0, "INVALID_PRICE");
 require(block.timestamp - updatedAt <= config.stalePeriod, "STALE_PRICE");
 require(answeredInRound >= roundId, "STALE_ROUND");

 uint8 feedDecimals = config.feed.decimals();
 require(feedDecimals <= 18, "UNSUPPORTED_FEED_DECIMALS");
 price = uint256(answer) * (10 ** (18 - feedDecimals));

 // Circuit breaker check
 if (circuitBreakerEnabled && lastKnownPrice[token] > 0) {
 uint256 oldPrice = lastKnownPrice[token];
 uint256 diff = price > oldPrice ? price - oldPrice : oldPrice - price;
 uint256 deviationBps = (diff * 10000) / oldPrice;
 require(deviationBps <= maxDeviationBps, "CIRCUIT_BREAKER_TRIGGERED");
 }
 }

 /// @notice Get price WITHOUT circuit breaker check, for liquidation paths
 /// @dev During market crashes (>20% move), the circuit breaker blocks getPrice(),
 /// which prevents liquidations. This function allows liquidation to proceed
 /// using the raw Chainlink price, ensuring bad debt doesn't accumulate.
 /// @dev Removed staleness revert. During Chainlink feed outages,
 /// liquidations must still proceed using the last available price. The safe
 /// getPrice() enforces staleness; this Unsafe variant intentionally does not.
 function getPriceUnsafe(address token) external view returns (uint256 price) {
 FeedConfig storage config = feeds[token];
 require(config.enabled, "FEED_NOT_ENABLED");

 (uint80 roundId, int256 answer, , , uint80 answeredInRound) = config.feed.latestRoundData();
 require(answer > 0, "INVALID_PRICE");
 // No staleness revert — liquidations must proceed during feed outages
 require(answeredInRound >= roundId, "STALE_ROUND");

 uint8 feedDecimals = config.feed.decimals();
 require(feedDecimals <= 18, "UNSUPPORTED_FEED_DECIMALS");
 price = uint256(answer) * (10 ** (18 - feedDecimals));
 // No circuit breaker check — raw Chainlink price
 }

 /// @notice Get USD value WITHOUT circuit breaker, for liquidation paths
 /// @dev Removed staleness revert to match getPriceUnsafe
 function getValueUsdUnsafe(address token, uint256 amount) external view returns (uint256 valueUsd) {
 FeedConfig storage config = feeds[token];
 require(config.enabled, "FEED_NOT_ENABLED");

 (uint80 roundId, int256 answer, , , uint80 answeredInRound) = config.feed.latestRoundData();
 require(answer > 0, "INVALID_PRICE");
 // No staleness revert — liquidations must proceed during feed outages
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
