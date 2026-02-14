// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/**
 * @title TimelockGoverned
 * @notice Base contract for all protocol contracts that delegate admin
 *         operations to a MintedTimelockController.
 *
 * @dev REPLACES the per-contract request/cancel/execute + pending-variable
 *      pattern with a single `onlyTimelock` modifier.  The scheduling delay,
 *      cancellation, overwrite-protection, and event emission are all handled
 *      by the OZ TimelockController — no hand-rolled state needed.
 *
 * STORAGE SAFETY:
 *   Uses ERC-7201 namespaced storage to prevent slot collisions when
 *   inherited by UUPS-upgradeable contracts alongside OZ upgradeable parents.
 *   keccak256(abi.encode(uint256(keccak256("minted.storage.TimelockGoverned")) - 1)) & ~bytes32(uint256(0xff))
 *
 * INTEGRATION PATTERN:
 *   1. Inherit TimelockGoverned
 *   2. Call `_setTimelock(addr)` in the constructor
 *   3. Mark admin setters with `onlyTimelock`
 *   4. Operations are scheduled on the MintedTimelockController,
 *      which calls the setter after the delay expires.
 */
abstract contract TimelockGoverned {
    // ─── ERC-7201 Namespaced Storage ───────────────────────────────────
    /// @custom:storage-location erc7201:minted.storage.TimelockGoverned
    struct TimelockGovernedStorage {
        address timelock;
    }

    // keccak256(abi.encode(uint256(keccak256("minted.storage.TimelockGoverned")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant TIMELOCK_GOVERNED_STORAGE_SLOT =
        0x96ec2584f13cbcbf2926bb7c7d24b036ddd15a8842ae5726c96f4a4a3e97cc00;

    function _getTimelockGovernedStorage() private pure returns (TimelockGovernedStorage storage s) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00000000, 1037618708480) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00000001, 0) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00000004, 0) }
        bytes32 slot = TIMELOCK_GOVERNED_STORAGE_SLOT;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000001,slot)}
        assembly {
            s.slot := slot
        }
    }

    /// @notice Address of the MintedTimelockController that gates admin ops
    function timelock() public view returns (address) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00020000, 1037618708482) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00020001, 0) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00020004, 0) }
        return _getTimelockGovernedStorage().timelock;
    }

    event TimelockUpdated(address indexed oldTimelock, address indexed newTimelock);

    error OnlyTimelock();
    error ZeroTimelock();

    modifier onlyTimelock() {
        if (msg.sender != _getTimelockGovernedStorage().timelock) revert OnlyTimelock();
        _;
    }

    /**
     * @notice Migrate to a new timelock controller.
     * @dev Must be called *through* the current timelock (i.e. scheduled +
     *      executed as a normal timelocked operation).
     */
    function setTimelock(address _timelock) external onlyTimelock {
        if (_timelock == address(0)) revert ZeroTimelock();
        TimelockGovernedStorage storage s = _getTimelockGovernedStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010002,0)}
        emit TimelockUpdated(s.timelock, _timelock);
        s.timelock = _timelock;address certora_local4 = s.timelock;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000004,certora_local4)}
    }

    /**
     * @dev Internal initialiser — called once in the constructor (or
     *      `initialize()` for upgradeable variants).
     */
    function _setTimelock(address _timelock) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00010000, 1037618708481) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00010001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00010005, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00016000, _timelock) }
        if (_timelock == address(0)) revert ZeroTimelock();
        TimelockGovernedStorage storage s = _getTimelockGovernedStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010003,0)}
        s.timelock = _timelock;address certora_local5 = s.timelock;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000005,certora_local5)}
        emit TimelockUpdated(address(0), _timelock);
    }
}
