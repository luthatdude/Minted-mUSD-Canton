// SPDX-License-Identifier: BUSL-1.1
// Minted Protocol — Global Pause Registry
// GAP-1: Allows pausing all protocol contracts in a single transaction.
// Previously, each contract (MetaVault, SMUSD, LeverageVault, DirectMintV2, TreasuryV2)
// had to be paused individually, which is insufficient for a protocol-wide emergency.

pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "./interfaces/IGlobalPauseRegistry.sol";
import "./Errors.sol";

/// @title GlobalPauseRegistry
/// @notice Protocol-wide pause switch. All core contracts query this registry
///         in their `whenNotGloballyPaused` modifier before executing state-changing ops.
/// @dev    The GUARDIAN_ROLE can activate the global pause (emergency responders).
///         Only DEFAULT_ADMIN_ROLE can unpause (separation of duties).
///         Contracts retain their local pause for granular control — global pause
///         is an additive layer on top.
contract GlobalPauseRegistry is AccessControl, IGlobalPauseRegistry {
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    /// @notice Whether the entire protocol is paused
    bool private _globallyPaused;

    /// @notice Timestamp of last global pause (for forensics / dashboards)
    uint256 public lastPausedAt;

    /// @notice Timestamp of last unpause
    uint256 public lastUnpausedAt;

    constructor(address admin, address guardian) {
        if (admin == address(0)) revert InvalidAdmin();
        if (guardian == address(0)) revert InvalidAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // QUERY
    // ═══════════════════════════════════════════════════════════════════════

    /// @inheritdoc IGlobalPauseRegistry
    function isGloballyPaused() external view override returns (bool) {
        return _globallyPaused;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ACTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Pause the entire protocol. Callable by GUARDIAN_ROLE (emergency).
    function pauseGlobal() external onlyRole(GUARDIAN_ROLE) {
        if (_globallyPaused) revert AlreadyPaused();
        _globallyPaused = true;
        lastPausedAt = block.timestamp;
        emit GlobalPauseStateChanged(true, msg.sender);
    }

    /// @notice Unpause the entire protocol. Requires DEFAULT_ADMIN_ROLE.
    function unpauseGlobal() external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!_globallyPaused) revert NotPaused();
        _globallyPaused = false;
        lastUnpausedAt = block.timestamp;
        emit GlobalPauseStateChanged(false, msg.sender);
    }
}
