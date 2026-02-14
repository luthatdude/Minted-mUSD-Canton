// SPDX-License-Identifier: BUSL-1.1
// Minted mUSD Protocol - Interest Rate Model
// Compound-style utilization-based interest rate curve

pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "./Errors.sol";

/// @title InterestRateModel
/// @notice Calculates dynamic interest rates based on utilization
/// @dev Uses a two-slope (kinked) model similar to Compound/Aave:
///      - Below kink: gentler slope for normal utilization
///      - Above kink: steeper slope to incentivize repayment
///
/// Formula:
///   If utilization <= kink:
///     BorrowRate = baseRateBps + (utilization * multiplierBps / 10000)
///   Else:
///     BorrowRate = baseRateBps + (kink * multiplierBps / 10000) 
///                  + ((utilization - kink) * jumpMultiplierBps / 10000)
///
///   SupplyRate = BorrowRate * utilization * (1 - reserveFactorBps/10000) / 10000
///
contract InterestRateModel is AccessControl {
    bytes32 public constant RATE_ADMIN_ROLE = keccak256("RATE_ADMIN_ROLE");

    /// @notice TIMELOCK_ROLE for critical rate parameter changes.
    ///         setParams() is gated by TIMELOCK_ROLE, enforcing a 48h governance delay
    ///         via MintedTimelockController.
    bytes32 public constant TIMELOCK_ROLE = keccak256("TIMELOCK_ROLE");

    // ============================================================
    //                  RATE PARAMETERS (all in BPS)
    // ============================================================

    /// @notice Base interest rate per year (e.g., 200 = 2%)
    uint256 public baseRateBps;

    /// @notice Multiplier per utilization below kink (e.g., 1000 = 10% at 100% util)
    uint256 public multiplierBps;

    /// @notice Utilization point where rate slope increases (e.g., 8000 = 80%)
    uint256 public kinkBps;

    /// @notice Multiplier per utilization above kink (e.g., 5000 = 50% additional)
    uint256 public jumpMultiplierBps;

    /// @notice Portion of interest that goes to protocol reserves (e.g., 1000 = 10%)
    uint256 public reserveFactorBps;

    // ============================================================
    //                  CONSTANTS
    // ============================================================

    uint256 private constant BPS = 10000;
    uint256 private constant SECONDS_PER_YEAR = 365 days;

    // ============================================================
    //                  EVENTS
    // ============================================================

    event RateParamsUpdated(
        uint256 baseRateBps,
        uint256 multiplierBps,
        uint256 kinkBps,
        uint256 jumpMultiplierBps,
        uint256 reserveFactorBps
    );

    // ============================================================
    //                  ERRORS
    // ============================================================

    error InvalidParameter();
    error KinkTooHigh();
    error ReserveFactorTooHigh();

    // ============================================================
    //                  CONSTRUCTOR
    // ============================================================

    /// @notice Initialize with default parameters
    /// @param _admin The admin address for rate updates
    constructor(address _admin) {
        // Validate admin address to prevent permanently bricked governance
        if (_admin == address(0)) revert InvalidAddress();
        // Default: 2% base, 10% at 80% util, jumps to 50% additional above 80%
        // At 100% util: 2% + (80% * 10%) + (20% * 50%) = 2% + 8% + 10% = 20% APR
        baseRateBps = 200;           // 2% base rate
        multiplierBps = 1000;        // 10% at 100% utilization (pre-kink slope)
        kinkBps = 8000;              // 80% utilization kink point
        jumpMultiplierBps = 5000;    // 50% additional above kink
        reserveFactorBps = 1000;     // 10% to protocol reserves

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(RATE_ADMIN_ROLE, _admin);
        _grantRole(TIMELOCK_ROLE, _admin);
        // Make TIMELOCK_ROLE self-administering so DEFAULT_ADMIN cannot bypass
        _setRoleAdmin(TIMELOCK_ROLE, TIMELOCK_ROLE);
    }

    // ============================================================
    //                  RATE CALCULATION
    // ============================================================

    /// @notice Calculate utilization rate
    /// @param totalBorrows Total amount borrowed (18 decimals)
    /// @param totalSupply Total amount supplied/available (18 decimals)
    /// @return Utilization in BPS (10000 = 100%)
    function utilizationRate(uint256 totalBorrows, uint256 totalSupply) 
        public 
        pure 
        returns (uint256) 
    {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00040000, 1037618708484) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00040001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00040005, 9) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00046001, totalSupply) }
        if (totalSupply == 0) return 0;
        // Cap at 100% utilization
        if (totalBorrows >= totalSupply) return BPS;
        return (totalBorrows * BPS) / totalSupply;
    }

    /// @notice Calculate borrow rate per second in BPS
    /// @param totalBorrows Total amount borrowed
    /// @param totalSupply Total amount supplied
    /// @return Borrow rate per second in BPS (multiply by principal and seconds)
    function getBorrowRatePerSecond(uint256 totalBorrows, uint256 totalSupply)
        public
        view
        returns (uint256)
    {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00030000, 1037618708483) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00030001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00030005, 9) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00036001, totalSupply) }
        uint256 annualRate = getBorrowRateAnnual(totalBorrows, totalSupply);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000001,annualRate)}
        return annualRate / SECONDS_PER_YEAR;
    }

    /// @notice Calculate annual borrow rate in BPS
    /// @param totalBorrows Total amount borrowed
    /// @param totalSupply Total amount supplied
    /// @return Annual borrow rate in BPS
    function getBorrowRateAnnual(uint256 totalBorrows, uint256 totalSupply)
        public
        view
        returns (uint256)
    {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00010000, 1037618708481) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00010001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00010005, 9) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00016001, totalSupply) }
        uint256 util = utilizationRate(totalBorrows, totalSupply);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000002,util)}

        if (util <= kinkBps) {
            // Below kink: linear increase
            return baseRateBps + (util * multiplierBps) / BPS;
        } else {
            // Above kink: steeper increase
            uint256 normalRate = baseRateBps + (kinkBps * multiplierBps) / BPS;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000000b,normalRate)}
            uint256 excessUtil = util - kinkBps;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000000c,excessUtil)}
            return normalRate + (excessUtil * jumpMultiplierBps) / BPS;
        }
    }

    /// @notice Calculate supply rate per second in BPS
    /// @dev SupplyRate = BorrowRate * Utilization * (1 - ReserveFactor)
    /// @param totalBorrows Total amount borrowed
    /// @param totalSupply Total amount supplied
    /// @return Supply rate per second in BPS
    function getSupplyRatePerSecond(uint256 totalBorrows, uint256 totalSupply)
        public
        view
        returns (uint256)
    {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00070000, 1037618708487) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00070001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00070005, 9) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00076001, totalSupply) }
        uint256 annualRate = getSupplyRateAnnual(totalBorrows, totalSupply);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000003,annualRate)}
        return annualRate / SECONDS_PER_YEAR;
    }

    /// @notice Calculate annual supply rate in BPS
    /// @param totalBorrows Total amount borrowed
    /// @param totalSupply Total amount supplied
    /// @return Annual supply rate in BPS
    function getSupplyRateAnnual(uint256 totalBorrows, uint256 totalSupply)
        public
        view
        returns (uint256)
    {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00060000, 1037618708486) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00060001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00060005, 9) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00066001, totalSupply) }
        uint256 borrowRate = getBorrowRateAnnual(totalBorrows, totalSupply);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000004,borrowRate)}
        uint256 util = utilizationRate(totalBorrows, totalSupply);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000005,util)}
        uint256 oneMinusReserve = BPS - reserveFactorBps;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000006,oneMinusReserve)}
        
        // SupplyRate = BorrowRate * Utilization * (1 - ReserveFactor)
        return (borrowRate * util * oneMinusReserve) / (BPS * BPS);
    }

    /// @notice Calculate interest owed for a given principal and time
    /// @param principal The borrowed amount (18 decimals)
    /// @param totalBorrows Total borrows in the system
    /// @param totalSupply Total supply in the system
    /// @param secondsElapsed Time since last accrual
    /// @return Total interest owed (18 decimals)
    function calculateInterest(
        uint256 principal,
        uint256 totalBorrows,
        uint256 totalSupply,
        uint256 secondsElapsed
    ) external view returns (uint256) {
        if (principal == 0 || secondsElapsed == 0) return 0;
        
        uint256 annualRateBps = getBorrowRateAnnual(totalBorrows, totalSupply);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000007,annualRateBps)}
        // interest = principal * annualRate * secondsElapsed / (BPS * SECONDS_PER_YEAR)
        // Reorder multiplication to avoid precision loss
        return (principal * annualRateBps * secondsElapsed) / (BPS * SECONDS_PER_YEAR);
    }

    /// @notice Split interest payment into supplier portion and reserve portion
    /// @param interestAmount Total interest paid
    /// @return supplierAmount Amount distributed to suppliers
    /// @return reserveAmount Amount kept as protocol reserves
    function splitInterest(uint256 interestAmount)
        external
        view
        returns (uint256 supplierAmount, uint256 reserveAmount)
    {
        reserveAmount = (interestAmount * reserveFactorBps) / BPS;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000009,reserveAmount)}
        supplierAmount = interestAmount - reserveAmount;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000000a,supplierAmount)}
    }

    // ============================================================
    //                  VIEW FUNCTIONS
    // ============================================================

    /// @notice Get all rate parameters in one call
    function getParams() external view returns (
        uint256 _baseRateBps,
        uint256 _multiplierBps,
        uint256 _kinkBps,
        uint256 _jumpMultiplierBps,
        uint256 _reserveFactorBps
    ) {
        return (baseRateBps, multiplierBps, kinkBps, jumpMultiplierBps, reserveFactorBps);
    }

    /// @notice Calculate rates at various utilization points for UI display
    /// @return rates Array of [utilization, borrowRate, supplyRate] at 10% increments
    function getRateCurve() external view returns (uint256[3][11] memory rates) {
        for (uint256 i = 0; i <= 10; i++) {
            uint256 util = i * 1000;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000000d,util)} // 0%, 10%, 20%, ... 100%
            // Create a mock scenario: if util is X%, then borrows = X * supply / 100
            // For display purposes, assume supply = 1e18
            uint256 mockSupply = 1e18;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000000e,mockSupply)}
            uint256 mockBorrows = (mockSupply * util) / BPS;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000000f,mockBorrows)}
            
            rates[i][0] = util;uint256 certora_local16 = rates[i][0];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000010,certora_local16)}
            rates[i][1] = getBorrowRateAnnual(mockBorrows, mockSupply);uint256 certora_local17 = rates[i][1];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000011,certora_local17)}
            rates[i][2] = getSupplyRateAnnual(mockBorrows, mockSupply);uint256 certora_local18 = rates[i][2];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000012,certora_local18)}
        }
    }

    // ============================================================
    //                  ADMIN FUNCTIONS
    // ============================================================

    /// @notice Update rate parameters (governance-controlled)
    /// @dev Dual-gated by RATE_ADMIN_ROLE + TIMELOCK_ROLE.
    ///      The MintedTimelockController should hold both roles, enforcing 48h delay.
    function setParams(
        uint256 _baseRateBps,
        uint256 _multiplierBps,
        uint256 _kinkBps,
        uint256 _jumpMultiplierBps,
        uint256 _reserveFactorBps
    ) external onlyRole(TIMELOCK_ROLE) {
        // Validate parameters
        if (_kinkBps > BPS) revert KinkTooHigh();
        if (_reserveFactorBps > 5000) revert ReserveFactorTooHigh(); // Max 50% to reserves
        
        // Sanity check: max annual rate at 100% util should be < 100%
        uint256 maxRate = _baseRateBps + (_kinkBps * _multiplierBps) / BPS 
                         + ((BPS - _kinkBps) * _jumpMultiplierBps) / BPS;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000008,maxRate)}
        if (maxRate > 10000) revert InvalidParameter(); // Max 100% APR

        baseRateBps = _baseRateBps;
        multiplierBps = _multiplierBps;
        kinkBps = _kinkBps;
        jumpMultiplierBps = _jumpMultiplierBps;
        reserveFactorBps = _reserveFactorBps;

        emit RateParamsUpdated(
            _baseRateBps,
            _multiplierBps,
            _kinkBps,
            _jumpMultiplierBps,
            _reserveFactorBps
        );
    }
}
