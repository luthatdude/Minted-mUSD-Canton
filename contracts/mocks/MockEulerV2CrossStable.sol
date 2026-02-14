// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockEulerVaultCrossStable
 * @notice Mock Euler V2 vault for cross-stable loop strategy testing
 * @dev Implements supply (deposit), borrow, repay, redeem, withdraw
 *      The supply vault holds RLUSD collateral, the borrow vault tracks USDC debt
 */
contract MockEulerVaultCrossStable {
    using SafeERC20 for IERC20;

    IERC20 public immutable underlyingAsset;

    // User balances (shares = assets for simplicity)
    mapping(address => uint256) public shares;
    mapping(address => uint256) public debt;

    uint256 public totalShares;
    uint256 public totalDeposited;
    uint256 public mockInterestRate;

    constructor(address _asset) {
        underlyingAsset = IERC20(_asset);
        mockInterestRate = 0.04e18; // 4% default
    }

    function asset() external view returns (address) {
        return address(underlyingAsset);
    }

    function deposit(uint256 assets, address receiver) external returns (uint256) {
        underlyingAsset.safeTransferFrom(msg.sender, address(this), assets);
        shares[receiver] += assets;
        totalShares += assets;
        totalDeposited += assets;
        return assets; // 1:1 share ratio
    }

    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256) {
        uint256 actual = assets > shares[owner] ? shares[owner] : assets;
        shares[owner] -= actual;
        totalShares -= actual;
        underlyingAsset.safeTransfer(receiver, actual);
        return actual;
    }

    function redeem(uint256 _shares, address receiver, address owner) external returns (uint256) {
        uint256 actual = _shares > shares[owner] ? shares[owner] : _shares;
        shares[owner] -= actual;
        totalShares -= actual;
        uint256 assets = actual; // 1:1
        underlyingAsset.safeTransfer(receiver, assets);
        return assets;
    }

    function balanceOf(address account) external view returns (uint256) {
        return shares[account];
    }

    function convertToAssets(uint256 _shares) external pure returns (uint256) {
        return _shares; // 1:1
    }

    function convertToShares(uint256 assets) external pure returns (uint256) {
        return assets; // 1:1
    }

    function totalAssets() external view returns (uint256) {
        return totalDeposited;
    }

    function maxWithdraw(address owner) external view returns (uint256) {
        return shares[owner];
    }

    // ─── Borrowing ───────────────────────────────────────────────────

    function borrow(uint256 assets, address receiver) external returns (uint256) {
        debt[receiver] += assets;
        underlyingAsset.safeTransfer(receiver, assets);
        return assets;
    }

    function repay(uint256 assets, address receiver) external returns (uint256) {
        uint256 actual = assets > debt[receiver] ? debt[receiver] : assets;
        underlyingAsset.safeTransferFrom(msg.sender, address(this), actual);
        debt[receiver] -= actual;
        return actual;
    }

    function debtOf(address account) external view returns (uint256) {
        return debt[account];
    }

    function interestRate() external view returns (uint256) {
        return mockInterestRate;
    }

    function accountLiquidity(address account, bool) external view returns (
        uint256 collateralValue,
        uint256 liabilityValue
    ) {
        collateralValue = shares[account];
        liabilityValue = debt[account];
    }

    // ─── Test helpers ────────────────────────────────────────────────

    function setInterestRate(uint256 rate) external {
        mockInterestRate = rate;
    }

    /// @notice Seed liquidity so borrow() has tokens to lend out
    function seedLiquidity(uint256 amount) external {
        underlyingAsset.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Simulate accrued interest by increasing a user's debt
    function simulateInterest(address account, uint256 extraDebt) external {
        debt[account] += extraDebt;
    }
}

/**
 * @title MockEVCCrossStable
 * @notice Mock Euler V2 EVC (Ethereum Vault Connector)
 */
contract MockEVCCrossStable {
    mapping(address => address[]) public collaterals;
    mapping(address => address[]) public controllers;

    function enableCollateral(address account, address vault) external {
        collaterals[account].push(vault);
    }

    function enableController(address account, address vault) external {
        controllers[account].push(vault);
    }

    function getCollaterals(address account) external view returns (address[] memory) {
        return collaterals[account];
    }

    function getControllers(address account) external view returns (address[] memory) {
        return controllers[account];
    }

    function call(address, address, uint256, bytes calldata) external payable returns (bytes memory) {
        return "";
    }
}

/**
 * @title MockPriceFeedCrossStable
 * @notice Chainlink-style price feed for RLUSD/USD depeg monitoring
 */
contract MockPriceFeedCrossStable {
    int256 public price;
    uint8 public decimals_;
    uint256 public lastUpdate;

    constructor(int256 _price, uint8 _decimals) {
        price = _price;
        decimals_ = _decimals;
        lastUpdate = block.timestamp;
    }

    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        return (1, price, block.timestamp, lastUpdate, 1);
    }

    function decimals() external view returns (uint8) {
        return decimals_;
    }

    function setPrice(int256 _price) external {
        price = _price;
        lastUpdate = block.timestamp;
    }

    function setStalePrice(int256 _price) external {
        price = _price;
        lastUpdate = block.timestamp - 90000; // > 24h stale
    }
}

/**
 * @title MockSwapRouterCrossStable
 * @notice 1:1 mock Uniswap V3 router for stablecoin swaps
 * @dev Handles cross-asset swaps (USDC ↔ RLUSD) at 1:1 for testing
 */
contract MockSwapRouterCrossStable {
    using SafeERC20 for IERC20;

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut) {
        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
        amountOut = params.amountIn; // 1:1 stablecoin swap
        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
    }

    /// @notice Fund the router with tokens for swaps
    function fund(address token, uint256 amount) external {
        IERC20(token).transferFrom(msg.sender, address(this), amount);
    }
}
