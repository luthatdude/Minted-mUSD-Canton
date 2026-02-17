// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockSMUSD
 * @notice Mock smUSD (staked mUSD) for testing interest distribution and share price.
 * @dev Implements a minimal ERC4626-like vault for mUSD staking.
 *      Share price increases when receiveInterest() is called.
 */
contract MockSMUSD is ERC20 {
    IERC20 public immutable musd;
    uint256 public totalMUSD;

    event InterestReceived(uint256 amount);

    constructor(address _musd) ERC20("Mock Staked mUSD", "msmUSD") {
        musd = IERC20(_musd);
    }

    /// @notice Stake mUSD and receive smUSD shares
    function deposit(uint256 amount, address receiver) external returns (uint256 shares) {
        if (totalSupply() == 0 || totalMUSD == 0) {
            shares = amount;
        } else {
            shares = (amount * totalSupply()) / totalMUSD;
        }
        musd.transferFrom(msg.sender, address(this), amount);
        totalMUSD += amount;
        _mint(receiver, shares);
    }

    /// @notice Unstake smUSD and receive mUSD
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        require(balanceOf(owner) >= shares, "INSUFFICIENT_SHARES");
        if (owner != msg.sender) {
            uint256 allowed = allowance(owner, msg.sender);
            require(allowed >= shares, "INSUFFICIENT_ALLOWANCE");
            _approve(owner, msg.sender, allowed - shares);
        }
        assets = (shares * totalMUSD) / totalSupply();
        _burn(owner, shares);
        totalMUSD -= assets;
        musd.transfer(receiver, assets);
    }

    /// @notice Receive interest — increases share price for all holders
    function receiveInterest(uint256 amount) external {
        musd.transferFrom(msg.sender, address(this), amount);
        totalMUSD += amount;
        emit InterestReceived(amount);
    }

    /// @notice Current share price (18 decimals)
    function sharePrice() external view returns (uint256) {
        if (totalSupply() == 0) return 1e18;
        return (totalMUSD * 1e18) / totalSupply();
    }

    /// @notice Total assets under management
    function totalAssets() external view returns (uint256) {
        return totalMUSD;
    }
}
