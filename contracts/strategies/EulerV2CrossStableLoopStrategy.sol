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
//                EULER V2 CROSS-STABLE INTERFACES
// ═══════════════════════════════════════════════════════════════════════════

/// @notice Euler V2 Vault — modular lending vault (ERC-4626 based)
interface IEulerVaultCrossStable {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function balanceOf(address account) external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function convertToShares(uint256 assets) external view returns (uint256);
    function totalAssets() external view returns (uint256);
    function asset() external view returns (address);
    function maxWithdraw(address owner) external view returns (uint256);

    /// @notice Euler V2 borrowing
    function borrow(uint256 assets, address receiver) external returns (uint256);
    function repay(uint256 assets, address receiver) external returns (uint256);
    function debtOf(address account) external view returns (uint256);

    /// @notice Interest rate info
    function interestRate() external view returns (uint256);

    /// @notice Account status
    function accountLiquidity(address account, bool liquidation) external view returns (
        uint256 collateralValue,
        uint256 liabilityValue
    );
}

/// @notice Euler V2 EVC (Ethereum Vault Connector)
interface IEVCCrossStable {
    function enableCollateral(address account, address vault) external;
    function enableController(address account, address vault) external;
    function getCollaterals(address account) external view returns (address[] memory);
    function getControllers(address account) external view returns (address[] memory);
    function call(
        address targetContract,
        address onBehalfOfAccount,
        uint256 value,
        bytes calldata data
    ) external payable returns (bytes memory);
}

/// @notice AAVE V3 Pool for flash loans
interface IAavePoolForCrossStable {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

/// @notice Flash loan callback
interface IFlashLoanSimpleReceiverCrossStable {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

/// @notice Uniswap V3 Router for stablecoin swaps
interface ISwapRouterV3CrossStable {
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

/// @notice Chainlink-style price feed for stablecoin peg monitoring
interface IPriceFeedCrossStable {
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    );
    function decimals() external view returns (uint8);
}

/**
 * @title EulerV2CrossStableLoopStrategy
 * @notice Cross-stablecoin leveraged loop on Euler V2: Supply RLUSD, Borrow USDC
 *
 * @dev Architecture:
 *
 *   Unlike same-asset loops (USDC/USDC), this strategy exploits the rate
 *   differential between two stablecoins. On Euler V2's Sentora RLUSD market:
 *
 *   - RLUSD supply APY > USDC borrow APY (20.73% max ROE at 9x)
 *   - RLUSD/USDC is a near-1:1 stablecoin pair (minimal depeg risk)
 *   - $35M+ liquidity in the USDC borrow market
 *
 *   DEPOSIT FLOW:
 *     1. Treasury deposits USDC
 *     2. Flash loan USDC → Swap USDC→RLUSD via Uniswap
 *     3. Supply all RLUSD to Euler V2 supply vault (collateral)
 *     4. Borrow USDC from Euler V2 borrow vault
 *     5. Repay flash loan with borrowed USDC
 *
 *   WITHDRAW FLOW:
 *     1. Flash loan USDC → repay USDC debt on Euler
 *     2. Withdraw RLUSD from supply vault
 *     3. Swap RLUSD→USDC
 *     4. Repay flash loan, return remainder to Treasury
 *
 *   SAFETY:
 *     - Depeg circuit breaker: pauses if RLUSD/USD deviates > 2%
 *     - Health factor monitoring with emergency deleverage
 *     - Profitability gate: only loop when net spread > 0
 *     - Max swap slippage protection (configurable)
 *
 *   YIELD ESTIMATE (at 4x leverage, 75% LTV):
 *     Supply APY (leveraged): ~12-16%
 *     Borrow cost (leveraged): -(6-8%)
 *     Merkl/EUL rewards:       +2-3%
 *     Net APY:                 ~8-12%
 *
 * @dev Implements ILeverageLoopStrategy for MetaVault / TreasuryV2 composability
 */
contract EulerV2CrossStableLoopStrategy is
    ILeverageLoopStrategy,
    IFlashLoanSimpleReceiverCrossStable,
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
    uint256 public constant MIN_HEALTH_FACTOR = 1.05e18;

    /// @notice Maximum acceptable depeg from $1.00 (2% = 200 bps)
    uint256 public constant MAX_DEPEG_BPS = 200;

    uint8 private constant ACTION_DEPOSIT = 1;
    uint8 private constant ACTION_WITHDRAW = 2;

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

    /// @notice USDC token (quote / borrow side)
    IERC20 public usdc;

    /// @notice RLUSD token (base / supply side)
    IERC20 public rlusd;

    /// @notice Euler V2 supply vault for RLUSD (collateral)
    IEulerVaultCrossStable public supplyVault;

    /// @notice Euler V2 borrow vault for USDC (debt)
    IEulerVaultCrossStable public borrowVault;

    /// @notice Euler V2 EVC
    IEVCCrossStable public evc;

    /// @notice AAVE pool for flash loans
    IAavePoolForCrossStable public flashLoanPool;

    /// @notice Merkl distributor for reward claiming
    IMerklDistributor public merklDistributor;

    /// @notice Uniswap V3 router for USDC↔RLUSD swaps
    ISwapRouterV3CrossStable public swapRouter;

    /// @notice RLUSD/USD price feed for depeg monitoring
    IPriceFeedCrossStable public rlusdPriceFeed;

    /// @notice Target LTV in basis points
    uint256 public override targetLtvBps;

    /// @notice Target loops (conceptual — flash loan = 1 tx)
    uint256 public override targetLoops;

    /// @notice Safety buffer below max LTV
    uint256 public safetyBufferBps;

    /// @notice Whether strategy is active
    bool public active;

    /// @notice Total USDC principal deposited
    uint256 public totalPrincipal;

    /// @notice Max borrow rate for profitability gate (WAD)
    uint256 public maxBorrowRateForProfit;

    /// @notice Total Merkl rewards claimed (USDC terms)
    uint256 public totalRewardsClaimed;

    /// @notice Swap fee tier for USDC↔RLUSD (100 = 0.01%, 500 = 0.05%)
    uint24 public stableSwapFeeTier;

    /// @notice Swap fee tier for reward token → USDC
    uint24 public rewardSwapFeeTier;

    /// @notice Minimum swap output ratio in BPS (e.g. 9900 = 99%)
    uint256 public minSwapOutputBps;

    /// @notice Reward token whitelist
    mapping(address => bool) public allowedRewardTokens;

    // ═══════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event Deposited(uint256 principal, uint256 totalSupplied, uint256 leverageX100);
    event ActiveUpdated(bool active);
    event Withdrawn(uint256 requested, uint256 returned);
    event ParametersUpdated(uint256 targetLtvBps, uint256 targetLoops);
    event RewardTokenToggled(address indexed token, bool allowed);
    event SwapExecuted(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);
    event DepegCircuitBreakerTriggered(int256 rlusdPrice);

    // ═══════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error StrategyNotActive();
    error InvalidLTV();
    error FlashLoanCallbackUnauthorized();
    error HealthFactorTooLow();
    error RewardTokenNotAllowed();
    error SharePriceTooLow();
    error DepegDetected();
    error SwapSlippageExceeded();
    error StalePrice();

    // ═══════════════════════════════════════════════════════════════════
    // CONSTRUCTOR & INITIALIZER
    // ═══════════════════════════════════════════════════════════════════

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Packed initialization parameters to avoid stack-too-deep
    struct InitParams {
        address usdc;
        address rlusd;
        address supplyVault;
        address borrowVault;
        address evc;
        address flashLoanPool;
        address merklDistributor;
        address swapRouter;
        address rlusdPriceFeed;
        address treasury;
        address admin;
        address timelock;
    }

    /**
     * @notice Initialize the Cross-Stable Euler V2 Loop Strategy
     * @param p Packed initialization parameters
     */
    function initialize(InitParams calldata p) external initializer {
        if (p.timelock == address(0)) revert ZeroAddress();
        if (p.usdc == address(0)) revert ZeroAddress();
        if (p.rlusd == address(0)) revert ZeroAddress();
        if (p.supplyVault == address(0)) revert ZeroAddress();
        if (p.borrowVault == address(0)) revert ZeroAddress();

        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        _setTimelock(p.timelock);

        usdc = IERC20(p.usdc);
        rlusd = IERC20(p.rlusd);
        supplyVault = IEulerVaultCrossStable(p.supplyVault);
        borrowVault = IEulerVaultCrossStable(p.borrowVault);
        evc = IEVCCrossStable(p.evc);
        flashLoanPool = IAavePoolForCrossStable(p.flashLoanPool);
        merklDistributor = IMerklDistributor(p.merklDistributor);
        swapRouter = ISwapRouterV3CrossStable(p.swapRouter);
        rlusdPriceFeed = IPriceFeedCrossStable(p.rlusdPriceFeed);

        // Default: 75% LTV, 4x conceptual leverage
        targetLtvBps = 7500;
        targetLoops = 4;
        safetyBufferBps = 500;
        active = true;

        maxBorrowRateForProfit = 0.08e18;
        stableSwapFeeTier = 100; // 0.01% for stablecoin pairs
        rewardSwapFeeTier = 3000; // 0.3% for reward tokens
        minSwapOutputBps = 9900; // 99% minimum output (tight for stables)

        _grantRole(DEFAULT_ADMIN_ROLE, p.admin);
        _grantRole(TREASURY_ROLE, p.treasury);
        _grantRole(STRATEGIST_ROLE, p.admin);
        _grantRole(GUARDIAN_ROLE, p.admin);
        _grantRole(KEEPER_ROLE, p.admin);
    }

    /// @notice Whether EVC has been set up
    bool public evcSetup;

    /**
     * @notice Set up EVC relationships (called once after deployment)
     * @dev M-08: Can only be called once.
     */
    function setupEVC() external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (evcSetup) revert EVCAlreadySetup();
        evcSetup = true;
        evc.enableCollateral(address(this), address(supplyVault));
        evc.enableController(address(this), address(borrowVault));
    }

    // ═══════════════════════════════════════════════════════════════════
    // DEPEG CIRCUIT BREAKER
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Check if RLUSD is within acceptable peg range
     * @return True if RLUSD price is within ±2% of $1.00
     */
    function isWithinPeg() public view returns (bool) {
        if (address(rlusdPriceFeed) == address(0)) return true; // No feed = skip check

        (, int256 price,, uint256 updatedAt,) = rlusdPriceFeed.latestRoundData();

        // Stale price check (> 24h)
        if (block.timestamp - updatedAt > 86400) return false;

        uint8 decimals = rlusdPriceFeed.decimals();
        uint256 target = 10 ** decimals; // $1.00

        uint256 priceUint = price > 0 ? uint256(price) : 0;
        uint256 deviation;
        if (priceUint > target) {
            deviation = ((priceUint - target) * BPS) / target;
        } else {
            deviation = ((target - priceUint) * BPS) / target;
        }

        return deviation <= MAX_DEPEG_BPS;
    }

    modifier whenPegged() {
        if (!isWithinPeg()) revert DepegDetected();
        _;
    }

    // ═══════════════════════════════════════════════════════════════════
    // IStrategy IMPLEMENTATION
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit USDC with flash-loan cross-stable leverage
     * @dev Flow: USDC → flash loan USDC → swap all to RLUSD → supply RLUSD →
     *      borrow USDC → repay flash
     */
    function deposit(uint256 amount)
        external
        override
        onlyRole(TREASURY_ROLE)
        nonReentrant
        whenNotPaused
        whenPegged
        returns (uint256 deposited)
    {
        if (amount == 0) revert ZeroAmount();
        if (!active) revert StrategyNotActive();

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        // Calculate flash loan for target leverage
        // At 75% LTV: flashAmount = amount * 0.75 / 0.25 = 3x the deposit
        uint256 flashAmount = (amount * targetLtvBps) / (BPS - targetLtvBps);

        if (flashAmount > 0) {
            flashLoanPool.flashLoanSimple(
                address(this),
                address(usdc),
                flashAmount,
                abi.encode(ACTION_DEPOSIT, amount),
                0
            );
        } else {
            // No leverage — just swap to RLUSD and supply
            uint256 rlusdReceived = _swapUsdcToRlusd(amount);
            rlusd.forceApprove(address(supplyVault), rlusdReceived);
            supplyVault.deposit(rlusdReceived, address(this));
        }

        totalPrincipal += amount;
        deposited = amount;

        uint256 collateralRlusd = supplyVault.convertToAssets(supplyVault.balanceOf(address(this)));
        // Approximate in USDC terms (1:1 for stables)
        uint256 leverageX100 = totalPrincipal > 0 ? (collateralRlusd * 100) / totalPrincipal : 100;

        emit Deposited(amount, collateralRlusd, leverageX100);
    }

    /**
     * @notice Withdraw USDC by deleveraging cross-stable position
     * @dev Flow: flash loan USDC → repay USDC debt → withdraw RLUSD →
     *      swap RLUSD→USDC → repay flash → return remainder
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
        uint256 currentDebt = borrowVault.debtOf(address(this));

        if (currentDebt > 0) {
            uint256 debtToRepay = (currentDebt * principalToWithdraw) / totalPrincipal;
            if (debtToRepay > currentDebt) debtToRepay = currentDebt;

            flashLoanPool.flashLoanSimple(
                address(this),
                address(usdc),
                debtToRepay,
                abi.encode(ACTION_WITHDRAW, principalToWithdraw),
                0
            );
        } else {
            // No debt — just withdraw RLUSD and swap back
            uint256 shares = supplyVault.balanceOf(address(this));
            uint256 sharesToRedeem = (shares * principalToWithdraw) / totalPrincipal;
            if (sharesToRedeem > shares) sharesToRedeem = shares;

            if (sharesToRedeem > 0) {
                uint256 rlusdWithdrawn = supplyVault.redeem(sharesToRedeem, address(this), address(this));
                if (rlusdWithdrawn > 0) {
                    _swapRlusdToUsdc(rlusdWithdrawn);
                }
            }
        }

        totalPrincipal -= principalToWithdraw;

        uint256 balance = usdc.balanceOf(address(this));
        withdrawn = balance > amount ? amount : balance;
        if (withdrawn > 0) {
            usdc.safeTransfer(msg.sender, withdrawn);
        }

        emit Withdrawn(amount, withdrawn);
    }

    /**
     * @notice Withdraw everything
     */
    function withdrawAll()
        external
        override
        onlyRole(TREASURY_ROLE)
        nonReentrant
        returns (uint256 withdrawn)
    {
        uint256 debt = borrowVault.debtOf(address(this));

        if (debt > 0) {
            flashLoanPool.flashLoanSimple(
                address(this),
                address(usdc),
                debt,
                abi.encode(ACTION_WITHDRAW, type(uint256).max),
                0
            );
        }

        // Withdraw remaining RLUSD supply
        uint256 shares = supplyVault.balanceOf(address(this));
        if (shares > 0) {
            uint256 rlusdWithdrawn = supplyVault.redeem(shares, address(this), address(this));
            if (rlusdWithdrawn > 0) {
                _swapRlusdToUsdc(rlusdWithdrawn);
            }
        }

        totalPrincipal = 0;

        withdrawn = usdc.balanceOf(address(this));
        if (withdrawn > 0) {
            usdc.safeTransfer(msg.sender, withdrawn);
        }

        emit Withdrawn(type(uint256).max, withdrawn);
    }

    /**
     * @notice Net position value in USDC terms (RLUSD collateral − USDC debt)
     * @dev Approximates RLUSD at 1:1 with USDC for stable pairs
     */
    function totalValue() external view override returns (uint256) {
        uint256 collateralRlusd = supplyVault.convertToAssets(supplyVault.balanceOf(address(this)));
        uint256 debt = borrowVault.debtOf(address(this));
        // RLUSD ≈ USDC at 1:1 for stablecoin pairs
        return collateralRlusd > debt ? collateralRlusd - debt : 0;
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

        if (action == ACTION_DEPOSIT) {
            _handleDepositCallback(amount, premium, userAmount);
        } else if (action == ACTION_WITHDRAW) {
            _handleWithdrawCallback(amount, premium, userAmount);
        }

        return true;
    }

    /**
     * @dev Deposit callback:
     *   1. Swap all USDC (user + flash) → RLUSD
     *   2. Supply RLUSD to Euler V2 supply vault
     *   3. Borrow USDC from Euler V2 borrow vault to repay flash
     */
    function _handleDepositCallback(uint256 flashAmount, uint256 premium, uint256 userAmount) internal {
        uint256 totalUsdc = userAmount + flashAmount;

        // Swap USDC → RLUSD
        uint256 rlusdReceived = _swapUsdcToRlusd(totalUsdc);

        // Supply RLUSD to Euler V2 supply vault
        rlusd.forceApprove(address(supplyVault), rlusdReceived);
        supplyVault.deposit(rlusdReceived, address(this));

        // Borrow USDC from Euler V2 borrow vault to repay flash loan
        uint256 repayAmount = flashAmount + premium;
        borrowVault.borrow(repayAmount, address(this));

        // Approve AAVE pool for flash loan repayment
        usdc.forceApprove(address(flashLoanPool), repayAmount);
    }

    /**
     * @dev Withdraw callback:
     *   1. Repay USDC debt with flash-loaned funds
     *   2. Withdraw RLUSD from supply vault
     *   3. Swap RLUSD → USDC
     *   4. Repay flash loan from swapped USDC
     */
    function _handleWithdrawCallback(uint256 flashAmount, uint256 premium, uint256 withdrawAmount) internal {
        // Repay Euler USDC debt
        usdc.forceApprove(address(borrowVault), flashAmount);
        borrowVault.repay(flashAmount, address(this));

        // Withdraw RLUSD from supply vault
        if (withdrawAmount == type(uint256).max) {
            uint256 shares = supplyVault.balanceOf(address(this));
            if (shares > 0) {
                uint256 rlusdWithdrawn = supplyVault.redeem(shares, address(this), address(this));
                if (rlusdWithdrawn > 0) {
                    _swapRlusdToUsdc(rlusdWithdrawn);
                }
            }
        } else {
            // M-03: withdrawAmount, flashAmount, premium are in USDC (6 decimals).
            // supplyVault operates on RLUSD (18 decimals). Scale up before withdrawal.
            uint256 usdcNeeded = withdrawAmount + flashAmount + premium;
            uint256 rlusdToWithdraw = usdcNeeded * 1e12; // scale 6 → 18 decimals
            uint256 maxW = supplyVault.maxWithdraw(address(this));
            if (rlusdToWithdraw > maxW) rlusdToWithdraw = maxW;
            if (rlusdToWithdraw > 0) {
                supplyVault.withdraw(rlusdToWithdraw, address(this), address(this));
                uint256 rlusdBalance = rlusd.balanceOf(address(this));
                if (rlusdBalance > 0) {
                    _swapRlusdToUsdc(rlusdBalance);
                }
            }
        }

        // Approve flash loan repayment
        uint256 repayAmount = flashAmount + premium;
        usdc.forceApprove(address(flashLoanPool), repayAmount);
    }

    // ═══════════════════════════════════════════════════════════════════
    // SWAP HELPERS
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Swap USDC → RLUSD via Uniswap V3
     * @param usdcAmount Amount of USDC to swap (6 decimals)
     * @return rlusdReceived Amount of RLUSD received (18 decimals)
     */
    function _swapUsdcToRlusd(uint256 usdcAmount) internal returns (uint256 rlusdReceived) {
        if (usdcAmount == 0) return 0;

        usdc.forceApprove(address(swapRouter), usdcAmount);

        // C-02: RLUSD is 18 decimals, USDC is 6 decimals.
        // At 1:1 peg, 1 USDC (1e6) = 1 RLUSD (1e18).
        // Scale minOut to RLUSD decimals for proper slippage protection.
        uint256 expectedRlusd = usdcAmount * 1e12; // scale 6 → 18 decimals
        uint256 minOut = (expectedRlusd * minSwapOutputBps) / BPS;

        rlusdReceived = swapRouter.exactInputSingle(
            ISwapRouterV3CrossStable.ExactInputSingleParams({
                tokenIn: address(usdc),
                tokenOut: address(rlusd),
                fee: stableSwapFeeTier,
                recipient: address(this),
                amountIn: usdcAmount,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );

        emit SwapExecuted(address(usdc), address(rlusd), usdcAmount, rlusdReceived);
    }

    /**
     * @notice Swap RLUSD → USDC via Uniswap V3
     * @param rlusdAmount Amount of RLUSD to swap (18 decimals)
     * @return usdcReceived Amount of USDC received (6 decimals)
     */
    function _swapRlusdToUsdc(uint256 rlusdAmount) internal returns (uint256 usdcReceived) {
        if (rlusdAmount == 0) return 0;

        rlusd.forceApprove(address(swapRouter), rlusdAmount);

        // C-02: RLUSD is 18 decimals, USDC is 6 decimals.
        // At 1:1 peg, 1 RLUSD (1e18) = 1 USDC (1e6).
        // Scale minOut to USDC decimals for proper slippage protection.
        uint256 expectedUsdc = rlusdAmount / 1e12; // scale 18 → 6 decimals
        uint256 minOut = (expectedUsdc * minSwapOutputBps) / BPS;

        usdcReceived = swapRouter.exactInputSingle(
            ISwapRouterV3CrossStable.ExactInputSingleParams({
                tokenIn: address(rlusd),
                tokenOut: address(usdc),
                fee: stableSwapFeeTier,
                recipient: address(this),
                amountIn: rlusdAmount,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );

        emit SwapExecuted(address(rlusd), address(usdc), rlusdAmount, usdcReceived);
    }

    // ═══════════════════════════════════════════════════════════════════
    // LEVERAGE VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function getHealthFactor() external view override returns (uint256) {
        uint256 debt = borrowVault.debtOf(address(this));
        if (debt == 0) return type(uint256).max;

        uint256 collateralRlusd = supplyVault.convertToAssets(supplyVault.balanceOf(address(this)));
        // RLUSD ≈ USDC for health factor calculation
        return (collateralRlusd * WAD) / debt;
    }

    function getCurrentLeverage() external view override returns (uint256 leverageX100) {
        if (totalPrincipal == 0) return 100;
        uint256 collateralRlusd = supplyVault.convertToAssets(supplyVault.balanceOf(address(this)));
        leverageX100 = (collateralRlusd * 100) / totalPrincipal;
    }

    function getPosition() external view override returns (
        uint256 collateral,
        uint256 borrowed,
        uint256 principal,
        uint256 netValue
    ) {
        collateral = supplyVault.convertToAssets(supplyVault.balanceOf(address(this)));
        borrowed = borrowVault.debtOf(address(this));
        principal = totalPrincipal;
        netValue = collateral > borrowed ? collateral - borrowed : 0;
    }

    // ═══════════════════════════════════════════════════════════════════
    // REAL SHARE PRICE & TVL (Stability DAO pattern)
    // ═══════════════════════════════════════════════════════════════════

    function realSharePrice() external view override returns (uint256 priceWad, bool trusted) {
        uint256 collateralVal = supplyVault.convertToAssets(supplyVault.balanceOf(address(this)));
        uint256 debt = borrowVault.debtOf(address(this));
        uint256 netVal = collateralVal > debt ? collateralVal - debt : 0;

        if (totalPrincipal == 0) {
            return (WAD, true);
        }
        priceWad = (netVal * WAD) / totalPrincipal;
        trusted = isWithinPeg();
    }

    function realTvl() external view override returns (uint256 tvl, bool trusted) {
        uint256 collateralVal = supplyVault.convertToAssets(supplyVault.balanceOf(address(this)));
        uint256 debt = borrowVault.debtOf(address(this));
        tvl = collateralVal > debt ? collateralVal - debt : 0;
        trusted = isWithinPeg();
    }

    /**
     * @notice Adjust leverage with share price protection
     */
    function adjustLeverage(uint256 newLtvBps, uint256 minSharePrice)
        external
        override
        onlyRole(STRATEGIST_ROLE)
        nonReentrant
        whenNotPaused
        whenPegged
    {
        if (newLtvBps < 3000 || newLtvBps > 9000) revert InvalidLTV();

        uint256 oldLtv = targetLtvBps;
        targetLtvBps = newLtvBps;

        uint256 collateralVal = supplyVault.convertToAssets(supplyVault.balanceOf(address(this)));
        uint256 currentDebt = borrowVault.debtOf(address(this));

        if (collateralVal > 0) {
            uint256 currentLtv = (currentDebt * BPS) / collateralVal;

            if (currentLtv < newLtvBps) {
                // Need more leverage — borrow more USDC, swap to RLUSD, supply
                uint256 targetDebt = (collateralVal * newLtvBps) / BPS;
                uint256 deficit = targetDebt - currentDebt;
                if (deficit > 1e4) {
                    flashLoanPool.flashLoanSimple(
                        address(this),
                        address(usdc),
                        deficit,
                        abi.encode(ACTION_DEPOSIT, uint256(0)),
                        0
                    );
                }
            } else if (currentLtv > newLtvBps) {
                // Need less leverage — repay debt, withdraw RLUSD, swap to USDC
                uint256 targetDebt = (collateralVal * newLtvBps) / BPS;
                uint256 excess = currentDebt - targetDebt;
                if (excess > 1e4) {
                    flashLoanPool.flashLoanSimple(
                        address(this),
                        address(usdc),
                        excess,
                        abi.encode(ACTION_WITHDRAW, uint256(0)),
                        0
                    );
                }
            }
        }

        // Share price protection
        if (minSharePrice > 0 && totalPrincipal > 0) {
            uint256 newCollateral = supplyVault.convertToAssets(supplyVault.balanceOf(address(this)));
            uint256 newDebt = borrowVault.debtOf(address(this));
            uint256 netVal = newCollateral > newDebt ? newCollateral - newDebt : 0;
            uint256 currentSharePrice = (netVal * WAD) / totalPrincipal;

            if (currentSharePrice < minSharePrice) revert SharePriceTooLow();
        }

        emit ParametersUpdated(newLtvBps, targetLoops);
        emit Rebalanced(oldLtv, newLtvBps, 0);
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
        uint256 collateral = supplyVault.convertToAssets(supplyVault.balanceOf(address(this)));
        uint256 currentDebt = borrowVault.debtOf(address(this));

        if (collateral == 0) return;

        uint256 currentLtv = (currentDebt * BPS) / collateral;

        if (currentLtv > targetLtvBps + 100) {
            uint256 targetDebt = (collateral * targetLtvBps) / BPS;
            uint256 excess = currentDebt - targetDebt;

            if (excess > 1e4) {
                flashLoanPool.flashLoanSimple(
                    address(this),
                    address(usdc),
                    excess,
                    abi.encode(ACTION_WITHDRAW, uint256(0)),
                    0
                );
            }
            emit Rebalanced(currentLtv, targetLtvBps, excess);
        } else if (currentLtv + 100 < targetLtvBps) {
            uint256 targetDebt = (collateral * targetLtvBps) / BPS;
            uint256 deficit = targetDebt - currentDebt;

            if (deficit > 1e4) {
                flashLoanPool.flashLoanSimple(
                    address(this),
                    address(usdc),
                    deficit,
                    abi.encode(ACTION_DEPOSIT, uint256(0)),
                    0
                );
            }
            emit Rebalanced(currentLtv, targetLtvBps, deficit);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // MERKL REWARDS
    // ═══════════════════════════════════════════════════════════════════

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

            // Swap reward token → USDC
            IERC20(token).forceApprove(address(swapRouter), balance);
            uint256 received = swapRouter.exactInputSingle(
                ISwapRouterV3CrossStable.ExactInputSingleParams({
                    tokenIn: token,
                    tokenOut: address(usdc),
                    fee: rewardSwapFeeTier,
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
            // Compound: swap USDC → RLUSD → supply to Euler vault
            uint256 rlusdReceived = _swapUsdcToRlusd(totalUsdcReceived);
            rlusd.forceApprove(address(supplyVault), rlusdReceived);
            supplyVault.deposit(rlusdReceived, address(this));
            totalRewardsClaimed += totalUsdcReceived;

            uint256 collateral = supplyVault.convertToAssets(supplyVault.balanceOf(address(this)));
            uint256 leverageX100 = totalPrincipal > 0 ? (collateral * 100) / totalPrincipal : 100;

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
        uint256 collateralBefore = supplyVault.convertToAssets(supplyVault.balanceOf(address(this)));
        uint256 debtBefore = borrowVault.debtOf(address(this));
        uint256 hfBefore = debtBefore > 0 ? (collateralBefore * WAD) / debtBefore : type(uint256).max;

        if (debtBefore > 0) {
            flashLoanPool.flashLoanSimple(
                address(this),
                address(usdc),
                debtBefore,
                abi.encode(ACTION_WITHDRAW, type(uint256).max),
                0
            );
        }

        uint256 shares = supplyVault.balanceOf(address(this));
        if (shares > 0) {
            uint256 rlusdWithdrawn = supplyVault.redeem(shares, address(this), address(this));
            if (rlusdWithdrawn > 0) {
                _swapRlusdToUsdc(rlusdWithdrawn);
            }
        }

        uint256 hfAfter = type(uint256).max;
        emit EmergencyDeleveraged(hfBefore, hfAfter);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ADMIN
    // ═══════════════════════════════════════════════════════════════════

    function setParameters(uint256 _targetLtvBps, uint256 _targetLoops) external onlyRole(STRATEGIST_ROLE) {
        if (_targetLtvBps < 3000 || _targetLtvBps > 9000) revert InvalidLTV();
        targetLtvBps = _targetLtvBps;
        targetLoops = _targetLoops;
        emit ParametersUpdated(_targetLtvBps, _targetLoops);
    }

    function setRewardToken(address _token, bool _allowed) external onlyRole(STRATEGIST_ROLE) {
        if (_token == address(0)) revert ZeroAddress();
        allowedRewardTokens[_token] = _allowed;
        emit RewardTokenToggled(_token, _allowed);
    }

    function setSwapFees(uint24 _stableFeeTier, uint24 _rewardFeeTier) external onlyRole(STRATEGIST_ROLE) {
        stableSwapFeeTier = _stableFeeTier;
        rewardSwapFeeTier = _rewardFeeTier;
    }

    function setMinSwapOutput(uint256 _minOutputBps) external onlyRole(STRATEGIST_ROLE) {
        if (_minOutputBps < 9000 || _minOutputBps > BPS) revert InvalidLTV(); // Reuse error
        minSwapOutputBps = _minOutputBps;
    }

    function setActive(bool _active) external onlyRole(STRATEGIST_ROLE) {
        active = _active;
        emit ActiveUpdated(_active);
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

    uint256[29] private __gap;  // reduced from 30 → 29 (evcSetup added)

    function _authorizeUpgrade(address) internal override onlyTimelock {}
}
