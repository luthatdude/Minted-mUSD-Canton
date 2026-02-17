// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../../contracts/interfaces/IOracleAdapter.sol";
import "../../contracts/TimelockGoverned.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title PriceAggregatorAdminHarness
 * @notice Admin-path harness for Certora rules that target adapter management
 *         and configuration invariants.
 * @dev Keeps the same admin/storage surface as PriceAggregator, while making
 *      read-only price-query methods trivial to avoid prover engine failures
 *      in complex view-path transformations.
 */
contract PriceAggregatorAdminHarness is
    AccessControlUpgradeable,
    UUPSUpgradeable,
    TimelockGoverned
{
    bytes32 public constant ORACLE_ADMIN_ROLE = keccak256("ORACLE_ADMIN_ROLE");

    IOracleAdapter[] public adapters;
    uint256 public constant MAX_ADAPTERS = 5;
    uint256 public maxDeviationBps;
    bool public crossValidationEnabled;

    error TooManyAdapters();
    error AdapterNotFound();
    error NoAdapterAvailable();
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

        maxDeviationBps = 500;
        crossValidationEnabled = false;
    }

    function addAdapter(address adapter) external onlyRole(ORACLE_ADMIN_ROLE) {
        if (adapter == address(0)) revert ZeroAddress();
        if (adapters.length >= MAX_ADAPTERS) revert TooManyAdapters();
        adapters.push(IOracleAdapter(adapter));
    }

    function removeAdapter(address adapter) external onlyRole(ORACLE_ADMIN_ROLE) {
        uint256 len = adapters.length;
        for (uint256 i = 0; i < len; i++) {
            if (address(adapters[i]) == adapter) {
                adapters[i] = adapters[len - 1];
                adapters.pop();
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
    }

    function setMaxDeviation(uint256 _maxDeviationBps) external onlyRole(ORACLE_ADMIN_ROLE) {
        if (_maxDeviationBps < 50 || _maxDeviationBps > 5000) revert InvalidMaxDeviation();
        maxDeviationBps = _maxDeviationBps;
    }

    function setCrossValidation(bool _enabled) external onlyRole(ORACLE_ADMIN_ROLE) {
        crossValidationEnabled = _enabled;
    }

    // Price-query helpers are intentionally trivial in this harness.
    function getPrice(address) external pure returns (uint256 price) {
        return 1e18;
    }

    function getPriceWithSource(address) external pure returns (
        uint256 price,
        string memory sourceName,
        uint256 updatedAt
    ) {
        return (1e18, "HARNESS", 0);
    }

    function getAllPrices(address) external pure returns (
        uint256[] memory prices,
        string[] memory sources
    ) {
        prices = new uint256[](0);
        sources = new string[](0);
    }

    function getValueUsd(address, uint256 amount, uint8) external pure returns (uint256) {
        return amount;
    }

    function adapterCount() external view returns (uint256) {
        return adapters.length;
    }

    function getHealthyAdapterCount(address) external view returns (uint256 count) {
        count = adapters.length;
    }

    function _authorizeUpgrade(address) internal override onlyTimelock {}
}
