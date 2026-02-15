// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IUniswapV3.sol";

/**
 * @title MockUniswapV3Pool
 * @notice Simulates a Uniswap V3 pool for testing MintedYBPool
 */
contract MockUniswapV3Pool is IUniswapV3Pool {
    address public override token0;
    address public override token1;
    uint24 public override fee;
    int24 public override tickSpacing;

    int24 public currentTick;
    uint160 public currentSqrtPriceX96;
    uint128 public override liquidity;

    constructor(address _token0, address _token1, uint24 _fee) {
        token0 = _token0;
        token1 = _token1;
        fee = _fee;
        tickSpacing = 60; // Default for 0.3%
        currentTick = 0;
        currentSqrtPriceX96 = 79228162514264337593543950336; // ~1:1
    }

    function slot0()
        external
        view
        override
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        return (currentSqrtPriceX96, currentTick, 0, 1, 1, 0, true);
    }

    function observe(uint32[] calldata)
        external
        pure
        override
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        tickCumulatives = new int56[](2);
        secondsPerLiquidityCumulativeX128s = new uint160[](2);
    }

    // Test helpers
    function setTick(int24 _tick) external {
        currentTick = _tick;
    }

    function setSqrtPriceX96(uint160 _price) external {
        currentSqrtPriceX96 = _price;
    }

    function setLiquidity(uint128 _liquidity) external {
        liquidity = _liquidity;
    }
}

/**
 * @title MockNonfungiblePositionManager
 * @notice Simulates Uniswap V3 NFT Position Manager for testing
 * @dev Tracks positions, accepts token deposits, simulates fee accrual
 */
contract MockNonfungiblePositionManager is INonfungiblePositionManager {
    using SafeERC20 for IERC20;

    struct Position {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 amount0;
        uint256 amount1;
        uint256 feeAmount0;
        uint256 feeAmount1;
        address owner;
    }

    uint256 public nextTokenId = 1;
    mapping(uint256 => Position) public _positions;

    // Simulated fee amounts for harvest testing
    uint256 public pendingFee0;
    uint256 public pendingFee1;

    function mint(MintParams calldata params)
        external
        payable
        override
        returns (uint256 tokenId, uint128 _liquidity, uint256 amount0, uint256 amount1)
    {
        tokenId = nextTokenId++;

        // Pull tokens
        if (params.amount0Desired > 0) {
            IERC20(params.token0).safeTransferFrom(msg.sender, address(this), params.amount0Desired);
        }
        if (params.amount1Desired > 0) {
            IERC20(params.token1).safeTransferFrom(msg.sender, address(this), params.amount1Desired);
        }

        amount0 = params.amount0Desired;
        amount1 = params.amount1Desired;
        _liquidity = uint128(amount0 + amount1); // Simplified liquidity

        _positions[tokenId] = Position({
            token0: params.token0,
            token1: params.token1,
            fee: params.fee,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            liquidity: _liquidity,
            amount0: amount0,
            amount1: amount1,
            feeAmount0: 0,
            feeAmount1: 0,
            owner: params.recipient
        });
    }

    function increaseLiquidity(IncreaseLiquidityParams calldata params)
        external
        payable
        override
        returns (uint128 _liquidity, uint256 amount0, uint256 amount1)
    {
        Position storage pos = _positions[params.tokenId];

        if (params.amount0Desired > 0) {
            IERC20(pos.token0).safeTransferFrom(msg.sender, address(this), params.amount0Desired);
        }
        if (params.amount1Desired > 0) {
            IERC20(pos.token1).safeTransferFrom(msg.sender, address(this), params.amount1Desired);
        }

        amount0 = params.amount0Desired;
        amount1 = params.amount1Desired;
        _liquidity = uint128(amount0 + amount1);

        pos.liquidity += _liquidity;
        pos.amount0 += amount0;
        pos.amount1 += amount1;
    }

    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        payable
        override
        returns (uint256 amount0, uint256 amount1)
    {
        Position storage pos = _positions[params.tokenId];
        require(params.liquidity <= pos.liquidity, "Insufficient liquidity");

        // Proportional withdrawal
        if (pos.liquidity > 0) {
            amount0 = (pos.amount0 * params.liquidity) / pos.liquidity;
            amount1 = (pos.amount1 * params.liquidity) / pos.liquidity;
        }

        pos.liquidity -= params.liquidity;
        pos.amount0 -= amount0;
        pos.amount1 -= amount1;

        // Store for collect
        pos.feeAmount0 += amount0;
        pos.feeAmount1 += amount1;
    }

    function collect(CollectParams calldata params)
        external
        payable
        override
        returns (uint256 amount0, uint256 amount1)
    {
        Position storage pos = _positions[params.tokenId];

        // Return decreased liquidity amounts + any pending fees
        amount0 = pos.feeAmount0 + pendingFee0;
        amount1 = pos.feeAmount1 + pendingFee1;

        // Cap at max
        if (amount0 > uint256(params.amount0Max)) amount0 = uint256(params.amount0Max);
        if (amount1 > uint256(params.amount1Max)) amount1 = uint256(params.amount1Max);

        pos.feeAmount0 = 0;
        pos.feeAmount1 = 0;
        pendingFee0 = 0;
        pendingFee1 = 0;

        // Transfer tokens
        if (amount0 > 0) {
            IERC20(pos.token0).safeTransfer(params.recipient, amount0);
        }
        if (amount1 > 0) {
            IERC20(pos.token1).safeTransfer(params.recipient, amount1);
        }
    }

    function burn(uint256 tokenId) external payable override {
        require(_positions[tokenId].liquidity == 0, "Position has liquidity");
        delete _positions[tokenId];
    }

    function positions(uint256 tokenId)
        external
        view
        override
        returns (
            uint96 nonce,
            address operator,
            address _token0,
            address _token1,
            uint24 _fee,
            int24 _tickLower,
            int24 _tickUpper,
            uint128 _liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        Position storage pos = _positions[tokenId];
        return (
            0,
            address(0),
            pos.token0,
            pos.token1,
            pos.fee,
            pos.tickLower,
            pos.tickUpper,
            pos.liquidity,
            0,
            0,
            uint128(pos.feeAmount0),
            uint128(pos.feeAmount1)
        );
    }

    function ownerOf(uint256 tokenId) external view override returns (address) {
        return _positions[tokenId].owner;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Test Helpers
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Simulate fee accrual on next collect() call
     * @dev Token amounts must be pre-transferred to this contract
     */
    function simulateFees(uint256 fee0, uint256 fee1) external {
        pendingFee0 = fee0;
        pendingFee1 = fee1;
    }
}

/**
 * @title MockSwapRouter
 * @notice Simulates Uniswap V3 Swap Router for testing
 * @dev 1:1 swap rate (simplified) — override with setRate() for more realistic tests
 */
contract MockSwapRouter is ISwapRouter {
    using SafeERC20 for IERC20;

    // Exchange rate: amountOut = amountIn * rateNumerator / rateDenominator
    uint256 public rateNumerator = 1;
    uint256 public rateDenominator = 1;

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        override
        returns (uint256 amountOut)
    {
        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);

        amountOut = (params.amountIn * rateNumerator) / rateDenominator;
        require(amountOut >= params.amountOutMinimum, "Too little received");

        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
    }

    /**
     * @notice Set the swap exchange rate
     * @param _numerator Rate numerator
     * @param _denominator Rate denominator
     */
    function setRate(uint256 _numerator, uint256 _denominator) external {
        rateNumerator = _numerator;
        rateDenominator = _denominator;
    }
}
