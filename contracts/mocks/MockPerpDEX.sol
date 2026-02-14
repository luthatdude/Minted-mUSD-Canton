// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockPerpDEX
 * @notice Mock perpetual DEX for testing BasisTradingStrategy
 * @dev Simulates margin deposits, short positions, funding payments, and PnL
 */
contract MockPerpDEX {
    using SafeERC20 for IERC20;

    IERC20 public usdc;

    // Margin balances per account
    mapping(address => uint256) public marginBalance;

    // Position tracking
    struct Position {
        address owner;
        bytes32 market;
        uint256 size;      // Notional USD (6 decimals)
        bool isOpen;
        int256 mockPnl;    // Configurable PnL for testing
        int256 mockFunding; // Configurable funding for testing
    }

    mapping(bytes32 => Position) public positionData;
    uint256 private _nextPositionId;

    // Mock funding rates per market (annualized, WAD)
    mapping(bytes32 => int256) public mockFundingRates;

    constructor(address _usdc) {
        usdc = IERC20(_usdc);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // IPerpDEX IMPLEMENTATION
    // ═══════════════════════════════════════════════════════════════════════

    function depositMargin(uint256 amount) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        marginBalance[msg.sender] += amount;
    }

    function withdrawMargin(uint256 amount) external {
        require(marginBalance[msg.sender] >= amount, "Insufficient margin");
        marginBalance[msg.sender] -= amount;
        usdc.safeTransfer(msg.sender, amount);
    }

    function openShort(
        bytes32 market,
        uint256 sizeUsd,
        uint256 /* maxSlippageBps */
    ) external returns (bytes32 positionId) {
        _nextPositionId++;
        positionId = keccak256(abi.encodePacked(msg.sender, market, _nextPositionId));

        positionData[positionId] = Position({
            owner: msg.sender,
            market: market,
            size: sizeUsd,
            isOpen: true,
            mockPnl: 0,
            mockFunding: 0
        });
    }

    function closePosition(
        bytes32 positionId,
        uint256 /* maxSlippageBps */
    ) external returns (int256 realizedPnl) {
        Position storage pos = positionData[positionId];
        require(pos.isOpen, "Position not open");

        realizedPnl = pos.mockPnl;
        pos.isOpen = false;

        // Apply PnL to margin
        if (realizedPnl > 0) {
            marginBalance[pos.owner] += uint256(realizedPnl);
        } else if (realizedPnl < 0) {
            uint256 loss = uint256(-realizedPnl);
            marginBalance[pos.owner] = marginBalance[pos.owner] > loss
                ? marginBalance[pos.owner] - loss
                : 0;
        }

        // Apply any pending funding
        if (pos.mockFunding > 0) {
            marginBalance[pos.owner] += uint256(pos.mockFunding);
        }

        pos.size = 0;
    }

    function reducePosition(
        bytes32 positionId,
        uint256 reduceByUsd,
        uint256 /* maxSlippageBps */
    ) external returns (int256 realizedPnl) {
        Position storage pos = positionData[positionId];
        require(pos.isOpen, "Position not open");

        // Proportional PnL
        if (pos.size > 0) {
            realizedPnl = (pos.mockPnl * int256(reduceByUsd)) / int256(pos.size);
        }

        pos.size = pos.size > reduceByUsd ? pos.size - reduceByUsd : 0;

        // Apply proportional PnL to margin
        if (realizedPnl > 0) {
            marginBalance[pos.owner] += uint256(realizedPnl);
        } else if (realizedPnl < 0) {
            uint256 loss = uint256(-realizedPnl);
            marginBalance[pos.owner] = marginBalance[pos.owner] > loss
                ? marginBalance[pos.owner] - loss
                : 0;
        }
    }

    function claimFunding(bytes32 positionId) external returns (int256 fundingPayment) {
        Position storage pos = positionData[positionId];
        require(pos.isOpen, "Position not open");

        fundingPayment = pos.mockFunding;
        pos.mockFunding = 0;

        if (fundingPayment > 0) {
            marginBalance[pos.owner] += uint256(fundingPayment);
        } else if (fundingPayment < 0) {
            uint256 cost = uint256(-fundingPayment);
            marginBalance[pos.owner] = marginBalance[pos.owner] > cost
                ? marginBalance[pos.owner] - cost
                : 0;
        }
    }

    function unrealizedPnl(bytes32 positionId) external view returns (int256) {
        return positionData[positionId].mockPnl;
    }

    function positionSize(bytes32 positionId) external view returns (uint256) {
        return positionData[positionId].size;
    }

    function currentFundingRate(bytes32 market) external view returns (int256) {
        return mockFundingRates[market];
    }

    function accruedFunding(bytes32 positionId) external view returns (int256) {
        return positionData[positionId].mockFunding;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TEST HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    function setMockPnl(bytes32 positionId, int256 pnl) external {
        positionData[positionId].mockPnl = pnl;
    }

    function setMockFunding(bytes32 positionId, int256 funding) external {
        positionData[positionId].mockFunding = funding;
    }

    function setMockFundingRate(bytes32 market, int256 rate) external {
        mockFundingRates[market] = rate;
    }

    /// @notice Seed the DEX with USDC liquidity (for PnL payouts)
    function seedLiquidity(uint256 amount) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Get position ID for testing (recompute from params)
    function getPositionId(address owner, bytes32 market, uint256 nonce) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(owner, market, nonce));
    }
}
