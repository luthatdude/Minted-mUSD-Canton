// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IStrategy.sol";
import "../TimelockGoverned.sol";
import "../Errors.sol";

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
    UUPSUpgradeable,
    TimelockGoverned
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
    /// @notice C-01: Declare TIMELOCK_ROLE explicitly — prevents admin from bypassing
    /// 48h timelock delay on unpause(), recoverToken(), setMarketSelector(), and upgrades.
    bytes32 public constant TIMELOCK_ROLE = keccak256("TIMELOCK_ROLE");

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

    /// @notice Configurable PT discount rate in BPS (default 1000 = 10%)
    /// @dev Used for PT-to-USDC and USDC-to-PT valuation approximations
    uint256 public ptDiscountRateBps;

    /// @notice When true, auto-selection is disabled — admin must set market manually
    bool public manualMarketSelection;

    // ═══════════════════════════════════════════════════════════════════════
    // MULTI-POOL STATE (manual mode)
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Tracks a single PT position in a Pendle market
    struct Position {
        address market;
        address pt;
        address sy;
        address yt;
        uint256 expiry;
        uint256 ptBalance;
    }

    /// @notice Active positions by market address
    mapping(address => Position) public positions;

    /// @notice Ordered list of markets with active positions
    address[] public activeMarkets;

    /// @notice Maximum concurrent positions to bound gas
    uint256 public constant MAX_POSITIONS = 10;

    /// @dev Storage gap for upgrades (reduced by 4: ptDiscountRateBps, manualMarketSelection, positions, activeMarkets)
    uint256[36] private __gap;

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
    event ManualModeUpdated(bool manual);
    event MarketSetManually(address indexed market, address pt, uint256 expiry);
    event AllocatedToMarket(address indexed market, uint256 usdcIn, uint256 ptOut);
    event DeallocatedFromMarket(address indexed market, uint256 ptIn, uint256 usdcOut);

    // ═══════════════════════════════════════════════════════════════════════
    // ERRORS (shared errors imported from Errors.sol)
    // ═══════════════════════════════════════════════════════════════════════

    error MarketNotExpired();
    error NoMarketSet();
    error RolloverNotNeeded();
    error InvalidSlippage();
    error ManualModeEnabled();
    error MarketExpiredOrInvalid();
    error TooManyPositions();
    error NoPositionInMarket();

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
        string calldata _category,
        address _timelock
    ) external initializer {
        if (_usdc == address(0) || _marketSelector == address(0) || _treasury == address(0) || _admin == address(0)) {
            revert ZeroAddress();
        }
        if (_timelock == address(0)) revert ZeroAddress();

        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        _setTimelock(_timelock);

        usdc = IERC20(_usdc);
        marketSelector = IPendleMarketSelector(_marketSelector);
        marketCategory = _category;

        // Default settings
        rolloverThreshold = DEFAULT_ROLLOVER_THRESHOLD;
        slippageBps = 50; // 0.5% default slippage
        ptDiscountRateBps = 1000; // 10% default, configurable
        active = true;

        // Setup roles
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(TREASURY_ROLE, _treasury);
        _grantRole(STRATEGIST_ROLE, _admin);
        _grantRole(GUARDIAN_ROLE, _admin);

        // C-01: Make TIMELOCK_ROLE its own admin — DEFAULT_ADMIN cannot grant/revoke it
        // Without this, DEFAULT_ADMIN can grant itself TIMELOCK_ROLE and bypass the 48h
        // upgrade delay, enabling instant implementation swap to drain all funds
        _setRoleAdmin(TIMELOCK_ROLE, TIMELOCK_ROLE);

        // C-02: Removed infinite approval (type(uint256).max) to Pendle Router.
        // Per-operation approvals are set before each router interaction
        // in deposit(), _depositToCurrentMarket(), and _redeemPt() to limit
        // exposure if Pendle Router is compromised.
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

        // Transfer USDC from treasury
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        // Manual mode: hold USDC idle — strategist allocates to specific pools later
        if (manualMarketSelection) {
            emit Deposited(address(0), amount, 0);
            return amount;
        }

        // Auto mode: deploy to single current market
        if (currentMarket == address(0) || _shouldRollover()) {
            _selectNewMarket();
        }

        // Swap USDC → PT via Pendle Router.
        // Use normalized PT expectation (including decimal scaling) for bounds.
        uint256 expectedPtOut = _usdcToPt(amount);
        uint256 minPtOut = (expectedPtOut * (BPS - slippageBps)) / BPS;

        IPendleRouter.ApproxParams memory approx = IPendleRouter.ApproxParams({
            guessMin: minPtOut,
            guessMax: expectedPtOut * 2, // PT can be worth more than underlying
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

        // SOL-C-02: Per-operation approval before router call
        usdc.forceApprove(PENDLE_ROUTER, amount);
        (uint256 netPtOut,,) = IPendleRouter(PENDLE_ROUTER).swapExactTokenForPt(
            address(this),
            currentMarket,
            minPtOut,
            approx,
            input,
            limit
        );
        usdc.forceApprove(PENDLE_ROUTER, 0);

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

        if (manualMarketSelection) {
            // Pull idle USDC first
            uint256 idle = usdc.balanceOf(address(this));
            if (idle >= amount) {
                usdc.safeTransfer(msg.sender, amount);
                return amount;
            }
            // Send all idle, then redeem from positions for the rest
            uint256 remaining = amount - idle;
            if (idle > 0) {
                usdc.safeTransfer(msg.sender, idle);
                withdrawn = idle;
            }
            // Redeem from positions (largest first) until we have enough
            for (uint256 i = 0; i < activeMarkets.length && remaining > 0; i++) {
                Position storage pos = positions[activeMarkets[i]];
                if (pos.ptBalance == 0) continue;
                uint256 ptNeeded = _usdcToPtWithExpiry(remaining, pos.pt, pos.expiry);
                if (ptNeeded > pos.ptBalance) ptNeeded = pos.ptBalance;
                uint256 redeemed = _redeemFromPosition(pos, ptNeeded);
                withdrawn += redeemed;
                remaining = redeemed >= remaining ? 0 : remaining - redeemed;
            }
            // Send any newly redeemed USDC
            uint256 newBalance = usdc.balanceOf(address(this));
            if (newBalance > 0 && remaining > 0) {
                uint256 toSend = newBalance < remaining ? newBalance : remaining;
                usdc.safeTransfer(msg.sender, toSend);
            }
            _cleanupEmptyPositions();
            emit Withdrawn(address(0), 0, withdrawn);
            return withdrawn;
        }

        // Auto mode: single position
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
        if (manualMarketSelection) {
            // Redeem all positions
            for (uint256 i = 0; i < activeMarkets.length; i++) {
                Position storage pos = positions[activeMarkets[i]];
                if (pos.ptBalance > 0) {
                    _redeemFromPosition(pos, pos.ptBalance);
                }
            }
            _cleanupEmptyPositions();
        } else {
            // Auto mode: single position
            if (ptBalance > 0) {
                _redeemPt(ptBalance);
            }
        }

        // Transfer everything
        withdrawn = usdc.balanceOf(address(this));
        if (withdrawn > 0) {
            usdc.safeTransfer(msg.sender, withdrawn);
        }
        emit Withdrawn(address(0), 0, withdrawn);
    }

    /**
     * @notice Total value in USDC terms
     * @dev PT approaches 1:1 at maturity, trades at discount before
     */
    function totalValue() external view override returns (uint256) {
        uint256 idle = usdc.balanceOf(address(this));

        if (manualMarketSelection) {
            // Sum all multi-pool positions
            uint256 positionValue = 0;
            for (uint256 i = 0; i < activeMarkets.length; i++) {
                Position storage pos = positions[activeMarkets[i]];
                if (pos.ptBalance > 0) {
                    positionValue += _ptToUsdcWithExpiry(pos.ptBalance, pos.pt, pos.expiry);
                }
            }
            return idle + positionValue;
        }

        // Auto mode: single position
        if (ptBalance == 0 || currentMarket == address(0)) {
            return idle;
        }
        return _ptToUsdc(ptBalance) + idle;
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
    // MULTI-POOL ALLOCATION (manual mode)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Allocate idle USDC to a specific Pendle PT market
     * @dev Only works in manual mode. Strategist decides which pool and how much.
     * @param _market Pendle market address
     * @param usdcAmount Amount of idle USDC to deploy
     */
    function allocateToMarket(address _market, uint256 usdcAmount)
        external
        nonReentrant
        whenNotPaused
        onlyRole(STRATEGIST_ROLE)
    {
        if (!manualMarketSelection) revert ManualModeEnabled();
        if (_market == address(0)) revert ZeroAddress();
        if (usdcAmount == 0) revert ZeroAmount();
        if (usdcAmount > usdc.balanceOf(address(this))) revert InsufficientBalance();

        IPendleMarket pendleMarket = IPendleMarket(_market);
        if (pendleMarket.isExpired()) revert MarketExpiredOrInvalid();

        // Initialize position if new
        Position storage pos = positions[_market];
        if (pos.market == address(0)) {
            if (activeMarkets.length >= MAX_POSITIONS) revert TooManyPositions();
            (address sy, address pt, address yt) = pendleMarket.readTokens();
            pos.market = _market;
            pos.pt = pt;
            pos.sy = sy;
            pos.yt = yt;
            pos.expiry = pendleMarket.expiry();
            activeMarkets.push(_market);
        }

        // Deploy USDC → PT via Pendle Router
        uint256 netPtOut = _depositToPosition(pos, usdcAmount);

        emit AllocatedToMarket(_market, usdcAmount, netPtOut);
    }

    /**
     * @notice Withdraw USDC from a specific pool back to idle
     * @param _market Pendle market address
     * @param usdcAmount Approximate USDC value to pull (redeems equivalent PT)
     */
    function deallocateFromMarket(address _market, uint256 usdcAmount)
        external
        nonReentrant
        onlyRole(STRATEGIST_ROLE)
    {
        if (!manualMarketSelection) revert ManualModeEnabled();
        Position storage pos = positions[_market];
        if (pos.market == address(0)) revert NoPositionInMarket();

        uint256 ptNeeded = _usdcToPtWithExpiry(usdcAmount, pos.pt, pos.expiry);
        if (ptNeeded > pos.ptBalance) ptNeeded = pos.ptBalance;

        uint256 usdcOut = _redeemFromPosition(pos, ptNeeded);

        // Clean up if position is empty
        if (pos.ptBalance == 0) {
            _removeActiveMarket(_market);
            delete positions[_market];
        }

        emit DeallocatedFromMarket(_market, ptNeeded, usdcOut);
    }

    /**
     * @notice Withdraw ALL PT from a specific pool back to idle USDC
     * @param _market Pendle market address
     */
    function deallocateAllFromMarket(address _market)
        external
        nonReentrant
        onlyRole(STRATEGIST_ROLE)
    {
        if (!manualMarketSelection) revert ManualModeEnabled();
        Position storage pos = positions[_market];
        if (pos.market == address(0)) revert NoPositionInMarket();

        uint256 ptAmount = pos.ptBalance;
        uint256 usdcOut = _redeemFromPosition(pos, ptAmount);

        _removeActiveMarket(_market);
        delete positions[_market];

        emit DeallocatedFromMarket(_market, ptAmount, usdcOut);
    }

    /**
     * @notice Get all active positions
     * @return markets Array of market addresses
     * @return ptBalances Array of PT balances
     * @return expiries Array of expiry timestamps
     * @return usdcValues Array of estimated USDC values
     */
    function getPositions()
        external
        view
        returns (
            address[] memory markets,
            uint256[] memory ptBalances,
            uint256[] memory expiries,
            uint256[] memory usdcValues
        )
    {
        uint256 len = activeMarkets.length;
        markets = new address[](len);
        ptBalances = new uint256[](len);
        expiries = new uint256[](len);
        usdcValues = new uint256[](len);

        for (uint256 i = 0; i < len; i++) {
            Position storage pos = positions[activeMarkets[i]];
            markets[i] = pos.market;
            ptBalances[i] = pos.ptBalance;
            expiries[i] = pos.expiry;
            usdcValues[i] = _ptToUsdcWithExpiry(pos.ptBalance, pos.pt, pos.expiry);
        }
    }

    /**
     * @notice Get idle (unallocated) USDC balance
     */
    function idleBalance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /**
     * @notice Get count of active positions
     */
    function positionCount() external view returns (uint256) {
        return activeMarkets.length;
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
        if (manualMarketSelection) revert ManualModeEnabled();
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
     * @dev Only STRATEGIST or GUARDIAN can trigger rollover
     */
    function triggerRollover() external nonReentrant onlyRole(STRATEGIST_ROLE) {
        if (manualMarketSelection) revert ManualModeEnabled();
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

        if (bestMarket == address(0)) revert NoValidMarket();
        if (info.pt == address(0)) revert InvalidPtToken();

        currentMarket = bestMarket;
        currentPT = info.pt;
        currentSY = info.sy;
        currentExpiry = info.expiry;

        // Get YT from market
        (,, address yt) = IPendleMarket(bestMarket).readTokens();
        currentYT = yt;

        // C-02: Removed infinite PT approval. Per-operation approvals are
        // set before each router call in _redeemPt() instead.
    }

    function _depositToCurrentMarket(uint256 usdcAmount) internal {
        uint256 expectedPtOut = _usdcToPt(usdcAmount);
        uint256 minPtOut = (expectedPtOut * (BPS - slippageBps)) / BPS;

        IPendleRouter.ApproxParams memory approx = IPendleRouter.ApproxParams({
            guessMin: minPtOut,
            guessMax: expectedPtOut * 2,
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

        // SOL-C-02: Per-operation approval before router call
        usdc.forceApprove(PENDLE_ROUTER, usdcAmount);
        (uint256 netPtOut,,) = IPendleRouter(PENDLE_ROUTER).swapExactTokenForPt(
            address(this),
            currentMarket,
            minPtOut,
            approx,
            input,
            _emptyLimitOrder()
        );
        usdc.forceApprove(PENDLE_ROUTER, 0);

        ptBalance += netPtOut;
    }

    function _redeemPt(uint256 ptAmount) internal returns (uint256 usdcOut) {
        if (ptAmount == 0) return 0;

        IPendleMarket market = IPendleMarket(currentMarket);
        bool expired = market.isExpired();

        uint256 expectedUsdcOut = _ptToUsdc(ptAmount);
        uint256 minUsdcOut = (expectedUsdcOut * (BPS - slippageBps)) / BPS;

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

        // SOL-C-02: Per-operation approval for PT before router call
        IERC20(currentPT).forceApprove(PENDLE_ROUTER, ptAmount);
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
        IERC20(currentPT).forceApprove(PENDLE_ROUTER, 0);

        ptBalance -= ptAmount;
    }

    // ─── Multi-pool internal helpers ────────────────────────────────────

    function _depositToPosition(Position storage pos, uint256 usdcAmount) internal returns (uint256 netPtOut) {
        uint256 expectedPtOut = _usdcToPtWithExpiry(usdcAmount, pos.pt, pos.expiry);
        uint256 minPtOut = (expectedPtOut * (BPS - slippageBps)) / BPS;

        IPendleRouter.ApproxParams memory approx = IPendleRouter.ApproxParams({
            guessMin: minPtOut,
            guessMax: expectedPtOut * 2,
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

        usdc.forceApprove(PENDLE_ROUTER, usdcAmount);
        (netPtOut,,) = IPendleRouter(PENDLE_ROUTER).swapExactTokenForPt(
            address(this),
            pos.market,
            minPtOut,
            approx,
            input,
            _emptyLimitOrder()
        );
        usdc.forceApprove(PENDLE_ROUTER, 0);

        if (netPtOut < minPtOut) revert SlippageExceeded();
        pos.ptBalance += netPtOut;
    }

    function _redeemFromPosition(Position storage pos, uint256 ptAmount) internal returns (uint256 usdcOut) {
        if (ptAmount == 0) return 0;

        bool expired = IPendleMarket(pos.market).isExpired();

        uint256 expectedUsdcOut = _ptToUsdcWithExpiry(ptAmount, pos.pt, pos.expiry);
        uint256 minUsdcOut = (expectedUsdcOut * (BPS - slippageBps)) / BPS;

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

        IERC20(pos.pt).forceApprove(PENDLE_ROUTER, ptAmount);
        if (expired) {
            (usdcOut,) = IPendleRouter(PENDLE_ROUTER).redeemPyToToken(
                address(this),
                pos.yt,
                ptAmount,
                output
            );
        } else {
            (usdcOut,,) = IPendleRouter(PENDLE_ROUTER).swapExactPtForToken(
                address(this),
                pos.market,
                ptAmount,
                output,
                _emptyLimitOrder()
            );
        }
        IERC20(pos.pt).forceApprove(PENDLE_ROUTER, 0);

        pos.ptBalance -= ptAmount;
    }

    function _ptToUsdcWithExpiry(uint256 ptAmount, address pt, uint256 expiry) internal view returns (uint256) {
        uint256 usdcEquivalent = _scalePtToUsdcDecimalsFor(ptAmount, pt);
        if (expiry == 0 || block.timestamp >= expiry) {
            return usdcEquivalent;
        }
        uint256 timeRemaining = expiry - block.timestamp;
        uint256 secondsPerYear = 365 days;
        if (timeRemaining > secondsPerYear) timeRemaining = secondsPerYear;
        uint256 discountBps = (ptDiscountRateBps * timeRemaining) / secondsPerYear;
        uint256 valueBps = BPS - discountBps;
        return (usdcEquivalent * valueBps) / BPS;
    }

    function _usdcToPtWithExpiry(uint256 usdcAmount, address pt, uint256 expiry) internal view returns (uint256) {
        uint256 ptEquivalent = _scaleUsdcToPtDecimalsFor(usdcAmount, pt);
        if (expiry == 0 || block.timestamp >= expiry) {
            return ptEquivalent;
        }
        uint256 timeRemaining = expiry - block.timestamp;
        uint256 secondsPerYear = 365 days;
        if (timeRemaining > secondsPerYear) timeRemaining = secondsPerYear;
        uint256 discountBps = (ptDiscountRateBps * timeRemaining) / secondsPerYear;
        uint256 valueBps = BPS - discountBps;
        return (ptEquivalent * BPS) / valueBps;
    }

    function _scaleUsdcToPtDecimalsFor(uint256 usdcAmount, address pt) internal view returns (uint256) {
        if (pt == address(0)) return usdcAmount;
        uint8 usdcDecimals = IERC20Metadata(address(usdc)).decimals();
        uint8 ptDecimals = IERC20Metadata(pt).decimals();
        if (ptDecimals == usdcDecimals) return usdcAmount;
        if (ptDecimals > usdcDecimals) return usdcAmount * _pow10(ptDecimals - usdcDecimals);
        return usdcAmount / _pow10(usdcDecimals - ptDecimals);
    }

    function _scalePtToUsdcDecimalsFor(uint256 ptAmount, address pt) internal view returns (uint256) {
        if (pt == address(0)) return ptAmount;
        uint8 usdcDecimals = IERC20Metadata(address(usdc)).decimals();
        uint8 ptDecimals = IERC20Metadata(pt).decimals();
        if (ptDecimals == usdcDecimals) return ptAmount;
        if (ptDecimals > usdcDecimals) return ptAmount / _pow10(ptDecimals - usdcDecimals);
        return ptAmount * _pow10(usdcDecimals - ptDecimals);
    }

    function _removeActiveMarket(address _market) internal {
        for (uint256 i = 0; i < activeMarkets.length; i++) {
            if (activeMarkets[i] == _market) {
                activeMarkets[i] = activeMarkets[activeMarkets.length - 1];
                activeMarkets.pop();
                return;
            }
        }
    }

    function _cleanupEmptyPositions() internal {
        uint256 i = 0;
        while (i < activeMarkets.length) {
            if (positions[activeMarkets[i]].ptBalance == 0) {
                delete positions[activeMarkets[i]];
                activeMarkets[i] = activeMarkets[activeMarkets.length - 1];
                activeMarkets.pop();
            } else {
                i++;
            }
        }
    }

    function _ptToUsdc(uint256 ptAmount) internal view returns (uint256) {
        uint256 usdcEquivalent = _scalePtToUsdcDecimals(ptAmount);
        if (currentExpiry == 0 || block.timestamp >= currentExpiry) {
            // At or after maturity, PT = 1:1 underlying
            return usdcEquivalent;
        }

        // Before maturity, PT trades at discount
        // Approximate using time to maturity
        uint256 timeRemaining = currentExpiry - block.timestamp;
        uint256 secondsPerYear = 365 days;

        // Simple approximation: PT discount = impliedRate * timeRemaining
        // For ~11% APY with 6 months to go: discount ≈ 5.5%
        // PT value = underlying * (1 - discount)
        // This is a simplification; actual value requires oracle
        if (timeRemaining > secondsPerYear) {
            timeRemaining = secondsPerYear;
        }

        // Use configurable discount rate
        uint256 discountBps = (ptDiscountRateBps * timeRemaining) / secondsPerYear;
        uint256 valueBps = BPS - discountBps;

        return (usdcEquivalent * valueBps) / BPS;
    }

    function _usdcToPt(uint256 usdcAmount) internal view returns (uint256) {
        uint256 ptEquivalent = _scaleUsdcToPtDecimals(usdcAmount);
        if (currentExpiry == 0 || block.timestamp >= currentExpiry) {
            return ptEquivalent;
        }

        uint256 timeRemaining = currentExpiry - block.timestamp;
        uint256 secondsPerYear = 365 days;
        if (timeRemaining > secondsPerYear) {
            timeRemaining = secondsPerYear;
        }

        // Use configurable discount rate
        uint256 discountBps = (ptDiscountRateBps * timeRemaining) / secondsPerYear;
        uint256 valueBps = BPS - discountBps;

        // PT needed = usdc-equivalent / (PT value per usdc)
        return (ptEquivalent * BPS) / valueBps;
    }

    function _scaleUsdcToPtDecimals(uint256 usdcAmount) internal view returns (uint256) {
        if (currentPT == address(0)) return usdcAmount;

        uint8 usdcDecimals = IERC20Metadata(address(usdc)).decimals();
        uint8 ptDecimals = IERC20Metadata(currentPT).decimals();
        if (ptDecimals == usdcDecimals) return usdcAmount;

        if (ptDecimals > usdcDecimals) {
            return usdcAmount * _pow10(ptDecimals - usdcDecimals);
        }
        return usdcAmount / _pow10(usdcDecimals - ptDecimals);
    }

    function _scalePtToUsdcDecimals(uint256 ptAmount) internal view returns (uint256) {
        if (currentPT == address(0)) return ptAmount;

        uint8 usdcDecimals = IERC20Metadata(address(usdc)).decimals();
        uint8 ptDecimals = IERC20Metadata(currentPT).decimals();
        if (ptDecimals == usdcDecimals) return ptAmount;

        if (ptDecimals > usdcDecimals) {
            return ptAmount / _pow10(ptDecimals - usdcDecimals);
        }
        return ptAmount * _pow10(usdcDecimals - ptDecimals);
    }

    function _pow10(uint8 exponent) internal pure returns (uint256) {
        if (exponent > 77) revert DecimalsTooLarge();
        return 10 ** uint256(exponent);
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
     * @dev Allows adjusting PT discount rate to match current market implied APY
     */
    function setPtDiscountRate(uint256 _discountBps) external onlyRole(STRATEGIST_ROLE) {
        if (_discountBps > 5000) revert DiscountTooHigh();
        emit PtDiscountRateUpdated(ptDiscountRateBps, _discountBps);
        ptDiscountRateBps = _discountBps;
    }

    /**
     * @notice Set rollover threshold
     * @param _threshold Time before expiry to trigger rollover
     */
    function setRolloverThreshold(uint256 _threshold) external onlyRole(STRATEGIST_ROLE) {
        if (_threshold < 1 days || _threshold > 30 days) revert InvalidThreshold();
        emit RolloverThresholdUpdated(rolloverThreshold, _threshold);
        rolloverThreshold = _threshold;
    }

    /**
     * @notice Toggle manual market selection mode
     * @dev When enabled, auto-selection is disabled — admin must call setMarketManual()
     */
    function setManualMode(bool _manual) external onlyRole(STRATEGIST_ROLE) {
        manualMarketSelection = _manual;
        emit ManualModeUpdated(_manual);
    }

    /**
     * @notice Manually set the PT market (only works in manual mode)
     * @dev Reads tokens/expiry from the Pendle market contract. If there is
     *      an existing PT position, it is redeemed to USDC first, then
     *      re-deposited into the new market.
     * @param _market Address of the Pendle market to use
     */
    function setMarketManual(address _market) external nonReentrant onlyRole(STRATEGIST_ROLE) {
        if (!manualMarketSelection) revert ManualModeEnabled(); // must be in manual mode
        if (_market == address(0)) revert ZeroAddress();

        // Validate market is not expired
        IPendleMarket pendleMarket = IPendleMarket(_market);
        if (pendleMarket.isExpired()) revert MarketExpiredOrInvalid();

        address oldMarket = currentMarket;
        uint256 usdcRecovered = 0;

        // Redeem existing position if switching markets
        if (ptBalance > 0 && oldMarket != address(0) && _market != oldMarket) {
            usdcRecovered = _redeemPt(ptBalance);
        }

        // Read tokens from the new market
        (address sy, address pt, address yt) = pendleMarket.readTokens();
        uint256 expiry = pendleMarket.expiry();

        currentMarket = _market;
        currentPT = pt;
        currentSY = sy;
        currentYT = yt;
        currentExpiry = expiry;

        // Re-deposit recovered USDC into the new market
        if (usdcRecovered > 0) {
            _depositToCurrentMarket(usdcRecovered);
        }

        emit MarketSetManually(_market, pt, expiry);
        if (oldMarket != address(0) && _market != oldMarket) {
            emit MarketRolled(oldMarket, _market, usdcRecovered, expiry);
        }
    }

    /**
     * @notice Update market selector
     */
    function setMarketSelector(address _selector) external onlyTimelock {
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
     * @notice Emergency withdraw all to USDC and send to recipient
     * @param recipient Address to receive the USDC (must hold TREASURY_ROLE)
     */
    function emergencyWithdraw(address recipient) external onlyRole(GUARDIAN_ROLE) {
        if (recipient == address(0)) revert ZeroAddress();
        if (!hasRole(TREASURY_ROLE, recipient)) revert RecipientMustBeTreasury();

        _pause();

        uint256 ptRedeemed = ptBalance;

        // Redeem single-market position (auto mode)
        if (ptBalance > 0) {
            _redeemPt(ptBalance);
        }

        // Redeem all multi-pool positions (manual mode)
        for (uint256 i = 0; i < activeMarkets.length; i++) {
            Position storage pos = positions[activeMarkets[i]];
            if (pos.ptBalance > 0) {
                ptRedeemed += pos.ptBalance;
                _redeemFromPosition(pos, pos.ptBalance);
            }
        }
        _cleanupEmptyPositions();

        uint256 balance = usdc.balanceOf(address(this));
        if (balance > 0) {
            usdc.safeTransfer(recipient, balance);
        }

        emit EmergencyWithdraw(ptRedeemed, balance);
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
    function unpause() external onlyTimelock {
        _unpause();
    }

    /**
     * @notice Recover stuck tokens (not USDC or PT)
     */
    function recoverToken(address token, address to) external onlyTimelock {
        if (token == address(usdc)) revert CannotRecoverUsdc();
        if (token == currentPT) revert CannotRecoverPt();
        // Protect all active position PTs
        for (uint256 i = 0; i < activeMarkets.length; i++) {
            if (token == positions[activeMarkets[i]].pt) revert CannotRecoverPt();
        }
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(to, balance);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // UUPS UPGRADE
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice CRIT-01: Only MintedTimelockController can authorize upgrades (48h delay enforced)
    function _authorizeUpgrade(address) internal override onlyTimelock {}
}
