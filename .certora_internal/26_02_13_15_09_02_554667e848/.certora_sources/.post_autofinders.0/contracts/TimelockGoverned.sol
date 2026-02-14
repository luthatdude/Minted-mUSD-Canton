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

    function _getTimelockGovernedStorage() private pure returns (TimelockGovernedStorage storage s) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff000d0000, 1037618708493) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff000d0001, 0) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff000d0004, 0) }
        bytes32 slot = TIMELOCK_GOVERNED_STORAGE_SLOT;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000003d,slot)}
        assembly {
            s.slot := slot
        }
    }

    /// @notice Address of the MintedTimelockController that gates admin ops
    function timelock() public view returns (address) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00080000, 1037618708488) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00080001, 0) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00080004, 0) }
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
        TimelockGovernedStorage storage s = _getTimelockGovernedStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001003e,0)}
        emit TimelockUpdated(s.timelock, _timelock);
        s.timelock = _timelock;address certora_local64 = s.timelock;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000040,certora_local64)}
    }

    /**
     * @dev Internal initialiser — called once in the constructor (or
     *      `initialize()` for upgradeable variants).
     */
    function _setTimelock(address _timelock) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff000e0000, 1037618708494) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff000e0001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff000e0005, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff000e6000, _timelock) }
        if (_timelock == address(0)) revert ZeroTimelock();
        TimelockGovernedStorage storage s = _getTimelockGovernedStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001003f,0)}
        s.timelock = _timelock;address certora_local65 = s.timelock;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000041,certora_local65)}
        emit TimelockUpdated(address(0), _timelock);
    }
}
