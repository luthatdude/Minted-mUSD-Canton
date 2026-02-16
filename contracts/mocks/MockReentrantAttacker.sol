// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title MockReentrantAttacker
/// @notice Simulates reentrancy attacks on protocol entry points
/// @dev Uses receive() and fallback() to re-enter target contracts
///      Tests verify that all nonReentrant-guarded functions properly revert
contract MockReentrantAttacker {
    enum AttackType {
        NONE,
        VAULT_DEPOSIT,
        VAULT_WITHDRAW,
        BORROW,
        REPAY,
        SMUSD_DEPOSIT,
        SMUSD_REDEEM,
        DIRECT_MINT,
        DIRECT_REDEEM,
        LIQUIDATION
    }

    address public target;
    AttackType public attackType;
    address public token;
    uint256 public amount;
    uint256 public attackCount;
    uint256 public maxAttacks;
    bool public attackSucceeded;

    event AttackAttempted(AttackType attackType, uint256 count, bool reverted);

    constructor() {
        maxAttacks = 1; // Try to re-enter once
    }

    function setAttack(
        address _target,
        AttackType _type,
        address _token,
        uint256 _amount
    ) external {
        target = _target;
        attackType = _type;
        token = _token;
        amount = _amount;
        attackCount = 0;
        attackSucceeded = false;
    }

    /// @notice Called when this contract receives ETH -- attempt reentrancy
    receive() external payable {
        _tryReenter();
    }

    /// @notice Fallback -- attempt reentrancy on any unexpected call
    fallback() external payable {
        _tryReenter();
    }

    /// @notice ERC-777 / ERC-1363 callback hook -- attempt reentrancy
    function tokensReceived(
        address, address, address, uint256, bytes calldata, bytes calldata
    ) external {
        _tryReenter();
    }

    /// @notice ERC-1363 onTransferReceived -- attempt reentrancy
    function onTransferReceived(
        address, address, uint256, bytes calldata
    ) external returns (bytes4) {
        _tryReenter();
        return this.onTransferReceived.selector;
    }

    function _tryReenter() internal {
        if (attackCount >= maxAttacks) return;
        attackCount++;

        bool success;
        bytes memory data;

        if (attackType == AttackType.VAULT_DEPOSIT) {
            // Re-enter CollateralVault.deposit
            data = abi.encodeWithSignature("deposit(address,uint256)", token, amount);
        } else if (attackType == AttackType.VAULT_WITHDRAW) {
            // Re-enter via BorrowModule.withdrawCollateral
            data = abi.encodeWithSignature("withdrawCollateral(address,uint256)", token, amount);
        } else if (attackType == AttackType.BORROW) {
            // Re-enter BorrowModule.borrow
            data = abi.encodeWithSignature("borrow(uint256)", amount);
        } else if (attackType == AttackType.REPAY) {
            // Re-enter BorrowModule.repay
            data = abi.encodeWithSignature("repay(uint256)", amount);
        } else if (attackType == AttackType.SMUSD_DEPOSIT) {
            // Re-enter SMUSD.deposit
            data = abi.encodeWithSignature("deposit(uint256,address)", amount, address(this));
        } else if (attackType == AttackType.SMUSD_REDEEM) {
            // Re-enter SMUSD.redeem
            data = abi.encodeWithSignature("redeem(uint256,address,address)", amount, address(this), address(this));
        } else if (attackType == AttackType.DIRECT_MINT) {
            // Re-enter DirectMintV2.mint
            data = abi.encodeWithSignature("mint(uint256)", amount);
        } else if (attackType == AttackType.DIRECT_REDEEM) {
            // Re-enter DirectMintV2.redeem
            data = abi.encodeWithSignature("redeem(uint256)", amount);
        } else if (attackType == AttackType.LIQUIDATION) {
            // Re-enter LiquidationEngine.liquidate
            data = abi.encodeWithSignature("liquidate(address,address,uint256)", address(this), token, amount);
        } else {
            return;
        }

        (success,) = target.call(data);
        attackSucceeded = success;

        emit AttackAttempted(attackType, attackCount, !success);
    }

    /// @notice Allow this contract to receive ERC20 approvals and interact with protocols
    function approve(address _token, address spender, uint256 _amount) external {
        IERC20(_token).approve(spender, _amount);
    }

    /// @notice Execute an initial call to the target to trigger the callback chain
    function executeAttack(bytes calldata data) external returns (bool success, bytes memory result) {
        (success, result) = target.call(data);
    }
}
