// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../strategies/FluidLoopStrategy.sol";
import "./MockFluidVaults.sol";

/**
 * @title FluidLoopStrategyTestable
 * @notice Test harness that overrides the virtual position-read methods
 *         so they query the mock Fluid vaults directly.
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
    /// @dev Read collateral value from mock vault
    function _readCollateralFromVault() internal view override returns (uint256) {
        if (positionNftId == 0) return 0;

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

    /// @dev Read debt value from mock vault
    function _readDebtFromVault() internal view override returns (uint256) {
        if (positionNftId == 0) return 0;

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
}
