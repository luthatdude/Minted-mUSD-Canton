// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IStrategy.sol";

/// @title MockStrategy
/// @notice Test mock for yield strategies. Simulates deposits, withdrawals, and yield accrual.
/// @dev Use simulateYield() to add yield and simulateLoss() to remove value.
contract MockStrategy is IStrategy {
    using SafeERC20 for IERC20;

    IERC20 public immutable _asset;
    address public treasury;
    uint256 public deposited;
    bool public active;
    bool public depositShouldFail;
    bool public withdrawShouldFail;

    constructor(address asset_, address treasury_) {
        _asset = IERC20(asset_);
        treasury = treasury_;
        active = true;
    }

    function deposit(uint256 amount) external override returns (uint256) {
        require(!depositShouldFail, "DEPOSIT_FAILED");
        _asset.safeTransferFrom(msg.sender, address(this), amount);
        deposited += amount;
        return amount;
    }

    function withdraw(uint256 amount) external override returns (uint256) {
        require(!withdrawShouldFail, "WITHDRAW_FAILED");
        uint256 toWithdraw = amount > deposited ? deposited : amount;
        toWithdraw = toWithdraw > _asset.balanceOf(address(this))
            ? _asset.balanceOf(address(this))
            : toWithdraw;
        deposited = deposited > toWithdraw ? deposited - toWithdraw : 0;
        _asset.safeTransfer(msg.sender, toWithdraw);
        return toWithdraw;
    }

    function withdrawAll() external override returns (uint256) {
        require(!withdrawShouldFail, "WITHDRAW_FAILED");
        uint256 balance = _asset.balanceOf(address(this));
        deposited = 0;
        if (balance > 0) {
            _asset.safeTransfer(msg.sender, balance);
        }
        return balance;
    }

    function totalValue() external view override returns (uint256) {
        return _asset.balanceOf(address(this));
    }

    function asset() external view override returns (address) {
        return address(_asset);
    }

    function isActive() external view override returns (bool) {
        return active;
    }

    // ============================================================
    //                    TEST HELPERS
    // ============================================================

    /// @notice Simulate yield by minting extra USDC to this contract
    /// @dev In tests, transfer extra USDC to this contract to simulate yield
    function simulateYield(uint256 amount) external {
        // Caller must transfer USDC to this contract first
        // This just updates accounting
        deposited += amount;
    }

    /// @notice Simulate loss
    function simulateLoss(uint256 amount) external {
        deposited = deposited > amount ? deposited - amount : 0;
        // Note: actual USDC balance needs to be reduced externally
    }

    function setActive(bool _active) external {
        active = _active;
    }

    function setDepositShouldFail(bool _fail) external {
        depositShouldFail = _fail;
    }

    function setWithdrawShouldFail(bool _fail) external {
        withdrawShouldFail = _fail;
    }
}
