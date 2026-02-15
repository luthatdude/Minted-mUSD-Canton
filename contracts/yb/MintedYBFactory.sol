// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/IYieldBasis.sol";
import "./MintedLevAMM.sol";
import "./MintedLT.sol";
import "./MintedLPOracle.sol";

/**
 * @title MintedYBFactory
 * @notice Factory for creating Yield Basis markets — Solidity port of Factory.vy
 * @dev Creates and manages YB markets. Each market consists of:
 *      - LT (Leveraged Liquidity Token) — user-facing deposit/withdraw
 *      - AMM (LEVAMM) — constant leverage AMM holding Curve LP collateral
 *      - PriceOracle — LP token price oracle
 *
 * The factory:
 *   1. Deploys new markets for Curve pools (e.g., crvUSD/WBTC, crvUSD/WETH)
 *   2. Manages stablecoin allocation to markets
 *   3. Stores admin configuration (fee receiver, gauge controller, etc.)
 *
 * Key design decisions vs original Factory.vy:
 *   - Uses `new` instead of Vyper's create_from_blueprint
 *   - VirtualPool and Staker are optional (set separately)
 *   - LEVERAGE is fixed at 2x (same as original)
 *
 * @author Minted Protocol — ported from Scientia Spectra AG yb-core Factory.vy
 */
contract MintedYBFactory is IMintedYBFactory, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Maximum number of markets
    uint256 public constant MAX_MARKETS = 50_000;

    /// @notice Fixed leverage: 2x (2 * 1e18)
    uint256 public constant LEVERAGE = 2e18;

    // ═══════════════════════════════════════════════════════════════════
    // IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════

    /// @notice The stablecoin used across all markets (e.g., crvUSD, USDC)
    IERC20 public immutable STABLECOIN;

    // ═══════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Factory admin
    address public override admin;

    /// @notice Emergency admin (can kill pools)
    address public override emergencyAdmin;

    /// @notice Receives admin fees from all markets
    address public override feeReceiver;

    /// @notice Gauge controller for staking rewards
    address public override gaugeController;

    /// @notice Minimum admin fee across all markets (1e18-based)
    uint256 public override minAdminFee;

    /// @notice Price aggregator for stablecoin → USD
    address public aggAddress;

    /// @notice Flash loan facility (for VirtualPool)
    address public override flash;

    /// @notice Number of markets created
    uint256 public override marketCount;

    /// @notice Market data by index
    mapping(uint256 => Market) public _markets;

    /// @notice External allocator balances
    mapping(address => uint256) public allocators;

    /// @notice Mint factory (crvUSD-style minter)
    address public mintFactory;

    // ═══════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event MarketParameters(
        uint256 indexed idx,
        address assetToken,
        address cryptopool,
        address amm,
        address lt,
        address priceOracle,
        address virtualPool,
        address staker_,
        address agg_
    );
    event SetAdmin(address admin_, address emergencyAdmin_, address oldAdmin, address oldEmergencyAdmin);
    event SetFeeReceiver(address feeReceiver_);
    event SetGaugeController(address gc);
    event SetMinAdminFee(uint256 adminFee);
    event SetAgg(address agg_);
    event SetFlash(address flash_);
    event SetAllocator(address allocator, uint256 amount);

    // ═══════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @param _stablecoin Stablecoin address (must be 18 decimals)
     * @param _admin Initial admin
     * @param _emergencyAdmin Emergency admin
     * @param _feeReceiver Fee receiver
     * @param _agg Price aggregator address
     */
    constructor(
        address _stablecoin,
        address _admin,
        address _emergencyAdmin,
        address _feeReceiver,
        address _agg
    ) {
        require(_stablecoin != address(0), "Zero stablecoin");
        require(_admin != address(0), "Zero admin");
        require(_emergencyAdmin != address(0), "Zero emergency admin");
        require(_feeReceiver != address(0), "Zero fee receiver");
        require(_agg != address(0), "Zero aggregator");

        STABLECOIN = IERC20(_stablecoin);
        admin = _admin;
        emergencyAdmin = _emergencyAdmin;
        feeReceiver = _feeReceiver;
        aggAddress = _agg;

        // Validate aggregator returns sane price
        uint256 p = IPriceAggregator(_agg).price();
        require(p > 0.9e18 && p < 1.1e18, "Bad aggregator");
    }

    // ═══════════════════════════════════════════════════════════════════
    // MARKET CREATION
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Create a new YB market for a Curve crypto pool
     * @dev Deploys: PriceOracle + LT + AMM, links them together,
     *      and allocates stablecoins for lending.
     *
     * @param pool Curve Twocrypto pool (coins(0)=stablecoin, coins(1)=crypto)
     * @param fee_ Trading fee for the AMM (1e18-based, e.g. 0.003e18 = 0.3%)
     * @param rate Initial borrow rate (1e18-based fraction per second)
     * @param debtCeiling Maximum stablecoin allocation for this market
     * @return market The created market descriptor
     */
    function addMarket(
        address pool,
        uint256 fee_,
        uint256 rate,
        uint256 debtCeiling
    ) external override nonReentrant returns (Market memory market) {
        require(msg.sender == admin, "Access");
        require(ICurvePool(pool).coins(0) == address(STABLECOIN), "Wrong stablecoin");
        require(ICurvePool(pool).decimals() == 18, "Wrong decimals");

        uint256 idx = marketCount;
        require(idx < MAX_MARKETS, "Too many markets");

        market.assetToken = ICurvePool(pool).coins(1);
        market.cryptopool = pool;

        // Deploy PriceOracle
        MintedLPOracle oracle = new MintedLPOracle(pool, aggAddress);
        market.priceOracle = address(oracle);

        // Deploy LT
        MintedLT lt = new MintedLT(
            market.assetToken,
            address(STABLECOIN),
            pool,
            address(this) // factory is admin
        );
        market.lt = address(lt);

        // Deploy AMM (LEVAMM)
        MintedLevAMM amm = new MintedLevAMM(
            address(lt),
            address(STABLECOIN),
            pool, // Curve LP token = collateral
            LEVERAGE,
            fee_,
            address(oracle)
        );
        market.amm = address(amm);

        // Link LT → AMM
        lt.setAmm(address(amm));
        lt.setRate(rate);

        // Approve stablecoin for LT allocation
        STABLECOIN.forceApprove(address(lt), type(uint256).max);

        // Allocate stablecoins
        lt.allocateStablecoins(debtCeiling);

        // Store market
        marketCount = idx + 1;
        _markets[idx] = market;

        emit MarketParameters(
            idx,
            market.assetToken,
            market.cryptopool,
            market.amm,
            market.lt,
            market.priceOracle,
            market.virtualPool,
            market.staker,
            aggAddress
        );

        return market;
    }

    // ═══════════════════════════════════════════════════════════════════
    // MARKET QUERIES
    // ═══════════════════════════════════════════════════════════════════

    /// @inheritdoc IMintedYBFactory
    function markets(uint256 i) external view override returns (Market memory) {
        return _markets[i];
    }

    // ═══════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @inheritdoc IMintedYBFactory
    function setAdmin(address newAdmin, address newEmergencyAdmin) external override {
        require(msg.sender == admin, "Access");
        require(newAdmin != address(0) && newEmergencyAdmin != address(0), "Zero address");
        emit SetAdmin(newAdmin, newEmergencyAdmin, admin, emergencyAdmin);
        admin = newAdmin;
        emergencyAdmin = newEmergencyAdmin;
    }

    /// @inheritdoc IMintedYBFactory
    function setFeeReceiver(address newFeeReceiver) external override {
        require(msg.sender == admin, "Access");
        feeReceiver = newFeeReceiver;
        emit SetFeeReceiver(newFeeReceiver);
    }

    /// @notice Set gauge controller (only once)
    function setGaugeController(address gc) external {
        require(msg.sender == admin, "Access");
        require(gaugeController == address(0), "Already set");
        gaugeController = gc;
        emit SetGaugeController(gc);
    }

    /// @inheritdoc IMintedYBFactory
    function setMinAdminFee(uint256 newMinAdminFee) external override {
        require(msg.sender == admin, "Access");
        require(newMinAdminFee <= 1e18, "Admin fee too high");
        minAdminFee = newMinAdminFee;
        emit SetMinAdminFee(newMinAdminFee);
    }

    /// @notice Set or change stablecoin price aggregator
    function setAgg(address _agg) external {
        require(msg.sender == admin, "Access");
        require(_agg != address(0), "Zero agg");
        aggAddress = _agg;
        uint256 p = IPriceAggregator(_agg).price();
        require(p > 0.9e18 && p < 1.1e18, "Bad aggregator");
        emit SetAgg(_agg);
    }

    /// @notice Set flash loan facility
    function setFlash(address _flash) external {
        require(msg.sender == admin, "Access");
        flash = _flash;
        emit SetFlash(_flash);
    }

    /// @inheritdoc IMintedYBFactory
    function setAllocator(address allocator, uint256 amount) external override {
        require(msg.sender == admin, "Access");
        require(allocator != mintFactory, "Minter");
        require(allocator != address(0), "Zero allocator");

        uint256 oldAllocation = allocators[allocator];
        if (amount > oldAllocation) {
            STABLECOIN.safeTransferFrom(allocator, address(this), amount - oldAllocation);
            allocators[allocator] = amount;
        } else if (amount < oldAllocation) {
            uint256 currentAllowance = STABLECOIN.allowance(address(this), allocator);
            STABLECOIN.forceApprove(allocator, currentAllowance + oldAllocation - amount);
            allocators[allocator] = amount;
        }

        emit SetAllocator(allocator, amount);
    }

    /// @notice Set mint factory (only once)
    function setMintFactory(address _mintFactory) external nonReentrant {
        require(msg.sender == admin, "Access");
        require(mintFactory == address(0), "Only set once");
        require(_mintFactory != address(0), "Zero address");
        mintFactory = _mintFactory;
        STABLECOIN.forceApprove(_mintFactory, type(uint256).max);
    }
}
