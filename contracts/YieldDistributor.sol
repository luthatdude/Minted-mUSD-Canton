// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./Errors.sol";

/**
 * @title YieldDistributor
 * @notice Proportionally distributes harvested yield to ALL pools according to
 *         share weight — Ethereum smUSD stakers AND Canton pools via the bridge.
 *
 * Architecture:
 *   1. Keeper calls distributeYield(yieldUsdc) after TreasuryV2.harvestYield()
 *   2. Withdraws yieldUsdc from Treasury reserve
 *   3. Mints mUSD 1:1 against USDC (via BRIDGE_ROLE on MUSD)
 *   4. Reads ETH vs Canton share ratio from SMUSD
 *   5. ETH portion → SMUSD.distributeYield()    (12h linear vesting)
 *   6. Canton portion → BLEBridge.bridgeToCanton() (relay picks up, Canton mints)
 *
 * Revenue Split:
 *   Protocol fee (20%) is taken by TreasuryV2.harvestYield() BEFORE this contract
 *   sees any yield. This contract only handles the 80% net yield distribution.
 *
 * Roles Required (granted during deployment):
 *   - ALLOCATOR_ROLE on TreasuryV2 (to call withdrawFromStrategy/withdraw)
 *   - YIELD_MANAGER_ROLE on SMUSD (to call distributeYield)
 *   - BRIDGE_ROLE on MUSD (to mint mUSD against USDC backing)
 *   - Approval from itself to BLEBridge for mUSD (bridgeToCanton burns from caller)
 */
contract YieldDistributor is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════
    // ROLES
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Keeper/bot role that triggers distribution
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    /// @notice Admin/governance for parameter changes
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    // ═══════════════════════════════════════════════════════════════════════
    // EXTERNAL CONTRACTS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice USDC token (6 decimals)
    IERC20 public immutable usdc;

    /// @notice mUSD token — YieldDistributor needs BRIDGE_ROLE to mint
    IMUSD_Distributor public immutable musd;

    /// @notice SMUSD vault — for ETH share count and yield distribution
    ISMUSD_Distributor public immutable smusd;

    /// @notice TreasuryV2 — source of yield USDC
    ITreasuryV2_Distributor public immutable treasury;

    /// @notice BLEBridgeV9 — for bridging Canton's yield portion
    IBLEBridge_Distributor public immutable bridge;

    // ═══════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Canton party identifier for yield bridging
    string public cantonYieldRecipient;

    /// @notice Minimum yield to distribute (prevents dust distributions)
    uint256 public minDistributionUsdc;

    /// @notice Cooldown between distributions
    uint256 public distributionCooldown;

    /// @notice Last distribution timestamp
    uint256 public lastDistributionTime;

    /// @notice Cumulative yield distributed to ETH (USDC terms, 6 decimals)
    uint256 public totalDistributedEth;

    /// @notice Cumulative yield distributed to Canton (USDC terms, 6 decimals)
    uint256 public totalDistributedCanton;

    /// @notice Total distributions count
    uint256 public distributionCount;

    // ═══════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event YieldDistributedToAllPools(
        uint256 indexed epoch,
        uint256 totalYieldUsdc,
        uint256 ethPortionUsdc,
        uint256 cantonPortionUsdc,
        uint256 ethSharesBps,
        uint256 cantonSharesBps
    );

    event CantonYieldBridged(
        uint256 indexed epoch,
        uint256 musdAmount,
        string cantonRecipient
    );

    event EthYieldDistributed(
        uint256 indexed epoch,
        uint256 musdAmount
    );

    event CantonRecipientUpdated(string oldRecipient, string newRecipient);
    event MinDistributionUpdated(uint256 oldMin, uint256 newMin);
    event DistributionCooldownUpdated(uint256 oldCooldown, uint256 newCooldown);

    // ═══════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error BelowMinDistribution();
    error CooldownNotElapsed();
    error NoSharesExist();
    error CantonRecipientNotSet();
    error InsufficientTreasuryReserve();

    // ═══════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════

    constructor(
        address _usdc,
        address _musd,
        address _smusd,
        address _treasury,
        address _bridge,
        address _admin
    ) {
        if (_usdc == address(0)) revert ZeroAddress();
        if (_musd == address(0)) revert ZeroAddress();
        if (_smusd == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_bridge == address(0)) revert ZeroAddress();
        if (_admin == address(0)) revert ZeroAddress();

        usdc = IERC20(_usdc);
        musd = IMUSD_Distributor(_musd);
        smusd = ISMUSD_Distributor(_smusd);
        treasury = ITreasuryV2_Distributor(_treasury);
        bridge = IBLEBridge_Distributor(_bridge);

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(GOVERNOR_ROLE, _admin);
        _grantRole(KEEPER_ROLE, _admin);

        // Defaults
        minDistributionUsdc = 100e6;      // $100 minimum
        distributionCooldown = 1 hours;    // Match TreasuryV2.MIN_ACCRUAL_INTERVAL

        // Pre-approve bridge to spend our mUSD (for bridgeToCanton burns)
        IERC20(_musd).forceApprove(_bridge, type(uint256).max);
        // Pre-approve SMUSD to pull our mUSD (for distributeYield)
        IERC20(_musd).forceApprove(_smusd, type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CORE: PROPORTIONAL YIELD DISTRIBUTION
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Distribute yield proportionally to all pools based on share weight.
     *         Called by keeper after TreasuryV2.harvestYield() accrues fees.
     *
     * @param yieldUsdc Net yield in USDC (6 decimals) to distribute.
     *        This should be the 80% net yield AFTER protocol fees.
     *
     * Flow:
     *   1. Withdraw yieldUsdc from Treasury reserve
     *   2. Mint mUSD 1:1 (USDC 6 dec → mUSD 18 dec)
     *   3. Read ethShares and cantonShares from SMUSD
     *   4. Split proportionally
     *   5. ETH → SMUSD.distributeYield(ethPortionMusd)
     *   6. Canton → bridge.bridgeToCanton(cantonPortionMusd, cantonRecipient)
     */
    function distributeYield(uint256 yieldUsdc)
        external
        nonReentrant
        whenNotPaused
        onlyRole(KEEPER_ROLE)
    {
        if (yieldUsdc < minDistributionUsdc) revert BelowMinDistribution();
        if (block.timestamp < lastDistributionTime + distributionCooldown) revert CooldownNotElapsed();

        // Read share proportions from SMUSD
        uint256 ethShares = smusd.totalSupply();
        uint256 cantonShares = smusd.cantonTotalShares();
        uint256 totalShares = ethShares + cantonShares;

        if (totalShares == 0) revert NoSharesExist();

        // Calculate proportional split in USDC terms
        uint256 cantonPortionUsdc = (cantonShares > 0)
            ? (yieldUsdc * cantonShares) / totalShares
            : 0;
        uint256 ethPortionUsdc = yieldUsdc - cantonPortionUsdc;

        // Withdraw USDC from Treasury reserve
        treasury.withdraw(address(this), yieldUsdc);

        // Convert USDC (6 dec) → mUSD (18 dec) by minting 1:1
        uint256 totalMusd = yieldUsdc * 1e12;
        musd.mint(address(this), totalMusd);

        // ── Distribute ETH portion to SMUSD ─────────────────────────
        if (ethPortionUsdc > 0) {
            uint256 ethPortionMusd = ethPortionUsdc * 1e12;
            smusd.distributeYield(ethPortionMusd);

            emit EthYieldDistributed(distributionCount, ethPortionMusd);
        }

        // ── Bridge Canton portion to Canton ─────────────────────────
        if (cantonPortionUsdc > 0 && cantonShares > 0) {
            if (bytes(cantonYieldRecipient).length == 0) revert CantonRecipientNotSet();

            uint256 cantonPortionMusd = cantonPortionUsdc * 1e12;
            bridge.bridgeToCanton(cantonPortionMusd, cantonYieldRecipient);

            emit CantonYieldBridged(distributionCount, cantonPortionMusd, cantonYieldRecipient);
        }

        // ── Update state ────────────────────────────────────────────
        lastDistributionTime = block.timestamp;
        totalDistributedEth += ethPortionUsdc;
        totalDistributedCanton += cantonPortionUsdc;
        distributionCount++;

        uint256 ethBps = (ethPortionUsdc * 10000) / yieldUsdc;
        uint256 cantonBps = 10000 - ethBps;

        emit YieldDistributedToAllPools(
            distributionCount,
            yieldUsdc,
            ethPortionUsdc,
            cantonPortionUsdc,
            ethBps,
            cantonBps
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Preview how yield would be split at current share ratios
    /// @param yieldUsdc Amount of USDC yield to distribute
    /// @return ethPortionUsdc ETH pool portion (USDC)
    /// @return cantonPortionUsdc Canton pool portion (USDC)
    /// @return ethShareBps ETH pool weight in BPS
    /// @return cantonShareBps Canton pool weight in BPS
    function previewDistribution(uint256 yieldUsdc) external view returns (
        uint256 ethPortionUsdc,
        uint256 cantonPortionUsdc,
        uint256 ethShareBps,
        uint256 cantonShareBps
    ) {
        uint256 ethShares = smusd.totalSupply();
        uint256 cantonShares = smusd.cantonTotalShares();
        uint256 totalShares = ethShares + cantonShares;

        if (totalShares == 0) return (0, 0, 0, 0);

        cantonPortionUsdc = (cantonShares > 0)
            ? (yieldUsdc * cantonShares) / totalShares
            : 0;
        ethPortionUsdc = yieldUsdc - cantonPortionUsdc;

        ethShareBps = (ethPortionUsdc * 10000) / yieldUsdc;
        cantonShareBps = 10000 - ethShareBps;
    }

    /// @notice Check if distribution can be called
    function canDistribute() external view returns (bool) {
        return block.timestamp >= lastDistributionTime + distributionCooldown;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // GOVERNANCE
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Set Canton yield recipient party
    function setCantonYieldRecipient(string calldata _recipient) external onlyRole(GOVERNOR_ROLE) {
        if (bytes(_recipient).length == 0) revert InvalidRecipient();
        emit CantonRecipientUpdated(cantonYieldRecipient, _recipient);
        cantonYieldRecipient = _recipient;
    }

    /// @notice Set minimum distribution amount
    function setMinDistribution(uint256 _min) external onlyRole(GOVERNOR_ROLE) {
        emit MinDistributionUpdated(minDistributionUsdc, _min);
        minDistributionUsdc = _min;
    }

    /// @notice Set distribution cooldown
    function setDistributionCooldown(uint256 _cooldown) external onlyRole(GOVERNOR_ROLE) {
        emit DistributionCooldownUpdated(distributionCooldown, _cooldown);
        distributionCooldown = _cooldown;
    }

    /// @notice Emergency pause
    function pause() external onlyRole(GOVERNOR_ROLE) {
        _pause();
    }

    /// @notice Unpause
    function unpause() external onlyRole(GOVERNOR_ROLE) {
        _unpause();
    }

    /// @notice Emergency rescue stuck tokens
    function rescueToken(address token, uint256 amount) external onlyRole(GOVERNOR_ROLE) {
        IERC20(token).safeTransfer(msg.sender, amount);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// MINIMAL INTERFACES (only what YieldDistributor needs)
// ═══════════════════════════════════════════════════════════════════════════

interface IMUSD_Distributor {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
}

interface ISMUSD_Distributor {
    function totalSupply() external view returns (uint256);
    function cantonTotalShares() external view returns (uint256);
    function distributeYield(uint256 amount) external;
    function globalTotalShares() external view returns (uint256);
}

interface ITreasuryV2_Distributor {
    function withdraw(address to, uint256 amount) external;
    function availableReserves() external view returns (uint256);
    function totalValue() external view returns (uint256);
}

interface IBLEBridge_Distributor {
    function bridgeToCanton(uint256 amount, string calldata cantonRecipient) external;
}
