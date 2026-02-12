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
 * Pendle Multi-Pool: 40% (11.7% APY)
 * Morpho Loop: 30% (11.5% APY)
 * Sky sUSDS: 20% (8% APY)
 * USDC Reserve: 10% (0% APY)
 * ────────────────────────────────────
 * Blended: ~10% gross APY
 *
 * Revenue Split:
 * smUSD Holders: 60% (~6% net APY target)
 * Protocol: 40% (spread above 6%)
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
 
 // Minimum time between fee accruals to prevent flash loan manipulation
 uint256 public constant MIN_ACCRUAL_INTERVAL = 1 hours;

 // Maximum reasonable yield per accrual interval (5%).
 // Value jumps above this threshold are likely strategy recovery, not yield.
 uint256 public constant MAX_YIELD_PER_ACCRUAL_BPS = 2000;

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
 address strategy; // Strategy contract address
 uint256 targetBps; // Target allocation (basis points)
 uint256 minBps; // Minimum allocation
 uint256 maxBps; // Maximum allocation
 bool active; // Is strategy active
 bool autoAllocate; // Auto-allocate on deposit
 }

 struct ProtocolFees {
 uint256 performanceFeeBps; // Fee on yield (default 4000 = 40%)
 uint256 accruedFees; // Accumulated protocol fees
 address feeRecipient; // Where fees go
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

 /// @notice Pending upgrade implementation (timelock)
 address public pendingImplementation;

 /// @notice Timestamp when upgrade was requested
 uint256 public upgradeRequestTime;

 /// @notice Timelock delay for upgrades (48 hours)
 uint256 public constant UPGRADE_DELAY = 48 hours;

 /// @notice Pending vault address (timelock)
 address public pendingVault;

 /// @notice Timestamp when vault change was requested
 uint256 public vaultChangeRequestTime;

 // ═══════════════════════════════════════════════════════════════════════
 // Additional timelocked admin operations
 // ═══════════════════════════════════════════════════════════════════════

 /// @notice Pending strategy addition
 struct PendingStrategy {
 address strategy;
 uint256 targetBps;
 uint256 minBps;
 uint256 maxBps;
 bool autoAllocate;
 uint256 requestTime;
 }
 PendingStrategy public pendingAddStrategy;
 address public pendingRemoveStrategy;
 uint256 public pendingRemoveStrategyTime;

 /// @notice Pending fee config
 uint256 public pendingFeeConfigBps;
 address public pendingFeeConfigRecipient;
 uint256 public pendingFeeConfigTime;

 /// @notice Pending reserve BPS
 uint256 public pendingReserveBps;
 uint256 public pendingReserveBpsTime;
 bool public pendingReserveBpsSet;

 event StrategyAddRequested(address indexed strategy, uint256 targetBps, uint256 readyAt);
 event StrategyAddCancelled(address indexed strategy);
 event StrategyRemoveRequested(address indexed strategy, uint256 readyAt);
 event StrategyRemoveCancelled(address indexed strategy);
 event FeeConfigChangeRequested(uint256 feeBps, address recipient, uint256 readyAt);
 event FeeConfigChangeCancelled();
 event ReserveBpsChangeRequested(uint256 bps, uint256 readyAt);
 event ReserveBpsChangeCancelled(uint256 bps);

 // ═══════════════════════════════════════════════════════════════════════
 // Timelocked strategy update
 // ═══════════════════════════════════════════════════════════════════════

 /// @notice Pending strategy parameter update (timelocked)
 struct PendingStrategyUpdate {
 address strategy; // slot +0 (packed with bool below? no, bool in +5)
 uint256 targetBps; // slot +1
 uint256 minBps; // slot +2
 uint256 maxBps; // slot +3
 bool autoAllocate; // slot +4 (packs into 1 slot)
 uint256 requestTime; // slot +5
 }
 PendingStrategyUpdate public pendingStrategyUpdate; // 6 slots

 event StrategyUpdateRequested(address indexed strategy, uint256 targetBps, uint256 readyAt);
 event StrategyUpdateCancelled(address indexed strategy);

 // ═══════════════════════════════════════════════════════════════════════
 // STORAGE GAP — fully documented slot layout
 // Slot occupancy before __gap:
 // 1: asset (IERC20)
 // 2: vault (address)
 // 3: strategies (StrategyConfig[] pointer)
 // 4: strategyIndex (mapping pointer)
 // 5: isStrategy (mapping pointer)
 // 6: reserveBps (uint256)
 // 7-9: fees (ProtocolFees — 3 slots)
 // 10: lastRecordedValue
 // 11: lastFeeAccrual
 // 12: minAutoAllocateAmount
 // 13: pendingImplementation
 // 14: upgradeRequestTime
 // 15: pendingVault
 // 16: vaultChangeRequestTime
 // 17-22: pendingAddStrategy (PendingStrategy — 6 slots)
 // 23: pendingRemoveStrategy
 // 24: pendingRemoveStrategyTime
 // 25: pendingFeeConfigBps
 // 26: pendingFeeConfigRecipient
 // 27: pendingFeeConfigTime
 // 28: pendingReserveBps
 // 29: pendingReserveBpsTime
 // 30: pendingReserveBpsSet
 // 31-36: pendingStrategyUpdate (PendingStrategyUpdate — 6 slots)
 // 37: peakRecordedValue
 // 38-56: __gap[19]
 // Total: 56 slots reserved
 // ═══════════════════════════════════════════════════════════════════════

 /// @notice High-water mark for totalValue.
 /// Used to detect strategy recovery: if currentValue rebounds but stays
 /// below peakRecordedValue, it's principal recovery, not yield.
 uint256 public peakRecordedValue;

 uint256[19] private __gap;

 // ═══════════════════════════════════════════════════════════════════════
 // EVENTS
 // ═══════════════════════════════════════════════════════════════════════

 event Deposited(address indexed from, uint256 amount, uint256[] allocations);
 event Withdrawn(address indexed to, uint256 amount);
 event StrategyAdded(address indexed strategy, uint256 targetBps);
 event StrategyRemoved(address indexed strategy);
 event StrategyUpdated(address indexed strategy, uint256 newTargetBps);
 event StrategyWithdrawn(address indexed strategy, uint256 amount); // Event for withdrawal tracking
 event FeesAccrued(uint256 yield_, uint256 protocolFee);
 event FeesClaimed(address indexed recipient, uint256 amount);
 event Rebalanced(uint256 totalValue);
 event EmergencyWithdraw(uint256 amount);
 /// Emit events on strategy failures for monitoring
 event StrategyDepositFailed(address indexed strategy, uint256 amount, bytes reason);
 event StrategyWithdrawFailed(address indexed strategy, uint256 amount, bytes reason);
 /// Events for rebalance failures
 event RebalanceWithdrawFailed(address indexed strategy, uint256 amount);
 event RebalanceDepositFailed(address indexed strategy, uint256 amount);
 /// Upgrade timelock events
 event UpgradeRequested(address indexed newImplementation, uint256 readyAt);
 event UpgradeCancelled(address indexed cancelledImplementation);
 /// Vault change timelock events
 event VaultChangeRequested(address indexed newVault, uint256 readyAt);
 event VaultChangeCancelled(address indexed cancelledVault);
 event VaultChanged(address indexed oldVault, address indexed newVault);
 /// @dev Emitted when strategy force-deactivated due to failed withdrawal
 event StrategyForceDeactivated(address indexed strategy, uint256 strandedValue, bytes reason);
 /// Added event for fee config changes
 event FeeConfigUpdated(uint256 performanceFeeBps, address feeRecipient);

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
 if (_asset == address(0) || _vault == address(0) || _admin == address(0) || _feeRecipient == address(0)) {
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
 performanceFeeBps: 4000, // 40% of yield → stakers get ~6% on 10% gross
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

 /// @dev Event for strategy totalValue() failures
 event StrategyValueQueryFailed(address indexed strategy);
 /// @dev Emitted when a sudden value jump suggests strategy recovery, not yield
 event StrategyRecoveryDetected(uint256 previousValue, uint256 currentValue, uint256 increase);

 /**
 * @notice Total value across reserve + all strategies
 * @dev Loops over bounded, admin-controlled strategies array (max ~10 strategies)
 * Uses try/catch so a reverting strategy doesn't DoS
 * all deposits, withdrawals, and redemptions system-wide.
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
 // Wrap in try/catch so a reverting strategy
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
 * @dev Uses peakRecordedValue to exclude recovery from fee calc
 */
 function _calculatePendingFees() internal view returns (uint256) {
 uint256 currentValue = totalValue();
 if (currentValue <= lastRecordedValue) return fees.accruedFees;

 // Check for spike (recovery detection)
 uint256 increase = currentValue - lastRecordedValue;
 uint256 maxReasonableYield = (lastRecordedValue * MAX_YIELD_PER_ACCRUAL_BPS) / BPS;
 if (increase > maxReasonableYield && lastRecordedValue > 0) {
 return fees.accruedFees; // Spike — no pending fees
 }

 // High-water mark: only tax value above peak
 if (peakRecordedValue > 0 && currentValue <= peakRecordedValue) {
 return fees.accruedFees; // Recovery — no pending fees
 }

 uint256 taxableYield;
 if (peakRecordedValue > 0 && lastRecordedValue < peakRecordedValue) {
 taxableYield = currentValue - peakRecordedValue;
 } else {
 taxableYield = increase;
 }

 uint256 newFees = (taxableYield * fees.performanceFeeBps) / BPS;
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

 // Update lastRecordedValue AFTER deposit
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

 // Revert if we can't fulfill the full requested amount
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

 // Update lastRecordedValue AFTER deposit so the new deposit
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

 // Update lastRecordedValue so the withdrawal isn't
 // mistaken for yield on the next _accrueFees() call.
 lastRecordedValue = totalValue();

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

 // Track shares approved (not deposited) for remainder calculation.
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
 // Clear approval after successful deposit to prevent dangling approvals
 asset.forceApprove(strat, 0);
 } catch (bytes memory reason) {
 // Emit event on failure for monitoring instead of silent catch
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

 // Withdraw proportionally, give last strategy the remainder
 // to avoid rounding dust leaving funds stranded across strategies.
 for (uint256 i = 0; i < strategies.length && remaining > 0; i++) {
 if (!strategies[i].active) continue;

 address strat = strategies[i].strategy;
 // slither-disable-next-line calls-loop
 // Use try/catch for strategy value query
 uint256 stratValue;
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
 // Emit event on failure for monitoring instead of silent catch
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
 * Added minimum time interval between accruals to prevent flash loan manipulation.
 * Attacker cannot inflate totalValue() temporarily and immediately accrue fees.
 */
 function _accrueFees() internal {
 // Skip fee accrual if called too soon (prevents flash loan manipulation)
 if (block.timestamp < lastFeeAccrual + MIN_ACCRUAL_INTERVAL) {
 return;
 }
 
 uint256 currentValue = totalValue();

 // Detect strategy recovery using high-water mark.
 // Two complementary checks:
 // 1. If currentValue rebounds but stays <= peakRecordedValue, the increase
 // is principal recovery, not yield — skip fee accrual entirely.
 // 2. If currentValue exceeds peakRecordedValue, only charge fees on the
 // portion above the peak (genuine new yield).
 // This fixes the original guard that only caught jumps > 20% of lastRecordedValue,
 // missing smaller recoveries from strategies with low TVL share.
 if (currentValue > lastRecordedValue) {
 uint256 increase = currentValue - lastRecordedValue;

 // Check 1: Threshold-based spike detection (catches large jumps from
 // strategy outage recovery even if above peak due to concurrent deposits)
 uint256 maxReasonableYield = (lastRecordedValue * MAX_YIELD_PER_ACCRUAL_BPS) / BPS;
 if (increase > maxReasonableYield && lastRecordedValue > 0) {
 // Large spike — likely strategy recovery, not yield
 emit StrategyRecoveryDetected(lastRecordedValue, currentValue, increase);
 lastRecordedValue = currentValue;
 if (currentValue > peakRecordedValue) {
 peakRecordedValue = currentValue;
 }
 lastFeeAccrual = block.timestamp;
 return;
 }

 // Check 2: High-water mark — only charge fees on value above prior peak.
 // If currentValue <= peakRecordedValue, the entire increase is recovery.
 if (peakRecordedValue > 0 && currentValue <= peakRecordedValue) {
 // Entire increase is recovery of previously-seen value — no fees
 emit StrategyRecoveryDetected(lastRecordedValue, currentValue, increase);
 lastRecordedValue = currentValue;
 lastFeeAccrual = block.timestamp;
 return;
 }

 // Genuine yield: only the portion above the peak is taxable
 uint256 taxableYield;
 if (peakRecordedValue > 0 && lastRecordedValue < peakRecordedValue) {
 // Part of the increase is recovery (up to peak), rest is new yield
 taxableYield = currentValue - peakRecordedValue;
 } else {
 // No recovery component — all increase is yield
 taxableYield = increase;
 }

 if (taxableYield > 0) {
 uint256 protocolFee = (taxableYield * fees.performanceFeeBps) / BPS;
 fees.accruedFees += protocolFee;
 emit FeesAccrued(taxableYield, protocolFee);
 }
 }

 lastRecordedValue = currentValue;
 if (currentValue > peakRecordedValue) {
 peakRecordedValue = currentValue;
 }
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

 // Only deduct what is actually sent, not the full claim amount.
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
 * @notice Request adding a new strategy (48h timelock)
 */
 function requestAddStrategy(
 address strategy,
 uint256 targetBps,
 uint256 minBps,
 uint256 maxBps,
 bool autoAllocate
 ) external onlyRole(STRATEGIST_ROLE) {
 if (strategy == address(0)) revert ZeroAddress();
 if (isStrategy[strategy]) revert StrategyExists();
 // Prevent overwriting pending request (bait-and-switch)
 require(pendingAddStrategy.strategy == address(0), "ADD_ALREADY_PENDING");
 // Count active strategies so removed ones don't permanently consume slots
 uint256 activeCount = 0;
 for (uint256 i = 0; i < strategies.length; i++) {
 if (strategies[i].active) activeCount++;
 }
 if (activeCount >= MAX_STRATEGIES) revert MaxStrategiesReached();
 if (targetBps > maxBps || minBps > targetBps) revert AllocationExceedsLimit();

 pendingAddStrategy = PendingStrategy({
 strategy: strategy,
 targetBps: targetBps,
 minBps: minBps,
 maxBps: maxBps,
 autoAllocate: autoAllocate,
 requestTime: block.timestamp
 });
 emit StrategyAddRequested(strategy, targetBps, block.timestamp + UPGRADE_DELAY);
 }

 function cancelAddStrategy() external onlyRole(STRATEGIST_ROLE) {
 address cancelled = pendingAddStrategy.strategy;
 delete pendingAddStrategy;
 emit StrategyAddCancelled(cancelled);
 }

 function executeAddStrategy() external onlyRole(STRATEGIST_ROLE) {
 PendingStrategy memory p = pendingAddStrategy;
 require(p.strategy != address(0), "NO_PENDING");
 require(block.timestamp >= p.requestTime + UPGRADE_DELAY, "TIMELOCK_ACTIVE");
 // Re-validate
 if (isStrategy[p.strategy]) revert StrategyExists();
 // Count active strategies so removed ones don't permanently consume slots
 uint256 activeCount = 0;
 for (uint256 j = 0; j < strategies.length; j++) {
 if (strategies[j].active) activeCount++;
 }
 if (activeCount >= MAX_STRATEGIES) revert MaxStrategiesReached();

 // Validate total allocation
 uint256 totalTarget = p.targetBps + reserveBps;
 for (uint256 i = 0; i < strategies.length; i++) {
 if (strategies[i].active) {
 totalTarget += strategies[i].targetBps;
 }
 }
 if (totalTarget > BPS) revert TotalAllocationInvalid();

 strategies.push(StrategyConfig({
 strategy: p.strategy,
 targetBps: p.targetBps,
 minBps: p.minBps,
 maxBps: p.maxBps,
 active: true,
 autoAllocate: p.autoAllocate
 }));

 strategyIndex[p.strategy] = strategies.length - 1;
 isStrategy[p.strategy] = true;

 delete pendingAddStrategy;
 emit StrategyAdded(p.strategy, p.targetBps);
 }

 /**
 * @notice Request removing a strategy (48h timelock)
 */
 function requestRemoveStrategy(address strategy) external onlyRole(STRATEGIST_ROLE) {
 if (!isStrategy[strategy]) revert StrategyNotFound();
 // Prevent overwriting pending request
 require(pendingRemoveStrategy == address(0), "REMOVE_ALREADY_PENDING");
 pendingRemoveStrategy = strategy;
 pendingRemoveStrategyTime = block.timestamp;
 emit StrategyRemoveRequested(strategy, block.timestamp + UPGRADE_DELAY);
 }

 function cancelRemoveStrategy() external onlyRole(STRATEGIST_ROLE) {
 address cancelled = pendingRemoveStrategy;
 pendingRemoveStrategy = address(0);
 pendingRemoveStrategyTime = 0;
 emit StrategyRemoveCancelled(cancelled);
 }

 function executeRemoveStrategy() external onlyRole(STRATEGIST_ROLE) {
 address strategy = pendingRemoveStrategy;
 require(strategy != address(0), "NO_PENDING");
 require(block.timestamp >= pendingRemoveStrategyTime + UPGRADE_DELAY, "TIMELOCK_ACTIVE");
 if (!isStrategy[strategy]) revert StrategyNotFound();

 pendingRemoveStrategy = address(0);
 pendingRemoveStrategyTime = 0;

 uint256 idx = strategyIndex[strategy];

 // Try to withdraw, but don't let failure permanently block removal.
 if (strategies[idx].active) {
 uint256 stratValue;
 try IStrategy(strategy).totalValue() returns (uint256 val) {
 stratValue = val;
 } catch {
 stratValue = 0;
 }

 if (stratValue > 0) {
 try IStrategy(strategy).withdrawAll() returns (uint256 withdrawn) {
 uint256 minWithdrawn = (stratValue * 95) / 100;
 if (withdrawn >= minWithdrawn) {
 emit StrategyWithdrawn(strategy, withdrawn);
 } else {
 emit StrategyForceDeactivated(strategy, stratValue - withdrawn, "");
 }
 } catch (bytes memory reason) {
 emit StrategyForceDeactivated(strategy, stratValue, reason);
 }
 }
 }

 strategies[idx].active = false;
 strategies[idx].targetBps = 0;
 isStrategy[strategy] = false;
 delete strategyIndex[strategy];

 asset.forceApprove(strategy, 0);

 emit StrategyRemoved(strategy);
 }

 /**
 * @notice Request strategy allocation update (timelocked)
 * @dev Prevents ALLOCATOR_ROLE from instantly redirecting funds to malicious strategy
 */

 function requestUpdateStrategy(
 address strategy,
 uint256 targetBps,
 uint256 minBps,
 uint256 maxBps,
 bool autoAllocate
 ) external onlyRole(ALLOCATOR_ROLE) {
 if (!isStrategy[strategy]) revert StrategyNotFound();
 require(pendingStrategyUpdate.strategy == address(0), "UPDATE_ALREADY_PENDING");
 pendingStrategyUpdate = PendingStrategyUpdate({
 strategy: strategy,
 targetBps: targetBps,
 minBps: minBps,
 maxBps: maxBps,
 autoAllocate: autoAllocate,
 requestTime: block.timestamp
 });
 emit StrategyUpdateRequested(strategy, targetBps, block.timestamp + UPGRADE_DELAY);
 }

 function cancelUpdateStrategy() external onlyRole(ALLOCATOR_ROLE) {
 address strategy = pendingStrategyUpdate.strategy;
 delete pendingStrategyUpdate;
 emit StrategyUpdateCancelled(strategy);
 }

 function executeUpdateStrategy() external onlyRole(ALLOCATOR_ROLE) {
 PendingStrategyUpdate memory pending = pendingStrategyUpdate;
 require(pending.strategy != address(0), "NO_PENDING");
 require(block.timestamp >= pending.requestTime + UPGRADE_DELAY, "TIMELOCK_ACTIVE");
 if (!isStrategy[pending.strategy]) revert StrategyNotFound();

 uint256 idx = strategyIndex[pending.strategy];

 // Validate new allocation
 uint256 totalTarget = pending.targetBps + reserveBps;
 for (uint256 i = 0; i < strategies.length; i++) {
 if (i != idx && strategies[i].active) {
 totalTarget += strategies[i].targetBps;
 }
 }
 if (totalTarget > BPS) revert TotalAllocationInvalid();

 strategies[idx].targetBps = pending.targetBps;
 strategies[idx].minBps = pending.minBps;
 strategies[idx].maxBps = pending.maxBps;
 strategies[idx].autoAllocate = pending.autoAllocate;

 delete pendingStrategyUpdate;
 emit StrategyUpdated(pending.strategy, pending.targetBps);
 }

 /**
 * @notice Update strategy allocation
 * @dev Restricted to DEFAULT_ADMIN_ROLE for emergency use only.
 * Normal updates should use requestUpdateStrategy/executeUpdateStrategy.
 */
 function updateStrategy(
 address strategy,
 uint256 targetBps,
 uint256 minBps,
 uint256 maxBps,
 bool autoAllocate
 ) external onlyRole(DEFAULT_ADMIN_ROLE) {
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
 // slither-disable-next-line incorrect-equality
 if (total == 0) return;

 // First pass: withdraw from over-allocated strategies
 for (uint256 i = 0; i < strategies.length; i++) {
 if (!strategies[i].active) continue;

 address strat = strategies[i].strategy;
 // slither-disable-next-line calls-loop
 // try/catch on totalValue() so a broken strategy doesn't DoS rebalance
 uint256 currentValue;
 try IStrategy(strat).totalValue() returns (uint256 val) {
 currentValue = val;
 } catch {
 emit RebalanceWithdrawFailed(strat, 0);
 continue; // Skip broken strategy
 }
 uint256 targetValue = (total * strategies[i].targetBps) / BPS;

 if (currentValue > targetValue) {
 uint256 excess = currentValue - targetValue;
 // slither-disable-next-line calls-loop
 // Add error event instead of silent swallow
 try IStrategy(strat).withdraw(excess) {} catch {
 emit RebalanceWithdrawFailed(strat, excess);
 }
 }
 }

 // Re-read totalValue() after withdrawals.
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
 // Wrap in try/catch consistent with pass 1 to prevent
 // a single broken strategy from DoSing all rebalancing
 uint256 currentValue;
 // slither-disable-next-line calls-loop
 try IStrategy(strat).totalValue() returns (uint256 val) {
 currentValue = val;
 } catch {
 // Skip broken strategy — cannot determine its current value
 continue;
 }
 uint256 targetValue = (total * strategies[i].targetBps) / BPS;

 if (currentValue < targetValue) {
 uint256 deficit = targetValue - currentValue;
 uint256 toDeposit = deficit < available ? deficit : available;

 asset.forceApprove(strat, toDeposit);
 // slither-disable-next-line calls-loop
 // Add error event instead of silent swallow
 try IStrategy(strat).deposit(toDeposit) returns (uint256 deposited) {
 available -= deposited;
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
 * Emits StrategyWithdrawFailed on failures instead of silent catch
 */
 function emergencyWithdrawAll() external onlyRole(GUARDIAN_ROLE) {
 for (uint256 i = 0; i < strategies.length; i++) {
 if (strategies[i].active) {
 address strategyAddr = strategies[i].strategy;
 // slither-disable-next-line calls-loop
 try IStrategy(strategyAddr).withdrawAll() {} 
 catch (bytes memory reason) {
 // Emit failure event instead of silent catch
 emit StrategyWithdrawFailed(strategyAddr, 0, reason);
 }
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
 * @notice Request fee config change (48h timelock)
 */
 function requestFeeConfig(
 uint256 _performanceFeeBps,
 address _feeRecipient
 ) external onlyRole(DEFAULT_ADMIN_ROLE) {
 require(_performanceFeeBps <= 5000, "Fee too high");
 require(_feeRecipient != address(0), "Invalid recipient");
 pendingFeeConfigBps = _performanceFeeBps;
 pendingFeeConfigRecipient = _feeRecipient;
 pendingFeeConfigTime = block.timestamp;
 emit FeeConfigChangeRequested(_performanceFeeBps, _feeRecipient, block.timestamp + UPGRADE_DELAY);
 }

 function cancelFeeConfig() external onlyRole(DEFAULT_ADMIN_ROLE) {
 pendingFeeConfigBps = 0;
 pendingFeeConfigRecipient = address(0);
 pendingFeeConfigTime = 0;
 emit FeeConfigChangeCancelled();
 }

 function executeFeeConfig() external onlyRole(DEFAULT_ADMIN_ROLE) {
 require(pendingFeeConfigRecipient != address(0), "NO_PENDING");
 require(block.timestamp >= pendingFeeConfigTime + UPGRADE_DELAY, "TIMELOCK_ACTIVE");

 _accrueFees(); // Accrue with old rate first

 fees.performanceFeeBps = pendingFeeConfigBps;
 fees.feeRecipient = pendingFeeConfigRecipient;

 emit FeeConfigUpdated(pendingFeeConfigBps, pendingFeeConfigRecipient);
 pendingFeeConfigBps = 0;
 pendingFeeConfigRecipient = address(0);
 pendingFeeConfigTime = 0;
 }

 /// Added event for reserve BPS changes
 event ReserveBpsUpdated(uint256 oldReserveBps, uint256 newReserveBps);

 /**
 * @notice Request reserve BPS change (48h timelock)
 */
 function requestReserveBps(uint256 _reserveBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
 require(_reserveBps <= 3000, "Reserve too high");
 pendingReserveBps = _reserveBps;
 pendingReserveBpsTime = block.timestamp;
 pendingReserveBpsSet = true;
 emit ReserveBpsChangeRequested(_reserveBps, block.timestamp + UPGRADE_DELAY);
 }

 function cancelReserveBps() external onlyRole(DEFAULT_ADMIN_ROLE) {
 uint256 cancelled = pendingReserveBps;
 pendingReserveBps = 0;
 pendingReserveBpsTime = 0;
 pendingReserveBpsSet = false;
 emit ReserveBpsChangeCancelled(cancelled);
 }

 function executeReserveBps() external onlyRole(DEFAULT_ADMIN_ROLE) {
 require(pendingReserveBpsSet, "NO_PENDING");
 require(block.timestamp >= pendingReserveBpsTime + UPGRADE_DELAY, "TIMELOCK_ACTIVE");
 uint256 oldBps = reserveBps;
 reserveBps = pendingReserveBps;
 pendingReserveBps = 0;
 pendingReserveBpsTime = 0;
 pendingReserveBpsSet = false;
 emit ReserveBpsUpdated(oldBps, reserveBps);
 }

 /// Added event and validation for min auto-allocate changes
 event MinAutoAllocateUpdated(uint256 oldAmount, uint256 newAmount);

 /**
 * @notice Update minimum auto-allocate amount
 */
 function setMinAutoAllocate(uint256 _minAmount) external onlyRole(DEFAULT_ADMIN_ROLE) {
 require(_minAmount > 0, "ZERO_MIN_AMOUNT");
 uint256 oldAmount = minAutoAllocateAmount;
 minAutoAllocateAmount = _minAmount;
 emit MinAutoAllocateUpdated(oldAmount, _minAmount);
 }

 /**
 * @notice Request a timelocked vault change
 * @param _vault Address of the new vault
 */
 function requestVaultChange(address _vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
 if (_vault == address(0)) revert ZeroAddress();
 pendingVault = _vault;
 vaultChangeRequestTime = block.timestamp;
 emit VaultChangeRequested(_vault, block.timestamp + UPGRADE_DELAY);
 }

 /**
 * @notice Cancel a pending vault change
 */
 function cancelVaultChange() external onlyRole(DEFAULT_ADMIN_ROLE) {
 address cancelled = pendingVault;
 pendingVault = address(0);
 vaultChangeRequestTime = 0;
 emit VaultChangeCancelled(cancelled);
 }

 /**
 * @notice Execute vault change after timelock expires
 * @dev VAULT_ROLE controls deposit/withdraw, so changes must be timelocked
 */
 function executeVaultChange() external onlyRole(DEFAULT_ADMIN_ROLE) {
 require(pendingVault != address(0), "NO_PENDING_VAULT");
 require(block.timestamp >= vaultChangeRequestTime + UPGRADE_DELAY, "VAULT_TIMELOCK_ACTIVE");

 address oldVault = vault;
 address newVault = pendingVault;

 // Clear pending state
 pendingVault = address(0);
 vaultChangeRequestTime = 0;

 // Execute role swap
 _revokeRole(VAULT_ROLE, oldVault);
 vault = newVault;
 _grantRole(VAULT_ROLE, newVault);

 emit VaultChanged(oldVault, newVault);
 }

 /**
 * @notice Emergency token recovery (not the primary asset)
 */
 function recoverToken(address token, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
 require(token != address(asset), "CANNOT_RECOVER_ASSET");
 IERC20(token).safeTransfer(msg.sender, amount);
 }

 /**
 * @notice Request a timelocked upgrade
 * @param newImplementation Address of the new implementation contract
 */
 /// @dev Prevent overwriting a pending upgrade to block bait-and-switch attacks.
 /// Admin must cancelUpgrade() first before requesting a new one.
 function requestUpgrade(address newImplementation) external onlyRole(DEFAULT_ADMIN_ROLE) {
 require(newImplementation != address(0), "ZERO_ADDRESS");
 require(pendingImplementation == address(0), "UPGRADE_ALREADY_PENDING");
 pendingImplementation = newImplementation;
 upgradeRequestTime = block.timestamp;
 emit UpgradeRequested(newImplementation, block.timestamp + UPGRADE_DELAY);
 }

 /**
 * @notice Cancel a pending upgrade
 */
 function cancelUpgrade() external onlyRole(DEFAULT_ADMIN_ROLE) {
 address cancelled = pendingImplementation;
 pendingImplementation = address(0);
 upgradeRequestTime = 0;
 emit UpgradeCancelled(cancelled);
 }

 /**
 * @notice UUPS upgrade authorization with timelock
 * @dev Requires requestUpgrade() to be called first, then UPGRADE_DELAY must pass
 */
 function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {
 require(pendingImplementation == newImplementation, "UPGRADE_NOT_REQUESTED");
 require(block.timestamp >= upgradeRequestTime + UPGRADE_DELAY, "UPGRADE_TIMELOCK_ACTIVE");
 // Clear pending state
 pendingImplementation = address(0);
 upgradeRequestTime = 0;
 }
}
