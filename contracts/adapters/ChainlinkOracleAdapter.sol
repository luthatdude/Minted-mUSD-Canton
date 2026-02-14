// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../interfaces/IOracleAdapter.sol";
import "../interfaces/IAggregatorV3.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "../TimelockGoverned.sol";

/**
 * @title ChainlinkOracleAdapter
 * @notice IOracleAdapter implementation for Chainlink price feeds
 */
contract ChainlinkOracleAdapter is
    IOracleAdapter,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    TimelockGoverned
{
    struct FeedConfig {
        IAggregatorV3 feed;
        uint256 stalePeriod;
        uint8 tokenDecimals;
        bool enabled;
    }

    bytes32 public constant ORACLE_ADMIN_ROLE = keccak256("ORACLE_ADMIN_ROLE");

    mapping(address => FeedConfig) public feeds;

    error InvalidFeed();
    error InvalidToken();
    error InvalidStalePeriod();
    error FeedNotEnabled();
    error InvalidPrice();
    error StalePrice();
    error StaleRound();

    event FeedSet(address indexed token, address indexed feed, uint256 stalePeriod);
    event FeedRemoved(address indexed token);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _admin, address _timelock) external initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();
        _setTimelock(_timelock);
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ORACLE_ADMIN_ROLE, _admin);
    }

    function setFeed(
        address token,
        address feed,
        uint256 stalePeriod,
        uint8 tokenDecimals
    ) external onlyRole(ORACLE_ADMIN_ROLE) {
        if (token == address(0)) revert InvalidToken();
        if (feed == address(0)) revert InvalidFeed();
        if (stalePeriod == 0 || stalePeriod > 48 hours) revert InvalidStalePeriod();

        feeds[token] = FeedConfig({
            feed: IAggregatorV3(feed),
            stalePeriod: stalePeriod,
            tokenDecimals: tokenDecimals,
            enabled: true
        });

        emit FeedSet(token, feed, stalePeriod);
    }

    function removeFeed(address token) external onlyRole(ORACLE_ADMIN_ROLE) {
        if (!feeds[token].enabled) revert FeedNotEnabled();
        delete feeds[token];
        emit FeedRemoved(token);
    }

    function getPrice(address token) external view override returns (uint256 price, uint256 updatedAt) {
        FeedConfig storage config = feeds[token];
        if (!config.enabled) revert FeedNotEnabled();

        (uint80 roundId, int256 answer, , uint256 _updatedAt, uint80 answeredInRound) = config.feed.latestRoundData();
        if (answer <= 0) revert InvalidPrice();
        if (block.timestamp - _updatedAt > config.stalePeriod) revert StalePrice();
        if (answeredInRound < roundId) revert StaleRound();

        uint8 feedDecimals = config.feed.decimals();
        price = uint256(answer) * (10 ** (18 - feedDecimals));
        updatedAt = _updatedAt;
    }

    function supportsToken(address token) external view override returns (bool) {
        return feeds[token].enabled;
    }

    function source() external pure override returns (string memory) {
        return "Chainlink";
    }

    function isHealthy(address token) external view override returns (bool) {
        FeedConfig storage config = feeds[token];
        if (!config.enabled) return false;

        try config.feed.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            return answer > 0 && (block.timestamp - updatedAt <= config.stalePeriod);
        } catch {
            return false;
        }
    }

    uint256[45] private __gap;

    function _authorizeUpgrade(address) internal override onlyTimelock {}
}
