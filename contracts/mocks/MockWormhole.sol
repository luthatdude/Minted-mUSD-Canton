// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title MockWormhole
 * @notice Mock Wormhole core contract for testing TreasuryReceiver
 */
contract MockWormhole {
    struct VM {
        uint8 version;
        uint32 timestamp;
        uint32 nonce;
        uint16 emitterChainId;
        bytes32 emitterAddress;
        uint64 sequence;
        uint8 consistencyLevel;
        bytes payload;
        uint32 guardianSetIndex;
        bytes signatures;
        bytes32 hash;
    }
    
    bool public shouldValidate = true;
    string public invalidReason = "";
    
    VM private _mockVM;
    
    function setMockVM(
        uint16 emitterChainId,
        bytes32 emitterAddress,
        bytes memory payload,
        bytes32 hash
    ) external {
        _mockVM = VM({
            version: 1,
            timestamp: uint32(block.timestamp),
            nonce: 0,
            emitterChainId: emitterChainId,
            emitterAddress: emitterAddress,
            sequence: 1,
            consistencyLevel: 1,
            payload: payload,
            guardianSetIndex: 0,
            signatures: "",
            hash: hash
        });
    }
    
    function parseAndVerifyVM(bytes calldata) external view returns (
        VM memory vm,
        bool valid,
        string memory reason
    ) {
        return (_mockVM, shouldValidate, invalidReason);
    }
    
    function setShouldValidate(bool _shouldValidate) external {
        shouldValidate = _shouldValidate;
    }
    
    function setInvalidReason(string memory _reason) external {
        invalidReason = _reason;
        shouldValidate = false;
    }
}
