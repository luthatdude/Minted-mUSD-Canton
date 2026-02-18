// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./Errors.sol";
import "./TimelockGoverned.sol";

/**
 * @title ETHPoolYieldDistributor
 * @notice Harvests yield from MetaVault #3 (Fluid) and bridges it as mUSD
 *         back to the Canton ETH Pool via BLEBridge.
 *
 * Architecture (ETH Pool yield return path):
 *
 *   Canton side (deposit):
 *     USDCx → ETHPool_StakeWithUSDCx → BridgeOutRequest (source="ethpool")
 *
 *   Ethereum side (deposit, handled by relay Direction 3):
 *     Relay → USDC → TreasuryV2.depositToStrategy(MetaVault #3)
 *
 *   Ethereum side (yield return, this contract):
 *     1. Keeper calls distributeETHPoolYield()
 *     2. Reads MetaVault #3 totalValue() vs lastRecordedValue (yield = delta)
 *     3. Mints mUSD directly (backed by yield USDC sitting in strategy)
 *     4. Burns mUSD via BLEBridge.bridgeToCanton(ethPoolRecipient)
 *     5. Emits ETHPoolYieldBridged event
 *
 *   Canton side (yield receipt, handled by relay Direction 4):
 *     Relay detects ETHPoolYieldBridged → creates CantonMUSD →
 *     exercises ETHPool_ReceiveYield → pooledUsdc ↑ → share price ↑
 *
 * Yield backing:
 *   The yield USDC remains in MetaVault #3. mUSD is minted then immediately
 *   burned in the same transaction (net supply change = 0), serving purely
 *   as a bridge vehicle. The mUSD is properly backed by the yield USDC
 *   sitting in the strategy at the time of distribution.
 *
 * Denomination:
 *   The ETH Pool is denominated in ETH on the Canton side.
 *   On Ethereum, all values are in USDC (MetaVault #3 / Fluid strategy).
 *   The mUSD bridge carries the USD-equivalent value; Canton converts
 *   via its oracle price when displaying ETH-denominated returns.
 *
 * Roles Required:
 *   - BRIDGE_ROLE on MUSD (to mint mUSD for bridging)
 *   - mUSD approval to BLEBridge (for bridgeToCanton burn)
 */
contract ETHPoolYieldDistributor is AccessControl, ReentrancyGuard, Pausable, TimelockGoverned {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════
    // ROLES
    // ═══════════════════════════════════════════════════════════════════

    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    // ═══════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Basis points denominator
    uint256 public constant BPS = 10000;

    /// @notice Maximum allowed maxYieldBps (20% of HWM per epoch)
    uint256 public constant MAX_YIELD_BPS_CAP = 2000;

    /// @notice Minimum maturity blocks for yield persistence check
    uint256 public constant MIN_MATURITY_BLOCKS = 1;

    // ═══════════════════════════════════════════════════════════════════
    // EXTERNAL CONTRACTS (immutable)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice mUSD token (18 decimals) — minted as bridge vehicle
    IMUSD_ETHPool public immutable musd;

    /// @notice BLEBridgeV9 — burns mUSD for Canton bridge
    IBLEBridge_ETHPool public immutable bridge;

    /// @notice MetaVault #3 (Fluid) — the strategy backing ETH Pool deposits
    IStrategy_ETHPool public immutable metaVault3;

    // ═══════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Canton ETH Pool party identifier for yield bridging
    string public ethPoolRecipient;

    /// @notice Last recorded MetaVault #3 totalValue (high-water mark for yield)
    uint256 public lastRecordedValue;

    /// @notice Minimum yield to distribute (USDC 6 decimals)
    uint256 public minYieldUsdc;

    /// @notice Cooldown between distributions
    uint256 public distributionCooldown;

    /// @notice Last distribution timestamp
    uint256 public lastDistributionTime;

    /// @notice Cumulative mUSD yield bridged to Canton ETH Pool
    uint256 public totalDistributed;

    /// @notice Total distribution epochs
    uint256 public distributionCount;

    /// @notice Maximum yield per epoch as BPS of lastRecordedValue (HIGH-01 fix)
    /// @dev Default 500 = 5% of HWM. Set to 0 to disable cap.
    uint256 public maxYieldBps;

    /// @notice Block number when yield was first observed above HWM (HIGH-01 persistence)
    /// @dev Distribution requires yield to persist for `yieldMaturityBlocks` blocks.
    uint256 public yieldFirstObservedBlock;

    /// @notice Number of blocks yield must persist before distribution (HIGH-01 persistence)
    /// @dev Default 10 blocks (~2 minutes on mainnet). Prevents single-block inflation.
    uint256 public yieldMaturityBlocks;

    /// @notice Whether HWM desync has been flagged (strategy value < HWM)
    bool public hwmDesyncFlagged;

    // ═══════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event ETHPoolYieldBridged(
        uint256 indexed epoch,
        uint256 yieldUsdc,
        uint256 musdBridged,
        string ethPoolRecipient
    );

    event LastRecordedValueUpdated(uint256 oldValue, uint256 newValue);
    event EthPoolRecipientUpdated(string oldRecipient, string newRecipient);
    event YieldCapped(uint256 rawYield, uint256 cappedYield, uint256 maxAllowed);
    event HWMDesyncDetected(uint256 currentValue, uint256 hwm);
    event HWMDesyncResolved(uint256 currentValue, uint256 hwm);
    event MaxYieldBpsUpdated(uint256 oldBps, uint256 newBps);
    event YieldCapDisabled();
    event YieldMaturityBlocksUpdated(uint256 oldBlocks, uint256 newBlocks);

    // ═══════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(
        address _musd,
        address _bridge,
        address _metaVault3,
        address _admin,
        address _timelock
    ) {
        if (_musd == address(0)) revert ZeroAddress();
        if (_bridge == address(0)) revert ZeroAddress();
        if (_metaVault3 == address(0)) revert ZeroAddress();
        if (_admin == address(0)) revert ZeroAddress();

        musd = IMUSD_ETHPool(_musd);
        bridge = IBLEBridge_ETHPool(_bridge);
        metaVault3 = IStrategy_ETHPool(_metaVault3);
        _setTimelock(_timelock);

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(GOVERNOR_ROLE, _admin);
        _grantRole(KEEPER_ROLE, _admin);

        // Defaults
        minYieldUsdc = 50e6;             // $50 minimum
        distributionCooldown = 1 hours;
        maxYieldBps = 500;               // 5% of HWM per epoch (HIGH-01)
        yieldMaturityBlocks = 10;        // ~2 min on mainnet (HIGH-01)

        // Initialize high-water mark to current MetaVault #3 value
        lastRecordedValue = metaVault3.totalValue();

        // Pre-approve bridge to spend mUSD (bridgeToCanton burns from caller)
        IERC20(_musd).forceApprove(_bridge, type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════
    // CORE: ETH POOL YIELD DISTRIBUTION
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Distribute ETH Pool yield from MetaVault #3 to Canton via bridge.
     *
     * Flow:
     *   1. Read MetaVault #3 totalValue() — compare with lastRecordedValue
     *   2. yield = currentValue - lastRecordedValue (only positive delta)
     *   3. Mint mUSD directly (backed by yield USDC in strategy)
     *   4. Bridge mUSD to Canton ETH Pool via BLEBridge.bridgeToCanton()
     *
     * The yield USDC stays in the strategy. mUSD is minted then immediately
     * burned by the bridge in the same transaction (net supply Δ = 0).
     * This avoids circular USDC flows and keeps HWM tracking accurate.
     *
     * @dev Only distributes NEW yield above the high-water mark.
     *      Protocol fee (20%) is already taken by TreasuryV2.harvestYield()
     *      before MetaVault #3 totalValue() reflects it. So the yield here
     *      is net of protocol fees.
     */
    function distributeETHPoolYield()
        external
        nonReentrant
        whenNotPaused
        onlyRole(KEEPER_ROLE)
    {
        if (bytes(ethPoolRecipient).length == 0) revert RecipientNotSet();
        if (block.timestamp < lastDistributionTime + distributionCooldown) {
            revert CooldownNotElapsed();
        }

        // ── Step 1: Calculate yield from MetaVault #3 ────────────────
        uint256 currentValue = metaVault3.totalValue();

        // HWM desync detection (MEDIUM-01): flag if value < HWM
        // Uses return (not revert) so on-chain state and event persist.
        if (currentValue < lastRecordedValue) {
            if (!hwmDesyncFlagged) {
                hwmDesyncFlagged = true;
                emit HWMDesyncDetected(currentValue, lastRecordedValue);
            }
            return; // No yield available — state persists for monitoring
        }

        if (currentValue == lastRecordedValue) revert NoYieldAvailable();

        // Resolve desync flag if value recovered
        if (hwmDesyncFlagged) {
            hwmDesyncFlagged = false;
            emit HWMDesyncResolved(currentValue, lastRecordedValue);
        }

        uint256 yieldUsdc = currentValue - lastRecordedValue;
        if (yieldUsdc < minYieldUsdc) revert BelowMinYield();

        // ── Step 1b: Yield persistence check (HIGH-01) ───────────────
        //  Require yield to persist for `yieldMaturityBlocks` blocks.
        //  Keeper must call observeYield() first to start the timer.
        if (yieldMaturityBlocks > 0) {
            if (yieldFirstObservedBlock == 0
                || block.number < yieldFirstObservedBlock + yieldMaturityBlocks) {
                revert YieldNotMature();
            }
        }

        // ── Step 1c: Apply yield cap (MEDIUM-03 + HIGH-01) ───────────
        //  Cap yield per epoch at maxYieldBps of HWM. Excess rolls to
        //  next epoch (HWM only advances by capped amount).
        if (maxYieldBps > 0 && lastRecordedValue > 0) {
            uint256 maxYield = (lastRecordedValue * maxYieldBps) / BPS;
            if (yieldUsdc > maxYield) {
                emit YieldCapped(yieldUsdc, maxYield, maxYield);
                yieldUsdc = maxYield;
            }
        }

        // ── Step 2: Update high-water mark ───────────────────────────
        //  Advance HWM by capped yield amount (NOT to currentValue).
        //  Excess yield above the cap remains for next epoch.
        uint256 oldValue = lastRecordedValue;
        lastRecordedValue = oldValue + yieldUsdc;

        // ── Step 3: Mint mUSD (USDC 6-dec → mUSD 18-dec) ────────────
        //  Backed by yield USDC sitting in MetaVault #3.
        //  The bridge burns this in the same tx (net supply Δ = 0).
        uint256 musdAmount = yieldUsdc * 1e12;
        musd.mint(address(this), musdAmount);

        // ── Step 4: Bridge mUSD to Canton ETH Pool ───────────────────
        bridge.bridgeToCanton(musdAmount, ethPoolRecipient);

        // ── Step 5: Update state ─────────────────────────────────────
        lastDistributionTime = block.timestamp;
        totalDistributed += musdAmount;
        distributionCount++;
        // Reset yield observation block for next epoch
        yieldFirstObservedBlock = 0;

        emit ETHPoolYieldBridged(
            distributionCount,
            yieldUsdc,
            musdAmount,
            ethPoolRecipient
        );
        emit LastRecordedValueUpdated(oldValue, lastRecordedValue);
    }

    // ═══════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Preview available yield from MetaVault #3
    /// @return yieldUsdc Available yield in USDC (6 decimals)
    /// @return canDistribute Whether distribution is allowed (cooldown + minimum)
    function previewYield() external view returns (uint256 yieldUsdc, bool canDistribute) {
        uint256 currentValue = metaVault3.totalValue();
        if (currentValue > lastRecordedValue) {
            yieldUsdc = currentValue - lastRecordedValue;
            // Apply cap in preview so caller sees what will actually be distributed
            if (maxYieldBps > 0 && lastRecordedValue > 0) {
                uint256 maxYield = (lastRecordedValue * maxYieldBps) / BPS;
                if (yieldUsdc > maxYield) {
                    yieldUsdc = maxYield;
                }
            }
        }
        bool yieldMature = yieldMaturityBlocks == 0
            || (yieldFirstObservedBlock > 0 && block.number >= yieldFirstObservedBlock + yieldMaturityBlocks);
        canDistribute = yieldUsdc >= minYieldUsdc
            && block.timestamp >= lastDistributionTime + distributionCooldown
            && bytes(ethPoolRecipient).length > 0
            && yieldMature;
    }

    /// @notice Check if HWM is desynced (strategy value < HWM)
    /// @return desynced True if current strategy value is below HWM
    /// @return currentValue Current MetaVault #3 totalValue
    /// @return hwm Current high-water mark
    function checkHwmDesync() external view returns (bool desynced, uint256 currentValue, uint256 hwm) {
        currentValue = metaVault3.totalValue();
        hwm = lastRecordedValue;
        desynced = currentValue < hwm;
    }

    // ═══════════════════════════════════════════════════════════════════
    // GOVERNANCE
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Set Canton ETH Pool recipient party
    function setEthPoolRecipient(string calldata _recipient)
        external
        onlyRole(GOVERNOR_ROLE)
    {
        if (bytes(_recipient).length == 0) revert InvalidRecipient();
        emit EthPoolRecipientUpdated(ethPoolRecipient, _recipient);
        ethPoolRecipient = _recipient;
    }

    /// @notice Set minimum yield amount
    function setMinYield(uint256 _min) external onlyTimelock {
        minYieldUsdc = _min;
    }

    /// @notice Set distribution cooldown
    function setCooldown(uint256 _cooldown) external onlyTimelock {
        distributionCooldown = _cooldown;
    }

    /// @notice Manually sync high-water mark to current MetaVault #3 value.
    /// @dev Use after manual withdrawals or strategy rebalances to prevent
    ///      the delta from including non-yield value changes.
    function syncHighWaterMark() external onlyRole(GOVERNOR_ROLE) {
        uint256 currentValue = metaVault3.totalValue();
        emit LastRecordedValueUpdated(lastRecordedValue, currentValue);
        lastRecordedValue = currentValue;
        // Reset yield observation and desync flag since HWM was manually synced
        yieldFirstObservedBlock = 0;
        if (hwmDesyncFlagged) {
            hwmDesyncFlagged = false;
            emit HWMDesyncResolved(currentValue, currentValue);
        }
    }

    /// @notice Set maximum yield per epoch as BPS of HWM (HIGH-01 / MEDIUM-03)
    /// @param _bps Basis points (e.g., 500 = 5%). Set to 0 to disable cap.
    function setMaxYieldBps(uint256 _bps) external onlyTimelock {
        if (_bps > MAX_YIELD_BPS_CAP) revert AboveMax();
        emit MaxYieldBpsUpdated(maxYieldBps, _bps);
        if (_bps == 0) emit YieldCapDisabled();
        maxYieldBps = _bps;
    }

    /// @notice Set yield maturity blocks (HIGH-01 persistence check)
    /// @param _blocks Number of blocks yield must persist. Set to 0 to disable.
    function setYieldMaturityBlocks(uint256 _blocks) external onlyTimelock {
        emit YieldMaturityBlocksUpdated(yieldMaturityBlocks, _blocks);
        yieldMaturityBlocks = _blocks;
    }

    /// @notice Mark yield as first observed at current block.
    /// @dev Keepers call this when they first detect yield to start the maturity
    ///      timer. If yield already observed, this is a no-op.
    function observeYield() external onlyRole(KEEPER_ROLE) {
        if (yieldFirstObservedBlock == 0) {
            uint256 currentValue = metaVault3.totalValue();
            if (currentValue > lastRecordedValue) {
                yieldFirstObservedBlock = block.number;
            }
        }
    }

    /// @notice Emergency pause
    function pause() external onlyRole(GOVERNOR_ROLE) { _pause(); }

    /// @notice Unpause
    function unpause() external onlyTimelock { _unpause(); }

    /// @notice Emergency rescue stuck tokens (cannot rescue mUSD — LOW-01)
    function rescueToken(address token, uint256 amount) external onlyTimelock {
        if (token == address(musd)) revert CannotRescueMusd();
        IERC20(token).safeTransfer(msg.sender, amount);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// MINIMAL INTERFACES
// ═══════════════════════════════════════════════════════════════════════════

interface IMUSD_ETHPool {
    function mint(address to, uint256 amount) external;
}

interface IBLEBridge_ETHPool {
    function bridgeToCanton(uint256 amount, string calldata cantonRecipient) external;
}

interface IStrategy_ETHPool {
    function totalValue() external view returns (uint256);
}
