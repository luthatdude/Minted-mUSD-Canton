// SPDX-License-Identifier: MIT
// BLE Protocol - Leverage Vault (UUPS-Upgradeable)
// Automatic multi-loop leverage with Uniswap V3 integration

pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "../interfaces/ISwapRouter.sol";
import "../interfaces/IPriceOracle.sol";
import "../interfaces/ICollateralVault.sol";
import "../interfaces/IMUSD.sol";
import "../interfaces/IBorrowModule.sol";

/// @title LeverageVaultUpgradeable
/// @notice UUPS-upgradeable version of LeverageVault.
/// Automatic multi-loop leverage with integrated Uniswap V3 swaps.
/// Users can open leveraged positions in a single transaction.
/// @dev Integrates with CollateralVault, BorrowModule, and Uniswap V3.
/// Added Pausable for emergency controls
contract LeverageVaultUpgradeable is AccessControlUpgradeable, ReentrancyGuardUpgradeable, PausableUpgradeable, UUPSUpgradeable {
 using SafeERC20 for IERC20;

 bytes32 public constant LEVERAGE_ADMIN_ROLE = keccak256("LEVERAGE_ADMIN_ROLE");
 bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
 bytes32 public constant TIMELOCK_ROLE = keccak256("TIMELOCK_ROLE");

 // ============================================================
 // STORAGE (converted from immutables for upgradeability)
 // ============================================================

 ISwapRouter public swapRouter;
 ICollateralVault public collateralVault;
 IBorrowModule public borrowModule;
 IPriceOracle public priceOracle;
 IERC20 public musd;

 // ============================================================
 // CONFIGURATION
 // ============================================================

 /// @notice Maximum number of leverage loops per transaction
 uint256 public maxLoops;

 /// @notice Minimum borrow amount per loop (prevents dust loops)
 uint256 public minBorrowPerLoop;

 /// @notice Default Uniswap pool fee tier (3000 = 0.3%)
 uint24 public defaultPoolFee;

 /// @notice Slippage tolerance in basis points (e.g., 100 = 1%)
 uint256 public maxSlippageBps;

 /// @notice Maximum allowed leverage × 10 (e.g., 30 = 3.0x max)
 uint256 public maxLeverageX10;

 /// @notice Per-token pool fee overrides
 mapping(address => uint24) public tokenPoolFees;

 /// @notice Whether a collateral token is enabled for leverage
 mapping(address => bool) public leverageEnabled;

 // ============================================================
 // POSITION TRACKING
 // ============================================================

 struct LeveragePosition {
 address collateralToken;
 uint256 initialDeposit; // User's initial collateral
 uint256 totalCollateral; // Total collateral after loops
 uint256 totalDebt; // Total mUSD debt
 uint256 loopsExecuted; // Number of loops completed
 uint256 targetLeverageX10; // Target leverage × 10 (e.g., 30 = 3.0x)
 uint256 openedAt; // Block timestamp when opened
 }

 /// @notice User leverage positions
 mapping(address => LeveragePosition) public positions;

 // ============================================================
 // EVENTS
 // ============================================================

 event LeverageOpened(
 address indexed user,
 address indexed collateralToken,
 uint256 initialDeposit,
 uint256 totalCollateral,
 uint256 totalDebt,
 uint256 loopsExecuted,
 uint256 effectiveLeverageX10
 );

 event LeverageClosed(
 address indexed user,
 address indexed collateralToken,
 uint256 collateralReturned,
 uint256 debtRepaid,
 uint256 profitOrLoss
 );

 event LeverageIncreased(
 address indexed user,
 uint256 additionalCollateral,
 uint256 additionalDebt,
 uint256 newLoops
 );

 event ConfigUpdated(uint256 maxLoops, uint256 minBorrowPerLoop, uint24 defaultPoolFee, uint256 maxSlippageBps);
 event MaxLeverageUpdated(uint256 oldMaxLeverageX10, uint256 newMaxLeverageX10);
 event TokenEnabled(address indexed token, uint24 poolFee);
 event TokenDisabled(address indexed token);

 /// @notice Event for direct mUSD repayment close (no swap needed)
 event LeverageClosedWithDirectRepay(
 address indexed user,
 address indexed collateralToken,
 uint256 collateralReturned,
 uint256 debtRepaid,
 uint256 musdProvidedByUser
 );

 /// @notice Emitted when emergency close debt repayment fails
 event EmergencyRepayFailed(address indexed user, uint256 debtAmount, uint256 musdAvailable);

 // ============================================================
 // CONSTRUCTOR & INITIALIZER
 // ============================================================

 /// @custom:oz-upgrades-unsafe-allow constructor
 constructor() {
 _disableInitializers();
 }

 /// @notice Initialize the upgradeable contract (replaces constructor)
 /// @param _swapRouter Uniswap V3 swap router address
 /// @param _collateralVault CollateralVault contract address
 /// @param _borrowModule BorrowModule contract address
 /// @param _priceOracle PriceOracle contract address
 /// @param _musd mUSD token address
 /// @param _admin Admin address for role grants
 function initialize(
 address _swapRouter,
 address _collateralVault,
 address _borrowModule,
 address _priceOracle,
 address _musd,
 address _admin,
 address _timelockController
 ) external initializer {
 require(_swapRouter != address(0), "INVALID_ROUTER");
 require(_collateralVault != address(0), "INVALID_VAULT");
 require(_borrowModule != address(0), "INVALID_BORROW");
 require(_priceOracle != address(0), "INVALID_ORACLE");
 require(_musd != address(0), "INVALID_MUSD");
 require(_admin != address(0), "INVALID_ADMIN");
 require(_timelockController != address(0), "INVALID_TIMELOCK");

 __AccessControl_init();
 __ReentrancyGuard_init();
 __Pausable_init();
 __UUPSUpgradeable_init();

 swapRouter = ISwapRouter(_swapRouter);
 collateralVault = ICollateralVault(_collateralVault);
 borrowModule = IBorrowModule(_borrowModule);
 priceOracle = IPriceOracle(_priceOracle);
 musd = IERC20(_musd);

 // Default configuration
 maxLoops = 10;
 minBorrowPerLoop = 100e18; // Min 100 mUSD per loop
 defaultPoolFee = 3000; // 0.3% Uniswap fee tier
 maxSlippageBps = 100; // 1% max slippage
 maxLeverageX10 = 30; // 3.0x max leverage by default

 _grantRole(DEFAULT_ADMIN_ROLE, _admin);
 _grantRole(LEVERAGE_ADMIN_ROLE, _admin);
 _grantRole(PAUSER_ROLE, _admin);
 _grantRole(TIMELOCK_ROLE, _timelockController);
 }

 // ============================================================
 // UUPS AUTHORIZATION
 // ============================================================

 /// @dev Only the MintedTimelockController can authorize upgrades (48h delay enforced by OZ TimelockController)
 function _authorizeUpgrade(address newImplementation) internal override onlyRole(TIMELOCK_ROLE) {}

 // ============================================================
 // LEVERAGE OPERATIONS
 // ============================================================

 /// @notice Open a leveraged position with automatic looping
 /// @param collateralToken The collateral token (e.g., WETH)
 /// @param initialAmount Initial collateral deposit
 /// @param targetLeverageX10 Target leverage × 10 (e.g., 30 = 3.0x, max based on LTV)
 /// @param maxLoopsOverride Max loops for this position (0 = use default)
 /// @param userMaxSlippageBps User-specified slippage tolerance in bps (0 = use global default, must be <= maxSlippageBps)
 /// @param swapDeadline User-supplied swap deadline (must be > block.timestamp)
 /// @return totalCollateral Total collateral after loops
 /// @return totalDebt Total mUSD debt
 /// @return loopsExecuted Number of loops completed
 function openLeveragedPosition(
 address collateralToken,
 uint256 initialAmount,
 uint256 targetLeverageX10,
 uint256 maxLoopsOverride,
 uint256 userMaxSlippageBps,
 uint256 swapDeadline
 ) external nonReentrant whenNotPaused returns (
 uint256 totalCollateral,
 uint256 totalDebt,
 uint256 loopsExecuted
 ) {
 // Validate user-supplied deadline to prevent MEV holding attacks
 require(swapDeadline > block.timestamp, "EXPIRED_DEADLINE");
 require(leverageEnabled[collateralToken], "TOKEN_NOT_ENABLED");
 require(initialAmount > 0, "INVALID_AMOUNT");
 require(targetLeverageX10 >= 10, "LEVERAGE_TOO_LOW"); // Min 1.0x
 require(positions[msg.sender].totalCollateral == 0, "POSITION_EXISTS");

 // Get collateral config to validate target leverage (scoped to free stack slots)
 {
 (bool enabled, uint256 collateralFactorBps, , ) = collateralVault.getConfig(collateralToken);
 require(enabled, "COLLATERAL_NOT_ENABLED");

 // Max leverage from LTV = 1 / (1 - LTV). E.g., 75% LTV = 4x max
 uint256 ltvMaxLeverageX10 = (10000 * 10) / (10000 - collateralFactorBps);
 // Use the lower of LTV-based max and configured max
 uint256 effectiveMaxLeverage = ltvMaxLeverageX10 < maxLeverageX10 ? ltvMaxLeverageX10 : maxLeverageX10;
 require(targetLeverageX10 <= effectiveMaxLeverage, "LEVERAGE_EXCEEDS_MAX");
 }

 // Transfer initial collateral from user
 IERC20(collateralToken).safeTransferFrom(msg.sender, address(this), initialAmount);

 // Deposit to collateral vault
 IERC20(collateralToken).forceApprove(address(collateralVault), initialAmount);
 collateralVault.depositFor(msg.sender, collateralToken, initialAmount);

 // Execute leverage loops
 uint256 loopLimit = maxLoopsOverride > 0 ? maxLoopsOverride : maxLoops;
 if (loopLimit > maxLoops) loopLimit = maxLoops;

 // Compute effective slippage — user can be stricter, never looser
 uint256 effectiveSlippage = userMaxSlippageBps == 0 ? maxSlippageBps : userMaxSlippageBps;
 require(effectiveSlippage <= maxSlippageBps, "USER_SLIPPAGE_EXCEEDS_MAX");

 (totalCollateral, totalDebt, loopsExecuted) = _executeLeverageLoops(
 msg.sender,
 collateralToken,
 initialAmount,
 targetLeverageX10,
 loopLimit,
 effectiveSlippage,
 swapDeadline
 );

 // Store position
 positions[msg.sender] = LeveragePosition({
 collateralToken: collateralToken,
 initialDeposit: initialAmount,
 totalCollateral: totalCollateral,
 totalDebt: totalDebt,
 loopsExecuted: loopsExecuted,
 targetLeverageX10: targetLeverageX10,
 openedAt: block.timestamp
 });

 uint256 effectiveLeverageX10 = (totalCollateral * 10) / initialAmount;

 emit LeverageOpened(
 msg.sender,
 collateralToken,
 initialAmount,
 totalCollateral,
 totalDebt,
 loopsExecuted,
 effectiveLeverageX10
 );

 return (totalCollateral, totalDebt, loopsExecuted);
 }

 /// @notice Close leveraged position - repay debt and withdraw collateral
 /// @param minCollateralOut Minimum collateral to receive (slippage protection)
 /// @param userMaxSlippageBps User-specified slippage tolerance in bps (0 = use global default, must be <= maxSlippageBps)
 /// @return collateralReturned Amount of collateral returned to user
 /// @dev If swap fails, use closeLeveragedPositionWithMusd() instead
 /// @dev whenNotPaused removed so users can always close positions and repay debt, even during emergency pause.
 function closeLeveragedPosition(uint256 minCollateralOut, uint256 userMaxSlippageBps, uint256 swapDeadline) external nonReentrant returns (uint256 collateralReturned) {
 // Validate user-supplied deadline
 require(swapDeadline > block.timestamp, "EXPIRED_DEADLINE");
 LeveragePosition storage pos = positions[msg.sender];
 require(pos.totalCollateral > 0, "NO_POSITION");

 address collateralToken = pos.collateralToken;
 uint256 debtToRepay = borrowModule.totalDebt(msg.sender);
 
 // Get total collateral in vault
 uint256 totalCollateralInVault = collateralVault.deposits(msg.sender, collateralToken);

 // Compute effective slippage — user can be stricter, never looser
 uint256 effectiveSlippage = userMaxSlippageBps == 0 ? maxSlippageBps : userMaxSlippageBps;
 require(effectiveSlippage <= maxSlippageBps, "USER_SLIPPAGE_EXCEEDS_MAX");

 if (debtToRepay > 0) {
 // Calculate how much collateral to sell to cover debt
 uint256 collateralToSell = _getCollateralForMusd(collateralToken, debtToRepay);

 // Add slippage buffer
 collateralToSell = (collateralToSell * (10000 + effectiveSlippage)) / 10000;
 
 // Cap at available collateral
 if (collateralToSell > totalCollateralInVault) {
 collateralToSell = totalCollateralInVault;
 }

 // Actually withdraw collateral from vault to this contract
 // Pass skipHealthCheck=true — atomic close repays debt in same tx
 collateralVault.withdrawFor(msg.sender, collateralToken, collateralToSell, address(this), true);

 // Swap collateral → mUSD
 uint256 musdReceived = _swapCollateralToMusd(collateralToken, collateralToSell, effectiveSlippage, swapDeadline);
 require(musdReceived >= debtToRepay, "INSUFFICIENT_MUSD_FROM_SWAP");

 // Use repayFor() to repay the USER's debt, not the vault's
 IERC20(address(musd)).forceApprove(address(borrowModule), debtToRepay);
 borrowModule.repayFor(msg.sender, debtToRepay);

 // Refund excess mUSD if any
 uint256 excessMusd = musdReceived - debtToRepay;
 if (excessMusd > 0) {
 // Try to swap excess mUSD back to collateral.
 // If swap fails (returns 0), transfer the mUSD directly to user
 // instead of leaving it trapped in the contract.
 uint256 swappedCollateral = _swapMusdToCollateral(collateralToken, excessMusd, effectiveSlippage, swapDeadline);
 if (swappedCollateral == 0) {
 // Swap failed — return mUSD directly to user
 IERC20(address(musd)).safeTransfer(msg.sender, excessMusd);
 }
 }
 }

 // Withdraw ALL remaining collateral from vault to user
 uint256 remainingCollateral = collateralVault.deposits(msg.sender, collateralToken);
 if (remainingCollateral > 0) {
 // skipHealthCheck=true — debt already repaid above
 collateralVault.withdrawFor(msg.sender, collateralToken, remainingCollateral, msg.sender, true);
 }
 
 // Also send any collateral held by this contract to user
 uint256 heldCollateral = IERC20(collateralToken).balanceOf(address(this));
 if (heldCollateral > 0) {
 IERC20(collateralToken).safeTransfer(msg.sender, heldCollateral);
 remainingCollateral += heldCollateral;
 }
 
 require(remainingCollateral >= minCollateralOut, "SLIPPAGE_EXCEEDED");

 collateralReturned = remainingCollateral;

 // Calculate profit/loss
 int256 profitOrLoss = int256(collateralReturned) - int256(pos.initialDeposit);

 emit LeverageClosed(
 msg.sender,
 collateralToken,
 collateralReturned,
 debtToRepay,
 profitOrLoss >= 0 ? uint256(profitOrLoss) : 0
 );

 // Clear position
 delete positions[msg.sender];

 return collateralReturned;
 }

 /// @notice Close leveraged position by providing mUSD directly
 /// @dev Use this if closeLeveragedPosition() fails due to swap issues.
 /// User provides mUSD to repay debt, receives ALL collateral back.
 /// This completely eliminates swap failure risk.
 /// @param musdAmount Amount of mUSD to provide for debt repayment
 /// @return collateralReturned Amount of collateral returned to user
 /// @dev whenNotPaused removed so users can always close positions and repay debt, even during emergency pause.
 function closeLeveragedPositionWithMusd(uint256 musdAmount) external nonReentrant returns (uint256 collateralReturned) {
 LeveragePosition storage pos = positions[msg.sender];
 require(pos.totalCollateral > 0, "NO_POSITION");

 address collateralToken = pos.collateralToken;
 uint256 debtToRepay = borrowModule.totalDebt(msg.sender);

 // If there's debt, user must provide enough mUSD to cover it
 if (debtToRepay > 0) {
 require(musdAmount >= debtToRepay, "INSUFFICIENT_MUSD_PROVIDED");

 // Pull mUSD from user
 IERC20(address(musd)).safeTransferFrom(msg.sender, address(this), musdAmount);

 // Use repayFor() to repay the USER's debt, not the vault's
 IERC20(address(musd)).forceApprove(address(borrowModule), debtToRepay);
 borrowModule.repayFor(msg.sender, debtToRepay);

 // Refund excess mUSD if user provided more than needed
 uint256 excessMusd = musdAmount - debtToRepay;
 if (excessMusd > 0) {
 IERC20(address(musd)).safeTransfer(msg.sender, excessMusd);
 }
 }

 // Withdraw ALL collateral from vault directly to user
 uint256 totalCollateralInVault = collateralVault.deposits(msg.sender, collateralToken);
 if (totalCollateralInVault > 0) {
 // skipHealthCheck=true — debt already repaid above
 collateralVault.withdrawFor(msg.sender, collateralToken, totalCollateralInVault, msg.sender, true);
 }

 // Also send any collateral held by this contract to user
 uint256 heldCollateral = IERC20(collateralToken).balanceOf(address(this));
 if (heldCollateral > 0) {
 IERC20(collateralToken).safeTransfer(msg.sender, heldCollateral);
 }

 collateralReturned = totalCollateralInVault + heldCollateral;

 emit LeverageClosedWithDirectRepay(
 msg.sender,
 collateralToken,
 collateralReturned,
 debtToRepay,
 musdAmount
 );

 // Clear position
 delete positions[msg.sender];

 return collateralReturned;
 }

 // ============================================================
 // INTERNAL LOOP LOGIC
 // ============================================================

 /// @notice Execute leverage loops
 function _executeLeverageLoops(
 address user,
 address collateralToken,
 uint256 currentCollateral,
 uint256 targetLeverageX10,
 uint256 loopLimit,
 uint256 slippageBps,
 uint256 swapDeadline
 ) internal returns (uint256 totalCollateral, uint256 totalDebt, uint256 loopsExecuted) {
 totalCollateral = currentCollateral;
 totalDebt = 0;
 loopsExecuted = 0;

 for (uint256 i = 0; i < loopLimit; i++) {
 // Check if we've reached target leverage
 if ((totalCollateral * 10) / currentCollateral >= targetLeverageX10) break;

 // Calculate and execute borrow (scoped to free stack slots)
 uint256 toBorrow;
 {
 uint256 borrowable = borrowModule.maxBorrow(user);
 if (borrowable < minBorrowPerLoop) break;

 toBorrow = _calculateTargetDebt(currentCollateral, totalCollateral, targetLeverageX10, collateralToken);
 toBorrow = toBorrow > totalDebt ? toBorrow - totalDebt : 0;
 if (toBorrow > borrowable) toBorrow = borrowable;
 if (toBorrow < minBorrowPerLoop) break;
 }

 // Borrow mUSD (minted to this contract for swapping)
 borrowModule.borrowFor(user, toBorrow);
 totalDebt += toBorrow;

 // FIX HIGH-06: Track collateral before swap for convergence check
 uint256 collateralBefore = totalCollateral;

 // Swap mUSD → collateral — revert on failure to prevent orphaned debt
 uint256 collateralReceived = _swapMusdToCollateral(collateralToken, toBorrow, slippageBps, swapDeadline);
 require(collateralReceived > 0, "SWAP_FAILED_ORPHANED_DEBT");

 // Deposit new collateral
 IERC20(collateralToken).forceApprove(address(collateralVault), collateralReceived);
 collateralVault.depositFor(user, collateralToken, collateralReceived);
 totalCollateral += collateralReceived;

 // FIX HIGH-06: Convergence check — if collateral gained is <1% of remaining gap,
 // break early to prevent gas waste and potential infinite loops
 uint256 remainingGap = (targetLeverageX10 * currentCollateral / 10) > totalCollateral
     ? (targetLeverageX10 * currentCollateral / 10) - totalCollateral
     : 0;
 uint256 progressMade = totalCollateral - collateralBefore;
 if (remainingGap > 0 && progressMade * 100 < remainingGap) {
     break; // Less than 1% progress toward target — convergence failure
 }

 loopsExecuted++;
 }

 return (totalCollateral, totalDebt, loopsExecuted);
 }

 /// @notice Calculate target debt for given leverage
 function _calculateTargetDebt(
 uint256 initialCollateral,
 uint256 currentCollateral,
 uint256 targetLeverageX10,
 address collateralToken
 ) internal view returns (uint256) {
 // Target total collateral = initial × leverage
 uint256 targetCollateral = (initialCollateral * targetLeverageX10) / 10;
 if (currentCollateral >= targetCollateral) return 0;

 uint256 neededCollateral = targetCollateral - currentCollateral;

 // Convert collateral need to mUSD
 uint256 collateralValueUsd = priceOracle.getValueUsd(collateralToken, neededCollateral);
 return collateralValueUsd;
 }

 // ============================================================
 // SWAP FUNCTIONS
 // ============================================================

 /// @notice Swap mUSD to collateral via Uniswap V3
 /// @dev slippageBps replaces global maxSlippageBps for user-specified tolerance
 /// @dev Uses user-supplied deadline instead of block.timestamp + 300
 function _swapMusdToCollateral(address collateralToken, uint256 musdAmount, uint256 slippageBps, uint256 deadline) internal returns (uint256 collateralReceived) {
 // slither-disable-next-line incorrect-equality
 if (musdAmount == 0) return 0;

 // Get expected output for slippage calculation
 uint256 expectedOut = _getCollateralForMusd(collateralToken, musdAmount);
 uint256 minOut = (expectedOut * (10000 - slippageBps)) / 10000;

 // Use forceApprove for consistency
 IERC20(address(musd)).forceApprove(address(swapRouter), musdAmount);

 // Get pool fee for this token
 uint24 poolFee = tokenPoolFees[collateralToken];
 if (poolFee == 0) poolFee = defaultPoolFee;

 // Execute swap
 try swapRouter.exactInputSingle(
 ISwapRouter.ExactInputSingleParams({
 tokenIn: address(musd),
 tokenOut: collateralToken,
 fee: poolFee,
 recipient: address(this),
 deadline: deadline, // User-supplied deadline
 amountIn: musdAmount,
 amountOutMinimum: minOut,
 sqrtPriceLimitX96: 0
 })
 ) returns (uint256 amountOut) {
 collateralReceived = amountOut;
 } catch {
 // Clear dangling approval on swap failure (defense-in-depth)
 IERC20(address(musd)).forceApprove(address(swapRouter), 0);
 collateralReceived = 0;
 }

 return collateralReceived;
 }

 /// @notice Swap collateral to mUSD via Uniswap V3
 /// Revert on swap failure instead of returning 0 to prevent fund loss
 /// @dev slippageBps replaces global maxSlippageBps for user-specified tolerance
 /// @dev Uses user-supplied deadline instead of block.timestamp + 300
 function _swapCollateralToMusd(address collateralToken, uint256 collateralAmount, uint256 slippageBps, uint256 deadline) internal returns (uint256 musdReceived) {
 // slither-disable-next-line incorrect-equality
 if (collateralAmount == 0) return 0;

 // Get expected output
 uint256 expectedOut = priceOracle.getValueUsd(collateralToken, collateralAmount);
 uint256 minOut = (expectedOut * (10000 - slippageBps)) / 10000;

 // Approve router
 IERC20(collateralToken).forceApprove(address(swapRouter), collateralAmount);

 // Get pool fee
 uint24 poolFee = tokenPoolFees[collateralToken];
 if (poolFee == 0) poolFee = defaultPoolFee;

 // Execute swap - REVERT on failure, do not silently return 0
 musdReceived = swapRouter.exactInputSingle(
 ISwapRouter.ExactInputSingleParams({
 tokenIn: collateralToken,
 tokenOut: address(musd),
 fee: poolFee,
 recipient: address(this),
 deadline: deadline, // User-supplied deadline
 amountIn: collateralAmount,
 amountOutMinimum: minOut,
 sqrtPriceLimitX96: 0
 })
 );
 
 // Explicit check for zero output
 require(musdReceived > 0, "SWAP_RETURNED_ZERO");

 return musdReceived;
 }

 /// @notice Get collateral amount for given mUSD amount (via oracle)
 /// Handle tokens with non-18 decimals (e.g., WBTC has 8)
 function _getCollateralForMusd(address collateralToken, uint256 musdAmount) internal view returns (uint256) {
 // mUSD is 1:1 with USD, so musdAmount = USD value
 // Get collateral price in USD
 // Query actual token decimals instead of assuming 18
 uint256 tokenDecimals = IERC20Metadata(collateralToken).decimals();
 uint256 oneUnit = 10 ** tokenDecimals;
 uint256 oneUnitValue = priceOracle.getValueUsd(collateralToken, oneUnit);
 if (oneUnitValue == 0) return 0;

 return (musdAmount * oneUnit) / oneUnitValue;
 }

 // ============================================================
 // VIEW FUNCTIONS
 // ============================================================

 /// @notice Get user's current position
 function getPosition(address user) external view returns (LeveragePosition memory) {
 return positions[user];
 }

 /// @notice Get the mUSD amount needed to close a position via closeLeveragedPositionWithMusd()
 /// @param user The user's address
 /// @return musdNeeded Amount of mUSD required to repay debt and close position
 function getMusdNeededToClose(address user) external view returns (uint256 musdNeeded) {
 return borrowModule.totalDebt(user);
 }

 /// @notice Calculate effective leverage for a position
 function getEffectiveLeverage(address user) external view returns (uint256 leverageX10) {
 LeveragePosition memory pos = positions[user];
 // slither-disable-next-line incorrect-equality
 if (pos.initialDeposit == 0) return 0;
 return (pos.totalCollateral * 10) / pos.initialDeposit;
 }

 /// @notice Estimate loops needed for target leverage
 function estimateLoops(
 address collateralToken,
 uint256 initialAmount,
 uint256 targetLeverageX10
 ) external view returns (uint256 estimatedLoops, uint256 estimatedDebt) {
 (bool enabled, uint256 collateralFactorBps, , ) = collateralVault.getConfig(collateralToken);
 if (!enabled) return (0, 0);

 uint256 ltv = collateralFactorBps; // e.g., 7500 = 75%
 uint256 currentCollateral = initialAmount;
 uint256 debt = 0;

 for (uint256 i = 0; i < maxLoops; i++) {
 uint256 currentLeverageX10 = (currentCollateral * 10) / initialAmount;
 if (currentLeverageX10 >= targetLeverageX10) break;

 uint256 collateralValueUsd = priceOracle.getValueUsd(collateralToken, currentCollateral);
 uint256 borrowable = (collateralValueUsd * ltv / 10000) - debt;
 if (borrowable < minBorrowPerLoop) break;

 // Estimate collateral from swap (simplified: assume 1:1 USD value)
 uint256 newCollateral = _getCollateralForMusd(collateralToken, borrowable);
 currentCollateral += newCollateral;
 debt += borrowable;
 estimatedLoops++;
 }

 estimatedDebt = debt;
 return (estimatedLoops, estimatedDebt);
 }

 // ============================================================
 // ADMIN FUNCTIONS
 // ============================================================

 /// @notice Update leverage configuration
 function setConfig(
 uint256 _maxLoops,
 uint256 _minBorrowPerLoop,
 uint24 _defaultPoolFee,
 uint256 _maxSlippageBps
 ) external onlyRole(TIMELOCK_ROLE) {
 require(_maxLoops > 0 && _maxLoops <= 20, "INVALID_MAX_LOOPS");
 require(_maxSlippageBps <= 500, "SLIPPAGE_TOO_HIGH"); // Max 5%
 // Validate fee tier matches Uniswap V3 valid tiers
 require(
 _defaultPoolFee == 100 || _defaultPoolFee == 500 ||
 _defaultPoolFee == 3000 || _defaultPoolFee == 10000,
 "INVALID_FEE_TIER"
 );

 maxLoops = _maxLoops;
 minBorrowPerLoop = _minBorrowPerLoop;
 defaultPoolFee = _defaultPoolFee;
 maxSlippageBps = _maxSlippageBps;

 emit ConfigUpdated(_maxLoops, _minBorrowPerLoop, _defaultPoolFee, _maxSlippageBps);
 }

 /// @notice Set maximum allowed leverage (toggle between presets: 1.5x, 2x, 2.5x, 3x)
 /// @param _maxLeverageX10 Max leverage × 10 (e.g., 15=1.5x, 20=2x, 25=2.5x, 30=3x)
 function setMaxLeverage(uint256 _maxLeverageX10) external onlyRole(TIMELOCK_ROLE) {
 require(_maxLeverageX10 >= 10 && _maxLeverageX10 <= 40, "INVALID_MAX_LEVERAGE"); // 1x to 4x range
 uint256 oldMax = maxLeverageX10;
 maxLeverageX10 = _maxLeverageX10;
 emit MaxLeverageUpdated(oldMax, _maxLeverageX10);
 }

 /// @notice Enable a collateral token for leverage
 function enableToken(address token, uint24 poolFee) external onlyRole(TIMELOCK_ROLE) {
 require(token != address(0), "INVALID_TOKEN");
 require(poolFee == 100 || poolFee == 500 || poolFee == 3000 || poolFee == 10000, "INVALID_FEE_TIER");

 leverageEnabled[token] = true;
 tokenPoolFees[token] = poolFee;

 emit TokenEnabled(token, poolFee);
 }

 /// @notice Disable a collateral token
 function disableToken(address token) external onlyRole(TIMELOCK_ROLE) {
 leverageEnabled[token] = false;
 emit TokenDisabled(token);
 }

 // ═══════════════════════════════════════════════════════════════════════
 // Emergency withdraw (via MintedTimelockController)
 // ═══════════════════════════════════════════════════════════════════════

 event EmergencyWithdrawExecuted(address indexed token, uint256 amount, address indexed recipient);

 /// @notice Emergency withdrawal of stuck tokens — must be called through MintedTimelockController
 /// @dev Timelock delay (48h) is enforced by the OZ TimelockController, not here
 function emergencyWithdraw(address token, uint256 amount, address recipient) external onlyRole(TIMELOCK_ROLE) {
 require(token != address(0), "INVALID_TOKEN");
 require(amount > 0, "ZERO_AMOUNT");
 require(recipient != address(0), "INVALID_RECIPIENT");

 IERC20(token).safeTransfer(recipient, amount);
 emit EmergencyWithdrawExecuted(token, amount, recipient);
 }

 /// @notice Emergency close a position when normal close fails (e.g., bad debt)
 /// @dev Admin can forcibly close. If full repayment fails, collateral stays in
 /// the contract for the protocol to recover — NOT returned to user.
 /// Prevents orphaned bad debt (debt in BorrowModule with no backing).
 /// @param user The user whose position to emergency-close
 /// @param emergencySlippageBps Allow wider slippage for emergency scenarios
 function emergencyClosePosition(address user, uint256 emergencySlippageBps) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
 require(emergencySlippageBps <= 2000, "MAX_20_PCT"); // Max 20% in emergency
 LeveragePosition storage pos = positions[user];
 require(pos.totalCollateral > 0, "NO_POSITION");

 address collateralToken = pos.collateralToken;

 // Snapshot balances before operation to prevent sweeping other users' residuals
 uint256 collateralBefore = IERC20(collateralToken).balanceOf(address(this));
 uint256 musdBefore = musd.balanceOf(address(this));

 // Withdraw all collateral from vault to this contract
 uint256 totalCollateralInVault = collateralVault.deposits(user, collateralToken);
 if (totalCollateralInVault > 0) {
 collateralVault.withdrawFor(user, collateralToken, totalCollateralInVault, address(this), true);
 }

 // Attempt to repay as much debt as possible
 uint256 debtToRepay = borrowModule.totalDebt(user);
 bool repaySucceeded = false;

 if (debtToRepay > 0 && totalCollateralInVault > 0) {
 uint256 musdReceived = _swapCollateralToMusd(collateralToken, totalCollateralInVault, emergencySlippageBps, block.timestamp + 1 hours);
 if (musdReceived > 0) {
 uint256 repayAmount = musdReceived < debtToRepay ? musdReceived : debtToRepay;
 IERC20(address(musd)).forceApprove(address(borrowModule), repayAmount);
 // If repay fails, DO NOT return collateral to user.
 // Orphaned bad debt is worse than temporarily holding user funds.
 try borrowModule.repayFor(user, repayAmount) {
 repaySucceeded = true;
 } catch {
 // If repayFor fails, burn available mUSD and reduce debt
 // directly to prevent orphaned debt in BorrowModule.
 // Without this, debt stays in BorrowModule with no backing collateral.
 try borrowModule.reduceDebt(user, repayAmount) {
 // Debt cleared from BorrowModule; mUSD stays in contract for admin recovery
 repaySucceeded = true;
 } catch {
 emit EmergencyRepayFailed(user, repayAmount, musdReceived);
 }
 }
 }
 } else if (debtToRepay == 0) {
 repaySucceeded = true;
 }

 // Only return remaining assets to user if repay succeeded.
 // If repay failed, collateral stays in contract for admin recovery via
 // emergencyWithdraw() — preventing orphaned bad debt.
 // Only return this user's portion, not full contract balance
 if (repaySucceeded) {
 uint256 collateralAfter = IERC20(collateralToken).balanceOf(address(this));
 uint256 userCollateral = collateralAfter > collateralBefore ? collateralAfter - collateralBefore : 0;
 if (userCollateral > 0) {
 IERC20(collateralToken).safeTransfer(user, userCollateral);
 }
 uint256 musdAfter = musd.balanceOf(address(this));
 uint256 userMusd = musdAfter > musdBefore ? musdAfter - musdBefore : 0;
 if (userMusd > 0) {
 IERC20(address(musd)).safeTransfer(user, userMusd);
 }
 }

 emit LeverageClosed(user, collateralToken, 0, debtToRepay, 0);
 delete positions[user];
 }

 // ============================================================
 // EMERGENCY CONTROLS 
 // ============================================================

 /// @notice Pause all leverage operations
 function pause() external onlyRole(PAUSER_ROLE) {
 _pause();
 }

 /// @notice Unpause leverage operations (requires admin for separation of duties)
 function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
 _unpause();
 }

 // ============================================================
 // STORAGE GAP
 // ============================================================

 uint256[40] private __gap;
}
