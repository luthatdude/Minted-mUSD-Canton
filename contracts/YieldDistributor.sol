// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./Errors.sol";

/**
 * @title YieldDistributor
 * @notice Proportionally distributes harvested yield to ALL pools according to
 *         share weight — Ethereum smUSD stakers AND Canton pools via the bridge.
 *
 * Architecture:
 *   1. Keeper calls distributeYield(yieldUsdc) after TreasuryV2.harvestYield()
 *   2. Withdraws yieldUsdc from Treasury reserve
 *   3. Swaps USDC → mUSD through DirectMint (proper 1:1 backed conversion)
 *   4. Reads ETH vs Canton share ratio from SMUSD
 *   5. ETH portion → SMUSD.distributeYield()    (12h linear vesting)
 *   6. Canton portion → BLEBridge.bridgeToCanton() (burn ETH, relay credits Canton)
 *
 * USDC → mUSD Conversion:
 *   Yield USDC is routed through DirectMintV2 which:
 *   - Takes USDC from this contract
 *   - Deposits it back into TreasuryV2 (maintains proper 1:1 backing)
 *   - Mints mUSD to this contract
 *   - May charge a mint fee (configurable via DirectMint governance)
 *   NOTE: For zero-fee yield conversion, set DirectMint.mintFeeBps = 0 via TIMELOCK.
 *
 *   Because USDC round-trips (Treasury → here → DirectMint → Treasury), the net
 *   Treasury.totalValue() change is only the mint fee. This means globalSharePrice()
 *   is NOT distorted — no distributedYieldOffset needed for the full amount.
 *
 * Revenue Split:
 *   Protocol fee (20%) is taken by TreasuryV2.harvestYield() BEFORE this contract
 *   sees any yield. This contract only handles the 80% net yield distribution.
 *
 * Roles Required (granted during deployment):
 *   - VAULT_ROLE on TreasuryV2 (to call withdraw)
 *   - YIELD_MANAGER_ROLE on SMUSD (to call distributeYield)
 *   - USDC approval to DirectMint (set in constructor)
 *   - mUSD approval to BLEBridge (for bridgeToCanton burn) — set in constructor
 *   - mUSD approval to SMUSD (for distributeYield pull) — set in constructor
 */
contract YieldDistributor is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════
    // ROLES
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Keeper/bot role that triggers distribution
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    /// @notice Admin/governance for parameter changes
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    // ═══════════════════════════════════════════════════════════════════════
    // EXTERNAL CONTRACTS (all immutable for gas + safety)
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice USDC token (6 decimals) — yield denomination
    IERC20 public immutable usdc;

    /// @notice mUSD token (18 decimals) — distributed to pools
    IERC20 public immutable musd;

    /// @notice SMUSD vault — for ETH share count and yield distribution
    ISMUSD_Distributor public immutable smusd;

    /// @notice TreasuryV2 — source of yield USDC
    ITreasuryV2_Distributor public immutable treasury;

    /// @notice BLEBridgeV9 — for bridging Canton's yield portion
    IBLEBridge_Distributor public immutable bridge;

    /// @notice DirectMintV2 — swaps USDC → mUSD with proper Treasury backing
    IDirectMint_Distributor public immutable directMint;

    // ═══════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Canton party identifier for yield bridging
    string public cantonYieldRecipient;

    /// @notice Minimum yield to distribute (prevents dust distributions, USDC 6 dec)
    uint256 public minDistributionUsdc;

    /// @notice Cooldown between distributions
    uint256 public distributionCooldown;

    /// @notice Last distribution timestamp
    uint256 public lastDistributionTime;

    /// @notice Cumulative mUSD yield distributed to ETH pool (18 decimals)
    uint256 public totalDistributedEth;

    /// @notice Cumulative mUSD yield distributed to Canton pool (18 decimals)
    uint256 public totalDistributedCanton;

    /// @notice Total distributions count
    uint256 public distributionCount;

    /// @notice Cumulative USDC paid as DirectMint swap fees (6 decimals)
    uint256 public totalMintFeesUsdc;

    // ═══════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event YieldDistributed(
        uint256 indexed epoch,
        uint256 yieldUsdc,           // Input USDC from Treasury
        uint256 musdMinted,          // mUSD received from DirectMint (after fee)
        uint256 ethMusd,             // mUSD sent to SMUSD
        uint256 cantonMusd,          // mUSD bridged to Canton
        uint256 ethSharesBps,        // ETH weight in basis points
        uint256 cantonSharesBps      // Canton weight in basis points
    );

    event CantonYieldBridged(
        uint256 indexed epoch,
        uint256 musdAmount,
        string cantonRecipient
    );

    event EthYieldDistributed(
        uint256 indexed epoch,
        uint256 musdAmount
    );

    event CantonRecipientUpdated(string oldRecipient, string newRecipient);
    event MinDistributionUpdated(uint256 oldMin, uint256 newMin);
    event DistributionCooldownUpdated(uint256 oldCooldown, uint256 newCooldown);

    // ═══════════════════════════════════════════════════════════════════════
    // ERRORS (unique to YieldDistributor; shared errors imported from Errors.sol)
    // ═══════════════════════════════════════════════════════════════════════

    error BelowMinDistribution();
    error CantonRecipientNotSet();
    error ZeroMusdReceived();

    // ═══════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════

    constructor(
        address _usdc,
        address _musd,
        address _smusd,
        address _treasury,
        address _bridge,
        address _directMint,
        address _admin
    ) {
        if (_usdc == address(0)) revert ZeroAddress();
        if (_musd == address(0)) revert ZeroAddress();
        if (_smusd == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_bridge == address(0)) revert ZeroAddress();
        if (_directMint == address(0)) revert ZeroAddress();
        if (_admin == address(0)) revert ZeroAddress();

        usdc = IERC20(_usdc);
        musd = IERC20(_musd);
        smusd = ISMUSD_Distributor(_smusd);
        treasury = ITreasuryV2_Distributor(_treasury);
        bridge = IBLEBridge_Distributor(_bridge);
        directMint = IDirectMint_Distributor(_directMint);

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(GOVERNOR_ROLE, _admin);
        _grantRole(KEEPER_ROLE, _admin);

        // Defaults
        minDistributionUsdc = 100e6;      // $100 minimum
        distributionCooldown = 1 hours;    // Match TreasuryV2.MIN_ACCRUAL_INTERVAL

        // Pre-approve DirectMint to pull our USDC (for swap)
        IERC20(_usdc).forceApprove(_directMint, type(uint256).max);
        // Pre-approve bridge to spend our mUSD (bridgeToCanton burns from caller)
        IERC20(_musd).forceApprove(_bridge, type(uint256).max);
        // Pre-approve SMUSD to pull our mUSD (distributeYield uses safeTransferFrom)
        IERC20(_musd).forceApprove(_smusd, type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CORE: PROPORTIONAL YIELD DISTRIBUTION
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Distribute yield proportionally to all pools based on share weight.
     *         Called by keeper after TreasuryV2.harvestYield() accrues fees.
     *
     * @param yieldUsdc Net yield in USDC (6 decimals) to distribute.
     *        This should be the 80% net yield AFTER protocol fees.
     *
     * Flow:
     *   1. Withdraw yieldUsdc from Treasury reserve
     *   2. Swap USDC → mUSD through DirectMint (proper 1:1 backed conversion)
     *   3. Read ethShares and cantonShares from SMUSD
     *   4. Split mUSD proportionally by share weight
     *   5. ETH → SMUSD.distributeYield(ethMusd)
     *   6. Canton → bridge.bridgeToCanton(cantonMusd, cantonRecipient)
     *
     * Note on USDC circular flow:
     *   Treasury.withdraw() sends USDC here, then DirectMint.mint() deposits
     *   it back to Treasury. Net Treasury change = only the mint fee.
     *   This is intentional — the USDC backing stays in Treasury, and mUSD
     *   is minted through the proper conversion path.
     */
    function distributeYield(uint256 yieldUsdc)
        external
        nonReentrant
        whenNotPaused
        onlyRole(KEEPER_ROLE)
    {
        if (yieldUsdc < minDistributionUsdc) revert BelowMinDistribution();
        if (block.timestamp < lastDistributionTime + distributionCooldown) {
            revert CooldownNotElapsed();
        }

        // ── Read share proportions from SMUSD ────────────────────────
        uint256 ethShares = smusd.totalSupply();
        uint256 cantonShares = smusd.cantonTotalShares();
        uint256 totalShares = ethShares + cantonShares;

        if (totalShares == 0) revert NoSharesExist();

        // ── Step 1: Withdraw yield USDC from Treasury ────────────────
        treasury.withdraw(address(this), yieldUsdc);

        // ── Step 2: Swap USDC → mUSD through DirectMint ─────────────
        //   DirectMint takes our USDC, deposits it back to Treasury
        //   (maintaining proper 1:1 backing), and mints mUSD to us.
        //   May charge a mint fee — set mintFeeBps = 0 via TIMELOCK
        //   for zero-fee yield conversion.
        uint256 musdReceived = directMint.mint(yieldUsdc);
        if (musdReceived == 0) revert ZeroMusdReceived();

        // Track DirectMint swap fee (USDC that was taken as fee)
        uint256 expectedMusd = yieldUsdc * 1e12;
        if (expectedMusd > musdReceived) {
            totalMintFeesUsdc += (expectedMusd - musdReceived) / 1e12;
        }

        // ── Step 3: Split mUSD proportionally by share weight ────────
        uint256 cantonMusd = (cantonShares > 0)
            ? (musdReceived * cantonShares) / totalShares
            : 0;
        uint256 ethMusd = musdReceived - cantonMusd;

        // ── Step 4: ETH portion → SMUSD (12h linear vesting) ────────
        if (ethMusd > 0) {
            smusd.distributeYield(ethMusd);
            emit EthYieldDistributed(distributionCount, ethMusd);
        }

        // ── Step 5: Canton portion → Bridge (burn ETH, credit Canton) ──
        if (cantonMusd > 0) {
            if (bytes(cantonYieldRecipient).length == 0) {
                revert CantonRecipientNotSet();
            }
            bridge.bridgeToCanton(cantonMusd, cantonYieldRecipient);
            emit CantonYieldBridged(
                distributionCount,
                cantonMusd,
                cantonYieldRecipient
            );
        }

        // ── Step 6: Update state ─────────────────────────────────────
        lastDistributionTime = block.timestamp;
        totalDistributedEth += ethMusd;
        totalDistributedCanton += cantonMusd;
        distributionCount++;

        uint256 ethBps = (ethMusd * 10000) / musdReceived;
        uint256 cantonBps = 10000 - ethBps;

        emit YieldDistributed(
            distributionCount,
            yieldUsdc,
            musdReceived,
            ethMusd,
            cantonMusd,
            ethBps,
            cantonBps
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Preview how yield would be split at current share ratios
    /// @param yieldUsdc Amount of USDC yield to distribute
    /// @return ethMusd ETH pool mUSD portion (after DirectMint fee)
    /// @return cantonMusd Canton pool mUSD portion (after DirectMint fee)
    /// @return ethShareBps ETH pool weight in BPS
    /// @return cantonShareBps Canton pool weight in BPS
    function previewDistribution(uint256 yieldUsdc) external view returns (
        uint256 ethMusd,
        uint256 cantonMusd,
        uint256 ethShareBps,
        uint256 cantonShareBps
    ) {
        uint256 ethShares = smusd.totalSupply();
        uint256 cantonShares = smusd.cantonTotalShares();
        uint256 totalShares = ethShares + cantonShares;

        if (totalShares == 0) return (0, 0, 0, 0);

        // Preview mUSD output from DirectMint (accounts for fee)
        (uint256 musdOut, ) = directMint.previewMint(yieldUsdc);

        cantonMusd = (cantonShares > 0)
            ? (musdOut * cantonShares) / totalShares
            : 0;
        ethMusd = musdOut - cantonMusd;

        ethShareBps = (musdOut > 0) ? (ethMusd * 10000) / musdOut : 0;
        cantonShareBps = (musdOut > 0) ? 10000 - ethShareBps : 0;
    }

    /// @notice Check if distribution can be called
    function canDistribute() external view returns (bool) {
        return block.timestamp >= lastDistributionTime + distributionCooldown;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // GOVERNANCE
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Set Canton yield recipient party
    function setCantonYieldRecipient(string calldata _recipient)
        external
        onlyRole(GOVERNOR_ROLE)
    {
        if (bytes(_recipient).length == 0) revert InvalidRecipient();
        emit CantonRecipientUpdated(cantonYieldRecipient, _recipient);
        cantonYieldRecipient = _recipient;
    }

    /// @notice Set minimum distribution amount
    function setMinDistribution(uint256 _min)
        external
        onlyRole(GOVERNOR_ROLE)
    {
        emit MinDistributionUpdated(minDistributionUsdc, _min);
        minDistributionUsdc = _min;
    }

    /// @notice Set distribution cooldown
    function setDistributionCooldown(uint256 _cooldown)
        external
        onlyRole(GOVERNOR_ROLE)
    {
        emit DistributionCooldownUpdated(distributionCooldown, _cooldown);
        distributionCooldown = _cooldown;
    }

    /// @notice Emergency pause
    function pause() external onlyRole(GOVERNOR_ROLE) {
        _pause();
    }

    /// @notice Unpause
    function unpause() external onlyRole(GOVERNOR_ROLE) {
        _unpause();
    }

    /// @notice Emergency rescue stuck tokens
    function rescueToken(address token, uint256 amount)
        external
        onlyRole(GOVERNOR_ROLE)
    {
        IERC20(token).safeTransfer(msg.sender, amount);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// MINIMAL INTERFACES (only what YieldDistributor needs)
// ═══════════════════════════════════════════════════════════════════════════

interface ISMUSD_Distributor {
    function totalSupply() external view returns (uint256);
    function cantonTotalShares() external view returns (uint256);
    function distributeYield(uint256 amount) external;
    function globalTotalShares() external view returns (uint256);
}

interface ITreasuryV2_Distributor {
    function withdraw(address to, uint256 amount) external;
    function availableReserves() external view returns (uint256);
    function totalValue() external view returns (uint256);
}

interface IBLEBridge_Distributor {
    function bridgeToCanton(uint256 amount, string calldata cantonRecipient) external;
}

interface IDirectMint_Distributor {
    function mint(uint256 usdcAmount) external returns (uint256 musdOut);
    function previewMint(uint256 usdcAmount) external view returns (uint256 musdOut, uint256 feeUsdc);
}
