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
 * @title MorphoLoopStrategy
 * @notice Leveraged USDC strategy using Morpho Blue recursive lending
 * @dev Deposits USDC → Borrow at 70% LTV → Redeposit → Loop for ~3.3x leverage
 *
 * Target Performance:
 *   Base Supply Rate:  ~5.9% (Morpho USDC vault)
 *   Borrow Rate:       ~4.5%
 *   Leverage:          3.33x (at 70% LTV)
 *   Net APY:           ~11.5% (supply*3.33 - borrow*2.33)
 *
 * Safety Features:
 *   - Max 5 loops to prevent gas exhaustion
 *   - Health factor monitoring
 *   - Emergency deleverage capability
 *   - Configurable target LTV with safety buffer
 */

/// @notice Morpho Blue Market interface
interface IMorphoBlue {
    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv; // Liquidation LTV (e.g., 86% = 860000000000000000)
    }

    struct Position {
        uint256 supplyShares;
        uint128 borrowShares;
        uint128 collateral;
    }

    function supply(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes memory data
    ) external returns (uint256 assetsSupplied, uint256 sharesSupplied);

    function withdraw(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256 assetsWithdrawn, uint256 sharesWithdrawn);

    function borrow(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256 assetsBorrowed, uint256 sharesBorrowed);

    function repay(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes memory data
    ) external returns (uint256 assetsRepaid, uint256 sharesRepaid);

    function supplyCollateral(
        MarketParams memory marketParams,
        uint256 assets,
        address onBehalf,
        bytes memory data
    ) external;

    function withdrawCollateral(
        MarketParams memory marketParams,
        uint256 assets,
        address onBehalf,
        address receiver
    ) external;

    function position(bytes32 id, address user) external view returns (Position memory);
    function market(bytes32 id) external view returns (
        uint128 totalSupplyAssets,
        uint128 totalSupplyShares,
        uint128 totalBorrowAssets,
        uint128 totalBorrowShares,
        uint128 lastUpdate,
        uint128 fee
    );

    function idToMarketParams(bytes32 id) external view returns (MarketParams memory);
}

/// @notice Morpho Blue Oracle interface
interface IMorphoOracle {
    function price() external view returns (uint256);
}

contract MorphoLoopStrategy is
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

    uint256 public constant BPS = 10000;
    uint256 public constant WAD = 1e18;
    
    /// @notice Maximum loops to prevent gas exhaustion
    uint256 public constant MAX_LOOPS = 5;
    
    /// @notice Minimum health factor before emergency deleverage (1.05 = 105%)
    uint256 public constant MIN_HEALTH_FACTOR = 1.05e18;

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

    /// @notice Morpho Blue core contract
    IMorphoBlue public morpho;

    /// @notice Market ID for USDC/USDC looping (self-referential for stablecoin leverage)
    bytes32 public marketId;

    /// @notice Cached market params
    IMorphoBlue.MarketParams public marketParams;

    /// @notice Target LTV for looping (default 7000 = 70%)
    uint256 public targetLtvBps;

    /// @notice Safety buffer below liquidation LTV (default 500 = 5%)
    uint256 public safetyBufferBps;

    /// @notice Number of loops to execute (default 4)
    uint256 public targetLoops;

    /// @notice Whether strategy is active for deposits
    bool public active;

    /// @notice Total principal deposited (before leverage)
    uint256 public totalPrincipal;

    // ═══════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event Deposited(uint256 principal, uint256 totalSupplied, uint256 loops);
    event Withdrawn(uint256 requested, uint256 returned);
    event Deleveraged(uint256 repaid, uint256 withdrawn);
    event EmergencyDeleverage(uint256 healthFactorBefore, uint256 healthFactorAfter);
    event ParametersUpdated(uint256 targetLtvBps, uint256 targetLoops);

    // ═══════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error ZeroAmount();
    error StrategyNotActive();
    error InsufficientBalance();
    error HealthFactorTooLow();
    error ExcessiveLoops();
    error InvalidLTV();

    // ═══════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR & INITIALIZER
    // ═══════════════════════════════════════════════════════════════════════

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _usdc,
        address _morpho,
        bytes32 _marketId,
        address _treasury,
        address _admin
    ) external initializer {
        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        usdc = IERC20(_usdc);
        morpho = IMorphoBlue(_morpho);
        marketId = _marketId;
        marketParams = morpho.idToMarketParams(_marketId);

        // Default parameters: 70% LTV, 4 loops
        targetLtvBps = 7000;
        safetyBufferBps = 500;
        targetLoops = 4;
        active = true;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(TREASURY_ROLE, _treasury);
        _grantRole(STRATEGIST_ROLE, _admin);
        _grantRole(GUARDIAN_ROLE, _admin);

        // Approve Morpho to spend USDC
        usdc.forceApprove(_morpho, type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // IStrategy IMPLEMENTATION
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit USDC and loop for leverage
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

        // Execute looping strategy
        uint256 totalSupplied = _loop(amount);

        totalPrincipal += amount;
        deposited = amount;

        emit Deposited(amount, totalSupplied, targetLoops);
    }

    /**
     * @notice Withdraw USDC by deleveraging
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

        // Calculate how much principal this represents
        uint256 principalToWithdraw = amount;
        if (principalToWithdraw > totalPrincipal) {
            principalToWithdraw = totalPrincipal;
        }

        // Deleverage to free up the requested amount
        withdrawn = _deleverage(principalToWithdraw);

        totalPrincipal -= principalToWithdraw;

        // Transfer USDC back to Treasury
        usdc.safeTransfer(msg.sender, withdrawn);

        emit Withdrawn(amount, withdrawn);
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
        // Full deleverage
        withdrawn = _fullDeleverage();
        totalPrincipal = 0;

        // Transfer all USDC back to Treasury
        uint256 balance = usdc.balanceOf(address(this));
        if (balance > 0) {
            usdc.safeTransfer(msg.sender, balance);
        }

        emit Withdrawn(type(uint256).max, withdrawn);
        return balance;
    }

    /**
     * @notice Total value of position in USDC terms
     * @return Total value including unrealized PnL
     */
    function totalValue() external view override returns (uint256) {
        IMorphoBlue.Position memory pos = morpho.position(marketId, address(this));
        
        // Get current supply and borrow values
        (uint128 totalSupplyAssets, uint128 totalSupplyShares, 
         uint128 totalBorrowAssets, uint128 totalBorrowShares,,) = morpho.market(marketId);

        // Calculate our supply value
        uint256 supplyValue = 0;
        if (totalSupplyShares > 0) {
            supplyValue = (uint256(pos.supplyShares) * totalSupplyAssets) / totalSupplyShares;
        }

        // Calculate our borrow value
        uint256 borrowValue = 0;
        if (totalBorrowShares > 0) {
            borrowValue = (uint256(pos.borrowShares) * totalBorrowAssets) / totalBorrowShares;
        }

        // Add collateral value
        uint256 collateralValue = pos.collateral;

        // Net value = supply + collateral - borrow
        if (supplyValue + collateralValue > borrowValue) {
            return supplyValue + collateralValue - borrowValue;
        }
        return 0;
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
    // INTERNAL LOOPING LOGIC
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Execute looping: supply → borrow → supply → repeat
     * @param initialAmount Starting USDC amount
     * @return totalSupplied Total USDC supplied across all loops
     */
    function _loop(uint256 initialAmount) internal returns (uint256 totalSupplied) {
        uint256 amountToSupply = initialAmount;
        totalSupplied = 0;

        for (uint256 i = 0; i < targetLoops && amountToSupply > 1e4; i++) {
            // Supply USDC as collateral
            morpho.supplyCollateral(marketParams, amountToSupply, address(this), "");
            totalSupplied += amountToSupply;

            // Calculate borrow amount at target LTV
            uint256 borrowAmount = (amountToSupply * targetLtvBps) / BPS;
            
            if (borrowAmount < 1e4) break; // Dust check

            // Borrow USDC
            (uint256 borrowed,) = morpho.borrow(
                marketParams,
                borrowAmount,
                0,
                address(this),
                address(this)
            );

            amountToSupply = borrowed;
        }
    }

    /**
     * @notice Deleverage to free up principal
     * @param principalNeeded Amount of principal to free
     * @return freed Amount actually freed
     */
    function _deleverage(uint256 principalNeeded) internal returns (uint256 freed) {
        IMorphoBlue.Position memory pos = morpho.position(marketId, address(this));
        
        // Calculate current borrow amount
        (,, uint128 totalBorrowAssets, uint128 totalBorrowShares,,) = morpho.market(marketId);
        uint256 currentBorrow = 0;
        if (totalBorrowShares > 0) {
            currentBorrow = (uint256(pos.borrowShares) * totalBorrowAssets) / totalBorrowShares;
        }

        // Iteratively repay and withdraw
        for (uint256 i = 0; i < MAX_LOOPS && currentBorrow > 0; i++) {
            // Withdraw some collateral (respecting LTV)
            uint256 maxWithdraw = _maxWithdrawable();
            if (maxWithdraw == 0) break;

            uint256 toWithdraw = maxWithdraw > principalNeeded ? principalNeeded : maxWithdraw;
            
            morpho.withdrawCollateral(marketParams, toWithdraw, address(this), address(this));
            freed += toWithdraw;

            if (freed >= principalNeeded) break;

            // Use withdrawn funds to repay debt
            uint256 balance = usdc.balanceOf(address(this));
            if (balance > 0 && currentBorrow > 0) {
                uint256 repayAmount = balance > currentBorrow ? currentBorrow : balance;
                morpho.repay(marketParams, repayAmount, 0, address(this), "");
                currentBorrow -= repayAmount;
            }
        }
    }

    /**
     * @notice Full deleverage - repay all debt and withdraw all collateral
     */
    function _fullDeleverage() internal returns (uint256 totalFreed) {
        for (uint256 i = 0; i < MAX_LOOPS * 2; i++) {
            IMorphoBlue.Position memory pos = morpho.position(marketId, address(this));
            
            // Get current borrow
            (,, uint128 totalBorrowAssets, uint128 totalBorrowShares,,) = morpho.market(marketId);
            uint256 currentBorrow = 0;
            if (totalBorrowShares > 0) {
                currentBorrow = (uint256(pos.borrowShares) * totalBorrowAssets) / totalBorrowShares;
            }

            // If no more debt, withdraw remaining collateral
            if (currentBorrow == 0) {
                if (pos.collateral > 0) {
                    morpho.withdrawCollateral(marketParams, pos.collateral, address(this), address(this));
                    totalFreed += pos.collateral;
                }
                break;
            }

            // Withdraw what we can
            uint256 maxWithdraw = _maxWithdrawable();
            if (maxWithdraw > 0) {
                morpho.withdrawCollateral(marketParams, maxWithdraw, address(this), address(this));
                totalFreed += maxWithdraw;
            }

            // Repay with available balance
            uint256 balance = usdc.balanceOf(address(this));
            if (balance > 0) {
                uint256 repayAmount = balance > currentBorrow ? currentBorrow : balance;
                morpho.repay(marketParams, repayAmount, 0, address(this), "");
            }
        }
    }

    /**
     * @notice Calculate max withdrawable collateral while staying above min health factor
     */
    function _maxWithdrawable() internal view returns (uint256) {
        IMorphoBlue.Position memory pos = morpho.position(marketId, address(this));
        
        (,, uint128 totalBorrowAssets, uint128 totalBorrowShares,,) = morpho.market(marketId);
        uint256 currentBorrow = 0;
        if (totalBorrowShares > 0) {
            currentBorrow = (uint256(pos.borrowShares) * totalBorrowAssets) / totalBorrowShares;
        }

        if (currentBorrow == 0) {
            return pos.collateral;
        }

        // Calculate minimum collateral needed for target LTV + safety buffer
        uint256 safeLtv = targetLtvBps - safetyBufferBps;
        uint256 minCollateral = (currentBorrow * BPS) / safeLtv;

        if (pos.collateral > minCollateral) {
            return pos.collateral - minCollateral;
        }
        return 0;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Current health factor of the position
     * @return healthFactor Scaled by 1e18 (1e18 = 1.0)
     */
    function getHealthFactor() external view returns (uint256 healthFactor) {
        IMorphoBlue.Position memory pos = morpho.position(marketId, address(this));
        
        (,, uint128 totalBorrowAssets, uint128 totalBorrowShares,,) = morpho.market(marketId);
        uint256 currentBorrow = 0;
        if (totalBorrowShares > 0) {
            currentBorrow = (uint256(pos.borrowShares) * totalBorrowAssets) / totalBorrowShares;
        }

        if (currentBorrow == 0) {
            return type(uint256).max; // Infinite health factor if no debt
        }

        // Health factor = (collateral * liquidationLTV) / borrow
        uint256 liquidationLtv = marketParams.lltv; // Already in WAD
        healthFactor = (pos.collateral * liquidationLtv) / (currentBorrow * WAD / WAD);
    }

    /**
     * @notice Current leverage ratio
     * @return leverageX100 Leverage × 100 (e.g., 333 = 3.33x)
     */
    function getCurrentLeverage() external view returns (uint256 leverageX100) {
        if (totalPrincipal == 0) return 100; // 1x if no principal

        IMorphoBlue.Position memory pos = morpho.position(marketId, address(this));
        
        // Leverage = total collateral / principal
        leverageX100 = (pos.collateral * 100) / totalPrincipal;
    }

    /**
     * @notice Get current position details
     */
    function getPosition() external view returns (
        uint256 collateral,
        uint256 borrowed,
        uint256 principal,
        uint256 netValue
    ) {
        IMorphoBlue.Position memory pos = morpho.position(marketId, address(this));
        
        (,, uint128 totalBorrowAssets, uint128 totalBorrowShares,,) = morpho.market(marketId);
        
        collateral = pos.collateral;
        borrowed = 0;
        if (totalBorrowShares > 0) {
            borrowed = (uint256(pos.borrowShares) * totalBorrowAssets) / totalBorrowShares;
        }
        principal = totalPrincipal;
        netValue = collateral > borrowed ? collateral - borrowed : 0;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Update looping parameters
     * @param _targetLtvBps New target LTV in basis points
     * @param _targetLoops New number of loops
     */
    function setParameters(
        uint256 _targetLtvBps,
        uint256 _targetLoops
    ) external onlyRole(STRATEGIST_ROLE) {
        // Validate LTV is reasonable (max 85% to stay below typical 86% LLTV)
        if (_targetLtvBps > 8500 || _targetLtvBps < 5000) revert InvalidLTV();
        if (_targetLoops > MAX_LOOPS) revert ExcessiveLoops();

        targetLtvBps = _targetLtvBps;
        targetLoops = _targetLoops;

        emit ParametersUpdated(_targetLtvBps, _targetLoops);
    }

    /**
     * @notice Set safety buffer
     */
    function setSafetyBuffer(uint256 _safetyBufferBps) external onlyRole(STRATEGIST_ROLE) {
        require(_safetyBufferBps >= 200 && _safetyBufferBps <= 2000, "Invalid buffer");
        safetyBufferBps = _safetyBufferBps;
    }

    /**
     * @notice Activate/deactivate strategy
     */
    function setActive(bool _active) external onlyRole(STRATEGIST_ROLE) {
        active = _active;
    }

    /**
     * @notice Emergency deleverage if health factor drops
     */
    function emergencyDeleverage() external onlyRole(GUARDIAN_ROLE) {
        uint256 healthBefore = this.getHealthFactor();
        _fullDeleverage();
        uint256 healthAfter = this.getHealthFactor();
        
        emit EmergencyDeleverage(healthBefore, healthAfter);
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
     * @notice Recover stuck tokens (not USDC in active position)
     */
    function recoverToken(address token, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(token != address(usdc) || totalPrincipal == 0, "Cannot recover active USDC");
        IERC20(token).safeTransfer(msg.sender, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // UPGRADES
    // ═══════════════════════════════════════════════════════════════════════

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
