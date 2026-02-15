// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "./interfaces/IYieldAdapter.sol";

/**
 * @title YieldVerifier
 * @notice On-chain verification layer for the hybrid yield scanning pipeline.
 *
 * @dev Architecture (3-layer hybrid):
 *   Layer 1: DeFiLlama off-chain indexer discovers 500+ protocols
 *   Layer 2: Off-chain scoring, filtering, tranche ranking (top 50)
 *   Layer 3: THIS CONTRACT verifies on-chain rates before capital deployment
 *
 * The verifier uses modular IYieldAdapter contracts — one per protocol.
 * Each adapter reads live rate data directly from the protocol's contracts.
 * This prevents the indexer from directing capital to fake/manipulated venues.
 *
 * Workflow:
 *   1. Admin registers adapters: registerAdapter(protocolId, adapterAddress)
 *   2. Frontend calls verify(protocolId, venue, expectedApyBps, toleranceBps)
 *   3. Verifier reads live rate via adapter.verify(venue, extraData)
 *   4. Compares live rate to indexer's claimed rate within tolerance
 *   5. Returns pass/fail + live rate data
 *
 * Security: Only verified opportunities should be whitelisted via governance before deployment.
 */
contract YieldVerifier is AccessControl {

    // ═══════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error ZeroAddress();
    error AdapterNotRegistered(uint256 protocolId);
    error VerificationFailed(uint256 protocolId, address venue, string reason);

    // ═══════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event AdapterRegistered(uint256 indexed protocolId, address indexed adapter, string name);
    event AdapterRemoved(uint256 indexed protocolId);
    event VerificationResult(
        uint256 indexed protocolId,
        address indexed venue,
        bool passed,
        uint256 expectedApyBps,
        uint256 liveApyBps,
        uint256 toleranceBps
    );

    // ═══════════════════════════════════════════════════════════════════
    // TYPES
    // ═══════════════════════════════════════════════════════════════════

    struct AdapterInfo {
        address adapter;     // IYieldAdapter implementation
        string name;         // Human-readable name
        bool active;         // Whether this adapter is enabled
    }

    struct VerifyResult {
        bool passed;
        uint256 liveSupplyApyBps;
        uint256 liveBorrowApyBps;
        uint256 liveTvlUsd6;
        uint256 liveUtilizationBps;
        bool liveAvailable;
        int256 apyDeviation;     // live - expected, in bps (negative = lower than expected)
    }

    struct BatchVerifyItem {
        uint256 protocolId;
        address venue;
        bytes32 extraData;
        uint256 expectedApyBps;
    }

    // ═══════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════

    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");

    /// @notice Default tolerance: 7.5% deviation from expected APY is acceptable
    /// @dev Tighter tolerance catches rate manipulation; custom overrides available per-protocol
    uint256 public constant DEFAULT_TOLERANCE_BPS = 750; // 7.5%

    /// @notice Maximum valid protocol ID — prevents registering adapters with undefined IDs
    uint256 public constant MAX_PROTOCOL_ID = 49;

    // ═══════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Registered adapters by protocol ID
    mapping(uint256 => AdapterInfo) public adapters;

    /// @notice All registered protocol IDs for enumeration
    uint256[] public registeredProtocols;

    /// @notice Custom tolerance per protocol (0 = use default)
    mapping(uint256 => uint256) public customTolerance;

    // ═══════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(address _admin) {
        if (_admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(MANAGER_ROLE, _admin);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ADMIN: Adapter Management
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Register a yield adapter for a protocol
     * @param protocolId Protocol enum ID (matches YieldScanner/DeFiLlama indexer)
     * @param adapter Address of the IYieldAdapter implementation
     */
    function registerAdapter(
        uint256 protocolId,
        address adapter
    ) external onlyRole(MANAGER_ROLE) {
        if (adapter == address(0)) revert ZeroAddress();
        require(protocolId <= MAX_PROTOCOL_ID, "protocolId exceeds MAX_PROTOCOL_ID");

        string memory name = IYieldAdapter(adapter).protocolName();

        // Track new protocol IDs
        if (adapters[protocolId].adapter == address(0)) {
            registeredProtocols.push(protocolId);
        }

        adapters[protocolId] = AdapterInfo({
            adapter: adapter,
            name: name,
            active: true
        });

        emit AdapterRegistered(protocolId, adapter, name);
    }

    /**
     * @notice Deactivate an adapter (keeps record, prevents verification)
     */
    function deactivateAdapter(uint256 protocolId) external onlyRole(MANAGER_ROLE) {
        adapters[protocolId].active = false;
        emit AdapterRemoved(protocolId);
    }

    /**
     * @notice Set a custom tolerance for a specific protocol
     * @param protocolId Protocol enum ID
     * @param toleranceBps Tolerance in bps (e.g., 1000 = 10%)
     */
    function setTolerance(
        uint256 protocolId,
        uint256 toleranceBps
    ) external onlyRole(MANAGER_ROLE) {
        customTolerance[protocolId] = toleranceBps;
    }

    // ═══════════════════════════════════════════════════════════════════
    // CORE: Single Verification
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Verify a yield opportunity against live on-chain data
     * @param protocolId Protocol enum ID
     * @param venue Protocol contract address (pool/vault/market)
     * @param extraData Protocol-specific data (e.g., marketId for Morpho)
     * @param expectedApyBps APY reported by the off-chain indexer (bps)
     * @return result Full verification result with live data
     */
    function verify(
        uint256 protocolId,
        address venue,
        bytes32 extraData,
        uint256 expectedApyBps
    ) external view returns (VerifyResult memory result) {
        AdapterInfo memory info = adapters[protocolId];
        if (info.adapter == address(0) || !info.active) {
            // No adapter registered — return unverified but mark as not passed
            result.passed = false;
            return result;
        }

        uint256 tolerance = customTolerance[protocolId];
        if (tolerance == 0) tolerance = DEFAULT_TOLERANCE_BPS;

        try IYieldAdapter(info.adapter).verify(venue, extraData) returns (
            uint256 supplyBps,
            uint256 borrowBps,
            uint256 tvl,
            uint256 util,
            bool available
        ) {
            result.liveSupplyApyBps = supplyBps;
            result.liveBorrowApyBps = borrowBps;
            result.liveTvlUsd6 = tvl;
            result.liveUtilizationBps = util;
            result.liveAvailable = available;
            result.apyDeviation = int256(supplyBps) - int256(expectedApyBps);

            // Check if live rate is within tolerance of expected
            if (expectedApyBps == 0) {
                // If indexer reported 0 and live is also 0, pass
                result.passed = (supplyBps == 0);
            } else {
                // |deviation| / expected <= tolerance / 10000
                uint256 absDeviation = result.apyDeviation >= 0
                    ? uint256(result.apyDeviation)
                    : uint256(-result.apyDeviation);
                result.passed = (absDeviation * 10000) / expectedApyBps <= tolerance;
            }

            // Also check availability
            if (!available) {
                result.passed = false;
            }
        } catch {
            // Adapter call failed — venue may be invalid or paused
            result.passed = false;
        }
    }

    /**
     * @notice Quick check: is this yield roughly accurate?
     * @return passed True if live rate is within tolerance of expected
     */
    function quickVerify(
        uint256 protocolId,
        address venue,
        bytes32 extraData,
        uint256 expectedApyBps
    ) external view returns (bool passed) {
        VerifyResult memory result = this.verify(
            protocolId, venue, extraData, expectedApyBps
        );
        return result.passed;
    }

    // ═══════════════════════════════════════════════════════════════════
    // CORE: Batch Verification
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Verify multiple opportunities in a single call
     * @param items Array of verification items
     * @return results Array of verification results (same order)
     * @return passedCount Number that passed verification
     */
    function batchVerify(
        BatchVerifyItem[] calldata items
    ) external view returns (VerifyResult[] memory results, uint256 passedCount) {
        results = new VerifyResult[](items.length);
        passedCount = 0;

        for (uint256 i = 0; i < items.length; i++) {
            results[i] = this.verify(
                items[i].protocolId,
                items[i].venue,
                items[i].extraData,
                items[i].expectedApyBps
            );
            if (results[i].passed) passedCount++;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // CORE: Direct Read (no comparison, just get live data)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Read live yield data from a protocol without comparison
     * @dev Useful for refreshing on-chain data after indexer discovery
     */
    function readLive(
        uint256 protocolId,
        address venue,
        bytes32 extraData
    ) external view returns (
        bool success,
        uint256 supplyApyBps,
        uint256 borrowApyBps,
        uint256 tvlUsd6,
        uint256 utilizationBps,
        bool available
    ) {
        AdapterInfo memory info = adapters[protocolId];
        if (info.adapter == address(0) || !info.active) {
            return (false, 0, 0, 0, 0, false);
        }

        try IYieldAdapter(info.adapter).verify(venue, extraData) returns (
            uint256 s, uint256 b, uint256 t, uint256 u, bool a
        ) {
            return (true, s, b, t, u, a);
        } catch {
            return (false, 0, 0, 0, 0, false);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // VIEWS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Get all registered adapter info
    function getAdapters() external view returns (
        uint256[] memory protocolIds,
        AdapterInfo[] memory infos
    ) {
        uint256 len = registeredProtocols.length;
        protocolIds = new uint256[](len);
        infos = new AdapterInfo[](len);
        for (uint256 i = 0; i < len; i++) {
            protocolIds[i] = registeredProtocols[i];
            infos[i] = adapters[registeredProtocols[i]];
        }
    }

    /// @notice Check if a protocol has a registered adapter
    function hasAdapter(uint256 protocolId) external view returns (bool) {
        return adapters[protocolId].adapter != address(0) && adapters[protocolId].active;
    }

    /// @notice Get the tolerance for a protocol
    function getTolerance(uint256 protocolId) external view returns (uint256) {
        uint256 t = customTolerance[protocolId];
        return t > 0 ? t : DEFAULT_TOLERANCE_BPS;
    }

    /// @notice Count of registered adapters
    function adapterCount() external view returns (uint256) {
        return registeredProtocols.length;
    }
}
