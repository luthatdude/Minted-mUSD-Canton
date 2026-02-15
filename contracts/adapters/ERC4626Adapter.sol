// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../interfaces/IYieldAdapter.sol";

/**
 * @title ERC4626Adapter
 * @notice IYieldAdapter for ERC4626 vaults (Sky sUSDS, Ethena sUSDe, Yearn V3, etc.).
 *         Reads totalAssets/totalSupply for share price; APY computed off-chain.
 */

interface IERC4626Adapter {
    function totalAssets() external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function asset() external view returns (address);
}

contract ERC4626Adapter is IYieldAdapter {
    uint256 public immutable protoId;
    string  public  name;

    /// @notice Snapshot for share-price-delta APY calculation
    struct SharePriceSnapshot {
        uint256 pricePerShare; // convertToAssets(1e18) at snapshot time
        uint256 timestamp;     // block.timestamp of snapshot
    }

    /// @notice Most recent snapshot per vault, used to compute trailing APY
    mapping(address => SharePriceSnapshot) public snapshots;

    /// @notice Seconds per year for annualization
    uint256 private constant SECONDS_PER_YEAR = 365.25 days;

    constructor(uint256 _protoId, string memory _name) {
        protoId = _protoId;
        name = _name;
    }

    /**
     * @notice Record current share price for APY computation.
     * @dev Call this periodically (e.g., daily via keeper) so that
     *      verify() can compute trailing APY from the delta.
     */
    function takeSnapshot(address vault) external {
        uint256 price = IERC4626Adapter(vault).convertToAssets(1e18);
        snapshots[vault] = SharePriceSnapshot({
            pricePerShare: price,
            timestamp: block.timestamp
        });
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
        IERC4626Adapter vault = IERC4626Adapter(venue);

        uint256 assets = vault.totalAssets();
        uint256 supply = vault.totalSupply();

        tvlUsd6 = assets;
        borrowApyBps = 0;
        utilizationBps = 0;
        available = supply > 0;

        // Compute trailing APY from share price delta
        SharePriceSnapshot memory snap = snapshots[venue];
        if (snap.timestamp > 0 && block.timestamp > snap.timestamp) {
            uint256 currentPrice = vault.convertToAssets(1e18);
            if (currentPrice > snap.pricePerShare) {
                uint256 elapsed = block.timestamp - snap.timestamp;
                // APY = (currentPrice / snapPrice - 1) * (SECONDS_PER_YEAR / elapsed)
                // In bps: ((currentPrice - snapPrice) * 10000 * SECONDS_PER_YEAR) / (snapPrice * elapsed)
                supplyApyBps = ((currentPrice - snap.pricePerShare) * 10000 * SECONDS_PER_YEAR)
                    / (snap.pricePerShare * elapsed);
            }
            // If price decreased or unchanged, supplyApyBps stays 0
        }
        // If no snapshot exists, supplyApyBps = 0 (unverifiable — needs first snapshot)
    }

    function protocolName() external view override returns (string memory) {
        return name;
    }

    function protocolId() external view override returns (uint256) {
        return protoId;
    }
}
