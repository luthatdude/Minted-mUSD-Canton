// SPDX-License-Identifier: BUSL-1.1
// Minted Protocol — Uniswap V3 TWAP Oracle
// GAP-2: Validates swap outputs against on-chain TWAP to detect price manipulation.
// Without TWAP validation, an attacker can manipulate the Uniswap spot price in the same
// block (sandwich attack) and the oracle-based slippage check alone may not catch it.

pragma solidity 0.8.26;

import "./interfaces/ITWAPOracle.sol";
import "./Errors.sol";

/// @notice Minimal Uniswap V3 Pool interface for TWAP observation
interface IUniswapV3Pool {
    function observe(uint32[] calldata secondsAgos) external view returns (
        int56[] memory tickCumulatives,
        uint160[] memory secondsPerLiquidityCumulativeX128s
    );
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// @notice Uniswap V3 Factory interface for pool lookup
interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

/// @title UniswapV3TWAPOracle
/// @notice Computes Uniswap V3 TWAP from on-chain tick accumulators.
///         Used by LeverageVault to validate that swap execution prices
///         are within an acceptable deviation from the TWAP.
/// @dev    Uses `pool.observe()` to compute arithmetic mean tick over a window,
///         then converts to a price quote via tick math.
contract UniswapV3TWAPOracle is ITWAPOracle {
    IUniswapV3Factory public immutable factory;

    /// @notice Maximum allowed deviation from TWAP (in basis points)
    /// @dev    5% = 500 bps. If spot deviates more than this from TWAP,
    ///         the swap is likely being manipulated.
    uint256 public constant MAX_TWAP_DEVIATION_BPS = 500;

    /// @notice Minimum TWAP observation window (prevents ultra-short manipulation)
    uint32 public constant MIN_TWAP_DURATION = 300; // 5 minutes

    constructor(address _factory) {
        if (_factory == address(0)) revert InvalidAddress();
        factory = IUniswapV3Factory(_factory);
    }

    /// @inheritdoc ITWAPOracle
    /// @dev Computes arithmetic mean tick from Uniswap V3 observations,
    ///      then converts to a quote amount. Reverts if pool doesn't exist
    ///      or has insufficient observation history.
    function getTWAPQuote(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint32 twapDuration,
        uint256 amountIn
    ) external view override returns (uint256 expectedOut) {
        if (twapDuration < MIN_TWAP_DURATION) twapDuration = MIN_TWAP_DURATION;

        address pool = factory.getPool(tokenIn, tokenOut, fee);
        if (pool == address(0)) revert InvalidAddress();

        // Query tick accumulators at [twapDuration, 0] seconds ago
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = twapDuration;
        secondsAgos[1] = 0;

        (int56[] memory tickCumulatives, ) = IUniswapV3Pool(pool).observe(secondsAgos);

        // Arithmetic mean tick
        int24 meanTick = int24((tickCumulatives[1] - tickCumulatives[0]) / int56(int32(twapDuration)));

        // Convert tick to price ratio
        // tick → sqrtPriceX96 → price
        // For simplicity we use the tick-to-sqrtPrice approximation:
        //   price = 1.0001^tick
        // Using the standard Uniswap math: price(token1/token0) = 1.0001^tick
        bool isToken0 = IUniswapV3Pool(pool).token0() == tokenIn;

        // Use base 1.0001 exponentiation via the standard method
        // We compute the price ratio using integer math suitable for the range of ticks seen
        // in practice (-887272 to +887272)
        uint256 absTick = meanTick >= 0 ? uint256(int256(meanTick)) : uint256(-int256(meanTick));
        
        // Compute 1.0001^|tick| using the binary decomposition method (from Uniswap V3 TickMath)
        uint256 ratio = absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
        if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
        if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
        if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
        if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
        if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
        if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
        if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
        if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
        if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
        if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
        if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
        if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
        if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
        if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
        if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
        if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
        if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
        if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
        if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;

        if (meanTick > 0) ratio = type(uint256).max / ratio;

        // Convert Q128 ratio → actual output amount
        // ratio = price(token1/token0) in Q128
        if (isToken0) {
            // tokenIn = token0: out = amountIn * ratio / 2^128
            expectedOut = (amountIn * ratio) >> 128;
        } else {
            // tokenIn = token1: out = amountIn * 2^128 / ratio
            expectedOut = (amountIn << 128) / ratio;
        }

        return expectedOut;
    }

    /// @notice Validate that a swap output is within acceptable TWAP deviation
    /// @param tokenIn Input token
    /// @param tokenOut Output token
    /// @param fee Pool fee tier
    /// @param twapDuration TWAP window in seconds
    /// @param amountIn Amount of tokenIn
    /// @param actualOut Actual output received from swap
    /// @return valid True if within acceptable deviation
    /// @return twapExpected The TWAP-based expected output
    function validateSwapOutput(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint32 twapDuration,
        uint256 amountIn,
        uint256 actualOut
    ) external view returns (bool valid, uint256 twapExpected) {
        twapExpected = this.getTWAPQuote(tokenIn, tokenOut, fee, twapDuration, amountIn);
        
        // Allow actualOut to be within MAX_TWAP_DEVIATION_BPS of TWAP
        uint256 minAcceptable = (twapExpected * (10000 - MAX_TWAP_DEVIATION_BPS)) / 10000;
        valid = actualOut >= minAcceptable;
        
        return (valid, twapExpected);
    }
}
