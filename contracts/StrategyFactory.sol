// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "./interfaces/IStrategy.sol";

/**
 * @title StrategyFactory
 * @notice One-click deploy + register of Treasury strategy adapters
 * @dev Deploys ERC1967 proxies pointing at pre-registered implementation contracts,
 *      calls initialize(), then registers the new strategy in TreasuryV2.
 *
 * Workflow:
 *   1. Admin calls registerImplementation(protocolId, impl) for each strategy type
 *   2. When user picks a YieldScanner suggestion with no strategy, frontend calls
 *      deployAndRegister(protocolId, initData, targetBps, minBps, maxBps, autoAllocate)
 *   3. Factory deploys a proxy clone → initialize → treasury.addStrategy()
 *
 * Requirements:
 *   - Factory must hold STRATEGIST_ROLE on TreasuryV2
 *   - Each implementation must be a UUPS-upgradeable IStrategy that accepts
 *     an initialize(bytes) call with protocol-specific params
 */
contract StrategyFactory is AccessControl {
    // ═══════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error ZeroAddress();
    error ImplementationNotSet();
    error DeployFailed();
    error InitializeFailed();
    error RegistrationFailed();
    error ProtocolAlreadyDeployed(uint256 protocolId);
    error NotValidStrategy();

    // ═══════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event ImplementationRegistered(uint256 indexed protocolId, string name, address implementation);
    event StrategyDeployed(
        uint256 indexed protocolId,
        address indexed proxy,
        address implementation,
        uint256 targetBps
    );

    // ═══════════════════════════════════════════════════════════════════════
    // TYPES
    // ═══════════════════════════════════════════════════════════════════════

    struct Implementation {
        address impl;           // UUPS implementation contract address
        string name;            // Human-readable name (e.g., "PendleStrategyV2")
        bool active;            // Whether this template is available for deployment
    }

    struct DeployedStrategy {
        uint256 protocolId;
        address proxy;
        address implementation;
        uint256 deployedAt;
        bool active;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CONSTANTS & ROLES
    // ═══════════════════════════════════════════════════════════════════════

    bytes32 public constant DEPLOYER_ROLE = keccak256("DEPLOYER_ROLE");

    // Protocol IDs (match YieldScanner.Protocol enum)
    uint256 public constant PROTO_AAVE_V3 = 0;
    uint256 public constant PROTO_COMPOUND_V3 = 1;
    uint256 public constant PROTO_MORPHO = 2;
    uint256 public constant PROTO_PENDLE = 3;
    uint256 public constant PROTO_SKY = 4;
    uint256 public constant PROTO_ETHENA = 5;
    uint256 public constant PROTO_SPARK = 6;
    uint256 public constant PROTO_CURVE = 7;
    uint256 public constant PROTO_YEARN = 8;
    uint256 public constant PROTO_CONTANGO = 9;

    // ═══════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice TreasuryV2 address — factory calls addStrategy() on this
    address public treasury;

    /// @notice Implementation contracts by protocol ID
    mapping(uint256 => Implementation) public implementations;

    /// @notice Deployed strategies by protocol ID
    mapping(uint256 => DeployedStrategy) public deployedStrategies;

    /// @notice All deployed proxy addresses
    address[] public allDeployed;

    /// @notice Protocol IDs that have implementations registered
    uint256[] public registeredProtocols;

    // ═══════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════

    constructor(address _treasury, address _admin) {
        if (_treasury == address(0) || _admin == address(0)) revert ZeroAddress();

        treasury = _treasury;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(DEPLOYER_ROLE, _admin);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ADMIN: Register implementation templates
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Register a strategy implementation for a protocol
     * @param protocolId Protocol enum from YieldScanner (0=Aave, 2=Morpho, 3=Pendle, 4=Sky, etc.)
     * @param impl Address of the deployed UUPS implementation contract
     * @param name Human-readable name for this strategy type
     */
    function registerImplementation(
        uint256 protocolId,
        address impl,
        string calldata name
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (impl == address(0)) revert ZeroAddress();

        // Track new protocols
        if (implementations[protocolId].impl == address(0)) {
            registeredProtocols.push(protocolId);
        }

        implementations[protocolId] = Implementation({
            impl: impl,
            name: name,
            active: true
        });

        emit ImplementationRegistered(protocolId, name, impl);
    }

    /**
     * @notice Deactivate an implementation (prevents new deployments)
     */
    function deactivateImplementation(uint256 protocolId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        implementations[protocolId].active = false;
    }

    /**
     * @notice Update the treasury address
     */
    function setTreasury(address _treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CORE: Deploy + Register in one transaction
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Deploy a new strategy proxy and register it in Treasury
     * @dev The factory must hold STRATEGIST_ROLE on TreasuryV2 for this to work.
     *
     * @param protocolId  Protocol enum (matches YieldScanner.Protocol)
     * @param initData    ABI-encoded initialize() calldata for the strategy
     *                    (e.g., abi.encodeCall(MorphoLoopStrategy.initialize, (usdc, morpho, ...)))
     * @param targetBps   Target allocation in Treasury (e.g., 2000 = 20%)
     * @param minBps      Minimum allocation bound
     * @param maxBps      Maximum allocation bound
     * @param autoAllocate Whether Treasury auto-allocates on deposits
     * @return proxy      Address of the newly deployed strategy proxy
     */
    function deployAndRegister(
        uint256 protocolId,
        bytes calldata initData,
        uint256 targetBps,
        uint256 minBps,
        uint256 maxBps,
        bool autoAllocate
    ) external onlyRole(DEPLOYER_ROLE) returns (address proxy) {
        Implementation memory impl = implementations[protocolId];
        if (impl.impl == address(0) || !impl.active) revert ImplementationNotSet();

        // Deploy ERC1967 proxy pointing to the implementation
        // initData is passed as the proxy constructor data (calls initialize)
        proxy = address(new ERC1967Proxy(impl.impl, initData));

        // Verify it implements IStrategy by calling asset()
        try IStrategy(proxy).asset() returns (address a) {
            if (a == address(0)) revert NotValidStrategy();
        } catch {
            revert NotValidStrategy();
        }

        // Register in TreasuryV2 (requires STRATEGIST_ROLE)
        ITreasuryAddStrategy(treasury).addStrategy(
            proxy,
            targetBps,
            minBps,
            maxBps,
            autoAllocate
        );

        // Track deployment
        deployedStrategies[protocolId] = DeployedStrategy({
            protocolId: protocolId,
            proxy: proxy,
            implementation: impl.impl,
            deployedAt: block.timestamp,
            active: true
        });
        allDeployed.push(proxy);

        emit StrategyDeployed(protocolId, proxy, impl.impl, targetBps);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Get all registered protocol IDs and their implementations
     */
    function getImplementations() external view returns (
        uint256[] memory protocolIds,
        address[] memory impls,
        string[] memory names,
        bool[] memory activeFlags
    ) {
        uint256 len = registeredProtocols.length;
        protocolIds = new uint256[](len);
        impls = new address[](len);
        names = new string[](len);
        activeFlags = new bool[](len);

        for (uint256 i = 0; i < len; i++) {
            uint256 pid = registeredProtocols[i];
            protocolIds[i] = pid;
            impls[i] = implementations[pid].impl;
            names[i] = implementations[pid].name;
            activeFlags[i] = implementations[pid].active;
        }
    }

    /**
     * @notice Get all deployed strategy proxies
     */
    function getDeployed() external view returns (DeployedStrategy[] memory) {
        DeployedStrategy[] memory result = new DeployedStrategy[](allDeployed.length);
        // Build from allDeployed — scan deployedStrategies mapping
        uint256 count;
        for (uint256 i = 0; i < registeredProtocols.length; i++) {
            uint256 pid = registeredProtocols[i];
            DeployedStrategy memory ds = deployedStrategies[pid];
            if (ds.proxy != address(0)) {
                result[count] = ds;
                count++;
            }
        }

        // Trim to actual count
        assembly {
            mstore(result, count)
        }
        return result;
    }

    /**
     * @notice Check if a protocol has a deployed strategy
     */
    function hasStrategy(uint256 protocolId) external view returns (bool) {
        return deployedStrategies[protocolId].proxy != address(0);
    }

    /**
     * @notice Get deployed strategy address for a protocol
     */
    function getStrategy(uint256 protocolId) external view returns (address) {
        return deployedStrategies[protocolId].proxy;
    }

    /**
     * @notice Check if a protocol has a registered implementation
     */
    function hasImplementation(uint256 protocolId) external view returns (bool) {
        return implementations[protocolId].impl != address(0) && implementations[protocolId].active;
    }

    /**
     * @notice Total number of deployed strategies
     */
    function deployedCount() external view returns (uint256) {
        return allDeployed.length;
    }
}

// Minimal interface for the addStrategy call
interface ITreasuryAddStrategy {
    function addStrategy(
        address strategy,
        uint256 targetBps,
        uint256 minBps,
        uint256 maxBps,
        bool autoAllocate
    ) external;
}
