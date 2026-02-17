// SPDX-License-Identifier: BUSL-1.1
// BLE Protocol - mUSD Token V2
// Added: CAP_MANAGER_ROLE for BLEBridgeV9 supply cap updates

pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./GlobalPausable.sol";
import "./Errors.sol";

/// @title MUSD
/// @notice ERC-20 stablecoin with supply cap, compliance, and emergency pause
contract MUSD is ERC20, AccessControl, Pausable, GlobalPausable {
    bytes32 public constant BRIDGE_ROLE = keccak256("BRIDGE_ROLE");
    bytes32 public constant COMPLIANCE_ROLE = keccak256("COMPLIANCE_ROLE");
    bytes32 public constant CAP_MANAGER_ROLE = keccak256("CAP_MANAGER_ROLE");
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");
    /// @dev LiquidationEngine needs burn permission
    bytes32 public constant LIQUIDATOR_ROLE = keccak256("LIQUIDATOR_ROLE");
    /// @notice SOL-H-17: TIMELOCK_ROLE for critical operations (48h governance delay)
    bytes32 public constant TIMELOCK_ROLE = keccak256("TIMELOCK_ROLE");

    uint256 public supplyCap;
    mapping(address => bool) public isBlacklisted;

    /// @notice Cooldown between supply cap increases to prevent rapid chaining
    /// 100M → 120M → 144M → 172.8M could happen in minutes without this
    uint256 public lastCapIncreaseTime;
    uint256 public constant MIN_CAP_INCREASE_INTERVAL = 24 hours;

    /// @notice Conservative local chain cap.
    /// Set to globalCap * localCapBps / 10000 (e.g., 6000 = 60% of global cap on this chain).
    /// This ensures that even if both chains independently mint to their local cap,
    /// combined supply stays within safe bounds: localCapEth + localCapCanton <= globalCap * 1.2
    /// The safety margin accounts for bridge latency in cross-chain supply synchronization.
    uint256 public localCapBps = 6000; // Default: 60% of supplyCap for this chain

    event SupplyCapUpdated(uint256 oldCap, uint256 newCap);
    event LocalCapBpsUpdated(uint256 oldBps, uint256 newBps);
    event BlacklistUpdated(address indexed account, bool status);
    event Mint(address indexed to, uint256 amount);
    event Burn(address indexed from, uint256 amount);
    /// @dev Event for when cap drops below current supply (undercollateralization response)
    event SupplyCapBelowSupply(uint256 newCap, uint256 currentSupply);

    /// @param _initialSupplyCap Initial mUSD supply cap
    /// @param _globalPauseRegistry Address of the GlobalPauseRegistry (address(0) to skip global pause)
    constructor(uint256 _initialSupplyCap, address _globalPauseRegistry) ERC20("Minted USD", "mUSD") GlobalPausable(_globalPauseRegistry) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(TIMELOCK_ROLE, msg.sender);
        _setRoleAdmin(TIMELOCK_ROLE, TIMELOCK_ROLE);
        if (_initialSupplyCap == 0) revert InvalidSupplyCap();
        supplyCap = _initialSupplyCap;
        emit SupplyCapUpdated(0, _initialSupplyCap);
    }

    /// @notice Set supply cap - callable by timelock admin or cap manager (BLEBridgeV9)
    /// @dev SOL-H-18: Admin increases now require TIMELOCK_ROLE (48h delay).
    ///      CAP_MANAGER_ROLE (BLEBridgeV9) can still adjust via attestation logic.
    ///      Decreases are always allowed (emergency undercollateralization response).
    function setSupplyCap(uint256 _cap) external {
        if (!hasRole(TIMELOCK_ROLE, msg.sender) && !hasRole(CAP_MANAGER_ROLE, msg.sender)) revert Unauthorized();
        if (_cap == 0) revert InvalidSupplyCap();
        
        uint256 oldCap = supplyCap;
        uint256 currentSupply = totalSupply();

        // Enforce 24h cooldown between supply cap INCREASES
        // Decreases are always allowed (emergency undercollateralization response)
        if (_cap > oldCap) {
            if (block.timestamp < lastCapIncreaseTime + MIN_CAP_INCREASE_INTERVAL) revert CapIncreaseCooldown();
            lastCapIncreaseTime = block.timestamp;
        }
        
        // Allow cap below current supply (signals undercollateralization)
        // Existing holders keep their tokens, but no new mints until supply drops
        if (_cap < currentSupply) {
            emit SupplyCapBelowSupply(_cap, currentSupply);
        }
        
        supplyCap = _cap;
        emit SupplyCapUpdated(oldCap, _cap);
    }

    /// @notice Set the local chain cap as percentage of global supply cap
    /// @param _bps Basis points (e.g., 6000 = 60%). Both chains should sum to <= 12000 for 20% safety margin.
    /// @dev SOL-M-19: Changed from DEFAULT_ADMIN_ROLE to TIMELOCK_ROLE — cap percentage is a critical parameter
    function setLocalCapBps(uint256 _bps) external onlyRole(TIMELOCK_ROLE) {
        if (_bps < 1000 || _bps > 10000) revert LocalCapOutOfRange();
        emit LocalCapBpsUpdated(localCapBps, _bps);
        localCapBps = _bps;
    }

    function setBlacklist(address account, bool status) external onlyRole(COMPLIANCE_ROLE) {
        if (account == address(0)) revert InvalidAddress();
        isBlacklisted[account] = status;
        emit BlacklistUpdated(account, status);
    }

    // Blacklist enforced in _update() override
    /// @notice Mint mUSD to a specified address
    function mint(address to, uint256 amount) external onlyRole(BRIDGE_ROLE) {
        if (to == address(0)) revert MintToZero();
        // Use conservative local cap to prevent cross-chain over-minting
        uint256 effectiveCap = (supplyCap * localCapBps) / 10000;
        if (totalSupply() + amount > effectiveCap) revert ExceedsLocalCap();
        _mint(to, amount);
        emit Mint(to, amount);
    }

    // Blacklist enforced in _update() override
    /// @notice Burn mUSD (allowed by BRIDGE_ROLE or LIQUIDATOR_ROLE)
    function burn(address from, uint256 amount) external {
        if (!hasRole(BRIDGE_ROLE, msg.sender) && !hasRole(LIQUIDATOR_ROLE, msg.sender)) revert UnauthorizedBurn();
        if (from != msg.sender) {
            _spendAllowance(from, msg.sender, amount);
        }
        _burn(from, amount);
        emit Burn(from, amount);
    }

    /// @dev SOL-H-16: Added whenNotGloballyPaused for protocol-wide emergency stop
    /// @dev SYS-H-01: Liquidation burns are exempt from pause to prevent bad debt
    ///      accumulation during emergencies. Liquidations are the most critical
    ///      operations during a crisis — blocking them causes cascading insolvency.
    function _update(address from, address to, uint256 value) internal override {
        // Burns by LIQUIDATOR_ROLE bypass pause so liquidations always work.
        // A burn is: from != address(0) && to == address(0).
        bool isLiquidationBurn = (to == address(0)) && hasRole(LIQUIDATOR_ROLE, msg.sender);
        if (!isLiquidationBurn) {
            _requireNotPaused();
            // GlobalPausable check
            if (address(globalPauseRegistry) != address(0) && globalPauseRegistry.isGloballyPaused()) {
                revert GloballyPaused();
            }
        }
        if (isBlacklisted[from] || isBlacklisted[to]) revert ComplianceReject();
        super._update(from, to, value);
    }

    /// @notice Emergency pause — stops all transfers, mints, and burns
    function pause() external onlyRole(EMERGENCY_ROLE) {
        _pause();
    }

    /// @notice Unpause requires timelock (separation of duties)
    /// @dev SOL-H-17: Changed from DEFAULT_ADMIN_ROLE to TIMELOCK_ROLE (48h governance delay)
    function unpause() external onlyRole(TIMELOCK_ROLE) {
        _unpause();
    }
}
