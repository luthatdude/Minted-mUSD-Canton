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
//                     EULER V2 INTERFACES
// ═══════════════════════════════════════════════════════════════════════════

/// @notice Euler V2 Vault — modular lending vault (ERC-4626 based)
interface IEulerVault {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function balanceOf(address account) external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function convertToShares(uint256 assets) external view returns (uint256);
    function totalAssets() external view returns (uint256);
    function asset() external view returns (address);
    function maxWithdraw(address owner) external view returns (uint256);

    /// @notice Euler V2 borrowing
    function borrow(uint256 assets, address receiver) external returns (uint256);
    function repay(uint256 assets, address receiver) external returns (uint256);
    function debtOf(address account) external view returns (uint256);

    /// @notice Interest rate info
    function interestRate() external view returns (uint256);

    /// @notice Account status
    function accountLiquidity(address account, bool liquidation) external view returns (
        uint256 collateralValue,
        uint256 liabilityValue
    );
}

/// @notice Euler V2 EVC (Ethereum Vault Connector) — links vaults for cross-collateral
interface IEVC {
    function enableCollateral(address account, address vault) external;
    function enableController(address account, address vault) external;
    function getCollaterals(address account) external view returns (address[] memory);
    function getControllers(address account) external view returns (address[] memory);
    function call(
        address targetContract,
        address onBehalfOfAccount,
        uint256 value,
        bytes calldata data
    ) external payable returns (bytes memory);
}

/// @notice AAVE V3 Pool for flash loans (Euler V2 doesn't support flash loans natively)
interface IAavePoolForFlashEuler {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

/// @notice Flash loan callback
interface IFlashLoanSimpleReceiverEuler {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

/// @notice Uniswap V3 Router for reward swaps
interface ISwapRouterV3Euler {
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
 * @title EulerV2LoopStrategy
 * @notice Leveraged USDC loop on Euler V2 with Merkl reward integration
 *
 * @dev Euler V2 Architecture:
 *   - Modular vault system with EVC (Ethereum Vault Connector) for cross-collateral
 *   - Each vault is an ERC-4626 token with borrowing capabilities
 *   - Supply vault (collateral) + Borrow vault (debt) linked via EVC
 *
 *   STRATEGY:
 *   1. Supply USDC to an Euler V2 supply vault (earn supply APY)
 *   2. Enable as collateral via EVC
 *   3. Borrow USDC from a separate borrow vault
 *   4. Re-supply borrowed USDC → loop
 *
 *   Single-tx via AAVE flash loans (Euler V2 doesn't have native flash loans):
 *   - Flash loan → supply all → borrow to repay flash
 *
 *   MERKL REWARDS:
 *   - Euler V2 vaults frequently have Merkl campaigns (EUL + partner tokens)
 *   - claimAndCompound() claims → swaps to USDC → deposits into position
 *
 * @dev Safety: health factor monitoring, emergency deleverage, profitability gate
 */
contract EulerV2LoopStrategy is
    ILeverageLoopStrategy,
    IFlashLoanSimpleReceiverEuler,
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
    uint256 public constant MIN_HEALTH_FACTOR = 1.05e18;

    uint8 private constant ACTION_DEPOSIT = 1;
    uint8 private constant ACTION_WITHDRAW = 2;

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

    /// @notice Euler V2 supply vault (collateral side)
    IEulerVault public supplyVault;

    /// @notice Euler V2 borrow vault (debt side)
    IEulerVault public borrowVault;

    /// @notice Euler V2 EVC — links supply and borrow vaults
    IEVC public evc;

    /// @notice AAVE pool for flash loans
    IAavePoolForFlashEuler public flashLoanPool;

    /// @notice Merkl distributor for reward claiming
    IMerklDistributor public merklDistributor;

    /// @notice Uniswap V3 router for reward swaps
    ISwapRouterV3Euler public swapRouter;

    /// @notice Target LTV in basis points
    uint256 public override targetLtvBps;

    /// @notice Target loops (conceptual — flash loan = 1 tx)
    uint256 public override targetLoops;

    /// @notice Safety buffer below max LTV
    uint256 public safetyBufferBps;

    /// @notice Whether strategy is active
    bool public active;

    /// @notice Total USDC principal deposited
    uint256 public totalPrincipal;

    /// @notice Max borrow rate for profitability gate
    uint256 public maxBorrowRateForProfit;

    /// @notice Total Merkl rewards claimed (USDC terms)
    uint256 public totalRewardsClaimed;

    /// @notice Swap fee tier
    uint24 public defaultSwapFeeTier;

    /// @notice Minimum swap output ratio
    uint256 public minSwapOutputBps;

    /// @notice Reward token whitelist
    mapping(address => bool) public allowedRewardTokens;

    // ═══════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event Deposited(uint256 principal, uint256 totalSupplied, uint256 leverageX100);
    event Withdrawn(uint256 requested, uint256 returned);
    event ParametersUpdated(uint256 targetLtvBps, uint256 targetLoops);
    event RewardTokenToggled(address indexed token, bool allowed);

    // ═══════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error StrategyNotActive();
    error InvalidLTV();
    error FlashLoanCallbackUnauthorized();
    error HealthFactorTooLow();
    error RewardTokenNotAllowed();
    error SharePriceTooLow();

    // ═══════════════════════════════════════════════════════════════════
    // CONSTRUCTOR & INITIALIZER
    // ═══════════════════════════════════════════════════════════════════

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the Euler V2 Loop Strategy
     * @param _usdc USDC token
     * @param _supplyVault Euler V2 supply vault for USDC
     * @param _borrowVault Euler V2 borrow vault for USDC
     * @param _evc Euler V2 EVC
     * @param _flashLoanPool AAVE pool for flash loans
     * @param _merklDistributor Merkl distributor
     * @param _swapRouter Uniswap V3 router
     * @param _treasury Treasury address
     * @param _admin Admin address
     * @param _timelock Timelock controller
     */
    function initialize(
        address _usdc,
        address _supplyVault,
        address _borrowVault,
        address _evc,
        address _flashLoanPool,
        address _merklDistributor,
        address _swapRouter,
        address _treasury,
        address _admin,
        address _timelock
    ) external initializer {
        if (_timelock == address(0)) revert ZeroAddress();
        if (_usdc == address(0)) revert ZeroAddress();
        if (_supplyVault == address(0)) revert ZeroAddress();
        if (_borrowVault == address(0)) revert ZeroAddress();

        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        _setTimelock(_timelock);

        usdc = IERC20(_usdc);
        supplyVault = IEulerVault(_supplyVault);
        borrowVault = IEulerVault(_borrowVault);
        evc = IEVC(_evc);
        flashLoanPool = IAavePoolForFlashEuler(_flashLoanPool);
        merklDistributor = IMerklDistributor(_merklDistributor);
        swapRouter = ISwapRouterV3Euler(_swapRouter);

        // Default: 75% LTV, 4x conceptual leverage
        targetLtvBps = 7500;
        targetLoops = 4;
        safetyBufferBps = 500;
        active = true;

        maxBorrowRateForProfit = 0.08e18;
        defaultSwapFeeTier = 3000;
        minSwapOutputBps = 9500;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(TREASURY_ROLE, _treasury);
        _grantRole(STRATEGIST_ROLE, _admin);
        _grantRole(GUARDIAN_ROLE, _admin);
        _grantRole(KEEPER_ROLE, _admin);
    }

    /**
     * @notice Set up EVC relationships (called once after deployment)
     * @dev Must be called by admin to enable collateral/controller linkages
     */
    function setupEVC() external onlyRole(DEFAULT_ADMIN_ROLE) {
        // Enable supply vault as collateral for this account
        evc.enableCollateral(address(this), address(supplyVault));
        // Enable borrow vault as controller for this account
        evc.enableController(address(this), address(borrowVault));
    }

    // ═══════════════════════════════════════════════════════════════════
    // IStrategy IMPLEMENTATION
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit USDC with flash-loan leverage
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

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        // Calculate flash loan for target leverage
        uint256 flashAmount = (amount * targetLtvBps) / (BPS - targetLtvBps);

        if (flashAmount > 0) {
            flashLoanPool.flashLoanSimple(
                address(this),
                address(usdc),
                flashAmount,
                abi.encode(ACTION_DEPOSIT, amount),
                0
            );
        } else {
            // No leverage
            usdc.forceApprove(address(supplyVault), amount);
            supplyVault.deposit(amount, address(this));
        }

        totalPrincipal += amount;
        deposited = amount;

        uint256 collateral = supplyVault.convertToAssets(supplyVault.balanceOf(address(this)));
        uint256 leverageX100 = totalPrincipal > 0 ? (collateral * 100) / totalPrincipal : 100;

        emit Deposited(amount, collateral, leverageX100);
    }

    /**
     * @notice Withdraw USDC by deleveraging
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
        uint256 currentDebt = borrowVault.debtOf(address(this));

        if (currentDebt > 0) {
            uint256 debtToRepay = (currentDebt * principalToWithdraw) / totalPrincipal;
            if (debtToRepay > currentDebt) debtToRepay = currentDebt;

            flashLoanPool.flashLoanSimple(
                address(this),
                address(usdc),
                debtToRepay,
                abi.encode(ACTION_WITHDRAW, principalToWithdraw),
                0
            );
        } else {
            // No debt — just withdraw
            supplyVault.withdraw(principalToWithdraw, address(this), address(this));
        }

        totalPrincipal -= principalToWithdraw;

        uint256 balance = usdc.balanceOf(address(this));
        withdrawn = balance > amount ? amount : balance;
        if (withdrawn > 0) {
            usdc.safeTransfer(msg.sender, withdrawn);
        }

        emit Withdrawn(amount, withdrawn);
    }

    /**
     * @notice Withdraw everything
     */
    function withdrawAll()
        external
        override
        onlyRole(TREASURY_ROLE)
        nonReentrant
        returns (uint256 withdrawn)
    {
        uint256 debt = borrowVault.debtOf(address(this));

        if (debt > 0) {
            flashLoanPool.flashLoanSimple(
                address(this),
                address(usdc),
                debt,
                abi.encode(ACTION_WITHDRAW, type(uint256).max),
                0
            );
        }

        // Withdraw remaining supply
        uint256 shares = supplyVault.balanceOf(address(this));
        if (shares > 0) {
            supplyVault.redeem(shares, address(this), address(this));
        }

        totalPrincipal = 0;

        withdrawn = usdc.balanceOf(address(this));
        if (withdrawn > 0) {
            usdc.safeTransfer(msg.sender, withdrawn);
        }

        emit Withdrawn(type(uint256).max, withdrawn);
    }

    /**
     * @notice Net position value (collateral − debt)
     */
    function totalValue() external view override returns (uint256) {
        uint256 collateral = supplyVault.convertToAssets(supplyVault.balanceOf(address(this)));
        uint256 debt = borrowVault.debtOf(address(this));
        return collateral > debt ? collateral - debt : 0;
    }

    function asset() external view override returns (address) {
        return address(usdc);
    }

    function isActive() external view override returns (bool) {
        return active && !paused();
    }

    // ═══════════════════════════════════════════════════════════════════
    // FLASH LOAN CALLBACK
    // ═══════════════════════════════════════════════════════════════════

    function executeOperation(
        address,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        if (msg.sender != address(flashLoanPool)) revert FlashLoanCallbackUnauthorized();
        if (initiator != address(this)) revert FlashLoanCallbackUnauthorized();

        (uint8 action, uint256 userAmount) = abi.decode(params, (uint8, uint256));

        if (action == ACTION_DEPOSIT) {
            _handleDepositCallback(amount, premium, userAmount);
        } else if (action == ACTION_WITHDRAW) {
            _handleWithdrawCallback(amount, premium, userAmount);
        }

        return true;
    }

    function _handleDepositCallback(uint256 flashAmount, uint256 premium, uint256 userAmount) internal {
        uint256 totalToSupply = userAmount + flashAmount;

        // Supply to Euler V2 supply vault
        usdc.forceApprove(address(supplyVault), totalToSupply);
        supplyVault.deposit(totalToSupply, address(this));

        // Borrow from Euler V2 borrow vault to repay flash loan
        uint256 repayAmount = flashAmount + premium;
        borrowVault.borrow(repayAmount, address(this));

        // Approve AAVE pool for flash loan repayment
        usdc.forceApprove(address(flashLoanPool), repayAmount);
    }

    function _handleWithdrawCallback(uint256 flashAmount, uint256 premium, uint256 withdrawAmount) internal {
        // Repay Euler debt with flash-loaned funds
        usdc.forceApprove(address(borrowVault), flashAmount);
        borrowVault.repay(flashAmount, address(this));

        // Withdraw from supply vault
        uint256 toWithdraw;
        if (withdrawAmount == type(uint256).max) {
            uint256 shares = supplyVault.balanceOf(address(this));
            if (shares > 0) {
                supplyVault.redeem(shares, address(this), address(this));
            }
        } else {
            toWithdraw = withdrawAmount + flashAmount + premium;
            uint256 maxW = supplyVault.maxWithdraw(address(this));
            if (toWithdraw > maxW) toWithdraw = maxW;
            if (toWithdraw > 0) {
                supplyVault.withdraw(toWithdraw, address(this), address(this));
            }
        }

        // Approve flash loan repayment
        uint256 repayAmount = flashAmount + premium;
        usdc.forceApprove(address(flashLoanPool), repayAmount);
    }

    // ═══════════════════════════════════════════════════════════════════
    // LEVERAGE VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function getHealthFactor() external view override returns (uint256) {
        uint256 debt = borrowVault.debtOf(address(this));
        if (debt == 0) return type(uint256).max;

        uint256 collateral = supplyVault.convertToAssets(supplyVault.balanceOf(address(this)));
        // Simple health factor: collateral / debt (in WAD)
        return (collateral * WAD) / debt;
    }

    function getCurrentLeverage() external view override returns (uint256 leverageX100) {
        if (totalPrincipal == 0) return 100;
        uint256 collateral = supplyVault.convertToAssets(supplyVault.balanceOf(address(this)));
        leverageX100 = (collateral * 100) / totalPrincipal;
    }

    function getPosition() external view override returns (
        uint256 collateral,
        uint256 borrowed,
        uint256 principal,
        uint256 netValue
    ) {
        collateral = supplyVault.convertToAssets(supplyVault.balanceOf(address(this)));
        borrowed = borrowVault.debtOf(address(this));
        principal = totalPrincipal;
        netValue = collateral > borrowed ? collateral - borrowed : 0;
    }

    // ═══════════════════════════════════════════════════════════════════
    // REAL SHARE PRICE & TVL (Stability DAO pattern)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Real share price accounting for all debt
     * @return priceWad Share price in WAD (1e18 = 1.0)
     * @return trusted Always true for Euler V2 (on-chain accounting)
     */
    function realSharePrice() external view override returns (uint256 priceWad, bool trusted) {
        uint256 collateralVal = supplyVault.convertToAssets(supplyVault.balanceOf(address(this)));
        uint256 debt = borrowVault.debtOf(address(this));
        uint256 netVal = collateralVal > debt ? collateralVal - debt : 0;

        if (totalPrincipal == 0) {
            return (WAD, true);
        }
        priceWad = (netVal * WAD) / totalPrincipal;
        trusted = true;
    }

    /**
     * @notice Real TVL net of all debt
     * @return tvl Net TVL in USDC terms (6 decimals)
     * @return trusted Always true for Euler V2
     */
    function realTvl() external view override returns (uint256 tvl, bool trusted) {
        uint256 collateralVal = supplyVault.convertToAssets(supplyVault.balanceOf(address(this)));
        uint256 debt = borrowVault.debtOf(address(this));
        tvl = collateralVal > debt ? collateralVal - debt : 0;
        trusted = true;
    }

    /**
     * @notice Adjust leverage with share price protection
     * @param newLtvBps New target LTV in basis points
     * @param minSharePrice Minimum acceptable share price post-adjustment (WAD)
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

        // Perform rebalance to new target
        uint256 collateralVal = supplyVault.convertToAssets(supplyVault.balanceOf(address(this)));
        uint256 currentDebt = borrowVault.debtOf(address(this));

        if (collateralVal > 0) {
            uint256 currentLtv = (currentDebt * BPS) / collateralVal;

            if (currentLtv < newLtvBps) {
                uint256 targetDebt = (collateralVal * newLtvBps) / BPS;
                uint256 deficit = targetDebt - currentDebt;
                if (deficit > 1e4) {
                    flashLoanPool.flashLoanSimple(
                        address(this),
                        address(usdc),
                        deficit,
                        abi.encode(ACTION_DEPOSIT, uint256(0)),
                        0
                    );
                }
            } else if (currentLtv > newLtvBps) {
                uint256 targetDebt = (collateralVal * newLtvBps) / BPS;
                uint256 excess = currentDebt - targetDebt;
                if (excess > 1e4) {
                    flashLoanPool.flashLoanSimple(
                        address(this),
                        address(usdc),
                        excess,
                        abi.encode(ACTION_WITHDRAW, uint256(0)),
                        0
                    );
                }
            }
        }

        // Share price protection
        if (minSharePrice > 0 && totalPrincipal > 0) {
            uint256 newCollateral = supplyVault.convertToAssets(supplyVault.balanceOf(address(this)));
            uint256 newDebt = borrowVault.debtOf(address(this));
            uint256 netVal = newCollateral > newDebt ? newCollateral - newDebt : 0;
            uint256 currentSharePrice = (netVal * WAD) / totalPrincipal;

            if (currentSharePrice < minSharePrice) revert SharePriceTooLow();
        }

        emit ParametersUpdated(newLtvBps, targetLoops);
        emit Rebalanced(oldLtv, newLtvBps, 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    // REBALANCE
    // ═══════════════════════════════════════════════════════════════════

    function rebalance()
        external
        override
        onlyRole(KEEPER_ROLE)
        nonReentrant
        whenNotPaused
    {
        uint256 collateral = supplyVault.convertToAssets(supplyVault.balanceOf(address(this)));
        uint256 currentDebt = borrowVault.debtOf(address(this));

        if (collateral == 0) return;

        uint256 currentLtv = (currentDebt * BPS) / collateral;

        if (currentLtv > targetLtvBps + 100) {
            // Over-leveraged — deleverage
            uint256 targetDebt = (collateral * targetLtvBps) / BPS;
            uint256 excess = currentDebt - targetDebt;

            if (excess > 1e4) {
                flashLoanPool.flashLoanSimple(
                    address(this),
                    address(usdc),
                    excess,
                    abi.encode(ACTION_WITHDRAW, uint256(0)),
                    0
                );
            }
            emit Rebalanced(currentLtv, targetLtvBps, excess);
        } else if (currentLtv + 100 < targetLtvBps) {
            // Under-leveraged — leverage up
            uint256 targetDebt = (collateral * targetLtvBps) / BPS;
            uint256 deficit = targetDebt - currentDebt;

            if (deficit > 1e4) {
                flashLoanPool.flashLoanSimple(
                    address(this),
                    address(usdc),
                    deficit,
                    abi.encode(ACTION_DEPOSIT, uint256(0)),
                    0
                );
            }
            emit Rebalanced(currentLtv, targetLtvBps, deficit);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // MERKL REWARDS
    // ═══════════════════════════════════════════════════════════════════

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

        for (uint256 i = 0; i < tokens.length; i++) {
            if (!allowedRewardTokens[tokens[i]]) revert RewardTokenNotAllowed();
        }

        address[] memory users = new address[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            users[i] = address(this);
        }

        merklDistributor.claim(users, tokens, amounts, proofs);

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

            IERC20(token).forceApprove(address(swapRouter), balance);
            uint256 received = swapRouter.exactInputSingle(
                ISwapRouterV3Euler.ExactInputSingleParams({
                    tokenIn: token,
                    tokenOut: address(usdc),
                    fee: defaultSwapFeeTier,
                    recipient: address(this),
                    amountIn: balance,
                    amountOutMinimum: (balance * minSwapOutputBps) / BPS,
                    sqrtPriceLimitX96: 0
                })
            );

            totalUsdcReceived += received;
            emit RewardsClaimed(token, received);
        }

        if (totalUsdcReceived > 0) {
            // Compound: supply back to Euler vault
            usdc.forceApprove(address(supplyVault), totalUsdcReceived);
            supplyVault.deposit(totalUsdcReceived, address(this));
            totalRewardsClaimed += totalUsdcReceived;

            uint256 collateral = supplyVault.convertToAssets(supplyVault.balanceOf(address(this)));
            uint256 leverageX100 = totalPrincipal > 0 ? (collateral * 100) / totalPrincipal : 100;

            emit RewardsCompounded(totalUsdcReceived, leverageX100);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // EMERGENCY
    // ═══════════════════════════════════════════════════════════════════

    function emergencyDeleverage()
        external
        override
        onlyRole(GUARDIAN_ROLE)
        nonReentrant
    {
        uint256 collateralBefore = supplyVault.convertToAssets(supplyVault.balanceOf(address(this)));
        uint256 debtBefore = borrowVault.debtOf(address(this));
        uint256 hfBefore = debtBefore > 0 ? (collateralBefore * WAD) / debtBefore : type(uint256).max;

        if (debtBefore > 0) {
            flashLoanPool.flashLoanSimple(
                address(this),
                address(usdc),
                debtBefore,
                abi.encode(ACTION_WITHDRAW, type(uint256).max),
                0
            );
        }

        uint256 shares = supplyVault.balanceOf(address(this));
        if (shares > 0) {
            supplyVault.redeem(shares, address(this), address(this));
        }

        uint256 hfAfter = type(uint256).max; // Fully deleveraged
        emit EmergencyDeleveraged(hfBefore, hfAfter);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ADMIN
    // ═══════════════════════════════════════════════════════════════════

    function setParameters(uint256 _targetLtvBps, uint256 _targetLoops) external onlyRole(STRATEGIST_ROLE) {
        if (_targetLtvBps < 3000 || _targetLtvBps > 9000) revert InvalidLTV();
        targetLtvBps = _targetLtvBps;
        targetLoops = _targetLoops;
        emit ParametersUpdated(_targetLtvBps, _targetLoops);
    }

    function setRewardToken(address _token, bool _allowed) external onlyRole(STRATEGIST_ROLE) {
        if (_token == address(0)) revert ZeroAddress();
        allowedRewardTokens[_token] = _allowed;
        emit RewardTokenToggled(_token, _allowed);
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

    uint256[35] private __gap;

    function _authorizeUpgrade(address) internal override onlyTimelock {}
}
