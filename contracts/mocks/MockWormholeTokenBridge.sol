// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockWormholeTokenBridge
 * @notice Mock Wormhole Token Bridge for testing DepositRouter and TreasuryReceiver
 */
contract MockWormholeTokenBridge {
    using SafeERC20 for IERC20;

    IERC20 public usdc;
    uint256 public transferAmount;
    address public transferRecipient;
    uint64 private _sequence;
    
    constructor() {
        // Default constructor for flexible testing
    }
    
    function setUsdc(address _usdc) external {
        usdc = IERC20(_usdc);
    }
    
    function setTransferAmount(uint256 amount) external {
        transferAmount = amount;
    }
    
    function setTransferRecipient(address recipient) external {
        transferRecipient = recipient;
    }
    
    /// @notice Mock transferTokens for DepositRouter testing
    function transferTokens(
        address token,
        uint256 amount,
        uint16,
        bytes32,
        uint256,
        uint32
    ) external payable returns (uint64 sequence) {
        // Pull tokens from caller (simulating bridge lock)
        IERC20(token).transferFrom(msg.sender, address(this), amount);
        _sequence++;
        return _sequence;
    }
    
    /// @notice Mock wrappedAsset for bridge queries
    function wrappedAsset(uint16, bytes32) external view returns (address) {
        return address(usdc);
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
