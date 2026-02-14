// SPDX-License-Identifier: MIT
// BLE Protocol - Borrow Module V2 (UUPS-Upgradeable)
// Tracks debt positions with utilization-based dynamic interest rates
// Routes interest payments to SMUSD stakers

pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IPriceOracle.sol";
import "../interfaces/ICollateralVault.sol";
import "../interfaces/IMUSD.sol";
import "../interfaces/IInterestRateModel.sol";
import "../interfaces/ISMUSD.sol";
import "../interfaces/ITreasuryV2.sol";

/// @title BorrowModuleUpgradeable
/// @notice UUPS-upgradeable version of BorrowModule.
/// Manages debt positions for overcollateralized mUSD borrowing.
/// Uses utilization-based dynamic interest rates (Compound-style).
/// Interest accrues per-second and is routed to SMUSD stakers.
contract BorrowModuleUpgradeable is AccessControlUpgradeable, ReentrancyGuardUpgradeable, PausableUpgradeable, UUPSUpgradeable {
 using SafeERC20 for IERC20;

 bytes32 public constant LIQUIDATION_ROLE = keccak256("LIQUIDATION_ROLE");
 bytes32 public constant BORROW_ADMIN_ROLE = keccak256("BORROW_ADMIN_ROLE");
 bytes32 public constant LEVERAGE_VAULT_ROLE = keccak256("LEVERAGE_VAULT_ROLE");
 bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
 bytes32 public constant TIMELOCK_ROLE = keccak256("TIMELOCK_ROLE");

 ICollateralVault public vault;
 IPriceOracle public oracle;
 IMUSD public musd;

 // ═══════════════════════════════════════════════════════════════════════
 // INTEREST RATE MODEL INTEGRATION
 // ═══════════════════════════════════════════════════════════════════════
 
 /// @notice Dynamic interest rate model (utilization-based)
 IInterestRateModel public interestRateModel;
 
 /// @notice SMUSD vault to receive interest payments
 ISMUSD public smusd;
 
 /// @notice Treasury for total supply calculation
 ITreasuryV2 public treasury;
 
 /// @notice Global total borrows across all users
 uint256 public totalBorrows;

 /// @notice Pre-accrual total borrows snapshot for per-user interest calculation
 /// Prevents denominator inflation that causes systematic undercharging
 uint256 internal totalBorrowsBeforeAccrual;
 
 /// @notice Accumulated protocol reserves (from reserve factor)
 uint256 public protocolReserves;
 
 /// @notice Last time global interest was accrued
 uint256 public lastGlobalAccrualTime;
 
 /// @notice Total interest paid to suppliers (for analytics)
 uint256 public totalInterestPaidToSuppliers;

 /// @notice Interest that accrued as debt but couldn't be minted (supply cap hit)
 /// @dev Tracked separately so totalBorrows stays in sync with actual mUSD supply.
 /// Cleared when a subsequent mint succeeds or admin calls drainUnroutedInterest().
 uint256 public unroutedInterest;

 // ═══════════════════════════════════════════════════════════════════════
 // BAD DEBT TRACKING & SOCIALIZATION
 // ═══════════════════════════════════════════════════════════════════════

 /// @notice Accumulated bad debt from underwater liquidations (unbacked mUSD)
 /// @dev When a liquidation exhausts all collateral but debt remains, the
 /// residual debt is written off the user's position and accumulated here.
 /// This represents mUSD in circulation that is no longer collateral-backed.
 uint256 public badDebt;

 /// @notice Total bad debt ever recorded (for analytics, never decremented)
 uint256 public cumulativeBadDebt;

 /// @notice Total bad debt covered by protocol reserves or external injection
 uint256 public badDebtCovered;

 /// @notice Emitted when bad debt is recorded from an underwater liquidation
 event BadDebtRecorded(address indexed user, uint256 amount, uint256 totalBadDebt);

 /// @notice Emitted when bad debt is covered (burned from reserves or injection)
 event BadDebtCovered(uint256 amount, uint256 remainingBadDebt, string source);

 /// @notice Emitted when bad debt is socialized across the protocol
 event BadDebtSocialized(uint256 amount, uint256 totalBorrowsBefore, uint256 totalBorrowsAfter);

 // ═══════════════════════════════════════════════════════════════════════
 // DEPRECATED — Legacy in-contract timelock variables.
 // These are no longer used since the contract now uses MintedTimelockController.
 // Kept to preserve storage layout for upgradeable contract compatibility.
 // DO NOT use these variables; use MintedTimelockController for all governance.
 // ═══════════════════════════════════════════════════════════════════════

 uint256 public constant ADMIN_DELAY = 48 hours;

 /// @dev DEPRECATED: Use MintedTimelockController instead
 address public pendingInterestRateModel;
 /// @dev DEPRECATED: Use MintedTimelockController instead
 uint256 public pendingInterestRateModelTime;
 /// @dev DEPRECATED: Use MintedTimelockController instead
 address public pendingSMUSD;
 /// @dev DEPRECATED: Use MintedTimelockController instead
 uint256 public pendingSMUSDTime;
 /// @dev DEPRECATED: Use MintedTimelockController instead
 address public pendingTreasury;
 /// @dev DEPRECATED: Use MintedTimelockController instead
 uint256 public pendingTreasuryTime;

 /// @dev DEPRECATED: Use MintedTimelockController instead
 uint256 public pendingInterestRate;
 /// @dev DEPRECATED: Use MintedTimelockController instead
 uint256 public pendingInterestRateTime;
 /// @dev DEPRECATED: Use MintedTimelockController instead
 bool public pendingInterestRateSet; // distinguish 0-value from unset
 /// @dev DEPRECATED: Use MintedTimelockController instead
 uint256 public pendingMinDebt;
 /// @dev DEPRECATED: Use MintedTimelockController instead
 uint256 public pendingMinDebtTime;

 event InterestRateModelChangeRequested(address indexed model, uint256 readyAt);
 event InterestRateModelChangeCancelled(address indexed model);
 event SMUSDChangeRequested(address indexed smusd, uint256 readyAt);
 event SMUSDChangeCancelled(address indexed smusd);
 event TreasuryChangeRequested(address indexed treasury, uint256 readyAt);
 event TreasuryChangeCancelled(address indexed treasury);
 event InterestRateChangeRequested(uint256 rateBps, uint256 readyAt);
 event InterestRateChangeCancelled(uint256 rateBps);
 event MinDebtChangeRequested(uint256 minDebt, uint256 readyAt);
 event MinDebtChangeCancelled(uint256 minDebt);
 
 /// @notice Fallback fixed rate if model not set (legacy compatibility)
 uint256 public interestRateBps;

 // Seconds per year for interest calculation
 uint256 private constant SECONDS_PER_YEAR = 365 days;
 uint256 private constant BPS = 10000;

 // Minimum debt to open a position (prevents dust positions)
 uint256 public minDebt;

 struct DebtPosition {
 uint256 principal; // Original borrowed amount (18 decimals)
 uint256 accruedInterest; // Accumulated interest at last update
 uint256 lastAccrualTime; // Timestamp of last interest accrual
 }

 // user => debt position
 mapping(address => DebtPosition) public positions;

 event Borrowed(address indexed user, uint256 amount, uint256 totalDebt);
 event Repaid(address indexed user, uint256 amount, uint256 remaining);
 event InterestAccrued(address indexed user, uint256 interest, uint256 totalDebt);
 event CollateralWithdrawn(address indexed user, address indexed token, uint256 amount);
 event InterestRateUpdated(uint256 oldRate, uint256 newRate);
 event DebtAdjusted(address indexed user, uint256 newDebt, string reason);
 event MinDebtUpdated(uint256 oldMinDebt, uint256 newMinDebt);
 
 // Interest routing events
 event InterestRoutedToSuppliers(uint256 supplierAmount, uint256 reserveAmount);
 event InterestRateModelUpdated(address indexed oldModel, address indexed newModel);
 event SMUSDUpdated(address indexed oldSMUSD, address indexed newSMUSD);
 event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
 event GlobalInterestAccrued(uint256 interest, uint256 newTotalBorrows, uint256 utilizationBps);
 event ReservesWithdrawn(address indexed to, uint256 amount);
 /// @dev Emitted when interest routing to SMUSD fails (e.g. supply cap hit)
 event InterestRoutingFailed(uint256 supplierAmount, bytes reason);
 /// @dev Emitted when reserve minting fails
 event ReservesMintFailed(address indexed to, uint256 amount);

 /// @custom:oz-upgrades-unsafe-allow constructor
 constructor() {
 _disableInitializers();
 }

 function initialize(
 address _vault,
 address _oracle,
 address _musd,
 uint256 _interestRateBps,
 uint256 _minDebt,
 address _admin,
 address _timelockController
 ) external initializer {
 __AccessControl_init();
 __ReentrancyGuard_init();
 __Pausable_init();
 __UUPSUpgradeable_init();

 require(_vault != address(0), "INVALID_VAULT");
 require(_oracle != address(0), "INVALID_ORACLE");
 require(_musd != address(0), "INVALID_MUSD");
 require(_interestRateBps <= 5000, "RATE_TOO_HIGH");
 require(_minDebt > 0 && _minDebt <= 1e24, "INVALID_MIN_DEBT");
 require(_timelockController != address(0), "INVALID_TIMELOCK");

 vault = ICollateralVault(_vault);
 oracle = IPriceOracle(_oracle);
 musd = IMUSD(_musd);
 interestRateBps = _interestRateBps;
 minDebt = _minDebt;
 lastGlobalAccrualTime = block.timestamp;

 _grantRole(DEFAULT_ADMIN_ROLE, _admin);
 _grantRole(BORROW_ADMIN_ROLE, _admin);
 _grantRole(TIMELOCK_ROLE, _timelockController);
 }

 /// @notice UUPS upgrade authorization — only MintedTimelockController can upgrade (48h delay enforced by OZ)
 function _authorizeUpgrade(address newImplementation) internal override logInternal0(newImplementation)onlyRole(TIMELOCK_ROLE) {}modifier logInternal0(address newImplementation) { assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00000000, 1037618708480) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00000001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00000005, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00006000, newImplementation) } _; }

 // ============================================================
 // INTEREST MODEL SETTERS
 // ============================================================

 // ── Contract-reference setters (via MintedTimelockController) ──

 /// @notice Set interest rate model — must be called through MintedTimelockController
 function setInterestRateModel(address _model) external onlyRole(TIMELOCK_ROLE) {
 require(_model != address(0), "ZERO_ADDRESS");
 address old = address(interestRateModel);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000001,old)}
 interestRateModel = IInterestRateModel(_model);
 emit InterestRateModelUpdated(old, _model);
 }

 /// @notice Set SMUSD vault — must be called through MintedTimelockController
 function setSMUSD(address _smusd) external onlyRole(TIMELOCK_ROLE) {
 require(_smusd != address(0), "ZERO_ADDRESS");
 address old = address(smusd);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000002,old)}
 smusd = ISMUSD(_smusd);
 emit SMUSDUpdated(old, _smusd);
 }

 /// @notice Set Treasury — must be called through MintedTimelockController
 function setTreasury(address _treasury) external onlyRole(TIMELOCK_ROLE) {
 require(_treasury != address(0), "ZERO_ADDRESS");
 address old = address(treasury);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000003,old)}
 treasury = ITreasuryV2(_treasury);
 emit TreasuryUpdated(old, _treasury);
 }

 /// @notice Drain unrouted interest to correct totalBorrows divergence.
 /// When supply cap exhaustion prevents minting mUSD for supplier interest,
 /// `unroutedInterest` accumulates while `totalBorrows` keeps growing.
 /// This function reconciles by subtracting the unrouted amount from totalBorrows.
 event UnroutedInterestDrained(uint256 amount, uint256 totalBorrowsBefore, uint256 totalBorrowsAfter);

 function drainUnroutedInterest() external onlyRole(TIMELOCK_ROLE) {
 uint256 amount = unroutedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000004,amount)}
 require(amount > 0, "NOTHING_TO_DRAIN");
 uint256 totalBorrowsBefore = totalBorrows;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000005,totalBorrowsBefore)}
 unroutedInterest = 0;
 if (totalBorrows >= amount) {
 totalBorrows -= amount;
 } else {
 totalBorrows = 0; // Safety: prevent underflow from rounding drift
 }
 emit UnroutedInterestDrained(amount, totalBorrowsBefore, totalBorrows);
 }

 // ============================================================
 // BORROW / REPAY
 // ============================================================

 /// @notice Borrow mUSD against deposited collateral
 /// @param amount Amount of mUSD to borrow (18 decimals)
 function borrow(uint256 amount) external nonReentrant whenNotPaused {
 require(amount > 0, "INVALID_AMOUNT");

 // Accrue interest first
 _accrueInterest(msg.sender);

 DebtPosition storage pos = positions[msg.sender];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010006,0)}
 uint256 newDebt = pos.principal + pos.accruedInterest + amount;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000007,newDebt)}
 require(newDebt >= minDebt, "BELOW_MIN_DEBT");

 pos.principal += amount;uint256 certora_local63 = pos.principal;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000003f,certora_local63)}
 totalBorrows += amount; // Track global borrows

 // Use borrow capacity (collateral factor) not liquidation threshold
 // _healthFactor uses liquidation threshold, which allows borrowing at the liquidation edge
 uint256 capacity = _borrowCapacity(msg.sender);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000008,capacity)}
 uint256 newTotalDebt = totalDebt(msg.sender);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000009,newTotalDebt)}
 require(capacity >= newTotalDebt, "EXCEEDS_BORROW_CAPACITY");

 // Mint mUSD to borrower
 musd.mint(msg.sender, amount);

 emit Borrowed(msg.sender, amount, totalDebt(msg.sender));
 }

 /// @notice Borrow mUSD on behalf of a user (for LeverageVault integration)
 /// @param user The user to borrow for
 /// @param amount Amount of mUSD to borrow (18 decimals)
 function borrowFor(address user, uint256 amount) external onlyRole(LEVERAGE_VAULT_ROLE) nonReentrant whenNotPaused {
 require(amount > 0, "INVALID_AMOUNT");
 require(user != address(0), "INVALID_USER");

 // Accrue interest first
 _accrueInterest(user);

 DebtPosition storage pos = positions[user];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001000a,0)}
 uint256 newDebt = pos.principal + pos.accruedInterest + amount;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000000b,newDebt)}
 require(newDebt >= minDebt, "BELOW_MIN_DEBT");

 pos.principal += amount;uint256 certora_local64 = pos.principal;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000040,certora_local64)}
 totalBorrows += amount; // Track global borrows

 uint256 capacity = _borrowCapacity(user);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000000c,capacity)}
 uint256 newTotalDebt = totalDebt(user);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000000d,newTotalDebt)}
 require(capacity >= newTotalDebt, "EXCEEDS_BORROW_CAPACITY");

 // Mint mUSD to the LeverageVault (msg.sender) for swapping
 musd.mint(msg.sender, amount);

 emit Borrowed(user, amount, totalDebt(user));
 }

 /// @notice Repay mUSD debt
 /// @param amount Amount of mUSD to repay (18 decimals)
 /// Removed whenNotPaused — users must always be able to repay debt,
 /// even during a pause, to avoid unfair liquidation from accruing interest.
 function repay(uint256 amount) external nonReentrant {
 require(amount > 0, "INVALID_AMOUNT");

 _accrueInterest(msg.sender);

 DebtPosition storage pos = positions[msg.sender];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001000e,0)}
 uint256 total = pos.principal + pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000000f,total)}
 require(total > 0, "NO_DEBT");

 // Cap repayment at total debt
 uint256 repayAmount = amount > total ? total : amount;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000010,repayAmount)}

 // Prevent dust positions after partial repayment
 uint256 remaining = total - repayAmount;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000011,remaining)}
 if (remaining > 0) {
 require(remaining >= minDebt, "REMAINING_BELOW_MIN_DEBT");
 }

 // Pay interest first, then principal
 if (repayAmount <= pos.accruedInterest) {
 pos.accruedInterest -= repayAmount;
 } else {
 // Renamed to 'principalPayment' to avoid shadowing outer 'remaining'
 uint256 principalPayment = repayAmount - pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000045,principalPayment)}
 pos.accruedInterest = 0;uint256 certora_local87 = pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000057,certora_local87)}
 pos.principal -= principalPayment;uint256 certora_local88 = pos.principal;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000058,certora_local88)}
 }

 // Subtract full repayment (principal + interest) from totalBorrows.
 // Previously only principal was subtracted, but _accrueGlobalInterest() adds
 // interest to totalBorrows, so repayment must subtract the full amount to
 // prevent totalBorrows from growing unboundedly.
 if (repayAmount > 0 && totalBorrows >= repayAmount) {
 totalBorrows -= repayAmount;
 } else if (repayAmount > 0) {
 totalBorrows = 0; // Safety: prevent underflow if rounding drift occurs
 }

 // Burn the repaid mUSD
 musd.burn(msg.sender, repayAmount);

 emit Repaid(msg.sender, repayAmount, totalDebt(msg.sender));
 }

 /// @notice Repay mUSD debt on behalf of a user (for LeverageVault integration)
 /// @dev Allows LeverageVault to repay user debt when closing positions
 /// @param user The user whose debt to repay
 /// @param amount Amount of mUSD to repay (18 decimals)
 /// Removed whenNotPaused — repayment must always be available.
 function repayFor(address user, uint256 amount) external onlyRole(LEVERAGE_VAULT_ROLE) nonReentrant {
 require(amount > 0, "INVALID_AMOUNT");
 require(user != address(0), "INVALID_USER");

 _accrueInterest(user);

 DebtPosition storage pos = positions[user];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010012,0)}
 uint256 total = pos.principal + pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000013,total)}
 require(total > 0, "NO_DEBT");

 // Cap repayment at total debt
 uint256 repayAmount = amount > total ? total : amount;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000014,repayAmount)}

 // Prevent dust positions after partial repayment
 uint256 remaining = total - repayAmount;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000015,remaining)}
 if (remaining > 0) {
 require(remaining >= minDebt, "REMAINING_BELOW_MIN_DEBT");
 }

 // Pay interest first, then principal
 if (repayAmount <= pos.accruedInterest) {
 pos.accruedInterest -= repayAmount;
 } else {
 uint256 principalPayment = repayAmount - pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000046,principalPayment)}
 pos.accruedInterest = 0;uint256 certora_local89 = pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000059,certora_local89)}
 pos.principal -= principalPayment;uint256 certora_local90 = pos.principal;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000005a,certora_local90)}
 }

 // Subtract full repayment (principal + interest) from totalBorrows.
 if (repayAmount > 0 && totalBorrows >= repayAmount) {
 totalBorrows -= repayAmount;
 } else if (repayAmount > 0) {
 totalBorrows = 0;
 }

 // Burn the repaid mUSD from the caller (LeverageVault)
 musd.burn(msg.sender, repayAmount);

 emit Repaid(user, repayAmount, totalDebt(user));
 }

 /// @notice Withdraw collateral (only if position stays healthy)
 /// @param token The collateral token
 /// @param amount Amount to withdraw
 /// Checks health BEFORE withdrawal (CEI pattern)
 function withdrawCollateral(address token, uint256 amount) external nonReentrant whenNotPaused {
 require(amount > 0, "INVALID_AMOUNT");

 _accrueInterest(msg.sender);

 // Check health factor BEFORE transfer to follow CEI pattern.
 // The vault.withdraw call below transfers tokens, so we must verify first.
 if (totalDebt(msg.sender) > 0) {
 // Verify the user has enough deposit
 uint256 currentDeposit = vault.deposits(msg.sender, token);
 require(currentDeposit >= amount, "INSUFFICIENT_DEPOSIT");

 // Compute post-withdrawal health by subtracting the withdrawn amount's value
 (bool enabled, , uint256 liqThreshold, ) = vault.getConfig(token);
 // Allow withdrawal of disabled-token collateral.
 // If admin disables a token, users with debt must still be able to withdraw
 // as long as the token was properly configured (liqThreshold > 0).
 // Blocking withdrawal traps collateral permanently for indebted users.
 require(enabled || liqThreshold > 0, "TOKEN_NOT_SUPPORTED");
 // Use try/catch to handle circuit breaker gracefully
 // If circuit breaker trips during withdrawal, fall back to unsafe price
 // rather than DoS-ing the withdrawal entirely
 uint256 withdrawnValue;
 try oracle.getValueUsd(token, amount) returns (uint256 val) {
 withdrawnValue = val;
 } catch {
 // Circuit breaker tripped — use unsafe price for withdrawal safety check
 withdrawnValue = oracle.getValueUsdUnsafe(token, amount);
 }
 uint256 weightedReduction = (withdrawnValue * liqThreshold) / 10000;

 uint256 currentWeighted = _weightedCollateralValue(msg.sender);
 uint256 postWeighted = currentWeighted > weightedReduction
 ? currentWeighted - weightedReduction
 : 0;

 uint256 debt = totalDebt(msg.sender);
 uint256 postHf = debt > 0 ? (postWeighted * 10000) / debt : type(uint256).max;
 require(postHf >= 10000, "WITHDRAWAL_WOULD_LIQUIDATE");
 }

 // Now perform the transfer (Interaction)
 vault.withdraw(token, amount, msg.sender);

 emit CollateralWithdrawn(msg.sender, token, amount);
 }

 // ============================================================
 // INTEREST ACCRUAL
 // ============================================================

 /// @notice Get total supply for utilization calculation
 /// @dev Uses Treasury.totalValue() if available, otherwise returns totalBorrows * 2 as fallback
 /// @dev Treasury.totalValue() returns USDC (6 decimals) but totalBorrows
 /// is in mUSD (18 decimals). Must scale by 1e12 for correct utilization.
 function _getTotalSupply() internal view returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00010000, 1037618708481) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00010001, 0) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00010004, 0) }
 if (address(treasury) != address(0)) {
 try treasury.totalValue() returns (uint256 value) {
 // Convert USDC (6 decimals) to mUSD scale (18 decimals)
 return value * 1e12;
 } catch {
 // Fallback: assume 50% utilization
 return totalBorrows * 2;
 }
 }
 // No treasury set: assume 50% utilization
 return totalBorrows > 0 ? totalBorrows * 2 : 1e18;
 }

 /// @notice Get current borrow rate (dynamic or fixed fallback)
 function _getCurrentBorrowRateBps() internal view returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00030000, 1037618708483) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00030001, 0) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00030004, 0) }
 if (address(interestRateModel) != address(0)) {
 return interestRateModel.getBorrowRateAnnual(totalBorrows, _getTotalSupply());
 }
 return interestRateBps; // Fallback to fixed rate
 }

 /// @notice Accrue global interest and route to suppliers
 /// @dev Called before any borrow/repay to update global state
 function _accrueGlobalInterest() internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00040000, 1037618708484) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00040001, 0) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00040004, 0) }
 uint256 elapsed = block.timestamp - lastGlobalAccrualTime;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000016,elapsed)}
 // slither-disable-next-line incorrect-equality
 if (elapsed == 0 || totalBorrows == 0) {
 lastGlobalAccrualTime = block.timestamp;
 return;
 }

 uint256 totalSupply = _getTotalSupply();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000017,totalSupply)}
 uint256 interest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000018,interest)}

 if (address(interestRateModel) != address(0)) {
 // Use dynamic interest rate model
 interest = interestRateModel.calculateInterest(
 totalBorrows,
 totalBorrows,
 totalSupply,
 elapsed
 );
 } else {
 // Fallback to fixed rate
 interest = (totalBorrows * interestRateBps * elapsed) / (BPS * SECONDS_PER_YEAR);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000005b,interest)}
 }

 // Cap interest per accrual to 10% of totalBorrows to prevent runaway minting
 uint256 maxInterestPerAccrual = totalBorrows / 10;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000019,maxInterestPerAccrual)}
 if (interest > maxInterestPerAccrual) {
 interest = maxInterestPerAccrual;
 }

 if (interest > 0) {
 // Split interest between suppliers and protocol reserves
 uint256 supplierAmount;
 uint256 reserveAmount;
 
 if (address(interestRateModel) != address(0)) {
 (supplierAmount, reserveAmount) = interestRateModel.splitInterest(interest);
 } else {
 // Default 10% to reserves if no model
 reserveAmount = interest / 10;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000064,reserveAmount)}
 supplierAmount = interest - reserveAmount;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000065,supplierAmount)}
 }

 // Add reserves to protocol
 protocolReserves += reserveAmount;

 // Route supplier portion to SMUSD
 // Wrap in try/catch so supply cap exhaustion doesn't brick
 // repay/liquidation paths. Interest is still tracked in totalBorrows.
 if (supplierAmount > 0 && address(smusd) != address(0)) {
 try musd.mint(address(this), supplierAmount) {
 // Use forceApprove for safe ERC20 approval
 IERC20(address(musd)).forceApprove(address(smusd), supplierAmount);
 try smusd.receiveInterest(supplierAmount) {
 totalInterestPaidToSuppliers += supplierAmount;
 emit InterestRoutedToSuppliers(supplierAmount, reserveAmount);
 } catch (bytes memory reason) {
 // SMUSD rejected — burn the minted tokens to keep supply clean
 musd.burn(address(this), supplierAmount);
 emit InterestRoutingFailed(supplierAmount, reason);
 }
 } catch (bytes memory reason) {
 // Supply cap hit — track as unrouted so totalBorrows stays
 // in sync with actual mUSD supply. The debt still exists but
 // the corresponding mUSD was never minted.
 unroutedInterest += supplierAmount;
 emit InterestRoutingFailed(supplierAmount, reason);
 }
 }

 // Update total borrows to include accrued interest
 // NOTE: totalBorrows is updated AFTER _accrueInterest() reads it for per-user
 // proportional calculation. This is correct: _accrueGlobalInterest() runs first
 // (updating totalBorrows here), then _accrueInterest() uses the new totalBorrows
 // as the denominator. To prevent systematic undercharging, we cache the pre-update
 // value in totalBorrowsBeforeAccrual for the per-user calculation.
 totalBorrowsBeforeAccrual = totalBorrows;
 totalBorrows += interest;
 
 // Use effective borrows (excluding unrouted interest) for utilization.
 // Unrouted interest inflates totalBorrows without corresponding mUSD supply,
 // creating phantom debt that artificially raises the utilization rate.
 uint256 effectiveBorrows = totalBorrows > unroutedInterest ? totalBorrows - unroutedInterest : totalBorrows;
 uint256 utilization = address(interestRateModel) != address(0)
 ? interestRateModel.utilizationRate(effectiveBorrows, totalSupply)
 : (effectiveBorrows * BPS) / totalSupply;
 
 emit GlobalInterestAccrued(interest, totalBorrows, utilization);
 }

 lastGlobalAccrualTime = block.timestamp;
 }

 /// @notice Accrue interest on a user's debt
 /// @dev Uses dynamic rate from InterestRateModel if set, otherwise fixed rate.
 /// Uses SIMPLE INTEREST model (not compound) for gas efficiency.
 /// simple interest is intentional.
 function _accrueInterest(address user) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00020000, 1037618708482) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00020001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00020005, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00026000, user) }
 // First accrue global interest (for routing to suppliers)
 _accrueGlobalInterest();

 DebtPosition storage pos = positions[user];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001001a,0)}
 if (pos.principal == 0 && pos.accruedInterest == 0) {
 pos.lastAccrualTime = block.timestamp;
 return;
 }

 uint256 elapsed = block.timestamp - pos.lastAccrualTime;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000001b,elapsed)}
 // slither-disable-next-line incorrect-equality
 if (elapsed == 0) return;

 // Calculate user interest as their proportional share of global interest
 // to prevent totalBorrows divergence. User's share = (user_principal / totalBorrows) * global_interest
 // This ensures Σ user_interest ≈ global_interest by construction.
 // Use totalBorrowsBeforeAccrual (cached pre-increment value) to prevent
 // systematic undercharging. Without this, the denominator is inflated by the global
 // interest already added in _accrueGlobalInterest(), causing sum(user_debts) < totalBorrows.
 uint256 interest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000001c,interest)}
 uint256 userTotal = pos.principal + pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000001d,userTotal)}
 uint256 denominator = totalBorrowsBeforeAccrual > 0 ? totalBorrowsBeforeAccrual : totalBorrows;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000001e,denominator)}
 if (denominator > 0 && userTotal > 0) {
 if (address(interestRateModel) != address(0)) {
 uint256 globalInterest = interestRateModel.calculateInterest(
 denominator,
 denominator,
 _getTotalSupply(),
 elapsed
 );
 // User's proportional share of global interest
 interest = (globalInterest * userTotal) / denominator;
 } else {
 // Fallback: use user's total debt (principal + accrued) as base
 interest = (userTotal * interestRateBps * elapsed) / (BPS * SECONDS_PER_YEAR);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000066,interest)}
 }
 }

 pos.accruedInterest += interest;uint256 certora_local65 = pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000041,certora_local65)}
 pos.lastAccrualTime = block.timestamp;uint256 certora_local66 = pos.lastAccrualTime;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000042,certora_local66)}

 if (interest > 0) {
 emit InterestAccrued(user, interest, pos.principal + pos.accruedInterest);
 }
 }

 // ============================================================
 // HEALTH FACTOR
 // ============================================================

 /// @notice Calculate health factor for a user
 /// @dev healthFactor = (collateralValue * liquidationThreshold) / debt
 /// Returns in basis points (10000 = 1.0). Below 10000 = liquidatable.
 function _healthFactor(address user) internal view returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00050000, 1037618708485) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00050001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00050005, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00056000, user) }
 uint256 debt = totalDebt(user);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000001f,debt)}
 // slither-disable-next-line incorrect-equality
 if (debt == 0) return type(uint256).max;

 uint256 weightedCollateral = _weightedCollateralValue(user);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000020,weightedCollateral)}
 if (weightedCollateral == 0) return 0;

 return (weightedCollateral * 10000) / debt;
 }

 /// @notice Get the collateral value weighted by liquidation threshold
 /// @dev Includes disabled collateral in health calculations.
 /// When admin disables a token, borrowers still have deposits. Excluding
 /// disabled tokens would instantly drop their health factor, making them
 /// liquidatable through no fault of their own. The collateral config
 /// (liqThreshold) persists even after disableCollateral().
 function _weightedCollateralValue(address user) internal view returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00060000, 1037618708486) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00060001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00060005, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00066000, user) }
 address[] memory tokens = vault.getSupportedTokens();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010021,0)}
 uint256 totalWeighted = 0;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000022,totalWeighted)}

 for (uint256 i = 0; i < tokens.length; i++) {
 uint256 deposited = vault.deposits(user, tokens[i]);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000047,deposited)}
 if (deposited == 0) continue;

 (, , uint256 liqThreshold, ) = vault.getConfig(tokens[i]);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010048,0)}
 // Do NOT skip disabled tokens — borrowers with existing deposits
 // must retain their collateral value for health factor calculations.
 // Only liqThreshold == 0 means truly unconfigured (never added).
 if (liqThreshold == 0) continue;

 uint256 valueUsd = oracle.getValueUsd(tokens[i], deposited);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000049,valueUsd)}
 totalWeighted += (valueUsd * liqThreshold) / 10000;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000005c,totalWeighted)}
 }

 return totalWeighted;
 }

 /// @notice Collateral value using unsafe oracle (bypasses circuit breaker)
 /// @dev Mirrors _weightedCollateralValue but uses getValueUsdUnsafe so liquidation
 /// health checks work during extreme price moves when circuit breaker trips.
 /// @dev Includes disabled collateral (same rationale as _weightedCollateralValue)
 function _weightedCollateralValueUnsafe(address user) internal view returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00070000, 1037618708487) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00070001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00070005, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00076000, user) }
 address[] memory tokens = vault.getSupportedTokens();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010023,0)}
 uint256 totalWeighted = 0;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000024,totalWeighted)}

 for (uint256 i = 0; i < tokens.length; i++) {
 uint256 deposited = vault.deposits(user, tokens[i]);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000004a,deposited)}
 if (deposited == 0) continue;

 (, , uint256 liqThreshold, ) = vault.getConfig(tokens[i]);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001004b,0)}
 // Do NOT skip disabled tokens — count all collateral for health factor
 if (liqThreshold == 0) continue;

 uint256 valueUsd = oracle.getValueUsdUnsafe(tokens[i], deposited);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000004c,valueUsd)}
 totalWeighted += (valueUsd * liqThreshold) / 10000;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000005d,totalWeighted)}
 }

 return totalWeighted;
 }

 /// @notice Get the maximum borrowable amount for a user (based on collateral factor, not liq threshold)
 /// @dev M-01: Intentionally skips disabled tokens — users must NOT open new debt against
 /// disabled collateral. This is asymmetric with health-check/liquidation (which still
 /// credits disabled collateral via liqThreshold > 0) to avoid trapping users. The
 /// asymmetry is by design: disabled tokens protect against new risk but don't orphan
 /// existing positions.
 function _borrowCapacity(address user) internal view returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00080000, 1037618708488) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00080001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00080005, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00086000, user) }
 address[] memory tokens = vault.getSupportedTokens();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010025,0)}
 uint256 totalCapacity = 0;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000026,totalCapacity)}

 for (uint256 i = 0; i < tokens.length; i++) {
 uint256 deposited = vault.deposits(user, tokens[i]);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000004d,deposited)}
 if (deposited == 0) continue;

 (bool enabled, uint256 colFactor, , ) = vault.getConfig(tokens[i]);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001004e,0)}
 if (!enabled) continue; // Intentional: no new borrows against disabled collateral

 uint256 valueUsd = oracle.getValueUsd(tokens[i], deposited);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000004f,valueUsd)}
 totalCapacity += (valueUsd * colFactor) / 10000;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000005e,totalCapacity)}
 }

 return totalCapacity;
 }

 // ============================================================
 // LIQUIDATION INTERFACE
 // ============================================================

 /// @notice Called by LiquidationEngine or LeverageVault to reduce a user's debt after seizure/emergency close
 /// Added nonReentrant to match all other state-modifying debt functions
 /// Allow LEVERAGE_VAULT_ROLE to call for emergency debt cleanup
 function reduceDebt(address user, uint256 amount) external nonReentrant {
 require(
 hasRole(LIQUIDATION_ROLE, msg.sender) || hasRole(LEVERAGE_VAULT_ROLE, msg.sender),
 "UNAUTHORIZED_REDUCE_DEBT"
 );
 _accrueInterest(user);

 DebtPosition storage pos = positions[user];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010027,0)}
 uint256 total = pos.principal + pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000028,total)}
 uint256 reduction = amount > total ? total : amount;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000029,reduction)}

 if (reduction <= pos.accruedInterest) {
 pos.accruedInterest -= reduction;
 } else {
 uint256 remaining = reduction - pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000050,remaining)}
 pos.accruedInterest = 0;uint256 certora_local95 = pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000005f,certora_local95)}
 pos.principal -= remaining;uint256 certora_local96 = pos.principal;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000060,certora_local96)}
 }

 // Subtract full reduction (principal + interest) from totalBorrows.
 // Same class as C-05: _accrueGlobalInterest adds interest to totalBorrows,
 // so liquidation must subtract the full amount, not just principal.
 if (reduction > 0 && totalBorrows >= reduction) {
 totalBorrows -= reduction;
 } else if (reduction > 0) {
 totalBorrows = 0; // Safety: prevent underflow from rounding drift
 }

 emit DebtAdjusted(user, totalDebt(user), "LIQUIDATION");
 }

 /// @notice Record bad debt from underwater liquidation.
 /// Called by LiquidationEngine after a liquidation exhausts all collateral
 /// on a borrower who still has residual debt. Writes off the user's position
 /// and moves the shortfall into the badDebt accumulator.
 /// @param user The borrower whose remaining debt is uncollectible
 function recordBadDebt(address user) external nonReentrant {
 require(
 hasRole(LIQUIDATION_ROLE, msg.sender),
 "UNAUTHORIZED_RECORD_BAD_DEBT"
 );

 _accrueInterest(user);

 DebtPosition storage pos = positions[user];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001002a,0)}
 uint256 residual = pos.principal + pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000002b,residual)}
 if (residual == 0) return;

 // Verify borrower truly has no collateral left
 address[] memory tokens = vault.getSupportedTokens();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001002c,0)}
 uint256 remainingCollateralValue = 0;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000002d,remainingCollateralValue)}
 for (uint256 i = 0; i < tokens.length; i++) {
 uint256 deposited = vault.deposits(user, tokens[i]);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000051,deposited)}
 if (deposited > 0) {
 remainingCollateralValue += oracle.getValueUsdUnsafe(tokens[i], deposited);
 }
 }
 require(remainingCollateralValue == 0, "COLLATERAL_REMAINING");

 // Write off the user's position
 pos.principal = 0;uint256 certora_local67 = pos.principal;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000043,certora_local67)}
 pos.accruedInterest = 0;uint256 certora_local68 = pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000044,certora_local68)}

 // Remove from totalBorrows (this debt no longer earns interest)
 if (totalBorrows >= residual) {
 totalBorrows -= residual;
 } else {
 totalBorrows = 0;
 }

 // Track bad debt
 badDebt += residual;
 cumulativeBadDebt += residual;

 emit BadDebtRecorded(user, residual, badDebt);
 emit DebtAdjusted(user, 0, "BAD_DEBT_WRITEOFF");
 }

 /// @notice Cover bad debt by burning mUSD from protocol reserves.
 /// Admin sends mUSD to this contract, which is burned to reduce
 /// the unbacked supply. Reduces the badDebt accumulator accordingly.
 /// @param amount Amount of bad debt to cover (mUSD, 18 decimals)
 function coverBadDebt(uint256 amount) external nonReentrant onlyRole(TIMELOCK_ROLE) {
 require(amount > 0, "ZERO_AMOUNT");
 require(badDebt > 0, "NO_BAD_DEBT");

 uint256 coverAmount = amount > badDebt ? badDebt : amount;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000002e,coverAmount)}

 // Burn mUSD from this contract to reduce unbacked supply
 // Admin must transfer mUSD to this contract before calling
 uint256 balance = IERC20(address(musd)).balanceOf(address(this));uint256 certora_local47 = balance;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000002f,certora_local47)}
 require(balance >= coverAmount, "INSUFFICIENT_MUSD_BALANCE");

 musd.burn(address(this), coverAmount);

 badDebt -= coverAmount;
 badDebtCovered += coverAmount;

 emit BadDebtCovered(coverAmount, badDebt, "PROTOCOL_RESERVES");
 }

 /// @notice Socialize remaining bad debt by reducing totalBorrows.
 /// This effectively distributes the loss across all borrowers by
 /// slightly reducing the interest base. Should only be used as a
 /// last resort when reserves are insufficient.
 /// @dev Socializes bad debt by proportionally reducing each active
 /// borrower's debt, maintaining the invariant sum(user_debts) == totalBorrows.
 /// Without proportional reduction, totalBorrows drops below user sums,
 /// breaking interest accrual math (overallocation via proportional share).
 /// @param amount Amount of bad debt to socialize
 /// @param borrowers Array of active borrower addresses whose debt should be reduced
 function socializeBadDebt(uint256 amount, address[] calldata borrowers) external nonReentrant onlyRole(TIMELOCK_ROLE) {
 require(amount > 0, "ZERO_AMOUNT");
 require(badDebt > 0, "NO_BAD_DEBT");
 require(borrowers.length > 0, "NO_BORROWERS");

 uint256 socializeAmount = amount > badDebt ? badDebt : amount;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000030,socializeAmount)}

 // ── Pass 1: accrue interest for all unique borrowers ──────
 // Accruing first ensures totalBorrows reflects post-accrual state
 // before we snapshot the denominator. Without this, the denominator
 // (pre-accrual) is smaller than the sum of post-accrual user totals,
 // causing userReduction fractions to sum > socializeAmount (overshoot).
 for (uint256 i = 0; i < borrowers.length; i++) {
 bool isDuplicate = false;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000052,isDuplicate)}
 for (uint256 j = 0; j < i; j++) {
 if (borrowers[j] == borrowers[i]) {
 isDuplicate = true;
 break;
 }
 }
 if (isDuplicate) continue;
 _accrueInterest(borrowers[i]);
 }

 // Snapshot denominator AFTER accrual so numerators and denominator
 // are on the same basis — prevents overshoot.
 uint256 totalBorrowsBefore = totalBorrows;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000031,totalBorrowsBefore)}

 // ── Pass 2: proportionally reduce each user's debt ────────
 uint256 totalReduced = 0;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000032,totalReduced)}
 for (uint256 i = 0; i < borrowers.length; i++) {
 bool isDuplicate = false;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000053,isDuplicate)}
 for (uint256 j = 0; j < i; j++) {
 if (borrowers[j] == borrowers[i]) {
 isDuplicate = true;
 break;
 }
 }
 if (isDuplicate) continue;

 DebtPosition storage pos = positions[borrowers[i]];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010054,0)}
 uint256 userTotal = pos.principal + pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000055,userTotal)}
 if (userTotal == 0) continue;

 uint256 userReduction = (socializeAmount * userTotal) / totalBorrowsBefore;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000056,userReduction)}
 if (userReduction == 0) continue;
 if (userReduction > userTotal) userReduction = userTotal;

 // Reduce accrued interest first, then principal
 if (userReduction <= pos.accruedInterest) {
 pos.accruedInterest -= userReduction;
 } else {
 uint256 remaining = userReduction - pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000063,remaining)}
 pos.accruedInterest = 0;uint256 certora_local103 = pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000067,certora_local103)}
 pos.principal = pos.principal > remaining ? pos.principal - remaining : 0;uint256 certora_local104 = pos.principal;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000068,certora_local104)}
 }
 totalReduced += userReduction;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000061,totalReduced)}
 emit DebtAdjusted(borrowers[i], pos.principal + pos.accruedInterest, "BAD_DEBT_SOCIALIZED");
 }

 // Cap totalReduced to prevent exceeding socializeAmount or badDebt
 if (totalReduced > socializeAmount) totalReduced = socializeAmount;
 if (totalReduced > badDebt) totalReduced = badDebt;

 // Decrement badDebt by actual amount applied, not requested amount.
 // This ensures badDebt stays in sync with real debt reductions.
 badDebt = badDebt > totalReduced ? badDebt - totalReduced : 0;
 badDebtCovered += totalReduced;

 // Reduce totalBorrows by the actual amount reduced across users
 if (totalBorrows >= totalReduced) {
 totalBorrows -= totalReduced;
 } else {
 totalBorrows = 0;
 }

 emit BadDebtSocialized(totalReduced, totalBorrowsBefore, totalBorrows);
 emit BadDebtCovered(totalReduced, badDebt, "SOCIALIZED");
 }

 // ============================================================
 // VIEW FUNCTIONS
 // ============================================================

 /// @notice Get total debt (principal + accrued interest) for a user
 /// @dev Uses pos.principal + pos.accruedInterest (total debt) as interest base,
 /// matching _accrueInterest() execution. Previously used only pos.principal, causing
 /// the view to understate pending interest vs what _accrueInterest actually charges.
 function totalDebt(address user) public view returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00110000, 1037618708497) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00110001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00110005, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00116000, user) }
 DebtPosition storage pos = positions[user];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010033,0)}
 uint256 elapsed = block.timestamp - pos.lastAccrualTime;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000034,elapsed)}
 uint256 userTotal = pos.principal + pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000035,userTotal)}
 
 uint256 pendingInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000036,pendingInterest)}
 if (address(interestRateModel) != address(0)) {
 // Use userTotal as base (matches _accrueInterest proportional share)
 uint256 globalInterest = interestRateModel.calculateInterest(
 totalBorrows,
 totalBorrows,
 _getTotalSupply(),
 elapsed
 );
 // User's proportional share of global interest (same formula as _accrueInterest)
 pendingInterest = totalBorrows > 0 ? (globalInterest * userTotal) / totalBorrows : 0;
 } else {
 // Use userTotal (principal + accrued) as base, matching _accrueInterest
 pendingInterest = (userTotal * interestRateBps * elapsed) / (BPS * SECONDS_PER_YEAR);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000062,pendingInterest)}
 }
 return userTotal + pendingInterest;
 }

 /// @notice Get health factor for a user (public view)
 /// @return Health factor in basis points (10000 = 1.0)
 function healthFactor(address user) external view returns (uint256) {
 uint256 debt = totalDebt(user);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000037,debt)}
 // slither-disable-next-line incorrect-equality
 if (debt == 0) return type(uint256).max;

 uint256 weightedCollateral = _weightedCollateralValue(user);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000038,weightedCollateral)}
 if (weightedCollateral == 0) return 0;

 return (weightedCollateral * 10000) / debt;
 }

 /// @notice Health factor using unsafe oracle (bypasses circuit breaker)
 /// @dev Used by LiquidationEngine so liquidations proceed during >20% price crashes.
 /// Without this, healthFactor() reverts via getValueUsd() circuit breaker,
 /// blocking all liquidations exactly when they are most needed.
 /// @return Health factor in basis points (10000 = 1.0)
 function healthFactorUnsafe(address user) external view returns (uint256) {
 uint256 debt = totalDebt(user);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000039,debt)}
 // slither-disable-next-line incorrect-equality
 if (debt == 0) return type(uint256).max;

 uint256 weightedCollateral = _weightedCollateralValueUnsafe(user);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000003a,weightedCollateral)}
 if (weightedCollateral == 0) return 0;

 return (weightedCollateral * 10000) / debt;
 }

 /// @notice Get maximum additional borrow amount for a user
 function maxBorrow(address user) external view returns (uint256) {
 uint256 capacity = _borrowCapacity(user);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000003b,capacity)}
 uint256 debt = totalDebt(user);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000003c,debt)}
 return capacity > debt ? capacity - debt : 0;
 }

 /// @notice Get total borrow capacity for a user (public wrapper)
 function borrowCapacity(address user) external view returns (uint256) {
 return _borrowCapacity(user);
 }

 // ============================================================
 // INTEREST RATE VIEW FUNCTIONS
 // ============================================================

 /// @notice Get current utilization rate in BPS
 function getUtilizationRate() external view returns (uint256) {
 if (address(interestRateModel) != address(0)) {
 return interestRateModel.utilizationRate(totalBorrows, _getTotalSupply());
 }
 uint256 supply = _getTotalSupply();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000003d,supply)}
 if (supply == 0) return 0;
 return (totalBorrows * BPS) / supply;
 }

 /// @notice Get current annual borrow rate in BPS
 function getCurrentBorrowRate() external view returns (uint256) {
 return _getCurrentBorrowRateBps();
 }

 /// @notice Get current annual supply rate in BPS
 function getCurrentSupplyRate() external view returns (uint256) {
 if (address(interestRateModel) != address(0)) {
 return interestRateModel.getSupplyRateAnnual(totalBorrows, _getTotalSupply());
 }
 // Fallback: 90% of borrow rate goes to suppliers
 return (interestRateBps * 9) / 10;
 }

 /// @notice Get total supply used for utilization calculation
 function getTotalSupply() external view returns (uint256) {
 return _getTotalSupply();
 }

 /// @notice Withdraw accumulated protocol reserves
 /// Reserves are accounting entries for the protocol's share of interest.
 /// Instead of minting unbacked mUSD (which dilutes the peg), we try to mint
 /// within the supply cap. If the cap is hit, the withdrawal fails gracefully.
 /// Admin should coordinate with supply cap management before withdrawing.
 function withdrawReserves(address to, uint256 amount) external onlyRole(TIMELOCK_ROLE) {
 require(amount <= protocolReserves, "EXCEEDS_RESERVES");
 require(to != address(0), "ZERO_ADDRESS");
 
 protocolReserves -= amount;
 
 // Try to mint — if supply cap is hit, revert gracefully
 // so admin knows to increase cap or reduce reserves first
 try musd.mint(to, amount) {
 emit ReservesWithdrawn(to, amount);
 } catch {
 // Restore reserves and emit failure
 protocolReserves += amount;
 emit ReservesMintFailed(to, amount);
 revert("SUPPLY_CAP_REACHED");
 }
 }

 // ============================================================
 // ADMIN (executed via MintedTimelockController)
 // ============================================================

 // ── Parameter setters (via MintedTimelockController) ──────

 /// @notice Set interest rate — must be called through MintedTimelockController
 function setInterestRate(uint256 _rateBps) external onlyRole(TIMELOCK_ROLE) {
 require(_rateBps <= 5000, "RATE_TOO_HIGH"); // Max 50% APR
 uint256 old = interestRateBps;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000003e,old)}
 interestRateBps = _rateBps;
 emit InterestRateUpdated(old, _rateBps);
 }

 /// @notice Set min debt threshold — must be called through MintedTimelockController
 function setMinDebt(uint256 _minDebt) external onlyRole(TIMELOCK_ROLE) {
 require(_minDebt > 0, "MIN_DEBT_ZERO");
 require(_minDebt <= 1e24, "MIN_DEBT_TOO_HIGH");
 emit MinDebtUpdated(minDebt, _minDebt);
 minDebt = _minDebt;
 }

 // ============================================================
 // EMERGENCY CONTROLS
 // ============================================================

 /// @notice Pause borrowing and repayments
 function pause() external onlyRole(PAUSER_ROLE) {
 _pause();
 }

 /// @notice Unpause borrowing and repayments
 /// Require DEFAULT_ADMIN_ROLE for separation of duties
 function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
 _unpause();
 }

 // ============================================================
 // STORAGE GAP
 // ============================================================

 uint256[40] private __gap;
}
