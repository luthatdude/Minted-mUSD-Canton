// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "./interfaces/IYieldBasis.sol";
import "./TimelockGoverned.sol";
import "./Errors.sol";

/**
 * @title MintedYBRouter
 * @notice Registry and router for Minted-owned Yield Basis pools
 * @dev Implements IYieldBasisRouter for pool discovery.
 *      Maintains a registry of MintedYBPool instances keyed by base/quote pairs.
 *
 * Usage:
 *   - YieldBasisStrategy queries getPool(WBTC, USDC) to find the BTC pool
 *   - Frontend queries getActivePools() to show available staking options
 *   - Admin registers new pools as capacity grows
 *
 * UUPS upgradeable + TimelockGoverned for safe operations
 */
contract MintedYBRouter is
    IYieldBasisRouter,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    TimelockGoverned
{
    // ═══════════════════════════════════════════════════════════════════════
    // ROLES
    // ═══════════════════════════════════════════════════════════════════════

    bytes32 public constant POOL_MANAGER_ROLE = keccak256("POOL_MANAGER_ROLE");

    // ═══════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Mapping: keccak256(baseAsset, quoteAsset) → pool address
    mapping(bytes32 => address) public pools;

    /// @notice Array of all registered pool addresses
    address[] public allPools;

    /// @notice Track whether a pool address is registered
    mapping(address => bool) public isRegistered;

    // ═══════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event PoolRegistered(address indexed pool, address indexed baseAsset, address indexed quoteAsset);
    event PoolDeregistered(address indexed pool, address indexed baseAsset, address indexed quoteAsset);

    // ═══════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error PoolAlreadyRegistered();
    error PoolNotRegistered();

    // ═══════════════════════════════════════════════════════════════════════
    // INITIALIZER
    // ═══════════════════════════════════════════════════════════════════════

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _admin, address _timelock) external initializer {
        if (_admin == address(0)) revert ZeroAddress();
        if (_timelock == address(0)) revert ZeroAddress();

        __AccessControl_init();
        __UUPSUpgradeable_init();
        _setTimelock(_timelock);

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(POOL_MANAGER_ROLE, _admin);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // IYieldBasisRouter IMPLEMENTATION
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Get the pool for a given base/quote pair
     * @param _baseAsset The volatile asset (WBTC, WETH)
     * @param _quoteAsset The stablecoin (USDC)
     * @return pool The pool address (address(0) if not found)
     */
    function getPool(address _baseAsset, address _quoteAsset)
        external
        view
        override
        returns (address pool)
    {
        bytes32 key = _poolKey(_baseAsset, _quoteAsset);
        return pools[key];
    }

    /**
     * @notice Get all registered (active) pools
     * @return activePools Array of pool addresses
     */
    function getActivePools() external view override returns (address[] memory activePools) {
        // Count active pools
        uint256 activeCount = 0;
        for (uint256 i = 0; i < allPools.length; i++) {
            if (IYieldBasisPool(allPools[i]).acceptingDeposits()) {
                activeCount++;
            }
        }

        activePools = new address[](activeCount);
        uint256 idx = 0;
        for (uint256 i = 0; i < allPools.length; i++) {
            if (IYieldBasisPool(allPools[i]).acceptingDeposits()) {
                activePools[idx] = allPools[i];
                idx++;
            }
        }
    }

    /**
     * @notice Get ALL registered pools (active and inactive)
     * @return Array of all pool addresses
     */
    function getAllPools() external view returns (address[] memory) {
        return allPools;
    }

    /**
     * @notice Total number of registered pools
     */
    function poolCount() external view returns (uint256) {
        return allPools.length;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // POOL MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Register a new MintedYBPool
     * @param pool MintedYBPool address
     */
    function registerPool(address pool) external onlyRole(POOL_MANAGER_ROLE) {
        if (pool == address(0)) revert ZeroAddress();
        if (isRegistered[pool]) revert PoolAlreadyRegistered();

        address _baseAsset = IYieldBasisPool(pool).baseAsset();
        address _quoteAsset = IYieldBasisPool(pool).quoteAsset();

        bytes32 key = _poolKey(_baseAsset, _quoteAsset);

        // Only one pool per pair (deregister old one first if upgrading)
        if (pools[key] != address(0)) revert PoolAlreadyRegistered();

        pools[key] = pool;
        allPools.push(pool);
        isRegistered[pool] = true;

        emit PoolRegistered(pool, _baseAsset, _quoteAsset);
    }

    /**
     * @notice Deregister a pool (e.g., during migration)
     * @param pool Pool address to remove
     */
    function deregisterPool(address pool) external onlyRole(POOL_MANAGER_ROLE) {
        if (!isRegistered[pool]) revert PoolNotRegistered();

        address _baseAsset = IYieldBasisPool(pool).baseAsset();
        address _quoteAsset = IYieldBasisPool(pool).quoteAsset();
        bytes32 key = _poolKey(_baseAsset, _quoteAsset);

        delete pools[key];
        isRegistered[pool] = false;

        // Remove from array (swap-and-pop)
        for (uint256 i = 0; i < allPools.length; i++) {
            if (allPools[i] == pool) {
                allPools[i] = allPools[allPools.length - 1];
                allPools.pop();
                break;
            }
        }

        emit PoolDeregistered(pool, _baseAsset, _quoteAsset);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INTERNAL
    // ═══════════════════════════════════════════════════════════════════════

    function _poolKey(address _baseAsset, address _quoteAsset) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(_baseAsset, _quoteAsset));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // UPGRADE
    // ═══════════════════════════════════════════════════════════════════════

    function _authorizeUpgrade(address) internal override onlyTimelock {}
}
