// SPDX-License-Identifier: MIT
// BLE Protocol — ERC-4626 Yield Vault with Unified Cross-Chain Share Price
// Security: Cooldown enforcement, donation attack mitigation, SafeERC20, ReentrancyGuard
// Feature: Unified share price across Ethereum and Canton for equal yield distribution

pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./GlobalPausable.sol";
import "./Errors.sol";

/// @dev Typed interface for Treasury calls
interface ITreasury {
    function totalValue() external view returns (uint256);
}

contract SMUSD is ERC4626, AccessControl, ReentrancyGuard, Pausable, GlobalPausable {
    using SafeERC20 for IERC20;

    bytes32 public constant YIELD_MANAGER_ROLE = keccak256("YIELD_MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant BRIDGE_ROLE = keccak256("BRIDGE_ROLE");
    bytes32 public constant INTEREST_ROUTER_ROLE = keccak256("INTEREST_ROUTER_ROLE");
    /// @notice SOL-H-17: TIMELOCK_ROLE for unpause (48h governance delay)
    bytes32 public constant TIMELOCK_ROLE = keccak256("TIMELOCK_ROLE");

    mapping(address => uint256) public lastDeposit;
    uint256 public constant WITHDRAW_COOLDOWN = 24 hours;
    
    // Maximum yield per distribution (10% of total assets) to prevent excessive dilution
    uint256 public constant MAX_YIELD_BPS = 1000; // 10% max yield per distribution

    // ═══════════════════════════════════════════════════════════════════════
    // UNIFIED CROSS-CHAIN YIELD: Canton shares tracking
    // ═══════════════════════════════════════════════════════════════════════
    
    /// @notice Total smUSD shares on Canton (synced via bridge attestation)
    uint256 public cantonTotalShares;
    
    /// @notice Last sync epoch from Canton
    uint256 public lastCantonSyncEpoch;
    
    /// @notice Treasury contract for global asset value
    address public treasury;

    // ═══════════════════════════════════════════════════════════════════════
    // Rate limiting for Canton share sync to prevent manipulation
    // ═══════════════════════════════════════════════════════════════════════
    
    /// @notice Last Canton sync timestamp
    uint256 public lastCantonSyncTime;
    
    /// @notice Minimum interval between syncs (1 hour)
    uint256 public constant MIN_SYNC_INTERVAL = 1 hours;
    
    /// @notice Maximum share change per sync (5% = 500 bps)
    uint256 public constant MAX_SHARE_CHANGE_BPS = 500;

    // ═══════════════════════════════════════════════════════════════════════
    // SOL-H-2: Cached treasury value (circuit breaker on Treasury failure)
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Last successfully read treasury value (USDC 6 decimals)
    uint256 public lastKnownTreasuryValue;

    /// @notice Timestamp of last successful treasury read
    uint256 public lastTreasuryRefreshTime;

    /// @notice Maximum staleness before we revert instead of using cache
    uint256 public constant MAX_TREASURY_STALENESS = 6 hours;

    // ═══════════════════════════════════════════════════════════════════════
    // SOL-H-3: Rolling 24h cumulative cap for Canton share changes
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Canton shares at the start of the current 24h window
    uint256 public cantonSharesAtWindowStart;

    /// @notice Timestamp when the current 24h window started
    uint256 public windowStartTime;

    /// @notice Maximum cumulative change in a 24h window (15% = 1500 bps)
    uint256 public constant MAX_DAILY_CHANGE_BPS = 1500;

    /// @notice Maximum ratio of Canton shares to ETH shares
    uint256 public constant MAX_CANTON_RATIO = 5;

    // ═══════════════════════════════════════════════════════════════════════
    // SOL-M-9: Yield vesting to prevent sandwich attacks
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Unvested yield still being dripped
    uint256 public unvestedYield;

    /// @notice Timestamp when current yield finishes vesting
    uint256 public yieldVestingEnd;

    /// @notice Last time vested yield was checkpointed
    uint256 public lastVestingCheckpoint;

    /// @notice Duration over which yield is linearly vested
    uint256 public constant VESTING_DURATION = 12 hours;

    // ═══════════════════════════════════════════════════════════════════════
    // INTEREST ROUTING: Track interest from BorrowModule
    // ═══════════════════════════════════════════════════════════════════════
    
    /// @notice Total interest received from borrowers
    uint256 public totalInterestReceived;
    
    /// @notice Last interest receipt timestamp
    uint256 public lastInterestReceiptTime;

    // ═══════════════════════════════════════════════════════════════════════
    // CRIT-01 FIX: Track yield extracted from Treasury for cross-chain distribution
    // When YieldDistributor withdraws USDC from Treasury, totalValue() drops.
    // This offset ensures globalTotalAssets() stays accurate during distribution.
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice USDC value (6 dec) withdrawn from Treasury for yield distribution
    ///         that hasn't yet been reflected back in Treasury strategies.
    ///         Decremented as yield vests in SMUSD or is confirmed bridged to Canton.
    uint256 public distributedYieldOffset;

    // Events
    event YieldDistributed(address indexed from, uint256 amount);
    event CooldownUpdated(address indexed account, uint256 timestamp);
    event CantonSharesSynced(uint256 cantonShares, uint256 epoch, uint256 globalSharePrice);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event InterestReceived(address indexed from, uint256 amount, uint256 totalReceived);
    event DistributedYieldOffsetUpdated(uint256 oldOffset, uint256 newOffset);
    /// @dev SOL-H-2: Emitted when treasury value is successfully cached
    event TreasuryCacheRefreshed(uint256 cachedValue, uint256 timestamp);
    /// @dev SOL-H-2: Emitted when treasury call fails and cache is used
    event TreasuryCacheFallback(uint256 cachedValue, uint256 cacheAge);
    /// @dev SOL-M-9: Emitted when yield vesting starts
    event YieldVestingStarted(uint256 amount, uint256 vestingEnd);

    /// @param _musd The mUSD token (underlying asset)
    /// @param _globalPauseRegistry Address of the GlobalPauseRegistry (address(0) to skip global pause)
    constructor(IERC20 _musd, address _globalPauseRegistry) ERC4626(_musd) ERC20("Staked mUSD", "smUSD") GlobalPausable(_globalPauseRegistry) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
        _grantRole(TIMELOCK_ROLE, msg.sender);
        _setRoleAdmin(TIMELOCK_ROLE, TIMELOCK_ROLE);
    }

    // Always set cooldown for receiver to prevent bypass via third-party deposit.
    // A depositor can always set their own cooldown, and depositing on behalf of someone
    // correctly locks the receiver's withdrawal window.
    function deposit(uint256 assets, address receiver) public override nonReentrant whenNotPaused whenNotGloballyPaused returns (uint256) {
        lastDeposit[receiver] = block.timestamp;
        emit CooldownUpdated(receiver, block.timestamp);
        return super.deposit(assets, receiver);
    }

    // Always set cooldown for receiver to prevent bypass via third-party mint.
    // Matches deposit() behavior — any path that increases shares must reset cooldown.
    function mint(uint256 shares, address receiver) public override nonReentrant whenNotPaused whenNotGloballyPaused returns (uint256) {
        lastDeposit[receiver] = block.timestamp;
        emit CooldownUpdated(receiver, block.timestamp);
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner) public override nonReentrant whenNotPaused whenNotGloballyPaused returns (uint256) {
        if (block.timestamp < lastDeposit[owner] + WITHDRAW_COOLDOWN) revert CooldownActive();
        return super.withdraw(assets, receiver, owner);
    }

    // Override redeem to enforce cooldown
    function redeem(uint256 shares, address receiver, address owner) public override nonReentrant whenNotPaused whenNotGloballyPaused returns (uint256) {
        if (block.timestamp < lastDeposit[owner] + WITHDRAW_COOLDOWN) revert CooldownActive();
        return super.redeem(shares, receiver, owner);
    }

    // Propagate cooldown on transfer to prevent bypass
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

    // Use SafeERC20 for token transfers with maximum yield cap to prevent excessive dilution
    // SOL-M-9: Yield is vested linearly over VESTING_DURATION to prevent sandwich attacks
    function distributeYield(uint256 amount) external onlyRole(YIELD_MANAGER_ROLE) {
        if (totalSupply() == 0) revert NoSharesExist();
        if (amount == 0) revert InvalidAmount();
        
        // Use globalTotalAssets() for cap (serves both ETH + Canton shareholders)
        uint256 currentAssets = globalTotalAssets();
        uint256 maxYield = (currentAssets * MAX_YIELD_BPS) / 10000;
        if (amount > maxYield) revert YieldExceedsCap();

        // Use safeTransferFrom
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);

        // SOL-M-9: Checkpoint existing vesting, then add new yield to vesting schedule
        _checkpointVesting();
        unvestedYield += amount;
        yieldVestingEnd = block.timestamp + VESTING_DURATION;
        lastVestingCheckpoint = block.timestamp;

        emit YieldDistributed(msg.sender, amount);
        emit YieldVestingStarted(amount, yieldVestingEnd);
    }

    /// @notice Receive interest payments from BorrowModule
    /// @dev Called by BorrowModule to route borrower interest to suppliers
    /// SOL-M-9: Interest is vested linearly over VESTING_DURATION to prevent sandwich attacks
    /// @param amount The amount of mUSD interest to receive
    function receiveInterest(uint256 amount) external onlyRole(INTEREST_ROUTER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        if (globalTotalShares() == 0) revert NoSharesExist();
        
        // Use globalTotalAssets() for the cap, not local totalAssets().
        // The vault serves both Ethereum and Canton shareholders, so the cap
        // should reflect the total asset base.
        uint256 currentAssets = globalTotalAssets();
        uint256 maxInterest = (currentAssets * MAX_YIELD_BPS) / 10000;
        if (amount > maxInterest) revert InterestExceedsCap();

        // Transfer mUSD from BorrowModule (which approved us)
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
        
        // SOL-M-9: Checkpoint existing vesting, then add to vesting schedule
        _checkpointVesting();
        unvestedYield += amount;
        yieldVestingEnd = block.timestamp + VESTING_DURATION;
        lastVestingCheckpoint = block.timestamp;
        
        // Track for analytics
        totalInterestReceived += amount;
        lastInterestReceiptTime = block.timestamp;

        emit InterestReceived(msg.sender, amount, totalInterestReceived);
        emit YieldVestingStarted(amount, yieldVestingEnd);
    }

    // decimalsOffset provides some protection against donation attacks
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

    // ═══════════════════════════════════════════════════════════════════════
    // UNIFIED CROSS-CHAIN YIELD: Global share price calculation
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Set the treasury address for global asset calculation
    /// @dev SOL-H-01: Changed from DEFAULT_ADMIN_ROLE to TIMELOCK_ROLE — critical parameter
    function setTreasury(address _treasury) external onlyRole(TIMELOCK_ROLE) {
        if (_treasury == address(0)) revert ZeroAddress();
        address oldTreasury = treasury;
        treasury = _treasury;
        emit TreasuryUpdated(oldTreasury, _treasury);
    }

    /// @notice Sync Canton shares from bridge attestation
    /// @dev Rate-limited to prevent share price manipulation
    /// SOL-H-3: Rolling 24h cumulative cap prevents compounding 5% changes
    /// SOL-H-4: First sync requires ethShares > 0 to prevent inflation at zero supply
    /// @param _cantonShares Total smUSD shares on Canton
    /// @param epoch Sync epoch (must be sequential)
    function syncCantonShares(uint256 _cantonShares, uint256 epoch) external onlyRole(BRIDGE_ROLE) {
        if (epoch <= lastCantonSyncEpoch) revert EpochNotSequential();
        
        // Rate limit — minimum 1 hour between syncs
        if (block.timestamp < lastCantonSyncTime + MIN_SYNC_INTERVAL) revert SyncTooFrequent();
        
        // SOL-H-4: First sync requires existing Ethereum deposits
        if (cantonTotalShares == 0) {
            uint256 ethShares = totalSupply();
            // Require Ethereum deposits before Canton sync to prevent inflation attack
            if (ethShares == 0) revert NoSharesExist();
            uint256 maxInitialShares = ethShares * 2;
            if (_cantonShares > maxInitialShares) revert InitialSharesTooLarge();
            // Initialize rolling window
            cantonSharesAtWindowStart = _cantonShares;
            windowStartTime = block.timestamp;
        } else {
            // Per-sync magnitude limit — max 5% change per sync
            uint256 maxIncrease = (cantonTotalShares * (10000 + MAX_SHARE_CHANGE_BPS)) / 10000;
            uint256 maxDecrease = (cantonTotalShares * (10000 - MAX_SHARE_CHANGE_BPS)) / 10000;
            if (_cantonShares > maxIncrease) revert ShareIncreaseTooLarge();
            if (_cantonShares < maxDecrease) revert ShareDecreaseTooLarge();

            // SOL-H-3: Rolling 24h cumulative cap
            if (block.timestamp >= windowStartTime + 24 hours) {
                // Start new window
                cantonSharesAtWindowStart = cantonTotalShares;
                windowStartTime = block.timestamp;
            }
            // Check cumulative change within window stays within MAX_DAILY_CHANGE_BPS
            uint256 windowBase = cantonSharesAtWindowStart;
            if (windowBase > 0) {
                uint256 maxCumulative = (windowBase * (10000 + MAX_DAILY_CHANGE_BPS)) / 10000;
                uint256 minCumulative = (windowBase * (10000 - MAX_DAILY_CHANGE_BPS)) / 10000;
                if (_cantonShares > maxCumulative) revert DailyShareChangeExceeded();
                if (_cantonShares < minCumulative) revert DailyShareChangeExceeded();
            }

            // SOL-H-3: Absolute ratio cap — Canton shares cannot exceed MAX_CANTON_RATIO * ETH shares
            uint256 ethShares = totalSupply();
            if (ethShares > 0 && _cantonShares > ethShares * MAX_CANTON_RATIO) {
                revert ShareIncreaseTooLarge();
            }
        }
        
        cantonTotalShares = _cantonShares;
        lastCantonSyncEpoch = epoch;
        lastCantonSyncTime = block.timestamp;
        
        emit CantonSharesSynced(_cantonShares, epoch, globalSharePrice());
    }

    /// @notice Get global total shares across both chains
    function globalTotalShares() public view returns (uint256) {
        return totalSupply() + cantonTotalShares;
    }

    /// @notice Get global total assets from Treasury
    /// @dev SOL-H-2: On Treasury failure, uses cached last-known-good value (max 6h stale).
    ///      Reverts if cache is too stale instead of silently falling back to local totalAssets().
    ///      Treasury.totalValue() returns USDC (6 decimals) but
    ///      this vault's asset is mUSD (18 decimals). Must scale by 1e12.
    ///      Uses typed interface call for better error propagation and compile-time safety.
    /// @notice CRIT-01 FIX: globalTotalAssets includes distributedYieldOffset
    ///         so share price doesn't drop when yield is withdrawn from Treasury
    ///         for proportional distribution to ETH and Canton pools.
    function globalTotalAssets() public view returns (uint256) {
        if (treasury == address(0)) {
            return totalAssets();
        }
        // Treasury.totalValue() returns total USDC backing all mUSD (6 decimals)
        // slither-disable-next-line calls-loop
        try ITreasury(treasury).totalValue() returns (uint256 usdcValue) {
            // CRIT-01: Add back yield that was withdrawn from Treasury for distribution
            // but hasn't been reflected yet (vesting in SMUSD or bridged to Canton)
            uint256 effectiveUsdc = usdcValue + distributedYieldOffset;
            // Convert USDC (6 decimals) to mUSD (18 decimals)
            return effectiveUsdc * 1e12;
        } catch {
            // SOL-H-2: Use cached treasury value instead of silently falling back to local
            if (lastKnownTreasuryValue > 0 && block.timestamp <= lastTreasuryRefreshTime + MAX_TREASURY_STALENESS) {
                uint256 effectiveCached = lastKnownTreasuryValue + distributedYieldOffset;
                return effectiveCached * 1e12;
            }
            // If cache is too stale or never set, revert to prevent incorrect accounting
            revert NoTreasury();
        }
    }

    /// @notice Refresh the cached treasury value
    /// @dev SOL-H-2: Non-view function to update cache. Should be called periodically by keeper.
    function refreshTreasuryCache() external {
        if (treasury == address(0)) revert NoTreasury();
        // slither-disable-next-line calls-loop
        uint256 usdcValue = ITreasury(treasury).totalValue();
        lastKnownTreasuryValue = usdcValue;
        lastTreasuryRefreshTime = block.timestamp;
        emit TreasuryCacheRefreshed(usdcValue, block.timestamp);
    }

    /// @notice CRIT-01 FIX: Update the distributed yield offset
    /// @dev Safety valve for any residual Treasury.totalValue() discrepancy
    ///      during yield distribution. With the DirectMint swap path, USDC
    ///      round-trips back to Treasury so the net change is only the mint fee.
    ///      This offset is typically 0 or near-zero when DirectMint.mintFeeBps = 0.
    ///      Retained for edge cases (e.g., partial failures, manual adjustments).
    /// @param _offset USDC amount (6 decimals) to add to globalTotalAssets
    function setDistributedYieldOffset(uint256 _offset) external onlyRole(YIELD_MANAGER_ROLE) {
        uint256 oldOffset = distributedYieldOffset;
        distributedYieldOffset = _offset;
        emit DistributedYieldOffsetUpdated(oldOffset, _offset);
    }

    /// @notice Global share price used for both chains
    /// @dev sharePrice = globalTotalAssets / globalTotalShares
    /// @return Share price in asset decimals (6 for USDC)
    function globalSharePrice() public view returns (uint256) {
        uint256 shares = globalTotalShares();
        if (shares == 0) {
            return 10 ** _decimalsOffset(); // 1.0 with offset
        }
        return (globalTotalAssets() * (10 ** _decimalsOffset())) / shares;
    }

    /// @notice Ethereum-only shares (for cross-chain sync)
    function ethereumTotalShares() external view returns (uint256) {
        return totalSupply();
    }

    /// @notice ERC-4626 conversion uses local vault accounting.
    /// @dev Safety: redemptions are paid from local vault liquidity, so preview
    ///      and execution must be based on local totalAssets/totalSupply.
    function convertToShares(uint256 assets) public view override returns (uint256) {
        return super.convertToShares(assets);
    }

    /// @notice ERC-4626 conversion uses local vault accounting.
    /// @dev Safety: previewed asset value must be redeemable from this vault.
    function convertToAssets(uint256 shares) public view override returns (uint256) {
        return super.convertToAssets(shares);
    }

    /// @notice Internal ERC-4626 conversion is intentionally local.
    /// @dev Do not use global Treasury TVL for execution-path conversions.
    function _convertToShares(uint256 assets, Math.Rounding rounding) internal view override returns (uint256) {
        return super._convertToShares(assets, rounding);
    }

    /// @notice Internal ERC-4626 conversion is intentionally local.
    function _convertToAssets(uint256 shares, Math.Rounding rounding) internal view override returns (uint256) {
        return super._convertToAssets(shares, rounding);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ERC-4626 compliance — max* functions must return 0 when the
    // corresponding deposit/mint/withdraw/redeem would revert.
    // EIP-4626: "MUST return the maximum amount … that would not cause
    // a revert"
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Maximum assets that can be deposited for `receiver`
    /// @dev Returns 0 when paused (deposit has whenNotPaused modifier)
    function maxDeposit(address receiver) public view override returns (uint256) {
        if (paused()) {
            return 0;
        }
        return super.maxDeposit(receiver);
    }

    /// @notice Maximum shares that can be minted for `receiver`
    /// @dev Returns 0 when paused (mint has whenNotPaused modifier)
    function maxMint(address receiver) public view override returns (uint256) {
        if (paused()) {
            return 0;
        }
        return super.maxMint(receiver);
    }

    /// @notice Maximum assets owner can withdraw
    /// @dev Returns 0 when paused or cooldown is active (ERC-4626 compliance)
    function maxWithdraw(address owner) public view override returns (uint256) {
        if (paused() || block.timestamp < lastDeposit[owner] + WITHDRAW_COOLDOWN) {
            return 0;
        }
        return super.maxWithdraw(owner);
    }

    /// @notice Maximum shares owner can redeem
    /// @dev Returns 0 when paused or cooldown is active (ERC-4626 compliance)
    function maxRedeem(address owner) public view override returns (uint256) {
        if (paused() || block.timestamp < lastDeposit[owner] + WITHDRAW_COOLDOWN) {
            return 0;
        }
        return super.maxRedeem(owner);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SOL-M-9: YIELD VESTING — linear drip to prevent sandwich attacks
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Override totalAssets to subtract unvested yield
    /// @dev This makes the share price increase linearly over VESTING_DURATION
    ///      instead of jumping instantly on yield injection.
    function totalAssets() public view override returns (uint256) {
        uint256 raw = super.totalAssets();
        uint256 stillUnvested = _currentUnvestedYield();
        // Protect against underflow if yield was somehow removed
        return raw > stillUnvested ? raw - stillUnvested : raw;
    }

    /// @notice Calculate currently unvested yield (view-safe)
    function _currentUnvestedYield() internal view returns (uint256) {
        if (unvestedYield == 0) return 0;
        if (block.timestamp >= yieldVestingEnd) return 0;

        uint256 vestingStart = lastVestingCheckpoint;
        uint256 totalDuration = yieldVestingEnd - vestingStart;
        if (totalDuration == 0) return 0;

        uint256 elapsed = block.timestamp - vestingStart;
        uint256 vested = (unvestedYield * elapsed) / totalDuration;
        return unvestedYield - vested;
    }

    /// @notice Checkpoint vesting — realize vested portion
    /// @dev Called before adding new yield to correctly account for partially vested amounts
    function _checkpointVesting() internal {
        if (unvestedYield == 0) return;
        if (block.timestamp >= yieldVestingEnd) {
            // All vested
            unvestedYield = 0;
            return;
        }
        uint256 vestingStart = lastVestingCheckpoint;
        uint256 totalDuration = yieldVestingEnd - vestingStart;
        if (totalDuration == 0) {
            unvestedYield = 0;
            return;
        }
        uint256 elapsed = block.timestamp - vestingStart;
        uint256 vested = (unvestedYield * elapsed) / totalDuration;
        unvestedYield -= vested;
        lastVestingCheckpoint = block.timestamp;
    }

    /// @notice View: current unvested yield amount
    function currentUnvestedYield() external view returns (uint256) {
        return _currentUnvestedYield();
    }

    // ============================================================
    //                     EMERGENCY CONTROLS
    // ============================================================

    /// @notice Pause all deposits and withdrawals
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Unpause all deposits and withdrawals
    /// @dev SOL-H-17: Requires TIMELOCK_ROLE (48h governance delay). Prevents
    ///      compromised PAUSER from re-enabling operations during active exploits.
    function unpause() external onlyRole(TIMELOCK_ROLE) {
        _unpause();
    }
}
