// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IStrategy.sol";

/**
 * @title TreasuryV2
 * @notice Auto-allocating treasury that distributes deposits across strategies on mint
 * @dev When USDC comes in, it's automatically split according to target allocations
 *
 * Default Allocation:
 *   Pendle Multi-Pool:  40% (11.7% APY)
 *   Morpho Loop:        30% (11.5% APY)
 *   Sky sUSDS:          20% (8% APY)
 *   USDC Reserve:       10% (0% APY)
 *   ────────────────────────────────────
 *   Blended:            ~10% gross APY
 *
 * Revenue Split:
 *   smUSD Holders:      80%
 *   Protocol:           20%
 */
contract TreasuryV2 is
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════

    uint256 public constant BPS = 10000;
    uint256 public constant MAX_STRATEGIES = 10;

    // ═══════════════════════════════════════════════════════════════════════
    // ROLES
    // ═══════════════════════════════════════════════════════════════════════

    bytes32 public constant ALLOCATOR_ROLE = keccak256("ALLOCATOR_ROLE");
    bytes32 public constant STRATEGIST_ROLE = keccak256("STRATEGIST_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");

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
        uint256 performanceFeeBps;  // Fee on yield (default 2000 = 20%)
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

    /// @dev Storage gap for future upgrades
    uint256[40] private __gap;

    // ═══════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event Deposited(address indexed from, uint256 amount, uint256[] allocations);
    event Withdrawn(address indexed to, uint256 amount);
    event StrategyAdded(address indexed strategy, uint256 targetBps);
    event StrategyRemoved(address indexed strategy);
    event StrategyUpdated(address indexed strategy, uint256 newTargetBps);
    event FeesAccrued(uint256 yield_, uint256 protocolFee);
    event FeesClaimed(address indexed recipient, uint256 amount);
    event Rebalanced(uint256 totalValue);
    event EmergencyWithdraw(uint256 amount);

    // ═══════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error ZeroAddress();
    error ZeroAmount();
    error StrategyExists();
    error StrategyNotFound();
    error AllocationExceedsLimit();
    error TotalAllocationInvalid();
    error InsufficientBalance();
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
        address _feeRecipient
    ) external initializer {
        if (_asset == address(0) || _vault == address(0) || _admin == address(0)) {
            revert ZeroAddress();
        }

        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        asset = IERC20(_asset);
        vault = _vault;

        // Default fee configuration
        fees = ProtocolFees({
            performanceFeeBps: 2000,  // 20% of yield
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

        lastFeeAccrual = block.timestamp;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Total value across reserve + all strategies
     */
    function totalValue() public view returns (uint256) {
        uint256 total = reserveBalance();

        for (uint256 i = 0; i < strategies.length; i++) {
            if (strategies[i].active) {
                total += IStrategy(strategies[i].strategy).totalValue();
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
                uint256 stratValue = IStrategy(strategies[i].strategy).totalValue();
                currentBps[i] = (stratValue * BPS) / total;
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

        // FIX H-04: Update lastRecordedValue AFTER deposit
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
            uint256 withdrawn = _withdrawFromStrategies(needed);

            actualAmount = reserve + withdrawn;
            if (actualAmount > amount) actualAmount = amount;

            // FIX H-01: Revert if we can't fulfill the full requested amount
            // Silent partial withdrawals can leave protocol in inconsistent state
            if (actualAmount < amount) {
                revert("INSUFFICIENT_LIQUIDITY");
            }

            asset.safeTransfer(vault, actualAmount);
        }

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
     */
    function deposit(address from, uint256 amount) external nonReentrant whenNotPaused onlyRole(VAULT_ROLE) {
        if (amount == 0) revert ZeroAmount();

        _accrueFees();

        asset.safeTransferFrom(from, address(this), amount);

        // Auto-allocate if above minimum
        if (amount >= minAutoAllocateAmount) {
            _autoAllocate(amount);
        }

        // FIX H-04: Update lastRecordedValue AFTER deposit so the new deposit
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
        require(available >= amount, "INSUFFICIENT_RESERVES");

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

        // FIX C-01: Track shares approved (not deposited) for remainder calculation.
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

                try IStrategy(strat).deposit(share) returns (uint256 deposited) {
                    allocations[i] = deposited;
                    // FIX H-04: Clear approval after successful deposit to prevent dangling approvals
                    asset.forceApprove(strat, 0);
                } catch {
                    // Strategy deposit failed, keep in reserve
                    allocations[i] = 0;
                    asset.forceApprove(strat, 0);
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
        uint256 totalStratValue = 0;
        uint256 lastActiveIdx = type(uint256).max;
        for (uint256 i = 0; i < strategies.length; i++) {
            if (strategies[i].active) {
                totalStratValue += IStrategy(strategies[i].strategy).totalValue();
                lastActiveIdx = i;
            }
        }

        if (totalStratValue == 0) return 0;

        // FIX M-07: Withdraw proportionally, give last strategy the remainder
        // to avoid rounding dust leaving funds stranded across strategies.
        for (uint256 i = 0; i < strategies.length && remaining > 0; i++) {
            if (!strategies[i].active) continue;

            address strat = strategies[i].strategy;
            uint256 stratValue = IStrategy(strat).totalValue();

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
                try IStrategy(strat).withdraw(toWithdraw) returns (uint256 withdrawn) {
                    totalWithdrawn += withdrawn;
                    remaining = remaining > withdrawn ? remaining - withdrawn : 0;
                } catch {
                    // Strategy withdrawal failed, try next
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
     */
    function _accrueFees() internal {
        uint256 currentValue = totalValue();

        if (currentValue > lastRecordedValue) {
            uint256 yield_ = currentValue - lastRecordedValue;
            uint256 protocolFee = (yield_ * fees.performanceFeeBps) / BPS;

            fees.accruedFees += protocolFee;

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
        if (toClaim == 0) return;

        // FIX I-05: Only deduct what is actually sent, not the full claim amount.
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

        // FIX H-03: Do NOT grant unlimited approval at add-time.
        // Approvals are granted per-operation in _autoAllocate and rebalance.

        emit StrategyAdded(strategy, targetBps);
    }

    /**
     * @notice Remove a strategy (withdraws all funds first)
     */
    function removeStrategy(address strategy) external onlyRole(STRATEGIST_ROLE) {
        if (!isStrategy[strategy]) revert StrategyNotFound();

        uint256 idx = strategyIndex[strategy];

        // Withdraw all from strategy
        if (strategies[idx].active) {
            try IStrategy(strategy).withdrawAll() {} catch {}
        }

        // Deactivate (don't delete to preserve indices)
        strategies[idx].active = false;
        strategies[idx].targetBps = 0;
        isStrategy[strategy] = false;
        // FIX M-09: Clean up stale strategyIndex mapping
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
    // REBALANCING
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Rebalance all strategies to target allocations
     */
    function rebalance() external nonReentrant onlyRole(ALLOCATOR_ROLE) {
        _accrueFees();

        uint256 total = totalValue();
        if (total == 0) return;

        // First pass: withdraw from over-allocated strategies
        for (uint256 i = 0; i < strategies.length; i++) {
            if (!strategies[i].active) continue;

            address strat = strategies[i].strategy;
            uint256 currentValue = IStrategy(strat).totalValue();
            uint256 targetValue = (total * strategies[i].targetBps) / BPS;

            if (currentValue > targetValue) {
                uint256 excess = currentValue - targetValue;
                try IStrategy(strat).withdraw(excess) {} catch {}
            }
        }

        // Second pass: deposit to under-allocated strategies
        uint256 reserve = reserveBalance();
        uint256 targetReserveAmt = (total * reserveBps) / BPS;
        uint256 available = reserve > targetReserveAmt ? reserve - targetReserveAmt : 0;

        for (uint256 i = 0; i < strategies.length && available > 0; i++) {
            if (!strategies[i].active) continue;

            address strat = strategies[i].strategy;
            uint256 currentValue = IStrategy(strat).totalValue();
            uint256 targetValue = (total * strategies[i].targetBps) / BPS;

            if (currentValue < targetValue) {
                uint256 deficit = targetValue - currentValue;
                uint256 toDeposit = deficit < available ? deficit : available;

                asset.forceApprove(strat, toDeposit);
                try IStrategy(strat).deposit(toDeposit) returns (uint256 deposited) {
                    available -= deposited;
                } catch {}
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
     */
    function emergencyWithdrawAll() external onlyRole(GUARDIAN_ROLE) {
        for (uint256 i = 0; i < strategies.length; i++) {
            if (strategies[i].active) {
                try IStrategy(strategies[i].strategy).withdrawAll() {} catch {}
            }
        }

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
    function setFeeConfig(
        uint256 _performanceFeeBps,
        address _feeRecipient
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_performanceFeeBps <= 5000, "Fee too high"); // Max 50%
        require(_feeRecipient != address(0), "Invalid recipient");

        _accrueFees(); // Accrue with old rate first

        fees.performanceFeeBps = _performanceFeeBps;
        fees.feeRecipient = _feeRecipient;
    }

    /**
     * @notice Update reserve percentage
     */
    function setReserveBps(uint256 _reserveBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_reserveBps <= 3000, "Reserve too high"); // Max 30%
        reserveBps = _reserveBps;
    }

    /**
     * @notice Update minimum auto-allocate amount
     */
    function setMinAutoAllocate(uint256 _minAmount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minAutoAllocateAmount = _minAmount;
    }

    /**
     * @notice Update vault address
     */
    function setVault(address _vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_vault == address(0)) revert ZeroAddress();

        _revokeRole(VAULT_ROLE, vault);
        vault = _vault;
        _grantRole(VAULT_ROLE, _vault);
    }

    /**
     * @notice Emergency token recovery (not the primary asset)
     */
    function recoverToken(address token, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(token != address(asset), "CANNOT_RECOVER_ASSET");
        IERC20(token).safeTransfer(msg.sender, amount);
    }

    /**
     * @notice UUPS upgrade authorization
     */
    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
