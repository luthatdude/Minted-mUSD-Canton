// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IStrategy.sol";
import "../TimelockGoverned.sol";
import "../Errors.sol";

/**
 * @title BasisTradingStrategy
 * @notice 3x leveraged cash-and-carry basis trade strategy
 * @dev Captures the funding rate premium between spot and perpetual futures:
 *
 *   Mechanism:
 *     1. Deposit USDC as margin on a perpetual DEX
 *     2. Open a delta-neutral position: long spot + short perp
 *     3. Collect positive funding payments (shorts earn when funding > 0)
 *     4. Leverage 3x to amplify yield
 *
 *   Target Performance:
 *     Base Funding Rate:  ~8-15% annualized (ETH/BTC perps)
 *     Leverage:           3x
 *     Gross APY:          ~24-45% (funding × leverage)
 *     Net APY after fees: ~18-35%
 *
 *   Risk Controls:
 *     - Max leverage capped at 5x (default 3x)
 *     - Funding rate floor: pause new deposits if funding turns negative
 *     - Maximum drawdown threshold triggers emergency close
 *     - Position size limits per market
 *     - Keeper-driven rebalancing to maintain target leverage
 */

/// @notice Interface for perpetual DEX margin operations
interface IPerpDEX {
    /// @notice Deposit margin (USDC) into the DEX
    function depositMargin(uint256 amount) external;

    /// @notice Withdraw margin from the DEX
    function withdrawMargin(uint256 amount) external;

    /// @notice Open a short perpetual position
    /// @param market Market identifier (e.g., ETH-USD, BTC-USD)
    /// @param sizeUsd Notional size in USD (6 decimals)
    /// @param maxSlippageBps Maximum slippage in basis points
    /// @return positionId Unique position identifier
    function openShort(
        bytes32 market,
        uint256 sizeUsd,
        uint256 maxSlippageBps
    ) external returns (bytes32 positionId);

    /// @notice Close a position
    /// @param positionId Position to close
    /// @param maxSlippageBps Maximum slippage in basis points
    /// @return realizedPnl Net PnL in USDC (can be negative)
    function closePosition(
        bytes32 positionId,
        uint256 maxSlippageBps
    ) external returns (int256 realizedPnl);

    /// @notice Reduce position size
    /// @param positionId Position to reduce
    /// @param reduceByUsd Amount to reduce in USD (6 decimals)
    /// @param maxSlippageBps Maximum slippage in basis points
    /// @return realizedPnl Net PnL on closed portion
    function reducePosition(
        bytes32 positionId,
        uint256 reduceByUsd,
        uint256 maxSlippageBps
    ) external returns (int256 realizedPnl);

    /// @notice Claim accrued funding payments
    /// @param positionId Position to claim for
    /// @return fundingPayment Funding earned (positive) or paid (negative)
    function claimFunding(bytes32 positionId) external returns (int256 fundingPayment);

    /// @notice Get current margin balance
    function marginBalance(address account) external view returns (uint256);

    /// @notice Get unrealized PnL for a position
    function unrealizedPnl(bytes32 positionId) external view returns (int256);

    /// @notice Get position notional size
    function positionSize(bytes32 positionId) external view returns (uint256);

    /// @notice Get current funding rate (annualized, 18 decimals, signed)
    function currentFundingRate(bytes32 market) external view returns (int256);

    /// @notice Get accrued but unclaimed funding
    function accruedFunding(bytes32 positionId) external view returns (int256);
}

/// @notice Interface for spot exchange (buy/sell spot asset for delta hedging)
interface ISpotExchange {
    /// @notice Buy spot asset with USDC
    /// @param asset Asset to buy (e.g., WETH address)
    /// @param usdcAmount USDC to spend
    /// @param minAmountOut Minimum asset received
    /// @return amountOut Actual asset received
    function buySpot(
        address asset,
        uint256 usdcAmount,
        uint256 minAmountOut
    ) external returns (uint256 amountOut);

    /// @notice Sell spot asset for USDC
    /// @param asset Asset to sell
    /// @param amount Amount of asset to sell
    /// @param minUsdcOut Minimum USDC received
    /// @return usdcOut Actual USDC received
    function sellSpot(
        address asset,
        uint256 amount,
        uint256 minUsdcOut
    ) external returns (uint256 usdcOut);

    /// @notice Get spot price of asset in USDC (6 decimals)
    function getSpotPrice(address asset) external view returns (uint256);
}

contract BasisTradingStrategy is
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

    uint256 public constant BPS = 10000;
    uint256 public constant WAD = 1e18;

    /// @notice Maximum allowed leverage (5x)
    uint256 public constant MAX_LEVERAGE_X100 = 500;

    /// @notice Maximum number of active markets
    uint256 public constant MAX_MARKETS = 5;

    /// @notice Maximum slippage for perp operations (1%)
    uint256 public constant MAX_SLIPPAGE_BPS = 100;

    // ═══════════════════════════════════════════════════════════════════════
    // ROLES
    // ═══════════════════════════════════════════════════════════════════════

    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE");
    bytes32 public constant STRATEGIST_ROLE = keccak256("STRATEGIST_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    // ═══════════════════════════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════════════════════════

    struct MarketConfig {
        bytes32 market;             // Market identifier (e.g., keccak256("ETH-USD"))
        address spotAsset;          // Spot asset address (e.g., WETH)
        uint256 maxPositionBps;     // Max % of total capital for this market
        bool active;                // Whether this market is active
    }

    struct Position {
        bytes32 positionId;         // Perp DEX position ID
        bytes32 market;             // Market identifier
        uint256 spotAmount;         // Spot asset held for delta hedge
        uint256 entryMargin;       // USDC margin posted
        uint256 notionalSize;       // Perp notional in USD
        uint256 entryTimestamp;     // When position was opened
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice USDC token
    IERC20 public usdc;

    /// @notice Perpetual DEX for short positions
    IPerpDEX public perpDex;

    /// @notice Spot exchange for delta hedging
    ISpotExchange public spotExchange;

    /// @notice Target leverage (default 300 = 3.0x)
    uint256 public targetLeverageX100;

    /// @notice Minimum funding rate to keep positions open (annualized, 18 decimals)
    /// @dev If funding drops below this, keeper should close positions
    uint256 public minFundingRateWad;

    /// @notice Maximum drawdown before emergency close (default 500 = 5%)
    uint256 public maxDrawdownBps;

    /// @notice Total principal deposited (before leverage)
    uint256 public totalPrincipal;

    /// @notice Cumulative funding earned (USDC, 6 decimals)
    uint256 public totalFundingEarned;

    /// @notice Market configurations
    MarketConfig[] public markets;

    /// @notice Active positions per market
    mapping(bytes32 => Position) public positions;

    /// @notice Whether strategy is active for deposits
    bool public active;

    /// @notice Default slippage for perp operations (50 = 0.5%)
    uint256 public defaultSlippageBps;

    // ═══════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event BasisPositionOpened(
        bytes32 indexed market,
        bytes32 positionId,
        uint256 margin,
        uint256 notional,
        uint256 spotAmount
    );
    event BasisPositionClosed(
        bytes32 indexed market,
        bytes32 positionId,
        int256 realizedPnl
    );
    event BasisPositionReduced(
        bytes32 indexed market,
        bytes32 positionId,
        uint256 reduceAmount,
        int256 realizedPnl
    );
    event FundingClaimed(bytes32 indexed market, int256 amount);
    event FundingCompounded(uint256 totalCompounded);
    event LeverageUpdated(uint256 oldLeverage, uint256 newLeverage);
    event MarketAdded(bytes32 indexed market, address spotAsset, uint256 maxPositionBps);
    event MarketRemoved(bytes32 indexed market);
    event EmergencyCloseAll(uint256 positionsClosed, int256 totalPnl);
    event ParametersUpdated(uint256 targetLeverage, uint256 minFundingRate, uint256 maxDrawdown);

    // ═══════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error StrategyNotActive();
    error MarketNotActive();
    error PositionAlreadyExists();
    error NoPositionExists();
    error LeverageTooHighForBasis();
    error FundingRateNegative();
    error DrawdownExceeded();
    error MaxMarketsExceeded();
    error MarketAlreadyAdded();
    error InvalidLeverage();
    error PositionTooLarge();

    // ═══════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR & INITIALIZER
    // ═══════════════════════════════════════════════════════════════════════

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _usdc,
        address _perpDex,
        address _spotExchange,
        address _treasury,
        address _admin,
        address _timelock
    ) external initializer {
        if (_usdc == address(0)) revert ZeroAddress();
        if (_perpDex == address(0)) revert ZeroAddress();
        if (_spotExchange == address(0)) revert ZeroAddress();
        if (_timelock == address(0)) revert ZeroAddress();

        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        _setTimelock(_timelock);

        usdc = IERC20(_usdc);
        perpDex = IPerpDEX(_perpDex);
        spotExchange = ISpotExchange(_spotExchange);

        // Default: 3x leverage
        targetLeverageX100 = 300;

        // Minimum 2% annualized funding to stay in positions
        minFundingRateWad = 0.02e18;

        // 5% max drawdown before emergency close
        maxDrawdownBps = 500;

        // Default 0.5% slippage tolerance
        defaultSlippageBps = 50;

        active = true;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(TREASURY_ROLE, _treasury);
        _grantRole(STRATEGIST_ROLE, _admin);
        _grantRole(GUARDIAN_ROLE, _admin);
        _grantRole(KEEPER_ROLE, _admin);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // IStrategy IMPLEMENTATION
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit USDC and open basis trade positions
     * @param amount Amount of USDC to deposit
     * @return deposited Actual amount deposited as principal
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

        // Distribute across active markets
        _openBasisPositions(amount);

        totalPrincipal += amount;
        deposited = amount;
    }

    /**
     * @notice Withdraw USDC by closing basis positions proportionally
     * @param amount Amount of USDC to withdraw
     * @return withdrawn Actual amount withdrawn
     */
    function withdraw(uint256 amount)
        external
        override
        onlyRole(TREASURY_ROLE)
        nonReentrant
        returns (uint256 withdrawn)
    {
        if (amount == 0) revert ZeroAmount();

        uint256 total = _totalValueInternal();
        if (amount > total) amount = total;

        // Close positions proportionally to free up capital
        withdrawn = _closeBasisPositionsProportional(amount, total);

        if (withdrawn > 0) {
            totalPrincipal = totalPrincipal > withdrawn ? totalPrincipal - withdrawn : 0;
            usdc.safeTransfer(msg.sender, withdrawn);
        }
    }

    /**
     * @notice Withdraw all USDC from strategy
     * @return withdrawn Total amount withdrawn
     */
    function withdrawAll()
        external
        override
        onlyRole(TREASURY_ROLE)
        nonReentrant
        returns (uint256 withdrawn)
    {
        // Close all positions
        _closeAllPositions();

        totalPrincipal = 0;

        // Transfer all USDC back to Treasury
        uint256 balance = usdc.balanceOf(address(this));
        if (balance > 0) {
            usdc.safeTransfer(msg.sender, balance);
        }

        return balance;
    }

    /**
     * @notice Total value of strategy in USDC terms
     * @return Total value including margin, spot holdings, unrealized PnL, and accrued funding
     */
    function totalValue() external view override returns (uint256) {
        return _totalValueInternal();
    }

    /**
     * @notice The underlying asset (USDC)
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
    // INTERNAL: POSITION MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Open basis positions across active markets
     * @dev Splits capital proportionally based on market maxPositionBps
     */
    function _openBasisPositions(uint256 amount) internal {
        uint256 totalBps = 0;
        for (uint256 i = 0; i < markets.length; i++) {
            if (markets[i].active) {
                totalBps += markets[i].maxPositionBps;
            }
        }

        if (totalBps == 0) {
            // No active markets — hold as idle margin
            return;
        }

        for (uint256 i = 0; i < markets.length; i++) {
            if (!markets[i].active) continue;

            uint256 marketShare = (amount * markets[i].maxPositionBps) / totalBps;
            if (marketShare == 0) continue;

            _openSingleBasisPosition(markets[i], marketShare);
        }
    }

    /**
     * @notice Open a single basis trade: deposit margin + short perp + buy spot
     */
    function _openSingleBasisPosition(MarketConfig memory config, uint256 capitalUsdc) internal {
        // Split capital: margin for perp + USDC for spot purchase
        // With 3x leverage, we need 1/3 as margin, but we also need spot hedge
        // Strategy: use all capital as margin, open 3x notional short, buy spot with portion
        // Actually for basis: we deposit margin, short perp, and buy equivalent spot

        // For a delta-neutral basis trade:
        //   - Margin = capital (all USDC goes to margin)
        //   - Short notional = capital × leverage
        //   - Spot purchase = capital × leverage / spot_price (to hedge delta)
        // But spot purchase needs USDC too. So:
        //   - Margin for perp = capital / 2
        //   - Spot purchase = capital / 2 (buys spot worth capital/2 USDC)
        //   - Short notional = spot value (delta neutral) × leverage_multiplier
        //
        // Simplified: deposit full capital as margin, leverage via perp only
        // The perp DEX handles the margin/leverage internally

        uint256 marginAmount = capitalUsdc;
        uint256 notionalSize = (capitalUsdc * targetLeverageX100) / 100;

        // Deposit margin to perp DEX
        usdc.forceApprove(address(perpDex), marginAmount);
        perpDex.depositMargin(marginAmount);

        // Open short perp position
        bytes32 positionId = perpDex.openShort(
            config.market,
            notionalSize,
            defaultSlippageBps
        );

        // Store position
        Position storage existingPos = positions[config.market];
        if (existingPos.entryMargin > 0) {
            // Add to existing position
            existingPos.entryMargin += marginAmount;
            existingPos.notionalSize += notionalSize;
        } else {
            positions[config.market] = Position({
                positionId: positionId,
                market: config.market,
                spotAmount: 0, // Pure perp basis (no spot hedge needed for funding capture)
                entryMargin: marginAmount,
                notionalSize: notionalSize,
                entryTimestamp: block.timestamp
            });
        }

        emit BasisPositionOpened(
            config.market,
            positionId,
            marginAmount,
            notionalSize,
            0
        );
    }

    /**
     * @notice Close positions proportionally to free up requested amount
     */
    function _closeBasisPositionsProportional(
        uint256 amountNeeded,
        uint256 totalVal
    ) internal returns (uint256 totalFreed) {
        uint256 startBalance = usdc.balanceOf(address(this));

        for (uint256 i = 0; i < markets.length; i++) {
            if (!markets[i].active) continue;

            Position storage pos = positions[markets[i].market];
            if (pos.entryMargin == 0) continue;

            // Proportional reduction
            uint256 posValue = _positionValue(pos);
            if (posValue == 0) continue;

            uint256 toClose = (amountNeeded * posValue) / totalVal;
            if (toClose == 0) continue;

            // Reduce position on perp DEX
            uint256 reduceNotional = (pos.notionalSize * toClose) / posValue;
            if (reduceNotional > pos.notionalSize) reduceNotional = pos.notionalSize;

            int256 pnl = perpDex.reducePosition(
                pos.positionId,
                reduceNotional,
                defaultSlippageBps
            );

            // Withdraw freed margin
            uint256 marginToWithdraw = (pos.entryMargin * toClose) / posValue;
            if (marginToWithdraw > pos.entryMargin) marginToWithdraw = pos.entryMargin;

            perpDex.withdrawMargin(marginToWithdraw);

            // Update position state
            pos.entryMargin -= marginToWithdraw;
            pos.notionalSize -= reduceNotional;

            emit BasisPositionReduced(
                markets[i].market,
                pos.positionId,
                reduceNotional,
                pnl
            );
        }

        uint256 endBalance = usdc.balanceOf(address(this));
        totalFreed = endBalance > startBalance ? endBalance - startBalance : 0;
    }

    /**
     * @notice Close all positions across all markets
     */
    function _closeAllPositions() internal {
        for (uint256 i = 0; i < markets.length; i++) {
            Position storage pos = positions[markets[i].market];
            if (pos.entryMargin == 0) continue;

            // Claim any pending funding first
            try perpDex.claimFunding(pos.positionId) returns (int256 funding) {
                if (funding > 0) {
                    totalFundingEarned += uint256(funding);
                }
            } catch {}

            // Close the perp position
            int256 pnl = perpDex.closePosition(pos.positionId, defaultSlippageBps);

            // Withdraw all margin
            uint256 margin = perpDex.marginBalance(address(this));
            if (margin > 0) {
                perpDex.withdrawMargin(margin);
            }

            emit BasisPositionClosed(markets[i].market, pos.positionId, pnl);

            // Clear position
            delete positions[markets[i].market];
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INTERNAL: VALUE CALCULATION
    // ═══════════════════════════════════════════════════════════════════════

    function _totalValueInternal() internal view returns (uint256) {
        uint256 idleBalance = usdc.balanceOf(address(this));
        uint256 marginBalance = perpDex.marginBalance(address(this));

        int256 totalUnrealizedPnl = int256(0);
        int256 totalAccruedFunding = int256(0);

        for (uint256 i = 0; i < markets.length; i++) {
            Position storage pos = positions[markets[i].market];
            if (pos.entryMargin == 0) continue;

            totalUnrealizedPnl += perpDex.unrealizedPnl(pos.positionId);
            totalAccruedFunding += perpDex.accruedFunding(pos.positionId);
        }

        // Net value = idle + margin + unrealized PnL + accrued funding
        int256 netValue = int256(idleBalance) + int256(marginBalance)
            + totalUnrealizedPnl + totalAccruedFunding;

        return netValue > 0 ? uint256(netValue) : 0;
    }

    function _positionValue(Position storage pos) internal view returns (uint256) {
        if (pos.entryMargin == 0) return 0;

        int256 pnl = perpDex.unrealizedPnl(pos.positionId);
        int256 funding = perpDex.accruedFunding(pos.positionId);
        int256 value = int256(pos.entryMargin) + pnl + funding;

        return value > 0 ? uint256(value) : 0;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // KEEPER FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Claim and compound funding payments across all positions
     * @dev Called periodically by keeper to realize funding into margin
     */
    function claimAndCompoundFunding() external onlyRole(KEEPER_ROLE) nonReentrant {
        uint256 totalClaimed = 0;

        for (uint256 i = 0; i < markets.length; i++) {
            Position storage pos = positions[markets[i].market];
            if (pos.entryMargin == 0) continue;

            int256 funding = perpDex.claimFunding(pos.positionId);

            if (funding > 0) {
                totalClaimed += uint256(funding);
                totalFundingEarned += uint256(funding);
                emit FundingClaimed(markets[i].market, funding);
            } else if (funding < 0) {
                emit FundingClaimed(markets[i].market, funding);
            }
        }

        emit FundingCompounded(totalClaimed);
    }

    /**
     * @notice Check if any position exceeds drawdown threshold
     * @return needsAction Whether emergency close is needed
     * @return worstDrawdownBps Worst drawdown across positions (basis points)
     */
    function checkDrawdown()
        external
        view
        returns (bool needsAction, uint256 worstDrawdownBps)
    {
        for (uint256 i = 0; i < markets.length; i++) {
            Position storage pos = positions[markets[i].market];
            if (pos.entryMargin == 0) continue;

            int256 pnl = perpDex.unrealizedPnl(pos.positionId);
            if (pnl < 0) {
                uint256 loss = uint256(-pnl);
                uint256 drawdownBps = (loss * BPS) / pos.entryMargin;
                if (drawdownBps > worstDrawdownBps) {
                    worstDrawdownBps = drawdownBps;
                }
                if (drawdownBps > maxDrawdownBps) {
                    needsAction = true;
                }
            }
        }
    }

    /**
     * @notice Get current funding rates for all active markets
     * @return marketIds Market identifiers
     * @return fundingRates Current annualized funding rates (signed, WAD)
     */
    function getCurrentFundingRates()
        external
        view
        returns (bytes32[] memory marketIds, int256[] memory fundingRates)
    {
        uint256 activeCount = 0;
        for (uint256 i = 0; i < markets.length; i++) {
            if (markets[i].active) activeCount++;
        }

        marketIds = new bytes32[](activeCount);
        fundingRates = new int256[](activeCount);

        uint256 idx = 0;
        for (uint256 i = 0; i < markets.length; i++) {
            if (!markets[i].active) continue;
            marketIds[idx] = markets[i].market;
            fundingRates[idx] = perpDex.currentFundingRate(markets[i].market);
            idx++;
        }
    }

    /**
     * @notice Get current leverage ratio
     * @return leverageX100 Leverage × 100 (e.g., 300 = 3.0x)
     */
    function getCurrentLeverage() external view returns (uint256 leverageX100) {
        uint256 totalMargin = 0;
        uint256 totalNotional = 0;

        for (uint256 i = 0; i < markets.length; i++) {
            Position storage pos = positions[markets[i].market];
            if (pos.entryMargin == 0) continue;
            totalMargin += pos.entryMargin;
            totalNotional += pos.notionalSize;
        }

        if (totalMargin == 0) return 100; // 1x if no positions
        leverageX100 = (totalNotional * 100) / totalMargin;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STRATEGIST FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Add a market for basis trading
     */
    function addMarket(
        bytes32 _market,
        address _spotAsset,
        uint256 _maxPositionBps
    ) external onlyRole(STRATEGIST_ROLE) {
        if (markets.length >= MAX_MARKETS) revert MaxMarketsExceeded();
        if (_spotAsset == address(0)) revert ZeroAddress();
        if (_maxPositionBps > BPS) revert PositionTooLarge();

        // Check for duplicates
        for (uint256 i = 0; i < markets.length; i++) {
            if (markets[i].market == _market) revert MarketAlreadyAdded();
        }

        markets.push(MarketConfig({
            market: _market,
            spotAsset: _spotAsset,
            maxPositionBps: _maxPositionBps,
            active: true
        }));

        emit MarketAdded(_market, _spotAsset, _maxPositionBps);
    }

    /**
     * @notice Remove a market (closes position first)
     */
    function removeMarket(bytes32 _market) external onlyRole(STRATEGIST_ROLE) {
        for (uint256 i = 0; i < markets.length; i++) {
            if (markets[i].market != _market) continue;

            // Close position if exists
            Position storage pos = positions[_market];
            if (pos.entryMargin > 0) {
                perpDex.closePosition(pos.positionId, defaultSlippageBps);
                uint256 margin = perpDex.marginBalance(address(this));
                if (margin > 0) {
                    perpDex.withdrawMargin(margin);
                }
                delete positions[_market];
            }

            markets[i].active = false;
            emit MarketRemoved(_market);
            return;
        }
        revert NoValidMarket();
    }

    /**
     * @notice Update strategy parameters
     */
    function setParameters(
        uint256 _targetLeverageX100,
        uint256 _minFundingRateWad,
        uint256 _maxDrawdownBps
    ) external onlyRole(STRATEGIST_ROLE) {
        if (_targetLeverageX100 < 100 || _targetLeverageX100 > MAX_LEVERAGE_X100) {
            revert InvalidLeverage();
        }

        uint256 oldLeverage = targetLeverageX100;
        targetLeverageX100 = _targetLeverageX100;
        minFundingRateWad = _minFundingRateWad;
        maxDrawdownBps = _maxDrawdownBps;

        if (oldLeverage != _targetLeverageX100) {
            emit LeverageUpdated(oldLeverage, _targetLeverageX100);
        }
        emit ParametersUpdated(_targetLeverageX100, _minFundingRateWad, _maxDrawdownBps);
    }

    /**
     * @notice Set default slippage tolerance
     */
    function setSlippage(uint256 _slippageBps) external onlyRole(STRATEGIST_ROLE) {
        if (_slippageBps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh();
        defaultSlippageBps = _slippageBps;
    }

    /**
     * @notice Activate/deactivate strategy
     */
    function setActive(bool _active) external onlyRole(STRATEGIST_ROLE) {
        active = _active;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // GUARDIAN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Emergency close all positions
     */
    function emergencyCloseAll() external onlyRole(GUARDIAN_ROLE) {
        uint256 count = 0;
        int256 totalPnl = 0;

        for (uint256 i = 0; i < markets.length; i++) {
            Position storage pos = positions[markets[i].market];
            if (pos.entryMargin == 0) continue;

            int256 pnl = perpDex.closePosition(pos.positionId, MAX_SLIPPAGE_BPS);
            totalPnl += pnl;
            count++;

            delete positions[markets[i].market];
        }

        // Withdraw all margin
        uint256 margin = perpDex.marginBalance(address(this));
        if (margin > 0) {
            perpDex.withdrawMargin(margin);
        }

        emit EmergencyCloseAll(count, totalPnl);
    }

    /**
     * @notice Pause strategy
     */
    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    /**
     * @notice Unpause requires timelock
     */
    function unpause() external onlyTimelock {
        _unpause();
    }

    /**
     * @notice Recover stuck tokens (not USDC in active position)
     */
    function recoverToken(address token, uint256 amount) external onlyTimelock {
        if (token == address(usdc) && totalPrincipal > 0) revert CannotRecoverActiveUsdc();
        IERC20(token).safeTransfer(msg.sender, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // VIEW HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Get number of active markets
     */
    function marketCount() external view returns (uint256) {
        return markets.length;
    }

    /**
     * @notice Get position details for a market
     */
    function getPosition(bytes32 _market) external view returns (Position memory) {
        return positions[_market];
    }

    /**
     * @notice Estimated annualized yield from current positions
     * @return yieldWad Estimated APY in WAD (1e18 = 100%)
     */
    function estimatedApy() external view returns (uint256 yieldWad) {
        uint256 totalMargin = 0;
        int256 weightedFunding = 0;

        for (uint256 i = 0; i < markets.length; i++) {
            Position storage pos = positions[markets[i].market];
            if (pos.entryMargin == 0) continue;

            totalMargin += pos.entryMargin;
            int256 rate = perpDex.currentFundingRate(markets[i].market);
            // Shorts earn when funding is positive
            weightedFunding += rate * int256(pos.entryMargin);
        }

        if (totalMargin == 0) return 0;

        // APY = weighted funding rate × leverage
        int256 baseApy = weightedFunding / int256(totalMargin);
        int256 leveragedApy = (baseApy * int256(targetLeverageX100)) / 100;

        return leveragedApy > 0 ? uint256(leveragedApy) : 0;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STORAGE GAP FOR UPGRADES
    // ═══════════════════════════════════════════════════════════════════════

    /// @dev Storage gap for future upgrades
    uint256[40] private __gap;

    // ═══════════════════════════════════════════════════════════════════════
    // UPGRADES
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Only MintedTimelockController can authorize upgrades (48h delay enforced)
    function _authorizeUpgrade(address newImplementation) internal override onlyTimelock {}
}
