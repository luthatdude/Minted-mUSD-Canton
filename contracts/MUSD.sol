// SPDX-License-Identifier: MIT
// BLE Protocol - Fixed Version V2
// Added: CAP_MANAGER_ROLE for BLEBridgeV9 supply cap updates

pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/// FIX H-3: Add Pausable so transfers can be halted in emergencies
contract MUSD is ERC20, AccessControl, Pausable {
    bytes32 public constant BRIDGE_ROLE = keccak256("BRIDGE_ROLE");
    bytes32 public constant COMPLIANCE_ROLE = keccak256("COMPLIANCE_ROLE");
    bytes32 public constant CAP_MANAGER_ROLE = keccak256("CAP_MANAGER_ROLE");
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");
    /// @dev FIX CRITICAL: LiquidationEngine needs burn permission
    bytes32 public constant LIQUIDATOR_ROLE = keccak256("LIQUIDATOR_ROLE");

    uint256 public supplyCap;
    mapping(address => bool) public isBlacklisted;

    event SupplyCapUpdated(uint256 oldCap, uint256 newCap);
    event BlacklistUpdated(address indexed account, bool status);
    event Mint(address indexed to, uint256 amount);
    event Burn(address indexed from, uint256 amount);
    /// @dev FIX: Event for when cap drops below current supply (undercollateralization response)
    event SupplyCapBelowSupply(uint256 newCap, uint256 currentSupply);

    constructor(uint256 _initialSupplyCap) ERC20("Minted USD", "mUSD") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        require(_initialSupplyCap > 0, "INVALID_SUPPLY_CAP");
        supplyCap = _initialSupplyCap;
        emit SupplyCapUpdated(0, _initialSupplyCap);
    }

    /// @notice Set supply cap - callable by admin or cap manager (BLEBridgeV9)
    /// @dev FIX CRITICAL: Allow cap decreases for undercollateralization response.
    ///      When attestations report lower backing, cap MUST be able to drop.
    ///      If cap < totalSupply, no new mints allowed but existing holders unaffected.
    function setSupplyCap(uint256 _cap) external {
        require(
            hasRole(DEFAULT_ADMIN_ROLE, msg.sender) || hasRole(CAP_MANAGER_ROLE, msg.sender),
            "UNAUTHORIZED"
        );
        require(_cap > 0, "INVALID_SUPPLY_CAP");
        
        uint256 oldCap = supplyCap;
        uint256 currentSupply = totalSupply();
        
        // FIX: Allow cap below current supply (signals undercollateralization)
        // Existing holders keep their tokens, but no new mints until supply drops
        if (_cap < currentSupply) {
            emit SupplyCapBelowSupply(_cap, currentSupply);
        }
        
        supplyCap = _cap;
        emit SupplyCapUpdated(oldCap, _cap);
    }

    function setBlacklist(address account, bool status) external onlyRole(COMPLIANCE_ROLE) {
        require(account != address(0), "INVALID_ADDRESS");
        isBlacklisted[account] = status;
        emit BlacklistUpdated(account, status);
    }

    // Blacklist enforced in _update() override
    function mint(address to, uint256 amount) external onlyRole(BRIDGE_ROLE) {
        require(totalSupply() + amount <= supplyCap, "EXCEEDS_CAP");
        _mint(to, amount);
        emit Mint(to, amount);
    }

    // Blacklist enforced in _update() override
    /// @dev FIX CRITICAL: Allow LIQUIDATOR_ROLE to burn for liquidations
    function burn(address from, uint256 amount) external {
        require(
            hasRole(BRIDGE_ROLE, msg.sender) || hasRole(LIQUIDATOR_ROLE, msg.sender),
            "UNAUTHORIZED_BURN"
        );
        if (from != msg.sender) {
            _spendAllowance(from, msg.sender, amount);
        }
        _burn(from, amount);
        emit Burn(from, amount);
    }

    function _update(address from, address to, uint256 value) internal override whenNotPaused {
        require(!isBlacklisted[from] && !isBlacklisted[to], "COMPLIANCE_REJECT");
        super._update(from, to, value);
    }

    /// FIX H-3: Emergency pause — stops all transfers, mints, and burns
    function pause() external onlyRole(EMERGENCY_ROLE) {
        _pause();
    }

    /// FIX H-3: Unpause requires admin (separation of duties)
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
