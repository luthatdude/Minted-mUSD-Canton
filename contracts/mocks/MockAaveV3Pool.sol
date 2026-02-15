// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockAaveV3Pool
 * @notice Mock AAVE V3 Pool for testing AaveV3LoopStrategy
 * @dev Supports: supply, withdraw, borrow, repay, flashLoanSimple, getUserAccountData
 */
contract MockAaveV3Pool {
    using SafeERC20 for IERC20;

    IERC20 public usdc;
    uint256 public constant FLASH_LOAN_PREMIUM_BPS = 5; // 0.05%

    // User balances
    mapping(address => uint256) public supplied;   // aToken balance
    mapping(address => uint256) public borrowed;   // variable debt balance
    uint8 public eModeCategory;

    // Mock data provider values
    uint256 public liquidityRate = 0.05e27;      // 5% supply rate (ray) — profitable for looping
    uint256 public variableBorrowRate = 0.03e27;  // 3% borrow rate (ray)

    constructor(address _usdc) {
        usdc = IERC20(_usdc);
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        supplied[onBehalfOf] += amount;
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        uint256 actual = amount > supplied[msg.sender] ? supplied[msg.sender] : amount;
        supplied[msg.sender] -= actual;
        IERC20(asset).safeTransfer(to, actual);
        return actual;
    }

    function borrow(address asset, uint256 amount, uint256, uint16, address onBehalfOf) external {
        borrowed[onBehalfOf] += amount;
        IERC20(asset).safeTransfer(msg.sender, amount);
    }

    function repay(address asset, uint256 amount, uint256, address onBehalfOf) external returns (uint256) {
        uint256 actual = amount > borrowed[onBehalfOf] ? borrowed[onBehalfOf] : amount;
        IERC20(asset).safeTransferFrom(msg.sender, address(this), actual);
        borrowed[onBehalfOf] -= actual;
        return actual;
    }

    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16
    ) external {
        uint256 premium = (amount * FLASH_LOAN_PREMIUM_BPS) / 10000;

        // Transfer flash loaned amount
        IERC20(asset).safeTransfer(receiverAddress, amount);

        // Call receiver callback
        (bool success,) = receiverAddress.call(
            abi.encodeWithSignature(
                "executeOperation(address,uint256,uint256,address,bytes)",
                asset, amount, premium, msg.sender, params
            )
        );
        require(success, "Flash loan callback failed");

        // Recover amount + premium
        IERC20(asset).safeTransferFrom(receiverAddress, address(this), amount + premium);
    }

    function setUserEMode(uint8 categoryId) external {
        eModeCategory = categoryId;
    }

    function getUserEMode(address) external view returns (uint256) {
        return eModeCategory;
    }

    function getUserAccountData(address user) external view returns (
        uint256 totalCollateralBase,
        uint256 totalDebtBase,
        uint256 availableBorrowsBase,
        uint256 currentLiquidationThreshold,
        uint256 ltv,
        uint256 healthFactor
    ) {
        totalCollateralBase = supplied[user] * 1e2; // USDC has 6 decimals, base uses 8
        totalDebtBase = borrowed[user] * 1e2;
        ltv = 7500;
        currentLiquidationThreshold = 8000;

        if (totalDebtBase > 0) {
            healthFactor = (totalCollateralBase * currentLiquidationThreshold * 1e18) / (totalDebtBase * 10000);
            availableBorrowsBase = totalCollateralBase * ltv / 10000 > totalDebtBase
                ? totalCollateralBase * ltv / 10000 - totalDebtBase : 0;
        } else {
            healthFactor = type(uint256).max;
            availableBorrowsBase = totalCollateralBase * ltv / 10000;
        }
    }

    // Seed liquidity for flash loans
    function seedLiquidity(uint256 amount) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    function setRates(uint256 _supplyRate, uint256 _borrowRate) external {
        liquidityRate = _supplyRate;
        variableBorrowRate = _borrowRate;
    }
}

/**
 * @title MockAToken — tracks aToken balance for users
 */
contract MockAToken {
    IERC20 public immutable underlying;
    MockAaveV3Pool public immutable pool;

    constructor(address _pool, address _underlying) {
        pool = MockAaveV3Pool(_pool);
        underlying = IERC20(_underlying);
    }

    function balanceOf(address account) external view returns (uint256) {
        return pool.supplied(account);
    }

    function scaledBalanceOf(address account) external view returns (uint256) {
        return pool.supplied(account);
    }

    function UNDERLYING_ASSET_ADDRESS() external view returns (address) {
        return address(underlying);
    }
}

/**
 * @title MockVariableDebtToken — tracks variable debt for users
 */
contract MockVariableDebtToken {
    MockAaveV3Pool public immutable pool;

    constructor(address _pool) {
        pool = MockAaveV3Pool(_pool);
    }

    function balanceOf(address account) external view returns (uint256) {
        return pool.borrowed(account);
    }

    function scaledBalanceOf(address account) external view returns (uint256) {
        return pool.borrowed(account);
    }
}

/**
 * @title MockAaveV3DataProvider
 */
contract MockAaveV3DataProvider {
    MockAaveV3Pool public immutable pool;

    constructor(address _pool) {
        pool = MockAaveV3Pool(_pool);
    }

    function getReserveData(address) external view returns (
        uint256 unbacked,
        uint256 accruedToTreasuryScaled,
        uint256 totalAToken,
        uint256 totalStableDebt,
        uint256 totalVariableDebt,
        uint256 liquidityRate,
        uint256 variableBorrowRate,
        uint256 stableBorrowRate,
        uint256 averageStableBorrowRate,
        uint256 liquidityIndex,
        uint256 variableBorrowIndex,
        uint40 lastUpdateTimestamp
    ) {
        liquidityRate = pool.liquidityRate();
        variableBorrowRate = pool.variableBorrowRate();
        lastUpdateTimestamp = uint40(block.timestamp);
    }

    function getReserveConfigurationData(address) external pure returns (
        uint256 decimals,
        uint256 ltv,
        uint256 liquidationThreshold,
        uint256 liquidationBonus,
        uint256 reserveFactor,
        bool usageAsCollateralEnabled,
        bool borrowingEnabled,
        bool stableBorrowRateEnabled,
        bool isActive,
        bool isFrozen
    ) {
        decimals = 6;
        ltv = 7500;
        liquidationThreshold = 8000;
        liquidationBonus = 10500;
        reserveFactor = 1000;
        usageAsCollateralEnabled = true;
        borrowingEnabled = true;
        stableBorrowRateEnabled = false;
        isActive = true;
        isFrozen = false;
    }

    function getUserReserveData(address asset, address user) external view returns (
        uint256 currentATokenBalance,
        uint256 currentStableDebt,
        uint256 currentVariableDebt,
        uint256 principalStableDebt,
        uint256 scaledVariableDebt,
        uint256 stableBorrowRate,
        uint256 liquidityRate,
        uint40 stableRateLastUpdated,
        bool usageAsCollateralEnabled
    ) {
        currentATokenBalance = pool.supplied(user);
        currentVariableDebt = pool.borrowed(user);
        usageAsCollateralEnabled = true;
    }
}

/**
 * @title MockMerklDistributor — mock Merkl reward distributor
 */
contract MockMerklDistributor {
    mapping(address => mapping(address => uint256)) public claimed;

    function claim(
        address[] calldata users,
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes32[][] calldata
    ) external {
        for (uint256 i = 0; i < users.length; i++) {
            claimed[users[i]][tokens[i]] += amounts[i];
            // Mint/transfer tokens to user (mock)
            IERC20(tokens[i]).transfer(users[i], amounts[i]);
        }
    }

    function toggleOperator(address) external {}

    function operators(address, address) external pure returns (uint256) {
        return 1;
    }

    // Fund the distributor for testing
    function fund(address token, uint256 amount) external {
        IERC20(token).transferFrom(msg.sender, address(this), amount);
    }
}

/**
 * @title MockSwapRouterV3 — mock Uniswap V3 router (1:1 swaps for test)
 */
contract MockSwapRouterV3ForLoop {
    using SafeERC20 for IERC20;

    // Simple 1:1 mock swap (works when both tokens have same decimals)
    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut) {
        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
        amountOut = params.amountIn; // 1:1 mock swap
        IERC20(params.tokenOut).safeTransfer(msg.sender, amountOut);
    }

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    // Fund for testing swaps
    function fund(address token, uint256 amount) external {
        IERC20(token).transferFrom(msg.sender, address(this), amount);
    }
}
