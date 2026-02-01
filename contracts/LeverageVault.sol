// SPDX-License-Identifier: MIT
// BLE Protocol - Leverage Vault
// Automatic multi-loop leverage with Uniswap V3 integration

pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice Uniswap V3 Swap Router interface
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice Price oracle interface
interface IPriceOracle {
    function getValueUsd(address token, uint256 amount) external view returns (uint256);
}

/// @notice Collateral vault interface
interface ICollateralVault {
    function deposits(address user, address token) external view returns (uint256);
    function getConfig(address token) external view returns (
        bool enabled, uint256 collateralFactorBps, uint256 liquidationThresholdBps, uint256 liquidationPenaltyBps
    );
    function depositFor(address user, address token, uint256 amount) external;
    function withdrawFor(address user, address token, uint256 amount, address recipient) external;
}

/// @notice mUSD mint interface
interface IMUSD {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @notice Borrow module interface
interface IBorrowModule {
    function borrowFor(address user, uint256 amount) external;
    function repay(uint256 amount) external;
    function totalDebt(address user) external view returns (uint256);
    function borrowCapacity(address user) external view returns (uint256);
    function maxBorrow(address user) external view returns (uint256);
}

/// @title LeverageVault
/// @notice Automatic multi-loop leverage with integrated Uniswap V3 swaps.
///         Users can open leveraged positions in a single transaction.
/// @dev Integrates with CollateralVault, BorrowModule, and Uniswap V3.
/// FIX H-03: Added Pausable for emergency controls
contract LeverageVault is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant LEVERAGE_ADMIN_ROLE = keccak256("LEVERAGE_ADMIN_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ============================================================
    //                  IMMUTABLES
    // ============================================================

    ISwapRouter public immutable swapRouter;
    ICollateralVault public immutable collateralVault;
    IBorrowModule public immutable borrowModule;
    IPriceOracle public immutable priceOracle;
    IERC20 public immutable musd;

    // ============================================================
    //                  CONFIGURATION
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
    //                  POSITION TRACKING
    // ============================================================

    struct LeveragePosition {
        address collateralToken;
        uint256 initialDeposit;      // User's initial collateral
        uint256 totalCollateral;     // Total collateral after loops
        uint256 totalDebt;           // Total mUSD debt
        uint256 loopsExecuted;       // Number of loops completed
        uint256 targetLeverageX10;   // Target leverage × 10 (e.g., 30 = 3.0x)
        uint256 openedAt;            // Block timestamp when opened
    }

    /// @notice User leverage positions
    mapping(address => LeveragePosition) public positions;

    // ============================================================
    //                  EVENTS
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

    // ============================================================
    //                  CONSTRUCTOR
    // ============================================================

    constructor(
        address _swapRouter,
        address _collateralVault,
        address _borrowModule,
        address _priceOracle,
        address _musd
    ) {
        require(_swapRouter != address(0), "INVALID_ROUTER");
        require(_collateralVault != address(0), "INVALID_VAULT");
        require(_borrowModule != address(0), "INVALID_BORROW");
        require(_priceOracle != address(0), "INVALID_ORACLE");
        require(_musd != address(0), "INVALID_MUSD");

        swapRouter = ISwapRouter(_swapRouter);
        collateralVault = ICollateralVault(_collateralVault);
        borrowModule = IBorrowModule(_borrowModule);
        priceOracle = IPriceOracle(_priceOracle);
        musd = IERC20(_musd);

        // Default configuration
        maxLoops = 10;
        minBorrowPerLoop = 100e18;      // Min 100 mUSD per loop
        defaultPoolFee = 3000;           // 0.3% Uniswap fee tier
        maxSlippageBps = 100;            // 1% max slippage
        maxLeverageX10 = 30;             // 3.0x max leverage by default

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(LEVERAGE_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
    }

    // ============================================================
    //                  LEVERAGE OPERATIONS
    // ============================================================

    /// @notice Open a leveraged position with automatic looping
    /// @param collateralToken The collateral token (e.g., WETH)
    /// @param initialAmount Initial collateral deposit
    /// @param targetLeverageX10 Target leverage × 10 (e.g., 30 = 3.0x, max based on LTV)
    /// @param maxLoopsOverride Max loops for this position (0 = use default)
    /// @return totalCollateral Total collateral after loops
    /// @return totalDebt Total mUSD debt
    /// @return loopsExecuted Number of loops completed
    function openLeveragedPosition(
        address collateralToken,
        uint256 initialAmount,
        uint256 targetLeverageX10,
        uint256 maxLoopsOverride
    ) external nonReentrant whenNotPaused returns (
        uint256 totalCollateral,
        uint256 totalDebt,
        uint256 loopsExecuted
    ) {
        require(leverageEnabled[collateralToken], "TOKEN_NOT_ENABLED");
        require(initialAmount > 0, "INVALID_AMOUNT");
        require(targetLeverageX10 >= 10, "LEVERAGE_TOO_LOW"); // Min 1.0x
        require(positions[msg.sender].totalCollateral == 0, "POSITION_EXISTS");

        // Get collateral config to validate target leverage
        (bool enabled, uint256 collateralFactorBps, , ) = collateralVault.getConfig(collateralToken);
        require(enabled, "COLLATERAL_NOT_ENABLED");

        // Max leverage from LTV = 1 / (1 - LTV). E.g., 75% LTV = 4x max
        uint256 ltvMaxLeverageX10 = (10000 * 10) / (10000 - collateralFactorBps);
        // Use the lower of LTV-based max and configured max
        uint256 effectiveMaxLeverage = ltvMaxLeverageX10 < maxLeverageX10 ? ltvMaxLeverageX10 : maxLeverageX10;
        require(targetLeverageX10 <= effectiveMaxLeverage, "LEVERAGE_EXCEEDS_MAX");

        // Transfer initial collateral from user
        IERC20(collateralToken).safeTransferFrom(msg.sender, address(this), initialAmount);

        // Deposit to collateral vault
        IERC20(collateralToken).forceApprove(address(collateralVault), initialAmount);
        collateralVault.depositFor(msg.sender, collateralToken, initialAmount);

        // Execute leverage loops
        uint256 loopLimit = maxLoopsOverride > 0 ? maxLoopsOverride : maxLoops;
        if (loopLimit > maxLoops) loopLimit = maxLoops;

        (totalCollateral, totalDebt, loopsExecuted) = _executeLeverageLoops(
            msg.sender,
            collateralToken,
            initialAmount,
            targetLeverageX10,
            loopLimit
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
    /// @return collateralReturned Amount of collateral returned to user
    function closeLeveragedPosition(uint256 minCollateralOut) external nonReentrant returns (uint256 collateralReturned) {
        LeveragePosition storage pos = positions[msg.sender];
        require(pos.totalCollateral > 0, "NO_POSITION");

        address collateralToken = pos.collateralToken;
        uint256 debtToRepay = borrowModule.totalDebt(msg.sender);
        
        // Get total collateral in vault
        uint256 totalCollateralInVault = collateralVault.deposits(msg.sender, collateralToken);

        if (debtToRepay > 0) {
            // Calculate how much collateral to sell to cover debt
            uint256 collateralToSell = _getCollateralForMusd(collateralToken, debtToRepay);

            // Add slippage buffer
            collateralToSell = (collateralToSell * (10000 + maxSlippageBps)) / 10000;
            
            // Cap at available collateral
            if (collateralToSell > totalCollateralInVault) {
                collateralToSell = totalCollateralInVault;
            }

            // FIX: Actually withdraw collateral from vault to this contract
            collateralVault.withdrawFor(msg.sender, collateralToken, collateralToSell, address(this));

            // Swap collateral → mUSD
            uint256 musdReceived = _swapCollateralToMusd(collateralToken, collateralToSell);
            require(musdReceived >= debtToRepay, "INSUFFICIENT_MUSD_FROM_SWAP");

            // FIX M-6: Use forceApprove for consistency and USDT-safety
            IERC20(address(musd)).forceApprove(address(borrowModule), debtToRepay);
            borrowModule.repay(debtToRepay);

            // FIX C-1: Refund excess mUSD — if swap-back fails, transfer mUSD to user
            uint256 excessMusd = musdReceived - debtToRepay;
            if (excessMusd > 0) {
                uint256 collateralBack = _swapMusdToCollateral(collateralToken, excessMusd);
                if (collateralBack == 0) {
                    // Swap failed — send excess mUSD directly to user instead of locking
                    IERC20(address(musd)).safeTransfer(msg.sender, excessMusd);
                }
            }
        }

        // FIX: Withdraw ALL remaining collateral from vault to user
        uint256 remainingCollateral = collateralVault.deposits(msg.sender, collateralToken);
        if (remainingCollateral > 0) {
            collateralVault.withdrawFor(msg.sender, collateralToken, remainingCollateral, msg.sender);
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

    // ============================================================
    //                  INTERNAL LOOP LOGIC
    // ============================================================

    /// @notice Execute leverage loops
    function _executeLeverageLoops(
        address user,
        address collateralToken,
        uint256 currentCollateral,
        uint256 targetLeverageX10,
        uint256 loopLimit
    ) internal returns (uint256 totalCollateral, uint256 totalDebt, uint256 loopsExecuted) {
        totalCollateral = currentCollateral;
        totalDebt = 0;
        loopsExecuted = 0;

        for (uint256 i = 0; i < loopLimit; i++) {
            // Check if we've reached target leverage
            uint256 currentLeverageX10 = (totalCollateral * 10) / currentCollateral;
            if (currentLeverageX10 >= targetLeverageX10) break;

            // Calculate remaining borrow capacity
            uint256 borrowable = borrowModule.maxBorrow(user);
            if (borrowable < minBorrowPerLoop) break;

            // Cap borrow to reach target leverage
            uint256 targetDebt = _calculateTargetDebt(currentCollateral, totalCollateral, targetLeverageX10, collateralToken);
            uint256 toBorrow = targetDebt > totalDebt ? targetDebt - totalDebt : 0;
            if (toBorrow > borrowable) toBorrow = borrowable;
            if (toBorrow < minBorrowPerLoop) break;

            // Borrow mUSD (minted to this contract for swapping)
            borrowModule.borrowFor(user, toBorrow);
            totalDebt += toBorrow;

            // FIX C-3: Swap mUSD → collateral — revert on failure to prevent orphaned debt
            uint256 collateralReceived = _swapMusdToCollateral(collateralToken, toBorrow);
            require(collateralReceived > 0, "SWAP_FAILED_ORPHANED_DEBT");

            // Deposit new collateral
            IERC20(collateralToken).forceApprove(address(collateralVault), collateralReceived);
            collateralVault.depositFor(user, collateralToken, collateralReceived);
            totalCollateral += collateralReceived;

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
    //                  SWAP FUNCTIONS
    // ============================================================

    /// @notice Swap mUSD to collateral via Uniswap V3
    function _swapMusdToCollateral(address collateralToken, uint256 musdAmount) internal returns (uint256 collateralReceived) {
        if (musdAmount == 0) return 0;

        // Get expected output for slippage calculation
        uint256 expectedOut = _getCollateralForMusd(collateralToken, musdAmount);
        uint256 minOut = (expectedOut * (10000 - maxSlippageBps)) / 10000;

        // FIX M-6: Use forceApprove for consistency
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
                deadline: block.timestamp, // FIX M-16: Use block.timestamp (caller controls via tx deadline)
                amountIn: musdAmount,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        ) returns (uint256 amountOut) {
            collateralReceived = amountOut;
        } catch {
            // Swap failed, return 0
            collateralReceived = 0;
        }

        return collateralReceived;
    }

    /// @notice Swap collateral to mUSD via Uniswap V3
    /// FIX C-1: Revert on swap failure instead of returning 0 to prevent fund loss
    function _swapCollateralToMusd(address collateralToken, uint256 collateralAmount) internal returns (uint256 musdReceived) {
        if (collateralAmount == 0) return 0;

        // Get expected output
        uint256 expectedOut = priceOracle.getValueUsd(collateralToken, collateralAmount);
        uint256 minOut = (expectedOut * (10000 - maxSlippageBps)) / 10000;

        // Approve router
        IERC20(collateralToken).forceApprove(address(swapRouter), collateralAmount);

        // Get pool fee
        uint24 poolFee = tokenPoolFees[collateralToken];
        if (poolFee == 0) poolFee = defaultPoolFee;

        // FIX C-1: Execute swap - REVERT on failure, do not silently return 0
        musdReceived = swapRouter.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: collateralToken,
                tokenOut: address(musd),
                fee: poolFee,
                recipient: address(this),
                deadline: block.timestamp + 300,
                amountIn: collateralAmount,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
        
        // FIX C-1: Explicit check for zero output
        require(musdReceived > 0, "SWAP_RETURNED_ZERO");

        return musdReceived;
    }

    /// @notice Get collateral amount for given mUSD amount (via oracle)
    /// FIX L-05: Handle tokens with non-18 decimals (e.g., WBTC has 8)
    function _getCollateralForMusd(address collateralToken, uint256 musdAmount) internal view returns (uint256) {
        // mUSD is 1:1 with USD, so musdAmount = USD value
        // Get collateral price in USD
        // FIX L-05: Query actual token decimals instead of assuming 18
        uint256 tokenDecimals = IERC20Metadata(collateralToken).decimals();
        uint256 oneUnit = 10 ** tokenDecimals;
        uint256 oneUnitValue = priceOracle.getValueUsd(collateralToken, oneUnit);
        if (oneUnitValue == 0) return 0;

        return (musdAmount * oneUnit) / oneUnitValue;
    }

    // ============================================================
    //                  VIEW FUNCTIONS
    // ============================================================

    /// @notice Get user's current position
    function getPosition(address user) external view returns (LeveragePosition memory) {
        return positions[user];
    }

    /// @notice Calculate effective leverage for a position
    function getEffectiveLeverage(address user) external view returns (uint256 leverageX10) {
        LeveragePosition memory pos = positions[user];
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
    //                  ADMIN FUNCTIONS
    // ============================================================

    /// @notice Update leverage configuration
    function setConfig(
        uint256 _maxLoops,
        uint256 _minBorrowPerLoop,
        uint24 _defaultPoolFee,
        uint256 _maxSlippageBps
    ) external onlyRole(LEVERAGE_ADMIN_ROLE) {
        require(_maxLoops > 0 && _maxLoops <= 20, "INVALID_MAX_LOOPS");
        require(_maxSlippageBps <= 500, "SLIPPAGE_TOO_HIGH"); // Max 5%

        maxLoops = _maxLoops;
        minBorrowPerLoop = _minBorrowPerLoop;
        defaultPoolFee = _defaultPoolFee;
        maxSlippageBps = _maxSlippageBps;

        emit ConfigUpdated(_maxLoops, _minBorrowPerLoop, _defaultPoolFee, _maxSlippageBps);
    }

    /// @notice Set maximum allowed leverage (toggle between presets: 1.5x, 2x, 2.5x, 3x)
    /// @param _maxLeverageX10 Max leverage × 10 (e.g., 15=1.5x, 20=2x, 25=2.5x, 30=3x)
    function setMaxLeverage(uint256 _maxLeverageX10) external onlyRole(LEVERAGE_ADMIN_ROLE) {
        require(_maxLeverageX10 >= 10 && _maxLeverageX10 <= 40, "INVALID_MAX_LEVERAGE"); // 1x to 4x range
        uint256 oldMax = maxLeverageX10;
        maxLeverageX10 = _maxLeverageX10;
        emit MaxLeverageUpdated(oldMax, _maxLeverageX10);
    }

    /// @notice Enable a collateral token for leverage
    function enableToken(address token, uint24 poolFee) external onlyRole(LEVERAGE_ADMIN_ROLE) {
        require(token != address(0), "INVALID_TOKEN");
        require(poolFee == 100 || poolFee == 500 || poolFee == 3000 || poolFee == 10000, "INVALID_FEE_TIER");

        leverageEnabled[token] = true;
        tokenPoolFees[token] = poolFee;

        emit TokenEnabled(token, poolFee);
    }

    /// @notice Disable a collateral token
    function disableToken(address token) external onlyRole(LEVERAGE_ADMIN_ROLE) {
        leverageEnabled[token] = false;
        emit TokenDisabled(token);
    }

    /// @notice Emergency withdraw stuck tokens
    function emergencyWithdraw(address token, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        IERC20(token).safeTransfer(msg.sender, amount);
    }

    /// @notice FIX C-4: Emergency close a position when normal close fails (e.g., bad debt)
    /// @dev Admin can forcibly close, returning whatever collateral remains to the user.
    ///      Debt is written off — protocol takes the loss rather than trapping user funds.
    /// @param user The user whose position to emergency-close
    function emergencyClosePosition(address user) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        LeveragePosition storage pos = positions[user];
        require(pos.totalCollateral > 0, "NO_POSITION");

        address collateralToken = pos.collateralToken;

        // Withdraw all collateral from vault to this contract
        uint256 totalCollateralInVault = collateralVault.deposits(user, collateralToken);
        if (totalCollateralInVault > 0) {
            collateralVault.withdrawFor(user, collateralToken, totalCollateralInVault, address(this));
        }

        // Attempt to repay as much debt as possible
        uint256 debtToRepay = borrowModule.totalDebt(user);
        if (debtToRepay > 0 && totalCollateralInVault > 0) {
            uint256 musdReceived = _swapCollateralToMusd(collateralToken, totalCollateralInVault);
            if (musdReceived > 0) {
                uint256 repayAmount = musdReceived < debtToRepay ? musdReceived : debtToRepay;
                IERC20(address(musd)).forceApprove(address(borrowModule), repayAmount);
                try borrowModule.repay(repayAmount) {} catch {}
            }
        }

        // Send any remaining collateral + mUSD back to the user
        uint256 remainingCollateral = IERC20(collateralToken).balanceOf(address(this));
        if (remainingCollateral > 0) {
            IERC20(collateralToken).safeTransfer(user, remainingCollateral);
        }
        uint256 remainingMusd = musd.balanceOf(address(this));
        if (remainingMusd > 0) {
            IERC20(address(musd)).safeTransfer(user, remainingMusd);
        }

        emit LeverageClosed(user, collateralToken, remainingCollateral, debtToRepay, 0);
        delete positions[user];
    }

    // ============================================================
    //                  EMERGENCY CONTROLS (FIX H-03)
    // ============================================================

    /// @notice Pause all leverage operations
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Unpause leverage operations (requires admin for separation of duties)
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
