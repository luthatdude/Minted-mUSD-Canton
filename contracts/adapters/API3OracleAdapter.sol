// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../interfaces/IOracleAdapter.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "../TimelockGoverned.sol";

/// @notice API3 dAPI proxy interface
interface IAPI3ReaderProxy {
    function read() external view returns (int224 value, uint32 timestamp);
}

/**
 * @title API3OracleAdapter
 * @notice IOracleAdapter implementation for API3 dAPI price feeds
 */
contract API3OracleAdapter is
    IOracleAdapter,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    TimelockGoverned
{
    struct ProxyConfig {
        IAPI3ReaderProxy proxy;
        uint256 stalePeriod;
        uint8 tokenDecimals;
        bool enabled;
    }

    bytes32 public constant ORACLE_ADMIN_ROLE = keccak256("ORACLE_ADMIN_ROLE");

    mapping(address => ProxyConfig) public proxies;

    error InvalidProxy();
    error InvalidToken();
    error InvalidStalePeriod();
    error ProxyNotEnabled();
    error InvalidPrice();
    error StalePrice();

    event ProxySet(address indexed token, address indexed proxy, uint256 stalePeriod);
    event ProxyRemoved(address indexed token);

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

    function setProxy(
        address token,
        address proxy,
        uint256 stalePeriod,
        uint8 tokenDecimals
    ) external onlyRole(ORACLE_ADMIN_ROLE) {
        if (token == address(0)) revert InvalidToken();
        if (proxy == address(0)) revert InvalidProxy();
        if (stalePeriod == 0 || stalePeriod > 48 hours) revert InvalidStalePeriod();

        proxies[token] = ProxyConfig({
            proxy: IAPI3ReaderProxy(proxy),
            stalePeriod: stalePeriod,
            tokenDecimals: tokenDecimals,
            enabled: true
        });

        emit ProxySet(token, proxy, stalePeriod);
    }

    function removeProxy(address token) external onlyRole(ORACLE_ADMIN_ROLE) {
        if (!proxies[token].enabled) revert ProxyNotEnabled();
        delete proxies[token];
        emit ProxyRemoved(token);
    }

    function getPrice(address token) external view override returns (uint256 price, uint256 updatedAt) {
        ProxyConfig storage config = proxies[token];
        if (!config.enabled) revert ProxyNotEnabled();

        (int224 value, uint32 timestamp) = config.proxy.read();
        if (value <= 0) revert InvalidPrice();
        if (block.timestamp - uint256(timestamp) > config.stalePeriod) revert StalePrice();

        // API3 returns 18-decimal prices by default
        price = uint256(int256(value));
        updatedAt = uint256(timestamp);
    }

    function supportsToken(address token) external view override returns (bool) {
        return proxies[token].enabled;
    }

    function source() external pure override returns (string memory) {
        return "API3";
    }

    function isHealthy(address token) external view override returns (bool) {
        ProxyConfig storage config = proxies[token];
        if (!config.enabled) return false;

        try config.proxy.read() returns (int224 value, uint32 timestamp) {
            return value > 0 && (block.timestamp - uint256(timestamp) <= config.stalePeriod);
        } catch {
            return false;
        }
    }

    uint256[45] private __gap;

    function _authorizeUpgrade(address) internal override onlyTimelock {}
}
