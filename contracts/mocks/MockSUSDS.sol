// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockSUSDS
 * @notice Mock sUSDS (Sky Savings USDS) for testing SkySUSDSStrategy.
 * @dev Implements a simple 4626-like deposit/withdraw with configurable exchange rate.
 */
contract MockSUSDS is ERC20 {
    IERC20 public immutable usds;
    uint256 public exchangeRate = 1e18; // 1:1 by default

    constructor(address _usds) ERC20("Mock Savings USDS", "msUSDS") {
        usds = IERC20(_usds);
    }

    /// @notice Set the exchange rate (18 decimals, e.g. 1.05e18 = 5% yield)
    function setExchangeRate(uint256 _rate) external {
        exchangeRate = _rate;
    }

    /// @notice Deposit USDS and receive sUSDS shares
    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        shares = (assets * 1e18) / exchangeRate;
        usds.transferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);
    }

    /// @notice Withdraw USDS by burning sUSDS shares
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        require(balanceOf(owner) >= shares, "INSUFFICIENT_SHARES");
        if (owner != msg.sender) {
            uint256 allowed = allowance(owner, msg.sender);
            require(allowed >= shares, "INSUFFICIENT_ALLOWANCE");
            _approve(owner, msg.sender, allowed - shares);
        }
        assets = (shares * exchangeRate) / 1e18;
        _burn(owner, shares);
        usds.transfer(receiver, assets);
    }

    /// @notice Preview how many shares a deposit would yield
    function previewDeposit(uint256 assets) external view returns (uint256) {
        return (assets * 1e18) / exchangeRate;
    }

    /// @notice Preview how many assets a redemption would yield
    function previewRedeem(uint256 shares) external view returns (uint256) {
        return (shares * exchangeRate) / 1e18;
    }

    /// @notice Total assets held
    function totalAssets() external view returns (uint256) {
        return usds.balanceOf(address(this));
    }
}
