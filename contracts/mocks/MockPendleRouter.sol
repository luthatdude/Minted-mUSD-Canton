// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../strategies/PendleStrategyV2.sol";

/**
 * @title MockPendleRouter
 * @notice Mock implementation of Pendle's ActionSwapPTYT router for tests.
 * @dev   Bytecode is injected at the hardcoded PENDLE_ROUTER address via
 *        `hardhat_setCode` + `hardhat_setStorageAt`.
 *
 * Storage layout (slots set externally):
 *   slot 0 → USDC address
 *   slot 1 → PT address
 *   slot 2 → ptPerUsdc  (how many PT per 1 USDC, 6-dec scale, e.g. 1e6 = 1:1)
 *   slot 3 → usdcPerPt  (how many USDC per 1 PT, 6-dec scale, e.g. 1e6 = 1:1)
 */
contract MockPendleRouter {
    using SafeERC20 for IERC20;

    IERC20 public usdc;
    IERC20 public pt;
    uint256 public ptPerUsdc;   // 6-dec scale
    uint256 public usdcPerPt;   // 6-dec scale

    constructor(address _usdc, address _pt) {
        usdc = IERC20(_usdc);
        pt = IERC20(_pt);
        ptPerUsdc = 1e6;
        usdcPerPt = 1e6;
    }

    // ─── swapExactTokenForPt ─────────────────────────────────────────
    function swapExactTokenForPt(
        address receiver,
        address, /* market */
        uint256, /* minPtOut */
        IPendleRouter.ApproxParams calldata, /* guessPtOut */
        IPendleRouter.TokenInput calldata input,
        IPendleRouter.LimitOrderData calldata /* limit */
    ) external payable returns (uint256 netPtOut, uint256 netSyFee, uint256 netSyInterm) {
        uint256 usdcIn = input.netTokenIn;
        usdc.safeTransferFrom(msg.sender, address(this), usdcIn);

        netPtOut = (usdcIn * ptPerUsdc) / 1e6;
        // Mint PT to receiver (assumes MockERC20 with public mint)
        IMockMintable(address(pt)).mint(receiver, netPtOut);

        netSyFee = 0;
        netSyInterm = 0;
    }

    // ─── swapExactPtForToken ─────────────────────────────────────────
    function swapExactPtForToken(
        address receiver,
        address, /* market */
        uint256 exactPtIn,
        IPendleRouter.TokenOutput calldata, /* output */
        IPendleRouter.LimitOrderData calldata /* limit */
    ) external returns (uint256 netTokenOut, uint256 netSyFee, uint256 netSyInterm) {
        pt.safeTransferFrom(msg.sender, address(this), exactPtIn);

        netTokenOut = (exactPtIn * usdcPerPt) / 1e6;
        // Transfer USDC to receiver
        usdc.safeTransfer(receiver, netTokenOut);

        netSyFee = 0;
        netSyInterm = 0;
    }

    // ─── redeemPyToToken ─────────────────────────────────────────────
    function redeemPyToToken(
        address receiver,
        address, /* YT */
        uint256 netPyIn,
        IPendleRouter.TokenOutput calldata /* output */
    ) external returns (uint256 netTokenOut, uint256 netSyFee) {
        pt.safeTransferFrom(msg.sender, address(this), netPyIn);

        // At maturity PT redeems 1:1
        netTokenOut = (netPyIn * usdcPerPt) / 1e6;
        usdc.safeTransfer(receiver, netTokenOut);

        netSyFee = 0;
    }
}

interface IMockMintable {
    function mint(address to, uint256 amount) external;
}
