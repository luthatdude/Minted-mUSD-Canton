// SPDX-License-Identifier: MIT
// BLE Protocol - Fixed Version V2
// Added: CAP_MANAGER_ROLE for BLEBridgeV9 supply cap updates

pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

contract MUSD is ERC20, AccessControl {
    bytes32 public constant BRIDGE_ROLE = keccak256("BRIDGE_ROLE");
    bytes32 public constant COMPLIANCE_ROLE = keccak256("COMPLIANCE_ROLE");
    bytes32 public constant CAP_MANAGER_ROLE = keccak256("CAP_MANAGER_ROLE");

    uint256 public supplyCap;
    mapping(address => bool) public isBlacklisted;

    event SupplyCapUpdated(uint256 oldCap, uint256 newCap);
    event BlacklistUpdated(address indexed account, bool status);
    event Mint(address indexed to, uint256 amount);
    event Burn(address indexed from, uint256 amount);

    constructor(uint256 _initialSupplyCap) ERC20("Minted USD", "mUSD") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        require(_initialSupplyCap > 0, "INVALID_SUPPLY_CAP");
        supplyCap = _initialSupplyCap;
        emit SupplyCapUpdated(0, _initialSupplyCap);
    }

    /// @notice Set supply cap - callable by admin or cap manager (BLEBridgeV9)
    function setSupplyCap(uint256 _cap) external {
        require(
            hasRole(DEFAULT_ADMIN_ROLE, msg.sender) || hasRole(CAP_MANAGER_ROLE, msg.sender),
            "UNAUTHORIZED"
        );
        require(_cap > 0, "INVALID_SUPPLY_CAP");
        uint256 oldCap = supplyCap;
        supplyCap = _cap;
        emit SupplyCapUpdated(oldCap, _cap);
    }

    function setBlacklist(address account, bool status) external onlyRole(COMPLIANCE_ROLE) {
        require(account != address(0), "INVALID_ADDRESS");
        isBlacklisted[account] = status;
        emit BlacklistUpdated(account, status);
    }

    function mint(address to, uint256 amount) external onlyRole(BRIDGE_ROLE) {
        require(totalSupply() + amount <= supplyCap, "EXCEEDS_CAP");
        require(!isBlacklisted[to], "RECEIVER_BLACKLISTED");
        _mint(to, amount);
        emit Mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyRole(BRIDGE_ROLE) {
        require(!isBlacklisted[from], "SENDER_BLACKLISTED");
        if (from != msg.sender) {
            _spendAllowance(from, msg.sender, amount);
        }
        _burn(from, amount);
        emit Burn(from, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!isBlacklisted[from] && !isBlacklisted[to], "COMPLIANCE_REJECT");
        super._update(from, to, value);
    }
}
