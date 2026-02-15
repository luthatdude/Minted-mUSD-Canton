// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IYieldBasis.sol";

/**
 * @title MockCurvePool
 * @notice Mock Curve Twocrypto pool for testing YB contracts
 * @dev Simulates a Curve 2-coin crypto pool. The pool IS the LP token (ERC20).
 *      coins(0) = stablecoin, coins(1) = crypto asset
 *
 * Simplified mechanics:
 *   - add_liquidity: mints LP tokens proportional to deposited value
 *   - remove_liquidity: burns LP tokens, returns proportional coins
 *   - remove_liquidity_fixed_out: returns fixed amount of one coin + remainder of other
 *   - price_scale: configurable price of coin1 in terms of coin0
 *   - virtual_price: tracks growth from fees (starts at 1e18)
 */
contract MockCurvePool is ERC20 {
    using SafeERC20 for IERC20;

    IERC20 public coin0; // stablecoin
    IERC20 public coin1; // crypto asset

    uint256 public _priceScale;   // Price of coin1 in coin0 terms (18 decimals)
    uint256 public _virtualPrice; // Virtual price (starts at 1e18)
    uint256 public _bal0;         // Balance of coin0 in pool
    uint256 public _bal1;         // Balance of coin1 in pool

    constructor(
        address _coin0,
        address _coin1,
        uint256 priceScale_
    ) ERC20("Mock Curve LP", "mockCrvLP") {
        coin0 = IERC20(_coin0);
        coin1 = IERC20(_coin1);
        _priceScale = priceScale_;
        _virtualPrice = 1e18;
    }

    // ═══════════════════════════════════════════════════════════════════
    // ICurvePool Interface
    // ═══════════════════════════════════════════════════════════════════

    function coins(uint256 i) external view returns (address) {
        if (i == 0) return address(coin0);
        if (i == 1) return address(coin1);
        revert("Invalid index");
    }

    function balances(uint256 i) external view returns (uint256) {
        if (i == 0) return _bal0;
        if (i == 1) return _bal1;
        revert("Invalid index");
    }

    function price_scale() external view returns (uint256) {
        return _priceScale;
    }

    function virtual_price() external view returns (uint256) {
        return _virtualPrice;
    }

    function lp_price() external view returns (uint256) {
        return _lpPrice();
    }

    function _lpPrice() internal view returns (uint256) {
        // 2 * virtual_price * sqrt(price_scale * 1e18) / 1e18
        uint256 sqrtPS = _sqrt(_priceScale * 1e18);
        return (2 * _virtualPrice * sqrtPS) / 1e18;
    }

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    /**
     * @notice Add liquidity to pool
     * @param amounts [coin0_amount, coin1_amount]
     * @param min_mint_amount Minimum LP tokens to receive
     * @param receiver Address to receive LP tokens
     * @return LP tokens minted
     */
    function add_liquidity(
        uint256[2] calldata amounts,
        uint256 min_mint_amount,
        address receiver,
        bool /* use_eth */
    ) external returns (uint256) {
        if (receiver == address(0)) receiver = msg.sender;

        // Transfer coins in
        if (amounts[0] > 0) {
            coin0.safeTransferFrom(msg.sender, address(this), amounts[0]);
            _bal0 += amounts[0];
        }
        if (amounts[1] > 0) {
            coin1.safeTransferFrom(msg.sender, address(this), amounts[1]);
            _bal1 += amounts[1];
        }

        // Calculate LP tokens: value = amounts[0] + amounts[1] * price_scale
        uint256 value = amounts[0] + (amounts[1] * _priceScale) / 1e18;

        // LP price = 2 * virtual_price * sqrt(price_scale * 1e18) / 1e18
        uint256 lpPrice = _lpPrice();

        // Mint LP tokens: value / lp_price (consistent with oracle pricing)
        uint256 lpTokens;
        if (totalSupply() == 0) {
            lpTokens = lpPrice > 0 ? (value * 1e18) / lpPrice : value;
        } else {
            // Proportional to existing pool
            uint256 totalValue = (_bal0 + (_bal1 * _priceScale) / 1e18) - value;
            if (totalValue > 0) {
                lpTokens = (value * totalSupply()) / totalValue;
            } else {
                lpTokens = lpPrice > 0 ? (value * 1e18) / lpPrice : value;
            }
        }

        require(lpTokens >= min_mint_amount, "Slippage");
        _mint(receiver, lpTokens);
        return lpTokens;
    }

    /**
     * @notice Remove liquidity proportionally
     * @param amount LP tokens to burn
     * @param min_amounts Minimum amounts of each coin
     * @return amounts Amounts of each coin returned
     */
    function remove_liquidity(
        uint256 amount,
        uint256[2] calldata min_amounts
    ) external returns (uint256[2] memory amounts) {
        uint256 supply = totalSupply();
        require(supply > 0, "No supply");

        amounts[0] = (_bal0 * amount) / supply;
        amounts[1] = (_bal1 * amount) / supply;

        require(amounts[0] >= min_amounts[0], "Slippage coin0");
        require(amounts[1] >= min_amounts[1], "Slippage coin1");

        _burn(msg.sender, amount);
        _bal0 -= amounts[0];
        _bal1 -= amounts[1];

        coin0.safeTransfer(msg.sender, amounts[0]);
        coin1.safeTransfer(msg.sender, amounts[1]);
    }

    /**
     * @notice Remove liquidity with fixed output of one coin
     * @param amount LP tokens to burn
     * @param i Index of coin to receive fixed amount
     * @param amount_i Fixed amount of coin i
     * @return Amount of the OTHER coin received
     */
    function remove_liquidity_fixed_out(
        uint256 amount,
        uint256 i,
        uint256 amount_i,
        uint256 /* extra_amount */
    ) external returns (uint256) {
        uint256 supply = totalSupply();
        require(supply > 0, "No supply");

        // Total value this LP represents
        uint256 totalValue0 = (_bal0 * amount) / supply; // coin0 portion
        uint256 totalValue1 = (_bal1 * amount) / supply; // coin1 portion

        _burn(msg.sender, amount);

        uint256 otherAmount;
        if (i == 0) {
            // Fixed coin0 output; remainder as coin1
            require(amount_i <= totalValue0 + (totalValue1 * _priceScale) / 1e18, "Insufficient");
            // Give exactly amount_i of coin0
            uint256 coin0Out = amount_i < totalValue0 ? amount_i : totalValue0;
            // If amount_i > totalValue0, need to convert some coin1
            if (amount_i > totalValue0) {
                uint256 extraNeeded = amount_i - totalValue0;
                uint256 coin1Needed = (extraNeeded * 1e18) / _priceScale;
                coin0Out = amount_i; // We'll have the pool cover it
                otherAmount = totalValue1 - coin1Needed;
            } else {
                // Give back remaining value as coin1
                uint256 excessCoin0 = totalValue0 - amount_i;
                uint256 extraCoin1 = (excessCoin0 * 1e18) / _priceScale;
                otherAmount = totalValue1 + extraCoin1;
            }

            _bal0 -= amount_i;
            _bal1 -= otherAmount;
            coin0.safeTransfer(msg.sender, amount_i);
            coin1.safeTransfer(msg.sender, otherAmount);
        } else {
            // Fixed coin1 output; remainder as coin0
            if (amount_i > totalValue1) {
                uint256 extraNeeded = (amount_i - totalValue1) * _priceScale / 1e18;
                otherAmount = totalValue0 - extraNeeded;
            } else {
                uint256 excessCoin1 = totalValue1 - amount_i;
                uint256 extraCoin0 = (excessCoin1 * _priceScale) / 1e18;
                otherAmount = totalValue0 + extraCoin0;
            }

            _bal1 -= amount_i;
            _bal0 -= otherAmount;
            coin1.safeTransfer(msg.sender, amount_i);
            coin0.safeTransfer(msg.sender, otherAmount);
        }

        return otherAmount;
    }

    /**
     * @notice Preview LP tokens for a deposit
     */
    function calc_token_amount(
        uint256[2] calldata amounts,
        bool /* is_deposit */
    ) external view returns (uint256) {
        uint256 value = amounts[0] + (amounts[1] * _priceScale) / 1e18;
        if (totalSupply() == 0) return value;
        uint256 totalValue = _bal0 + (_bal1 * _priceScale) / 1e18;
        return (value * totalSupply()) / totalValue;
    }

    /**
     * @notice Preview withdrawal with fixed output
     */
    function calc_withdraw_fixed_out(
        uint256 token_amount,
        uint256 i,
        uint256 amount_i
    ) external view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return 0;

        uint256 totalValue0 = (_bal0 * token_amount) / supply;
        uint256 totalValue1 = (_bal1 * token_amount) / supply;

        if (i == 0) {
            if (amount_i > totalValue0) {
                uint256 extraNeeded = amount_i - totalValue0;
                uint256 coin1Needed = (extraNeeded * 1e18) / _priceScale;
                return totalValue1 > coin1Needed ? totalValue1 - coin1Needed : 0;
            } else {
                uint256 excessCoin0 = totalValue0 - amount_i;
                uint256 extraCoin1 = (excessCoin0 * 1e18) / _priceScale;
                return totalValue1 + extraCoin1;
            }
        } else {
            if (amount_i > totalValue1) {
                uint256 extraNeeded = ((amount_i - totalValue1) * _priceScale) / 1e18;
                return totalValue0 > extraNeeded ? totalValue0 - extraNeeded : 0;
            } else {
                uint256 excessCoin1 = totalValue1 - amount_i;
                return totalValue0 + (excessCoin1 * _priceScale) / 1e18;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Test Helpers
    // ═══════════════════════════════════════════════════════════════════

    function setPriceScale(uint256 price) external {
        _priceScale = price;
    }

    function setVirtualPrice(uint256 vp) external {
        _virtualPrice = vp;
    }

    /// @notice Simulate fee accrual by increasing virtual price
    function simulateFees(uint256 feeAmount) external {
        uint256 supply = totalSupply();
        if (supply > 0) {
            _virtualPrice = (_virtualPrice * (supply + feeAmount)) / supply;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Internal
    // ═══════════════════════════════════════════════════════════════════

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

/**
 * @title MockPriceAggregator
 * @notice Mock stablecoin price aggregator for testing
 * @dev Returns configurable price (~1e18 at peg)
 */
contract MockPriceAggregator is IPriceAggregator {
    uint256 public _price;

    constructor(uint256 initialPrice) {
        _price = initialPrice;
    }

    function price() external view override returns (uint256) {
        return _price;
    }

    function price_w() external view override returns (uint256) {
        return _price;
    }

    function setPrice(uint256 newPrice) external {
        _price = newPrice;
    }
}

/**
 * @title MockYBSwapRouter
 * @notice Mock swap router for testing YieldBasisStrategy
 * @dev Simulates USDC ↔ crypto asset swaps at configurable rates
 */
contract MockYBSwapRouter {
    using SafeERC20 for IERC20;

    // exchange rate: amount_out = amount_in * rate / 1e18
    mapping(address => mapping(address => uint256)) public rates;

    function setRate(address from, address to, uint256 rate) external {
        rates[from][to] = rate;
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 /* minOut */
    ) external returns (uint256 amountOut) {
        uint256 rate = rates[tokenIn][tokenOut];
        require(rate > 0, "No rate set");

        amountOut = (amountIn * rate) / 1e18;

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);

        return amountOut;
    }
}
