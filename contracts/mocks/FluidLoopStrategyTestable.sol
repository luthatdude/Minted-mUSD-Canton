// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../strategies/FluidLoopStrategy.sol";
import "./MockFluidVaults.sol";

/**
 * @title FluidLoopStrategyTestable
 * @notice Test harness that overrides the virtual position-read methods
 *         so they query the mock Fluid vaults directly.
 *
 *         V2: Now also accepts VaultResolver/DexResolver addresses in InitParams
 *         (passed as zero for backward-compatible mock-based tests) and overrides
 *         `_cachedDexState()` for DEX integration tests.
 */
contract FluidLoopStrategyTestable is FluidLoopStrategy {
    /// @notice Passthrough initializer for upgrade safety
    function initializeTestable(InitParams calldata p) external initializer {
        if (p.timelock == address(0)) revert ZeroAddress();
        if (p.inputAsset == address(0)) revert ZeroAddress();
        if (p.fluidVault == address(0)) revert ZeroAddress();
        if (p.mode == 0 || p.mode > 3) revert InvalidVaultMode();
        // Delegate to parent
        // We inline the parent's initialize logic because we can't call
        // another initializer from initializer (reentrancy guard)
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

        // Resolvers (address(0) for backward-compatible mock tests)
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

        if (p.mode == MODE_STABLE) {
            targetLtvBps = 9000;
            targetLoops = 4;
            swapFeeTier = 100;
        } else if (p.mode == MODE_LRT) {
            targetLtvBps = 9200;
            targetLoops = 4;
            swapFeeTier = 100;
        } else {
            targetLtvBps = 9400;
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

    /// @dev Read collateral value from mock vault (overrides production VaultResolver path)
    function _readCollateralFromVault() internal view override returns (uint256) {
        if (positionNftId == 0) return 0;

        // If VaultResolver is set, use the production path
        if (address(vaultResolver) != address(0)) {
            return super._readCollateralFromVault();
        }

        // Fallback: read directly from mock vault
        if (vaultMode == MODE_STABLE) {
            (uint256 col,) = MockFluidVaultT1(fluidVault).getPosition(positionNftId);
            return col;
        } else if (vaultMode == MODE_LRT) {
            (uint256 col0, uint256 col1,) = MockFluidVaultT2(fluidVault).getPosition(positionNftId);
            return col0 + col1; // simplified: sum both tokens
        } else {
            (uint256 col0, uint256 col1,,) = MockFluidVaultT4(fluidVault).getPosition(positionNftId);
            return col0 + col1;
        }
    }

    /// @dev Read debt value from mock vault (overrides production VaultResolver path)
    function _readDebtFromVault() internal view override returns (uint256) {
        if (positionNftId == 0) return 0;

        // If VaultResolver is set, use the production path
        if (address(vaultResolver) != address(0)) {
            return super._readDebtFromVault();
        }

        // Fallback: read directly from mock vault
        if (vaultMode == MODE_STABLE) {
            (, uint256 dbt) = MockFluidVaultT1(fluidVault).getPosition(positionNftId);
            return dbt;
        } else if (vaultMode == MODE_LRT) {
            (,, uint256 dbt) = MockFluidVaultT2(fluidVault).getPosition(positionNftId);
            return dbt;
        } else {
            (,, uint256 dbt0, uint256 dbt1) = MockFluidVaultT4(fluidVault).getPosition(positionNftId);
            return dbt0 + dbt1;
        }
    }

    /// @dev Override _cachedDexState to read from MockFluidDexResolver.
    ///      The mock's getDexState is a view function (reads from mapping),
    ///      but the interface declares it as non-view to match Fluid mainnet.
    ///      We use a low-level staticcall to bypass the view restriction.
    function _cachedDexState() internal view override returns (IFluidDexResolver.DexState memory state) {
        if (address(dexResolver) != address(0) && dexPool != address(0)) {
            // staticcall is safe here because our mock is view-compatible
            (bool success, bytes memory data) = address(dexResolver).staticcall(
                abi.encodeWithSelector(IFluidDexResolver.getDexState.selector, dexPool)
            );
            if (success && data.length > 0) {
                state = abi.decode(data, (IFluidDexResolver.DexState));
                return state;
            }
        }
        // Fallback: 1:1 ratio for tests without DEX resolver
        state.token0PerSupplyShare = 1e18;
        state.token1PerSupplyShare = 0;
        state.token0PerBorrowShare = 1e18;
        state.token1PerBorrowShare = 0;
        return state;
    }
}
