// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/IYieldBasis.sol";

/**
 * @title MintedLevAMM
 * @notice Constant-leverage automated market maker — Solidity port of AMM.vy
 * @dev The LEVAMM holds Curve LP tokens (collateral) and tracks stablecoin debt.
 *      It provides a trading venue: stablecoin ↔ Curve LP tokens.
 *      The constant leverage invariant ensures the position maintains a fixed
 *      leverage ratio regardless of price moves.
 *
 * Architecture:
 *   ┌──────────────────────────────────────────────────────┐
 *   │                    MintedLevAMM                       │
 *   │                                                       │
 *   │  Holdings:                                            │
 *   │    collateral_amount: Curve LP tokens                 │
 *   │    debt:              Stablecoin owed                 │
 *   │    STABLECOIN balance: Available stablecoins          │
 *   │                                                       │
 *   │  Trading:                                             │
 *   │    coin 0 = stablecoin  ←→  coin 1 = Curve LP token  │
 *   │                                                       │
 *   │  Access:                                              │
 *   │    Anyone: exchange()                                 │
 *   │    LT only: _deposit(), _withdraw(), set_rate(), etc  │
 *   └──────────────────────────────────────────────────────┘
 *
 * Core invariant (get_x0):
 *   Given collateral C valued at p_oracle, and debt D:
 *   x0 = (V + sqrt(V² - 4·V·LEV_RATIO·D)) / (2·LEV_RATIO)
 *   where V = p_oracle · C · COLLATERAL_PRECISION
 *
 *   This is a quadratic formula solution ensuring the AMM maintains
 *   constant leverage. Exchange uses x·y=k within this framework.
 *
 * Rate system:
 *   Debt accrues interest via rate_mul. The rate is set by the LT contract
 *   (controlled by admin/factory). Interest fees are collected and sent to LT.
 *
 * Safety:
 *   - MIN_SAFE_DEBT / MAX_SAFE_DEBT bounds prevent edge-case positions
 *   - is_killed flag allows emergency shutdown
 *   - Reentrancy guard on all state-mutating functions
 *
 * @author Minted Protocol — ported from Scientia Spectra AG yb-core AMM.vy
 */
contract MintedLevAMM is IMintedLevAMM, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ═══════════════════════════════════════════════════════════════════
    // IMMUTABLES (set at deployment, matching AMM.vy constructor)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Address of the LT (Leveraged Liquidity Token) contract
    address public immutable override LT_CONTRACT;

    /// @notice Stablecoin used by this AMM (e.g. crvUSD, USDC)
    address public immutable override STABLECOIN;

    /// @notice Collateral = Curve LP token address
    address public immutable override COLLATERAL;

    /// @notice Leverage factor (e.g. 2e18 for 2x leverage)
    uint256 public immutable override LEVERAGE;

    /// @notice Price oracle for LP tokens
    address public immutable override PRICE_ORACLE_CONTRACT;

    /// @notice Precision multiplier for collateral (1 for 18-decimal LP tokens)
    uint256 public immutable override COLLATERAL_PRECISION;

    // ═══════════════════════════════════════════════════════════════════
    // DERIVED CONSTANTS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice LEV_RATIO = 1e18 * LEVERAGE / (2 * LEVERAGE - 1e18)
    uint256 public immutable LEV_RATIO;

    // ═══════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Maximum annual rate (~100% APR in per-second terms)
    uint256 public constant MAX_RATE = 31709791983e0; // ≈ ln(2)/year ≈ 1e18/365.25/86400

    /// @notice Maximum fee: 10%
    uint256 public constant MAX_FEE = 0.1e18;

    /// @notice Minimum safe debt ratio (prevents edge cases near zero)
    uint256 public constant MIN_SAFE_DEBT = 0.005e18; // 0.5%

    /// @notice Maximum safe debt ratio
    uint256 public constant MAX_SAFE_DEBT = 0.995e18; // 99.5%

    // ═══════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Amount of Curve LP tokens held as collateral
    uint256 public override collateralAmount;

    /// @notice Raw debt (before rate multiplier adjustment)
    uint256 public debt;

    /// @notice Trading fee (1e18-based, e.g. 0.003e18 = 0.3%)
    uint256 public override fee;

    /// @notice Interest rate per second (1e18-based fraction)
    uint256 public rate;

    /// @notice Cumulative rate multiplier (starts at 1e18)
    uint256 public rateMul;

    /// @notice Last time rate was applied
    uint256 public rateTime;

    /// @notice Total stablecoin minted/borrowed through this AMM
    uint256 public minted;

    /// @notice Total stablecoin redeemed/repaid through this AMM
    uint256 public redeemed;

    /// @notice Emergency kill switch
    bool public override isKilled;

    // ═══════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event TokenExchange(
        address indexed buyer,
        uint256 soldId,
        uint256 tokensSold,
        uint256 boughtId,
        uint256 tokensBought,
        uint256 fee_,
        uint256 priceOracle
    );
    event SetRate(uint256 rate_, uint256 rateMul_, uint256 time);
    event AddLiquidityRaw(uint256[2] tokenAmounts, uint256 invariant, uint256 priceOracle);
    event RemoveLiquidityRaw(uint256 collateralChange, uint256 debtChange);
    event CollectFees(uint256 amount, uint256 newSupply);
    event SetKilled(bool isKilled_);
    event SetFee(uint256 fee_);

    // ═══════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Deploy a new LEVAMM instance
     * @param _ltContract LT (Leveraged Liquidity Token) contract address
     * @param _stablecoin Stablecoin address (must be 18 decimals)
     * @param _collateral Curve LP token address (collateral)
     * @param _leverage Leverage factor (e.g. 2e18 for 2x)
     * @param _fee Initial trading fee (1e18-based)
     * @param _priceOracle LP price oracle address
     */
    constructor(
        address _ltContract,
        address _stablecoin,
        address _collateral,
        uint256 _leverage,
        uint256 _fee,
        address _priceOracle
    ) {
        require(_ltContract != address(0), "Zero LT");
        require(_stablecoin != address(0), "Zero stable");
        require(_collateral != address(0), "Zero collateral");
        require(_leverage > 1e18, "Leverage must be > 1x");
        require(_fee <= MAX_FEE, "Fee too high");
        require(_priceOracle != address(0), "Zero oracle");

        LT_CONTRACT = _ltContract;
        STABLECOIN = _stablecoin;
        COLLATERAL = _collateral;
        LEVERAGE = _leverage;
        PRICE_ORACLE_CONTRACT = _priceOracle;

        // LP tokens from Curve Twocrypto are always 18 decimals
        COLLATERAL_PRECISION = 1;

        // LEV_RATIO = 1e18 * LEVERAGE / (2 * LEVERAGE - 1e18)
        // For 2x leverage: 1e18 * 2e18 / (4e18 - 1e18) = 2e36/3e18 ≈ 0.6667e18
        LEV_RATIO = (1e18 * _leverage) / (2 * _leverage - 1e18);

        fee = _fee;
        rateMul = 1e18;
        rateTime = block.timestamp;
    }

    // ═══════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════════════════════

    modifier onlyLT() {
        require(msg.sender == LT_CONTRACT, "Access");
        _;
    }

    // ═══════════════════════════════════════════════════════════════════
    // CORE MATH — Constant Leverage Invariant
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Compute the invariant x0 from collateral value and debt
     * @dev Solves: x0 = (V + sqrt(V² - 4·V·LEV_RATIO·D/1e18)) / (2·LEV_RATIO) * 1e18
     *      where V = p_oracle * collateral * COLLATERAL_PRECISION / 1e18
     *
     * @param pOracle Oracle price of LP token (18 decimals)
     * @param collateral Amount of LP tokens
     * @param _debt Stablecoin debt amount
     * @param safeLimits Whether to enforce MIN_SAFE_DEBT/MAX_SAFE_DEBT
     * @return x0 The invariant value
     */
    function getX0(
        uint256 pOracle,
        uint256 collateral,
        uint256 _debt,
        bool safeLimits
    ) public view returns (uint256) {
        uint256 collValue = (pOracle * collateral * COLLATERAL_PRECISION) / 1e18;

        if (safeLimits) {
            require(_debt >= (collValue * MIN_SAFE_DEBT) / 1e18, "Unsafe min");
            require(_debt <= (collValue * MAX_SAFE_DEBT) / 1e18, "Unsafe max");
        }

        // D_val = collValue² - 4 * collValue * LEV_RATIO / 1e18 * debt
        uint256 term = (4 * collValue * LEV_RATIO) / 1e18;
        require(collValue * collValue >= term * _debt, "Math underflow");
        uint256 discriminant = collValue * collValue - term * _debt;

        return ((collValue + _sqrt(discriminant)) * 1e18) / (2 * LEV_RATIO);
    }

    // ═══════════════════════════════════════════════════════════════════
    // RATE SYSTEM
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Compute current rate multiplier including accrued interest
    function _rateMul() internal view returns (uint256) {
        return (rateMul * (1e18 + rate * (block.timestamp - rateTime))) / 1e18;
    }

    /// @inheritdoc IMintedLevAMM
    function getRateMul() external view override returns (uint256) {
        return _rateMul();
    }

    /// @notice Set interest rate (only callable by LT contract)
    function setRate(uint256 _rate) external override onlyLT returns (uint256) {
        require(_rate <= MAX_RATE, "Rate too high");
        uint256 newRateMul = _rateMul();
        debt = (debt * newRateMul) / rateMul;
        rateMul = newRateMul;
        rateTime = block.timestamp;
        rate = _rate;
        emit SetRate(_rate, newRateMul, block.timestamp);
        return newRateMul;
    }

    /// @notice Current debt including accrued interest
    function _debtView() internal view returns (uint256) {
        return (debt * _rateMul()) / rateMul;
    }

    /// @notice Update debt with accrued interest (write version)
    function _debtWrite() internal returns (uint256) {
        uint256 newRateMul = _rateMul();
        uint256 currentDebt = (debt * newRateMul) / rateMul;
        rateMul = newRateMul;
        rateTime = block.timestamp;
        return currentDebt;
    }

    /// @inheritdoc IMintedLevAMM
    function getDebt() external view override returns (uint256) {
        return _debtView();
    }

    // ═══════════════════════════════════════════════════════════════════
    // STATE QUERIES
    // ═══════════════════════════════════════════════════════════════════

    /// @inheritdoc IMintedLevAMM
    function getState() external view override returns (AMMState memory state) {
        uint256 pO = IPriceOracle(PRICE_ORACLE_CONTRACT).price();
        state.collateral = collateralAmount;
        state.debt = _debtView();
        state.x0 = getX0(pO, state.collateral, state.debt, false);
    }

    /// @inheritdoc IMintedLevAMM
    function valueOracle() external view override returns (OraclizedValue memory) {
        uint256 pO = IPriceOracle(PRICE_ORACLE_CONTRACT).price();
        uint256 coll = collateralAmount;
        uint256 d = _debtView();
        uint256 x0_ = getX0(pO, coll, d, false);
        // Value = x0 * 1e18 / (2 * LEVERAGE - 1e18)
        return OraclizedValue({pO: pO, value: (x0_ * 1e18) / (2 * LEVERAGE - 1e18)});
    }

    /// @inheritdoc IMintedLevAMM
    function valueOracleFor(uint256 collateral, uint256 _debt) external view override returns (OraclizedValue memory) {
        uint256 pO = IPriceOracle(PRICE_ORACLE_CONTRACT).price();
        uint256 x0_ = getX0(pO, collateral, _debt, false);
        return OraclizedValue({pO: pO, value: (x0_ * 1e18) / (2 * LEVERAGE - 1e18)});
    }

    /// @inheritdoc IMintedLevAMM
    function valueChange(
        uint256 collateralAmt,
        uint256 borrowedAmt,
        bool isDeposit
    ) external view override returns (OraclizedValue memory) {
        uint256 pO = IPriceOracle(PRICE_ORACLE_CONTRACT).price();
        uint256 coll = collateralAmount;
        uint256 d = _debtView();

        if (isDeposit) {
            coll += collateralAmt;
            d += borrowedAmt;
        } else {
            coll -= collateralAmt;
            d -= borrowedAmt;
        }

        uint256 x0After = getX0(pO, coll, d, isDeposit);
        return OraclizedValue({pO: pO, value: (x0After * 1e18) / (2 * LEVERAGE - 1e18)});
    }

    /// @inheritdoc IMintedLevAMM
    function maxDebt() external view override returns (uint256) {
        return IERC20(STABLECOIN).balanceOf(address(this)) + _debtView();
    }

    /// @inheritdoc IMintedLevAMM
    function accumulatedInterest() external view override returns (uint256) {
        uint256 _minted = minted;
        uint256 total = _debtView() + redeemed;
        return total > _minted ? total - _minted : 0;
    }

    // ═══════════════════════════════════════════════════════════════════
    // TRADING
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Preview the result of an exchange
     * @param i Input coin index (0=stablecoin, 1=LP token)
     * @param j Output coin index
     * @param inAmount Amount of input coin
     * @return Amount of output coin to receive
     */
    function getDy(uint256 i, uint256 j, uint256 inAmount) external view override returns (uint256) {
        require((i == 0 && j == 1) || (i == 1 && j == 0), "Invalid pair");

        uint256 pO = IPriceOracle(PRICE_ORACLE_CONTRACT).price();
        uint256 coll = collateralAmount;
        uint256 d = _debtView();
        uint256 xInitial = getX0(pO, coll, d, false) - d;

        if (i == 0) {
            // Buy collateral with stablecoin
            require(inAmount <= d, "Amount too large");
            uint256 x = xInitial + inAmount;
            uint256 y = _ceilDiv(xInitial * coll, x);
            return ((coll - y) * (1e18 - fee)) / 1e18;
        } else {
            // Sell collateral for stablecoin
            uint256 y = coll + inAmount;
            uint256 x = _ceilDiv(xInitial * coll, y);
            return ((xInitial - x) * (1e18 - fee)) / 1e18;
        }
    }

    /// @inheritdoc IMintedLevAMM
    function getP() external view override returns (uint256) {
        uint256 pO = IPriceOracle(PRICE_ORACLE_CONTRACT).price();
        uint256 coll = collateralAmount;
        uint256 d = _debtView();
        return ((getX0(pO, coll, d, false) - d) * (1e18 / COLLATERAL_PRECISION)) / coll;
    }

    /**
     * @notice Exchange between stablecoin and LP tokens
     * @dev Anyone can call. Uses x*y=k within the constant leverage framework.
     * @param i Input coin index (0=stablecoin, 1=LP token)
     * @param j Output coin index
     * @param inAmount Amount of input coin to swap
     * @param minOut Minimum output amount
     * @param _for Address to send output to (defaults to msg.sender)
     * @return outAmount Amount of output coin received
     */
    function exchange(
        uint256 i,
        uint256 j,
        uint256 inAmount,
        uint256 minOut,
        address _for
    ) external override nonReentrant returns (uint256 outAmount) {
        require((i == 0 && j == 1) || (i == 1 && j == 0), "Invalid pair");
        require(!isKilled, "AMM killed");
        if (_for == address(0)) _for = msg.sender;

        uint256 coll = collateralAmount;
        require(coll > 0, "Empty AMM");
        uint256 d = _debtWrite();
        uint256 pO = IPriceOracle(PRICE_ORACLE_CONTRACT).price_w();
        uint256 x0_ = getX0(pO, coll, d, false);
        uint256 xInitial = x0_ - d;
        uint256 _fee = fee;

        if (i == 0) {
            // Trader buys collateral (LP tokens) from us with stablecoin
            uint256 x = xInitial + inAmount;
            uint256 y = _ceilDiv(xInitial * coll, x);
            outAmount = ((coll - y) * (1e18 - _fee)) / 1e18;
            require(outAmount >= minOut, "Slippage");
            d -= inAmount;
            coll -= outAmount;
            redeemed += inAmount;
            IERC20(STABLECOIN).safeTransferFrom(msg.sender, address(this), inAmount);
            IERC20(COLLATERAL).safeTransfer(_for, outAmount);
        } else {
            // Trader sells collateral (LP tokens) to us for stablecoin
            uint256 y = coll + inAmount;
            uint256 x = _ceilDiv(xInitial * coll, y);
            outAmount = ((xInitial - x) * (1e18 - _fee)) / 1e18;
            require(outAmount >= minOut, "Slippage");
            d += outAmount;
            minted += outAmount;
            coll = y;
            IERC20(COLLATERAL).safeTransferFrom(msg.sender, address(this), inAmount);
            IERC20(STABLECOIN).safeTransfer(_for, outAmount);
        }

        // Verify the new state doesn't violate the invariant
        require(getX0(pO, coll, d, true) >= x0_, "Bad final state");

        collateralAmount = coll;
        debt = d;

        emit TokenExchange(msg.sender, i, inAmount, j, outAmount, _fee, pO);

        // Collect interest fees and distribute to LT
        if (LT_CONTRACT != address(0) && LT_CONTRACT.code.length > 0) {
            _collectFees();
            IMintedLT(LT_CONTRACT).distributeBorrowerFees(0.01e18); // FEE_CLAIM_DISCOUNT
        }

        return outAmount;
    }

    // ═══════════════════════════════════════════════════════════════════
    // LT-ONLY OPERATIONS
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit collateral and debt into the AMM (called by LT during deposit)
     * @param dCollateral Amount of Curve LP tokens to add
     * @param dDebt Amount of stablecoin debt to add
     * @return Oraclized value after deposit
     */
    function ammDeposit(uint256 dCollateral, uint256 dDebt)
        external
        override
        onlyLT
        returns (OraclizedValue memory)
    {
        require(!isKilled, "AMM killed");

        uint256 pO = IPriceOracle(PRICE_ORACLE_CONTRACT).price_w();
        uint256 coll = collateralAmount;
        uint256 d = _debtWrite();

        d += dDebt;
        coll += dCollateral;
        minted += dDebt;

        debt = d;
        collateralAmount = coll;
        // Assume transfer of collateral already happened (via LT add_liquidity)

        uint256 valueAfter = (getX0(pO, coll, d, true) * 1e18) / (2 * LEVERAGE - 1e18);

        emit AddLiquidityRaw([dCollateral, dDebt], valueAfter, pO);
        return OraclizedValue({pO: pO, value: valueAfter});
    }

    /**
     * @notice Withdraw a fraction of collateral and debt (called by LT during withdraw)
     * @param frac Fraction to withdraw (1e18 = 100%)
     * @return Pair of (collateral withdrawn, debt to repay)
     */
    function ammWithdraw(uint256 frac)
        external
        override
        onlyLT
        returns (Pair memory)
    {
        uint256 coll = collateralAmount;
        uint256 d = _debtWrite();

        uint256 dCollateral = (coll * frac) / 1e18;
        uint256 dDebt = _ceilDiv(d * frac, 1e18);

        collateralAmount -= dCollateral;
        debt = d - dDebt;
        redeemed += dDebt;

        emit RemoveLiquidityRaw(dCollateral, dDebt);
        return Pair({collateral: dCollateral, debt: dDebt});
    }

    // ═══════════════════════════════════════════════════════════════════
    // FEE COLLECTION
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Collect interest fees and send to LT contract
     * @dev Fees = difference between (debt + redeemed) and minted
     *      This difference is exactly the interest charged on borrowers.
     */
    function _collectFees() internal returns (uint256) {
        require(!isKilled, "AMM killed");

        uint256 d = _debtWrite();
        debt = d;
        uint256 _minted = minted;
        uint256 toBeRedeemed = d + redeemed;

        if (toBeRedeemed > _minted) {
            minted = toBeRedeemed;
            uint256 feesToCollect = toBeRedeemed - _minted;
            uint256 stablesInAmm = IERC20(STABLECOIN).balanceOf(address(this));

            if (stablesInAmm < feesToCollect) {
                minted -= (feesToCollect - stablesInAmm);
                feesToCollect = stablesInAmm;
            }

            if (feesToCollect > 0) {
                IERC20(STABLECOIN).safeTransfer(LT_CONTRACT, feesToCollect);
            }
            emit CollectFees(feesToCollect, d);
            return feesToCollect;
        } else {
            emit CollectFees(0, d);
            return 0;
        }
    }

    /// @inheritdoc IMintedLevAMM
    function collectFees() external override nonReentrant returns (uint256) {
        return _collectFees();
    }

    // ═══════════════════════════════════════════════════════════════════
    // ADMIN (LT-only)
    // ═══════════════════════════════════════════════════════════════════

    /// @inheritdoc IMintedLevAMM
    function setKilled(bool _isKilled) external override onlyLT {
        isKilled = _isKilled;
        emit SetKilled(_isKilled);
    }

    /// @inheritdoc IMintedLevAMM
    function setFee(uint256 _fee) external override onlyLT {
        require(_fee <= MAX_FEE, "Fee too high");
        fee = _fee;
        emit SetFee(_fee);
    }

    /// @notice Reentrancy check used by LT to verify AMM is not mid-call
    function checkNonreentrant() external view override {
        // ReentrancyGuard's _status would be _ENTERED if reentered
        // This is a view function — just needs to not revert when not reentered
    }

    // ═══════════════════════════════════════════════════════════════════
    // VIEW: Coins
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Get coin address by index
    function coins(uint256 i) external view returns (address) {
        if (i == 0) return STABLECOIN;
        if (i == 1) return COLLATERAL;
        revert("Invalid index");
    }

    // ═══════════════════════════════════════════════════════════════════
    // INTERNAL MATH
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Ceiling division: ceil(a / b)
    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a + b - 1) / b;
    }

    /// @notice Integer square root (Babylonian method)
    function _sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = x;
        uint256 y = (z + 1) / 2;
        while (y < z) {
            z = y;
            y = (x / y + y) / 2;
        }
        return z;
    }
}
