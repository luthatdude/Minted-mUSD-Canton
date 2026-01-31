// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockWormholeTokenBridge
 * @notice Mock Wormhole Token Bridge for testing TreasuryReceiver
 */
contract MockWormholeTokenBridge {
    using SafeERC20 for IERC20;

    IERC20 public usdc;
    uint256 public transferAmount;
    address public transferRecipient;
    
    constructor(address _usdc) {
        usdc = IERC20(_usdc);
    }
    
    function setTransferAmount(uint256 amount) external {
        transferAmount = amount;
    }
    
    function setTransferRecipient(address recipient) external {
        transferRecipient = recipient;
    }
    
    function completeTransfer(bytes memory) external {
        // Simulate completing transfer by sending USDC to the caller
        if (transferAmount > 0 && usdc.balanceOf(address(this)) >= transferAmount) {
            usdc.safeTransfer(msg.sender, transferAmount);
        }
    }
    
    function completeTransferAndUnwrapETH(bytes memory) external {
        // Not used in our tests
    }
}
