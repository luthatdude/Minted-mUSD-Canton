// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../interfaces/IYieldAdapter.sol";

/**
 * @title AaveV3Adapter
 * @notice IYieldAdapter for Aave V3 and forks (Spark).
 *         Reads getReserveData() for supply/borrow rates.
 */

interface IAaveV3PoolAdapter {
    struct ReserveData {
        uint256 configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate;
        uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40  lastUpdateTimestamp;
        uint16  id;
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint128 accruedToTreasury;
        uint128 unbacked;
        uint128 isolationModeTotalDebt;
    }
    function getReserveData(address asset) external view returns (ReserveData memory);
}

interface IERC20Balance {
    function totalSupply() external view returns (uint256);
}

contract AaveV3Adapter is IYieldAdapter {
    uint256 private constant RAY = 1e27;
    uint256 private constant BPS = 10_000;

    address public immutable asset;       // USDC address for reserve queries
    uint256 public immutable protoId;     // 0 = AaveV3, 6 = Spark
    string  public  name;

    constructor(address _asset, uint256 _protoId, string memory _name) {
        asset = _asset;
        protoId = _protoId;
        name = _name;
    }

    function verify(
        address venue,
        bytes32 /* extraData */
    ) external view override returns (
        uint256 supplyApyBps,
        uint256 borrowApyBps,
        uint256 tvlUsd6,
        uint256 utilizationBps,
        bool available
    ) {
        IAaveV3PoolAdapter.ReserveData memory data =
            IAaveV3PoolAdapter(venue).getReserveData(asset);

        supplyApyBps = (uint256(data.currentLiquidityRate) * BPS) / RAY;
        borrowApyBps = (uint256(data.currentVariableBorrowRate) * BPS) / RAY;

        // Read aToken totalSupply as TVL proxy
        if (data.aTokenAddress != address(0)) {
            try IERC20Balance(data.aTokenAddress).totalSupply() returns (uint256 ts) {
                tvlUsd6 = ts;
            } catch {}
        }

        utilizationBps = (supplyApyBps + borrowApyBps) > 0
            ? (borrowApyBps * BPS) / (supplyApyBps + borrowApyBps)
            : 0;
        available = true;
    }

    function protocolName() external view override returns (string memory) {
        return name;
    }

    function protocolId() external view override returns (uint256) {
        return protoId;
    }
}
