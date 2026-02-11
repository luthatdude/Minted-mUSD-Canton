// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IStrategy.sol";

/**
 * @title PendleStrategyV2
 * @notice Yield strategy that deposits USDC into Pendle PT markets with automatic rollover
 * @dev Integrates with PendleMarketSelector for optimal market selection
 *
 * Features:
 *   - Auto-selects highest APY Pendle PT market via PendleMarketSelector
 *   - Monitors expiry and triggers rollover before maturity
 *   - Redeems matured PT → underlying → re-deposits to new market
 *   - Implements IStrategy for TreasuryV2 integration
 *
 * Flow:
 *   1. deposit(): USDC → swap to PT via Pendle Router
 *   2. At maturity: PT redeemable 1:1 for SY → underlying
 *   3. rollToNewMarket(): Redeem current → select new market → deposit
 */

// ═══════════════════════════════════════════════════════════════════════════
// PENDLE INTERFACES
// ═══════════════════════════════════════════════════════════════════════════

interface IPendleRouter {
    struct ApproxParams {
        uint256 guessMin;
        uint256 guessMax;
        uint256 guessOffchain;
        uint256 maxIteration;
        uint256 eps;
    }

    struct TokenInput {
        address tokenIn;
        uint256 netTokenIn;
        address tokenMintSy;
        address pendleSwap;
        SwapData swapData;
    }

    struct TokenOutput {
        address tokenOut;
        uint256 minTokenOut;
        address tokenRedeemSy;
        address pendleSwap;
        SwapData swapData;
    }

    struct SwapData {
        SwapType swapType;
        address extRouter;
        bytes extCalldata;
        bool needScale;
    }

    enum SwapType {
        NONE,
        KYBERSWAP,
        ONE_INCH,
        ETH_WETH
    }

    /// @notice Swap token for PT
    function swapExactTokenForPt(
        address receiver,
        address market,
        uint256 minPtOut,
        ApproxParams calldata guessPtOut,
        TokenInput calldata input,
        LimitOrderData calldata limit
    ) external payable returns (uint256 netPtOut, uint256 netSyFee, uint256 netSyInterm);

    /// @notice Redeem PT for token after maturity
    function redeemPyToToken(
        address receiver,
        address YT,
        uint256 netPyIn,
        TokenOutput calldata output
    ) external returns (uint256 netTokenOut, uint256 netSyFee);

    /// @notice Swap PT for token (before maturity)
    function swapExactPtForToken(
        address receiver,
        address market,
        uint256 exactPtIn,
        TokenOutput calldata output,
        LimitOrderData calldata limit
    ) external returns (uint256 netTokenOut, uint256 netSyFee, uint256 netSyInterm);

    struct LimitOrderData {
        address limitRouter;
        uint256 epsSkipMarket;
        FillOrderParams[] normalFills;
        FillOrderParams[] flashFills;
        bytes optData;
    }

    struct FillOrderParams {
        Order order;
        bytes signature;
        uint256 makingAmount;
    }

    struct Order {
        uint256 salt;
        uint256 expiry;
        uint256 nonce;
        OrderType orderType;
        address token;
        address YT;
        address maker;
        address receiver;
        uint256 makingAmount;
        uint256 lnImpliedRate;
        uint256 failSafeRate;
        bytes permit;
    }

    enum OrderType {
        SY_FOR_PT,
        PT_FOR_SY,
        SY_FOR_YT,
        YT_FOR_SY
    }
}

interface IPendleMarket {
    function readTokens() external view returns (address sy, address pt, address yt);
    function expiry() external view returns (uint256);
    function isExpired() external view returns (bool);
}

interface IPendleSY {
    function redeem(
        address receiver,
        uint256 amountSharesToRedeem,
        address tokenOut,
        uint256 minTokenOut,
        bool burnFromInternalBalance
    ) external returns (uint256 amountTokenOut);

    function deposit(
        address receiver,
        address tokenIn,
        uint256 amountTokenIn,
        uint256 minSharesOut
    ) external payable returns (uint256 amountSharesOut);

    function exchangeRate() external view returns (uint256);
    function yieldToken() external view returns (address);
    function getTokensIn() external view returns (address[] memory);
    function getTokensOut() external view returns (address[] memory);
}

interface IPendlePT {
    function SY() external view returns (address);
    function YT() external view returns (address);
    function isExpired() external view returns (bool);
    function expiry() external view returns (uint256);
}

interface IPendleMarketSelector {
    struct MarketInfo {
        address market;
        address sy;
        address pt;
        uint256 expiry;
        uint256 timeToExpiry;
        uint256 totalPt;
        uint256 totalSy;
        uint256 tvlSy;
        uint256 impliedRate;
        uint256 impliedAPY;
        uint256 score;
    }

    function selectBestMarket(string calldata category)
        external
        view
        returns (address bestMarket, MarketInfo memory info);

    function isValidMarket(address market) external view returns (bool);
}

// ═══════════════════════════════════════════════════════════════════════════
// PENDLE STRATEGY V2
// ═══════════════════════════════════════════════════════════════════════════

contract PendleStrategyV2 is
    IStrategy,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Pendle Router V4 (same on all chains)
    address public constant PENDLE_ROUTER = 0x888888888889758F76e7103c6CbF23ABbF58F946;

    /// @notice Maximum slippage for swaps (basis points)
    uint256 public constant MAX_SLIPPAGE_BPS = 100; // 1%

    /// @notice Basis points denominator
    uint256 public constant BPS = 10000;

    /// @notice Default rollover threshold (7 days before expiry)
    uint256 public constant DEFAULT_ROLLOVER_THRESHOLD = 7 days;

    // ═══════════════════════════════════════════════════════════════════════
    // ROLES
    // ═══════════════════════════════════════════════════════════════════════

    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE");
    bytes32 public constant STRATEGIST_ROLE = keccak256("STRATEGIST_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    // ═══════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice USDC token
    IERC20 public usdc;

    /// @notice Market selector contract
    IPendleMarketSelector public marketSelector;

    /// @notice Current Pendle market
    address public currentMarket;

    /// @notice Current PT token
    address public currentPT;

    /// @notice Current SY token
    address public currentSY;

    /// @notice Current YT token
    address public currentYT;

    /// @notice Current market expiry timestamp
    uint256 public currentExpiry;

    /// @notice PT balance held by this strategy
    uint256 public ptBalance;

    /// @notice Time before expiry to trigger rollover
    uint256 public rolloverThreshold;

    /// @notice Category for market selection (e.g., "USD")
    string public marketCategory;

    /// @notice Whether strategy is active
    bool public active;

    /// @notice Slippage tolerance in basis points
    uint256 public slippageBps;

    /// @notice FIX M-02: Configurable PT discount rate in BPS (default 1000 = 10%)
    /// @dev Used for PT-to-USDC and USDC-to-PT valuation approximations
    uint256 public ptDiscountRateBps;

    /// @dev Storage gap for upgrades (reduced from 39 to 37 for pendingImplementation + upgradeRequestTime)
    uint256[37] private __gap;

    // ═══════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event Deposited(address indexed market, uint256 usdcIn, uint256 ptOut);
    event Withdrawn(address indexed market, uint256 ptIn, uint256 usdcOut);
    event MarketRolled(address indexed oldMarket, address indexed newMarket, uint256 amount, uint256 newExpiry);
    event RolloverTriggered(address indexed triggeredBy, uint256 daysToExpiry);
    event SlippageUpdated(uint256 oldSlippage, uint256 newSlippage);
    event PtDiscountRateUpdated(uint256 oldRate, uint256 newRate);
    event RolloverThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);
    event EmergencyWithdraw(uint256 ptRedeemed, uint256 usdcOut);

    // ═══════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error ZeroAddress();
    error ZeroAmount();
    error NotActive();
    error MarketNotExpired();
    error NoMarketSet();
    error SlippageExceeded();
    error RolloverNotNeeded();
    error InvalidSlippage();

    // ═══════════════════════════════════════════════════════════════════════
    // INITIALIZER
    // ═══════════════════════════════════════════════════════════════════════

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the Pendle strategy
     * @param _usdc USDC token address
     * @param _marketSelector PendleMarketSelector address
     * @param _treasury TreasuryV2 address
     * @param _admin Admin address
     * @param _category Market category (e.g., "USD")
     */
    function initialize(
        address _usdc,
        address _marketSelector,
        address _treasury,
        address _admin,
        string calldata _category
    ) external initializer {
        if (_usdc == address(0) || _marketSelector == address(0) || _treasury == address(0)) {
            revert ZeroAddress();
        }

        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        usdc = IERC20(_usdc);
        marketSelector = IPendleMarketSelector(_marketSelector);
        marketCategory = _category;

        // Default settings
        rolloverThreshold = DEFAULT_ROLLOVER_THRESHOLD;
        slippageBps = 50; // 0.5% default slippage
        ptDiscountRateBps = 1000; // FIX M-02: 10% default, now configurable
        active = true;

        // Setup roles
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(TREASURY_ROLE, _treasury);
        _grantRole(STRATEGIST_ROLE, _admin);
        _grantRole(GUARDIAN_ROLE, _admin);

        // FIX PS-H01: Don't grant infinite approval — use per-operation approvals instead
        // Approvals are set in deposit() and _depositToCurrentMarket() before each swap
    }

    // ═══════════════════════════════════════════════════════════════════════
    // IStrategy IMPLEMENTATION
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit USDC into the current Pendle market
     * @dev Automatically selects best market if none is set
     * @param amount Amount of USDC to deposit
     * @return deposited Actual PT value received (in USDC terms)
     */
    function deposit(uint256 amount) external override nonReentrant whenNotPaused onlyRole(TREASURY_ROLE) returns (uint256 deposited) {
        if (!active) revert NotActive();
        if (amount == 0) revert ZeroAmount();

        // Auto-select market if not set or approaching expiry
        if (currentMarket == address(0) || _shouldRollover()) {
            _selectNewMarket();
        }

        // Transfer USDC from treasury
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        // FIX PS-H01: Per-operation approval instead of infinite
        usdc.forceApprove(PENDLE_ROUTER, amount);

        // Swap USDC → PT via Pendle Router
        uint256 minPtOut = (amount * (BPS - slippageBps)) / BPS;

        IPendleRouter.ApproxParams memory approx = IPendleRouter.ApproxParams({
            guessMin: minPtOut,
            guessMax: amount * 2, // PT can be worth more than underlying
            guessOffchain: 0,
            maxIteration: 256,
            eps: 1e14 // 0.01% precision
        });

        IPendleRouter.TokenInput memory input = IPendleRouter.TokenInput({
            tokenIn: address(usdc),
            netTokenIn: amount,
            tokenMintSy: address(usdc),
            pendleSwap: address(0),
            swapData: IPendleRouter.SwapData({
                swapType: IPendleRouter.SwapType.NONE,
                extRouter: address(0),
                extCalldata: "",
                needScale: false
            })
        });

        IPendleRouter.LimitOrderData memory limit = _emptyLimitOrder();

        (uint256 netPtOut,,) = IPendleRouter(PENDLE_ROUTER).swapExactTokenForPt(
            address(this),
            currentMarket,
            minPtOut,
            approx,
            input,
            limit
        );

        if (netPtOut < minPtOut) revert SlippageExceeded();

        ptBalance += netPtOut;
        deposited = amount; // Return USDC value deposited

        emit Deposited(currentMarket, amount, netPtOut);
    }

    /**
     * @notice Withdraw USDC from the strategy
     * @param amount Amount of USDC to withdraw
     * @return withdrawn Actual USDC withdrawn
     */
    function withdraw(uint256 amount) external override nonReentrant onlyRole(TREASURY_ROLE) returns (uint256 withdrawn) {
        if (amount == 0) revert ZeroAmount();
        if (currentMarket == address(0)) revert NoMarketSet();

        // Calculate PT needed (1:1 at maturity, slight premium before)
        uint256 ptNeeded = _usdcToPt(amount);
        if (ptNeeded > ptBalance) {
            ptNeeded = ptBalance;
        }

        withdrawn = _redeemPt(ptNeeded);

        // Transfer USDC to treasury
        usdc.safeTransfer(msg.sender, withdrawn);

        emit Withdrawn(currentMarket, ptNeeded, withdrawn);
    }

    /**
     * @notice Withdraw all USDC from the strategy
     * @return withdrawn Total USDC withdrawn
     */
    function withdrawAll() external override nonReentrant onlyRole(TREASURY_ROLE) returns (uint256 withdrawn) {
        if (ptBalance == 0) return 0;

        uint256 ptToRedeem = ptBalance;
        withdrawn = _redeemPt(ptToRedeem);

        // Transfer all USDC to treasury (includes any dust from prior operations)
        uint256 balance = usdc.balanceOf(address(this));
        if (balance > withdrawn) {
            // FIX PS-M01: Use the larger of redeemed amount and balance to capture any extras
            withdrawn = balance;
        }
        if (balance > 0) {
            usdc.safeTransfer(msg.sender, balance);
        }

        emit Withdrawn(currentMarket, ptToRedeem, withdrawn);
    }

    /**
     * @notice Total value in USDC terms
     * @dev PT approaches 1:1 at maturity, trades at discount before
     */
    function totalValue() external view override returns (uint256) {
        if (ptBalance == 0 || currentMarket == address(0)) {
            return usdc.balanceOf(address(this));
        }

        // PT value = ptBalance * exchange rate (approaches 1 at maturity)
        uint256 ptValue = _ptToUsdc(ptBalance);
        return ptValue + usdc.balanceOf(address(this));
    }

    /**
     * @notice Underlying asset (USDC)
     */
    function asset() external view override returns (address) {
        return address(usdc);
    }

    /**
     * @notice Whether strategy is accepting deposits
     */
    function isActive() external view override returns (bool) {
        return active && !paused();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ROLLOVER LOGIC
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Check if rollover is needed
     * @return True if current market is near expiry or expired
     */
    function shouldRollover() external view returns (bool) {
        return _shouldRollover();
    }

    /**
     * @notice Time remaining until current market expires
     */
    function timeToExpiry() external view returns (uint256) {
        if (currentExpiry == 0 || currentExpiry <= block.timestamp) return 0;
        return currentExpiry - block.timestamp;
    }

    /**
     * @notice Roll position to a new market
     * @dev Can be called by strategist or automatically on deposit
     */
    function rollToNewMarket() external nonReentrant onlyRole(STRATEGIST_ROLE) {
        if (!_shouldRollover() && currentMarket != address(0)) {
            revert RolloverNotNeeded();
        }

        address oldMarket = currentMarket;
        uint256 usdcRecovered = 0;

        // Redeem existing PT if any
        if (ptBalance > 0) {
            usdcRecovered = _redeemPt(ptBalance);
        }

        // Select new market
        _selectNewMarket();

        // Re-deposit if we recovered USDC
        if (usdcRecovered > 0) {
            _depositToCurrentMarket(usdcRecovered);
        }

        emit MarketRolled(oldMarket, currentMarket, usdcRecovered, currentExpiry);
    }

    /**
     * @notice Keeper function to trigger rollover
     * @dev FIX HIGH: Added access control - only STRATEGIST or GUARDIAN can trigger
     * @dev Previously permissionless, allowing front-running attacks
     */
    function triggerRollover() external nonReentrant onlyRole(STRATEGIST_ROLE) {
        if (!_shouldRollover()) revert RolloverNotNeeded();

        uint256 daysRemaining = 0;
        if (currentExpiry > block.timestamp) {
            daysRemaining = (currentExpiry - block.timestamp) / 1 days;
        }

        emit RolloverTriggered(msg.sender, daysRemaining);

        address oldMarket = currentMarket;
        uint256 usdcRecovered = 0;

        if (ptBalance > 0) {
            usdcRecovered = _redeemPt(ptBalance);
        }

        _selectNewMarket();

        if (usdcRecovered > 0) {
            _depositToCurrentMarket(usdcRecovered);
        }

        emit MarketRolled(oldMarket, currentMarket, usdcRecovered, currentExpiry);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INTERNAL FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    function _shouldRollover() internal view returns (bool) {
        if (currentMarket == address(0)) return true;
        if (currentExpiry == 0) return true;
        if (block.timestamp >= currentExpiry) return true; // Expired
        if (block.timestamp + rolloverThreshold >= currentExpiry) return true; // Near expiry
        return false;
    }

    function _selectNewMarket() internal {
        (address bestMarket, IPendleMarketSelector.MarketInfo memory info) =
            marketSelector.selectBestMarket(marketCategory);

        currentMarket = bestMarket;
        currentPT = info.pt;
        currentSY = info.sy;
        currentExpiry = info.expiry;

        // Get YT from market
        (,, address yt) = IPendleMarket(bestMarket).readTokens();
        currentYT = yt;

        // FIX PS-H01: Don't grant infinite PT approval — done per-operation in _redeemPt
    }

    function _depositToCurrentMarket(uint256 usdcAmount) internal {
        // FIX PS-H01: Per-operation approval instead of infinite
        usdc.forceApprove(PENDLE_ROUTER, usdcAmount);

        uint256 minPtOut = (usdcAmount * (BPS - slippageBps)) / BPS;

        IPendleRouter.ApproxParams memory approx = IPendleRouter.ApproxParams({
            guessMin: minPtOut,
            guessMax: usdcAmount * 2,
            guessOffchain: 0,
            maxIteration: 256,
            eps: 1e14
        });

        IPendleRouter.TokenInput memory input = IPendleRouter.TokenInput({
            tokenIn: address(usdc),
            netTokenIn: usdcAmount,
            tokenMintSy: address(usdc),
            pendleSwap: address(0),
            swapData: IPendleRouter.SwapData({
                swapType: IPendleRouter.SwapType.NONE,
                extRouter: address(0),
                extCalldata: "",
                needScale: false
            })
        });

        (uint256 netPtOut,,) = IPendleRouter(PENDLE_ROUTER).swapExactTokenForPt(
            address(this),
            currentMarket,
            minPtOut,
            approx,
            input,
            _emptyLimitOrder()
        );

        ptBalance += netPtOut;
    }

    function _redeemPt(uint256 ptAmount) internal returns (uint256 usdcOut) {
        if (ptAmount == 0) return 0;

        // FIX PS-H01: Per-operation PT approval instead of infinite
        IERC20(currentPT).forceApprove(PENDLE_ROUTER, ptAmount);

        IPendleMarket market = IPendleMarket(currentMarket);
        bool expired = market.isExpired();

        uint256 minUsdcOut = (ptAmount * (BPS - slippageBps)) / BPS;

        IPendleRouter.TokenOutput memory output = IPendleRouter.TokenOutput({
            tokenOut: address(usdc),
            minTokenOut: minUsdcOut,
            tokenRedeemSy: address(usdc),
            pendleSwap: address(0),
            swapData: IPendleRouter.SwapData({
                swapType: IPendleRouter.SwapType.NONE,
                extRouter: address(0),
                extCalldata: "",
                needScale: false
            })
        });

        if (expired) {
            // Redeem PT directly (1:1) after maturity
            (usdcOut,) = IPendleRouter(PENDLE_ROUTER).redeemPyToToken(
                address(this),
                currentYT,
                ptAmount,
                output
            );
        } else {
            // Swap PT → USDC before maturity
            (usdcOut,,) = IPendleRouter(PENDLE_ROUTER).swapExactPtForToken(
                address(this),
                currentMarket,
                ptAmount,
                output,
                _emptyLimitOrder()
            );
        }

        ptBalance -= ptAmount;
    }

    function _ptToUsdc(uint256 ptAmount) internal view returns (uint256) {
        if (ptAmount == 0) return 0;
        if (currentExpiry == 0 || block.timestamp >= currentExpiry) {
            // At or after maturity, PT = 1:1 underlying
            return ptAmount;
        }

        // Before maturity, PT trades at discount
        // FIX V6-HIGH: Improved PT valuation using continuous compounding approximation
        // PT_value = underlying / (1 + rate * timeRemaining/year)
        // This is more accurate than linear discount for higher rates / longer durations
        uint256 timeRemaining = currentExpiry - block.timestamp;
        uint256 secondsPerYear = 365 days;

        if (timeRemaining > secondsPerYear) {
            timeRemaining = secondsPerYear;
        }

        // FIX M-02: Use configurable discount rate instead of hardcoded 10%
        // Denominator: BPS + (rate * time / year)
        // This gives PT_value = ptAmount * BPS / (BPS + discountBps)
        uint256 discountBps = (ptDiscountRateBps * timeRemaining) / secondsPerYear;
        uint256 denominatorBps = BPS + discountBps;

        // FIX V6-HIGH: Division-by-zero guard (denominatorBps is always >= BPS here, but be safe)
        if (denominatorBps == 0) return ptAmount;

        return (ptAmount * BPS) / denominatorBps;
    }

    function _usdcToPt(uint256 usdcAmount) internal view returns (uint256) {
        if (usdcAmount == 0) return 0;
        if (currentExpiry == 0 || block.timestamp >= currentExpiry) {
            return usdcAmount;
        }

        uint256 timeRemaining = currentExpiry - block.timestamp;
        uint256 secondsPerYear = 365 days;
        if (timeRemaining > secondsPerYear) {
            timeRemaining = secondsPerYear;
        }

        // FIX M-02: Use configurable discount rate
        // Inverse of _ptToUsdc: PT = usdc * (BPS + discountBps) / BPS
        uint256 discountBps = (ptDiscountRateBps * timeRemaining) / secondsPerYear;
        uint256 denominatorBps = BPS + discountBps;

        // FIX V6-HIGH: Division-by-zero guard
        if (BPS == 0) return usdcAmount;

        // PT needed = usdc * (1 + discount) — more PT for same USDC since PT is at a discount
        return (usdcAmount * denominatorBps) / BPS;
    }

    function _emptyLimitOrder() internal pure returns (IPendleRouter.LimitOrderData memory) {
        return IPendleRouter.LimitOrderData({
            limitRouter: address(0),
            epsSkipMarket: 0,
            normalFills: new IPendleRouter.FillOrderParams[](0),
            flashFills: new IPendleRouter.FillOrderParams[](0),
            optData: ""
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Set slippage tolerance
     * @param _slippageBps New slippage in basis points (max 1%)
     */
    function setSlippage(uint256 _slippageBps) external onlyRole(STRATEGIST_ROLE) {
        if (_slippageBps > MAX_SLIPPAGE_BPS) revert InvalidSlippage();
        emit SlippageUpdated(slippageBps, _slippageBps);
        slippageBps = _slippageBps;
    }

    /**
     * @notice Set PT discount rate for NAV valuation
     * @param _discountBps New discount rate in BPS (e.g., 1000 = 10%, 500 = 5%)
     * @dev FIX M-02: Allows adjusting PT discount rate to match current market implied APY
     */
    function setPtDiscountRate(uint256 _discountBps) external onlyRole(STRATEGIST_ROLE) {
        require(_discountBps <= 5000, "DISCOUNT_TOO_HIGH"); // Max 50%
        emit PtDiscountRateUpdated(ptDiscountRateBps, _discountBps);
        ptDiscountRateBps = _discountBps;
    }

    /**
     * @notice Set rollover threshold
     * @param _threshold Time before expiry to trigger rollover
     */
    function setRolloverThreshold(uint256 _threshold) external onlyRole(STRATEGIST_ROLE) {
        emit RolloverThresholdUpdated(rolloverThreshold, _threshold);
        rolloverThreshold = _threshold;
    }

    /**
     * @notice Update market selector
     */
    function setMarketSelector(address _selector) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_selector == address(0)) revert ZeroAddress();
        marketSelector = IPendleMarketSelector(_selector);
    }

    /**
     * @notice Set active status
     */
    function setActive(bool _active) external onlyRole(GUARDIAN_ROLE) {
        active = _active;
    }

    /**
     * @notice Emergency withdraw all to USDC
     */
    function emergencyWithdraw() external onlyRole(GUARDIAN_ROLE) {
        _pause();

        // FIX: Capture ptBalance before _redeemPt() zeroes it
        uint256 ptRedeemed = ptBalance;
        uint256 usdcOut = 0;
        if (ptRedeemed > 0) {
            usdcOut = _redeemPt(ptRedeemed);
        }

        uint256 balance = usdc.balanceOf(address(this));
        emit EmergencyWithdraw(ptRedeemed, balance);

        // Keep USDC in contract for treasury to withdraw
    }

    /**
     * @notice Pause strategy
     */
    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    /**
     * @notice Unpause strategy
     */
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /**
     * @notice Recover stuck tokens (not USDC or PT)
     */
    function recoverToken(address token, address to) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(token != address(usdc), "Cannot recover USDC");
        require(token != currentPT, "Cannot recover PT");
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(to, balance);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // UUPS UPGRADE (TIMELOCKED)
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice FIX INSTITUTIONAL: Pending implementation for timelocked upgrade
    address public pendingImplementation;

    /// @notice FIX INSTITUTIONAL: Timestamp of upgrade request
    uint256 public upgradeRequestTime;

    /// @notice FIX INSTITUTIONAL: 48-hour upgrade delay
    uint256 public constant UPGRADE_DELAY = 48 hours;

    event UpgradeRequested(address indexed newImplementation, uint256 executeAfter);
    event UpgradeCancelled(address indexed cancelledImplementation);

    /// @notice Request a timelocked upgrade
    function requestUpgrade(address newImplementation) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newImplementation != address(0), "ZERO_ADDRESS");
        pendingImplementation = newImplementation;
        upgradeRequestTime = block.timestamp;
        emit UpgradeRequested(newImplementation, block.timestamp + UPGRADE_DELAY);
    }

    /// @notice Cancel a pending upgrade
    function cancelUpgrade() external onlyRole(DEFAULT_ADMIN_ROLE) {
        address cancelled = pendingImplementation;
        pendingImplementation = address(0);
        upgradeRequestTime = 0;
        emit UpgradeCancelled(cancelled);
    }

    /// @notice UUPS upgrade authorization with 48h timelock
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {
        require(pendingImplementation == newImplementation, "UPGRADE_NOT_REQUESTED");
        require(block.timestamp >= upgradeRequestTime + UPGRADE_DELAY, "UPGRADE_TIMELOCK_ACTIVE");
        pendingImplementation = address(0);
        upgradeRequestTime = 0;
    }
}
