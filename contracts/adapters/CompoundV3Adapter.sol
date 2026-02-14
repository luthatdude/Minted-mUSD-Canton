// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../interfaces/IYieldAdapter.sol";

/**
 * @title CompoundV3Adapter
 * @notice IYieldAdapter for Compound V3 (Comet) markets.
 *         Reads getSupplyRate(getUtilization()) for supply APY.
 */

interface ICometAdapter {
    function getSupplyRate(uint256 utilization) external view returns (uint64);
    function getBorrowRate(uint256 utilization) external view returns (uint64);
    function getUtilization() external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function totalBorrow() external view returns (uint256);
}

contract CompoundV3Adapter is IYieldAdapter {
    uint256 private constant SECONDS_PER_YEAR = 365.25 days;
    uint256 private constant BPS = 10_000;

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
        ICometAdapter comet = ICometAdapter(venue);

        uint256 util = comet.getUtilization();
        uint256 supplyRate = uint256(comet.getSupplyRate(util));

        supplyApyBps = (supplyRate * SECONDS_PER_YEAR * BPS) / 1e18;
        utilizationBps = (util * BPS) / 1e18;

        try comet.getBorrowRate(util) returns (uint64 br) {
            borrowApyBps = (uint256(br) * SECONDS_PER_YEAR * BPS) / 1e18;
        } catch {}

        try comet.totalSupply() returns (uint256 ts) {
            tvlUsd6 = ts;
        } catch {}

        available = true;
    }

    function protocolName() external pure override returns (string memory) {
        return "Compound V3";
    }

    function protocolId() external pure override returns (uint256) {
        return 1; // CompoundV3
    }
}
