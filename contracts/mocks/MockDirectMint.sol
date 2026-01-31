// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title MockDirectMint
 * @notice Mock DirectMint for testing TreasuryReceiver
 */
contract MockDirectMint {
    IERC20 public usdc;
    IERC20 public musd;
    bool public shouldFail;
    
    constructor(address _usdc, address _musd) {
        usdc = IERC20(_usdc);
        musd = IERC20(_musd);
    }
    
    function mintFor(address recipient, uint256 usdcAmount) external returns (uint256 musdMinted) {
        require(!shouldFail, "MINT_FAILED");
        
        // Pull USDC from caller
        usdc.transferFrom(msg.sender, address(this), usdcAmount);
        
        // Mint mUSD 1:1 (mock doesn't actually mint, just returns amount)
        musdMinted = usdcAmount * 1e12;  // Convert 6 decimals to 18
        
        return musdMinted;
    }
    
    function setShouldFail(bool _shouldFail) external {
        shouldFail = _shouldFail;
    }
}
