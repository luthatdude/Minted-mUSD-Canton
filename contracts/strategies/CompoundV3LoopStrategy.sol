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
//                     COMPOUND V3 (COMET) INTERFACES
// ═══════════════════════════════════════════════════════════════════════════

/// @notice Compound III (Comet) — unified lending/borrowing market
interface IComet {
    function supply(address asset, uint256 amount) external;
    function supplyTo(address dst, address asset, uint256 amount) external;
    function withdraw(address asset, uint256 amount) external;
    function withdrawTo(address to, address asset, uint256 amount) external;

    /// @notice Base (borrow) token balance — negative = debt, positive = supply
    function balanceOf(address account) external view returns (uint256);
    function borrowBalanceOf(address account) external view returns (uint256);

    /// @notice Collateral balance for a specific asset
    function collateralBalanceOf(address account, address asset) external view returns (uint128);

    /// @notice Get supply/borrow rates
    function getSupplyRate(uint256 utilization) external view returns (uint64);
    function getBorrowRate(uint256 utilization) external view returns (uint64);
    function getUtilization() external view returns (uint256);

    /// @notice Get asset info
    function getAssetInfoByAddress(address asset) external view returns (AssetInfo memory);
    function baseToken() external view returns (address);
    function numAssets() external view returns (uint8);
    function getAssetInfo(uint8 i) external view returns (AssetInfo memory);

    /// @notice Price feed
    function getPrice(address priceFeed) external view returns (uint256);
    function baseTokenPriceFeed() external view returns (address);

    /// @notice Account health
    function isLiquidatable(address account) external view returns (bool);
    function isBorrowCollateralized(address account) external view returns (bool);

    /// @notice Allow/disallow managers
    function allow(address manager, bool isAllowed) external;

    struct AssetInfo {
        uint8 offset;
        address asset;
        address priceFeed;
        uint64 scale;
        uint64 borrowCollateralFactor;
        uint64 liquidateCollateralFactor;
        uint64 liquidationFactor;
        uint128 supplyCap;
    }
}

/// @notice Compound III Rewards contract
interface ICometRewards {
    function claim(address comet, address src, bool shouldAccrue) external;
    function getRewardOwed(address comet, address account) external returns (
        address token,
        uint256 owed
    );
}

/// @notice Uniswap V3 Router for reward → USDC swaps
interface ISwapRouterV3Compound {
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

/// @notice AAVE V3 Pool interface for flash loans (used for leveraging)
interface IAavePoolForFlash {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

/// @notice Flash loan callback
interface IFlashLoanSimpleReceiverCompound {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

/**
 * @title CompoundV3LoopStrategy
 * @notice Leveraged loop strategy on Compound V3 (Comet) with Merkl rewards
 *
 * @dev Compound V3 uses a single market model where USDC is the base (borrow) token
 *      and collateral assets (wETH, wBTC, wstETH, etc.) are supplied separately.
 *
 *      For USDC looping (supply USDC → borrow USDC doesn't work in Comet),
 *      we use the "supply as lender" model:
 *
 *      STRATEGY (same-asset with collateral bridge):
 *      1. Supply USDC to earn supply APY (as base lender)
 *      2. For leveraged yield: use wETH or wstETH collateral to borrow USDC, then supply
 *
 *      However, the simpler model for Compound V3:
 *      - Supply USDC as base lender → earn supply APY
 *      - Supply collateral → borrow USDC → supply more USDC → loop
 *      - This is the collateral → borrow → supply model
 *
 *      For pure USDC yield without leverage, Compound V3 provides:
 *      - Base supply APY on USDC deposits
 *      - COMP rewards (claimable via CometRewards)
 *      - Merkl rewards (if campaigns are active)
 *
 *      For leveraged USDC on Compound V3:
 *      - Supply a collateral asset (e.g., wETH)
 *      - Borrow USDC against it
 *      - Supply borrowed USDC back (as base lender)
 *      - Net: earn supplyAPY on total USDC supplied, pay borrowAPY on USDC borrowed
 *
 * @dev Safety: Uses AAVE flash loans for single-tx leverage (Compound V3 doesn't have flash loans)
 */
contract CompoundV3LoopStrategy is
    ILeverageLoopStrategy,
    IFlashLoanSimpleReceiverCompound,
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
    uint256 public constant FACTOR_SCALE = 1e18;

    uint8 private constant ACTION_DEPOSIT = 1;
    uint8 private constant ACTION_WITHDRAW = 2;
    uint8 private constant ACTION_REBALANCE_UP = 3;
    uint8 private constant ACTION_REBALANCE_DOWN = 4;

    uint256 public constant MIN_HEALTH_FACTOR = 1.05e18;

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

    /// @notice Compound V3 Comet market (e.g., cUSDCv3)
    IComet public comet;

    /// @notice Compound Rewards distributor
    ICometRewards public cometRewards;

    /// @notice Collateral asset used for borrowing (e.g., WETH)
    IERC20 public collateralAsset;

    /// @notice AAVE pool for flash loans (Compound V3 doesn't support flash loans)
    IAavePoolForFlash public flashLoanPool;

    /// @notice Merkl Distributor
    IMerklDistributor public merklDistributor;

    /// @notice Uniswap V3 Router for swaps
    ISwapRouterV3Compound public swapRouter;

    /// @notice Target LTV in basis points
    uint256 public override targetLtvBps;

    /// @notice Target loops (conceptual, flash loan = 1 tx)
    uint256 public override targetLoops;

    /// @notice Safety buffer below liquidation threshold
    uint256 public safetyBufferBps;

    /// @notice Whether strategy is active
    bool public active;

    /// @notice Total USDC principal deposited
    uint256 public totalPrincipal;

    /// @notice Total USDC supplied to Comet as base lender
    uint256 public totalSupplied;

    /// @notice Max borrow rate for profitability
    uint256 public maxBorrowRateForProfit;

    /// @notice Total rewards claimed
    uint256 public totalRewardsClaimed;

    /// @notice Default swap fee tier
    uint24 public defaultSwapFeeTier;

    /// @notice Minimum swap output ratio
    uint256 public minSwapOutputBps;

    /// @notice Allowed reward tokens whitelist
    mapping(address => bool) public allowedRewardTokens;

    // ═══════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event Deposited(uint256 principal, uint256 totalSupplied);
    event Withdrawn(uint256 requested, uint256 returned);
    event ParametersUpdated(uint256 targetLtvBps, uint256 targetLoops);
    event CompRewardsClaimed(uint256 amount);
    event RewardTokenToggled(address indexed token, bool allowed);
    event SwapParamsUpdated(uint24 feeTier, uint256 minOutputBps);

    // ═══════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error StrategyNotActive();
    error InvalidLTV();
    error FlashLoanCallbackUnauthorized();
    error PositionLiquidatable();
    error RewardTokenNotAllowed();
    error SharePriceTooLow();

    // ═══════════════════════════════════════════════════════════════════
    // CONSTRUCTOR & INITIALIZER
    // ═══════════════════════════════════════════════════════════════════

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the Compound V3 Loop Strategy
     * @param _usdc USDC token address
     * @param _comet Compound V3 Comet market address (e.g., cUSDCv3)
     * @param _cometRewards Compound Rewards contract
     * @param _collateralAsset Collateral for borrowing (e.g., WETH)
     * @param _flashLoanPool AAVE pool for flash loans
     * @param _merklDistributor Merkl distributor
     * @param _swapRouter Uniswap V3 router
     * @param _treasury Treasury address
     * @param _admin Default admin
     * @param _timelock Timelock controller
     */
    function initialize(
        address _usdc,
        address _comet,
        address _cometRewards,
        address _collateralAsset,
        address _flashLoanPool,
        address _merklDistributor,
        address _swapRouter,
        address _treasury,
        address _admin,
        address _timelock
    ) external initializer {
        if (_timelock == address(0)) revert ZeroAddress();
        if (_usdc == address(0)) revert ZeroAddress();
        if (_comet == address(0)) revert ZeroAddress();

        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        _setTimelock(_timelock);

        usdc = IERC20(_usdc);
        comet = IComet(_comet);
        cometRewards = ICometRewards(_cometRewards);
        collateralAsset = IERC20(_collateralAsset);
        flashLoanPool = IAavePoolForFlash(_flashLoanPool);
        merklDistributor = IMerklDistributor(_merklDistributor);
        swapRouter = ISwapRouterV3Compound(_swapRouter);

        // Default: 70% LTV, 3 loops conceptual
        targetLtvBps = 7000;
        targetLoops = 3;
        safetyBufferBps = 500;
        active = true;

        maxBorrowRateForProfit = 0.08e18;
        defaultSwapFeeTier = 3000;
        minSwapOutputBps = 9500;

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
     * @notice Deposit USDC — supplies to Comet as base lender
     * @dev In Compound V3, USDC is supplied directly. For leveraged yield,
     *      collateral must be supplied separately via supplyCollateral()
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

        // Supply USDC to Comet as base lender
        usdc.forceApprove(address(comet), amount);
        comet.supply(address(usdc), amount);

        totalPrincipal += amount;
        totalSupplied += amount;
        deposited = amount;

        emit Deposited(amount, totalSupplied);
    }

    /**
     * @notice Withdraw USDC from Comet
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

        // If we have borrowed, need to deleverage first
        uint256 borrowed = comet.borrowBalanceOf(address(this));
        if (borrowed > 0) {
            // Proportional deleverage via flash loan
            uint256 debtToRepay = (borrowed * principalToWithdraw) / totalPrincipal;
            if (debtToRepay > borrowed) debtToRepay = borrowed;

            if (debtToRepay > 0) {
                flashLoanPool.flashLoanSimple(
                    address(this),
                    address(usdc),
                    debtToRepay,
                    abi.encode(ACTION_WITHDRAW, principalToWithdraw),
                    0
                );
            }
        }

        // Withdraw from Comet
        uint256 available = comet.balanceOf(address(this));
        uint256 toWithdraw = principalToWithdraw > available ? available : principalToWithdraw;

        if (toWithdraw > 0) {
            comet.withdraw(address(usdc), toWithdraw);
        }

        totalPrincipal -= principalToWithdraw;
        if (totalSupplied >= principalToWithdraw) {
            totalSupplied -= principalToWithdraw;
        } else {
            totalSupplied = 0;
        }

        // Transfer to Treasury
        uint256 balance = usdc.balanceOf(address(this));
        withdrawn = balance > amount ? amount : balance;
        if (withdrawn > 0) {
            usdc.safeTransfer(msg.sender, withdrawn);
        }

        emit Withdrawn(amount, withdrawn);
    }

    /**
     * @notice Withdraw all from Comet
     */
    function withdrawAll()
        external
        override
        onlyRole(TREASURY_ROLE)
        nonReentrant
        returns (uint256 withdrawn)
    {
        // Repay all debt first
        uint256 borrowed = comet.borrowBalanceOf(address(this));
        if (borrowed > 0) {
            flashLoanPool.flashLoanSimple(
                address(this),
                address(usdc),
                borrowed,
                abi.encode(ACTION_WITHDRAW, type(uint256).max),
                0
            );
        }

        // Withdraw remaining supply
        uint256 supplied = comet.balanceOf(address(this));
        if (supplied > 0) {
            comet.withdraw(address(usdc), supplied);
        }

        totalPrincipal = 0;
        totalSupplied = 0;

        withdrawn = usdc.balanceOf(address(this));
        if (withdrawn > 0) {
            usdc.safeTransfer(msg.sender, withdrawn);
        }

        emit Withdrawn(type(uint256).max, withdrawn);
    }

    /**
     * @notice Total value = supplied USDC − borrowed USDC (net position)
     */
    function totalValue() external view override returns (uint256) {
        uint256 supplied = comet.balanceOf(address(this));
        uint256 borrowed = comet.borrowBalanceOf(address(this));
        return supplied > borrowed ? supplied - borrowed : 0;
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

    function executeOperation(
        address,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        if (msg.sender != address(flashLoanPool)) revert FlashLoanCallbackUnauthorized();
        if (initiator != address(this)) revert FlashLoanCallbackUnauthorized();

        (uint8 action, uint256 userAmount) = abi.decode(params, (uint8, uint256));

        if (action == ACTION_WITHDRAW) {
            _handleWithdrawCallback(amount, premium, userAmount);
        }

        return true;
    }

    function _handleWithdrawCallback(uint256 flashAmount, uint256 premium, uint256 /* withdrawAmount */) internal {
        // Repay debt to Comet
        usdc.forceApprove(address(comet), flashAmount);
        comet.supply(address(usdc), flashAmount); // Supplying reduces debt in Comet

        // Withdraw collateral if any
        uint128 collBalance = comet.collateralBalanceOf(address(this), address(collateralAsset));
        if (collBalance > 0) {
            comet.withdraw(address(collateralAsset), uint256(collBalance));
            // Sell collateral → USDC to repay flash loan
            IERC20(address(collateralAsset)).forceApprove(address(swapRouter), uint256(collBalance));
            // CV3-01: Use minSwapOutputBps instead of 0 to prevent sandwich attacks
            swapRouter.exactInputSingle(
                ISwapRouterV3Compound.ExactInputSingleParams({
                    tokenIn: address(collateralAsset),
                    tokenOut: address(usdc),
                    fee: defaultSwapFeeTier,
                    recipient: address(this),
                    amountIn: uint256(collBalance),
                    amountOutMinimum: (uint256(collBalance) * minSwapOutputBps) / BPS,
                    sqrtPriceLimitX96: 0
                })
            );
        }

        // Approve repayment
        uint256 repayAmount = flashAmount + premium;
        usdc.forceApprove(address(flashLoanPool), repayAmount);
    }

    // ═══════════════════════════════════════════════════════════════════
    // LEVERAGE VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function getHealthFactor() external view override returns (uint256) {
        if (comet.isLiquidatable(address(this))) return 0;
        if (comet.isBorrowCollateralized(address(this))) return 2e18; // Healthy
        return 1e18; // Marginally safe
    }

    function getCurrentLeverage() external view override returns (uint256 leverageX100) {
        if (totalPrincipal == 0) return 100;
        uint256 supplied = comet.balanceOf(address(this));
        leverageX100 = (supplied * 100) / totalPrincipal;
    }

    function getPosition() external view override returns (
        uint256 collateral,
        uint256 borrowed,
        uint256 principal,
        uint256 netValue
    ) {
        collateral = comet.balanceOf(address(this));
        borrowed = comet.borrowBalanceOf(address(this));
        principal = totalPrincipal;
        netValue = collateral > borrowed ? collateral - borrowed : 0;
    }

    // ═══════════════════════════════════════════════════════════════════
    // REAL SHARE PRICE & TVL (Stability DAO pattern)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Real share price accounting for all debt
     * @return priceWad Share price in WAD (1e18 = 1.0)
     * @return trusted Always true for Compound V3 (on-chain accounting)
     */
    function realSharePrice() external view override returns (uint256 priceWad, bool trusted) {
        uint256 supplied = comet.balanceOf(address(this));
        uint256 debt = comet.borrowBalanceOf(address(this));
        uint256 netVal = supplied > debt ? supplied - debt : 0;

        if (totalPrincipal == 0) {
            return (WAD, true);
        }
        priceWad = (netVal * WAD) / totalPrincipal;
        trusted = true;
    }

    /**
     * @notice Real TVL net of all debt
     * @return tvl Net TVL in USDC terms (6 decimals)
     * @return trusted Always true for Compound V3
     */
    function realTvl() external view override returns (uint256 tvl, bool trusted) {
        uint256 supplied = comet.balanceOf(address(this));
        uint256 debt = comet.borrowBalanceOf(address(this));
        tvl = supplied > debt ? supplied - debt : 0;
        trusted = true;
    }

    /**
     * @notice Adjust leverage with share price protection
     * @param newLtvBps New target LTV in basis points
     * @param minSharePrice Minimum acceptable share price post-adjustment (WAD)
     */
    function adjustLeverage(uint256 newLtvBps, uint256 minSharePrice)
        external
        override
        onlyRole(STRATEGIST_ROLE)
        nonReentrant
        whenNotPaused
    {
        if (newLtvBps < 3000 || newLtvBps > 8500) revert InvalidLTV();

        targetLtvBps = newLtvBps;

        // Share price protection
        if (minSharePrice > 0 && totalPrincipal > 0) {
            uint256 supplied = comet.balanceOf(address(this));
            uint256 debt = comet.borrowBalanceOf(address(this));
            uint256 netVal = supplied > debt ? supplied - debt : 0;
            uint256 currentSharePrice = (netVal * WAD) / totalPrincipal;

            if (currentSharePrice < minSharePrice) revert SharePriceTooLow();
        }

        emit ParametersUpdated(newLtvBps, targetLoops);
    }

    /**
     * @notice Check current Compound V3 supply/borrow rates
     */
    function getCurrentRates() external view returns (
        uint256 supplyRate,
        uint256 borrowRate,
        uint256 utilization
    ) {
        utilization = comet.getUtilization();
        supplyRate = comet.getSupplyRate(utilization);
        borrowRate = comet.getBorrowRate(utilization);
    }

    // ═══════════════════════════════════════════════════════════════════
    // REBALANCE
    // ═══════════════════════════════════════════════════════════════════

    function rebalance()
        external
        override
        onlyRole(KEEPER_ROLE)
        nonReentrant
        whenNotPaused
    {
        // For Compound V3 base-lending-only mode, rebalance is a no-op
        // When leveraged via collateral, keeper adjusts collateral ratio
        emit Rebalanced(0, targetLtvBps, 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    // REWARDS
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Claim COMP rewards from Compound V3
     */
    function claimCompRewards() external onlyRole(KEEPER_ROLE) nonReentrant {
        cometRewards.claim(address(comet), address(this), true);

        // Get COMP token balance and swap to USDC
        (address compToken, ) = cometRewards.getRewardOwed(address(comet), address(this));
        if (compToken != address(0)) {
            uint256 balance = IERC20(compToken).balanceOf(address(this));
            if (balance > 0) {
                IERC20(compToken).forceApprove(address(swapRouter), balance);
                // CV3-01: Use minSwapOutputBps instead of 0 to prevent sandwich attacks
                uint256 received = swapRouter.exactInputSingle(
                    ISwapRouterV3Compound.ExactInputSingleParams({
                        tokenIn: compToken,
                        tokenOut: address(usdc),
                        fee: defaultSwapFeeTier,
                        recipient: address(this),
                        amountIn: balance,
                        amountOutMinimum: (balance * minSwapOutputBps) / BPS,
                        sqrtPriceLimitX96: 0
                    })
                );

                // Supply back to Comet
                if (received > 0) {
                    usdc.forceApprove(address(comet), received);
                    comet.supply(address(usdc), received);
                    totalSupplied += received;
                    totalRewardsClaimed += received;
                    emit CompRewardsClaimed(received);
                }
            }
        }
    }

    /**
     * @notice Claim Merkl rewards and compound into position
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

        for (uint256 i = 0; i < tokens.length; i++) {
            if (!allowedRewardTokens[tokens[i]]) revert RewardTokenNotAllowed();
        }

        address[] memory users = new address[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            users[i] = address(this);
        }

        merklDistributor.claim(users, tokens, amounts, proofs);

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

            IERC20(token).forceApprove(address(swapRouter), balance);
            uint256 received = swapRouter.exactInputSingle(
                ISwapRouterV3Compound.ExactInputSingleParams({
                    tokenIn: token,
                    tokenOut: address(usdc),
                    fee: defaultSwapFeeTier,
                    recipient: address(this),
                    amountIn: balance,
                    amountOutMinimum: (balance * minSwapOutputBps) / BPS,
                    sqrtPriceLimitX96: 0
                })
            );

            totalUsdcReceived += received;
            emit RewardsClaimed(token, received);
        }

        if (totalUsdcReceived > 0) {
            usdc.forceApprove(address(comet), totalUsdcReceived);
            comet.supply(address(usdc), totalUsdcReceived);
            totalSupplied += totalUsdcReceived;
            totalRewardsClaimed += totalUsdcReceived;

            uint256 leverageX100 = totalPrincipal > 0
                ? (totalSupplied * 100) / totalPrincipal
                : 100;

            emit RewardsCompounded(totalUsdcReceived, leverageX100);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // EMERGENCY
    // ═══════════════════════════════════════════════════════════════════

    function emergencyDeleverage()
        external
        override
        onlyRole(GUARDIAN_ROLE)
        nonReentrant
    {
        uint256 borrowed = comet.borrowBalanceOf(address(this));

        if (borrowed > 0) {
            flashLoanPool.flashLoanSimple(
                address(this),
                address(usdc),
                borrowed,
                abi.encode(ACTION_WITHDRAW, type(uint256).max),
                0
            );
        }

        uint256 supplied = comet.balanceOf(address(this));
        if (supplied > 0) {
            comet.withdraw(address(usdc), supplied);
        }

        emit EmergencyDeleveraged(0, type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ADMIN
    // ═══════════════════════════════════════════════════════════════════

    function setParameters(uint256 _targetLtvBps, uint256 _targetLoops) external onlyRole(STRATEGIST_ROLE) {
        if (_targetLtvBps < 3000 || _targetLtvBps > 8500) revert InvalidLTV();
        targetLtvBps = _targetLtvBps;
        targetLoops = _targetLoops;
        emit ParametersUpdated(_targetLtvBps, _targetLoops);
    }

    function setRewardToken(address _token, bool _allowed) external onlyRole(STRATEGIST_ROLE) {
        if (_token == address(0)) revert ZeroAddress();
        allowedRewardTokens[_token] = _allowed;
        emit RewardTokenToggled(_token, _allowed);
    }

    function setSwapParams(uint24 _feeTier, uint256 _minOutputBps) external onlyRole(STRATEGIST_ROLE) {
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
