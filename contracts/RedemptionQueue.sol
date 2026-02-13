// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title RedemptionQueue
/// @notice Orderly mUSD-to-USDC redemption queue preventing bank-run scenarios.
///         Users queue redemption requests which are processed FIFO when liquidity
///         is available. This prevents a rush to redeem from causing a liquidity
///         crisis in the Treasury.
/// @dev FIX: Implements bank-run resilience mechanism identified in economic model audit.
contract RedemptionQueue is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant PROCESSOR_ROLE = keccak256("PROCESSOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    IERC20 public immutable musd;
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
        require(_musd != address(0) && _usdc != address(0), "ZERO_ADDRESS");
        musd = IERC20(_musd);
        usdc = IERC20(_usdc);
        maxDailyRedemption = _maxDailyRedemption;
        minRequestAge = _minRequestAge;
        lastDayReset = block.timestamp;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PROCESSOR_ROLE, msg.sender);
    }

    /// @notice Queue a redemption request. Locks mUSD in this contract.
    /// @param musdAmount Amount of mUSD to redeem (18 decimals)
    /// @param minUsdcOut Minimum USDC expected (6 decimals) - slippage protection
    function queueRedemption(uint256 musdAmount, uint256 minUsdcOut) external nonReentrant whenNotPaused {
        require(musdAmount > 0, "ZERO_AMOUNT");

        // Convert mUSD (18 decimals) to USDC (6 decimals) at 1:1
        uint256 usdcAmount = musdAmount / 1e12;
        require(usdcAmount >= minUsdcOut, "SLIPPAGE_EXCEEDED");
        require(usdcAmount > 0, "DUST_AMOUNT");

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

            usdc.safeTransfer(req.user, req.usdcAmount);

            emit RedemptionFulfilled(nextFulfillIndex, req.user, req.usdcAmount);

            nextFulfillIndex++;
            processed++;
        }
    }

    /// @notice Cancel a pending redemption and return mUSD
    /// @param requestId The request index to cancel
    function cancelRedemption(uint256 requestId) external nonReentrant {
        require(requestId < queue.length, "INVALID_ID");
        RedemptionRequest storage req = queue[requestId];
        require(req.user == msg.sender, "NOT_OWNER");
        require(!req.fulfilled, "ALREADY_FULFILLED");
        require(!req.cancelled, "ALREADY_CANCELLED");

        req.cancelled = true;
        totalPendingMusd -= req.musdAmount;
        totalPendingUsdc -= req.usdcAmount;

        musd.safeTransfer(msg.sender, req.musdAmount);

        emit RedemptionCancelled(requestId, msg.sender, req.musdAmount);
    }

    // View functions
    function queueLength() external view returns (uint256) { return queue.length; }
    function pendingCount() external view returns (uint256) { return queue.length - nextFulfillIndex; }

    // Admin
    function setMaxDailyRedemption(uint256 newLimit) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 old = maxDailyRedemption;
        maxDailyRedemption = newLimit;
        emit DailyLimitUpdated(old, newLimit);
    }

    function setMinRequestAge(uint256 newAge) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minRequestAge = newAge;
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    function _resetDailyIfNeeded() internal {
        if (block.timestamp >= lastDayReset + 1 days) {
            dailyRedeemed = 0;
            lastDayReset = block.timestamp;
        }
    }
}
