// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title MockBLEBridge
/// @notice Minimal mock for BLEBridgeV9 bridgeToCanton in yield distribution tests.
///         Records bridge-out calls so tests can verify amounts and recipients.
contract MockBLEBridge {
    struct BridgeOutCall {
        uint256 amount;
        string cantonRecipient;
        address caller;
        uint256 timestamp;
    }

    BridgeOutCall[] public bridgeOutCalls;
    uint256 public totalBridgedOut;

    address public musdToken;

    event BridgeToCantonRequested(
        bytes32 indexed requestId,
        address indexed sender,
        uint256 amount,
        uint256 nonce,
        string cantonRecipient,
        uint256 timestamp
    );

    constructor(address _musdToken) {
        musdToken = _musdToken;
    }

    /// @notice Mock bridgeToCanton — records the call and burns mUSD from sender
    function bridgeToCanton(
        uint256 amount,
        string calldata cantonRecipient
    ) external {
        require(amount > 0, "ZeroAmount");
        require(bytes(cantonRecipient).length > 0, "InvalidRecipient");

        // Burn mUSD from caller (requires BRIDGE_ROLE on MUSD + approval)
        // In mock: we just burn via the MUSD interface
        IMUSD_Mock(musdToken).burn(msg.sender, amount);

        bridgeOutCalls.push(BridgeOutCall({
            amount: amount,
            cantonRecipient: cantonRecipient,
            caller: msg.sender,
            timestamp: block.timestamp
        }));

        totalBridgedOut += amount;

        emit BridgeToCantonRequested(
            keccak256(abi.encodePacked(bridgeOutCalls.length, msg.sender, amount)),
            msg.sender,
            amount,
            bridgeOutCalls.length,
            cantonRecipient,
            block.timestamp
        );
    }

    function bridgeOutCallCount() external view returns (uint256) {
        return bridgeOutCalls.length;
    }

    function getLastBridgeOut() external view returns (
        uint256 amount,
        string memory cantonRecipient,
        address caller
    ) {
        require(bridgeOutCalls.length > 0, "NoBridgeOutCalls");
        BridgeOutCall storage last = bridgeOutCalls[bridgeOutCalls.length - 1];
        return (last.amount, last.cantonRecipient, last.caller);
    }
}

interface IMUSD_Mock {
    function burn(address from, uint256 amount) external;
}
