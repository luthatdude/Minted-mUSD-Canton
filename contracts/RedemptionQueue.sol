// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./Errors.sol";

/// @dev Interface for burning mUSD tokens after redemption fulfillment
interface IMUSDBurnable {
    function burn(address from, uint256 amount) external;
}

/// @title RedemptionQueue
/// @notice Orderly mUSD-to-USDC redemption queue preventing bank-run scenarios.
///         Users queue redemption requests which are processed FIFO when liquidity
///         is available. This prevents a rush to redeem from causing a liquidity
///         crisis in the Treasury.
/// @dev Burns mUSD after fulfillment to prevent permanent supply inflation.
///
/// @dev DEPLOYMENT DEPENDENCY — This contract's `processBatch()`
///      calls `musdBurnable.burn(address(this), ...)` which requires the RedemptionQueue
///      address to hold BRIDGE_ROLE or LIQUIDATOR_ROLE on the MUSD contract.
///      Deployment scripts MUST include:
///
///          musd.grantRole(musd.BRIDGE_ROLE(), redemptionQueueAddress);
///
///      See also: scripts/deploy.ts and scripts/verify-deployment.ts for the grant step.
contract RedemptionQueue is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant PROCESSOR_ROLE = keccak256("PROCESSOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    /// @notice SOL-H-17: TIMELOCK_ROLE for unpause (48h governance delay)
    bytes32 public constant TIMELOCK_ROLE = keccak256("TIMELOCK_ROLE");

    IERC20 public immutable musd;
    IMUSDBurnable public immutable musdBurnable;
    IERC20 public immutable usdc;

    struct RedemptionRequest {
        address user;
        uint256 musdAmount;       // mUSD locked for redemption (18 decimals)
        uint256 usdcAmount;       // USDC to receive (6 decimals)
        uint256 requestedAt;
        bool fulfilled;
        bool cancelled;
    }

    // Queue state
    RedemptionRequest[] public queue;
    uint256 public nextFulfillIndex;    // FIFO pointer
    uint256 public totalPendingMusd;    // Total mUSD locked in unfulfilled requests
    uint256 public totalPendingUsdc;    // Total USDC owed for pending requests

    // Rate limits
    uint256 public maxDailyRedemption;  // Max USDC redeemable per day
    uint256 public dailyRedeemed;       // USDC redeemed today
    uint256 public lastDayReset;        // Timestamp of last daily reset

    // Cooldown
    uint256 public minRequestAge;       // Minimum time before fulfillment (e.g., 1 hour)

    // C-01: Queue DoS protection — prevents unbounded array growth and dust spam
    uint256 public constant MIN_REDEMPTION_USDC = 100e6;    // 100 USDC minimum redemption
    uint256 public constant MAX_QUEUE_SIZE = 10_000;         // Max active (unfulfilled, uncancelled) requests
    uint256 public constant MAX_PENDING_PER_USER = 10;       // Per-user active pending limit
    uint256 public activePendingCount;                       // Global active pending request counter
    mapping(address => uint256) public userPendingCount;     // Per-user active pending counter

    error QueueSizeExceeded();
    error UserQueueLimitExceeded();
    error BelowMinRedemption();

    event RedemptionQueued(uint256 indexed requestId, address indexed user, uint256 musdAmount, uint256 usdcAmount);
    event RedemptionFulfilled(uint256 indexed requestId, address indexed user, uint256 usdcAmount);
    event RedemptionCancelled(uint256 indexed requestId, address indexed user, uint256 musdAmount);
    event DailyLimitUpdated(uint256 oldLimit, uint256 newLimit);

    constructor(
        address _musd,
        address _usdc,
        uint256 _maxDailyRedemption,
        uint256 _minRequestAge
    ) {
        if (_musd == address(0) || _usdc == address(0)) revert ZeroAddress();
        musd = IERC20(_musd);
        musdBurnable = IMUSDBurnable(_musd);
        usdc = IERC20(_usdc);
        maxDailyRedemption = _maxDailyRedemption;
        minRequestAge = _minRequestAge;
        lastDayReset = block.timestamp;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PROCESSOR_ROLE, msg.sender);
        _grantRole(TIMELOCK_ROLE, msg.sender);
        _setRoleAdmin(TIMELOCK_ROLE, TIMELOCK_ROLE);
    }

    /// @notice Queue a redemption request. Locks mUSD in this contract.
    /// @param musdAmount Amount of mUSD to redeem (18 decimals)
    /// @param minUsdcOut Minimum USDC expected (6 decimals) - slippage protection
    function queueRedemption(uint256 musdAmount, uint256 minUsdcOut) external nonReentrant whenNotPaused {
        if (musdAmount == 0) revert ZeroAmount();

        // Convert mUSD (18 decimals) to USDC (6 decimals) at 1:1
        uint256 usdcAmount = musdAmount / 1e12;
        if (usdcAmount < minUsdcOut) revert SlippageExceeded();
        if (usdcAmount == 0) revert DustAmount();

        // C-01: Minimum redemption prevents dust spam
        if (usdcAmount < MIN_REDEMPTION_USDC) revert BelowMinRedemption();
        // C-01: Global queue cap prevents unbounded array growth
        if (activePendingCount >= MAX_QUEUE_SIZE) revert QueueSizeExceeded();
        // C-01: Per-user limit prevents single-actor spam
        if (userPendingCount[msg.sender] >= MAX_PENDING_PER_USER) revert UserQueueLimitExceeded();

        // Lock mUSD
        musd.safeTransferFrom(msg.sender, address(this), musdAmount);

        uint256 requestId = queue.length;
        queue.push(RedemptionRequest({
            user: msg.sender,
            musdAmount: musdAmount,
            usdcAmount: usdcAmount,
            requestedAt: block.timestamp,
            fulfilled: false,
            cancelled: false
        }));

        totalPendingMusd += musdAmount;
        totalPendingUsdc += usdcAmount;

        // C-01: Track active pending counts
        activePendingCount++;
        userPendingCount[msg.sender]++;

        emit RedemptionQueued(requestId, msg.sender, musdAmount, usdcAmount);
    }

    /// @notice Process pending redemptions in FIFO order
    /// @param maxCount Maximum number of requests to process in this call
    function processBatch(uint256 maxCount) external onlyRole(PROCESSOR_ROLE) nonReentrant {
        _resetDailyIfNeeded();

        uint256 processed = 0;
        uint256 availableUsdc = usdc.balanceOf(address(this));

        while (processed < maxCount && nextFulfillIndex < queue.length) {
            RedemptionRequest storage req = queue[nextFulfillIndex];

            // Skip fulfilled or cancelled
            if (req.fulfilled || req.cancelled) {
                nextFulfillIndex++;
                continue;
            }

            // Check cooldown
            if (block.timestamp < req.requestedAt + minRequestAge) {
                break; // All subsequent requests are newer, so stop
            }

            // Check daily limit
            if (dailyRedeemed + req.usdcAmount > maxDailyRedemption) {
                break; // Daily limit reached
            }

            // Check available liquidity
            if (availableUsdc < req.usdcAmount) {
                break; // Not enough USDC
            }

            // Fulfill
            req.fulfilled = true;
            availableUsdc -= req.usdcAmount;
            dailyRedeemed += req.usdcAmount;
            totalPendingMusd -= req.musdAmount;
            totalPendingUsdc -= req.usdcAmount;

            // C-01: Decrement active counts on fulfillment
            activePendingCount--;
            userPendingCount[req.user]--;

            // Burn the locked mUSD to reduce totalSupply and maintain peg integrity.
            // Without this burn, redeemed mUSD stays locked forever, inflating totalSupply
            // and degrading the health ratio reported by BLEBridgeV9.getHealthRatio().
            musdBurnable.burn(address(this), req.musdAmount);

            usdc.safeTransfer(req.user, req.usdcAmount);

            emit RedemptionFulfilled(nextFulfillIndex, req.user, req.usdcAmount);

            nextFulfillIndex++;
            processed++;
        }
    }

    /// @notice Cancel a pending redemption and return mUSD
    /// @param requestId The request index to cancel
    function cancelRedemption(uint256 requestId) external nonReentrant {
        if (requestId >= queue.length) revert InvalidId();
        RedemptionRequest storage req = queue[requestId];
        if (req.user != msg.sender) revert NotOwner();
        if (req.fulfilled) revert AlreadyFulfilled();
        if (req.cancelled) revert AlreadyCancelled();

        req.cancelled = true;
        totalPendingMusd -= req.musdAmount;
        totalPendingUsdc -= req.usdcAmount;

        // C-01: Decrement active counts on cancellation
        activePendingCount--;
        userPendingCount[msg.sender]--;

        musd.safeTransfer(msg.sender, req.musdAmount);

        emit RedemptionCancelled(requestId, msg.sender, req.musdAmount);
    }

    // View functions
    function queueLength() external view returns (uint256) { return queue.length; }
    function pendingCount() external view returns (uint256) { return queue.length - nextFulfillIndex; }

    // Admin
    /// @dev SOL-H-02: Changed from DEFAULT_ADMIN_ROLE to TIMELOCK_ROLE — rate limits are critical parameters
    function setMaxDailyRedemption(uint256 newLimit) external onlyRole(TIMELOCK_ROLE) {
        uint256 old = maxDailyRedemption;
        maxDailyRedemption = newLimit;
        emit DailyLimitUpdated(old, newLimit);
    }

    /// @dev SOL-H-02: Changed from DEFAULT_ADMIN_ROLE to TIMELOCK_ROLE — cooldown is a critical parameter
    function setMinRequestAge(uint256 newAge) external onlyRole(TIMELOCK_ROLE) {
        minRequestAge = newAge;
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    /// @dev SOL-H-17: Changed from DEFAULT_ADMIN_ROLE to TIMELOCK_ROLE (48h governance delay)
    function unpause() external onlyRole(TIMELOCK_ROLE) { _unpause(); }

    function _resetDailyIfNeeded() internal {
        if (block.timestamp >= lastDayReset + 1 days) {
            dailyRedeemed = 0;
            lastDayReset = block.timestamp;
        }
    }
}
