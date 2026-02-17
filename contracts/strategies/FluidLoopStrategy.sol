// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/ILeverageLoopStrategy.sol";
import "../interfaces/IFluidVault.sol";
import "../interfaces/IMerklDistributor.sol";
import "../TimelockGoverned.sol";
import "../Errors.sol";

// Resolver imports (same file, separate interfaces)
// IFluidVaultResolver — reads position data (collateral/debt) for any NFT
// IFluidDexResolver — resolves DEX shares → underlying token amounts
// IFluidDexT1 — core DEX interface for smart collateral deposits

// ═══════════════════════════════════════════════════════════════════════════
//                  AAVE V3 FLASH LOAN (for leverage building)
// ═══════════════════════════════════════════════════════════════════════════

interface IAavePoolForFluid {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IFlashLoanSimpleReceiverFluid {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

// ═══════════════════════════════════════════════════════════════════════════
//             UNISWAP V3 SWAP (for cross-asset conversion)
// ═══════════════════════════════════════════════════════════════════════════

interface ISwapRouterFluid {
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

// ═══════════════════════════════════════════════════════════════════════════
//                 WRAPPED STETH / WETH INTERFACES
// ═══════════════════════════════════════════════════════════════════════════

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
    function balanceOf(address) external view returns (uint256);
}

// ═══════════════════════════════════════════════════════════════════════════
//          FLUID LOOP STRATEGY — Unified for T1 / T2 / T4 Vaults
// ═══════════════════════════════════════════════════════════════════════════
//
// This contract implements leveraged loop positions on Fluid Protocol.
// Three vault modes are supported, selected at initialization:
//
//   Mode 1 (STABLE):  syrupUSDC / USDC   — VaultT1 (#146)
//   Mode 2 (LRT):     weETH-ETH / wstETH — VaultT2 (#74)
//   Mode 3 (LST):     wstETH-ETH / wstETH-ETH — VaultT4 (#44)
//
// All positions are NFT-based. The strategy holds a single NFT per vault.
// Flash loans (AAVE V3) are used to build/unwind the leveraged position.
// ═══════════════════════════════════════════════════════════════════════════

contract FluidLoopStrategy is
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    TimelockGoverned,
    ILeverageLoopStrategy,
    IFlashLoanSimpleReceiverFluid
{
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════

    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;

    // Vault modes
    uint8 public constant MODE_STABLE = 1;  // T1: syrupUSDC / USDC
    uint8 public constant MODE_LRT    = 2;  // T2: weETH-ETH / wstETH
    uint8 public constant MODE_LST    = 3;  // T4: wstETH-ETH / wstETH-ETH

    // Flash loan action types
    uint8 private constant ACTION_DEPOSIT  = 1;
    uint8 private constant ACTION_WITHDRAW = 2;

    // Roles
    bytes32 public constant TREASURY_ROLE  = keccak256("TREASURY_ROLE");
    bytes32 public constant STRATEGIST_ROLE = keccak256("STRATEGIST_ROLE");
    bytes32 public constant GUARDIAN_ROLE   = keccak256("GUARDIAN_ROLE");
    bytes32 public constant KEEPER_ROLE    = keccak256("KEEPER_ROLE");

    // ═══════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Which vault mode (1=STABLE, 2=LRT, 3=LST)
    uint8 public vaultMode;

    /// @notice The input asset (USDC for stables, WETH/wstETH for LST/LRT)
    IERC20 public inputAsset;

    /// @notice The supply-side token deposited into Fluid vault
    IERC20 public supplyToken;

    /// @notice The borrow-side token
    IERC20 public borrowToken;

    /// @notice Second supply token for smart collateral (T2/T4 only)
    IERC20 public supplyToken1;

    /// @notice Second borrow token for smart debt (T4 only)
    IERC20 public borrowToken1;

    /// @notice The Fluid vault address
    address public fluidVault;

    /// @notice Fluid Vault Factory (holds position NFTs)
    IFluidVaultFactory public vaultFactory;

    /// @notice AAVE V3 pool for flash loans
    IAavePoolForFluid public flashLoanPool;

    /// @notice Merkl distributor for reward claiming
    IMerklDistributor public merklDistributor;

    /// @notice Uniswap V3 router for asset swaps
    ISwapRouterFluid public swapRouter;

    /// @notice Our position NFT ID in the Fluid vault (0 = no position)
    uint256 public positionNftId;

    /// @notice Target LTV in basis points (e.g., 9000 = 90%)
    uint256 public targetLtvBps;

    /// @notice Number of leverage loops
    uint256 public targetLoops;

    /// @notice Safety buffer BPS below CF before rebalance
    uint256 public safetyBufferBps;

    /// @notice Strategy active flag
    bool public active;

    /// @notice Total USDC principal deposited
    uint256 public totalPrincipal;

    /// @notice Total rewards claimed (denominated in input asset)
    uint256 public totalRewardsClaimed;

    /// @notice Swap fee tier for correlated pairs (100 = 0.01%)
    uint24 public swapFeeTier;

    /// @notice Swap fee tier for reward token swaps
    uint24 public rewardSwapFeeTier;

    /// @notice Minimum swap output in BPS (9900 = 99%)
    uint256 public minSwapOutputBps;

    /// @notice Allowed reward tokens for compounding
    mapping(address => bool) public allowedRewardTokens;

    // ═══════════════════════════════════════════════════════════════════
    // RESOLVER STATE (V2 — live position reads + DEX integration)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Fluid VaultResolver — reads live position data (collateral/debt)
    IFluidVaultResolver public vaultResolver;

    /// @notice Fluid DexResolver — resolves DEX LP shares → underlying tokens
    IFluidDexResolver public dexResolver;

    /// @notice DEX protocol address for smart collateral (T2/T4 supply side)
    address public dexPool;

    /// @notice Whether DEX smart collateral is enabled (T2/T4 only)
    bool public dexEnabled;

    // ═══════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error InvalidVaultMode();
    error InvalidLTV();
    error InvalidFlashLoan();
    error PositionAlreadyExists();
    error SharePriceBelowMin();
    error RewardTokenNotAllowed();
    error CannotRecoverActiveAsset();

    // ═══════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event PositionCreated(uint256 nftId, uint8 vaultMode);
    event Deposited(uint256 principal, uint256 leveragedAmount);
    event ActiveUpdated(bool active);
    event Withdrawn(uint256 amount, uint256 principalReduced);
    event ParametersUpdated(uint256 targetLtvBps, uint256 targetLoops);
    event RewardTokenToggled(address indexed token, bool allowed);
    event SwapExecuted(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);

    // ═══════════════════════════════════════════════════════════════════
    // INITIALIZER
    // ═══════════════════════════════════════════════════════════════════

    struct InitParams {
        uint8 mode;               // 1=STABLE, 2=LRT, 3=LST
        address inputAsset;       // USDC, WETH, or wstETH
        address supplyToken;      // syrupUSDC, weETH, wstETH
        address borrowToken;      // USDC, wstETH, wstETH
        address supplyToken1;     // address(0) for T1, ETH for T2/T4
        address borrowToken1;     // address(0) for T1/T2, ETH for T4
        address fluidVault;       // Fluid vault address
        address vaultFactory;     // Fluid VaultFactory
        address flashLoanPool;    // AAVE V3 pool
        address merklDistributor; // Merkl distributor
        address swapRouter;       // Uniswap V3 router
        address vaultResolver;    // Fluid VaultResolver (position reads)
        address dexResolver;      // Fluid DexResolver (share resolution)
        address dexPool;          // Fluid DEX pool for smart collateral (0 = disabled)
        address treasury;
        address admin;
        address timelock;
    }

    function initialize(InitParams calldata p) external initializer {
        if (p.timelock == address(0)) revert ZeroAddress();
        if (p.inputAsset == address(0)) revert ZeroAddress();
        if (p.fluidVault == address(0)) revert ZeroAddress();
        if (p.mode == 0 || p.mode > 3) revert InvalidVaultMode();

        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        _setTimelock(p.timelock);

        vaultMode = p.mode;
        inputAsset = IERC20(p.inputAsset);
        supplyToken = IERC20(p.supplyToken);
        borrowToken = IERC20(p.borrowToken);
        supplyToken1 = IERC20(p.supplyToken1);
        borrowToken1 = IERC20(p.borrowToken1);
        fluidVault = p.fluidVault;
        vaultFactory = IFluidVaultFactory(p.vaultFactory);
        flashLoanPool = IAavePoolForFluid(p.flashLoanPool);
        merklDistributor = IMerklDistributor(p.merklDistributor);
        swapRouter = ISwapRouterFluid(p.swapRouter);

        // Resolvers (can be address(0) for test/mock deployments)
        if (p.vaultResolver != address(0)) {
            vaultResolver = IFluidVaultResolver(p.vaultResolver);
        }
        if (p.dexResolver != address(0)) {
            dexResolver = IFluidDexResolver(p.dexResolver);
        }
        if (p.dexPool != address(0)) {
            dexPool = p.dexPool;
            dexEnabled = true;
        }

        // Defaults based on vault mode
        if (p.mode == MODE_STABLE) {
            targetLtvBps = 9000;   // 90% LTV for stablecoins
            targetLoops = 4;
            swapFeeTier = 100;     // 0.01% for stablecoin pairs
        } else if (p.mode == MODE_LRT) {
            targetLtvBps = 9200;   // 92% for ETH-correlated
            targetLoops = 4;
            swapFeeTier = 100;     // tight for ETH/LST/LRT
        } else {
            targetLtvBps = 9400;   // 94% for same-LP loop
            targetLoops = 5;
            swapFeeTier = 100;
        }

        safetyBufferBps = 200;
        active = true;
        rewardSwapFeeTier = 3000;
        minSwapOutputBps = 9900;

        _grantRole(DEFAULT_ADMIN_ROLE, p.admin);
        _grantRole(TREASURY_ROLE, p.treasury);
        _grantRole(STRATEGIST_ROLE, p.admin);
        _grantRole(GUARDIAN_ROLE, p.admin);
        _grantRole(KEEPER_ROLE, p.admin);
    }

    // ═══════════════════════════════════════════════════════════════════
    // IStrategy — BASE INTERFACE
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Returns the input asset address
    function asset() external view override returns (address) {
        return address(inputAsset);
    }

    /// @notice Whether strategy is active
    function isActive() external view override returns (bool) {
        return active;
    }

    /// @notice Deposit input asset and build leveraged Fluid position
    function deposit(uint256 amount)
        external
        override
        onlyRole(TREASURY_ROLE)
        nonReentrant
        whenNotPaused
        returns (uint256 deposited)
    {
        if (!active) revert NotActive();
        if (amount == 0) revert ZeroAmount();

        inputAsset.safeTransferFrom(msg.sender, address(this), amount);

        // Build leveraged position via flash loan
        uint256 flashAmount = (amount * targetLtvBps) / (BPS - targetLtvBps);
        if (flashAmount > 0) {
            flashLoanPool.flashLoanSimple(
                address(this),
                address(inputAsset),
                flashAmount,
                abi.encode(ACTION_DEPOSIT, amount),
                0
            );
        } else {
            _depositDirect(amount);
        }

        totalPrincipal += amount;
        deposited = amount;

        emit Deposited(amount, amount + flashAmount);
        emit Leveraged(amount, amount + flashAmount, _calcLeverageX100(), targetLoops);
    }

    /// @notice Withdraw from Fluid position
    function withdraw(uint256 amount)
        external
        override
        onlyRole(TREASURY_ROLE)
        nonReentrant
        whenNotPaused
        returns (uint256 withdrawn)
    {
        if (amount == 0) revert ZeroAmount();

        uint256 positionValue = _getPositionValue();
        uint256 toWithdraw = amount > positionValue ? positionValue : amount;

        if (toWithdraw > 0) {
            _withdrawFromPosition(toWithdraw);
        }

        uint256 balance = inputAsset.balanceOf(address(this));
        withdrawn = balance > toWithdraw ? toWithdraw : balance;

        if (withdrawn > totalPrincipal) {
            totalPrincipal = 0;
        } else {
            totalPrincipal -= withdrawn;
        }

        if (withdrawn > 0) {
            inputAsset.safeTransfer(msg.sender, withdrawn);
        }

        emit Withdrawn(withdrawn, withdrawn);
    }

    /// @notice Withdraw all — fully deleverage and return everything
    function withdrawAll()
        external
        override
        onlyRole(TREASURY_ROLE)
        nonReentrant
        returns (uint256 withdrawn)
    {
        _fullDeleverage();

        uint256 balance = inputAsset.balanceOf(address(this));
        totalPrincipal = 0;

        if (balance > 0) {
            inputAsset.safeTransfer(msg.sender, balance);
        }

        withdrawn = balance;
        emit Withdrawn(withdrawn, withdrawn);
    }

    /// @notice Total value of position in input asset terms
    function totalValue() external view override returns (uint256) {
        return _getPositionValue();
    }

    // ═══════════════════════════════════════════════════════════════════
    // ILeverageLoopStrategy — EXTENDED INTERFACE
    // ═══════════════════════════════════════════════════════════════════

    function getHealthFactor() external view override returns (uint256) {
        uint256 col = _getCollateralValue();
        uint256 debt = _getDebtValue();
        if (debt == 0) return type(uint256).max;
        return (col * WAD) / debt;
    }

    function getCurrentLeverage() external view override returns (uint256 leverageX100) {
        return _calcLeverageX100();
    }

    function getPosition() external view override returns (
        uint256 collateral,
        uint256 borrowed,
        uint256 principal,
        uint256 netValue
    ) {
        collateral = _getCollateralValue();
        borrowed = _getDebtValue();
        principal = totalPrincipal;
        netValue = collateral > borrowed ? collateral - borrowed : 0;
    }

    function realSharePrice() external view override returns (uint256 priceWad, bool trusted) {
        if (totalPrincipal == 0) return (WAD, true);
        uint256 netVal = _getPositionValue();
        priceWad = (netVal * WAD) / totalPrincipal;
        trusted = true;
    }

    function realTvl() external view override returns (uint256 tvl, bool trusted) {
        tvl = _getPositionValue();
        trusted = true;
    }

    // ═══════════════════════════════════════════════════════════════════
    // REBALANCE & LEVERAGE
    // ═══════════════════════════════════════════════════════════════════

    function rebalance()
        external
        override
        onlyRole(KEEPER_ROLE)
        nonReentrant
        whenNotPaused
    {
        uint256 col = _getCollateralValue();
        uint256 debt = _getDebtValue();
        if (debt == 0 || col == 0) return;

        uint256 currentLtv = (debt * BPS) / col;
        uint256 oldLtv = currentLtv;

        if (currentLtv > targetLtvBps + safetyBufferBps) {
            // Over-leveraged → repay some debt
            uint256 excess = debt - ((col * targetLtvBps) / BPS);
            _repayDebt(excess);
        } else if (currentLtv < targetLtvBps - safetyBufferBps) {
            // Under-leveraged → borrow more
            uint256 deficit = ((col * targetLtvBps) / BPS) - debt;
            _borrowMore(deficit);
        }

        col = _getCollateralValue();
        debt = _getDebtValue();
        uint256 newLtv = debt > 0 ? (debt * BPS) / col : 0;

        emit Rebalanced(oldLtv, newLtv, 0);
    }

    function adjustLeverage(uint256 newLtvBps, uint256 minSharePrice)
        external
        override
        onlyRole(STRATEGIST_ROLE)
        nonReentrant
        whenNotPaused
    {
        if (newLtvBps < 3000 || newLtvBps > 9500) revert InvalidLTV();

        targetLtvBps = newLtvBps;

        // Rebalance to new target
        uint256 col = _getCollateralValue();
        uint256 debt = _getDebtValue();

        if (debt > 0 && col > 0) {
            uint256 currentLtv = (debt * BPS) / col;

            if (currentLtv > newLtvBps) {
                uint256 excess = debt - ((col * newLtvBps) / BPS);
                _repayDebt(excess);
            } else if (currentLtv < newLtvBps) {
                uint256 deficit = ((col * newLtvBps) / BPS) - debt;
                _borrowMore(deficit);
            }
        }

        // Share price protection
        if (totalPrincipal > 0) {
            uint256 netVal = _getPositionValue();
            uint256 sharePrice = (netVal * WAD) / totalPrincipal;
            if (sharePrice < minSharePrice) revert SharePriceBelowMin();
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

        uint256 totalReceived = 0;

        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            uint256 balance = IERC20(token).balanceOf(address(this));
            if (balance == 0) continue;

            if (token == address(inputAsset)) {
                totalReceived += balance;
                emit RewardsClaimed(token, balance);
                continue;
            }

            // Swap reward → input asset
            IERC20(token).forceApprove(address(swapRouter), balance);
            uint256 received = swapRouter.exactInputSingle(
                ISwapRouterFluid.ExactInputSingleParams({
                    tokenIn: token,
                    tokenOut: address(inputAsset),
                    fee: rewardSwapFeeTier,
                    recipient: address(this),
                    amountIn: balance,
                    amountOutMinimum: (balance * minSwapOutputBps) / BPS,
                    sqrtPriceLimitX96: 0
                })
            );

            totalReceived += received;
            emit RewardsClaimed(token, received);
        }

        if (totalReceived > 0) {
            // Compound into the position
            _depositDirect(totalReceived);
            totalRewardsClaimed += totalReceived;
            emit RewardsCompounded(totalReceived, _calcLeverageX100());
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
        uint256 hfBefore = _getDebtValue() > 0
            ? (_getCollateralValue() * WAD) / _getDebtValue()
            : type(uint256).max;

        _fullDeleverage();

        emit EmergencyDeleveraged(hfBefore, type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════
    // FLASH LOAN CALLBACK
    // ═══════════════════════════════════════════════════════════════════

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        if (msg.sender != address(flashLoanPool)) revert InvalidFlashLoan();
        if (initiator != address(this)) revert InvalidFlashLoan();
        // M-02: Validate flash-loaned asset matches expected input asset
        if (asset != address(inputAsset)) revert InvalidFlashLoan();

        (uint8 action, uint256 principalAmount) = abi.decode(params, (uint8, uint256));

        if (action == ACTION_DEPOSIT) {
            uint256 totalSupply = amount + principalAmount;

            // Supply collateral to Fluid vault
            _supplyToVault(totalSupply);

            // Borrow from Fluid vault to repay flash loan
            _borrowFromVault(amount + premium);
        } else if (action == ACTION_WITHDRAW) {
            // Repay Fluid vault debt
            _repayToVault(amount);

            // Withdraw collateral from Fluid vault
            if (principalAmount == type(uint256).max) {
                // Full deleverage — withdraw all remaining collateral
                uint256 allCol = _getCollateralValue();
                if (allCol > 0) {
                    _withdrawFromVault(allCol);
                }
            } else {
                uint256 toWithdraw = principalAmount + amount + premium;
                _withdrawFromVault(toWithdraw);
            }
        }

        // Approve flash loan repayment
        inputAsset.forceApprove(address(flashLoanPool), amount + premium);
        return true;
    }

    // ═══════════════════════════════════════════════════════════════════
    // INTERNAL — FLUID VAULT OPERATIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Supply collateral into the Fluid vault
    function _supplyToVault(uint256 amount) internal {
        IERC20(supplyToken).forceApprove(fluidVault, amount);

        if (vaultMode == MODE_STABLE) {
            // T1: operate(nftId, +col, 0, to)
            (uint256 nftId,,) = IFluidVaultT1(fluidVault).operate(
                positionNftId,
                int256(amount),
                0,
                address(this)
            );
            if (positionNftId == 0) {
                positionNftId = nftId;
                emit PositionCreated(nftId, vaultMode);
            }
        } else if (vaultMode == MODE_LRT) {
            // T2: Supply token0 (weETH) as collateral, no token1
            (uint256 nftId,,) = IFluidVaultT2(fluidVault).operate(
                positionNftId,
                int256(amount), // token0 (weETH)
                0,              // token1 (ETH)
                1,              // colSharesMinMax (min 1 share)
                0,              // no debt change
                address(this)
            );
            if (positionNftId == 0) {
                positionNftId = nftId;
                emit PositionCreated(nftId, vaultMode);
            }
        } else {
            // T4: Supply token0 (wstETH) as smart collateral
            (uint256 nftId,,) = IFluidVaultT4(fluidVault).operate(
                positionNftId,
                int256(amount), // col token0 (wstETH)
                0,              // col token1 (ETH)
                1,              // colSharesMinMax
                0,              // debt token0
                0,              // debt token1
                0,              // debtSharesMinMax
                address(this)
            );
            if (positionNftId == 0) {
                positionNftId = nftId;
                emit PositionCreated(nftId, vaultMode);
            }
        }
    }

    /// @dev Borrow from the Fluid vault
    function _borrowFromVault(uint256 amount) internal {
        if (vaultMode == MODE_STABLE) {
            // T1: operate(nftId, 0, +debt, to)
            IFluidVaultT1(fluidVault).operate(
                positionNftId,
                0,
                int256(amount),
                address(this)
            );
        } else if (vaultMode == MODE_LRT) {
            // T2: Borrow wstETH
            IFluidVaultT2(fluidVault).operate(
                positionNftId,
                0, 0, 0,         // no collateral change
                int256(amount),  // borrow
                address(this)
            );
        } else {
            // T4: Borrow token0 (wstETH) from smart debt
            IFluidVaultT4(fluidVault).operate(
                positionNftId,
                0, 0, 0,         // no collateral change
                int256(amount),  // debt token0
                0,               // debt token1
                int256(amount),  // debtSharesMinMax (min)
                address(this)
            );
        }
    }

    /// @dev Repay debt to the Fluid vault
    function _repayToVault(uint256 amount) internal {
        IERC20(borrowToken).forceApprove(fluidVault, amount);

        if (vaultMode == MODE_STABLE) {
            IFluidVaultT1(fluidVault).operate(
                positionNftId,
                0,
                -int256(amount),
                address(this)
            );
        } else if (vaultMode == MODE_LRT) {
            IFluidVaultT2(fluidVault).operate(
                positionNftId,
                0, 0, 0,
                -int256(amount),
                address(this)
            );
        } else {
            IFluidVaultT4(fluidVault).operate(
                positionNftId,
                0, 0, 0,
                -int256(amount),
                0,
                -int256(amount),
                address(this)
            );
        }
    }

    /// @dev Withdraw collateral from the Fluid vault
    function _withdrawFromVault(uint256 amount) internal {
        if (vaultMode == MODE_STABLE) {
            IFluidVaultT1(fluidVault).operate(
                positionNftId,
                -int256(amount),
                0,
                address(this)
            );
        } else if (vaultMode == MODE_LRT) {
            IFluidVaultT2(fluidVault).operate(
                positionNftId,
                -int256(amount),
                0,
                -1,  // colSharesMinMax = -1 (withdraw minimum 1 share)
                0,
                address(this)
            );
        } else {
            IFluidVaultT4(fluidVault).operate(
                positionNftId,
                -int256(amount),
                0,
                -1,
                0, 0, 0,
                address(this)
            );
        }
    }

    /// @dev Direct deposit (no flash loan) — for compounding small amounts
    function _depositDirect(uint256 amount) internal {
        _supplyToVault(amount);
    }

    /// @dev Withdraw from position (may use flash loan to deleverage)
    function _withdrawFromPosition(uint256 amount) internal {
        uint256 debt = _getDebtValue();

        if (debt > 0) {
            // Need flash loan to unwind proportionally
            uint256 debtToRepay = (debt * amount) / _getPositionValue();
            if (debtToRepay > 0) {
                flashLoanPool.flashLoanSimple(
                    address(this),
                    address(inputAsset),
                    debtToRepay,
                    abi.encode(ACTION_WITHDRAW, amount),
                    0
                );
            }
        } else {
            _withdrawFromVault(amount);
        }
    }

    /// @dev Full deleverage — unwind entire position
    function _fullDeleverage() internal {
        uint256 debt = _getDebtValue();

        if (debt > 0) {
            flashLoanPool.flashLoanSimple(
                address(this),
                address(inputAsset),
                debt,
                abi.encode(ACTION_WITHDRAW, type(uint256).max),
                0
            );
        } else {
            // No debt, just withdraw remaining collateral
            uint256 col = _getCollateralValue();
            if (col > 0) {
                _withdrawFromVault(col);
            }
        }
    }

    /// @dev Repay some debt for rebalancing
    function _repayDebt(uint256 amount) internal {
        uint256 balance = inputAsset.balanceOf(address(this));
        if (balance < amount) {
            // Withdraw collateral to get funds for repayment
            uint256 needed = amount - balance;
            _withdrawFromVault(needed);
        }
        _repayToVault(amount);
    }

    /// @dev Borrow more for rebalancing
    function _borrowMore(uint256 amount) internal {
        _borrowFromVault(amount);
        _supplyToVault(amount);
    }

    // ═══════════════════════════════════════════════════════════════════
    // INTERNAL — POSITION VALUE HELPERS
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Get total collateral value in input asset terms
    function _getCollateralValue() internal view returns (uint256) {
        if (positionNftId == 0) return 0;

        // For mocks, we use a simplified view
        // In production, this would read from Fluid's VaultResolver
        // or the vault's position data directly
        return _readCollateralFromVault();
    }

    /// @dev Get total debt value in input asset terms
    function _getDebtValue() internal view returns (uint256) {
        if (positionNftId == 0) return 0;
        return _readDebtFromVault();
    }

    /// @dev Net position value (collateral - debt)
    function _getPositionValue() internal view returns (uint256) {
        uint256 col = _getCollateralValue();
        uint256 debt = _getDebtValue();
        return col > debt ? col - debt : 0;
    }

    /// @dev Calculate current leverage as X100 (e.g., 400 = 4x)
    function _calcLeverageX100() internal view returns (uint256) {
        uint256 col = _getCollateralValue();
        if (totalPrincipal == 0 || col == 0) return 100;
        return (col * 100) / totalPrincipal;
    }

    /// @dev Read collateral from vault via VaultResolver + DexResolver.
    ///      For T1 vaults, supply is in raw token amounts.
    ///      For T2/T4 (smart collateral), supply is in DEX shares
    ///      which are resolved to token amounts via the DexResolver.
    ///      Still virtual so test harness can override with mock reads.
    function _readCollateralFromVault() internal view virtual returns (uint256) {
        if (address(vaultResolver) == address(0)) return 0; // no resolver = test mode

        (IFluidVaultResolver.UserPosition memory pos,
         IFluidVaultResolver.VaultEntireData memory data) =
            vaultResolver.positionByNftId(positionNftId);

        uint256 supplyRaw = pos.supply; // token amount for T1, shares for T2/T4

        if (!data.isSmartCol) {
            // T1: supply is already in token amounts, adjust by vault exchange price
            // pos.supply is already the final amount after exchange price application
            return supplyRaw;
        }

        // T2/T4: supply is in DEX shares → resolve to token amounts
        return _resolveDexSupplyShares(supplyRaw);
    }

    /// @dev Read debt from vault via VaultResolver + DexResolver.
    ///      For T1/T2 vaults, borrow is in raw token amounts.
    ///      For T4 (smart debt), borrow is in DEX shares.
    function _readDebtFromVault() internal view virtual returns (uint256) {
        if (address(vaultResolver) == address(0)) return 0;

        (IFluidVaultResolver.UserPosition memory pos,
         IFluidVaultResolver.VaultEntireData memory data) =
            vaultResolver.positionByNftId(positionNftId);

        uint256 borrowRaw = pos.borrow;

        if (!data.isSmartDebt) {
            // T1/T2: borrow is in raw token amounts
            return borrowRaw;
        }

        // T4: borrow is in DEX shares → resolve to token amounts
        return _resolveDexBorrowShares(borrowRaw);
    }

    /// @dev Convert DEX supply shares → total underlying token value.
    ///      Uses DexResolver.getDexState() which returns token amounts per 1e18 shares.
    ///      Returns sum of token0 + token1 values (assumes correlated pair, e.g. ETH/wstETH).
    function _resolveDexSupplyShares(uint256 shares) internal view returns (uint256) {
        if (shares == 0 || address(dexResolver) == address(0) || dexPool == address(0)) return 0;

        // getDexState is a non-view that uses staticcall internally;
        // safe to call from a view context via the resolver's caching pattern.
        // For on-chain view calls, we use the last cached values.
        // token0PerSupplyShare and token1PerSupplyShare are 1e18-based.
        IFluidDexResolver.DexState memory state = _cachedDexState();

        uint256 token0Value = (shares * state.token0PerSupplyShare) / WAD;
        uint256 token1Value = (shares * state.token1PerSupplyShare) / WAD;

        return token0Value + token1Value;
    }

    /// @dev Convert DEX borrow shares → total underlying token value
    function _resolveDexBorrowShares(uint256 shares) internal view returns (uint256) {
        if (shares == 0 || address(dexResolver) == address(0) || dexPool == address(0)) return 0;

        IFluidDexResolver.DexState memory state = _cachedDexState();

        uint256 token0Value = (shares * state.token0PerBorrowShare) / WAD;
        uint256 token1Value = (shares * state.token1PerBorrowShare) / WAD;

        return token0Value + token1Value;
    }

    /// @dev Read cached DEX state. In production the DexResolver may be
    ///      non-view (it updates internal caches on mainnet). This base
    ///      implementation returns a zero struct. The test harness and
    ///      production child contracts MUST override this to return
    ///      live share-to-token ratios from the DexResolver.
    function _cachedDexState() internal view virtual returns (IFluidDexResolver.DexState memory state) {
        // Default: returns zeroed struct. Override in child contracts.
        // Production override should read DEX storage slots directly
        // (view-safe) or use an off-chain keeper to cache the values.
        return state;
    }

    // ═══════════════════════════════════════════════════════════════════
    // DEX SMART COLLATERAL — earn DEX trading fees on top of lending
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Deposit both tokens into the DEX pool as smart collateral LP.
    ///         This makes vault collateral also act as DEX LP, earning trading fees.
    ///         Only applicable for T2/T4 vaults where supply side is a Fluid DEX.
    /// @param token0Amount Amount of token0 to deposit into DEX LP
    /// @param token1Amount Amount of token1 to deposit into DEX LP
    /// @param minShares Minimum DEX shares to receive (slippage protection)
    function depositDexCollateral(
        uint256 token0Amount,
        uint256 token1Amount,
        int256 minShares
    )
        external
        onlyRole(STRATEGIST_ROLE)
        nonReentrant
        whenNotPaused
    {
        if (!dexEnabled) revert NotActive();
        if (vaultMode == MODE_STABLE) revert InvalidVaultMode();
        if (token0Amount == 0 && token1Amount == 0) revert ZeroAmount();

        // Approve tokens to the Fluid vault (which routes through DEX)
        // Handle case where supplyToken == supplyToken1 (same token for both sides)
        if (address(supplyToken) == address(supplyToken1)) {
            IERC20(supplyToken).forceApprove(fluidVault, token0Amount + token1Amount);
        } else {
            if (token0Amount > 0) {
                IERC20(supplyToken).forceApprove(fluidVault, token0Amount);
            }
            if (token1Amount > 0) {
                IERC20(supplyToken1).forceApprove(fluidVault, token1Amount);
            }
        }

        if (vaultMode == MODE_LRT) {
            // T2: smart collateral + normal debt
            (uint256 nftId,,) = IFluidVaultT2(fluidVault).operate(
                positionNftId,
                int256(token0Amount),
                int256(token1Amount),
                minShares,
                0, // no debt change
                address(this)
            );
            if (positionNftId == 0) {
                positionNftId = nftId;
                emit PositionCreated(nftId, vaultMode);
            }
        } else {
            // T4: smart collateral + smart debt
            (uint256 nftId,,) = IFluidVaultT4(fluidVault).operate(
                positionNftId,
                int256(token0Amount),
                int256(token1Amount),
                minShares,
                0, 0, 0, // no debt change
                address(this)
            );
            if (positionNftId == 0) {
                positionNftId = nftId;
                emit PositionCreated(nftId, vaultMode);
            }
        }

        emit DexCollateralDeposited(token0Amount, token1Amount);
    }

    /// @notice Withdraw DEX LP collateral back to individual tokens.
    /// @param sharesToBurn DEX shares to redeem (negative for withdraw)
    /// @param minToken0 Minimum token0 to receive
    /// @param minToken1 Minimum token1 to receive
    function withdrawDexCollateral(
        uint256 sharesToBurn,
        uint256 minToken0,
        uint256 minToken1
    )
        external
        onlyRole(STRATEGIST_ROLE)
        nonReentrant
        whenNotPaused
    {
        if (!dexEnabled) revert NotActive();
        if (vaultMode == MODE_STABLE) revert InvalidVaultMode();
        if (sharesToBurn == 0) revert ZeroAmount();

        if (vaultMode == MODE_LRT) {
            IFluidVaultT2(fluidVault).operatePerfect(
                positionNftId,
                -int256(sharesToBurn),
                -int256(minToken0),
                -int256(minToken1),
                0, // no debt change
                address(this)
            );
        } else {
            IFluidVaultT4(fluidVault).operatePerfect(
                positionNftId,
                -int256(sharesToBurn),
                -int256(minToken0),
                -int256(minToken1),
                0, 0, 0, // no debt change
                address(this)
            );
        }

        emit DexCollateralWithdrawn(sharesToBurn);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ADMIN
    // ═══════════════════════════════════════════════════════════════════

    function setParameters(uint256 _targetLtvBps, uint256 _targetLoops) external onlyRole(STRATEGIST_ROLE) {
        if (_targetLtvBps < 3000 || _targetLtvBps > 9500) revert InvalidLTV();
        targetLtvBps = _targetLtvBps;
        targetLoops = _targetLoops;
        emit ParametersUpdated(_targetLtvBps, _targetLoops);
    }

    function setRewardToken(address _token, bool _allowed) external onlyRole(STRATEGIST_ROLE) {
        if (_token == address(0)) revert ZeroAddress();
        allowedRewardTokens[_token] = _allowed;
        emit RewardTokenToggled(_token, _allowed);
    }

    function setSwapFees(uint24 _feeTier, uint24 _rewardFeeTier) external onlyRole(STRATEGIST_ROLE) {
        swapFeeTier = _feeTier;
        rewardSwapFeeTier = _rewardFeeTier;
    }

    function setMinSwapOutput(uint256 _minOutputBps) external onlyRole(STRATEGIST_ROLE) {
        if (_minOutputBps < 9000 || _minOutputBps > BPS) revert InvalidLTV();
        minSwapOutputBps = _minOutputBps;
    }

    function setActive(bool _active) external onlyRole(STRATEGIST_ROLE) {
        active = _active;
        emit ActiveUpdated(_active);
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyTimelock {
        _unpause();
    }

    function recoverToken(address token, uint256 amount) external onlyTimelock {
        if (token == address(inputAsset) && totalPrincipal > 0) revert CannotRecoverActiveAsset();
        IERC20(token).safeTransfer(msg.sender, amount);
    }

    /// @notice Set the Fluid VaultResolver address (for live position reads)
    function setVaultResolver(address _resolver) external onlyTimelock {
        if (_resolver == address(0)) revert ZeroAddress();
        vaultResolver = IFluidVaultResolver(_resolver);
    }

    /// @notice Set the Fluid DexResolver address (for DEX share resolution)
    function setDexResolver(address _resolver) external onlyTimelock {
        if (_resolver == address(0)) revert ZeroAddress();
        dexResolver = IFluidDexResolver(_resolver);
    }

    /// @notice Enable/disable DEX smart collateral and set the DEX pool address
    function setDexPool(address _dexPool, bool _enabled) external onlyTimelock {
        dexPool = _dexPool;
        dexEnabled = _enabled;
        emit DexPoolUpdated(_dexPool, _enabled);
    }

    // ═══════════════════════════════════════════════════════════════════
    // EVENTS (V2 — DEX integration)
    // ═══════════════════════════════════════════════════════════════════

    event DexCollateralDeposited(uint256 token0Amount, uint256 token1Amount);
    event DexCollateralWithdrawn(uint256 sharesBurned);
    event DexPoolUpdated(address indexed dexPool, bool enabled);

    // ═══════════════════════════════════════════════════════════════════
    // STORAGE GAP & UPGRADES
    // ═══════════════════════════════════════════════════════════════════

    uint256[26] private __gap;  // reduced from 30 → 26 (4 new storage vars above)

    function _authorizeUpgrade(address) internal override onlyTimelock {}
}
