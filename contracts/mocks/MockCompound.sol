// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MockComet
/// @notice Minimal Compound V3 Comet mock for CompoundV3LoopStrategy testing
contract MockComet {
    using SafeERC20 for IERC20;

    IERC20 public baseToken_;
    mapping(address => uint256) public _balances;         // base supply
    mapping(address => uint256) public _borrowBalances;   // base borrow
    mapping(address => mapping(address => uint128)) public _collateral; // account → asset → amount

    bool public _liquidatable;

    constructor(address _baseToken) {
        baseToken_ = IERC20(_baseToken);
    }

    function baseToken() external view returns (address) { return address(baseToken_); }

    function supply(address asset, uint256 amount) external {
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        if (asset == address(baseToken_)) {
            // If borrower has debt, supply reduces debt first
            if (_borrowBalances[msg.sender] > 0) {
                uint256 repay = amount > _borrowBalances[msg.sender] ? _borrowBalances[msg.sender] : amount;
                _borrowBalances[msg.sender] -= repay;
                amount -= repay;
            }
            _balances[msg.sender] += amount;
        } else {
            _collateral[msg.sender][asset] += uint128(amount);
        }
    }

    function supplyTo(address dst, address asset, uint256 amount) external {
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        if (asset == address(baseToken_)) {
            _balances[dst] += amount;
        } else {
            _collateral[dst][asset] += uint128(amount);
        }
    }

    function withdraw(address asset, uint256 amount) external {
        if (asset == address(baseToken_)) {
            if (_balances[msg.sender] >= amount) {
                _balances[msg.sender] -= amount;
            } else {
                // Excess becomes borrow
                uint256 excess = amount - _balances[msg.sender];
                _balances[msg.sender] = 0;
                _borrowBalances[msg.sender] += excess;
            }
            IERC20(asset).safeTransfer(msg.sender, amount);
        } else {
            require(_collateral[msg.sender][asset] >= uint128(amount), "insufficient collateral");
            _collateral[msg.sender][asset] -= uint128(amount);
            IERC20(asset).safeTransfer(msg.sender, amount);
        }
    }

    function withdrawTo(address to, address asset, uint256 amount) external {
        if (asset == address(baseToken_)) {
            _balances[msg.sender] -= amount;
            IERC20(asset).safeTransfer(to, amount);
        } else {
            _collateral[msg.sender][asset] -= uint128(amount);
            IERC20(asset).safeTransfer(to, amount);
        }
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function borrowBalanceOf(address account) external view returns (uint256) {
        return _borrowBalances[account];
    }

    function collateralBalanceOf(address account, address asset) external view returns (uint128) {
        return _collateral[account][asset];
    }

    function getSupplyRate(uint256) external pure returns (uint64) { return uint64(uint256(0.03e18) / 365 / 86400); }
    function getBorrowRate(uint256) external pure returns (uint64) { return uint64(uint256(0.05e18) / 365 / 86400); }
    function getUtilization() external pure returns (uint256) { return 0.8e18; }

    function isLiquidatable(address) external view returns (bool) { return _liquidatable; }
    function isBorrowCollateralized(address) external pure returns (bool) { return true; }

    function allow(address, bool) external {}

    function setLiquidatable(bool v) external { _liquidatable = v; }

    function setBalance(address account, uint256 bal) external { _balances[account] = bal; }
    function setBorrowBalance(address account, uint256 bal) external { _borrowBalances[account] = bal; }

    // Seed liquidity for flash loan repayments
    function seedLiquidity(uint256 amount) external {
        baseToken_.safeTransferFrom(msg.sender, address(this), amount);
    }

    function baseTokenPriceFeed() external pure returns (address) { return address(0); }
    function getPrice(address) external pure returns (uint256) { return 1e8; }
    function numAssets() external pure returns (uint8) { return 1; }

    struct AssetInfo {
        uint8 offset;
        address asset;
        address priceFeed;
        uint64 scale;
        uint64 borrowCollateralFactor;
        uint64 liquidateCollateralFactor;
        uint64 liquidationFactor;
        uint128 supplyCap;
    }

    function getAssetInfoByAddress(address) external pure returns (AssetInfo memory) {
        return AssetInfo(0, address(0), address(0), 1e6, 0.8e18, 0.85e18, 0.9e18, type(uint128).max);
    }

    function getAssetInfo(uint8) external pure returns (AssetInfo memory) {
        return AssetInfo(0, address(0), address(0), 1e6, 0.8e18, 0.85e18, 0.9e18, type(uint128).max);
    }
}

/// @title MockCometRewards
/// @notice Minimal Compound III Rewards mock
contract MockCometRewards {
    address public compToken;
    uint256 public rewardAmount;

    constructor(address _compToken) {
        compToken = _compToken;
    }

    function setRewardAmount(uint256 amount) external {
        rewardAmount = amount;
    }

    function claim(address, address src, bool) external {
        if (rewardAmount > 0 && compToken != address(0)) {
            IERC20(compToken).transfer(src, rewardAmount);
        }
    }

    function getRewardOwed(address, address) external view returns (address token, uint256 owed) {
        return (compToken, rewardAmount);
    }
}

/// @title MockAaveFlashPool
/// @notice Minimal AAVE flash loan pool mock for CompoundV3LoopStrategy
contract MockAaveFlashPool {
    using SafeERC20 for IERC20;

    IERC20 public asset;
    uint256 public premiumBps = 9; // 0.09%

    constructor(address _asset) {
        asset = IERC20(_asset);
    }

    function flashLoanSimple(
        address receiver,
        address _asset,
        uint256 amount,
        bytes calldata params,
        uint16
    ) external {
        require(_asset == address(asset), "wrong asset");
        uint256 premium = (amount * premiumBps) / 10000;

        // Transfer flash loan to receiver
        asset.safeTransfer(receiver, amount);

        // Callback
        (bool ok, ) = receiver.call(
            abi.encodeWithSignature(
                "executeOperation(address,uint256,uint256,address,bytes)",
                _asset, amount, premium, receiver, params
            )
        );
        require(ok, "flash callback failed");

        // Pull back amount + premium
        asset.safeTransferFrom(receiver, address(this), amount + premium);
    }

    function seedLiquidity(uint256 amount) external {
        asset.safeTransferFrom(msg.sender, address(this), amount);
    }
}
