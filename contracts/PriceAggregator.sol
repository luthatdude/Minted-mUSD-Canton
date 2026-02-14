// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "./interfaces/IOracleAdapter.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "./TimelockGoverned.sol";

/**
 * @title PriceAggregator
 * @notice Multi-source oracle aggregator with fallback chain
 * @dev Queries adapters in priority order, falls back to next on failure.
 *      This is the Stability DAO pattern: modular oracle adapters with
 *      automatic failover for maximum uptime.
 */
contract PriceAggregator is
    AccessControlUpgradeable,
    UUPSUpgradeable,
    TimelockGoverned
{
    bytes32 public constant ORACLE_ADMIN_ROLE = keccak256("ORACLE_ADMIN_ROLE");

    /// @notice Ordered list of oracle adapters (highest priority first)
    IOracleAdapter[] public adapters;

    /// @notice Maximum number of adapters
    uint256 public constant MAX_ADAPTERS = 5;

    /// @notice Maximum allowed deviation between sources (in BPS)
    uint256 public maxDeviationBps;

    /// @notice Whether cross-source validation is enabled
    bool public crossValidationEnabled;

    // Events
    event AdapterAdded(address indexed adapter, uint256 index);
    event AdapterRemoved(address indexed adapter);
    event AdaptersReordered();
    event MaxDeviationUpdated(uint256 newMaxBps);
    event CrossValidationToggled(bool enabled);
    event FallbackUsed(address indexed token, string primarySource, string fallbackSource);

    // Errors
    error TooManyAdapters();
    error AdapterNotFound();
    error NoAdapterAvailable();
    error PriceDeviationTooHigh(uint256 price1, uint256 price2, uint256 deviationBps);
    error InvalidMaxDeviation();
    error ZeroAddress();

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

        maxDeviationBps = 500; // 5% default
        crossValidationEnabled = false;
    }

    // ═══════════════════════════════════════════════════════
    // ADAPTER MANAGEMENT
    // ═══════════════════════════════════════════════════════

    function addAdapter(address adapter) external onlyRole(ORACLE_ADMIN_ROLE) {
        if (adapter == address(0)) revert ZeroAddress();
        if (adapters.length >= MAX_ADAPTERS) revert TooManyAdapters();

        adapters.push(IOracleAdapter(adapter));
        emit AdapterAdded(adapter, adapters.length - 1);
    }

    function removeAdapter(address adapter) external onlyRole(ORACLE_ADMIN_ROLE) {
        uint256 len = adapters.length;
        for (uint256 i = 0; i < len; i++) {
            if (address(adapters[i]) == adapter) {
                adapters[i] = adapters[len - 1];
                adapters.pop();
                emit AdapterRemoved(adapter);
                return;
            }
        }
        revert AdapterNotFound();
    }

    function setAdapters(address[] calldata _adapters) external onlyRole(ORACLE_ADMIN_ROLE) {
        if (_adapters.length > MAX_ADAPTERS) revert TooManyAdapters();

        delete adapters;
        for (uint256 i = 0; i < _adapters.length; i++) {
            if (_adapters[i] == address(0)) revert ZeroAddress();
            adapters.push(IOracleAdapter(_adapters[i]));
        }
        emit AdaptersReordered();
    }

    function setMaxDeviation(uint256 _maxDeviationBps) external onlyRole(ORACLE_ADMIN_ROLE) {
        if (_maxDeviationBps < 50 || _maxDeviationBps > 5000) revert InvalidMaxDeviation();
        maxDeviationBps = _maxDeviationBps;
        emit MaxDeviationUpdated(_maxDeviationBps);
    }

    function setCrossValidation(bool _enabled) external onlyRole(ORACLE_ADMIN_ROLE) {
        crossValidationEnabled = _enabled;
        emit CrossValidationToggled(_enabled);
    }

    // ═══════════════════════════════════════════════════════
    // PRICE QUERIES
    // ═══════════════════════════════════════════════════════

    /// @notice Get price from highest-priority healthy adapter
    /// @param token Token address to price
    /// @return price USD price in 18 decimals
    function getPrice(address token) external view returns (uint256 price) {
        uint256 len = adapters.length;
        for (uint256 i = 0; i < len; i++) {
            if (!adapters[i].supportsToken(token)) continue;
            if (!adapters[i].isHealthy(token)) continue;

            try adapters[i].getPrice(token) returns (uint256 _price, uint256) {
                if (_price > 0) {
                    if (crossValidationEnabled) {
                        _crossValidate(token, _price, i);
                    }
                    return _price;
                }
            } catch {
                continue;
            }
        }
        revert NoAdapterAvailable();
    }

    /// @notice Get price with source information
    function getPriceWithSource(address token) external view returns (
        uint256 price,
        string memory sourceName,
        uint256 updatedAt
    ) {
        uint256 len = adapters.length;
        for (uint256 i = 0; i < len; i++) {
            if (!adapters[i].supportsToken(token)) continue;
            if (!adapters[i].isHealthy(token)) continue;

            try adapters[i].getPrice(token) returns (uint256 _price, uint256 _updatedAt) {
                if (_price > 0) {
                    return (_price, adapters[i].source(), _updatedAt);
                }
            } catch {
                continue;
            }
        }
        revert NoAdapterAvailable();
    }

    /// @notice Get prices from all healthy adapters for comparison
    function getAllPrices(address token) external view returns (
        uint256[] memory prices,
        string[] memory sources
    ) {
        uint256 len = adapters.length;
        prices = new uint256[](len);
        sources = new string[](len);

        for (uint256 i = 0; i < len; i++) {
            if (!adapters[i].supportsToken(token) || !adapters[i].isHealthy(token)) {
                continue;
            }
            try adapters[i].getPrice(token) returns (uint256 _price, uint256) {
                prices[i] = _price;
                sources[i] = adapters[i].source();
            } catch {
                // Leave as 0
            }
        }
    }

    /// @notice Get USD value of a token amount
    function getValueUsd(address token, uint256 amount, uint8 tokenDecimals) external view returns (uint256) {
        uint256 price = this.getPrice(token);
        return (amount * price) / (10 ** tokenDecimals);
    }

    // ═══════════════════════════════════════════════════════
    // HEALTH CHECK
    // ═══════════════════════════════════════════════════════

    function adapterCount() external view returns (uint256) {
        return adapters.length;
    }

    function getHealthyAdapterCount(address token) external view returns (uint256 count) {
        for (uint256 i = 0; i < adapters.length; i++) {
            if (adapters[i].supportsToken(token) && adapters[i].isHealthy(token)) {
                count++;
            }
        }
    }

    // ═══════════════════════════════════════════════════════
    // INTERNAL
    // ═══════════════════════════════════════════════════════

    function _crossValidate(address token, uint256 primaryPrice, uint256 primaryIndex) internal view {
        for (uint256 i = 0; i < adapters.length; i++) {
            if (i == primaryIndex) continue;
            if (!adapters[i].supportsToken(token) || !adapters[i].isHealthy(token)) continue;

            try adapters[i].getPrice(token) returns (uint256 secondaryPrice, uint256) {
                if (secondaryPrice > 0) {
                    uint256 diff = primaryPrice > secondaryPrice
                        ? primaryPrice - secondaryPrice
                        : secondaryPrice - primaryPrice;
                    uint256 deviationBps = (diff * 10000) / primaryPrice;

                    if (deviationBps > maxDeviationBps) {
                        revert PriceDeviationTooHigh(primaryPrice, secondaryPrice, deviationBps);
                    }
                    return; // Validated against at least one other source
                }
            } catch {
                continue;
            }
        }
        // No secondary source available — primary price accepted without cross-validation
    }

    uint256[40] private __gap;

    function _authorizeUpgrade(address) internal override onlyTimelock {}
}
