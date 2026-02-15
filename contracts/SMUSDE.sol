// SPDX-License-Identifier: BUSL-1.1
// Minted Protocol — smUSD-E: ETH Pool Staked mUSD (Lending/Borrowing Enabled)
// Security: Blacklist enforcement, ReentrancyGuard, Pausable, role-gated mint/burn

pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./Errors.sol";

/// @title SMUSDE
/// @notice smUSD-E: Staked mUSD from ETH Pool — lending/borrowing enabled variant.
///
///   Unlike smUSD (ERC-4626 yield vault), smUSD-E is:
///     - Freely transferable for use as collateral in lending/borrowing
///     - Mintable/burnable only by the ETH Pool contract
///     - Backed by mUSD staked in the ETH Pool
///     - Represents a claim on ETH-denominated yield with optional time-lock multipliers
///
///   This token can be deposited into CollateralVault as lending collateral.
///   On Canton (no native ETH), mUSD is minted directly into the pool.
contract SMUSDE is ERC20, AccessControl, ReentrancyGuard, Pausable {
    bytes32 public constant POOL_ROLE = keccak256("POOL_ROLE");
    bytes32 public constant COMPLIANCE_ROLE = keccak256("COMPLIANCE_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Compliance blacklist (mirrors MUSD pattern)
    mapping(address => bool) public isBlacklisted;

    event BlacklistUpdated(address indexed account, bool status);
    event Minted(address indexed to, uint256 amount);
    event Burned(address indexed from, uint256 amount);

    constructor() ERC20("Staked mUSD ETH Pool", "smUSD-E") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                     POOL OPERATIONS (ETHPool only)
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Mint smUSD-E shares to a staker
    /// @param to Recipient address
    /// @param amount Number of smUSD-E shares to mint
    function mint(address to, uint256 amount) external onlyRole(POOL_ROLE) {
        if (to == address(0)) revert MintToZero();
        if (amount == 0) revert ZeroAmount();
        _mint(to, amount);
        emit Minted(to, amount);
    }

    /// @notice Burn smUSD-E shares from a staker on unstake
    /// @param from Address to burn from
    /// @param amount Number of smUSD-E shares to burn
    function burn(address from, uint256 amount) external onlyRole(POOL_ROLE) {
        if (amount == 0) revert ZeroAmount();
        if (balanceOf(from) < amount) revert InsufficientBalance();
        _burn(from, amount);
        emit Burned(from, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                     COMPLIANCE
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Set blacklist status for an account
    function setBlacklist(address account, bool status) external onlyRole(COMPLIANCE_ROLE) {
        if (account == address(0)) revert InvalidAddress();
        isBlacklisted[account] = status;
        emit BlacklistUpdated(account, status);
    }

    /// @notice Blacklist enforcement in transfer hook
    /// @dev Mirrors MUSD._update() pattern — blocks all transfers for blacklisted addresses
    function _update(address from, address to, uint256 value) internal override whenNotPaused {
        if (isBlacklisted[from] || isBlacklisted[to]) revert ComplianceReject();
        super._update(from, to, value);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                     EMERGENCY CONTROLS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Pause all transfers, mints, and burns
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Unpause — requires admin for separation of duties
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
