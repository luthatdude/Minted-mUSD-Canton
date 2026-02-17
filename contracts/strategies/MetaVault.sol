// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IStrategy.sol";
import "../TimelockGoverned.sol";
import "../Errors.sol";

// ═══════════════════════════════════════════════════════════════════════════
//                         META-VAULT (Vault-of-Vaults)
// ═══════════════════════════════════════════════════════════════════════════
//
// Aggregates up to 4 sub-strategies (Pendle, Fluid, Morpho, Euler) behind
// a single IStrategy interface so TreasuryV2 sees ONE address.
//
// Deposit flow:
//   1. TreasuryV2 calls deposit(amount) on this vault
//   2. MetaVault splits USDC across sub-strategies according to weightBps[]
//   3. Each sub-strategy handles its own looping / PT purchase / etc.
//
// Withdraw flow:
//   1. TreasuryV2 calls withdraw(amount) or withdrawAll()
//   2. MetaVault pro-rata pulls from each sub-strategy
//   3. Returns USDC to TreasuryV2
//
// Rebalance:
//   Admin/keeper calls rebalance() to realign actual allocations with targets.
//
// Key features:
//   - Weighted allocation across 4 sub-strategies
//   - Drift-based auto-rebalancing with configurable threshold
//   - Per-strategy deposit caps and circuit breakers
//   - Emergency withdraw-all from any or all sub-strategies
//   - Single IStrategy façade for TreasuryV2
// ═══════════════════════════════════════════════════════════════════════════

contract MetaVault is
    IStrategy,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    TimelockGoverned
{
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════

    uint256 public constant BPS = 10_000;

    /// @notice Max sub-strategies this vault supports
    uint256 public constant MAX_STRATEGIES = 4;

    /// @notice Minimum rebalance drift before rebalance is allowed (200 bps = 2%)
    uint256 public constant MIN_DRIFT_BPS = 200;

    // ═══════════════════════════════════════════════════════════════════
    // ROLES
    // ═══════════════════════════════════════════════════════════════════

    bytes32 public constant TREASURY_ROLE   = keccak256("TREASURY_ROLE");
    bytes32 public constant STRATEGIST_ROLE = keccak256("STRATEGIST_ROLE");
    bytes32 public constant GUARDIAN_ROLE   = keccak256("GUARDIAN_ROLE");
    bytes32 public constant KEEPER_ROLE     = keccak256("KEEPER_ROLE");

    // ═══════════════════════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════════════════════

    struct SubStrategy {
        address strategy;       // IStrategy implementation address
        uint256 weightBps;      // Target allocation (e.g., 3500 = 35%)
        uint256 capUsd;         // Max USDC deployable (6 decimals, 0 = unlimited)
        bool    enabled;        // Circuit breaker — can be disabled individually
    }

    // ═══════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════

    /// @notice USDC token
    IERC20 public usdc;

    /// @notice Array of sub-strategies (max 4)
    SubStrategy[] public subStrategies;

    /// @notice Whether the vault is active for deposits
    bool public active;

    /// @notice Total principal deposited (before sub-strategy leverage)
    uint256 public totalPrincipal;

    /// @notice Drift threshold in BPS before rebalance is triggered
    uint256 public driftThresholdBps;

    /// @notice Minimum time between rebalances (seconds)
    uint256 public rebalanceCooldown;

    /// @notice Timestamp of last rebalance
    uint256 public lastRebalanceAt;

    // ═══════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event Deposited(uint256 totalAmount, uint256[] subAmounts);
    event Withdrawn(uint256 totalAmount, uint256[] subAmounts);
    event SubStrategyAdded(uint256 indexed index, address strategy, uint256 weightBps);
    event SubStrategyRemoved(uint256 indexed index, address strategy);
    event SubStrategyToggled(uint256 indexed index, bool enabled);
    event WeightsUpdated(uint256[] newWeights);
    event Rebalanced(uint256[] deltas, uint256 drift);
    event EmergencyWithdrawn(uint256 indexed index, uint256 amount);
    event CapUpdated(uint256 indexed index, uint256 newCap);
    event DriftThresholdUpdated(uint256 oldBps, uint256 newBps);

    // ═══════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error StrategyNotActive();
    error TooManyStrategies();
    error WeightSumNot10000();
    error InvalidIndex();
    error SubStrategyDisabled();
    error CooldownNotElapsedMV();
    error DriftBelowThreshold();
    error CapExceeded();
    error NoSubStrategies();

    // ═══════════════════════════════════════════════════════════════════
    // CONSTRUCTOR & INITIALIZER
    // ═══════════════════════════════════════════════════════════════════

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param _usdc USDC token address
    /// @param _treasury TreasuryV2 address (gets TREASURY_ROLE)
    /// @param _admin Admin wallet
    /// @param _timelock MintedTimelockController
    function initialize(
        address _usdc,
        address _treasury,
        address _admin,
        address _timelock
    ) external initializer {
        if (_usdc == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_admin == address(0)) revert ZeroAddress();
        if (_timelock == address(0)) revert ZeroAddress();

        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        _setTimelock(_timelock);

        usdc = IERC20(_usdc);
        active = true;
        driftThresholdBps = 500; // 5% default
        rebalanceCooldown = 1 hours;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(TREASURY_ROLE, _treasury);
        _grantRole(STRATEGIST_ROLE, _admin);
        _grantRole(GUARDIAN_ROLE, _admin);
        _grantRole(KEEPER_ROLE, _admin);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                    IStrategy — DEPOSIT
    // ═══════════════════════════════════════════════════════════════════

    /// @inheritdoc IStrategy
    function deposit(uint256 amount)
        external
        override
        onlyRole(TREASURY_ROLE)
        nonReentrant
        whenNotPaused
        returns (uint256 deposited)
    {
        if (!active) revert StrategyNotActive();
        if (amount == 0) revert ZeroAmount();
        uint256 len = subStrategies.length;
        if (len == 0) revert NoSubStrategies();
        _validateWeights();

        // Pull USDC from Treasury
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        uint256[] memory subAmounts = new uint256[](len);
        uint256 remaining = amount;

        // Distribute according to weights
        for (uint256 i = 0; i < len; i++) {
            SubStrategy storage ss = subStrategies[i];
            if (!ss.enabled) continue;

            uint256 share;
            if (i == len - 1) {
                // Last strategy gets the remainder (avoids rounding dust)
                share = remaining;
            } else {
                share = (amount * ss.weightBps) / BPS;
                if (share > remaining) share = remaining;
            }

            if (share == 0) continue;

            // Enforce per-strategy cap
            if (ss.capUsd > 0) {
                uint256 currentVal = IStrategy(ss.strategy).totalValue();
                if (currentVal + share > ss.capUsd) {
                    uint256 allowed = ss.capUsd > currentVal ? ss.capUsd - currentVal : 0;
                    share = allowed;
                }
            }

            if (share > 0) {
                usdc.forceApprove(ss.strategy, share);
                IStrategy(ss.strategy).deposit(share);
                subAmounts[i] = share;
                remaining -= share;
            }
        }

        // If remaining dust due to caps/disabled strategies, keep in MetaVault as idle USDC
        deposited = amount - remaining;
        totalPrincipal += deposited;

        emit Deposited(deposited, subAmounts);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                    IStrategy — WITHDRAW
    // ═══════════════════════════════════════════════════════════════════

    /// @inheritdoc IStrategy
    function withdraw(uint256 amount)
        external
        override
        onlyRole(TREASURY_ROLE)
        nonReentrant
        returns (uint256 withdrawn)
    {
        if (amount == 0) revert ZeroAmount();

        uint256 len = subStrategies.length;
        uint256[] memory subAmounts = new uint256[](len);
        uint256 needed = amount;

        // First, use any idle USDC sitting in the MetaVault
        uint256 idle = usdc.balanceOf(address(this));
        if (idle > 0) {
            uint256 fromIdle = idle > needed ? needed : idle;
            needed -= fromIdle;
            withdrawn += fromIdle;
        }

        // Pro-rata withdraw from sub-strategies based on their current value
        if (needed > 0 && len > 0) {
            uint256 totalSub = _totalSubValue();
            if (totalSub > 0) {
                for (uint256 i = 0; i < len && needed > 0; i++) {
                    uint256 subVal = IStrategy(subStrategies[i].strategy).totalValue();
                    if (subVal == 0) continue;

                    // Last strategy with value: pull whatever is still needed
                    uint256 pull = (needed * subVal) / totalSub;
                    if (pull > subVal) pull = subVal;
                    if (pull > needed) pull = needed;

                    if (pull > 0) {
                        uint256 got = IStrategy(subStrategies[i].strategy).withdraw(pull);
                        subAmounts[i] = got;
                        withdrawn += got;
                        needed = needed > got ? needed - got : 0;
                    }
                }
            }

            // Second pass: if still short due to rounding, pull from any with value
            for (uint256 i = 0; i < len && needed > 0; i++) {
                uint256 subVal = IStrategy(subStrategies[i].strategy).totalValue();
                if (subVal == 0) continue;
                uint256 pull = needed > subVal ? subVal : needed;
                uint256 got = IStrategy(subStrategies[i].strategy).withdraw(pull);
                subAmounts[i] += got;
                withdrawn += got;
                needed = needed > got ? needed - got : 0;
            }
        }

        // Transfer actual USDC we hold (may differ from `withdrawn` accounting due to rounding)
        uint256 toSend = usdc.balanceOf(address(this));
        if (toSend > amount) toSend = amount; // never send more than requested
        if (toSend < withdrawn) withdrawn = toSend;

        if (withdrawn > 0) {
            if (totalPrincipal > withdrawn) {
                totalPrincipal -= withdrawn;
            } else {
                totalPrincipal = 0;
            }
            usdc.safeTransfer(msg.sender, withdrawn);
        }

        emit Withdrawn(withdrawn, subAmounts);
    }

    /// @inheritdoc IStrategy
    function withdrawAll()
        external
        override
        onlyRole(TREASURY_ROLE)
        nonReentrant
        returns (uint256 withdrawn)
    {
        uint256 len = subStrategies.length;
        uint256[] memory subAmounts = new uint256[](len);

        for (uint256 i = 0; i < len; i++) {
            uint256 got = IStrategy(subStrategies[i].strategy).withdrawAll();
            subAmounts[i] = got;
        }

        // After all sub-strategy withdrawals, everything is in our balance
        withdrawn = usdc.balanceOf(address(this));
        totalPrincipal = 0;

        if (withdrawn > 0) {
            usdc.safeTransfer(msg.sender, withdrawn);
        }

        emit Withdrawn(withdrawn, subAmounts);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                    IStrategy — VIEW
    // ═══════════════════════════════════════════════════════════════════

    /// @inheritdoc IStrategy
    function totalValue() external view override returns (uint256) {
        return _totalSubValue() + usdc.balanceOf(address(this));
    }

    /// @inheritdoc IStrategy
    function asset() external view override returns (address) {
        return address(usdc);
    }

    /// @inheritdoc IStrategy
    function isActive() external view override returns (bool) {
        return active;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                    SUB-STRATEGY MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Add a new sub-strategy.
    /// @dev Weights are NOT validated here — call validateWeights() or setWeights()
    ///      after adding all desired sub-strategies. Deposits are blocked until
    ///      weights sum to BPS.
    function addSubStrategy(
        address _strategy,
        uint256 _weightBps,
        uint256 _capUsd
    ) external onlyRole(STRATEGIST_ROLE) {
        if (_strategy == address(0)) revert ZeroAddress();
        if (subStrategies.length >= MAX_STRATEGIES) revert TooManyStrategies();

        subStrategies.push(SubStrategy({
            strategy: _strategy,
            weightBps: _weightBps,
            capUsd: _capUsd,
            enabled: true
        }));

        // Pre-approve USDC to sub-strategy
        usdc.approve(_strategy, type(uint256).max);

        emit SubStrategyAdded(subStrategies.length - 1, _strategy, _weightBps);
    }

    /// @notice Public weight validation — reverts if weights don't sum to BPS
    function validateWeights() external view {
        _validateWeights();
    }

    /// @notice Remove a sub-strategy (withdraws all funds first)
    function removeSubStrategy(uint256 index) external onlyRole(STRATEGIST_ROLE) {
        if (index >= subStrategies.length) revert InvalidIndex();

        SubStrategy storage ss = subStrategies[index];
        address strat = ss.strategy;

        // Withdraw everything from this sub-strategy
        uint256 recovered = IStrategy(strat).withdrawAll();
        if (recovered > 0) {
            // Keep in MetaVault as idle USDC
        }

        // Revoke approval
        usdc.approve(strat, 0);

        emit SubStrategyRemoved(index, strat);

        // Swap with last and pop
        uint256 last = subStrategies.length - 1;
        if (index != last) {
            subStrategies[index] = subStrategies[last];
        }
        subStrategies.pop();

        // Weights must be re-set after removal
    }

    /// @notice Enable/disable a sub-strategy (circuit breaker)
    function toggleSubStrategy(uint256 index, bool enabled) external onlyRole(GUARDIAN_ROLE) {
        if (index >= subStrategies.length) revert InvalidIndex();
        subStrategies[index].enabled = enabled;
        emit SubStrategyToggled(index, enabled);
    }

    /// @notice Update all weights at once. Must sum to BPS.
    function setWeights(uint256[] calldata weights) external onlyRole(STRATEGIST_ROLE) {
        if (weights.length != subStrategies.length) revert LengthMismatch();
        for (uint256 i = 0; i < weights.length; i++) {
            subStrategies[i].weightBps = weights[i];
        }
        _validateWeights();
        emit WeightsUpdated(weights);
    }

    /// @notice Update cap for a sub-strategy
    function setSubStrategyCap(uint256 index, uint256 newCap) external onlyRole(STRATEGIST_ROLE) {
        if (index >= subStrategies.length) revert InvalidIndex();
        subStrategies[index].capUsd = newCap;
        emit CapUpdated(index, newCap);
    }

    /// @notice Set drift threshold (min BPS drift before rebalance is allowed)
    function setDriftThreshold(uint256 newBps) external onlyRole(STRATEGIST_ROLE) {
        if (newBps < MIN_DRIFT_BPS) revert DriftBelowThreshold();
        emit DriftThresholdUpdated(driftThresholdBps, newBps);
        driftThresholdBps = newBps;
    }

    /// @notice Set rebalance cooldown (seconds)
    function setRebalanceCooldown(uint256 seconds_) external onlyRole(STRATEGIST_ROLE) {
        rebalanceCooldown = seconds_;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                    REBALANCE
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Rebalance sub-strategies to match target weights.
    ///         Withdraws from over-allocated, deposits to under-allocated.
    function rebalance() external onlyRole(KEEPER_ROLE) nonReentrant whenNotPaused {
        if (block.timestamp < lastRebalanceAt + rebalanceCooldown) revert CooldownNotElapsedMV();

        uint256 len = subStrategies.length;
        if (len == 0) revert NoSubStrategies();

        uint256 total = _totalSubValue() + usdc.balanceOf(address(this));
        if (total == 0) return;

        // Calculate current vs target and find max drift
        int256[] memory deltas = new int256[](len);
        uint256 maxDrift = 0;

        for (uint256 i = 0; i < len; i++) {
            SubStrategy storage ss = subStrategies[i];
            uint256 currentVal = IStrategy(ss.strategy).totalValue();
            uint256 targetVal = (total * ss.weightBps) / BPS;
            deltas[i] = int256(targetVal) - int256(currentVal);

            // Track max drift (in BPS relative to total)
            uint256 driftBps = currentVal > targetVal
                ? ((currentVal - targetVal) * BPS) / total
                : ((targetVal - currentVal) * BPS) / total;
            if (driftBps > maxDrift) maxDrift = driftBps;
        }

        if (maxDrift < driftThresholdBps) revert DriftBelowThreshold();

        // Phase 1: Withdraw from over-allocated strategies
        for (uint256 i = 0; i < len; i++) {
            if (deltas[i] < 0) {
                uint256 excess = uint256(-deltas[i]);
                IStrategy(subStrategies[i].strategy).withdraw(excess);
            }
        }

        // Phase 2: Deposit to under-allocated strategies
        for (uint256 i = 0; i < len; i++) {
            if (deltas[i] > 0 && subStrategies[i].enabled) {
                uint256 deficit = uint256(deltas[i]);
                uint256 available = usdc.balanceOf(address(this));
                uint256 toDeposit = deficit > available ? available : deficit;
                if (toDeposit > 0) {
                    usdc.forceApprove(subStrategies[i].strategy, toDeposit);
                    IStrategy(subStrategies[i].strategy).deposit(toDeposit);
                }
            }
        }

        lastRebalanceAt = block.timestamp;

        uint256[] memory deltaAbs = new uint256[](len);
        for (uint256 i = 0; i < len; i++) {
            deltaAbs[i] = deltas[i] >= 0 ? uint256(deltas[i]) : uint256(-deltas[i]);
        }
        emit Rebalanced(deltaAbs, maxDrift);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                    EMERGENCY
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Emergency withdraw all funds from a specific sub-strategy
    function emergencyWithdrawFrom(uint256 index)
        external
        onlyRole(GUARDIAN_ROLE)
    {
        if (index >= subStrategies.length) revert InvalidIndex();
        uint256 got = IStrategy(subStrategies[index].strategy).withdrawAll();
        subStrategies[index].enabled = false;
        emit EmergencyWithdrawn(index, got);
    }

    /// @notice Emergency withdraw all funds from ALL sub-strategies
    function emergencyWithdrawAll() external onlyRole(GUARDIAN_ROLE) {
        for (uint256 i = 0; i < subStrategies.length; i++) {
            uint256 got = IStrategy(subStrategies[i].strategy).withdrawAll();
            subStrategies[i].enabled = false;
            emit EmergencyWithdrawn(i, got);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //                    ADMIN
    // ═══════════════════════════════════════════════════════════════════

    function setActive(bool _active) external onlyRole(STRATEGIST_ROLE) {
        active = _active;
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    /// @dev MV-02: Changed from DEFAULT_ADMIN_ROLE to onlyTimelock (governance delay)
    function unpause() external onlyTimelock {
        _unpause();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                    VIEW HELPERS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Number of sub-strategies
    function subStrategyCount() external view returns (uint256) {
        return subStrategies.length;
    }

    /// @notice Get full sub-strategy info
    function getSubStrategy(uint256 index)
        external
        view
        returns (address strategy, uint256 weightBps, uint256 capUsd, bool enabled, uint256 currentValue)
    {
        if (index >= subStrategies.length) revert InvalidIndex();
        SubStrategy storage ss = subStrategies[index];
        return (
            ss.strategy,
            ss.weightBps,
            ss.capUsd,
            ss.enabled,
            IStrategy(ss.strategy).totalValue()
        );
    }

    /// @notice Current allocation BPS for each sub-strategy
    function currentAllocations() external view returns (uint256[] memory allocBps) {
        uint256 len = subStrategies.length;
        allocBps = new uint256[](len);
        uint256 total = _totalSubValue() + usdc.balanceOf(address(this));
        if (total == 0) return allocBps;

        for (uint256 i = 0; i < len; i++) {
            uint256 val = IStrategy(subStrategies[i].strategy).totalValue();
            allocBps[i] = (val * BPS) / total;
        }
    }

    /// @notice Maximum drift from target across all sub-strategies (in BPS)
    function currentDrift() external view returns (uint256 maxDrift) {
        uint256 len = subStrategies.length;
        uint256 total = _totalSubValue() + usdc.balanceOf(address(this));
        if (total == 0) return 0;

        for (uint256 i = 0; i < len; i++) {
            SubStrategy storage ss = subStrategies[i];
            uint256 currentVal = IStrategy(ss.strategy).totalValue();
            uint256 targetVal = (total * ss.weightBps) / BPS;
            uint256 driftBps = currentVal > targetVal
                ? ((currentVal - targetVal) * BPS) / total
                : ((targetVal - currentVal) * BPS) / total;
            if (driftBps > maxDrift) maxDrift = driftBps;
        }
    }

    /// @notice Idle USDC sitting in MetaVault (not deployed to any strategy)
    function idleBalance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    // ═══════════════════════════════════════════════════════════════════
    //                    INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    function _totalSubValue() internal view returns (uint256 total) {
        for (uint256 i = 0; i < subStrategies.length; i++) {
            total += IStrategy(subStrategies[i].strategy).totalValue();
        }
    }

    function _validateWeights() internal view {
        uint256 sum = 0;
        for (uint256 i = 0; i < subStrategies.length; i++) {
            sum += subStrategies[i].weightBps;
        }
        if (sum != BPS) revert WeightSumNot10000();
    }

    /// @dev MV-01: Changed from DEFAULT_ADMIN_ROLE to onlyTimelock (governance delay)
    function _authorizeUpgrade(address) internal override onlyTimelock {}

    /// @dev Storage gap for future upgradeable storage variables
    uint256[40] private __gap;
}
