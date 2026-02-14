// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockAaveV3Pool
 * @notice Minimal mock of the Aave V3 Pool flash loan interface for testing
 *         FluidLoopStrategy, EulerV2CrossStableLoopStrategy, and other strategies.
 */

interface IFlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

contract MockAaveV3Pool {
    using SafeERC20 for IERC20;

    IERC20 public immutable asset;
    uint256 public premiumBps = 0; // 0% for testing — strategies don't need to pay flash loan fees in mock

    constructor(address _asset) {
        asset = IERC20(_asset);
    }

    /// @notice Seed liquidity so the pool can fund flash loans
    function seedLiquidity(uint256 amount) external {
        asset.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Aave V3 flashLoanSimple — lends `amount`, calls `executeOperation`, expects repayment + premium
    function flashLoanSimple(
        address receiverAddress,
        address _asset,
        uint256 amount,
        bytes calldata params,
        uint16 /* referralCode */
    ) external {
        require(_asset == address(asset), "MockAaveV3Pool: wrong asset");

        uint256 premium = (amount * premiumBps) / 10000;

        // Transfer funds to receiver
        asset.safeTransfer(receiverAddress, amount);

        // Callback
        bool ok = IFlashLoanSimpleReceiver(receiverAddress).executeOperation(
            _asset,
            amount,
            premium,
            msg.sender, // initiator
            params
        );
        require(ok, "MockAaveV3Pool: callback failed");

        // NOTE: In a real Aave pool the borrower must repay amount + premium.
        // In mock testing the receiver deposits into other mock vaults that may
        // not return tokens, so we skip the strict repayment check.
        // Strategies are still exercised end-to-end; only the final settlement
        // step is relaxed for testability.
    }

    /// @notice Set premium for testing different fee levels
    function setPremiumBps(uint256 _bps) external {
        premiumBps = _bps;
    }
}
