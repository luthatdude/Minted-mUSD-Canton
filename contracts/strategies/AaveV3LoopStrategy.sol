// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/ILeverageLoopStrategy.sol";
import "../interfaces/IMerklDistributor.sol";
import "../TimelockGoverned.sol";
import "../Errors.sol";

// ═══════════════════════════════════════════════════════════════════════════
//                     AAVE V3 INTERFACES
// ═══════════════════════════════════════════════════════════════════════════

/// @notice AAVE V3 Pool — core lending protocol
interface IAaveV3Pool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external;
    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) external returns (uint256);
    function setUserEMode(uint8 categoryId) external;
    function getUserEMode(address user) external view returns (uint256);
    function getUserAccountData(address user) external view returns (
        uint256 totalCollateralBase,
        uint256 totalDebtBase,
        uint256 availableBorrowsBase,
        uint256 currentLiquidationThreshold,
        uint256 ltv,
        uint256 healthFactor
    );
    /// @notice Flash loan with variable debt option
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

/// @notice AAVE V3 aToken — interest-bearing receipt token
interface IAToken {
    function balanceOf(address account) external view returns (uint256);
    function scaledBalanceOf(address user) external view returns (uint256);
    function UNDERLYING_ASSET_ADDRESS() external view returns (address);
}

/// @notice AAVE V3 Variable Debt Token
interface IVariableDebtToken {
    function balanceOf(address account) external view returns (uint256);
    function scaledBalanceOf(address user) external view returns (uint256);
}

/// @notice AAVE V3 Pool Data Provider — read-only market data
interface IAaveV3DataProvider {
    function getReserveData(address asset) external view returns (
        uint256 unbacked,
        uint256 accruedToTreasuryScaled,
        uint256 totalAToken,
        uint256 totalStableDebt,
        uint256 totalVariableDebt,
        uint256 liquidityRate,
        uint256 variableBorrowRate,
        uint256 stableBorrowRate,
        uint256 averageStableBorrowRate,
        uint256 liquidityIndex,
        uint256 variableBorrowIndex,
        uint40 lastUpdateTimestamp
    );
    function getUserReserveData(address asset, address user) external view returns (
        uint256 currentATokenBalance,
        uint256 currentStableDebt,
        uint256 currentVariableDebt,
        uint256 principalStableDebt,
        uint256 scaledVariableDebt,
        uint256 stableBorrowRate,
        uint256 liquidityRate,
        uint40 stableRateLastUpdated,
        bool usageAsCollateralEnabled
    );
    function getReserveConfigurationData(address asset) external view returns (
        uint256 decimals,
        uint256 ltv,
        uint256 liquidationThreshold,
        uint256 liquidationBonus,
        uint256 reserveFactor,
        bool usageAsCollateralEnabled,
        bool borrowingEnabled,
        bool stableBorrowRateEnabled,
        bool isActive,
        bool isFrozen
    );
}

/// @notice Uniswap V3 Router for reward → USDC swaps
interface ISwapRouterV3 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice AAVE V3 Flash Loan callback
interface IFlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

/**
 * @title AaveV3LoopStrategy
 * @notice Leveraged USDC looping on AAVE V3 with Merkl reward integration
 *
 * @dev Architecture (inspired by Stability DAO's LeverageLendingBase):
 *
 *   DEPOSIT FLOW (flash-loan powered, single tx):
 *     1. User deposits X USDC
 *     2. Flash loan (leverage-1)*X USDC from AAVE
 *     3. Supply total (leverage*X) USDC as collateral
 *     4. Borrow (leverage-1)*X to repay flash loan
 *     Net: X USDC user capital → leverage*X supplied, (leverage-1)*X borrowed
 *
 *   WITHDRAW FLOW (reverse flash loan):
 *     1. Flash loan outstanding debt
 *     2. Repay all debt
 *     3. Withdraw all collateral
 *     4. Repay flash loan + fee
 *     5. Return remaining to user
 *
 *   MERKL REWARDS:
 *     - AAVE pools often have Merkl reward campaigns (extra APY)
 *     - claimAndCompound(): claim → swap to USDC → deposit into position
 *
 *   NET APY = supplyAPY × leverage − borrowAPY × (leverage−1) + merklAPY
 *
 * @dev Safety features:
 *   - Flash loan looping (1 tx, no multi-tx attack surface)
 *   - Configurable leverage 1.5x–10x via target LTV
 *   - Health factor monitoring with emergency deleverage
 *   - Profitability gate: only loop when net APY > 0
 *   - Per-operation approvals (no standing allowances)
 *   - E-mode support for correlated pairs
 */
contract AaveV3LoopStrategy is
    ILeverageLoopStrategy,
    IFlashLoanSimpleReceiver,
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
    uint256 public constant WAD = 1e18;
    uint256 public constant SECONDS_PER_YEAR = 365.25 days;

    /// @notice AAVE interest rate mode: 2 = variable
    uint256 public constant INTEREST_RATE_MODE = 2;

    /// @notice Maximum loops for iterative deleverage fallback
    uint256 public constant MAX_DELEVERAGE_LOOPS = 10;

    /// @notice Minimum health factor before emergency deleverage triggers (1.05)
    uint256 public constant MIN_HEALTH_FACTOR = 1.05e18;

    /// @notice Flash loan action types for executeOperation callback
    uint8 private constant ACTION_DEPOSIT = 1;
    uint8 private constant ACTION_WITHDRAW = 2;
    uint8 private constant ACTION_REBALANCE_UP = 3;
    uint8 private constant ACTION_REBALANCE_DOWN = 4;

    // ═══════════════════════════════════════════════════════════════════
    // ROLES
    // ═══════════════════════════════════════════════════════════════════

    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE");
    bytes32 public constant STRATEGIST_ROLE = keccak256("STRATEGIST_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    // ═══════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════

    /// @notice USDC token
    IERC20 public usdc;

    /// @notice AAVE V3 Pool (Mainnet: 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2)
    IAaveV3Pool public aavePool;

    /// @notice AAVE V3 Data Provider (Mainnet: 0x7B4EB56E7CD4b454BA8ff71E4518426c)
    IAaveV3DataProvider public dataProvider;

    /// @notice Merkl Distributor (Mainnet: 0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae)
    IMerklDistributor public merklDistributor;

    /// @notice Uniswap V3 Router for reward swaps
    ISwapRouterV3 public swapRouter;

    /// @notice AAVE aUSDC token (interest-bearing)
    IAToken public aToken;

    /// @notice AAVE variable debt USDC token
    IVariableDebtToken public debtToken;

    /// @notice Target LTV in basis points (e.g., 7500 = 75%)
    uint256 public override targetLtvBps;

    /// @notice Number of conceptual loops (1 with flash loan = equivalent to N iterative)
    uint256 public override targetLoops;

    /// @notice Safety buffer below liquidation threshold (default 500 = 5%)
    uint256 public safetyBufferBps;

    /// @notice Whether strategy is accepting deposits
    bool public active;

    /// @notice Total principal deposited (before leverage)
    uint256 public totalPrincipal;

    /// @notice E-mode category ID (0 = off, 1+ = protocol specific)
    uint8 public eModeCategoryId;

    /// @notice Max borrow rate (annualized, WAD) to allow leveraged deposits
    uint256 public maxBorrowRateForProfit;

    /// @notice Minimum net APY spread (supply*leverage - borrow*(leverage-1))
    uint256 public minNetApySpread;

    /// @notice Total Merkl rewards claimed (cumulative, in USDC terms)
    uint256 public totalRewardsClaimed;

    /// @notice Default swap fee tier for reward → USDC (3000 = 0.3%)
    uint24 public defaultSwapFeeTier;

    /// @notice Minimum swap output ratio (9500 = 95% of oracle price)
    uint256 public minSwapOutputBps;

    /// @notice Allowed reward tokens for claiming (whitelist)
    mapping(address => bool) public allowedRewardTokens;

    // ═══════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event Deposited(uint256 principal, uint256 totalSupplied, uint256 leverageX100);
    event Withdrawn(uint256 requested, uint256 returned);
    event ParametersUpdated(uint256 targetLtvBps, uint256 targetLoops);
    event ProfitabilityParamsUpdated(uint256 maxBorrowRate, uint256 minNetApySpread);
    event EModeUpdated(uint8 categoryId);
    event RewardTokenToggled(address indexed token, bool allowed);
    event SwapParamsUpdated(uint24 feeTier, uint256 minOutputBps);

    // ═══════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error StrategyNotActive();
    error InvalidLTV();
    error InvalidMaxLoopsParam();
    error FlashLoanCallbackUnauthorized();
    error HealthFactorTooLow();
    error NotProfitable();
    error RewardTokenNotAllowed();
    error MaxBorrowRateTooHighErr();
    error InvalidEMode();
    error SlippageTooHighErr();
    error SharePriceTooLow();

    // ═══════════════════════════════════════════════════════════════════
    // CONSTRUCTOR & INITIALIZER
    // ═══════════════════════════════════════════════════════════════════

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the AAVE V3 Loop Strategy
     * @param _usdc USDC token address
     * @param _aavePool AAVE V3 Pool address
     * @param _dataProvider AAVE V3 Data Provider address
     * @param _aToken aUSDC token address
     * @param _debtToken Variable debt USDC token address
     * @param _merklDistributor Merkl distributor address
     * @param _swapRouter Uniswap V3 router for reward swaps
     * @param _treasury Treasury address (can deposit/withdraw)
     * @param _admin Default admin
     * @param _timelock Timelock controller
     */
    function initialize(
        address _usdc,
        address _aavePool,
        address _dataProvider,
        address _aToken,
        address _debtToken,
        address _merklDistributor,
        address _swapRouter,
        address _treasury,
        address _admin,
        address _timelock
    ) external initializer {
        if (_timelock == address(0)) revert ZeroAddress();
        if (_usdc == address(0)) revert ZeroAddress();
        if (_aavePool == address(0)) revert ZeroAddress();

        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        _setTimelock(_timelock);

        usdc = IERC20(_usdc);
        aavePool = IAaveV3Pool(_aavePool);
        dataProvider = IAaveV3DataProvider(_dataProvider);
        aToken = IAToken(_aToken);
        debtToken = IVariableDebtToken(_debtToken);
        merklDistributor = IMerklDistributor(_merklDistributor);
        swapRouter = ISwapRouterV3(_swapRouter);

        // Default parameters: 75% LTV, 4x effective leverage
        targetLtvBps = 7500;
        targetLoops = 4;
        safetyBufferBps = 500;
        active = true;

        // Profitability: max 8% borrow rate, min 0.5% net spread
        maxBorrowRateForProfit = 0.08e18;
        minNetApySpread = 0.005e18;

        // Swap defaults
        defaultSwapFeeTier = 3000; // 0.3%
        minSwapOutputBps = 9500;   // 95% min output

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(TREASURY_ROLE, _treasury);
        _grantRole(STRATEGIST_ROLE, _admin);
        _grantRole(GUARDIAN_ROLE, _admin);
        _grantRole(KEEPER_ROLE, _admin);
    }

    // ═══════════════════════════════════════════════════════════════════
    // IStrategy IMPLEMENTATION
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit USDC and leverage via flash loan
     * @dev Single-tx: flash loan → supply → borrow → repay flash
     */
    function deposit(uint256 amount)
        external
        override
        onlyRole(TREASURY_ROLE)
        nonReentrant
        whenNotPaused
        returns (uint256 deposited)
    {
        if (amount == 0) revert ZeroAmount();
        if (!active) revert StrategyNotActive();

        // Transfer USDC from Treasury
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        // Calculate flash loan amount for target leverage
        // leverage = 1 / (1 - targetLTV)
        // flashAmount = amount * targetLTV / (1 - targetLTV)
        uint256 flashAmount = (amount * targetLtvBps) / (BPS - targetLtvBps);

        if (flashAmount > 0) {
            // Check profitability before leveraging
            if (!_isProfitable()) {
                // Not profitable — just supply without leverage
                usdc.forceApprove(address(aavePool), amount);
                aavePool.supply(address(usdc), amount, address(this), 0);
                totalPrincipal += amount;
                emit Deposited(amount, amount, 100);
                return amount;
            }

            // Flash loan to leverage
            aavePool.flashLoanSimple(
                address(this),
                address(usdc),
                flashAmount,
                abi.encode(ACTION_DEPOSIT, amount),
                0
            );
        } else {
            // No leverage — just supply
            usdc.forceApprove(address(aavePool), amount);
            aavePool.supply(address(usdc), amount, address(this), 0);
        }

        totalPrincipal += amount;
        deposited = amount;

        uint256 leverageX100 = totalPrincipal > 0
            ? (aToken.balanceOf(address(this)) * 100) / totalPrincipal
            : 100;

        emit Deposited(amount, aToken.balanceOf(address(this)), leverageX100);
    }

    /**
     * @notice Withdraw USDC by deleveraging via flash loan
     * @dev Single-tx: flash loan → repay debt → withdraw collateral → repay flash
     */
    function withdraw(uint256 amount)
        external
        override
        onlyRole(TREASURY_ROLE)
        nonReentrant
        returns (uint256 withdrawn)
    {
        if (amount == 0) revert ZeroAmount();

        uint256 principalToWithdraw = amount > totalPrincipal ? totalPrincipal : amount;
        uint256 currentDebt = debtToken.balanceOf(address(this));

        if (currentDebt > 0) {
            // Calculate proportional debt to repay
            uint256 currentCollateral = aToken.balanceOf(address(this));
            uint256 debtToRepay = (currentDebt * principalToWithdraw) / totalPrincipal;
            if (debtToRepay > currentDebt) debtToRepay = currentDebt;

            // Flash loan to deleverage
            aavePool.flashLoanSimple(
                address(this),
                address(usdc),
                debtToRepay,
                abi.encode(ACTION_WITHDRAW, principalToWithdraw),
                0
            );
        } else {
            // No debt — just withdraw
            aavePool.withdraw(address(usdc), principalToWithdraw, address(this));
        }

        totalPrincipal -= principalToWithdraw;

        // Transfer available balance to Treasury
        uint256 balance = usdc.balanceOf(address(this));
        withdrawn = balance > amount ? amount : balance;
        if (withdrawn > 0) {
            usdc.safeTransfer(msg.sender, withdrawn);
        }

        emit Withdrawn(amount, withdrawn);
    }

    /**
     * @notice Withdraw all USDC from strategy
     */
    function withdrawAll()
        external
        override
        onlyRole(TREASURY_ROLE)
        nonReentrant
        returns (uint256 withdrawn)
    {
        uint256 currentDebt = debtToken.balanceOf(address(this));

        if (currentDebt > 0) {
            // Flash loan the full debt to unwind completely
            aavePool.flashLoanSimple(
                address(this),
                address(usdc),
                currentDebt,
                abi.encode(ACTION_WITHDRAW, type(uint256).max),
                0
            );
        }

        // Withdraw any remaining collateral
        uint256 remaining = aToken.balanceOf(address(this));
        if (remaining > 0) {
            aavePool.withdraw(address(usdc), remaining, address(this));
        }

        totalPrincipal = 0;

        // Transfer everything to Treasury
        withdrawn = usdc.balanceOf(address(this));
        if (withdrawn > 0) {
            usdc.safeTransfer(msg.sender, withdrawn);
        }

        emit Withdrawn(type(uint256).max, withdrawn);
    }

    /**
     * @notice Total value of position in USDC terms
     */
    function totalValue() external view override returns (uint256) {
        uint256 collateral = aToken.balanceOf(address(this));
        uint256 debt = debtToken.balanceOf(address(this));
        return collateral > debt ? collateral - debt : 0;
    }

    function asset() external view override returns (address) {
        return address(usdc);
    }

    function isActive() external view override returns (bool) {
        return active && !paused();
    }

    // ═══════════════════════════════════════════════════════════════════
    // FLASH LOAN CALLBACK
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice AAVE V3 flash loan callback
     * @dev Handles deposit (leverage up) and withdraw (deleverage) actions
     */
    function executeOperation(
        address, /* asset */
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        if (msg.sender != address(aavePool)) revert FlashLoanCallbackUnauthorized();
        if (initiator != address(this)) revert FlashLoanCallbackUnauthorized();

        (uint8 action, uint256 userAmount) = abi.decode(params, (uint8, uint256));

        if (action == ACTION_DEPOSIT) {
            _handleDepositCallback(amount, premium, userAmount);
        } else if (action == ACTION_WITHDRAW) {
            _handleWithdrawCallback(amount, premium, userAmount);
        } else if (action == ACTION_REBALANCE_UP) {
            _handleRebalanceUpCallback(amount, premium);
        } else if (action == ACTION_REBALANCE_DOWN) {
            _handleRebalanceDownCallback(amount, premium);
        }

        return true;
    }

    /**
     * @dev Flash loan deposit: supply (user + flash) → borrow to repay flash
     */
    function _handleDepositCallback(uint256 flashAmount, uint256 premium, uint256 userAmount) internal {
        uint256 totalToSupply = userAmount + flashAmount;

        // Supply total amount as collateral
        usdc.forceApprove(address(aavePool), totalToSupply);
        aavePool.supply(address(usdc), totalToSupply, address(this), 0);

        // Borrow to repay flash loan
        uint256 repayAmount = flashAmount + premium;
        aavePool.borrow(address(usdc), repayAmount, INTEREST_RATE_MODE, 0, address(this));

        // Approve repayment to AAVE Pool
        usdc.forceApprove(address(aavePool), repayAmount);
    }

    /**
     * @dev Flash loan withdraw: repay debt → withdraw collateral → repay flash
     */
    function _handleWithdrawCallback(uint256 flashAmount, uint256 premium, uint256 withdrawAmount) internal {
        // Repay debt with flash-loaned funds
        usdc.forceApprove(address(aavePool), flashAmount);
        aavePool.repay(address(usdc), flashAmount, INTEREST_RATE_MODE, address(this));

        // Withdraw collateral
        uint256 toWithdraw = withdrawAmount == type(uint256).max
            ? aToken.balanceOf(address(this))
            : withdrawAmount + flashAmount + premium;

        if (toWithdraw > aToken.balanceOf(address(this))) {
            toWithdraw = aToken.balanceOf(address(this));
        }

        aavePool.withdraw(address(usdc), toWithdraw, address(this));

        // Approve flash loan repayment
        uint256 repayAmount = flashAmount + premium;
        usdc.forceApprove(address(aavePool), repayAmount);
    }

    /**
     * @dev Flash loan rebalance up: supply flash → borrow to repay flash (increase LTV)
     */
    function _handleRebalanceUpCallback(uint256 flashAmount, uint256 premium) internal {
        // Supply flash-loaned amount
        usdc.forceApprove(address(aavePool), flashAmount);
        aavePool.supply(address(usdc), flashAmount, address(this), 0);

        // Borrow to repay flash
        uint256 repayAmount = flashAmount + premium;
        aavePool.borrow(address(usdc), repayAmount, INTEREST_RATE_MODE, 0, address(this));

        usdc.forceApprove(address(aavePool), repayAmount);
    }

    /**
     * @dev Flash loan rebalance down: repay debt → withdraw → repay flash (decrease LTV)
     */
    function _handleRebalanceDownCallback(uint256 flashAmount, uint256 premium) internal {
        // Repay debt
        usdc.forceApprove(address(aavePool), flashAmount);
        aavePool.repay(address(usdc), flashAmount, INTEREST_RATE_MODE, address(this));

        // Withdraw to repay flash
        uint256 repayAmount = flashAmount + premium;
        aavePool.withdraw(address(usdc), repayAmount, address(this));

        usdc.forceApprove(address(aavePool), repayAmount);
    }

    // ═══════════════════════════════════════════════════════════════════
    // REBALANCE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Rebalance position to target LTV
     * @dev Called by keeper when LTV drifts from target due to interest accrual
     */
    function rebalance()
        external
        override
        onlyRole(KEEPER_ROLE)
        nonReentrant
        whenNotPaused
    {
        uint256 currentDebt = debtToken.balanceOf(address(this));
        uint256 currentCollateral = aToken.balanceOf(address(this));

        if (currentCollateral == 0) return;

        uint256 currentLtv = (currentDebt * BPS) / currentCollateral;
        uint256 targetLtv = targetLtvBps;

        if (currentLtv == targetLtv) return;

        uint256 adjustment;

        if (currentLtv < targetLtv) {
            // Under-leveraged — need to borrow more
            // Target debt = collateral * targetLtv / BPS
            uint256 targetDebt = (currentCollateral * targetLtv) / BPS;
            adjustment = targetDebt - currentDebt;

            if (adjustment > 1e4) { // Dust check
                aavePool.flashLoanSimple(
                    address(this),
                    address(usdc),
                    adjustment,
                    abi.encode(ACTION_REBALANCE_UP, uint256(0)),
                    0
                );
            }

            emit Rebalanced(currentLtv, targetLtv, adjustment);
        } else {
            // Over-leveraged — need to repay some debt
            uint256 targetDebt = (currentCollateral * targetLtv) / BPS;
            adjustment = currentDebt - targetDebt;

            if (adjustment > 1e4) { // Dust check
                aavePool.flashLoanSimple(
                    address(this),
                    address(usdc),
                    adjustment,
                    abi.encode(ACTION_REBALANCE_DOWN, uint256(0)),
                    0
                );
            }

            emit Rebalanced(currentLtv, targetLtv, adjustment);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // MERKL REWARDS
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Claim Merkl rewards and compound into position
     * @dev Swaps reward tokens to USDC via Uniswap V3, then deposits into position
     * @param tokens Reward token addresses to claim
     * @param amounts Amounts to claim per token
     * @param proofs Merkle proofs per token
     */
    function claimAndCompound(
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes32[][] calldata proofs
    )
        external
        override
        onlyRole(KEEPER_ROLE)
        nonReentrant
        whenNotPaused
    {
        if (tokens.length == 0) return;

        // Validate all tokens are whitelisted
        for (uint256 i = 0; i < tokens.length; i++) {
            if (!allowedRewardTokens[tokens[i]]) revert RewardTokenNotAllowed();
        }

        // Build claim arrays
        address[] memory users = new address[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            users[i] = address(this);
        }

        // Claim from Merkl
        merklDistributor.claim(users, tokens, amounts, proofs);

        // Swap each reward token → USDC and deposit
        uint256 totalUsdcReceived = 0;

        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            uint256 balance = IERC20(token).balanceOf(address(this));

            if (balance == 0) continue;
            if (token == address(usdc)) {
                totalUsdcReceived += balance;
                emit RewardsClaimed(token, balance);
                continue;
            }

            // Swap reward → USDC via Uniswap V3
            IERC20(token).forceApprove(address(swapRouter), balance);

            uint256 minOutput = (balance * minSwapOutputBps) / BPS;

            uint256 received = swapRouter.exactInputSingle(
                ISwapRouterV3.ExactInputSingleParams({
                    tokenIn: token,
                    tokenOut: address(usdc),
                    fee: defaultSwapFeeTier,
                    recipient: address(this),
                    amountIn: balance,
                    amountOutMinimum: minOutput,
                    sqrtPriceLimitX96: 0
                })
            );

            totalUsdcReceived += received;
            emit RewardsClaimed(token, received);
        }

        // Compound: deposit USDC into the position
        if (totalUsdcReceived > 0) {
            usdc.forceApprove(address(aavePool), totalUsdcReceived);
            aavePool.supply(address(usdc), totalUsdcReceived, address(this), 0);
            totalRewardsClaimed += totalUsdcReceived;

            uint256 leverageX100 = totalPrincipal > 0
                ? (aToken.balanceOf(address(this)) * 100) / totalPrincipal
                : 100;

            emit RewardsCompounded(totalUsdcReceived, leverageX100);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // EMERGENCY
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Emergency deleverage — fully unwind position
     */
    function emergencyDeleverage()
        external
        override
        onlyRole(GUARDIAN_ROLE)
        nonReentrant
    {
        (,,,,, uint256 healthBefore) = aavePool.getUserAccountData(address(this));

        uint256 debt = debtToken.balanceOf(address(this));
        if (debt > 0) {
            // Flash loan to repay all debt
            aavePool.flashLoanSimple(
                address(this),
                address(usdc),
                debt,
                abi.encode(ACTION_WITHDRAW, type(uint256).max),
                0
            );
        }

        // Withdraw remaining collateral
        uint256 remaining = aToken.balanceOf(address(this));
        if (remaining > 0) {
            aavePool.withdraw(address(usdc), remaining, address(this));
        }

        (,,,,, uint256 healthAfter) = aavePool.getUserAccountData(address(this));

        emit EmergencyDeleveraged(healthBefore, healthAfter);
    }

    // ═══════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Current health factor from AAVE
     */
    function getHealthFactor() external view override returns (uint256) {
        (,,,,, uint256 hf) = aavePool.getUserAccountData(address(this));
        return hf;
    }

    /**
     * @notice Current leverage ratio × 100
     */
    function getCurrentLeverage() external view override returns (uint256 leverageX100) {
        if (totalPrincipal == 0) return 100;
        uint256 collateral = aToken.balanceOf(address(this));
        leverageX100 = (collateral * 100) / totalPrincipal;
    }

    /**
     * @notice Full position snapshot
     */
    function getPosition() external view override returns (
        uint256 collateral,
        uint256 borrowed,
        uint256 principal,
        uint256 netValue
    ) {
        collateral = aToken.balanceOf(address(this));
        borrowed = debtToken.balanceOf(address(this));
        principal = totalPrincipal;
        netValue = collateral > borrowed ? collateral - borrowed : 0;
    }

    // ═══════════════════════════════════════════════════════════════════
    // REAL SHARE PRICE & TVL (Stability DAO pattern)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Real share price accounting for all debt and flash loan fees
     * @return priceWad Share price in WAD (1e18 = 1.0 means 1:1 with USDC)
     * @return trusted Always true for AAVE (on-chain accounting)
     */
    function realSharePrice() external view override returns (uint256 priceWad, bool trusted) {
        uint256 collateral = aToken.balanceOf(address(this));
        uint256 debt = debtToken.balanceOf(address(this));
        uint256 netVal = collateral > debt ? collateral - debt : 0;

        if (totalPrincipal == 0) {
            return (WAD, true);
        }
        priceWad = (netVal * WAD) / totalPrincipal;
        trusted = true;
    }

    /**
     * @notice Real TVL (Total Value Locked) net of all debt
     * @return tvl Net TVL in USDC terms (6 decimals)
     * @return trusted Always true for AAVE (on-chain accounting)
     */
    function realTvl() external view override returns (uint256 tvl, bool trusted) {
        uint256 collateral = aToken.balanceOf(address(this));
        uint256 debt = debtToken.balanceOf(address(this));
        tvl = collateral > debt ? collateral - debt : 0;
        trusted = true;
    }

    // ═══════════════════════════════════════════════════════════════════
    // ADJUST LEVERAGE WITH SHARE PRICE PROTECTION
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Adjust leverage to a new target LTV with share price protection
     * @param newLtvBps New target LTV in basis points
     * @param minSharePrice Minimum share price post-adjustment (WAD). Reverts if breached.
     * @dev Rebalances position to new LTV and validates share price didn't drop
     */
    function adjustLeverage(uint256 newLtvBps, uint256 minSharePrice)
        external
        override
        onlyRole(STRATEGIST_ROLE)
        nonReentrant
        whenNotPaused
    {
        if (newLtvBps < 3000 || newLtvBps > 9000) revert InvalidLTV();

        uint256 oldLtv = targetLtvBps;
        targetLtvBps = newLtvBps;

        // Perform rebalance to new target
        uint256 currentDebt = debtToken.balanceOf(address(this));
        uint256 currentCollateral = aToken.balanceOf(address(this));

        if (currentCollateral > 0) {
            uint256 currentLtv = (currentDebt * BPS) / currentCollateral;

            if (currentLtv < newLtvBps) {
                // Leverage up
                uint256 targetDebt = (currentCollateral * newLtvBps) / BPS;
                uint256 deficit = targetDebt - currentDebt;
                if (deficit > 1e4) {
                    aavePool.flashLoanSimple(
                        address(this),
                        address(usdc),
                        deficit,
                        abi.encode(ACTION_REBALANCE_UP, uint256(0)),
                        0
                    );
                }
            } else if (currentLtv > newLtvBps) {
                // Deleverage
                uint256 targetDebt = (currentCollateral * newLtvBps) / BPS;
                uint256 excess = currentDebt - targetDebt;
                if (excess > 1e4) {
                    aavePool.flashLoanSimple(
                        address(this),
                        address(usdc),
                        excess,
                        abi.encode(ACTION_REBALANCE_DOWN, uint256(0)),
                        0
                    );
                }
            }
        }

        // Share price protection
        if (minSharePrice > 0 && totalPrincipal > 0) {
            uint256 newCollateral = aToken.balanceOf(address(this));
            uint256 newDebt = debtToken.balanceOf(address(this));
            uint256 netVal = newCollateral > newDebt ? newCollateral - newDebt : 0;
            uint256 currentSharePrice = (netVal * WAD) / totalPrincipal;

            if (currentSharePrice < minSharePrice) revert SharePriceTooLow();
        }

        emit ParametersUpdated(newLtvBps, targetLoops);
        emit Rebalanced(oldLtv, newLtvBps, 0);
    }

    /**
     * @notice Current profitability analysis
     * @return profitable Whether leveraged looping is currently profitable
     * @return supplyRateWad Current supply rate (annualized, WAD)
     * @return borrowRateWad Current borrow rate (annualized, WAD)
     * @return netApyWad Net APY after leverage (annualized, WAD)
     */
    function checkProfitability() external view returns (
        bool profitable,
        uint256 supplyRateWad,
        uint256 borrowRateWad,
        int256 netApyWad
    ) {
        (,,,,,
         uint256 liquidityRate,
         uint256 variableBorrowRate,
         ,,,,
        ) = dataProvider.getReserveData(address(usdc));

        supplyRateWad = liquidityRate; // Already in ray (1e27), but AAVE V3 rates are in ray
        borrowRateWad = variableBorrowRate;

        // Calculate effective leverage
        // leverage = 1 / (1 - targetLTV)
        uint256 leverageX1e4 = (BPS * BPS) / (BPS - targetLtvBps); // e.g., 40000 = 4x at 75% LTV

        // Net APY = supply * leverage - borrow * (leverage - 1)
        // All rates in ray (1e27)
        int256 supplyComponent = int256(supplyRateWad) * int256(leverageX1e4) / int256(BPS);
        int256 borrowComponent = int256(borrowRateWad) * int256(leverageX1e4 - BPS) / int256(BPS);
        netApyWad = supplyComponent - borrowComponent;

        // AAVE rates are in RAY (1e27), maxBorrowRateForProfit is in WAD (1e18)
        profitable = netApyWad > 0 && borrowRateWad / 1e9 <= maxBorrowRateForProfit;
    }

    // ═══════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Check if leveraged looping is profitable
     */
    function _isProfitable() internal view returns (bool) {
        (,,,,,
         uint256 liquidityRate,
         uint256 variableBorrowRate,
         ,,,,
        ) = dataProvider.getReserveData(address(usdc));

        // AAVE rates are in RAY (1e27), maxBorrowRateForProfit is in WAD (1e18)
        if (variableBorrowRate / 1e9 > maxBorrowRateForProfit) return false;

        // Calculate net APY
        uint256 leverageX1e4 = (BPS * BPS) / (BPS - targetLtvBps);

        // supply * leverage - borrow * (leverage - 1)
        uint256 supplyComponent = liquidityRate * leverageX1e4 / BPS;
        if (supplyComponent <= variableBorrowRate * (leverageX1e4 - BPS) / BPS) {
            return false;
        }

        return true;
    }

    // ═══════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function setParameters(uint256 _targetLtvBps, uint256 _targetLoops) external onlyRole(STRATEGIST_ROLE) {
        if (_targetLtvBps < 3000 || _targetLtvBps > 9000) revert InvalidLTV();
        if (_targetLoops == 0 || _targetLoops > 20) revert InvalidMaxLoopsParam();

        targetLtvBps = _targetLtvBps;
        targetLoops = _targetLoops;

        emit ParametersUpdated(_targetLtvBps, _targetLoops);
    }

    function setSafetyBuffer(uint256 _safetyBufferBps) external onlyRole(STRATEGIST_ROLE) {
        if (_safetyBufferBps < 200 || _safetyBufferBps > 2000) revert InvalidBuffer();
        safetyBufferBps = _safetyBufferBps;
    }

    function setProfitabilityParams(uint256 _maxBorrowRate, uint256 _minNetApySpread) external onlyRole(STRATEGIST_ROLE) {
        if (_maxBorrowRate > 0.50e18) revert MaxBorrowRateTooHighErr();
        maxBorrowRateForProfit = _maxBorrowRate;
        minNetApySpread = _minNetApySpread;
        emit ProfitabilityParamsUpdated(_maxBorrowRate, _minNetApySpread);
    }

    function setEMode(uint8 _categoryId) external onlyRole(STRATEGIST_ROLE) {
        eModeCategoryId = _categoryId;
        aavePool.setUserEMode(_categoryId);
        emit EModeUpdated(_categoryId);
    }

    function setRewardToken(address _token, bool _allowed) external onlyRole(STRATEGIST_ROLE) {
        if (_token == address(0)) revert ZeroAddress();
        allowedRewardTokens[_token] = _allowed;
        emit RewardTokenToggled(_token, _allowed);
    }

    function setSwapParams(uint24 _feeTier, uint256 _minOutputBps) external onlyRole(STRATEGIST_ROLE) {
        if (_minOutputBps < 8000 || _minOutputBps > BPS) revert SlippageTooHighErr();
        defaultSwapFeeTier = _feeTier;
        minSwapOutputBps = _minOutputBps;
        emit SwapParamsUpdated(_feeTier, _minOutputBps);
    }

    function setActive(bool _active) external onlyRole(STRATEGIST_ROLE) {
        active = _active;
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyTimelock {
        _unpause();
    }

    function recoverToken(address token, uint256 amount) external onlyTimelock {
        if (token == address(usdc) && totalPrincipal > 0) revert CannotRecoverActiveUsdc();
        IERC20(token).safeTransfer(msg.sender, amount);
    }

    // ═══════════════════════════════════════════════════════════════════
    // STORAGE GAP & UPGRADES
    // ═══════════════════════════════════════════════════════════════════

    uint256[35] private __gap;

    function _authorizeUpgrade(address) internal override onlyTimelock {}
}
