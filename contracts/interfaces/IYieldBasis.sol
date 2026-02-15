// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

// ═══════════════════════════════════════════════════════════════════════════
// Yield Basis Core Interfaces — Faithful port from yb-core Vyper contracts
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @title ICurvePool
 * @notice Interface for Curve Twocrypto pools used as underlying LP backend
 * @dev YB leverages Curve 2-coin crypto pools (e.g. crvUSD/WBTC, crvUSD/WETH).
 *      The pool contract IS the LP token (ERC20).
 *      Requires "refueling" support (remove_liquidity_fixed_out).
 *      coins(0) = stablecoin, coins(1) = crypto asset
 */
interface ICurvePool {
    // ── Liquidity operations ──────────────────────────────────────────
    function add_liquidity(
        uint256[2] calldata amounts,
        uint256 min_mint_amount,
        address receiver,
        bool use_eth
    ) external returns (uint256);

    function remove_liquidity(
        uint256 amount,
        uint256[2] calldata min_amounts
    ) external returns (uint256[2] memory);

    /// @notice Remove liquidity getting a fixed amount of one coin + remainder of the other
    /// @param amount LP tokens to burn
    /// @param i Index of coin to receive a fixed amount of
    /// @param amount_i Fixed amount of coin i to receive
    /// @param extra_amount Extra amount parameter
    /// @return Amount of the OTHER coin received
    function remove_liquidity_fixed_out(
        uint256 amount,
        uint256 i,
        uint256 amount_i,
        uint256 extra_amount
    ) external returns (uint256);

    // ── Preview functions ─────────────────────────────────────────────
    function calc_token_amount(
        uint256[2] calldata amounts,
        bool is_deposit
    ) external view returns (uint256);

    /// @notice Preview removal with fixed output of one coin
    function calc_withdraw_fixed_out(
        uint256 token_amount,
        uint256 i,
        uint256 amount_i
    ) external view returns (uint256);

    // ── Pool state ────────────────────────────────────────────────────
    function coins(uint256 i) external view returns (address);
    function balances(uint256 i) external view returns (uint256);
    function price_scale() external view returns (uint256);
    function virtual_price() external view returns (uint256);
    function lp_price() external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function decimals() external view returns (uint256);

    // ── ERC20 (LP token IS the pool) ──────────────────────────────────
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

/**
 * @title IPriceOracle
 * @notice Price oracle interface matching CryptopoolLPOracle.vy
 * @dev Returns the price of Curve LP tokens denominated in aggregated USD.
 *      price_w() is the write variant that may update internal EMA state.
 */
interface IPriceOracle {
    /// @notice Read-only LP price in aggregated USD (18 decimals)
    function price() external view returns (uint256);

    /// @notice Write variant — may update EMA or oracle state
    function price_w() external returns (uint256);

    /// @notice The aggregator contract
    function AGG() external view returns (address);
}

/**
 * @title IPriceAggregator
 * @notice Stablecoin price aggregator (e.g. crvUSD → USD)
 * @dev Returns ~1e18 when stablecoin is at peg
 */
interface IPriceAggregator {
    function price() external view returns (uint256);
    function price_w() external returns (uint256);
}

// ═══════════════════════════════════════════════════════════════════════════
// Structs — matching YB-core data structures
// ═══════════════════════════════════════════════════════════════════════════

/// @notice AMM state (from AMM.vy)
struct AMMState {
    uint256 collateral; // Curve LP tokens held
    uint256 debt;       // Stablecoin debt
    uint256 x0;         // Invariant value
}

/// @notice Oracle + value pair (from AMM.vy)
struct OraclizedValue {
    uint256 pO;    // Oracle price
    uint256 value; // Value in stablecoin terms
}

/// @notice Collateral/debt pair for withdrawals (from AMM.vy)
struct Pair {
    uint256 collateral;
    uint256 debt;
}

/// @notice Liquidity tracking (from LT.vy)
struct LiquidityValues {
    int256  admin;        // Admin fee accumulator (can be negative)
    uint256 total;        // Total value excluding admin fees
    uint256 idealStaked;  // Ideal staked value (for loss tracking)
    uint256 staked;       // Actual staked value
}

/// @notice Extended liquidity values with token supply info (from LT.vy)
struct LiquidityValuesOut {
    int256  admin;
    uint256 total;
    uint256 idealStaked;
    uint256 staked;
    uint256 stakedTokens;
    uint256 supplyTokens;
    int256  tokenReduction;
}

/// @notice Market descriptor (from Factory.vy)
struct Market {
    address assetToken;
    address cryptopool;
    address amm;
    address lt;
    address priceOracle;
    address virtualPool;
    address staker;
}

// ═══════════════════════════════════════════════════════════════════════════
// Core Contract Interfaces
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @title IMintedLevAMM
 * @notice Interface for the Minted LEVAMM — constant leverage AMM
 * @dev Port of AMM.vy. Holds Curve LP collateral + stablecoin debt.
 *      Trading pair: stablecoin (coin 0) ↔ Curve LP token (coin 1).
 *      Only LT contract can deposit/withdraw. Anyone can trade (exchange).
 */
interface IMintedLevAMM {
    // ── Trading ───────────────────────────────────────────────────────
    function exchange(uint256 i, uint256 j, uint256 inAmount, uint256 minOut, address _for) external returns (uint256);
    function getDy(uint256 i, uint256 j, uint256 inAmount) external view returns (uint256);
    function getP() external view returns (uint256);

    // ── LT-only operations ────────────────────────────────────────────
    function ammDeposit(uint256 dCollateral, uint256 dDebt) external returns (OraclizedValue memory);
    function ammWithdraw(uint256 frac) external returns (Pair memory);

    // ── State queries ─────────────────────────────────────────────────
    function getState() external view returns (AMMState memory);
    function getDebt() external view returns (uint256);
    function collateralAmount() external view returns (uint256);
    function valueOracle() external view returns (OraclizedValue memory);
    function valueOracleFor(uint256 collateral, uint256 debt) external view returns (OraclizedValue memory);
    function valueChange(uint256 collateralAmt, uint256 borrowedAmt, bool isDeposit) external view returns (OraclizedValue memory);
    function maxDebt() external view returns (uint256);
    function accumulatedInterest() external view returns (uint256);

    // ── Rate system ───────────────────────────────────────────────────
    function setRate(uint256 rate) external returns (uint256);
    function getRateMul() external view returns (uint256);
    function fee() external view returns (uint256);
    function setFee(uint256 _fee) external;

    // ── Admin ─────────────────────────────────────────────────────────
    function collectFees() external returns (uint256);
    function setKilled(bool _isKilled) external;
    function isKilled() external view returns (bool);
    function checkNonreentrant() external view;

    // ── Immutables ────────────────────────────────────────────────────
    function LT_CONTRACT() external view returns (address);
    function STABLECOIN() external view returns (address);
    function COLLATERAL() external view returns (address);
    function LEVERAGE() external view returns (uint256);
    function PRICE_ORACLE_CONTRACT() external view returns (address);
    function COLLATERAL_PRECISION() external view returns (uint256);
}

/**
 * @title IMintedLT
 * @notice Interface for the Minted Leveraged Liquidity Token
 * @dev Port of LT.vy. The main user-facing contract.
 *      Users deposit crypto assets (WBTC/WETH) + specify debt → get LT shares.
 *      Shares appreciate as LP fees accumulate.
 *      Implements ERC20 with ERC-4626-like deposit/withdraw pattern.
 */
interface IMintedLT {
    // ── Deposit / Withdraw ────────────────────────────────────────────
    function deposit(uint256 assets, uint256 debt, uint256 minShares, address receiver) external returns (uint256 shares);
    function withdraw(uint256 shares, uint256 minAssets, address receiver) external returns (uint256 assets);
    function emergencyWithdraw(uint256 shares, address receiver, address owner) external returns (uint256 asset, int256 stables);

    // ── Preview ───────────────────────────────────────────────────────
    function previewDeposit(uint256 assets, uint256 debt, bool raiseOverflow) external view returns (uint256 shares);
    function previewWithdraw(uint256 shares) external view returns (uint256 assets);
    function previewEmergencyWithdraw(uint256 shares) external view returns (uint256, int256);

    // ── Value / Price ─────────────────────────────────────────────────
    function pricePerShare() external view returns (uint256);

    // ── ERC20 ─────────────────────────────────────────────────────────
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);

    // ── Admin ─────────────────────────────────────────────────────────
    function setAmm(address _amm) external;
    function setRate(uint256 rate) external;
    function setAmmFee(uint256 fee_) external;
    function allocateStablecoins(uint256 limit) external;
    function setStaker(address _staker) external;
    function setKilled(bool _isKilled) external;
    function setAdmin(address newAdmin) external;
    function withdrawAdminFees() external;
    function distributeBorrowerFees(uint256 discount) external;

    // ── Staker ────────────────────────────────────────────────────────
    function checkpointStakerRebase() external;
    function updatedBalances() external view returns (uint256 supply, uint256 staked);

    // ── State ─────────────────────────────────────────────────────────
    function admin() external view returns (address);
    function getLevAmm() external view returns (address);
    function getStaker() external view returns (address);
    function stablecoinAllocation() external view returns (uint256);
    function stablecoinAllocated() external view returns (uint256);
    function isKilled() external view returns (bool);

    // ── Immutables ────────────────────────────────────────────────────
    function ASSET_TOKEN() external view returns (address);
    function STABLECOIN_TOKEN() external view returns (address);
    function CRYPTOPOOL() external view returns (address);
}

/**
 * @title IMintedYBFactory
 * @notice Interface for the Minted Yield Basis factory
 */
interface IMintedYBFactory {
    function addMarket(address pool, uint256 fee_, uint256 rate, uint256 debtCeiling) external returns (Market memory);
    function markets(uint256 i) external view returns (Market memory);
    function marketCount() external view returns (uint256);
    function admin() external view returns (address);
    function emergencyAdmin() external view returns (address);
    function feeReceiver() external view returns (address);
    function gaugeController() external view returns (address);
    function minAdminFee() external view returns (uint256);
    function flash() external view returns (address);
    function setAdmin(address newAdmin, address newEmergencyAdmin) external;
    function setFeeReceiver(address newFeeReceiver) external;
    function setMinAdminFee(uint256 newMinAdminFee) external;
    function setAllocator(address allocator, uint256 amount) external;
}

// ═══════════════════════════════════════════════════════════════════════════
// Legacy adapter interface — retained for backward compatibility
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @title IYieldBasisPool
 * @notice DEPRECATED — Legacy lender-centric interface from before YB source review.
 *         The real YB uses leveraged LP (IMintedLT), not lending pools.
 *         Retained only for MockYieldBasisPool and backward compatibility.
 */
interface IYieldBasisPool {
    function depositLend(uint256 amount, uint256 minShares) external returns (uint256 shares);
    function withdrawLend(uint256 shares, uint256 minAmount) external returns (uint256 amount);
    function lenderValue(address account) external view returns (uint256 value);
    function lenderShares(address account) external view returns (uint256 shares);
    function totalLenderAssets() external view returns (uint256 total);
    function lendingAPY() external view returns (uint256 apy);
    function utilization() external view returns (uint256 utilization_);
    function baseAsset() external view returns (address);
    function quoteAsset() external view returns (address);
    function acceptingDeposits() external view returns (bool);
}

/**
 * @title IYieldBasisRouter
 * @notice DEPRECATED — Legacy router interface
 */
interface IYieldBasisRouter {
    function getPool(address baseAsset_, address quoteAsset_) external view returns (address pool);
    function getActivePools() external view returns (address[] memory pools);
}
