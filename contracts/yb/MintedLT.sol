// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SignedMath.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/IYieldBasis.sol";

/**
 * @title MintedLT
 * @notice Leveraged Liquidity Token — Solidity port of LT.vy
 * @dev The main user-facing contract for the Yield Basis protocol.
 *
 * Users deposit crypto assets (e.g., WBTC) and specify a stablecoin debt amount.
 * The contract:
 *   1. Borrows stablecoin from AMM's allocation
 *   2. Adds both (stablecoin + crypto) as liquidity to the Curve pool
 *   3. Resulting LP tokens go to the AMM as collateral
 *   4. User receives LT shares proportional to value added
 *
 * The LT token is ERC20-compliant with an ERC-4626-like deposit/withdraw pattern.
 * Share price appreciates as LP fees accumulate and borrower interest is earned.
 *
 * Admin fee system:
 *   - A fraction of profits goes to admin (fee receiver) based on staker proportion
 *   - Uses a "token reduction" mechanism: instead of minting new fee tokens,
 *     staker token balance is reduced, effectively transferring value
 *   - This is a unique mechanism from YB that avoids dilution events
 *
 * Value tracking (LiquidityValues):
 *   - admin: accumulated admin fee (can be negative during losses)
 *   - total: total value excluding admin fees
 *   - idealStaked: ideal staked value for loss recovery tracking
 *   - staked: actual staked value
 *
 * Key constants from YB:
 *   - FEE_CLAIM_DISCOUNT = 1e16 (1% discount on borrower fee reinvestment)
 *   - MIN_SHARE_REMAINDER = 1e6 (minimum shares to prevent griefing)
 *   - SQRT_MIN_UNSTAKED_FRACTION = 1e14 (cap on admin fee token reduction)
 *   - MIN_STAKED_FOR_FEES = 10e18 (minimum staked tokens to charge admin fees)
 *
 * @author Minted Protocol — ported from Scientia Spectra AG yb-core LT.vy
 */
contract MintedLT is IMintedLT, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;
    using SignedMath for int256;

    // ═══════════════════════════════════════════════════════════════════
    // IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════

    /// @notice The crypto asset deposited by users (e.g., WBTC, WETH)
    address public immutable override ASSET_TOKEN;

    /// @notice The stablecoin used for borrowing (e.g., crvUSD, USDC)
    address public immutable override STABLECOIN_TOKEN;

    /// @notice The Curve Twocrypto pool (coins(0)=stablecoin, coins(1)=asset)
    address public immutable override CRYPTOPOOL;

    // ═══════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Discount applied when reinvesting borrower fees as LP (1%)
    uint256 public constant FEE_CLAIM_DISCOUNT = 0.01e18;

    /// @notice Minimum shares that must remain (prevents griefing attacks)
    uint256 public constant MIN_SHARE_REMAINDER = 1e6;

    /// @notice Cap on admin fee token reduction rate
    uint256 public constant SQRT_MIN_UNSTAKED_FRACTION = 1e14;

    /// @notice Minimum staked tokens to start charging admin fees
    int256 public constant MIN_STAKED_FOR_FEES = 10e18;

    // ═══════════════════════════════════════════════════════════════════
    // STATE — Admin & AMM
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Admin address (can be Factory or EOA)
    address public override admin;

    /// @notice The LEVAMM contract
    IMintedLevAMM public levAmm;

    /// @notice Price aggregator (via oracle → agg)
    IPriceAggregator public agg;

    /// @notice Staker/gauge contract (receives value via token reduction)
    address public staker;

    // ═══════════════════════════════════════════════════════════════════
    // STATE — Liquidity tracking
    // ═══════════════════════════════════════════════════════════════════

    LiquidityValues public liquidity;

    // ═══════════════════════════════════════════════════════════════════
    // STATE — ERC20
    // ═══════════════════════════════════════════════════════════════════

    mapping(address => mapping(address => uint256)) private _allowances;
    mapping(address => uint256) private _balances;
    uint256 private _totalSupply;

    // ═══════════════════════════════════════════════════════════════════
    // STATE — Stablecoin allocation
    // ═══════════════════════════════════════════════════════════════════

    uint256 public override stablecoinAllocation;
    uint256 public override stablecoinAllocated;

    // ═══════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares);
    event SetAdmin(address indexed admin_);
    event SetStaker(address indexed staker_);
    event AllocateStablecoins(address indexed allocator, uint256 allocation, uint256 allocated);
    event DistributeBorrowerFees(address indexed sender, uint256 amount, uint256 minAmount, uint256 discount);
    event WithdrawAdminFees(address indexed receiver, uint256 amount);

    // ═══════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @param _assetToken Crypto asset (e.g., WBTC)
     * @param _stablecoin Stablecoin (e.g., crvUSD) — must be 18 decimals
     * @param _cryptopool Curve Twocrypto pool (coins(0)=stablecoin, coins(1)=asset)
     * @param _admin Admin address (factory or EOA)
     */
    constructor(
        address _assetToken,
        address _stablecoin,
        address _cryptopool,
        address _admin
    ) {
        require(_assetToken != address(0), "Zero asset");
        require(_stablecoin != address(0), "Zero stable");
        require(_cryptopool != address(0), "Zero pool");
        require(_admin != address(0), "Zero admin");

        ASSET_TOKEN = _assetToken;
        STABLECOIN_TOKEN = _stablecoin;
        CRYPTOPOOL = _cryptopool;
        admin = _admin;

        // Approve Curve pool to spend both tokens for add_liquidity
        IERC20(_assetToken).forceApprove(_cryptopool, type(uint256).max);
        IERC20(_stablecoin).forceApprove(_cryptopool, type(uint256).max);

        // Verify pool configuration: coins(0)=stablecoin, coins(1)=asset
        require(ICurvePool(_cryptopool).coins(0) == _stablecoin, "Wrong stablecoin in pool");
        require(ICurvePool(_cryptopool).coins(1) == _assetToken, "Wrong asset in pool");
    }

    // ═══════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════════════════════

    modifier onlyAdmin() {
        _checkAdmin();
        _;
    }

    // ═══════════════════════════════════════════════════════════════════
    // DEPOSIT
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit crypto assets and borrow stablecoin for leveraged LP
     * @dev Flow:
     *   1. Borrow stablecoin from AMM (pre-allocated by factory)
     *   2. Pull asset tokens from depositor
     *   3. Add both to Curve pool → get LP tokens → send to AMM
     *   4. Record deposit in AMM (updates collateral + debt)
     *   5. Calculate shares based on value added
     *   6. Mint shares to receiver
     *
     * @param assets Amount of crypto asset to deposit
     * @param debtAmount Amount of stablecoin to borrow (≈ same value as assets)
     * @param minShares Minimum shares (slippage protection)
     * @param receiver Address to receive LT shares
     * @return shares LT shares minted
     */
    function deposit(
        uint256 assets,
        uint256 debtAmount,
        uint256 minShares,
        address receiver
    ) external override nonReentrant returns (uint256 shares) {
        if (receiver == address(0)) receiver = msg.sender;
        require(receiver != staker, "Deposit to staker");

        IMintedLevAMM _amm = levAmm;

        // 1. Borrow stablecoin from AMM
        IERC20(STABLECOIN_TOKEN).safeTransferFrom(address(_amm), address(this), debtAmount);

        // 2. Pull crypto asset from depositor
        IERC20(ASSET_TOKEN).safeTransferFrom(msg.sender, address(this), assets);

        // 3. Add liquidity to Curve pool → LP tokens go to AMM
        uint256[2] memory amounts = [debtAmount, assets];
        uint256 lpTokens = ICurvePool(CRYPTOPOOL).add_liquidity(amounts, 0, address(_amm), false);

        // 4. Get oracle price
        uint256 pO = _priceOracleW();
        uint256 supply = _totalSupply;

        // Calculate values BEFORE deposit (fees from add_liquidity go to existing LPs)
        LiquidityValuesOut memory lv;
        if (supply > 0) {
            lv = _calculateValues(pO);
        }

        // 5. Record deposit in AMM
        OraclizedValue memory v = _amm.ammDeposit(lpTokens, debtAmount);
        uint256 valueAfter = (v.value * 1e18) / pO;

        // Ensure debt doesn't exceed half of available stablecoins
        require(_amm.maxDebt() / 2 >= v.value, "Debt too high");

        // 6. Calculate shares
        if (supply > 0 && lv.total > 0) {
            supply = lv.supplyTokens;
            liquidity.admin = lv.admin;
            uint256 valueBefore = lv.total;
            valueAfter = uint256(int256(valueAfter) - lv.admin);
            liquidity.total = valueAfter;
            liquidity.staked = lv.staked;
            _totalSupply = lv.supplyTokens;

            if (staker != address(0)) {
                _balances[staker] = lv.stakedTokens;
                _logTokenReduction(staker, lv.tokenReduction);
            }

            shares = (supply * valueAfter) / valueBefore - supply;
        } else {
            // Initial deposit: 1 share = 1 unit of value
            shares = valueAfter;
            liquidity.idealStaked = 0;
            liquidity.staked = 0;
            liquidity.total = shares + supply;
            liquidity.admin = 0;

            if (_balances[staker] > 0) {
                emit Transfer(staker, address(0), _balances[staker]);
            }
            _balances[staker] = 0;
        }

        require(shares + supply >= MIN_SHARE_REMAINDER, "Remainder too small");
        require(shares >= minShares, "Slippage");

        _mint(receiver, shares);
        _distributeBorrowerFees(FEE_CLAIM_DISCOUNT);

        emit Deposit(msg.sender, receiver, assets, shares);
        return shares;
    }

    // ═══════════════════════════════════════════════════════════════════
    // WITHDRAW
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Withdraw crypto assets by burning LT shares
     * @dev Flow:
     *   1. Calculate current values (admin fees, token reduction)
     *   2. Compute fraction of AMM to withdraw
     *   3. Withdraw from AMM → get LP tokens + debt amount
     *   4. Transfer LP tokens from AMM to this contract
     *   5. Remove liquidity from Curve pool (fixed stablecoin out)
     *   6. Burn shares, send crypto asset to receiver, repay stablecoin to AMM
     *
     * @param shares LT shares to burn
     * @param minAssets Minimum crypto asset to receive
     * @param receiver Address to receive assets
     * @return cryptoReceived Amount of crypto asset returned
     */
    function withdraw(
        uint256 shares,
        uint256 minAssets,
        address receiver
    ) external override nonReentrant returns (uint256 cryptoReceived) {
        if (receiver == address(0)) receiver = msg.sender;
        require(shares > 0, "Withdrawing nothing");
        require(staker != msg.sender && staker != receiver, "Withdraw to/from staker");
        require(!levAmm.isKilled(), "Use emergency_withdraw");

        IMintedLevAMM _amm = levAmm;
        LiquidityValuesOut memory lv = _calculateValues(_priceOracleW());
        uint256 supply = lv.supplyTokens;

        liquidity.admin = lv.admin;
        liquidity.staked = lv.staked;
        _totalSupply = supply;

        require(
            supply >= MIN_SHARE_REMAINDER + shares || supply == shares,
            "Remainder too small"
        );

        if (staker != address(0)) {
            _balances[staker] = lv.stakedTokens;
            _logTokenReduction(staker, lv.tokenReduction);
        }

        // Calculate admin balance (only positive admin fees affect withdrawal fraction)
        uint256 adminBalance = lv.admin > 0 ? uint256(lv.admin) : 0;

        // Withdraw from AMM: fraction excludes admin fee portion
        uint256 frac = ((1e18 * lv.total) / (lv.total + adminBalance) * shares) / supply;
        Pair memory withdrawn = _amm.ammWithdraw(frac);

        // Transfer LP tokens from AMM → this contract
        IERC20(CRYPTOPOOL).safeTransferFrom(address(_amm), address(this), withdrawn.collateral);

        // Remove from Curve: get back exactly `withdrawn.debt` stablecoin + remainder as crypto
        cryptoReceived = ICurvePool(CRYPTOPOOL).remove_liquidity_fixed_out(
            withdrawn.collateral,
            0, // coin 0 = stablecoin
            withdrawn.debt,
            0
        );

        // Burn shares
        _burn(msg.sender, shares);
        liquidity.total = (lv.total * (supply - shares)) / supply;

        if (lv.admin < 0) {
            liquidity.admin = (lv.admin * int256(supply - shares)) / int256(supply);
        }

        require(cryptoReceived >= minAssets, "Slippage");

        // Repay stablecoin to AMM, send crypto to receiver
        IERC20(STABLECOIN_TOKEN).safeTransfer(address(_amm), withdrawn.debt);
        IERC20(ASSET_TOKEN).safeTransfer(receiver, cryptoReceived);

        _distributeBorrowerFees(FEE_CLAIM_DISCOUNT);

        emit Withdraw(msg.sender, receiver, msg.sender, cryptoReceived, shares);
        return cryptoReceived;
    }

    // ═══════════════════════════════════════════════════════════════════
    // EMERGENCY WITHDRAW
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Emergency withdraw — proportional removal without optimization
     * @dev When AMM is killed, uses simple proportional Curve removal.
     *      May return negative stables (user must provide stablecoin to cover debt).
     * @param shares Shares to burn
     * @param receiver Address to receive assets
     * @param owner Owner of shares to burn
     * @return cryptoAmount Amount of crypto received
     * @return stablesNet Signed stablecoin amount (negative = user owes)
     */
    function emergencyWithdraw(
        uint256 shares,
        address receiver,
        address owner
    ) external override nonReentrant returns (uint256 cryptoAmount, int256 stablesNet) {
        if (receiver == address(0)) receiver = msg.sender;
        require(staker != owner && staker != receiver, "Withdraw to/from staker");

        uint256 supply;
        LiquidityValuesOut memory lv;
        IMintedLevAMM _amm = levAmm;
        bool killed = _amm.isKilled();

        if (killed) {
            // When killed: simplified access control
            require(owner == msg.sender || msg.sender == admin, "Access");
            if (msg.sender == admin && msg.sender != owner) {
                require(receiver == owner, "receiver must be owner");
            }
            supply = _totalSupply;
        } else {
            require(owner == msg.sender, "Not killed");
            lv = _calculateValues(_priceOracleW());
            supply = lv.supplyTokens;
            liquidity.admin = lv.admin;
            liquidity.total = lv.total;
            liquidity.staked = lv.staked;
            _totalSupply = supply;
            if (staker != address(0)) {
                _balances[staker] = lv.stakedTokens;
                _logTokenReduction(staker, lv.tokenReduction);
            }
        }

        require(
            supply >= MIN_SHARE_REMAINDER + shares || supply == shares,
            "Remainder too small"
        );

        uint256 frac = (1e18 * shares) / supply;
        int256 fracClean = int256(frac);
        if (lv.admin > 0 && lv.total != 0) {
            frac = (frac * lv.total) / (uint256(lv.admin) + lv.total);
        }

        // Withdraw from AMM
        Pair memory withdrawnLevamm = _amm.ammWithdraw(frac);
        IERC20(CRYPTOPOOL).safeTransferFrom(address(_amm), address(this), withdrawnLevamm.collateral);

        // Proportional removal from Curve (no optimization)
        uint256[2] memory minAmounts = [uint256(0), uint256(0)];
        uint256[2] memory withdrawnCswap = ICurvePool(CRYPTOPOOL).remove_liquidity(
            withdrawnLevamm.collateral,
            minAmounts
        );

        stablesNet = int256(withdrawnCswap[0]) - int256(withdrawnLevamm.debt);
        cryptoAmount = withdrawnCswap[1];

        _burn(owner, shares);

        liquidity.total = (liquidity.total * (supply - shares)) / supply;
        if (liquidity.admin < 0 || killed) {
            liquidity.admin = (liquidity.admin * (1e18 - fracClean)) / 1e18;
        }

        // Handle stablecoin balance
        if (stablesNet > 0) {
            IERC20(STABLECOIN_TOKEN).safeTransfer(receiver, uint256(stablesNet));
        } else if (stablesNet < 0) {
            IERC20(STABLECOIN_TOKEN).safeTransferFrom(msg.sender, address(this), uint256(-stablesNet));
        }

        // Repay debt to AMM and send crypto to receiver
        IERC20(STABLECOIN_TOKEN).safeTransfer(address(_amm), withdrawnLevamm.debt);
        IERC20(ASSET_TOKEN).safeTransfer(receiver, cryptoAmount);

        return (cryptoAmount, stablesNet);
    }

    // ═══════════════════════════════════════════════════════════════════
    // PREVIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @inheritdoc IMintedLT
    function previewDeposit(
        uint256 assets,
        uint256 debtAmount,
        bool raiseOverflow
    ) external view override returns (uint256) {
        uint256[2] memory amounts = [debtAmount, assets];
        uint256 lpTokens = ICurvePool(CRYPTOPOOL).calc_token_amount(amounts, true);
        uint256 supply = _totalSupply;
        uint256 pO = _priceOracle();
        IMintedLevAMM _amm = levAmm;
        uint256 ammMaxDebt = _amm.maxDebt() / 2;

        if (supply > 0) {
            LiquidityValuesOut memory lv = _calculateValues(pO);
            if (lv.total > 0) {
                OraclizedValue memory v = _amm.valueChange(lpTokens, debtAmount, true);
                if (raiseOverflow) {
                    require(ammMaxDebt >= v.value, "Debt too high");
                }
                uint256 valueAfter = uint256(int256((v.value * 1e18) / pO) - lv.admin);
                return (lv.supplyTokens * valueAfter) / lv.total - lv.supplyTokens;
            }
        }

        OraclizedValue memory v = _amm.valueOracleFor(lpTokens, debtAmount);
        if (raiseOverflow) {
            require(ammMaxDebt >= v.value, "Debt too high");
        }
        return (v.value * 1e18) / pO;
    }

    /// @inheritdoc IMintedLT
    function previewWithdraw(uint256 shares) external view override returns (uint256) {
        LiquidityValuesOut memory v = _calculateValues(_priceOracle());
        AMMState memory state = levAmm.getState();
        uint256 adminBalance = v.admin > 0 ? uint256(v.admin) : 0;
        uint256 frac = ((1e18 * v.total) / (v.total + adminBalance) * shares) / v.supplyTokens;
        uint256 withdrawnLp = (state.collateral * frac) / 1e18;
        uint256 withdrawnDebt = (state.debt * frac) / 1e18;
        return ICurvePool(CRYPTOPOOL).calc_withdraw_fixed_out(withdrawnLp, 0, withdrawnDebt);
    }

    /// @inheritdoc IMintedLT
    function previewEmergencyWithdraw(uint256 shares) external view override returns (uint256, int256) {
        uint256 supply;
        LiquidityValuesOut memory lv;
        IMintedLevAMM _amm = levAmm;

        if (_amm.isKilled()) {
            supply = _totalSupply;
        } else {
            lv = _calculateValues(_priceOracle());
            supply = lv.supplyTokens;
        }

        uint256 frac = (1e18 * shares) / supply;
        if (lv.admin > 0 && lv.total != 0) {
            frac = (frac * lv.total) / (uint256(lv.admin) + lv.total);
        }

        uint256 lpCollateral = (_amm.collateralAmount() * frac) / 1e18;
        int256 debtVal = int256(_ceilDiv(_amm.getDebt() * frac, 1e18));

        uint256 cryptopoolSupply = ICurvePool(CRYPTOPOOL).totalSupply();
        uint256 bal0 = ICurvePool(CRYPTOPOOL).balances(0);
        uint256 bal1 = ICurvePool(CRYPTOPOOL).balances(1);

        uint256 withdrawAmt0 = (lpCollateral * bal0) / cryptopoolSupply;
        uint256 withdrawAmt1 = (lpCollateral * bal1) / cryptopoolSupply;

        return (withdrawAmt1, int256(withdrawAmt0) - debtVal);
    }

    // ═══════════════════════════════════════════════════════════════════
    // VALUE / PRICE
    // ═══════════════════════════════════════════════════════════════════

    /// @inheritdoc IMintedLT
    function pricePerShare() external view override returns (uint256) {
        if (_totalSupply == 0) return 1e18;
        LiquidityValuesOut memory v = _calculateValues(_priceOracle());
        return (v.total * 1e18) / v.supplyTokens;
    }

    // ═══════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Set AMM — only allowed once (at init time)
    function setAmm(address _amm) external override nonReentrant {
        _checkAdmin();
        require(address(levAmm) == address(0), "Already set");
        require(IMintedLevAMM(_amm).STABLECOIN() == STABLECOIN_TOKEN, "Wrong stablecoin");
        require(IMintedLevAMM(_amm).COLLATERAL() == CRYPTOPOOL, "Wrong collateral");
        require(IMintedLevAMM(_amm).LT_CONTRACT() == address(this), "Wrong LT");

        levAmm = IMintedLevAMM(_amm);
        agg = IPriceOracle(IMintedLevAMM(_amm).PRICE_ORACLE_CONTRACT()).AGG();
    }

    /// @notice Set borrow rate
    function setRate(uint256 _rate) external override nonReentrant {
        _checkAdmin();
        levAmm.setRate(_rate);
    }

    /// @notice Set AMM fee
    function setAmmFee(uint256 fee_) external override nonReentrant {
        _checkAdmin();
        levAmm.setFee(fee_);
    }

    /// @notice Set admin
    function setAdmin(address newAdmin) external override nonReentrant {
        _checkAdmin();
        admin = newAdmin;
        emit SetAdmin(newAdmin);
    }

    /// @notice Allocate stablecoins from admin/factory to AMM for lending
    function allocateStablecoins(uint256 limit) external override nonReentrant {
        address allocator = admin;
        uint256 allocation;
        uint256 allocated = stablecoinAllocated;

        if (limit == type(uint256).max) {
            allocation = stablecoinAllocation;
        } else {
            _checkAdmin();
            stablecoinAllocation = limit;
            allocation = limit;
        }

        levAmm.checkNonreentrant();

        if (allocation > allocated) {
            uint256 available = IERC20(STABLECOIN_TOKEN).balanceOf(allocator);
            uint256 toTransfer = allocation - allocated < available ? allocation - allocated : available;
            IERC20(STABLECOIN_TOKEN).safeTransferFrom(allocator, address(levAmm), toTransfer);
            allocated += toTransfer;
            stablecoinAllocated = allocated;
        } else if (allocation < allocated) {
            // Compute safe lower limit for deflating
            uint256 lpPrice = IPriceOracle(levAmm.PRICE_ORACLE_CONTRACT()).price_w();
            uint256 safeLowerLimit = (lpPrice * levAmm.collateralAmount() * 3) / (4 * 1e18);
            uint256 maxReduce = allocated > safeLowerLimit ? allocated - safeLowerLimit : 0;
            uint256 toTransfer = allocation < allocated ? allocated - allocation : 0;
            toTransfer = toTransfer < maxReduce ? toTransfer : maxReduce;
            uint256 ammBalance = IERC20(STABLECOIN_TOKEN).balanceOf(address(levAmm));
            toTransfer = toTransfer < ammBalance ? toTransfer : ammBalance;
            allocated -= toTransfer;
            IERC20(STABLECOIN_TOKEN).safeTransferFrom(address(levAmm), allocator, toTransfer);
            stablecoinAllocated = allocated;
        }

        emit AllocateStablecoins(allocator, allocation, allocated);
    }

    /// @notice Set staker contract — only once
    function setStaker(address _staker) external override nonReentrant {
        require(staker == address(0), "Staker already set");
        require(_staker != address(0), "Zero staker");
        _checkAdmin();

        uint256 stakerBalance = _balances[_staker];
        if (stakerBalance > 0) {
            // Transfer existing balance to fee receiver
            address feeReceiver = IMintedYBFactory(admin).feeReceiver();
            require(_staker != feeReceiver, "Staker=fee_receiver");
            _transfer(_staker, feeReceiver, stakerBalance);
        }

        staker = _staker;
        emit SetStaker(_staker);
    }

    /// @notice Kill or unkill the pool
    function setKilled(bool _isKilled) external override {
        address _admin = admin;
        if (_isCode(_admin)) {
            require(
                msg.sender == _admin ||
                msg.sender == IMintedYBFactory(_admin).admin() ||
                msg.sender == IMintedYBFactory(_admin).emergencyAdmin(),
                "Access"
            );
        } else {
            require(msg.sender == _admin, "Access");
        }
        levAmm.setKilled(_isKilled);
    }

    /// @notice Withdraw admin fees to DAO fee receiver
    function withdrawAdminFees() external override nonReentrant {
        address _admin = admin;
        require(_isCode(_admin), "Need factory");
        require(!levAmm.isKilled(), "Killed");
        levAmm.checkNonreentrant();

        address feeReceiver = IMintedYBFactory(_admin).feeReceiver();
        require(feeReceiver != address(0), "No fee_receiver");
        require(feeReceiver != staker, "Staker=fee_receiver");

        LiquidityValuesOut memory v = _calculateValues(_priceOracleW());
        require(v.admin >= 0, "Loss made admin fee negative");

        _totalSupply = v.supplyTokens;
        uint256 newTotal = v.total + uint256(v.admin);
        uint256 toMint = (v.supplyTokens * newTotal) / v.total - v.supplyTokens;

        _mint(feeReceiver, toMint);
        liquidity.total = newTotal;
        liquidity.admin = 0;
        liquidity.staked = v.staked;

        if (staker != address(0)) {
            _balances[staker] = v.stakedTokens;
            _logTokenReduction(staker, v.tokenReduction);
        }

        emit WithdrawAdminFees(feeReceiver, toMint);
    }

    /// @notice Distribute borrower fees — reinvest as LP
    function distributeBorrowerFees(uint256 discount) external override nonReentrant {
        if (discount > FEE_CLAIM_DISCOUNT) {
            _checkAdmin();
        }
        _distributeBorrowerFees(discount);
    }

    // ═══════════════════════════════════════════════════════════════════
    // STAKER FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @inheritdoc IMintedLT
    function checkpointStakerRebase() external override {
        address _staker = staker;
        bool killed = levAmm.isKilled();

        if (msg.sender == _staker && !killed) {
            LiquidityValuesOut memory lv = _calculateValues(_priceOracleW());
            liquidity.admin = lv.admin;
            liquidity.total = lv.total;
            liquidity.staked = lv.staked;
            _totalSupply = lv.supplyTokens;
            _balances[_staker] = lv.stakedTokens;
            _logTokenReduction(_staker, lv.tokenReduction);
        }
    }

    /// @inheritdoc IMintedLT
    function updatedBalances() external view override returns (uint256 supply, uint256 staked_) {
        if (_totalSupply > 0) {
            LiquidityValuesOut memory lv = _calculateValues(_priceOracle());
            return (lv.supplyTokens, lv.stakedTokens);
        }
        return (0, 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ERC20 IMPLEMENTATION
    // ═══════════════════════════════════════════════════════════════════

    function name() external view override returns (string memory) {
        return string.concat("Yield Basis liquidity for ", _getSymbol(ASSET_TOKEN));
    }

    function symbol() external view override returns (string memory) {
        return string.concat("yb-", _getSymbol(ASSET_TOKEN));
    }

    function decimals() external pure override returns (uint8) {
        return 18;
    }

    function totalSupply() external view override returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) external view override returns (uint256) {
        return _balances[account];
    }

    function allowance(address owner_, address spender) external view override returns (uint256) {
        return _allowances[owner_][spender];
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        _approve(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        uint256 currentAllowance = _allowances[from][msg.sender];
        if (currentAllowance != type(uint256).max) {
            require(currentAllowance >= amount, "ERC20: insufficient allowance");
            _approve(from, msg.sender, currentAllowance - amount);
        }
        _transfer(from, to, amount);
        return true;
    }

    // ═══════════════════════════════════════════════════════════════════
    // STATE GETTERS
    // ═══════════════════════════════════════════════════════════════════

    function getLevAmm() external view override returns (address) {
        return address(levAmm);
    }

    function getStaker() external view override returns (address) {
        return staker;
    }

    function isKilled() external view override returns (bool) {
        return levAmm.isKilled();
    }

    // ═══════════════════════════════════════════════════════════════════
    // INTERNAL — Value Calculation (core of the admin fee system)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Calculate current liquidity values including admin fee adjustments
     * @dev This is the most complex function — ports LT.vy _calculate_values().
     *      Tracks value changes, computes admin fees, and determines token reduction.
     *
     * The token reduction mechanism:
     *   Instead of minting new tokens for admin fees, staker token balance is
     *   reduced. This effectively transfers value from staker to admin without
     *   diluting other holders. The reduction is capped to prevent extreme cases.
     */
    /// @dev Intermediate computation state for _calculateValues
    struct _CalcTemp {
        int256 stakedTokens;
        int256 supply;
        int256 fA;
        int256 prevValue;
        int256 valueChangeAmt;
        int256 dvUse36;
        int256 adminFee;
        int256 newTotalValue36;
        int256 newStakedValue36;
    }

    function _calculateValues(uint256 pO) internal view returns (LiquidityValuesOut memory result) {
        LiquidityValues memory prev = liquidity;
        _CalcTemp memory t;

        if (staker != address(0)) {
            t.stakedTokens = int256(_balances[staker]);
        }
        t.supply = int256(_totalSupply);
        t.fA = _adminFeeFraction(t.supply, t.stakedTokens);

        {
            OraclizedValue memory ammValue = levAmm.valueOracle();
            int256 curValue = int256((ammValue.value * 1e18) / pO);
            t.prevValue = int256(prev.total);
            t.valueChangeAmt = curValue - (t.prevValue + prev.admin);
        }

        t.dvUse36 = _computeDvUse36(t.valueChangeAmt, t.fA, t.supply, t.stakedTokens, int256(prev.staked), int256(prev.idealStaked));
        t.adminFee = prev.admin + (t.valueChangeAmt - t.dvUse36 / 1e18);

        // Staked value change
        {
            int256 vStLoss = int256(prev.idealStaked) > int256(prev.staked) ? int256(prev.idealStaked) - int256(prev.staked) : int256(0);
            int256 dvS36;
            if (t.supply != 0) {
                dvS36 = (t.dvUse36 * t.stakedTokens) / t.supply;
            }
            if (t.dvUse36 > 0) {
                dvS36 = dvS36 < vStLoss * 1e18 ? dvS36 : vStLoss * 1e18;
            }
            t.newTotalValue36 = t.prevValue * 1e18 + t.dvUse36;
            if (t.newTotalValue36 < 0) t.newTotalValue36 = 0;
            t.newStakedValue36 = int256(prev.staked) * 1e18 + dvS36;
            if (t.newStakedValue36 < 0) t.newStakedValue36 = 0;
        }

        int256 tokenReduction = _computeTokenReduction(
            t.newTotalValue36, t.newStakedValue36, t.stakedTokens, t.supply,
            t.valueChangeAmt, t.prevValue, t.fA
        );

        result.admin = t.adminFee;
        result.total = uint256(t.newTotalValue36 / 1e18);
        result.idealStaked = prev.idealStaked;
        result.staked = uint256(t.newStakedValue36 / 1e18);
        result.stakedTokens = uint256(t.stakedTokens - tokenReduction);
        result.supplyTokens = uint256(t.supply - tokenReduction);
        result.tokenReduction = tokenReduction;
    }

    /// @dev Calculate admin fee fraction f_a
    function _adminFeeFraction(int256 supply, int256 stakedTokens) internal view returns (int256 fA) {
        uint256 minAdminFee_ = _minAdminFee();
        if (supply > 0) {
            uint256 unstakedFrac = uint256((supply - stakedTokens) * 1e18 / supply);
            uint256 sqrtUnstaked = _sqrt(unstakedFrac * 1e18);
            fA = int256(1e18 - ((1e18 - minAdminFee_) * sqrtUnstaked) / 1e18);
        }
    }

    /// @dev Compute dvUse36 — effective user value change scaled by 1e18
    function _computeDvUse36(
        int256 valueChangeAmt,
        int256 fA,
        int256 supply,
        int256 stakedTokens,
        int256 vSt,
        int256 vStIdeal
    ) internal pure returns (int256 dvUse36) {
        int256 vStLoss = vStIdeal > vSt ? vStIdeal - vSt : int256(0);

        if (stakedTokens >= MIN_STAKED_FOR_FEES) {
            if (valueChangeAmt > 0) {
                int256 vLoss = valueChangeAmt < (vStLoss * supply / stakedTokens) ?
                    valueChangeAmt : (vStLoss * supply / stakedTokens);
                dvUse36 = vLoss * 1e18 + (valueChangeAmt - vLoss) * (1e18 - fA);
            } else {
                dvUse36 = valueChangeAmt * 1e18;
            }
        } else {
            dvUse36 = valueChangeAmt * (1e18 - fA);
        }
    }

    /// @dev Compute token reduction (avoids stack-too-deep in _calculateValues)
    function _computeTokenReduction(
        int256 newTotalValue36,
        int256 newStakedValue36,
        int256 stakedTokens,
        int256 supply,
        int256 valueChangeAmt,
        int256 prevValue,
        int256 fA
    ) internal pure returns (int256 tokenReduction) {
        int256 denom = newTotalValue36 - newStakedValue36;
        if (denom != 0) {
            tokenReduction = (newTotalValue36 * stakedTokens) / denom
                - (newStakedValue36 * supply) / denom;
        }

        // Cap token reduction
        int256 maxTokenReduction;
        {
            int256 absChange = valueChangeAmt >= 0 ? valueChangeAmt : -valueChangeAmt;
            int256 denomPv = prevValue + valueChangeAmt + 1;
            if (denomPv != 0) {
                maxTokenReduction = (absChange * supply / denomPv) * (1e18 - fA) / int256(SQRT_MIN_UNSTAKED_FRACTION);
                if (maxTokenReduction < 0) maxTokenReduction = -maxTokenReduction;
            }
        }

        // Clamp
        if (stakedTokens > 0) {
            tokenReduction = tokenReduction < stakedTokens - 1 ? tokenReduction : stakedTokens - 1;
        }
        if (supply > 0) {
            tokenReduction = tokenReduction < supply - 1 ? tokenReduction : supply - 1;
        }
        if (tokenReduction >= 0) {
            tokenReduction = tokenReduction < maxTokenReduction ? tokenReduction : maxTokenReduction;
        } else {
            tokenReduction = tokenReduction > -maxTokenReduction ? tokenReduction : -maxTokenReduction;
        }
        // Don't allow negatives if denominator was too small
        if (denom < 1e4 * 1e18) {
            tokenReduction = tokenReduction > 0 ? tokenReduction : int256(0);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // INTERNAL — Fee distribution
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Distribute borrower fees — collect from AMM and reinvest as LP
     * @dev Collected stablecoin fees are added as single-sided liquidity to Curve pool,
     *      creating more LP tokens that increase the value for all LT holders.
     */
    function _distributeBorrowerFees(uint256 discount) internal {
        IMintedLevAMM _amm = levAmm;
        if (msg.sender != address(_amm)) {
            _amm.collectFees();
        }
        uint256 amount = IERC20(STABLECOIN_TOKEN).balanceOf(address(this));
        if (amount > 0) {
            uint256 lpPrice = ICurvePool(CRYPTOPOOL).lp_price();
            uint256 minAmount = ((1e18 - discount) * amount) / lpPrice;
            uint256[2] memory amounts = [amount, uint256(0)];
            ICurvePool(CRYPTOPOOL).add_liquidity(amounts, minAmount, address(0), true);
            emit DistributeBorrowerFees(msg.sender, amount, minAmount, discount);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // INTERNAL — Oracle
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Read-only combined oracle price
    function _priceOracle() internal view returns (uint256) {
        return (ICurvePool(CRYPTOPOOL).price_scale() * agg.price()) / 1e18;
    }

    /// @notice Write variant of combined oracle price
    function _priceOracleW() internal returns (uint256) {
        return (ICurvePool(CRYPTOPOOL).price_scale() * agg.price_w()) / 1e18;
    }

    // ═══════════════════════════════════════════════════════════════════
    // INTERNAL — Admin check
    // ═══════════════════════════════════════════════════════════════════

    function _checkAdmin() internal view {
        address _admin = admin;
        if (_isCode(_admin)) {
            require(
                msg.sender == _admin || msg.sender == IMintedYBFactory(_admin).admin(),
                "Access"
            );
        } else {
            require(msg.sender == _admin, "Access");
        }
    }

    function _minAdminFee() internal view returns (uint256) {
        address _admin = admin;
        if (_isCode(_admin)) {
            return IMintedYBFactory(_admin).minAdminFee();
        }
        return 0;
    }

    // ═══════════════════════════════════════════════════════════════════
    // INTERNAL — ERC20 helpers
    // ═══════════════════════════════════════════════════════════════════

    function _mint(address to, uint256 amount) internal {
        _balances[to] += amount;
        _totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function _burn(address from, uint256 amount) internal {
        require(_balances[from] >= amount, "ERC20: burn exceeds balance");
        _balances[from] -= amount;
        _totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    function _approve(address owner_, address spender, uint256 amount) internal {
        _allowances[owner_][spender] = amount;
        emit Approval(owner_, spender, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(this) && to != address(0), "Invalid recipient");

        address _staker = staker;
        bool stakerUsed = (_staker != address(0) && (from == _staker || to == _staker));

        if (stakerUsed) {
            require(from != to, "Self transfer");

            LiquidityValuesOut memory lv;
            if (msg.sender == _staker || levAmm.isKilled()) {
                // Staker initiated — use current values without recalculation
                lv.idealStaked = liquidity.idealStaked;
                lv.staked = liquidity.staked;
                lv.total = liquidity.total;
                lv.supplyTokens = _totalSupply;
                lv.stakedTokens = _balances[_staker];
            } else {
                lv = _calculateValues(_priceOracleW());
                liquidity.admin = lv.admin;
                liquidity.total = lv.total;
                _totalSupply = lv.supplyTokens;
                _balances[_staker] = lv.stakedTokens;
                _logTokenReduction(_staker, lv.tokenReduction);
            }

            if (from == _staker) {
                // Reduce staked portion
                if (lv.supplyTokens > 0) {
                    lv.staked -= (lv.total * amount) / lv.supplyTokens;
                }
                if (lv.stakedTokens > 0) {
                    lv.idealStaked = (lv.idealStaked * (lv.stakedTokens - amount)) / lv.stakedTokens;
                }
            } else if (to == _staker) {
                // Increase staked portion
                uint256 dStakedValue = (lv.total * amount) / lv.supplyTokens;
                lv.staked += dStakedValue;
                if (lv.stakedTokens > 1e10) {
                    lv.idealStaked = (lv.idealStaked * (lv.stakedTokens + amount)) / lv.stakedTokens;
                } else {
                    lv.idealStaked += dStakedValue;
                }
            }

            liquidity.staked = lv.staked;
            liquidity.idealStaked = lv.idealStaked;
        }

        _balances[from] -= amount;
        _balances[to] += amount;

        emit Transfer(from, to, amount);
    }

    function _logTokenReduction(address _staker, int256 tokenReduction) internal {
        if (tokenReduction < 0) {
            emit Transfer(address(0), _staker, uint256(-tokenReduction));
        }
        if (tokenReduction > 0) {
            emit Transfer(_staker, address(0), uint256(tokenReduction));
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // INTERNAL — Utilities
    // ═══════════════════════════════════════════════════════════════════

    function _isCode(address addr) internal view returns (bool) {
        return addr.code.length > 0;
    }

    function _getSymbol(address token) internal view returns (string memory) {
        // Try to get symbol from token — fallback to "???"
        (bool success, bytes memory data) = token.staticcall(
            abi.encodeWithSignature("symbol()")
        );
        if (success && data.length > 0) {
            return abi.decode(data, (string));
        }
        return "???";
    }

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

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a + b - 1) / b;
    }
}
