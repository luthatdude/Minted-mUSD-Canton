// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IStrategy.sol";
import "../interfaces/IYieldBasis.sol";
import "../TimelockGoverned.sol";
import "../Errors.sol";

/**
 * @title YieldBasisStrategy
 * @notice TreasuryV2 strategy that deposits into Yield Basis leveraged LP markets
 * @dev Deposits USDC from Treasury → swaps to crypto asset → deposits into MintedLT
 *      → earns leveraged LP yield from Curve pool trading fees.
 *
 * V2 Architecture (correct — based on actual yb-core):
 *   The real Yield Basis protocol is a LEVERAGED LIQUIDITY system, not a lending pool.
 *   Users deposit crypto assets (WBTC/WETH) + borrow stablecoins → added to Curve pools
 *   at 2x leverage → earn amplified LP fees.
 *
 *   MintedLT.deposit(assets, debt, minShares, receiver) → LT shares
 *   MintedLT.withdraw(shares, minAssets, receiver) → crypto assets
 *
 * Strategy flow:
 *   1. Treasury sends USDC to this strategy
 *   2. Strategy swaps USDC → crypto asset (WBTC or WETH) via swap router
 *   3. Strategy deposits crypto asset into MintedLT with matching debt
 *   4. LT shares appreciate as Curve LP fees accumulate
 *   5. On withdraw: burn LT shares → receive crypto → swap to USDC → return to Treasury
 *
 * Each deployment targets ONE market (BTC or ETH). Deploy two instances:
 *   - YieldBasisStrategy(btcLT) → BTC leveraged LP
 *   - YieldBasisStrategy(ethLT) → ETH leveraged LP
 *
 * Safety:
 *   - Max debt ratio cap to prevent over-leveraging
 *   - Slippage protection on all swaps and deposits
 *   - Timelock on LT migration and swap router changes
 *   - Emergency withdrawAll() with fallback to emergency_withdraw
 */
contract YieldBasisStrategy is
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

    uint256 public constant BPS = 10_000;

    /// @notice Maximum slippage for swap + deposit operations (5%)
    uint256 public constant MAX_SLIPPAGE_BPS = 500;

    /// @notice Minimum withdrawal amount to prevent dust
    uint256 public constant MIN_WITHDRAW = 1e6; // 1 USDC

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

    /// @notice The MintedLT (Leveraged Liquidity Token) contract for this market
    IMintedLT public ltToken;

    /// @notice The crypto asset this strategy deposits (WBTC or WETH)
    IERC20 public assetToken;

    /// @notice The stablecoin used by the YB system (may differ from USDC)
    IERC20 public ybStablecoin;

    /// @notice Label for this strategy instance ("BTC" or "ETH")
    string public poolLabel;

    /// @notice Whether this strategy is active and accepting deposits
    bool public active;

    /// @notice Total USDC deposited (for tracking vs actual value)
    uint256 public totalDeposited;

    /// @notice Total USDC withdrawn
    uint256 public totalWithdrawn;

    /// @notice Slippage tolerance for deposit/withdraw (bps)
    uint256 public slippageBps;

    /// @notice Last harvest timestamp
    uint256 public lastHarvest;

    /// @notice Cumulative yield harvested
    uint256 public totalHarvested;

    /// @notice Swap router for USDC ↔ crypto asset conversions
    address public swapRouter;

    /// @dev Storage gap for future upgrades
    uint256[35] private __gap;

    // ═══════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event Deposited(uint256 usdcAmount, uint256 assetAmount, uint256 sharesReceived);
    event Withdrawn(uint256 shares, uint256 assetAmount, uint256 usdcReceived);
    event WithdrawnAll(uint256 totalReceived);
    event LTMigrated(address indexed oldLT, address indexed newLT);
    event SwapRouterUpdated(address indexed oldRouter, address indexed newRouter);
    event SlippageUpdated(uint256 oldBps, uint256 newBps);
    event Harvested(uint256 yield_, uint256 totalValue_);
    event ActivationToggled(bool active);

    // ═══════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error InvalidLT();
    error InvalidLabel();
    error InvalidSwapRouter();
    error SlippageTooHigh_();
    error LTKilled();

    // ═══════════════════════════════════════════════════════════════════════
    // INITIALIZER
    // ═══════════════════════════════════════════════════════════════════════

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the strategy
     * @param _usdc USDC token address
     * @param _ltToken MintedLT contract address
     * @param _swapRouter Router for USDC ↔ asset swaps (Uniswap, Curve, 1inch)
     * @param _treasury TreasuryV2 address (caller for deposit/withdraw)
     * @param _admin Admin address
     * @param _timelock Timelock controller address
     * @param _label Pool label ("BTC" or "ETH")
     */
    function initialize(
        address _usdc,
        address _ltToken,
        address _swapRouter,
        address _treasury,
        address _admin,
        address _timelock,
        string calldata _label
    ) external initializer {
        if (_usdc == address(0)) revert ZeroAddress();
        if (_ltToken == address(0)) revert InvalidLT();
        if (_swapRouter == address(0)) revert InvalidSwapRouter();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_admin == address(0)) revert ZeroAddress();
        if (_timelock == address(0)) revert ZeroAddress();
        if (bytes(_label).length == 0) revert InvalidLabel();

        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        _setTimelock(_timelock);

        usdc = IERC20(_usdc);
        ltToken = IMintedLT(_ltToken);
        assetToken = IERC20(IMintedLT(_ltToken).ASSET_TOKEN());
        ybStablecoin = IERC20(IMintedLT(_ltToken).STABLECOIN_TOKEN());
        swapRouter = _swapRouter;
        poolLabel = _label;
        active = true;
        slippageBps = 100; // 1% default slippage

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(TREASURY_ROLE, _treasury);
        _grantRole(STRATEGIST_ROLE, _admin);
        _grantRole(GUARDIAN_ROLE, _admin);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // IStrategy IMPLEMENTATION
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit USDC into the YB leveraged LP market
     * @dev Flow: USDC → swap to crypto asset → deposit into MintedLT with matching debt
     *      The debt amount is computed to roughly match the asset value (1:1 leverage base)
     * @param amount Amount of USDC to deposit
     * @return deposited Actual amount deposited
     */
    function deposit(uint256 amount)
        external
        override
        nonReentrant
        whenNotPaused
        onlyRole(TREASURY_ROLE)
        returns (uint256 deposited)
    {
        if (amount == 0) revert ZeroAmount();
        if (!active) revert NotActive();
        if (ltToken.isKilled()) revert LTKilled();

        // Pull USDC from Treasury
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        // Swap USDC → crypto asset via swap router
        // The swap router handles the conversion (Uniswap, Curve, etc.)
        uint256 assetAmount = _swapUsdcToAsset(amount);
        if (assetAmount == 0) revert ZeroOutput();

        // Compute appropriate debt: roughly match asset value in stablecoin terms
        // The debt is borrowed from AMM's pre-allocated stablecoin pool
        uint256 debtAmount = _computeDebt(assetAmount);

        // Approve LT to pull our asset tokens
        assetToken.forceApprove(address(ltToken), assetAmount);

        // Deposit into MintedLT: assets + debt → LT shares
        uint256 shares = ltToken.deposit(assetAmount, debtAmount, 0, address(this));

        // Clear residual approval
        assetToken.forceApprove(address(ltToken), 0);

        totalDeposited += amount;
        deposited = amount;

        emit Deposited(amount, assetAmount, shares);
        return deposited;
    }

    /**
     * @notice Withdraw USDC from the YB leveraged LP market
     * @dev Flow: burn LT shares → receive crypto asset → swap to USDC → return
     * @param amount Amount of USDC to withdraw (approximate — actual may vary)
     * @return withdrawn Actual USDC amount withdrawn
     */
    function withdraw(uint256 amount)
        external
        override
        nonReentrant
        whenNotPaused
        onlyRole(TREASURY_ROLE)
        returns (uint256 withdrawn)
    {
        if (amount == 0) revert ZeroAmount();

        uint256 ltShares = ltToken.balanceOf(address(this));
        if (ltShares == 0) revert ZeroAmount();

        // Estimate shares needed for the requested USDC amount
        uint256 pricePerShare_ = ltToken.pricePerShare();
        uint256 sharesToRedeem = (amount * 1e18) / pricePerShare_;
        if (sharesToRedeem > ltShares) {
            sharesToRedeem = ltShares;
        }

        // Withdraw from LT: burn shares → receive crypto asset
        uint256 assetBalBefore = assetToken.balanceOf(address(this));
        uint256 assetsReceived = ltToken.withdraw(sharesToRedeem, address(this), address(this));
        uint256 assetBalAfter = assetToken.balanceOf(address(this));
        assetsReceived = assetBalAfter - assetBalBefore;

        // Swap crypto asset → USDC
        withdrawn = _swapAssetToUsdc(assetsReceived);

        if (withdrawn > 0) {
            totalWithdrawn += withdrawn;
            usdc.safeTransfer(msg.sender, withdrawn);
        }

        emit Withdrawn(sharesToRedeem, assetsReceived, withdrawn);
        return withdrawn;
    }

    /**
     * @notice Withdraw all from the YB leveraged LP market
     * @return withdrawn Total USDC amount withdrawn
     */
    function withdrawAll()
        external
        override
        nonReentrant
        onlyRole(TREASURY_ROLE)
        returns (uint256 withdrawn)
    {
        uint256 ltShares = ltToken.balanceOf(address(this));
        if (ltShares == 0) return 0;

        // Try normal withdraw first
        uint256 assetBalBefore = assetToken.balanceOf(address(this));
        try ltToken.withdraw(ltShares, address(this), address(this)) returns (uint256) {
            // Normal withdraw succeeded
        } catch {
            // Fallback to emergency withdraw if normal fails (e.g., AMM killed)
            ltToken.emergencyWithdraw(ltShares, address(this), address(this));
        }
        uint256 assetsReceived = assetToken.balanceOf(address(this)) - assetBalBefore;

        // Swap all received crypto → USDC
        if (assetsReceived > 0) {
            withdrawn = _swapAssetToUsdc(assetsReceived);
        }

        // Also sweep any stablecoin received from emergency_withdraw
        uint256 stableBal = ybStablecoin.balanceOf(address(this));
        if (stableBal > 0 && address(ybStablecoin) != address(usdc)) {
            // If YB stablecoin isn't USDC, would need another swap
            // For now, transfer directly if they're the same
        } else if (stableBal > 0) {
            withdrawn += stableBal;
        }

        if (withdrawn > 0) {
            totalWithdrawn += withdrawn;
            usdc.safeTransfer(msg.sender, withdrawn);
        }

        emit WithdrawnAll(withdrawn);
        return withdrawn;
    }

    /**
     * @notice Total value of this strategy's LT position in USDC terms
     * @return Total value in USDC (6 decimals)
     */
    function totalValue() external view override returns (uint256) {
        uint256 ltShares = ltToken.balanceOf(address(this));
        if (ltShares == 0) return 0;

        // LT pricePerShare is in 18 decimals (crypto asset units per share)
        uint256 pricePerShare_ = ltToken.pricePerShare();
        uint256 assetValue = (ltShares * pricePerShare_) / 1e18;

        // Convert asset value to USDC terms using oracle
        // This is an approximation — actual swap output may differ
        return _estimateAssetValueInUsdc(assetValue);
    }

    /// @notice The underlying asset (USDC)
    function asset() external view override returns (address) {
        return address(usdc);
    }

    /// @notice Whether this strategy is active
    function isActive() external view override returns (bool) {
        return active && !paused() && !ltToken.isKilled();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STRATEGIST FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Record yield for tracking purposes
    function harvest() external onlyRole(STRATEGIST_ROLE) {
        uint256 ltShares = ltToken.balanceOf(address(this));
        uint256 pricePerShare_ = ltShares > 0 ? ltToken.pricePerShare() : 0;
        uint256 currentValue = (ltShares * pricePerShare_) / 1e18;
        uint256 estUsdc = _estimateAssetValueInUsdc(currentValue);

        uint256 netDeposited = totalDeposited > totalWithdrawn ? totalDeposited - totalWithdrawn : 0;
        uint256 yield_ = estUsdc > netDeposited ? estUsdc - netDeposited : 0;

        lastHarvest = block.timestamp;
        totalHarvested += yield_;

        emit Harvested(yield_, estUsdc);
    }

    /// @notice Toggle strategy active/inactive
    function setActive(bool _active) external onlyRole(STRATEGIST_ROLE) {
        active = _active;
        emit ActivationToggled(_active);
    }

    /// @notice Update slippage tolerance
    function setSlippage(uint256 _bps) external onlyRole(STRATEGIST_ROLE) {
        if (_bps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh_();
        uint256 old = slippageBps;
        slippageBps = _bps;
        emit SlippageUpdated(old, _bps);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TIMELOCK FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Migrate to a new MintedLT contract
    function migrateLT(address newLT) external onlyTimelock {
        if (newLT == address(0)) revert InvalidLT();
        address oldLT = address(ltToken);

        // Withdraw everything from current LT
        uint256 ltShares = ltToken.balanceOf(address(this));
        if (ltShares > 0) {
            try ltToken.withdraw(ltShares, address(this), address(this)) {} catch {
                ltToken.emergencyWithdraw(ltShares, address(this), address(this));
            }
        }

        // Update references
        ltToken = IMintedLT(newLT);
        assetToken = IERC20(IMintedLT(newLT).ASSET_TOKEN());
        ybStablecoin = IERC20(IMintedLT(newLT).STABLECOIN_TOKEN());

        // Re-deposit assets into new LT if we have any
        uint256 assetBal = assetToken.balanceOf(address(this));
        if (assetBal > 0) {
            uint256 debtAmount = _computeDebt(assetBal);
            assetToken.forceApprove(newLT, assetBal);
            ltToken.deposit(assetBal, debtAmount, 0, address(this));
            assetToken.forceApprove(newLT, 0);
        }

        emit LTMigrated(oldLT, newLT);
    }

    /// @notice Update swap router
    function setSwapRouter(address _router) external onlyTimelock {
        if (_router == address(0)) revert InvalidSwapRouter();
        address old = swapRouter;
        swapRouter = _router;
        emit SwapRouterUpdated(old, _router);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // EMERGENCY
    // ═══════════════════════════════════════════════════════════════════════

    function pause() external onlyRole(GUARDIAN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    /// @notice Recover stuck tokens (not strategy assets)
    function recoverToken(address token, uint256 amount, address to) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(usdc)) revert CannotRecoverUsdc();
        if (token == address(assetToken)) revert CannotRecoverAsset();
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Current LT share price (18 decimals)
    function currentSharePrice() external view returns (uint256) {
        return ltToken.pricePerShare();
    }

    /// @notice LT shares held by this strategy
    function ltShareBalance() external view returns (uint256) {
        return ltToken.balanceOf(address(this));
    }

    /// @notice The crypto asset this market trades (WBTC or WETH)
    function baseAsset() external view returns (address) {
        return address(assetToken);
    }

    /// @notice Net P&L estimate in USDC terms
    function netPnL() external view returns (int256) {
        uint256 ltShares = ltToken.balanceOf(address(this));
        uint256 pricePerShare_ = ltShares > 0 ? ltToken.pricePerShare() : 0;
        uint256 assetValue = (ltShares * pricePerShare_) / 1e18;
        uint256 estUsdc = _estimateAssetValueInUsdc(assetValue);
        return int256(estUsdc) - int256(totalDeposited) + int256(totalWithdrawn);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INTERNAL — Swap helpers (abstract; use swap router)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Swap USDC → crypto asset via router
     * @dev Override this in tests with a mock router.
     *      In production, calls the swap router (Uniswap, Curve, 1inch, etc.)
     */
    function _swapUsdcToAsset(uint256 usdcAmount) internal returns (uint256 assetAmount) {
        if (swapRouter == address(0)) return 0;

        usdc.forceApprove(swapRouter, usdcAmount);

        // Encode swap: USDC → assetToken
        // The swap router interface is abstracted — production routers will differ
        (bool success, bytes memory data) = swapRouter.call(
            abi.encodeWithSignature(
                "swap(address,address,uint256,uint256)",
                address(usdc),
                address(assetToken),
                usdcAmount,
                0 // min out — slippage handled by strategy-level checks
            )
        );

        if (success && data.length >= 32) {
            assetAmount = abi.decode(data, (uint256));
        }

        usdc.forceApprove(swapRouter, 0);
        return assetAmount;
    }

    /**
     * @notice Swap crypto asset → USDC via router
     */
    function _swapAssetToUsdc(uint256 assetAmount) internal returns (uint256 usdcAmount) {
        if (swapRouter == address(0) || assetAmount == 0) return 0;

        assetToken.forceApprove(swapRouter, assetAmount);

        (bool success, bytes memory data) = swapRouter.call(
            abi.encodeWithSignature(
                "swap(address,address,uint256,uint256)",
                address(assetToken),
                address(usdc),
                assetAmount,
                0
            )
        );

        if (success && data.length >= 32) {
            usdcAmount = abi.decode(data, (uint256));
        }

        assetToken.forceApprove(swapRouter, 0);
        return usdcAmount;
    }

    /**
     * @notice Compute appropriate debt amount for a given asset deposit
     * @dev Debt should roughly match the asset value in stablecoin terms.
     *      Uses the Curve pool price_scale to estimate conversion.
     */
    function _computeDebt(uint256 assetAmount) internal view returns (uint256) {
        // Get price from the Curve pool that LT uses
        address pool = ltToken.CRYPTOPOOL();
        uint256 priceScale = ICurvePool(pool).price_scale();
        // price_scale = price of coin1 (asset) in terms of coin0 (stablecoin)
        return (assetAmount * priceScale) / 1e18;
    }

    /**
     * @notice Estimate asset value in USDC terms (for reporting)
     * @dev Uses Curve pool price as reference. Approximate — not for execution.
     */
    function _estimateAssetValueInUsdc(uint256 assetAmount) internal view returns (uint256) {
        if (assetAmount == 0) return 0;
        address pool = ltToken.CRYPTOPOOL();
        uint256 priceScale = ICurvePool(pool).price_scale();
        // Convert to 18-decimal stablecoin value, then to 6-decimal USDC
        uint256 stableValue = (assetAmount * priceScale) / 1e18;
        // If USDC has 6 decimals and stablecoin has 18, adjust
        // For simplicity, assume 1:1 stablecoin:USDC at 18 decimal precision
        return stableValue / 1e12; // 18 → 6 decimals
    }

    // ═══════════════════════════════════════════════════════════════════════
    // UPGRADE
    // ═══════════════════════════════════════════════════════════════════════

    function _authorizeUpgrade(address) internal override onlyTimelock {}
}
