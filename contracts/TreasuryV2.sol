// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IStrategy.sol";
import "./TimelockGoverned.sol";
import "./Errors.sol";
/**
 * @title TreasuryV2
 * @notice Auto-allocating treasury that distributes deposits across strategies on mint
 * @dev When USDC comes in, it's automatically split according to target allocations
 *
 * Default Allocation (v3 — Feb 2026):
 *   Pendle Multi-Pool:        30% (11.7% APY)
 *   Euler V2 RLUSD/USDC Loop: 15% (8-12% APY — cross-stable leverage)
 *   Morpho Loop:              20% (11.5% APY)
 *   Sky sUSDS:                15% (8% APY)
 *   Fluid Stable Loop:        10% (14.3% APY — syrupUSDC/USDC T1 #146)
 *   USDC Reserve:             10% (0% APY)
 *   ────────────────────────────────────────
 *   Blended:                  ~11.0% gross APY
 *
 * Revenue Split:
 *   smUSD Holders:      60% (~6.6% net APY target)
 *   Protocol:           40% (spread above 6%)
 */
contract TreasuryV2 is
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    TimelockGoverned
{
    using SafeERC20 for IERC20;
    // ═══════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════
    uint256 public constant BPS = 10000;
    uint256 public constant MAX_STRATEGIES = 10;
    uint256 public constant MIN_ACCRUAL_INTERVAL = 1 hours;
    // ═══════════════════════════════════════════════════════════════════════
    // ROLES
    // ═══════════════════════════════════════════════════════════════════════
    bytes32 public constant ALLOCATOR_ROLE = keccak256("ALLOCATOR_ROLE");
    bytes32 public constant STRATEGIST_ROLE = keccak256("STRATEGIST_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");
    // TIMELOCK_ROLE replaced by TimelockGoverned — all admin ops go through MintedTimelockController
    // ═══════════════════════════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════════════════════════
    struct StrategyConfig {
        address strategy;           // Strategy contract address
        uint256 targetBps;          // Target allocation (basis points)
        uint256 minBps;             // Minimum allocation
        uint256 maxBps;             // Maximum allocation
        bool active;                // Is strategy active
        bool autoAllocate;          // Auto-allocate on deposit
    }
    struct ProtocolFees {
        uint256 performanceFeeBps;  // Fee on yield (default 4000 = 40%)
        uint256 accruedFees;        // Accumulated protocol fees
        address feeRecipient;       // Where fees go
    }
    // ═══════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════
    /// @notice USDC token
    IERC20 public asset;
    /// @notice SMUSD vault address
    address public vault;
    /// @notice Strategy configurations
    StrategyConfig[] public strategies;
    /// @notice Strategy address → index in array
    mapping(address => uint256) public strategyIndex;
    /// @notice Strategy address → is registered
    mapping(address => bool) public isStrategy;
    /// @notice Reserve buffer in basis points (not deployed to strategies)
    uint256 public reserveBps;
    /// @notice Protocol fee configuration
    ProtocolFees public fees;
    /// @notice Last recorded total value (for yield calculation)
    uint256 public lastRecordedValue;
    /// @notice Last fee accrual timestamp
    uint256 public lastFeeAccrual;
    /// @notice Minimum deposit to trigger auto-allocation
    uint256 public minAutoAllocateAmount;
    /// @notice High-water mark for fee accrual. Fees only accrue when
    ///         totalValue exceeds this peak, preventing fee charging on principal recovery
    ///         after transient strategy failures.
    uint256 public peakRecordedValue;
    /// @dev Storage gap for future upgrades (reduced by 1 for peakRecordedValue)
    uint256[39] private __gap;
    // ═══════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════
    event Deposited(address indexed from, uint256 amount, uint256[] allocations);
    event Withdrawn(address indexed to, uint256 amount);
    event StrategyAdded(address indexed strategy, uint256 targetBps);
    event StrategyRemoved(address indexed strategy);
    event StrategyUpdated(address indexed strategy, uint256 newTargetBps);
    event StrategyWithdrawn(address indexed strategy, uint256 amount);
    event FeesAccrued(uint256 yield_, uint256 protocolFee);
    event FeesClaimed(address indexed recipient, uint256 amount);
    event Rebalanced(uint256 totalValue);
    event EmergencyWithdraw(uint256 amount);
    event StrategyDepositFailed(address indexed strategy, uint256 amount, bytes reason);
    event StrategyWithdrawFailed(address indexed strategy, uint256 amount, bytes reason);
    event RebalanceWithdrawFailed(address indexed strategy, uint256 amount);
    event RebalanceDepositFailed(address indexed strategy, uint256 amount);
    event DeployedToStrategy(address indexed strategy, uint256 amount, uint256 deposited);
    event WithdrawnFromStrategy(address indexed strategy, uint256 amount, uint256 withdrawn);
    // ═══════════════════════════════════════════════════════════════════════
    // ERRORS (shared errors imported from Errors.sol)
    // ═══════════════════════════════════════════════════════════════════════
    error StrategyExists();
    error StrategyNotFound();
    error AllocationExceedsLimit();
    error TotalAllocationInvalid();
    error OnlyVault();
    error MaxStrategiesReached();
    // ═══════════════════════════════════════════════════════════════════════
    // INITIALIZER
    // ═══════════════════════════════════════════════════════════════════════
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }
    /**
     * @notice Initialize treasury with default configuration
     * @param _asset USDC address
     * @param _vault SMUSD vault address
     * @param _admin Admin address
     * @param _feeRecipient Protocol fee recipient
     */
    function initialize(
        address _asset,
        address _vault,
        address _admin,
        address _feeRecipient,
        address _timelock
    ) external initializer {
        if (_asset == address(0) || _vault == address(0) || _admin == address(0)) {
            revert ZeroAddress();
        }
        if (_timelock == address(0)) revert ZeroAddress();
        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        _setTimelock(_timelock);
        asset = IERC20(_asset);
        vault = _vault;
        // Default fee configuration
        fees = ProtocolFees({
            performanceFeeBps: 4000,  // 40% of yield → stakers get ~6% on 10% gross
            accruedFees: 0,
            feeRecipient: _feeRecipient
        });
        // Default reserve (10%)
        reserveBps = 1000;
        // Minimum $1000 to auto-allocate
        minAutoAllocateAmount = 1000e6;
        // Setup roles
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ALLOCATOR_ROLE, _admin);
        _grantRole(STRATEGIST_ROLE, _admin);
        _grantRole(GUARDIAN_ROLE, _admin);
        _grantRole(VAULT_ROLE, _vault);
        // TimelockGoverned replaces TIMELOCK_ROLE — admin ops go through MintedTimelockController
        lastFeeAccrual = block.timestamp;
    }
    // ═══════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════
    /// @dev Event for strategy totalValue() failures
    event StrategyValueQueryFailed(address indexed strategy);
    /**
     * @notice Total value across reserve + all strategies
     * @dev Loops over bounded, admin-controlled strategies array (max ~10 strategies)
     *      Uses try/catch so a reverting strategy doesn't DoS
     *      all deposits, withdrawals, and redemptions system-wide.
     */
    function totalValue() public view returns (uint256) {
        uint256 total = reserveBalance();
        for (uint256 i = 0; i < strategies.length; i++) {
            if (strategies[i].active) {
                // slither-disable-next-line calls-loop
                // Treat reverting strategies as zero value instead of DoS
                try IStrategy(strategies[i].strategy).totalValue() returns (uint256 val) {
                    total += val;
                } catch {
                    // Strategy is broken — treated as zero. Admin should removeStrategy.
                    // Note: can't emit event in view function, but the broken strategy
                    // will be visible via getCurrentAllocations() returning 0 for it.
                }
            }
        }
        return total;
    }
    /**
     * @notice Total value minus accrued protocol fees
     */
    function totalValueNet() public view returns (uint256) {
        uint256 total = totalValue();
        uint256 pending = _calculatePendingFees();
        return total > pending ? total - pending : 0;
    }
    /**
     * @notice USDC balance held in reserve
     */
    function reserveBalance() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }
    /**
     * @notice Target reserve amount based on total value
     */
    function targetReserve() public view returns (uint256) {
        return (totalValue() * reserveBps) / BPS;
    }
    /**
     * @notice Get strategy count
     */
    function strategyCount() external view returns (uint256) {
        return strategies.length;
    }
    /**
     * @notice Get all strategy configs
     */
    function getAllStrategies() external view returns (StrategyConfig[] memory) {
        return strategies;
    }
    /**
     * @notice Get current allocation percentages
     */
    function getCurrentAllocations() external view returns (
        address[] memory strategyAddresses,
        uint256[] memory currentBps,
        uint256[] memory _targetBps
    ) {
        uint256 total = totalValue();
        uint256 len = strategies.length;
        strategyAddresses = new address[](len);
        currentBps = new uint256[](len);
        _targetBps = new uint256[](len);
        for (uint256 i = 0; i < len; i++) {
            strategyAddresses[i] = strategies[i].strategy;
            _targetBps[i] = strategies[i].targetBps;
            if (total > 0 && strategies[i].active) {
                // slither-disable-next-line calls-loop
                // doesn't DoS this view function. Defaults to 0 bps on failure.
                try IStrategy(strategies[i].strategy).totalValue() returns (uint256 stratValue) {
                    currentBps[i] = (stratValue * BPS) / total;
                } catch {
                    currentBps[i] = 0;
                }
            }
        }
    }
    /**
     * @notice Calculate pending protocol fees
     */
    function _calculatePendingFees() internal view returns (uint256) {
        uint256 currentValue = totalValue();
        if (currentValue <= lastRecordedValue) return fees.accruedFees;
        uint256 yield_ = currentValue - lastRecordedValue;
        uint256 newFees = (yield_ * fees.performanceFeeBps) / BPS;
        return fees.accruedFees + newFees;
    }
    /**
     * @notice Get pending fees
     */
    function pendingFees() external view returns (uint256) {
        return _calculatePendingFees();
    }
    // ═══════════════════════════════════════════════════════════════════════
    // VAULT INTERFACE (Auto-Allocation)
    // ═══════════════════════════════════════════════════════════════════════
    /**
     * @notice Deposit from vault with automatic allocation
     * @param amount USDC amount to deposit
     * @return allocations Array of amounts allocated to each strategy
     */
    function depositFromVault(uint256 amount)
        external
        nonReentrant
        whenNotPaused
        onlyRole(VAULT_ROLE)
        returns (uint256[] memory allocations)
    {
        if (amount == 0) revert ZeroAmount();
        // Accrue fees before deposit
        _accrueFees();
        // Pull USDC from vault
        asset.safeTransferFrom(msg.sender, address(this), amount);
        // Auto-allocate if above minimum
        if (amount >= minAutoAllocateAmount) {
            allocations = _autoAllocate(amount);
        } else {
            // Small deposits stay in reserve until next rebalance
            allocations = new uint256[](strategies.length);
        }
        lastRecordedValue = totalValue();
        emit Deposited(msg.sender, amount, allocations);
        return allocations;
    }
    /**
     * @notice Withdraw to vault
     * @param amount USDC amount requested
     * @return actualAmount Amount actually withdrawn
     */
    function withdrawToVault(uint256 amount)
        external
        nonReentrant
        whenNotPaused
        onlyRole(VAULT_ROLE)
        returns (uint256 actualAmount)
    {
        if (amount == 0) revert ZeroAmount();
        // Accrue fees before withdrawal
        _accrueFees();
        // Try to fulfill from reserve first
        uint256 reserve = reserveBalance();
        if (reserve >= amount) {
            // Reserve covers it
            asset.safeTransfer(vault, amount);
            actualAmount = amount;
        } else {
            // Need to pull from strategies
            uint256 needed = amount - reserve;
            // slither-disable-next-line reentrancy-vulnerabilities
            uint256 withdrawn = _withdrawFromStrategies(needed);
            actualAmount = reserve + withdrawn;
            if (actualAmount > amount) actualAmount = amount;
            // Silent partial withdrawals can leave protocol in inconsistent state
            if (actualAmount < amount) {
                revert InsufficientLiquidity();
            }
            asset.safeTransfer(vault, actualAmount);
        }
        lastRecordedValue = totalValue();
        emit Withdrawn(vault, actualAmount);
        return actualAmount;
    }
    // ═══════════════════════════════════════════════════════════════════════
    // LEGACY INTERFACE (backward compatibility with DirectMint)
    // ═══════════════════════════════════════════════════════════════════════
    /**
     * @notice Total USDC backing (reserve + deployed to strategies)
     * @dev Matches Treasury.sol interface so DirectMint works unchanged
     */
    function totalBacking() external view returns (uint256) {
        return totalValue();
    }
    /**
     * @notice USDC available in reserve (not deployed)
     * @dev Matches Treasury.sol interface so DirectMint works unchanged
     */
    function availableReserves() public view returns (uint256) {
        return reserveBalance();
    }
    /**
     * @notice Deposit USDC from DirectMint (legacy interface)
     * @param from Address to pull USDC from
     * @param amount Amount of USDC to deposit
     *      Even though VAULT_ROLE is required, a compromised vault could drain
     *      any address that has approved this contract.
     */
    function deposit(address from, uint256 amount) external nonReentrant whenNotPaused onlyRole(VAULT_ROLE) {
        if (amount == 0) revert ZeroAmount();
        if (from != msg.sender) revert MustDepositOwnFunds();
        _accrueFees();
        asset.safeTransferFrom(from, address(this), amount);
        // Auto-allocate if above minimum
        if (amount >= minAutoAllocateAmount) {
            _autoAllocate(amount);
        }
        // is not mistaken for yield on the next _accrueFees() call.
        lastRecordedValue = totalValue();
        uint256[] memory allocs = new uint256[](0);
        emit Deposited(from, amount, allocs);
    }
    /**
     * @notice Withdraw USDC to a recipient (legacy interface)
     * @param to Address to send USDC to
     * @param amount Amount of USDC to withdraw
     */
    function withdraw(address to, uint256 amount) external nonReentrant whenNotPaused onlyRole(VAULT_ROLE) {
        if (amount == 0) revert ZeroAmount();
        _accrueFees();
        uint256 reserve = reserveBalance();
        if (reserve < amount) {
            uint256 needed = amount - reserve;
            _withdrawFromStrategies(needed);
        }
        uint256 available = reserveBalance();
        if (available < amount) revert InsufficientReserves();
        asset.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }
    // ═══════════════════════════════════════════════════════════════════════
    // AUTO-ALLOCATION
    // ═══════════════════════════════════════════════════════════════════════
    /**
     * @notice Automatically allocate deposit across strategies
     * @param amount Total amount to allocate
     * @return allocations Amount sent to each strategy
     */
    function _autoAllocate(uint256 amount) internal returns (uint256[] memory allocations) {
        allocations = new uint256[](strategies.length);
        // Calculate how much goes to reserve
        uint256 toReserve = (amount * reserveBps) / BPS;
        uint256 toAllocate = amount - toReserve;
        // Calculate total target bps for active auto-allocate strategies
        uint256 totalTargetBps = 0;
        for (uint256 i = 0; i < strategies.length; i++) {
            if (strategies[i].active && strategies[i].autoAllocate) {
                totalTargetBps += strategies[i].targetBps;
            }
        }
        if (totalTargetBps == 0) return allocations;
        // This prevents the last strategy from receiving an incorrect amount when
        // prior strategies deposit less than approved due to slippage.
        uint256 sharesApproved = 0;
        uint256 lastActiveIdx = type(uint256).max;
        // Find last active auto-allocate strategy for remainder handling
        for (uint256 i = 0; i < strategies.length; i++) {
            if (strategies[i].active && strategies[i].autoAllocate) {
                lastActiveIdx = i;
            }
        }
        for (uint256 i = 0; i < strategies.length; i++) {
            if (!strategies[i].active || !strategies[i].autoAllocate) continue;
            // Calculate this strategy's share
            uint256 share;
            if (i == lastActiveIdx) {
                // Last active strategy gets remainder to avoid rounding dust
                share = toAllocate - sharesApproved;
            } else {
                share = (toAllocate * strategies[i].targetBps) / totalTargetBps;
            }
            if (share > 0) {
                sharesApproved += share;
                // Approve and deposit
                address strat = strategies[i].strategy;
                asset.forceApprove(strat, share);
                // slither-disable-next-line calls-loop
                try IStrategy(strat).deposit(share) returns (uint256 deposited) {
                    allocations[i] = deposited;
                    asset.forceApprove(strat, 0);
                } catch (bytes memory reason) {
                    allocations[i] = 0;
                    asset.forceApprove(strat, 0);
                    emit StrategyDepositFailed(strat, share, reason);
                }
            }
        }
        return allocations;
    }
    /**
     * @notice Withdraw from strategies proportionally
     */
    function _withdrawFromStrategies(uint256 amount) internal returns (uint256 totalWithdrawn) {
        uint256 remaining = amount;
        // Calculate total strategy value
        // Use try/catch to prevent DoS from reverting strategies
        uint256 totalStratValue = 0;
        uint256 lastActiveIdx = type(uint256).max;
        for (uint256 i = 0; i < strategies.length; i++) {
            if (strategies[i].active) {
                // slither-disable-next-line calls-loop
                try IStrategy(strategies[i].strategy).totalValue() returns (uint256 val) {
                    totalStratValue += val;
                    lastActiveIdx = i;
                } catch {
                    // Skip broken strategies during withdrawal
                }
            }
        }
        if (totalStratValue == 0) return 0;
        // to avoid rounding dust leaving funds stranded across strategies.
        for (uint256 i = 0; i < strategies.length && remaining > 0; i++) {
            if (!strategies[i].active) continue;
            address strat = strategies[i].strategy;
            // slither-disable-next-line calls-loop
            // Use try/catch for strategy value query
            uint256 stratValue = 0;
            try IStrategy(strat).totalValue() returns (uint256 val) {
                stratValue = val;
            } catch {
                continue; // Skip broken strategies
            }
            if (stratValue == 0) continue;
            // Last active strategy gets whatever remains to handle rounding
            uint256 toWithdraw;
            if (i == lastActiveIdx) {
                toWithdraw = remaining;
            } else {
                toWithdraw = (amount * stratValue) / totalStratValue;
            }
            if (toWithdraw > remaining) toWithdraw = remaining;
            if (toWithdraw > stratValue) toWithdraw = stratValue;
            if (toWithdraw > 0) {
                // slither-disable-next-line calls-loop
                try IStrategy(strat).withdraw(toWithdraw) returns (uint256 withdrawn) {
                    totalWithdrawn += withdrawn;
                    remaining = remaining > withdrawn ? remaining - withdrawn : 0;
                } catch (bytes memory reason) {
                    emit StrategyWithdrawFailed(strat, toWithdraw, reason);
                }
            }
        }
        return totalWithdrawn;
    }
    // ═══════════════════════════════════════════════════════════════════════
    // FEE MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════
    /**
     * @notice Accrue protocol fees on yield
     * Attacker cannot inflate totalValue() temporarily and immediately accrue fees.
     */
    /// @dev Track peak value to prevent charging fees on principal recovery.
    ///      Uses peakRecordedValue: fees only accrue when totalValue exceeds the all-time
    ///      high-water mark, ensuring only genuine yield is subject to performance fees.
    function _accrueFees() internal {
        if (block.timestamp < lastFeeAccrual + MIN_ACCRUAL_INTERVAL) {
            return;
        }
        uint256 currentValue = totalValue();
        // Only charge fees on genuine yield above the high-water mark.
        // peakRecordedValue tracks the highest legitimate totalValue observed.
        uint256 peak = peakRecordedValue > lastRecordedValue ? peakRecordedValue : lastRecordedValue;
        if (currentValue > peak) {
            uint256 yield_ = currentValue - peak;
            uint256 protocolFee = (yield_ * fees.performanceFeeBps) / BPS;
            fees.accruedFees += protocolFee;
            peakRecordedValue = currentValue;
            emit FeesAccrued(yield_, protocolFee);
        }
        lastRecordedValue = currentValue;
        lastFeeAccrual = block.timestamp;
    }
    /**
     * @notice Manually trigger fee accrual
     */
    function accrueFees() external onlyRole(ALLOCATOR_ROLE) {
        _accrueFees();
    }
    /**
     * @notice Claim accrued protocol fees
     */
    function claimFees() external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
        _accrueFees();
        uint256 toClaim = fees.accruedFees;
        // slither-disable-next-line incorrect-equality
        if (toClaim == 0) return;
        // This prevents loss if reserve + strategies can't cover the full amount.
        // Withdraw from strategies if needed
        uint256 reserve = reserveBalance();
        if (reserve < toClaim) {
            _withdrawFromStrategies(toClaim - reserve);
        }
        uint256 available = reserveBalance();
        uint256 toSend = available < toClaim ? available : toClaim;
        // Only deduct what we actually send; remainder stays as accruedFees
        fees.accruedFees = toClaim - toSend;
        asset.safeTransfer(fees.feeRecipient, toSend);
        // Update recorded value after fee withdrawal
        lastRecordedValue = totalValue();
        emit FeesClaimed(fees.feeRecipient, toSend);
    }
    // ═══════════════════════════════════════════════════════════════════════
    // STRATEGY MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════
    /**
     * @notice Add a new strategy
     */
    function addStrategy(
        address strategy,
        uint256 targetBps,
        uint256 minBps,
        uint256 maxBps,
        bool autoAllocate
    ) external onlyRole(STRATEGIST_ROLE) {
        if (strategy == address(0)) revert ZeroAddress();
        if (isStrategy[strategy]) revert StrategyExists();
        if (strategies.length >= MAX_STRATEGIES) revert MaxStrategiesReached();
        if (targetBps > maxBps || minBps > targetBps) revert AllocationExceedsLimit();
        // Validate total allocation
        uint256 totalTarget = targetBps + reserveBps;
        for (uint256 i = 0; i < strategies.length; i++) {
            if (strategies[i].active) {
                totalTarget += strategies[i].targetBps;
            }
        }
        if (totalTarget > BPS) revert TotalAllocationInvalid();
        strategies.push(StrategyConfig({
            strategy: strategy,
            targetBps: targetBps,
            minBps: minBps,
            maxBps: maxBps,
            active: true,
            autoAllocate: autoAllocate
        }));
        strategyIndex[strategy] = strategies.length - 1;
        isStrategy[strategy] = true;
        // Approvals are granted per-operation in _autoAllocate and rebalance.
        emit StrategyAdded(strategy, targetBps);
    }
    /**
     * @notice Remove a strategy (withdraws all funds first)
     */
    /// @dev Emitted when strategy force-deactivated due to failed withdrawal
    event StrategyForceDeactivated(address indexed strategy, uint256 strandedValue, bytes reason);
    function removeStrategy(address strategy) external onlyRole(STRATEGIST_ROLE) {
        if (!isStrategy[strategy]) revert StrategyNotFound();
        uint256 idx = strategyIndex[strategy];
        // Try to withdraw, but don't let failure permanently block removal.
        // If withdrawAll() fails, force-deactivate to prevent permanent DoS.
        if (strategies[idx].active) {
            uint256 stratValue = 0;
            try IStrategy(strategy).totalValue() returns (uint256 val) {
                stratValue = val;
            } catch {
                stratValue = 0;
            }
            if (stratValue > 0) {
                try IStrategy(strategy).withdrawAll() returns (uint256 withdrawn) {
                    // Verify at least 95% withdrawn (slippage tolerance)
                    uint256 minWithdrawn = (stratValue * 95) / 100;
                    if (withdrawn >= minWithdrawn) {
                        emit StrategyWithdrawn(strategy, withdrawn);
                    } else {
                        // Partial withdrawal — still deactivate but warn
                        emit StrategyForceDeactivated(strategy, stratValue - withdrawn, "");
                    }
                } catch (bytes memory reason) {
                    // Force-deactivate instead of reverting.
                    // Funds remain in the strategy — admin must recover via
                    // emergencyWithdrawAll() or direct strategy interaction later.
                    emit StrategyForceDeactivated(strategy, stratValue, reason);
                }
            }
        }
        // Deactivate (don't delete to preserve indices)
        strategies[idx].active = false;
        strategies[idx].targetBps = 0;
        isStrategy[strategy] = false;
        delete strategyIndex[strategy];
        // Revoke approval
        asset.forceApprove(strategy, 0);
        emit StrategyRemoved(strategy);
    }
    /**
     * @notice Update strategy allocation
     */
    function updateStrategy(
        address strategy,
        uint256 targetBps,
        uint256 minBps,
        uint256 maxBps,
        bool autoAllocate
    ) external onlyRole(ALLOCATOR_ROLE) {
        if (!isStrategy[strategy]) revert StrategyNotFound();
        uint256 idx = strategyIndex[strategy];
        // Validate new allocation
        uint256 totalTarget = targetBps + reserveBps;
        for (uint256 i = 0; i < strategies.length; i++) {
            if (i != idx && strategies[i].active) {
                totalTarget += strategies[i].targetBps;
            }
        }
        if (totalTarget > BPS) revert TotalAllocationInvalid();
        strategies[idx].targetBps = targetBps;
        strategies[idx].minBps = minBps;
        strategies[idx].maxBps = maxBps;
        strategies[idx].autoAllocate = autoAllocate;
        emit StrategyUpdated(strategy, targetBps);
    }
    // ═══════════════════════════════════════════════════════════════════════
    // MANUAL DEPLOYMENT
    // ═══════════════════════════════════════════════════════════════════════
    /**
     * @notice Deploy exact USDC amount from treasury reserves to a specific strategy
     * @param strategy The strategy address (must be registered and active)
     * @param amount USDC amount to deploy (6 decimals)
     */
    function deployToStrategy(
        address strategy,
        uint256 amount
    ) external nonReentrant whenNotPaused onlyRole(ALLOCATOR_ROLE) {
        if (amount == 0) revert ZeroAmount();
        if (!isStrategy[strategy]) revert StrategyNotFound();
        uint256 idx = strategyIndex[strategy];
        if (!strategies[idx].active) revert StrategyNotFound();
        if (reserveBalance() < amount) revert InsufficientReserves();
        asset.forceApprove(strategy, amount);
        uint256 deposited = IStrategy(strategy).deposit(amount);
        asset.forceApprove(strategy, 0);
        lastRecordedValue = totalValue();
        emit DeployedToStrategy(strategy, amount, deposited);
    }
    /**
     * @notice Withdraw exact USDC amount from a specific strategy back to treasury reserves
     * @param strategy The strategy address (must be registered)
     * @param amount USDC amount to withdraw (6 decimals)
     */
    function withdrawFromStrategy(
        address strategy,
        uint256 amount
    ) external nonReentrant onlyRole(ALLOCATOR_ROLE) {
        if (amount == 0) revert ZeroAmount();
        if (!isStrategy[strategy]) revert StrategyNotFound();
        uint256 withdrawn = IStrategy(strategy).withdraw(amount);
        lastRecordedValue = totalValue();
        emit WithdrawnFromStrategy(strategy, amount, withdrawn);
    }
    /**
     * @notice Withdraw all funds from a specific strategy back to treasury reserves
     * @param strategy The strategy address (must be registered)
     */
    function withdrawAllFromStrategy(
        address strategy
    ) external nonReentrant onlyRole(ALLOCATOR_ROLE) {
        if (!isStrategy[strategy]) revert StrategyNotFound();
        uint256 withdrawn = IStrategy(strategy).withdrawAll();
        lastRecordedValue = totalValue();
        emit WithdrawnFromStrategy(strategy, withdrawn, withdrawn);
    }
    // ═══════════════════════════════════════════════════════════════════════
    // REBALANCING
    // ═══════════════════════════════════════════════════════════════════════
    /**
     * @notice Rebalance all strategies to target allocations
     */
    function rebalance() external nonReentrant onlyRole(ALLOCATOR_ROLE) {
        _accrueFees();
        uint256 total = totalValue();
        // slither-disable-next-line incorrect-equality
        if (total == 0) return;
        // First pass: withdraw from over-allocated strategies
        for (uint256 i = 0; i < strategies.length; i++) {
            if (!strategies[i].active) continue;
            address strat = strategies[i].strategy;
            // slither-disable-next-line calls-loop
            uint256 currentValue = IStrategy(strat).totalValue();
            uint256 targetValue = (total * strategies[i].targetBps) / BPS;
            if (currentValue > targetValue) {
                uint256 excess = currentValue - targetValue;
                // slither-disable-next-line calls-loop
                try IStrategy(strat).withdraw(excess) {} catch {
                    emit RebalanceWithdrawFailed(strat, excess);
                }
            }
        }
        // Pass 1 withdrawals change strategy values, so using the stale `total`
        // for pass 2 would systematically over-allocate to under-funded strategies.
        total = totalValue();
        // Second pass: deposit to under-allocated strategies
        uint256 reserve = reserveBalance();
        uint256 targetReserveAmt = (total * reserveBps) / BPS;
        uint256 available = reserve > targetReserveAmt ? reserve - targetReserveAmt : 0;
        for (uint256 i = 0; i < strategies.length && available > 0; i++) {
            if (!strategies[i].active) continue;
            address strat = strategies[i].strategy;
            // slither-disable-next-line calls-loop
            uint256 currentValue = IStrategy(strat).totalValue();
            uint256 targetValue = (total * strategies[i].targetBps) / BPS;
            if (currentValue < targetValue) {
                uint256 deficit = targetValue - currentValue;
                uint256 toDeposit = deficit < available ? deficit : available;
                asset.forceApprove(strat, toDeposit);
                // slither-disable-next-line calls-loop
                try IStrategy(strat).deposit(toDeposit) returns (uint256 deposited) {
                    available -= deposited;
                    // Clear temporary allowance after use (defense in depth).
                    asset.forceApprove(strat, 0);
                } catch {
                    emit RebalanceDepositFailed(strat, toDeposit);
                    asset.forceApprove(strat, 0); // Clear approval on failure
                }
            }
        }
        lastRecordedValue = totalValue();
        emit Rebalanced(lastRecordedValue);
    }
    // ═══════════════════════════════════════════════════════════════════════
    // EMERGENCY
    // ═══════════════════════════════════════════════════════════════════════
    /**
     * @notice Emergency withdraw all from all strategies
     * @dev Loops over bounded, admin-controlled strategies array
     */
    function emergencyWithdrawAll() external onlyRole(GUARDIAN_ROLE) {
        for (uint256 i = 0; i < strategies.length; i++) {
            if (strategies[i].active) {
                address strategyAddr = strategies[i].strategy;
                // slither-disable-next-line calls-loop
                try IStrategy(strategyAddr).withdrawAll() {} 
                catch (bytes memory reason) {
                    emit StrategyWithdrawFailed(strategyAddr, 0, reason);
                }
            }
        }
        // on next _accrueFees() call after emergency withdrawal
        lastRecordedValue = totalValue();
        emit EmergencyWithdraw(reserveBalance());
    }
    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
    // ═══════════════════════════════════════════════════════════════════════
    // ADMIN
    // ═══════════════════════════════════════════════════════════════════════
    /**
     * @notice Update fee configuration
     */
    event FeeConfigUpdated(uint256 performanceFeeBps, address feeRecipient);
    /// @notice Fee config changes require timelock delay via TimelockGoverned
    function setFeeConfig(
        uint256 _performanceFeeBps,
        address _feeRecipient
    ) external onlyTimelock {
        if (_performanceFeeBps > 5000) revert FeeTooHigh();
        if (_feeRecipient == address(0)) revert InvalidRecipient();
        _accrueFees(); // Accrue with old rate first
        fees.performanceFeeBps = _performanceFeeBps;
        fees.feeRecipient = _feeRecipient;
        emit FeeConfigUpdated(_performanceFeeBps, _feeRecipient);
    }
    event ReserveBpsUpdated(uint256 oldReserveBps, uint256 newReserveBps);
    /**
     * @notice Update reserve percentage
     */
    function setReserveBps(uint256 _reserveBps) external onlyTimelock {
        if (_reserveBps > 3000) revert ReserveTooHigh();
        uint256 oldBps = reserveBps;
        reserveBps = _reserveBps;
        emit ReserveBpsUpdated(oldBps, _reserveBps);
    }
    event MinAutoAllocateUpdated(uint256 oldAmount, uint256 newAmount);
    /**
     * @notice Update minimum auto-allocate amount
     */
    function setMinAutoAllocate(uint256 _minAmount) external onlyTimelock {
        if (_minAmount == 0) revert ZeroAmount();
        uint256 oldAmount = minAutoAllocateAmount;
        minAutoAllocateAmount = _minAmount;
        emit MinAutoAllocateUpdated(oldAmount, _minAmount);
    }
    /**
     * @notice Update vault address
     */
    /// @notice Vault address changes require timelock delay via TimelockGoverned
    function setVault(address _vault) external onlyTimelock {
        if (_vault == address(0)) revert ZeroAddress();
        _revokeRole(VAULT_ROLE, vault);
        vault = _vault;
        _grantRole(VAULT_ROLE, _vault);
    }
    /**
     * @notice Emergency token recovery (not the primary asset)
     */
    /// @notice Token recovery requires timelock delay via TimelockGoverned
    function recoverToken(address token, uint256 amount) external onlyTimelock {
        if (token == address(asset)) revert CannotRecoverAsset();
        IERC20(token).safeTransfer(msg.sender, amount);
    }
    /**
     * @notice UUPS upgrade authorization
     */
    /// @notice Only MintedTimelockController can authorize upgrades (48h delay enforced)
    function _authorizeUpgrade(address) internal override onlyTimelock {}
}
