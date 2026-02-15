// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import "../interfaces/IYieldBasis.sol";

/**
 * @title MintedLPOracle
 * @notice LP price oracle for Curve crypto pools — Solidity port of CryptopoolLPOracle.vy
 * @dev Computes the price of a Curve Twocrypto LP token in aggregated USD.
 *
 * Formula:
 *   lp_price = 2 * virtual_price * sqrt(price_scale * 1e18) / 1e18
 *   price    = lp_price * agg_price / 1e18
 *
 * Where:
 *   - virtual_price: Curve pool's invariant-based price per LP token
 *   - price_scale:   Internal Curve price of coin 1 in terms of coin 0
 *   - agg_price:     Stablecoin price from aggregator (~1e18 at peg)
 *
 * @author Minted Protocol — ported from Scientia Spectra AG (yb-core)
 */
contract MintedLPOracle is IPriceOracle {
    ICurvePool public immutable POOL;
    IPriceAggregator public immutable override AGG;

    constructor(address _pool, address _agg) {
        require(_pool != address(0), "Zero pool");
        require(_agg != address(0), "Zero agg");
        POOL = ICurvePool(_pool);
        AGG = IPriceAggregator(_agg);
    }

    /// @notice Compute LP token price from Curve pool internals
    /// @dev lp_price = 2 * virtual_price * isqrt(price_scale * 1e18) / 1e18
    function _lpPrice() internal view returns (uint256) {
        uint256 virtualPrice = POOL.virtual_price();
        uint256 pScale = POOL.price_scale();
        // isqrt equivalent: sqrt(pScale * 1e18)
        uint256 sqrtPScale = _sqrt(pScale * 1e18);
        return (2 * virtualPrice * sqrtPScale) / 1e18;
    }

    /// @notice Read-only LP price in aggregated USD (18 decimals)
    function price() external view override returns (uint256) {
        return (_lpPrice() * AGG.price()) / 1e18;
    }

    /// @notice Write variant — calls aggregator's price_w() which may update EMA
    function price_w() external override returns (uint256) {
        return (_lpPrice() * AGG.price_w()) / 1e18;
    }

    // ── Internal Math ─────────────────────────────────────────────────

    /// @notice Integer square root (matching Vyper's isqrt)
    /// @dev Uses Babylonian method. Returns floor(sqrt(x)).
    function _sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = x;
        uint256 y = (z + 1) / 2;
        while (y < z) {
            z = y;
            y = (x / y + y) / 2;
        }
        return z;
    }
}
