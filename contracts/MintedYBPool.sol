// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interfaces/IYieldBasis.sol";
import "./interfaces/IUniswapV3.sol";
import "./TimelockGoverned.sol";
import "./Errors.sol";

/**
 * @title MintedYBPool
 * @notice Minted-owned Yield Basis pool that replaces external YB pools
 * @dev Implements IYieldBasisPool so the existing YieldBasisStrategy and
 *      YBStakingVault require zero changes.
 *
 * Why recreate?
 *   External Yield Basis pools (github.com/yield-basis) have reached capacity
 *   and are not accepting new lender deposits.  By deploying our own pool we
 *   control capacity, fees, tick ranges, and can scale independently.
 *
 * Architecture:
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │                        MintedYBPool                         │
 *   │                                                             │
 *   │  Lenders ─deposit USDC──▶ Share accounting ──▶ Uni V3 LP    │
 *   │          ◀─withdraw────── Value tracking   ◀── Fee harvest  │
 *   │                                                             │
 *   │  LP Manager: concentrated liquidity on Uni V3 (WBTC/USDC   │
 *   │              or WETH/USDC) within configurable tick ranges  │
 *   │                                                             │
 *   │  Yield = Uni V3 trading fees  →  distributed to lenders    │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Capacity:
 *   - maxLenderDeposits: total USDC lenders can deposit (admin-tunable)
 *   - No external dependency on third-party capacity limits
 *
 * Risk controls:
 *   - Configurable tick width (wider = less IL, lower yield)
 *   - Rebalance with timelock on range changes
 *   - Utilization cap: won't deploy more than utilizationTarget of deposits
 *   - Emergency withdraw: pull all liquidity from Uni V3
 *
 * UUPS upgradeable + TimelockGoverned for safe operations
 */
contract MintedYBPool is
    IYieldBasisPool,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    TimelockGoverned
{
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ═══════════════════════════════════════════════════════════════════════
    // ROLES
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Strategist manages LP positions, rebalances, and harvests
    bytes32 public constant STRATEGIST_ROLE = keccak256("STRATEGIST_ROLE");

    /// @notice Guardian can pause in emergencies
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    /// @notice Keeper calls periodic harvest
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    // ═══════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════

    uint256 public constant BPS = 10_000;

    /// @notice Maximum performance fee: 20%
    uint256 public constant MAX_PERFORMANCE_FEE_BPS = 2000;

    /// @notice Minimum rebalance interval to prevent MEV sandwich
    uint256 public constant MIN_REBALANCE_INTERVAL = 30 minutes;

    /// @notice Maximum utilization target: 95%
    uint256 public constant MAX_UTILIZATION_TARGET = 9500;

    /// @notice Precision for APY calculation (18 decimals)
    uint256 public constant APY_PRECISION = 1e18;

    /// @notice Seconds in a year for APY calculation
    uint256 public constant SECONDS_PER_YEAR = 365.25 days;

    // ═══════════════════════════════════════════════════════════════════════
    // IMMUTABLE-ISH (set once in initialize, never changed)
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice The volatile asset: WBTC or WETH
    address public baseToken;

    /// @notice The stablecoin: USDC
    IERC20 public quoteToken;

    /// @notice Uniswap V3 pool for the base/quote pair
    IUniswapV3Pool public uniPool;

    /// @notice Uniswap V3 NFT Position Manager
    INonfungiblePositionManager public positionManager;

    /// @notice Uniswap V3 Swap Router (for rebalancing)
    ISwapRouter public swapRouter;

    /// @notice Uni V3 fee tier (e.g., 3000 = 0.3%, 500 = 0.05%)
    uint24 public feeTier;

    /// @notice Whether USDC is token0 in the Uni V3 pool
    bool public quoteIsToken0;

    // ═══════════════════════════════════════════════════════════════════════
    // LENDER ACCOUNTING
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Per-lender share balance
    mapping(address => uint256) public lenderShareBalance;

    /// @notice Total lender shares outstanding
    uint256 public totalLenderShares;

    /// @notice Total USDC deposited by lenders (before yield)
    uint256 public totalLenderDeposited;

    /// @notice Maximum total lender deposits (capacity we control)
    uint256 public maxLenderDeposits;

    /// @notice Cumulative yield earned by lenders (after fees)
    uint256 public cumulativeLenderYield;

    // ═══════════════════════════════════════════════════════════════════════
    // LP POSITION STATE
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Active Uniswap V3 NFT position ID (0 if none)
    uint256 public activePositionId;

    /// @notice Current tick range boundaries
    int24 public tickLower;
    int24 public tickUpper;

    /// @notice Amount of USDC currently deployed in LP
    uint256 public deployedQuoteAmount;

    /// @notice Amount of base token currently in LP
    uint256 public deployedBaseAmount;

    /// @notice Target utilization: fraction of lender deposits to deploy (BPS)
    uint256 public utilizationTarget;

    /// @notice USDC held idle (not deployed, available for withdrawals)
    uint256 public idleQuoteBalance;

    // ═══════════════════════════════════════════════════════════════════════
    // FEE & YIELD TRACKING
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Performance fee in basis points (taken from yield)
    uint256 public performanceFeeBps;

    /// @notice Accumulated protocol fees (USDC)
    uint256 public accruedProtocolFees;

    /// @notice Fee recipient
    address public feeRecipient;

    /// @notice Last harvest timestamp
    uint256 public lastHarvestTime;

    /// @notice Last rebalance timestamp
    uint256 public lastRebalanceTime;

    /// @notice Cumulative yield for APY tracking
    uint256 public cumulativeYield;
    uint256 public yieldTrackingStartTime;

    // ═══════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event LenderDeposited(address indexed lender, uint256 amount, uint256 shares);
    event LenderWithdrawn(address indexed lender, uint256 shares, uint256 amount);
    event LiquidityDeployed(uint256 tokenId, uint256 quoteAmount, uint256 baseAmount, int24 tickLower, int24 tickUpper);
    event LiquidityRemoved(uint256 tokenId, uint256 quoteReceived, uint256 baseReceived);
    event Harvested(uint256 quoteFees, uint256 baseFees, uint256 lenderYield, uint256 protocolFee);
    event Rebalanced(int24 oldTickLower, int24 oldTickUpper, int24 newTickLower, int24 newTickUpper);
    event CapacityUpdated(uint256 oldCap, uint256 newCap);
    event UtilizationTargetUpdated(uint256 oldTarget, uint256 newTarget);
    event PerformanceFeeUpdated(uint256 oldFee, uint256 newFee);
    event FeeRecipientUpdated(address oldRecipient, address newRecipient);
    event ProtocolFeesWithdrawn(address indexed to, uint256 amount);
    event EmergencyWithdraw(uint256 quoteReceived, uint256 baseReceived);

    // ═══════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error DepositCapReached();
    error PoolNotAcceptingDeposits();
    error InsufficientShares();
    error InsufficientIdle();
    error InvalidTickRange();
    error RebalanceTooFrequent();
    error NoActivePosition();
    error PositionAlreadyActive();
    error InvalidFeeTier();

    // ═══════════════════════════════════════════════════════════════════════
    // INITIALIZER
    // ═══════════════════════════════════════════════════════════════════════

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the Minted YB Pool
     * @param _baseToken WBTC or WETH address
     * @param _quoteToken USDC address
     * @param _uniPool Uniswap V3 pool for the pair
     * @param _positionManager Uniswap V3 NFT Position Manager
     * @param _swapRouter Uniswap V3 Swap Router
     * @param _maxDeposits Initial capacity cap in USDC
     * @param _admin Admin address
     * @param _timelock Timelock controller address
     * @param _feeRecipient Protocol fee recipient
     */
    function initialize(
        address _baseToken,
        address _quoteToken,
        address _uniPool,
        address _positionManager,
        address _swapRouter,
        uint256 _maxDeposits,
        address _admin,
        address _timelock,
        address _feeRecipient
    ) external initializer {
        if (_baseToken == address(0)) revert ZeroAddress();
        if (_quoteToken == address(0)) revert ZeroAddress();
        if (_uniPool == address(0)) revert ZeroAddress();
        if (_positionManager == address(0)) revert ZeroAddress();
        if (_swapRouter == address(0)) revert ZeroAddress();
        if (_admin == address(0)) revert ZeroAddress();
        if (_timelock == address(0)) revert ZeroAddress();
        if (_feeRecipient == address(0)) revert ZeroAddress();
        if (_maxDeposits == 0) revert ZeroAmount();

        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        _setTimelock(_timelock);

        baseToken = _baseToken;
        quoteToken = IERC20(_quoteToken);
        uniPool = IUniswapV3Pool(_uniPool);
        positionManager = INonfungiblePositionManager(_positionManager);
        swapRouter = ISwapRouter(_swapRouter);
        feeTier = IUniswapV3Pool(_uniPool).fee();
        maxLenderDeposits = _maxDeposits;
        feeRecipient = _feeRecipient;

        // Determine token ordering in the Uni V3 pool
        address token0 = IUniswapV3Pool(_uniPool).token0();
        quoteIsToken0 = (token0 == _quoteToken);

        // Sensible defaults
        utilizationTarget = 8000; // Deploy 80% of deposits
        performanceFeeBps = 1000; // 10% performance fee
        yieldTrackingStartTime = block.timestamp;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(STRATEGIST_ROLE, _admin);
        _grantRole(GUARDIAN_ROLE, _admin);
        _grantRole(KEEPER_ROLE, _admin);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // IYieldBasisPool — LENDER DEPOSIT / WITHDRAW
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit USDC as a lender
     * @param amount USDC amount to deposit
     * @param minShares Minimum shares to receive (slippage protection)
     * @return shares Lender shares received
     */
    function depositLend(uint256 amount, uint256 minShares)
        external
        override
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        if (amount == 0) revert ZeroAmount();
        if (!_isAcceptingDeposits()) revert PoolNotAcceptingDeposits();

        uint256 totalValue = _totalLenderValue();

        // Check capacity
        if (totalValue + amount > maxLenderDeposits) revert DepositCapReached();

        // Calculate shares: first depositor gets 1:1, subsequent proportional
        if (totalLenderShares == 0) {
            shares = amount;
        } else {
            shares = amount.mulDiv(totalLenderShares, totalValue, Math.Rounding.Floor);
        }

        if (shares < minShares) revert BelowMin();
        if (shares == 0) revert ZeroOutput();

        // Pull USDC
        quoteToken.safeTransferFrom(msg.sender, address(this), amount);

        // Update state
        lenderShareBalance[msg.sender] += shares;
        totalLenderShares += shares;
        totalLenderDeposited += amount;
        idleQuoteBalance += amount;

        emit LenderDeposited(msg.sender, amount, shares);
    }

    /**
     * @notice Withdraw USDC by redeeming lender shares
     * @param shares Shares to redeem
     * @param minAmount Minimum USDC to receive
     * @return amount USDC amount received
     */
    function withdrawLend(uint256 shares, uint256 minAmount)
        external
        override
        nonReentrant
        whenNotPaused
        returns (uint256 amount)
    {
        if (shares == 0) revert ZeroAmount();
        if (lenderShareBalance[msg.sender] < shares) revert InsufficientShares();

        uint256 totalValue = _totalLenderValue();

        // Calculate USDC value of shares
        amount = shares.mulDiv(totalValue, totalLenderShares, Math.Rounding.Floor);
        if (amount < minAmount) revert BelowMin();

        // Ensure sufficient idle balance — if not, pull from LP
        if (amount > idleQuoteBalance) {
            uint256 deficit = amount - idleQuoteBalance;
            _pullFromLP(deficit);
        }

        // Safety check after potential LP withdrawal
        uint256 available = quoteToken.balanceOf(address(this)) - accruedProtocolFees;
        if (amount > available) {
            amount = available; // Cap at actually available (rounding safety)
        }

        // Update state
        lenderShareBalance[msg.sender] -= shares;
        totalLenderShares -= shares;
        if (amount <= totalLenderDeposited) {
            totalLenderDeposited -= amount;
        } else {
            totalLenderDeposited = 0;
        }
        if (amount <= idleQuoteBalance) {
            idleQuoteBalance -= amount;
        } else {
            idleQuoteBalance = 0;
        }

        // Transfer USDC to lender
        quoteToken.safeTransfer(msg.sender, amount);

        emit LenderWithdrawn(msg.sender, shares, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // IYieldBasisPool — VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    function lenderValue(address account) external view override returns (uint256) {
        if (totalLenderShares == 0) return 0;
        return lenderShareBalance[account].mulDiv(_totalLenderValue(), totalLenderShares, Math.Rounding.Floor);
    }

    function lenderShares(address account) external view override returns (uint256) {
        return lenderShareBalance[account];
    }

    function totalLenderAssets() external view override returns (uint256) {
        return _totalLenderValue();
    }

    function lendingAPY() external view override returns (uint256) {
        uint256 elapsed = block.timestamp - yieldTrackingStartTime;
        if (elapsed == 0 || totalLenderDeposited == 0) return 0;

        // APY = (cumulativeYield / totalDeposited) * (SECONDS_PER_YEAR / elapsed) * 1e18
        return cumulativeYield.mulDiv(
            APY_PRECISION * SECONDS_PER_YEAR,
            totalLenderDeposited * elapsed,
            Math.Rounding.Floor
        );
    }

    function utilization() external view override returns (uint256) {
        uint256 total = _totalLenderValue();
        if (total == 0) return 0;
        return deployedQuoteAmount.mulDiv(BPS, total, Math.Rounding.Floor);
    }

    function baseAsset() external view override returns (address) {
        return baseToken;
    }

    function quoteAsset() external view override returns (address) {
        return address(quoteToken);
    }

    function acceptingDeposits() external view override returns (bool) {
        return _isAcceptingDeposits();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // LP MANAGEMENT — STRATEGIST
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Deploy idle USDC into a Uniswap V3 concentrated liquidity position
     * @dev Creates a new position or adds to existing one.
     *      For BTC/USDC or ETH/USDC LP, we provide single-sided USDC liquidity
     *      within a range where USDC is the dominant asset.
     * @param _tickLower Lower tick boundary
     * @param _tickUpper Upper tick boundary
     * @param quoteAmount USDC amount to deploy
     * @param baseAmount Base token amount to pair (0 for single-sided)
     * @param minQuote Minimum USDC accepted (slippage)
     * @param minBase Minimum base accepted (slippage)
     */
    function deployLiquidity(
        int24 _tickLower,
        int24 _tickUpper,
        uint256 quoteAmount,
        uint256 baseAmount,
        uint256 minQuote,
        uint256 minBase
    ) external nonReentrant onlyRole(STRATEGIST_ROLE) {
        if (quoteAmount == 0 && baseAmount == 0) revert ZeroAmount();
        if (_tickLower >= _tickUpper) revert InvalidTickRange();
        if (quoteAmount > idleQuoteBalance) revert InsufficientIdle();

        // Check utilization limit
        uint256 totalValue = _totalLenderValue();
        uint256 newDeployed = deployedQuoteAmount + quoteAmount;
        if (totalValue > 0 && newDeployed.mulDiv(BPS, totalValue, Math.Rounding.Ceil) > utilizationTarget) {
            revert AboveMax();
        }

        // Determine token0/token1 amounts based on pool ordering
        (uint256 amount0, uint256 amount1, uint256 min0, uint256 min1) = quoteIsToken0
            ? (quoteAmount, baseAmount, minQuote, minBase)
            : (baseAmount, quoteAmount, minBase, minQuote);

        // Approve tokens to position manager
        if (quoteAmount > 0) {
            quoteToken.forceApprove(address(positionManager), quoteAmount);
        }
        if (baseAmount > 0) {
            IERC20(baseToken).forceApprove(address(positionManager), baseAmount);
        }

        if (activePositionId == 0) {
            // Create new position
            (uint256 tokenId, , uint256 actual0, uint256 actual1) = positionManager.mint(
                INonfungiblePositionManager.MintParams({
                    token0: quoteIsToken0 ? address(quoteToken) : baseToken,
                    token1: quoteIsToken0 ? baseToken : address(quoteToken),
                    fee: feeTier,
                    tickLower: _tickLower,
                    tickUpper: _tickUpper,
                    amount0Desired: amount0,
                    amount1Desired: amount1,
                    amount0Min: min0,
                    amount1Min: min1,
                    recipient: address(this),
                    deadline: block.timestamp
                })
            );

            activePositionId = tokenId;
            tickLower = _tickLower;
            tickUpper = _tickUpper;

            uint256 actualQuote = quoteIsToken0 ? actual0 : actual1;
            uint256 actualBase = quoteIsToken0 ? actual1 : actual0;
            deployedQuoteAmount += actualQuote;
            deployedBaseAmount += actualBase;
            idleQuoteBalance -= actualQuote;

            emit LiquidityDeployed(tokenId, actualQuote, actualBase, _tickLower, _tickUpper);
        } else {
            // Add to existing position
            (, uint256 actual0, uint256 actual1) = positionManager.increaseLiquidity(
                INonfungiblePositionManager.IncreaseLiquidityParams({
                    tokenId: activePositionId,
                    amount0Desired: amount0,
                    amount1Desired: amount1,
                    amount0Min: min0,
                    amount1Min: min1,
                    deadline: block.timestamp
                })
            );

            uint256 actualQuote = quoteIsToken0 ? actual0 : actual1;
            uint256 actualBase = quoteIsToken0 ? actual1 : actual0;
            deployedQuoteAmount += actualQuote;
            deployedBaseAmount += actualBase;
            idleQuoteBalance -= actualQuote;

            emit LiquidityDeployed(activePositionId, actualQuote, actualBase, _tickLower, _tickUpper);
        }

        // Clear residual approvals
        quoteToken.forceApprove(address(positionManager), 0);
        if (baseAmount > 0) {
            IERC20(baseToken).forceApprove(address(positionManager), 0);
        }
    }

    /**
     * @notice Remove all liquidity from the active Uni V3 position
     * @dev Collects all fees + removes all liquidity + burns NFT
     */
    function removeLiquidity() external nonReentrant onlyRole(STRATEGIST_ROLE) {
        _removeAllLiquidity();
    }

    /**
     * @notice Harvest trading fees from the active Uni V3 position
     * @dev Collects accrued fees, takes protocol cut, rest goes to lenders
     */
    function harvest() external nonReentrant onlyRole(KEEPER_ROLE) {
        if (activePositionId == 0) revert NoActivePosition();

        // Collect all accrued fees
        (uint256 collected0, uint256 collected1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: activePositionId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        uint256 quoteFees = quoteIsToken0 ? collected0 : collected1;
        uint256 baseFees = quoteIsToken0 ? collected1 : collected0;

        // Convert base fees to USDC via swap (if any)
        if (baseFees > 0) {
            IERC20(baseToken).forceApprove(address(swapRouter), baseFees);
            uint256 quoteFromSwap = swapRouter.exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: baseToken,
                    tokenOut: address(quoteToken),
                    fee: feeTier,
                    recipient: address(this),
                    deadline: block.timestamp,
                    amountIn: baseFees,
                    amountOutMinimum: 0, // Keeper accepts any amount; front-run protection via mempool privacy
                    sqrtPriceLimitX96: 0
                })
            );
            quoteFees += quoteFromSwap;
            IERC20(baseToken).forceApprove(address(swapRouter), 0);
        }

        // Split fees: protocol takes performanceFeeBps, rest to lenders
        uint256 protocolFee = quoteFees.mulDiv(performanceFeeBps, BPS, Math.Rounding.Floor);
        uint256 lenderYield = quoteFees - protocolFee;

        accruedProtocolFees += protocolFee;
        idleQuoteBalance += lenderYield;
        cumulativeLenderYield += lenderYield;
        cumulativeYield += lenderYield;

        lastHarvestTime = block.timestamp;

        emit Harvested(quoteFees, baseFees, lenderYield, protocolFee);
    }

    /**
     * @notice Rebalance the LP position to a new tick range
     * @dev Removes current position, creates new one at updated ticks.
     *      Requires timelock for safety (prevents MEV-abusive range changes).
     * @param _newTickLower New lower tick
     * @param _newTickUpper New upper tick
     * @param quoteAmount USDC to deploy in new position
     * @param baseAmount Base token to deploy
     * @param minQuote Min USDC accepted
     * @param minBase Min base accepted
     */
    function rebalance(
        int24 _newTickLower,
        int24 _newTickUpper,
        uint256 quoteAmount,
        uint256 baseAmount,
        uint256 minQuote,
        uint256 minBase
    ) external nonReentrant onlyRole(STRATEGIST_ROLE) {
        if (_newTickLower >= _newTickUpper) revert InvalidTickRange();
        if (block.timestamp < lastRebalanceTime + MIN_REBALANCE_INTERVAL) revert RebalanceTooFrequent();

        int24 oldLower = tickLower;
        int24 oldUpper = tickUpper;

        // Remove existing position (if any)
        if (activePositionId != 0) {
            _removeAllLiquidity();
        }

        // Deploy into new range
        if (quoteAmount > 0 || baseAmount > 0) {
            if (quoteAmount > idleQuoteBalance) revert InsufficientIdle();

            (uint256 amount0, uint256 amount1, uint256 min0, uint256 min1) = quoteIsToken0
                ? (quoteAmount, baseAmount, minQuote, minBase)
                : (baseAmount, quoteAmount, minBase, minQuote);

            if (quoteAmount > 0) {
                quoteToken.forceApprove(address(positionManager), quoteAmount);
            }
            if (baseAmount > 0) {
                IERC20(baseToken).forceApprove(address(positionManager), baseAmount);
            }

            (uint256 tokenId, , uint256 actual0, uint256 actual1) = positionManager.mint(
                INonfungiblePositionManager.MintParams({
                    token0: quoteIsToken0 ? address(quoteToken) : baseToken,
                    token1: quoteIsToken0 ? baseToken : address(quoteToken),
                    fee: feeTier,
                    tickLower: _newTickLower,
                    tickUpper: _newTickUpper,
                    amount0Desired: amount0,
                    amount1Desired: amount1,
                    amount0Min: min0,
                    amount1Min: min1,
                    recipient: address(this),
                    deadline: block.timestamp
                })
            );

            activePositionId = tokenId;
            tickLower = _newTickLower;
            tickUpper = _newTickUpper;

            uint256 actualQuote = quoteIsToken0 ? actual0 : actual1;
            uint256 actualBase = quoteIsToken0 ? actual1 : actual0;
            deployedQuoteAmount = actualQuote;
            deployedBaseAmount = actualBase;
            idleQuoteBalance -= actualQuote;

            // Clear residual approvals
            quoteToken.forceApprove(address(positionManager), 0);
            if (baseAmount > 0) {
                IERC20(baseToken).forceApprove(address(positionManager), 0);
            }

            emit LiquidityDeployed(tokenId, actualQuote, actualBase, _newTickLower, _newTickUpper);
        }

        lastRebalanceTime = block.timestamp;
        emit Rebalanced(oldLower, oldUpper, _newTickLower, _newTickUpper);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ADMIN — DEFAULT_ADMIN_ROLE
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Update capacity cap
     * @param _maxDeposits New maximum lender deposits in USDC
     */
    function setMaxLenderDeposits(uint256 _maxDeposits) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_maxDeposits == 0) revert ZeroAmount();
        uint256 old = maxLenderDeposits;
        maxLenderDeposits = _maxDeposits;
        emit CapacityUpdated(old, _maxDeposits);
    }

    /**
     * @notice Update utilization target
     * @param _target New target in BPS (e.g., 8000 = 80%)
     */
    function setUtilizationTarget(uint256 _target) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_target > MAX_UTILIZATION_TARGET) revert AboveMax();
        uint256 old = utilizationTarget;
        utilizationTarget = _target;
        emit UtilizationTargetUpdated(old, _target);
    }

    /**
     * @notice Update performance fee
     * @param _feeBps New fee in BPS
     */
    function setPerformanceFee(uint256 _feeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_feeBps > MAX_PERFORMANCE_FEE_BPS) revert FeeTooHigh();
        uint256 old = performanceFeeBps;
        performanceFeeBps = _feeBps;
        emit PerformanceFeeUpdated(old, _feeBps);
    }

    /**
     * @notice Update fee recipient
     */
    function setFeeRecipient(address _recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_recipient == address(0)) revert ZeroAddress();
        address old = feeRecipient;
        feeRecipient = _recipient;
        emit FeeRecipientUpdated(old, _recipient);
    }

    /**
     * @notice Withdraw accrued protocol fees
     */
    function withdrawProtocolFees() external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 fees = accruedProtocolFees;
        if (fees == 0) revert NoFees();
        accruedProtocolFees = 0;
        quoteToken.safeTransfer(feeRecipient, fees);
        emit ProtocolFeesWithdrawn(feeRecipient, fees);
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TIMELOCK — CRITICAL OPERATIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Upgrade the Uniswap V3 pool reference (e.g., fee tier migration)
     * @param _newPool New Uni V3 pool address
     */
    function migrateUniPool(address _newPool) external onlyTimelock {
        if (_newPool == address(0)) revert ZeroAddress();
        // Must remove liquidity first
        if (activePositionId != 0) revert PositionAlreadyActive();

        uniPool = IUniswapV3Pool(_newPool);
        feeTier = IUniswapV3Pool(_newPool).fee();
        address token0 = IUniswapV3Pool(_newPool).token0();
        quoteIsToken0 = (token0 == address(quoteToken));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // EMERGENCY
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Emergency: remove all liquidity and return to idle
     */
    function emergencyWithdrawLP() external onlyRole(GUARDIAN_ROLE) {
        _removeAllLiquidity();
    }

    /**
     * @notice Emergency: recover stuck tokens (not quote, base, or LP tokens)
     */
    function recoverToken(address token, uint256 amount, address to) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(quoteToken)) revert CannotRecoverUsdc();
        if (token == baseToken) revert CannotRecoverAsset();
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INTERNAL
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Total value available to lenders (idle + deployed, excluding protocol fees)
     */
    function _totalLenderValue() internal view returns (uint256) {
        return idleQuoteBalance + deployedQuoteAmount + cumulativeLenderYield;
    }

    /**
     * @notice Whether the pool can accept deposits
     */
    function _isAcceptingDeposits() internal view returns (bool) {
        if (paused()) return false;
        return _totalLenderValue() < maxLenderDeposits;
    }

    /**
     * @notice Pull USDC from LP to satisfy a withdrawal
     * @param amount USDC needed
     */
    function _pullFromLP(uint256 amount) internal {
        if (activePositionId == 0) return;

        // Get position liquidity
        (,,,,,,, uint128 posLiquidity,,,,) = positionManager.positions(activePositionId);
        if (posLiquidity == 0) return;

        // Calculate fraction of liquidity to remove
        // We approximate: remove proportional to amount/deployedQuoteAmount
        uint128 liquidityToRemove;
        if (amount >= deployedQuoteAmount) {
            liquidityToRemove = posLiquidity; // Remove all
        } else {
            liquidityToRemove = uint128(
                uint256(posLiquidity).mulDiv(amount, deployedQuoteAmount, Math.Rounding.Ceil)
            );
            if (liquidityToRemove > posLiquidity) liquidityToRemove = posLiquidity;
        }

        (uint256 removed0, uint256 removed1) = positionManager.decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: activePositionId,
                liquidity: liquidityToRemove,
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp
            })
        );

        // Collect the tokens
        positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: activePositionId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        uint256 quoteReceived = quoteIsToken0 ? removed0 : removed1;
        uint256 baseReceived = quoteIsToken0 ? removed1 : removed0;

        // Update deployed amounts
        if (quoteReceived >= deployedQuoteAmount) {
            deployedQuoteAmount = 0;
        } else {
            deployedQuoteAmount -= quoteReceived;
        }
        if (baseReceived >= deployedBaseAmount) {
            deployedBaseAmount = 0;
        } else {
            deployedBaseAmount -= baseReceived;
        }

        idleQuoteBalance += quoteReceived;

        // Convert any base tokens received to USDC
        if (baseReceived > 0) {
            IERC20(baseToken).forceApprove(address(swapRouter), baseReceived);
            uint256 quoteFromSwap = swapRouter.exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: baseToken,
                    tokenOut: address(quoteToken),
                    fee: feeTier,
                    recipient: address(this),
                    deadline: block.timestamp,
                    amountIn: baseReceived,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
            idleQuoteBalance += quoteFromSwap;
            IERC20(baseToken).forceApprove(address(swapRouter), 0);
        }

        // If all liquidity removed, burn the NFT
        if (liquidityToRemove == posLiquidity) {
            positionManager.burn(activePositionId);
            activePositionId = 0;
            tickLower = 0;
            tickUpper = 0;
        }
    }

    /**
     * @notice Remove all liquidity, collect fees, burn NFT
     */
    function _removeAllLiquidity() internal {
        if (activePositionId == 0) return;

        (,,,,,,, uint128 posLiquidity,,,,) = positionManager.positions(activePositionId);

        uint256 quoteReceived;
        uint256 baseReceived;

        if (posLiquidity > 0) {
            (uint256 removed0, uint256 removed1) = positionManager.decreaseLiquidity(
                INonfungiblePositionManager.DecreaseLiquidityParams({
                    tokenId: activePositionId,
                    liquidity: posLiquidity,
                    amount0Min: 0,
                    amount1Min: 0,
                    deadline: block.timestamp
                })
            );

            quoteReceived = quoteIsToken0 ? removed0 : removed1;
            baseReceived = quoteIsToken0 ? removed1 : removed0;
        }

        // Collect everything (removed liquidity + accrued fees)
        (uint256 collected0, uint256 collected1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: activePositionId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        uint256 totalQuote = quoteIsToken0 ? collected0 : collected1;
        uint256 totalBase = quoteIsToken0 ? collected1 : collected0;

        // Burn the NFT
        positionManager.burn(activePositionId);

        // Convert any base tokens to USDC
        if (totalBase > 0) {
            IERC20(baseToken).forceApprove(address(swapRouter), totalBase);
            uint256 quoteFromSwap = swapRouter.exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: baseToken,
                    tokenOut: address(quoteToken),
                    fee: feeTier,
                    recipient: address(this),
                    deadline: block.timestamp,
                    amountIn: totalBase,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
            totalQuote += quoteFromSwap;
            IERC20(baseToken).forceApprove(address(swapRouter), 0);
        }

        // Reset LP tracking
        idleQuoteBalance += totalQuote;
        deployedQuoteAmount = 0;
        deployedBaseAmount = 0;
        activePositionId = 0;
        tickLower = 0;
        tickUpper = 0;

        emit LiquidityRemoved(0, totalQuote, totalBase);
        emit EmergencyWithdraw(totalQuote, totalBase);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // EXTRA VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Total capacity remaining
    function remainingCapacity() external view returns (uint256) {
        uint256 tv = _totalLenderValue();
        if (tv >= maxLenderDeposits) return 0;
        return maxLenderDeposits - tv;
    }

    /// @notice Current tick from the Uni V3 pool
    function currentTick() external view returns (int24 tick) {
        (, tick,,,,,) = uniPool.slot0();
    }

    /// @notice Whether the LP position is in range
    function isInRange() external view returns (bool) {
        if (activePositionId == 0) return false;
        (, int24 tick,,,,,) = uniPool.slot0();
        return tick >= tickLower && tick < tickUpper;
    }

    /// @notice Pool info for frontend
    function poolInfo()
        external
        view
        returns (
            address _baseToken,
            address _quoteToken,
            uint256 _totalDeposited,
            uint256 _maxDeposits,
            uint256 _deployed,
            uint256 _idle,
            uint256 _apy,
            uint256 _utilization,
            bool _accepting
        )
    {
        _baseToken = baseToken;
        _quoteToken = address(quoteToken);
        _totalDeposited = _totalLenderValue();
        _maxDeposits = maxLenderDeposits;
        _deployed = deployedQuoteAmount;
        _idle = idleQuoteBalance;
        _apy = this.lendingAPY();
        _utilization = this.utilization();
        _accepting = _isAcceptingDeposits();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // UPGRADE
    // ═══════════════════════════════════════════════════════════════════════

    function _authorizeUpgrade(address) internal override onlyTimelock {}
}
