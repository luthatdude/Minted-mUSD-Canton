// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../interfaces/IYieldBasis.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockYieldBasisPool
 * @notice Mock YB pool for testing YieldBasisStrategy and YBStakingVault
 * @dev Simulates a lending pool where USDC deposits earn interest.
 *      Interest accrues via setAccruedYield() which inflates lender values.
 */
contract MockYieldBasisPool is IYieldBasisPool {
    using SafeERC20 for IERC20;

    IERC20 public immutable _quoteAsset; // USDC
    address public immutable _baseAsset;  // WBTC or WETH

    // Lender tracking
    mapping(address => uint256) public _lenderShares;
    uint256 public totalShares;
    uint256 public totalDeposited;

    // Simulated yield
    uint256 public accruedYield;

    // Pool state
    bool public _acceptingDeposits = true;
    uint256 public _utilization = 5000; // 50%
    uint256 public _lendingAPY = 0.08e18; // 8%

    constructor(address quoteAsset_, address baseAsset_) {
        _quoteAsset = IERC20(quoteAsset_);
        _baseAsset = baseAsset_;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // IYieldBasisPool Implementation
    // ═══════════════════════════════════════════════════════════════════════

    function depositLend(uint256 amount, uint256 /* minShares */) external override returns (uint256 shares) {
        require(_acceptingDeposits, "Pool closed");
        _quoteAsset.safeTransferFrom(msg.sender, address(this), amount);

        // Share calculation: if first deposit, 1:1. Otherwise, proportional.
        if (totalShares == 0) {
            shares = amount;
        } else {
            shares = (amount * totalShares) / _totalLenderValue();
        }

        _lenderShares[msg.sender] += shares;
        totalShares += shares;
        totalDeposited += amount;

        return shares;
    }

    function withdrawLend(uint256 shares, uint256 /* minAmount */) external override returns (uint256 amount) {
        require(_lenderShares[msg.sender] >= shares, "Insufficient shares");

        amount = (shares * _totalLenderValue()) / totalShares;

        _lenderShares[msg.sender] -= shares;
        totalShares -= shares;

        _quoteAsset.safeTransfer(msg.sender, amount);
        return amount;
    }

    function lenderValue(address account) external view override returns (uint256) {
        if (totalShares == 0) return 0;
        return (_lenderShares[account] * _totalLenderValue()) / totalShares;
    }

    function lenderShares(address account) external view override returns (uint256) {
        return _lenderShares[account];
    }

    function totalLenderAssets() external view override returns (uint256) {
        return _totalLenderValue();
    }

    function lendingAPY() external view override returns (uint256) {
        return _lendingAPY;
    }

    function utilization() external view override returns (uint256) {
        return _utilization;
    }

    function baseAsset() external view override returns (address) {
        return _baseAsset;
    }

    function quoteAsset() external view override returns (address) {
        return address(_quoteAsset);
    }

    function acceptingDeposits() external view override returns (bool) {
        return _acceptingDeposits;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Test Helpers
    // ═══════════════════════════════════════════════════════════════════════

    function _totalLenderValue() internal view returns (uint256) {
        return totalDeposited + accruedYield;
    }

    /// @notice Simulate yield accrual (USDC must be sent to this contract first)
    function setAccruedYield(uint256 _yield) external {
        accruedYield = _yield;
    }

    /// @notice Simulate adding yield by transferring USDC in
    function addYield(uint256 amount) external {
        _quoteAsset.safeTransferFrom(msg.sender, address(this), amount);
        accruedYield += amount;
    }

    function setAcceptingDeposits(bool _accepting) external {
        _acceptingDeposits = _accepting;
    }

    function setUtilization(uint256 _util) external {
        _utilization = _util;
    }

    function setLendingAPY(uint256 _apy) external {
        _lendingAPY = _apy;
    }
}
