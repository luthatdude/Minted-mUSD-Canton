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
//                    CONTANGO CORE-V2 INTERFACES
// ═══════════════════════════════════════════════════════════════════════════

/// @notice Contango core contract — multi-money-market leverage protocol
/// @dev Mainnet: 0x6Cae28b3D09D8f8Fc74fAdcc4F15bc0e8825bE3D
interface IContango {
    function trade(TradeParams calldata tradeParams, ExecutionParams calldata execParams)
        external
        payable
        returns (bytes32 positionId, Trade memory trade_);

    function tradeOnBehalfOf(TradeParams calldata tradeParams, ExecutionParams calldata execParams, address onBehalfOf)
        external
        payable
        returns (bytes32 positionId, Trade memory trade_);

    function claimRewards(bytes32 positionId, address to) external;

    function instrument(bytes32 symbol) external view returns (Instrument memory);

    function positionNFT() external view returns (address);
    function vault() external view returns (address);
}

/// @notice Contango Vault — custodial token storage
interface IContangoVault {
    function depositTo(IERC20 token, address account, uint256 amount) external;
    function withdraw(IERC20 token, address account, uint256 amount, address to) external;
    function balanceOf(IERC20 token, address account) external view returns (uint256);
}

/// @notice Contango Lens — read-only position data
interface IContangoLens {
    function balances(bytes32 positionId) external view returns (Balances memory balances_);
    function leverage(bytes32 positionId) external view returns (uint256 leverage_);
    function netRate(bytes32 positionId) external view returns (int256 netRate_);
    function rates(bytes32 positionId) external view returns (uint256 borrowing, uint256 lending);
    function metaData(bytes32 positionId) external returns (MetaData memory metaData_);
}

/// @notice Contango PositionNFT — ERC721 position ownership
interface IPositionNFT {
    function exists(bytes32 positionId) external view returns (bool);
    function positionOwner(bytes32 positionId) external view returns (address);
    function setApprovalForAll(address operator, bool approved) external;
    function isApprovedForAll(address owner, address operator) external view returns (bool);
}

// ─── Contango Data Types ─────────────────────────────────────────────────

struct TradeParams {
    bytes32 positionId;
    int256 quantity;
    uint256 limitPrice;
    uint8 cashflowCcy;     // 0 = None, 1 = Base, 2 = Quote
    int256 cashflow;
}

struct ExecutionParams {
    address spender;
    address router;
    uint256 swapAmount;
    bytes swapBytes;
    address flashLoanProvider;
}

struct Trade {
    int256 quantity;
    SwapInfo swap;
    uint8 cashflowCcy;
    int256 cashflow;
    uint256 fee;
    uint8 feeCcy;
    uint256 forwardPrice;
}

struct SwapInfo {
    uint8 inputCcy;
    int256 input;
    int256 output;
    uint256 price;
}

struct Instrument {
    IERC20 base;
    uint256 baseUnit;
    IERC20 quote;
    uint256 quoteUnit;
    bool closingOnly;
}

struct Balances {
    uint256 collateral;
    uint256 debt;
}

struct MetaData {
    Balances balances;
    uint256 leverage;
    int256 netRate;
    uint256 healthFactor;
}

/// @notice Uniswap V3 Router for reward → USDC swaps
interface ISwapRouterV3Contango {
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

/**
 * @title ContangoLoopStrategy
 * @notice Leveraged USDC looping via Contango's multi-money-market infrastructure
 *
 * @dev Architecture:
 *
 *   Contango core-v2 is a multi-protocol leverage engine that abstracts
 *   10+ money markets (Aave, Morpho, Compound, Euler, Silo, Dolomite, etc.)
 *   behind a unified trade() interface with composable step-based execution.
 *
 *   DEPOSIT FLOW:
 *     1. Treasury deposits USDC into this strategy
 *     2. Strategy deposits USDC into Contango's Vault
 *     3. Strategy opens a leveraged position via contango.trade()
 *        - Contango handles flash loan → supply → borrow → repay flash internally
 *        - Single tx, no multi-step loop needed on our side
 *
 *   WITHDRAW FLOW:
 *     1. Strategy closes position (partially or fully) via contango.trade()
 *        - Contango handles flash loan → repay debt → withdraw → repay flash
 *     2. Strategy withdraws USDC from Contango Vault
 *     3. USDC returned to Treasury
 *
 *   KEY ADVANTAGES over direct protocol integration:
 *     - Automatic best-execution across money markets
 *     - Step-based composable strategies via StrategyBuilder
 *     - Built-in flash loan hash validation (callback security)
 *     - NFT-based position ownership (composable)
 *     - Unified position monitoring via ContangoLens
 *     - Protocol-agnostic: switch underlying money market without contract changes
 *
 *   SECURITY:
 *     - Flash loan callback validation handled by Contango core
 *     - Per-operation approvals (no standing allowances)
 *     - UUPS upgradeable with timelock governance
 *     - Role-based access control matching existing strategies
 *     - Profitability gate: only loop when net APY > 0
 *
 *   POSITION TRACKING:
 *     - Contango uses bytes32 PositionId encoding: Symbol + MoneyMarketId + Expiry + Number
 *     - Positions are ERC721 NFTs owned by this contract
 *     - ContangoLens provides normalized health/leverage data
 *
 * @dev Follows the same pattern as AaveV3LoopStrategy, CompoundV3LoopStrategy, etc.
 */
contract ContangoLoopStrategy is
    ILeverageLoopStrategy,
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

    /// @notice Maximum iterative deleverage loops (fallback if flash loan fails)
    uint256 public constant MAX_DELEVERAGE_LOOPS = 10;

    /// @notice Minimum health factor before emergency deleverage (1.05)
    uint256 public constant MIN_HEALTH_FACTOR = 1.05e18;

    /// @notice Contango cashflow currency: Quote = USDC
    uint8 private constant CASHFLOW_QUOTE = 2;

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

    /// @notice Contango core contract
    IContango public contango;

    /// @notice Contango Vault — custodial token storage
    IContangoVault public contangoVault;

    /// @notice Contango Lens — read-only position data
    IContangoLens public contangoLens;

    /// @notice Contango PositionNFT — ERC721 position ownership
    IPositionNFT public positionNFT;

    /// @notice Merkl Distributor for reward claiming
    IMerklDistributor public merklDistributor;

    /// @notice Uniswap V3 Router for reward swaps
    ISwapRouterV3Contango public swapRouter;

    /// @notice Contango Symbol for USDC instrument (e.g., "USDCUSDC")
    bytes32 public instrumentSymbol;

    /// @notice Current Contango position ID (bytes32-encoded)
    bytes32 public positionId;

    /// @notice Target LTV in basis points (e.g., 7500 = 75%)
    uint256 public override targetLtvBps;

    /// @notice Effective target loops (leverage = 1/(1-LTV))
    uint256 public override targetLoops;

    /// @notice Safety buffer below liquidation threshold (default 500 = 5%)
    uint256 public safetyBufferBps;

    /// @notice Whether strategy is accepting deposits
    bool public active;

    /// @notice Total principal deposited (before leverage)
    uint256 public totalPrincipal;

    /// @notice Maximum borrow rate (WAD) to allow leveraged deposits
    uint256 public maxBorrowRateForProfit;

    /// @notice Minimum net APY spread for profitability
    uint256 public minNetApySpread;

    /// @notice Total rewards claimed (cumulative, USDC terms)
    uint256 public totalRewardsClaimed;

    /// @notice Default swap fee tier (3000 = 0.3%)
    uint24 public defaultSwapFeeTier;

    /// @notice Minimum swap output ratio (9500 = 95%)
    uint256 public minSwapOutputBps;

    /// @notice Whitelisted reward tokens for claiming
    mapping(address => bool) public allowedRewardTokens;

    /// @notice Preferred Contango money market ID (0 = auto-select)
    uint8 public preferredMoneyMarket;

    /// @notice Default swap router address for Contango ExecutionParams
    address public defaultSwapSpender;

    /// @notice Default swap router address for Contango ExecutionParams
    address public defaultSwapRouter;

    // ═══════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event Deposited(uint256 principal, uint256 totalCollateral, uint256 leverageX100);
    event Withdrawn(uint256 requested, uint256 returned);
    event ParametersUpdated(uint256 targetLtvBps, uint256 targetLoops);
    event ProfitabilityParamsUpdated(uint256 maxBorrowRate, uint256 minNetApySpread);
    event PositionOpened(bytes32 indexed positionId, uint256 collateral, uint256 debt);
    event PositionClosed(bytes32 indexed positionId, uint256 withdrawn);
    event MoneyMarketUpdated(uint8 moneyMarketId);
    event SwapRouterUpdated(address spender, address router);
    event RewardTokenToggled(address indexed token, bool allowed);
    event SwapParamsUpdated(uint24 feeTier, uint256 minOutputBps);
    event InstrumentSymbolUpdated(bytes32 symbol);

    // ═══════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error StrategyNotActive();
    error InvalidLTV();
    error InvalidMaxLoopsParam();
    error HealthFactorTooLow();
    error NotProfitable();
    error RewardTokenNotAllowed();
    error MaxBorrowRateTooHighErr();
    error SlippageTooHighErr();
    error ContangoTradeReverted();
    error PositionNotFound();
    error InvalidContangoAddress();
    error InvalidInstrumentSymbol();
    error SharePriceTooLow();

    // ═══════════════════════════════════════════════════════════════════
    // CONSTRUCTOR & INITIALIZER
    // ═══════════════════════════════════════════════════════════════════

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the Contango Loop Strategy
     * @param _usdc USDC token address
     * @param _contango Contango core contract
     * @param _contangoVault Contango Vault contract
     * @param _contangoLens Contango Lens contract
     * @param _merklDistributor Merkl distributor for rewards
     * @param _swapRouter Uniswap V3 router for reward → USDC swaps
     * @param _instrumentSymbol Contango instrument symbol for USDC looping
     * @param _treasury Treasury address (can deposit/withdraw)
     * @param _admin Default admin
     * @param _timelock Timelock controller
     */
    function initialize(
        address _usdc,
        address _contango,
        address _contangoVault,
        address _contangoLens,
        address _merklDistributor,
        address _swapRouter,
        bytes32 _instrumentSymbol,
        address _treasury,
        address _admin,
        address _timelock
    ) external initializer {
        if (_timelock == address(0)) revert ZeroAddress();
        if (_usdc == address(0)) revert ZeroAddress();
        if (_contango == address(0)) revert InvalidContangoAddress();
        if (_contangoVault == address(0)) revert InvalidContangoAddress();
        if (_instrumentSymbol == bytes32(0)) revert InvalidInstrumentSymbol();

        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        _setTimelock(_timelock);

        usdc = IERC20(_usdc);
        contango = IContango(_contango);
        contangoVault = IContangoVault(_contangoVault);
        contangoLens = IContangoLens(_contangoLens);
        positionNFT = IPositionNFT(IContango(_contango).positionNFT());
        merklDistributor = IMerklDistributor(_merklDistributor);
        swapRouter = ISwapRouterV3Contango(_swapRouter);
        instrumentSymbol = _instrumentSymbol;

        // Default parameters: 75% LTV, 4x effective leverage
        targetLtvBps = 7500;
        targetLoops = 4;
        safetyBufferBps = 500;
        active = true;

        // Profitability: max 8% borrow rate, min 0.5% net spread
        maxBorrowRateForProfit = 0.08e18;
        minNetApySpread = 0.005e18;

        // Swap defaults
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
     * @notice Deposit USDC and open/increase leveraged position via Contango
     * @dev Contango handles flash loan → supply → borrow internally via trade()
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

        // Check profitability before leveraging
        if (!_isProfitable()) {
            // Not profitable — deposit into Contango vault without leverage
            usdc.forceApprove(address(contangoVault), amount);
            contangoVault.depositTo(usdc, address(this), amount);
            totalPrincipal += amount;
            emit Deposited(amount, amount, 100);
            return amount;
        }

        // Deposit USDC into Contango Vault (Contango pulls from vault during trade)
        usdc.forceApprove(address(contangoVault), amount);
        contangoVault.depositTo(usdc, address(this), amount);

        // Calculate leverage: 1 / (1 - targetLTV)
        // At 75% LTV: 4x leverage → quantity = amount * 3 (3x of collateral from flash)
        uint256 leverageMultiplier = (BPS * BPS) / (BPS - targetLtvBps);
        int256 quantity = int256((amount * leverageMultiplier) / BPS);

        // Build trade params to open/increase position
        TradeParams memory tradeParams = TradeParams({
            positionId: positionId, // bytes32(0) for new position, existing ID for increase
            quantity: quantity,
            limitPrice: type(uint256).max, // No price limit for same-asset
            cashflowCcy: CASHFLOW_QUOTE,
            cashflow: int256(amount)       // Deposit amount from vault
        });

        ExecutionParams memory execParams = ExecutionParams({
            spender: defaultSwapSpender,
            router: defaultSwapRouter,
            swapAmount: 0,
            swapBytes: "",
            flashLoanProvider: address(0) // Contango auto-selects best flash loan
        });

        // Execute trade — Contango handles all flash loan logic internally
        (bytes32 newPositionId, ) = contango.trade(tradeParams, execParams);

        // Store position ID if new position was created
        if (positionId == bytes32(0)) {
            positionId = newPositionId;
        }

        totalPrincipal += amount;
        deposited = amount;

        // Calculate effective leverage
        uint256 leverageX100 = 100;
        if (totalPrincipal > 0) {
            try contangoLens.balances(positionId) returns (Balances memory bal) {
                if (bal.collateral > 0) {
                    leverageX100 = (bal.collateral * 100) / totalPrincipal;
                }
            } catch {
                leverageX100 = (amount * leverageMultiplier) / BPS;
            }
        }

        emit Deposited(amount, amount, leverageX100);
        emit PositionOpened(positionId, amount, 0);
    }

    /**
     * @notice Withdraw USDC by reducing leveraged position via Contango
     * @dev Contango handles flash loan → repay → withdraw internally
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

        if (positionId != bytes32(0)) {
            // Calculate proportional position reduction
            Balances memory bal = contangoLens.balances(positionId);

            if (bal.debt > 0) {
                // Close proportional part of position
                int256 quantityToClose = -int256((bal.collateral * principalToWithdraw) / totalPrincipal);

                TradeParams memory tradeParams = TradeParams({
                    positionId: positionId,
                    quantity: quantityToClose,
                    limitPrice: 0,
                    cashflowCcy: CASHFLOW_QUOTE,
                    cashflow: -int256(principalToWithdraw)
                });

                ExecutionParams memory execParams = ExecutionParams({
                    spender: defaultSwapSpender,
                    router: defaultSwapRouter,
                    swapAmount: 0,
                    swapBytes: "",
                    flashLoanProvider: address(0)
                });

                contango.trade(tradeParams, execParams);
            }

            // Withdraw USDC from Contango Vault
            uint256 vaultBalance = contangoVault.balanceOf(usdc, address(this));
            uint256 toWithdraw = vaultBalance > principalToWithdraw ? principalToWithdraw : vaultBalance;
            if (toWithdraw > 0) {
                contangoVault.withdraw(usdc, address(this), toWithdraw, address(this));
            }
        }

        totalPrincipal -= principalToWithdraw;

        // Transfer to Treasury
        uint256 balance = usdc.balanceOf(address(this));
        withdrawn = balance > amount ? amount : balance;
        if (withdrawn > 0) {
            usdc.safeTransfer(msg.sender, withdrawn);
        }

        emit Withdrawn(amount, withdrawn);
    }

    /**
     * @notice Withdraw all USDC from strategy — full close
     */
    function withdrawAll()
        external
        override
        onlyRole(TREASURY_ROLE)
        nonReentrant
        returns (uint256 withdrawn)
    {
        if (positionId != bytes32(0)) {
            // Close entire position
            Balances memory bal;
            try contangoLens.balances(positionId) returns (Balances memory b) {
                bal = b;
            } catch {
                // Position may not exist anymore
            }

            if (bal.collateral > 0) {
                TradeParams memory tradeParams = TradeParams({
                    positionId: positionId,
                    quantity: -int256(bal.collateral), // Close all
                    limitPrice: 0,
                    cashflowCcy: CASHFLOW_QUOTE,
                    cashflow: 0
                });

                ExecutionParams memory execParams = ExecutionParams({
                    spender: defaultSwapSpender,
                    router: defaultSwapRouter,
                    swapAmount: 0,
                    swapBytes: "",
                    flashLoanProvider: address(0)
                });

                contango.trade(tradeParams, execParams);
            }

            // Withdraw everything from vault
            uint256 vaultBalance = contangoVault.balanceOf(usdc, address(this));
            if (vaultBalance > 0) {
                contangoVault.withdraw(usdc, address(this), vaultBalance, address(this));
            }

            positionId = bytes32(0);
        }

        totalPrincipal = 0;

        withdrawn = usdc.balanceOf(address(this));
        if (withdrawn > 0) {
            usdc.safeTransfer(msg.sender, withdrawn);
        }

        emit Withdrawn(type(uint256).max, withdrawn);
    }

    /**
     * @notice Total value of position in USDC terms
     */
    function totalValue() external view override returns (uint256) {
        if (positionId == bytes32(0)) {
            // No position — check vault balance
            try contangoVault.balanceOf(usdc, address(this)) returns (uint256 vb) {
                return vb + usdc.balanceOf(address(this));
            } catch {
                return usdc.balanceOf(address(this));
            }
        }

        // Position exists — query Contango Lens
        try contangoLens.balances(positionId) returns (Balances memory bal) {
            uint256 netValue = bal.collateral > bal.debt ? bal.collateral - bal.debt : 0;
            // Add any USDC held directly
            return netValue + usdc.balanceOf(address(this));
        } catch {
            return usdc.balanceOf(address(this));
        }
    }

    function asset() external view override returns (address) {
        return address(usdc);
    }

    function isActive() external view override returns (bool) {
        return active && !paused();
    }

    // ═══════════════════════════════════════════════════════════════════
    // ILeverageLoopStrategy — HEALTH & POSITION
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Current health factor from Contango Lens
     */
    function getHealthFactor() external view override returns (uint256) {
        if (positionId == bytes32(0)) return type(uint256).max;

        try contangoLens.balances(positionId) returns (Balances memory bal) {
            if (bal.debt == 0) return type(uint256).max;
            // health = collateral / debt (WAD-scaled)
            return (bal.collateral * WAD) / bal.debt;
        } catch {
            return type(uint256).max;
        }
    }

    /**
     * @notice Current leverage ratio × 100
     */
    function getCurrentLeverage() external view override returns (uint256 leverageX100) {
        if (totalPrincipal == 0) return 100;

        try contangoLens.balances(positionId) returns (Balances memory bal) {
            if (bal.collateral == 0) return 100;
            leverageX100 = (bal.collateral * 100) / totalPrincipal;
        } catch {
            leverageX100 = 100;
        }
    }

    /**
     * @notice Full position snapshot
     */
    function getPosition() external view override returns (
        uint256 collateral,
        uint256 borrowed,
        uint256 principal,
        uint256 netValue
    ) {
        principal = totalPrincipal;

        if (positionId != bytes32(0)) {
            try contangoLens.balances(positionId) returns (Balances memory bal) {
                collateral = bal.collateral;
                borrowed = bal.debt;
                netValue = collateral > borrowed ? collateral - borrowed : 0;
            } catch {
                // Position query failed
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // REAL SHARE PRICE & TVL (Stability DAO Pattern)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Real share price accounting for all debt and fees
     * @return priceWad Share price in WAD (1e18 = 1.0)
     * @return trusted Always true (Contango uses on-chain accounting)
     */
    function realSharePrice() external view override returns (uint256 priceWad, bool trusted) {
        if (totalPrincipal == 0) {
            return (WAD, true);
        }

        uint256 netVal;
        if (positionId != bytes32(0)) {
            try contangoLens.balances(positionId) returns (Balances memory bal) {
                netVal = bal.collateral > bal.debt ? bal.collateral - bal.debt : 0;
            } catch {
                netVal = 0;
            }
        }
        // Add USDC held directly
        netVal += usdc.balanceOf(address(this));

        priceWad = (netVal * WAD) / totalPrincipal;
        trusted = true;
    }

    /**
     * @notice Real TVL (Total Value Locked) net of all debt
     * @return tvl Net TVL in USDC terms (6 decimals)
     * @return trusted Always true (Contango uses on-chain accounting)
     */
    function realTvl() external view override returns (uint256 tvl, bool trusted) {
        if (positionId != bytes32(0)) {
            try contangoLens.balances(positionId) returns (Balances memory bal) {
                tvl = bal.collateral > bal.debt ? bal.collateral - bal.debt : 0;
            } catch {
                tvl = 0;
            }
        }
        tvl += usdc.balanceOf(address(this));
        trusted = true;
    }

    // ═══════════════════════════════════════════════════════════════════
    // ADJUST LEVERAGE WITH SHARE PRICE PROTECTION
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Adjust leverage to a new target LTV with share price protection
     * @param newLtvBps New target LTV in basis points
     * @param minSharePrice Minimum share price post-adjustment (WAD). Reverts if breached.
     */
    function adjustLeverage(uint256 newLtvBps, uint256 minSharePrice)
        external
        override
        onlyRole(STRATEGIST_ROLE)
        nonReentrant
        whenNotPaused
    {
        if (newLtvBps < 3000 || newLtvBps > 9000) revert InvalidLTV();

        uint256 oldLtv = targetLtvBps;
        targetLtvBps = newLtvBps;

        // Rebalance to new target via Contango
        if (positionId != bytes32(0)) {
            Balances memory bal = contangoLens.balances(positionId);

            if (bal.collateral > 0) {
                uint256 currentLtv = (bal.debt * BPS) / bal.collateral;

                if (currentLtv < newLtvBps) {
                    // Leverage up
                    uint256 targetDebt = (bal.collateral * newLtvBps) / BPS;
                    uint256 deficit = targetDebt - bal.debt;
                    if (deficit > 1e4) {
                        TradeParams memory tradeParams = TradeParams({
                            positionId: positionId,
                            quantity: int256(deficit),
                            limitPrice: type(uint256).max,
                            cashflowCcy: 0,
                            cashflow: 0
                        });
                        ExecutionParams memory execParams = ExecutionParams({
                            spender: defaultSwapSpender,
                            router: defaultSwapRouter,
                            swapAmount: 0,
                            swapBytes: "",
                            flashLoanProvider: address(0)
                        });
                        contango.trade(tradeParams, execParams);
                    }
                } else if (currentLtv > newLtvBps) {
                    // Deleverage
                    uint256 targetDebt = (bal.collateral * newLtvBps) / BPS;
                    uint256 excess = bal.debt - targetDebt;
                    if (excess > 1e4) {
                        TradeParams memory tradeParams = TradeParams({
                            positionId: positionId,
                            quantity: -int256(excess),
                            limitPrice: 0,
                            cashflowCcy: 0,
                            cashflow: 0
                        });
                        ExecutionParams memory execParams = ExecutionParams({
                            spender: defaultSwapSpender,
                            router: defaultSwapRouter,
                            swapAmount: 0,
                            swapBytes: "",
                            flashLoanProvider: address(0)
                        });
                        contango.trade(tradeParams, execParams);
                    }
                }
            }
        }

        // Share price protection
        if (minSharePrice > 0 && totalPrincipal > 0) {
            uint256 netVal;
            if (positionId != bytes32(0)) {
                Balances memory newBal = contangoLens.balances(positionId);
                netVal = newBal.collateral > newBal.debt ? newBal.collateral - newBal.debt : 0;
            }
            netVal += usdc.balanceOf(address(this));
            uint256 currentSharePrice = (netVal * WAD) / totalPrincipal;
            if (currentSharePrice < minSharePrice) revert SharePriceTooLow();
        }

        emit ParametersUpdated(newLtvBps, targetLoops);
        emit Rebalanced(oldLtv, newLtvBps, 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    // REBALANCE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Rebalance position to target LTV via Contango
     * @dev Called by keeper when LTV drifts from target due to interest
     */
    function rebalance()
        external
        override
        onlyRole(KEEPER_ROLE)
        nonReentrant
        whenNotPaused
    {
        if (positionId == bytes32(0)) return;

        Balances memory bal = contangoLens.balances(positionId);
        if (bal.collateral == 0) return;

        uint256 currentLtv = (bal.debt * BPS) / bal.collateral;
        uint256 targetLtv = targetLtvBps;

        if (currentLtv == targetLtv) return;

        int256 adjustment;

        if (currentLtv < targetLtv) {
            // Under-leveraged — increase position
            uint256 targetDebt = (bal.collateral * targetLtv) / BPS;
            uint256 additionalDebt = targetDebt - bal.debt;

            if (additionalDebt > 1e4) {
                adjustment = int256(additionalDebt);

                TradeParams memory tradeParams = TradeParams({
                    positionId: positionId,
                    quantity: adjustment,
                    limitPrice: type(uint256).max,
                    cashflowCcy: 0,
                    cashflow: 0
                });

                ExecutionParams memory execParams = ExecutionParams({
                    spender: defaultSwapSpender,
                    router: defaultSwapRouter,
                    swapAmount: 0,
                    swapBytes: "",
                    flashLoanProvider: address(0)
                });

                contango.trade(tradeParams, execParams);
            }

            emit Rebalanced(currentLtv, targetLtv, uint256(adjustment));
        } else {
            // Over-leveraged — reduce position
            uint256 targetDebt = (bal.collateral * targetLtv) / BPS;
            uint256 excessDebt = bal.debt - targetDebt;

            if (excessDebt > 1e4) {
                adjustment = -int256(excessDebt);

                TradeParams memory tradeParams = TradeParams({
                    positionId: positionId,
                    quantity: adjustment,
                    limitPrice: 0,
                    cashflowCcy: 0,
                    cashflow: 0
                });

                ExecutionParams memory execParams = ExecutionParams({
                    spender: defaultSwapSpender,
                    router: defaultSwapRouter,
                    swapAmount: 0,
                    swapBytes: "",
                    flashLoanProvider: address(0)
                });

                contango.trade(tradeParams, execParams);
            }

            emit Rebalanced(currentLtv, targetLtv, excessDebt);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // MERKL REWARDS
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Claim Merkl rewards and compound into position
     * @dev Swaps reward tokens → USDC → deposits into Contango position
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

        // Validate all tokens are whitelisted
        for (uint256 i = 0; i < tokens.length; i++) {
            if (!allowedRewardTokens[tokens[i]]) revert RewardTokenNotAllowed();
        }

        // Build claim arrays
        address[] memory users = new address[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            users[i] = address(this);
        }

        // Claim from Merkl
        merklDistributor.claim(users, tokens, amounts, proofs);

        // Swap each reward → USDC and compound
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

            // Swap reward → USDC via Uniswap V3
            IERC20(token).forceApprove(address(swapRouter), balance);

            uint256 minOutput = (balance * minSwapOutputBps) / BPS;

            uint256 received = swapRouter.exactInputSingle(
                ISwapRouterV3Contango.ExactInputSingleParams({
                    tokenIn: token,
                    tokenOut: address(usdc),
                    fee: defaultSwapFeeTier,
                    recipient: address(this),
                    amountIn: balance,
                    amountOutMinimum: minOutput,
                    sqrtPriceLimitX96: 0
                })
            );

            totalUsdcReceived += received;
            emit RewardsClaimed(token, received);
        }

        // Compound: deposit into Contango position
        if (totalUsdcReceived > 0 && positionId != bytes32(0)) {
            usdc.forceApprove(address(contangoVault), totalUsdcReceived);
            contangoVault.depositTo(usdc, address(this), totalUsdcReceived);
            totalRewardsClaimed += totalUsdcReceived;

            uint256 leverageX100 = 100;
            try contangoLens.balances(positionId) returns (Balances memory bal) {
                if (totalPrincipal > 0) {
                    leverageX100 = (bal.collateral * 100) / totalPrincipal;
                }
            } catch {}

            emit RewardsCompounded(totalUsdcReceived, leverageX100);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // EMERGENCY
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Emergency deleverage — fully unwind Contango position
     */
    function emergencyDeleverage()
        external
        override
        onlyRole(GUARDIAN_ROLE)
        nonReentrant
    {
        if (positionId == bytes32(0)) return;

        uint256 healthBefore = type(uint256).max;
        try contangoLens.balances(positionId) returns (Balances memory bal) {
            if (bal.debt > 0) {
                healthBefore = (bal.collateral * WAD) / bal.debt;
            }

            // Close entire position
            TradeParams memory tradeParams = TradeParams({
                positionId: positionId,
                quantity: -int256(bal.collateral),
                limitPrice: 0,
                cashflowCcy: 0,
                cashflow: 0
            });

            ExecutionParams memory execParams = ExecutionParams({
                spender: defaultSwapSpender,
                router: defaultSwapRouter,
                swapAmount: 0,
                swapBytes: "",
                flashLoanProvider: address(0)
            });

            contango.trade(tradeParams, execParams);
        } catch {
            // Position query/trade failed — nothing to deleverage
        }

        // Withdraw everything from vault
        try contangoVault.balanceOf(usdc, address(this)) returns (uint256 vb) {
            if (vb > 0) {
                contangoVault.withdraw(usdc, address(this), vb, address(this));
            }
        } catch {}

        uint256 healthAfter = type(uint256).max;
        positionId = bytes32(0);

        emit EmergencyDeleveraged(healthBefore, healthAfter);
    }

    // ═══════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Current profitability analysis via Contango Lens
     */
    function checkProfitability() external view returns (
        bool profitable,
        uint256 borrowRateWad,
        uint256 lendingRateWad,
        int256 netRateWad
    ) {
        if (positionId == bytes32(0)) {
            return (true, 0, 0, 0);
        }

        try contangoLens.rates(positionId) returns (uint256 borrowing, uint256 lending) {
            borrowRateWad = borrowing;
            lendingRateWad = lending;
        } catch {
            return (false, 0, 0, 0);
        }

        try contangoLens.netRate(positionId) returns (int256 nr) {
            netRateWad = nr;
        } catch {}

        profitable = netRateWad > 0 && borrowRateWad <= maxBorrowRateForProfit;
    }

    /**
     * @notice Get the underlying Contango money market for this position
     */
    function getContangoPositionId() external view returns (bytes32) {
        return positionId;
    }

    // ═══════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Check if leveraged looping is profitable
     * @dev For new positions, checks instrument rates. For existing, uses Lens.
     */
    function _isProfitable() internal view returns (bool) {
        if (positionId == bytes32(0)) {
            // No position yet — assume profitable if within limits
            return true;
        }

        try contangoLens.rates(positionId) returns (uint256 borrowing, uint256 lending) {
            if (borrowing > maxBorrowRateForProfit) return false;

            // Calculate net APY with leverage
            uint256 leverageX1e4 = (BPS * BPS) / (BPS - targetLtvBps);
            uint256 supplyComponent = lending * leverageX1e4 / BPS;
            uint256 borrowComponent = borrowing * (leverageX1e4 - BPS) / BPS;

            return supplyComponent > borrowComponent;
        } catch {
            return false;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function setParameters(uint256 _targetLtvBps, uint256 _targetLoops) external onlyRole(STRATEGIST_ROLE) {
        if (_targetLtvBps < 3000 || _targetLtvBps > 9000) revert InvalidLTV();
        if (_targetLoops == 0 || _targetLoops > 20) revert InvalidMaxLoopsParam();

        targetLtvBps = _targetLtvBps;
        targetLoops = _targetLoops;

        emit ParametersUpdated(_targetLtvBps, _targetLoops);
    }

    function setSafetyBuffer(uint256 _safetyBufferBps) external onlyRole(STRATEGIST_ROLE) {
        if (_safetyBufferBps < 200 || _safetyBufferBps > 2000) revert InvalidBuffer();
        safetyBufferBps = _safetyBufferBps;
    }

    function setProfitabilityParams(uint256 _maxBorrowRate, uint256 _minNetApySpread) external onlyRole(STRATEGIST_ROLE) {
        if (_maxBorrowRate > 0.50e18) revert MaxBorrowRateTooHighErr();
        maxBorrowRateForProfit = _maxBorrowRate;
        minNetApySpread = _minNetApySpread;
        emit ProfitabilityParamsUpdated(_maxBorrowRate, _minNetApySpread);
    }

    function setPreferredMoneyMarket(uint8 _mmId) external onlyRole(STRATEGIST_ROLE) {
        preferredMoneyMarket = _mmId;
        emit MoneyMarketUpdated(_mmId);
    }

    function setDefaultSwapRouter(address _spender, address _router) external onlyRole(STRATEGIST_ROLE) {
        if (_spender == address(0) || _router == address(0)) revert ZeroAddress();
        defaultSwapSpender = _spender;
        defaultSwapRouter = _router;
        emit SwapRouterUpdated(_spender, _router);
    }

    function setInstrumentSymbol(bytes32 _symbol) external onlyRole(STRATEGIST_ROLE) {
        if (_symbol == bytes32(0)) revert InvalidInstrumentSymbol();
        instrumentSymbol = _symbol;
        emit InstrumentSymbolUpdated(_symbol);
    }

    function setRewardToken(address _token, bool _allowed) external onlyRole(STRATEGIST_ROLE) {
        if (_token == address(0)) revert ZeroAddress();
        allowedRewardTokens[_token] = _allowed;
        emit RewardTokenToggled(_token, _allowed);
    }

    function setSwapParams(uint24 _feeTier, uint256 _minOutputBps) external onlyRole(STRATEGIST_ROLE) {
        if (_minOutputBps < 8000 || _minOutputBps > BPS) revert SlippageTooHighErr();
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

    uint256[30] private __gap;

    function _authorizeUpgrade(address) internal override onlyTimelock {}
}
