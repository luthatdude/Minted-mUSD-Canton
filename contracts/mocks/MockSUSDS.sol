// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MockSUSDS
/// @notice Mock sUSDS ERC-4626-like vault for tests.
///         Holds USDS deposits and issues shares at a configurable rate.
contract MockSUSDS is ERC20 {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdsToken;
    uint256 public sharePrice; // 1e18 = 1:1

    constructor(address _usds) ERC20("Mock Staked USDS", "sUSDS") {
        usdsToken = IERC20(_usds);
        sharePrice = 1e18; // Start at 1:1
    }

    function asset() external view returns (address) {
        return address(usdsToken);
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        usdsToken.safeTransferFrom(msg.sender, address(this), assets);
        shares = convertToShares(assets);
        _mint(receiver, shares);
    }

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        require(balanceOf(owner) >= shares, "Insufficient shares");
        if (msg.sender != owner) {
            // Simplified allowance check for tests
            uint256 allowed = allowance(owner, msg.sender);
            require(allowed >= shares, "Insufficient allowance");
            _approve(owner, msg.sender, allowed - shares);
        }
        assets = convertToAssets(shares);
        _burn(owner, shares);
        usdsToken.safeTransfer(receiver, assets);
    }

    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares) {
        shares = convertToShares(assets);
        require(balanceOf(owner) >= shares, "Insufficient shares");
        if (msg.sender != owner) {
            uint256 allowed = allowance(owner, msg.sender);
            require(allowed >= shares, "Insufficient allowance");
            _approve(owner, msg.sender, allowed - shares);
        }
        _burn(owner, shares);
        usdsToken.safeTransfer(receiver, assets);
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return (shares * sharePrice) / 1e18;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return (assets * 1e18) / sharePrice;
    }

    function totalAssets() external view returns (uint256) {
        return usdsToken.balanceOf(address(this));
    }

    function previewDeposit(uint256 assets) external view returns (uint256) {
        return convertToShares(assets);
    }

    function previewRedeem(uint256 shares) external view returns (uint256) {
        return convertToAssets(shares);
    }

    function maxDeposit(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function maxRedeem(address owner) external view returns (uint256) {
        return balanceOf(owner);
    }

    // Test helper: Simulate yield accrual by changing share price
    function setSharePrice(uint256 _price) external {
        sharePrice = _price;
    }

    // Test helper: Simulate yield by adding USDS to vault
    function simulateYield(uint256 amount) external {
        usdsToken.safeTransferFrom(msg.sender, address(this), amount);
        // Increase share price proportionally
        uint256 currentShares = totalSupply();
        if (currentShares > 0) {
            uint256 currentAssets = usdsToken.balanceOf(address(this));
            sharePrice = (currentAssets * 1e18) / currentShares;
        }
    }
}
