// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title MockUniswapV3Pool
/// @notice Minimal Uniswap V3 Pool mock for TWAP oracle testing
contract MockUniswapV3Pool {
    address public token0;
    address public token1;

    int56[] private _tickCumulatives;
    uint160[] private _secondsPerLiquidity;

    constructor(address _token0, address _token1) {
        token0 = _token0;
        token1 = _token1;
        // Default values: tick cumulative = 0 at both points
        _tickCumulatives = new int56[](2);
        _secondsPerLiquidity = new uint160[](2);
    }

    /// @notice Set tick cumulatives for testing
    /// @param tickCum0 Tick cumulative at secondsAgo[0] (older)
    /// @param tickCum1 Tick cumulative at secondsAgo[1] (newer / now)
    function setTickCumulatives(int56 tickCum0, int56 tickCum1) external {
        _tickCumulatives[0] = tickCum0;
        _tickCumulatives[1] = tickCum1;
    }

    function observe(uint32[] calldata) external view returns (
        int56[] memory tickCumulatives,
        uint160[] memory secondsPerLiquidityCumulativeX128s
    ) {
        return (_tickCumulatives, _secondsPerLiquidity);
    }
}

/// @title MockUniswapV3Factory
/// @notice Minimal factory that returns pre-configured pools
contract MockUniswapV3Factory {
    mapping(bytes32 => address) private _pools;

    function setPool(address tokenA, address tokenB, uint24 fee, address pool) external {
        bytes32 key = _key(tokenA, tokenB, fee);
        _pools[key] = pool;
    }

    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address) {
        bytes32 key = _key(tokenA, tokenB, fee);
        address p = _pools[key];
        if (p != address(0)) return p;
        // Try reverse order
        return _pools[_key(tokenB, tokenA, fee)];
    }

    function _key(address a, address b, uint24 fee) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(a, b, fee));
    }
}
