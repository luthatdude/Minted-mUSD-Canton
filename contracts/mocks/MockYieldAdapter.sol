// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../interfaces/IYieldAdapter.sol";

/// @title MockYieldAdapter
/// @notice Mock implementation of IYieldAdapter for testing YieldVerifier
contract MockYieldAdapter is IYieldAdapter {
    uint256 public immutable _protocolId;
    string public _protocolName;
    uint256 public _supplyApyBps;
    uint256 public _borrowApyBps;
    uint256 public _tvlUsd6;
    uint256 public _utilizationBps;
    bool public _available;

    constructor(
        uint256 protocolId_,
        string memory protocolName_,
        uint256 supplyApyBps_,
        uint256 borrowApyBps_,
        uint256 tvlUsd6_,
        uint256 utilizationBps_,
        bool available_
    ) {
        _protocolId = protocolId_;
        _protocolName = protocolName_;
        _supplyApyBps = supplyApyBps_;
        _borrowApyBps = borrowApyBps_;
        _tvlUsd6 = tvlUsd6_;
        _utilizationBps = utilizationBps_;
        _available = available_;
    }

    function verify(
        address,
        bytes32
    ) external view override returns (
        uint256 supplyApyBps,
        uint256 borrowApyBps,
        uint256 tvlUsd6,
        uint256 utilizationBps,
        bool available
    ) {
        return (_supplyApyBps, _borrowApyBps, _tvlUsd6, _utilizationBps, _available);
    }

    function protocolName() external view override returns (string memory) {
        return _protocolName;
    }

    function protocolId() external view override returns (uint256) {
        return _protocolId;
    }
}
