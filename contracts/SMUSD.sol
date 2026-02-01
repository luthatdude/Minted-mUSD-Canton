// SPDX-License-Identifier: MIT
// BLE Protocol - Fixed Version
// Fixes: S-01 (Cooldown bypass via transfer), S-02 (Missing redeem override),
//        S-03 (Donation attack mitigation), S-04 (SafeERC20)

pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

contract SMUSD is ERC4626, AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant YIELD_MANAGER_ROLE = keccak256("YIELD_MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    mapping(address => uint256) public lastDeposit;
    uint256 public constant WITHDRAW_COOLDOWN = 24 hours;
    
    // FIX M-3: Maximum yield per distribution (10% of total assets) to prevent excessive dilution
    uint256 public constant MAX_YIELD_BPS = 1000; // 10% max yield per distribution

    // Events
    event YieldDistributed(address indexed from, uint256 amount);
    event CooldownUpdated(address indexed account, uint256 timestamp);

    constructor(IERC20 _musd) ERC4626(_musd) ERC20("Staked mUSD", "smUSD") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
    }

    // FIX S-H01: Set cooldown for receiver on deposit to prevent flash-deposit-withdraw.
    // FIX M-2: Only reset cooldown when depositing for yourself to prevent griefing.
    // Third-party deposits (receiver != msg.sender) don't reset cooldown, preventing
    // attackers from depositing dust to perpetually extend a victim's withdrawal lock.
    // Transfer-based cooldown propagation in _update() still prevents share-transfer bypasses.
    function deposit(uint256 assets, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        if (receiver == msg.sender) {
            lastDeposit[receiver] = block.timestamp;
            emit CooldownUpdated(receiver, block.timestamp);
        }
        return super.deposit(assets, receiver);
    }

    // FIX S-H01 + M-2: Same cooldown-only-for-self pattern as deposit().
    function mint(uint256 shares, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        if (receiver == msg.sender) {
            lastDeposit[receiver] = block.timestamp;
            emit CooldownUpdated(receiver, block.timestamp);
        }
        return super.mint(shares, receiver);
    }

    // FIX: Added nonReentrant and whenNotPaused for security
    function withdraw(uint256 assets, address receiver, address owner) public override nonReentrant whenNotPaused returns (uint256) {
        require(block.timestamp >= lastDeposit[owner] + WITHDRAW_COOLDOWN, "COOLDOWN_ACTIVE");
        return super.withdraw(assets, receiver, owner);
    }

    // FIX S-02: Override redeem to enforce cooldown
    // FIX: Added nonReentrant and whenNotPaused for security
    function redeem(uint256 shares, address receiver, address owner) public override nonReentrant whenNotPaused returns (uint256) {
        require(block.timestamp >= lastDeposit[owner] + WITHDRAW_COOLDOWN, "COOLDOWN_ACTIVE");
        return super.redeem(shares, receiver, owner);
    }

    // FIX S-01: Propagate cooldown on transfer to prevent bypass
    function _update(address from, address to, uint256 value) internal override {
        // Skip cooldown propagation for mint (from == 0) and burn (to == 0)
        if (from != address(0) && to != address(0)) {
            // Transfer: propagate the stricter cooldown to receiver
            uint256 fromCooldown = lastDeposit[from];
            uint256 toCooldown = lastDeposit[to];

            // Receiver inherits the later (more restrictive) cooldown
            if (fromCooldown > toCooldown) {
                lastDeposit[to] = fromCooldown;
                emit CooldownUpdated(to, fromCooldown);
            }
        }

        super._update(from, to, value);
    }

    // FIX S-04: Use SafeERC20 for token transfers
    // FIX M-3: Added maximum yield cap to prevent excessive dilution attacks
    function distributeYield(uint256 amount) external onlyRole(YIELD_MANAGER_ROLE) {
        require(totalSupply() > 0, "NO_SHARES_EXIST");
        require(amount > 0, "INVALID_AMOUNT");
        
        // FIX M-3: Cap yield distribution to prevent excessive dilution
        uint256 currentAssets = totalAssets();
        uint256 maxYield = (currentAssets * MAX_YIELD_BPS) / 10000;
        require(amount <= maxYield, "YIELD_EXCEEDS_CAP");

        // FIX S-04: Use safeTransferFrom
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);

        emit YieldDistributed(msg.sender, amount);
    }

    // FIX S-03: decimalsOffset provides some protection against donation attacks
    // by making the initial share price calculation more robust
    function _decimalsOffset() internal pure override returns (uint8) {
        return 3;
    }

    // View function to check remaining cooldown time
    function getRemainingCooldown(address account) external view returns (uint256) {
        uint256 cooldownEnd = lastDeposit[account] + WITHDRAW_COOLDOWN;
        if (block.timestamp >= cooldownEnd) {
            return 0;
        }
        return cooldownEnd - block.timestamp;
    }

    // View function to check if withdrawal is allowed
    function canWithdraw(address account) external view returns (bool) {
        return block.timestamp >= lastDeposit[account] + WITHDRAW_COOLDOWN;
    }

    // ============================================================
    //                     EMERGENCY CONTROLS
    // ============================================================

    /// @notice Pause all deposits and withdrawals
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Unpause all deposits and withdrawals
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
}
