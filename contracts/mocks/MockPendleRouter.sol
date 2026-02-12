// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IPendleRouter.sol";

/**
 * @title MockPendleRouter
 * @notice Mock Pendle Router for testing PendleStrategyV2.
 *         Simulates swapExactTokenForPt, swapExactPtForToken, and redeemPyToToken.
 */
contract MockPendleRouter is IPendleRouter {
    using SafeERC20 for IERC20;

    address public usdc;
    address public ptToken;

    /// @dev Simulated exchange rate: how many PT per 1 USDC (in 1e6 precision for USDC)
    /// Default 1:1 — 1 USDC = 1 PT
    uint256 public ptPerUsdc = 1e6;

    /// @dev Simulated redemption rate: how many USDC per 1 PT (in 1e6 precision)
    uint256 public usdcPerPt = 1e6;

    /// @dev If true, reverts on next call (for failure testing)
    bool public shouldRevert;
    string public revertReason;

    constructor(address _usdc, address _ptToken) {
        usdc = _usdc;
        ptToken = _ptToken;
    }

    // ── Test helpers ──────────────────────────────────────────

    function setRates(uint256 _ptPerUsdc, uint256 _usdcPerPt) external {
        ptPerUsdc = _ptPerUsdc;
        usdcPerPt = _usdcPerPt;
    }

    function setShouldRevert(bool _shouldRevert, string calldata _reason) external {
        shouldRevert = _shouldRevert;
        revertReason = _reason;
    }

    // ── IPendleRouter implementation ─────────────────────────

    /// @notice Swap USDC → PT
    function swapExactTokenForPt(
        address receiver,
        address /* market */,
        uint256 /* minPtOut */,
        ApproxParams calldata /* guessPtOut */,
        TokenInput calldata input,
        LimitOrderData calldata /* limit */
    ) external payable override returns (uint256 netPtOut, uint256 netSyFee, uint256 netSyInterm) {
        if (shouldRevert) {
            revert(revertReason);
        }

        uint256 usdcIn = input.netTokenIn;
        // Pull USDC from strategy
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), usdcIn);

        // Mint PT to receiver (1:1 by default)
        netPtOut = (usdcIn * ptPerUsdc) / 1e6;
        IMockPT(ptToken).mint(receiver, netPtOut);

        netSyFee = 0;
        netSyInterm = 0;
    }

    /// @notice Redeem PT → USDC after maturity
    function redeemPyToToken(
        address receiver,
        address /* YT */,
        uint256 netPyIn,
        TokenOutput calldata /* output */
    ) external override returns (uint256 netTokenOut, uint256 netSyFee) {
        if (shouldRevert) {
            revert(revertReason);
        }

        // Burn PT from strategy
        IERC20(ptToken).safeTransferFrom(msg.sender, address(this), netPyIn);
        IMockPT(ptToken).burn(address(this), netPyIn);

        // Send USDC to receiver (1:1 at maturity)
        netTokenOut = (netPyIn * usdcPerPt) / 1e6;
        IMockERC20(usdc).mint(receiver, netTokenOut);

        netSyFee = 0;
    }

    /// @notice Swap PT → USDC before maturity
    function swapExactPtForToken(
        address receiver,
        address /* market */,
        uint256 exactPtIn,
        TokenOutput calldata /* output */,
        LimitOrderData calldata /* limit */
    ) external override returns (uint256 netTokenOut, uint256 netSyFee, uint256 netSyInterm) {
        if (shouldRevert) {
            revert(revertReason);
        }

        // Burn PT from strategy
        IERC20(ptToken).safeTransferFrom(msg.sender, address(this), exactPtIn);
        IMockPT(ptToken).burn(address(this), exactPtIn);

        // Send USDC to receiver (at market rate)
        netTokenOut = (exactPtIn * usdcPerPt) / 1e6;
        IMockERC20(usdc).mint(receiver, netTokenOut);

        netSyFee = 0;
        netSyInterm = 0;
    }
}

/// @dev Interface for mint/burn on mock tokens
interface IMockPT {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}

interface IMockERC20 {
    function mint(address to, uint256 amount) external;
}
