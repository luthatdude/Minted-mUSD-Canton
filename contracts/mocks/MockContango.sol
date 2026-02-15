// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../strategies/ContangoLoopStrategy.sol";

/**
 * @title MockContango
 * @notice Mock Contango core-v2 for testing ContangoLoopStrategy
 * @dev Simulates trade() flow: flash loan → supply → borrow → repay flash
 *      In practice, Contango handles this atomically via StrategyBuilder steps.
 *      The mock does simplified position tracking for test purposes.
 */
contract MockContango {
    using SafeERC20 for IERC20;

    struct MockPosition {
        uint256 collateral;
        uint256 debt;
        bool exists;
    }

    IERC20 public usdc;
    address public positionNFTAddr;
    address public vaultAddr;
    
    mapping(bytes32 => MockPosition) public positions;
    uint256 public nextPositionNumber = 1;

    constructor(address _usdc, address _positionNFT, address _vault) {
        usdc = IERC20(_usdc);
        positionNFTAddr = _positionNFT;
        vaultAddr = _vault;
    }

    function positionNFT() external view returns (address) {
        return positionNFTAddr;
    }

    function vault() external view returns (address) {
        return vaultAddr;
    }

    function trade(TradeParams calldata tradeParams, ExecutionParams calldata)
        external
        payable
        returns (bytes32 positionId, Trade memory trade_)
    {
        positionId = tradeParams.positionId;

        if (positionId == bytes32(0)) {
            // New position
            positionId = bytes32(nextPositionNumber);
            nextPositionNumber++;
            positions[positionId].exists = true;
            MockPositionNFT(positionNFTAddr).mint(positionId, msg.sender);
        }

        MockPosition storage pos = positions[positionId];

        if (tradeParams.quantity > 0) {
            // Opening / increasing position
            uint256 additionalCollateral = uint256(tradeParams.quantity);
            uint256 cashflow = tradeParams.cashflow > 0 ? uint256(tradeParams.cashflow) : 0;
            uint256 additionalDebt = additionalCollateral > cashflow ? additionalCollateral - cashflow : 0;

            pos.collateral += additionalCollateral;
            pos.debt += additionalDebt;
        } else {
            // Closing / reducing position
            uint256 reduction = uint256(-tradeParams.quantity);
            if (reduction >= pos.collateral) {
                // Full close
                pos.collateral = 0;
                pos.debt = 0;
            } else {
                // Proportional close
                uint256 proportionalDebt = (pos.debt * reduction) / pos.collateral;
                pos.collateral -= reduction;
                pos.debt -= proportionalDebt;
            }
        }

        trade_ = Trade({
            quantity: tradeParams.quantity,
            swap: SwapInfo({inputCcy: 0, input: 0, output: 0, price: 1e18}),
            cashflowCcy: tradeParams.cashflowCcy,
            cashflow: tradeParams.cashflow,
            fee: 0,
            feeCcy: 0,
            forwardPrice: 1e18
        });
    }

    function tradeOnBehalfOf(
        TradeParams calldata tradeParams,
        ExecutionParams calldata execParams,
        address
    ) external payable returns (bytes32 positionId, Trade memory trade_) {
        return this.trade(tradeParams, execParams);
    }

    function claimRewards(bytes32, address) external {
        // No-op for testing
    }

    function instrument(bytes32) external view returns (Instrument memory) {
        return Instrument({
            base: usdc,
            baseUnit: 1e6,
            quote: usdc,
            quoteUnit: 1e6,
            closingOnly: false
        });
    }

    // Helper: get position data for lens
    function getPosition(bytes32 positionId) external view returns (uint256 collateral, uint256 debt) {
        return (positions[positionId].collateral, positions[positionId].debt);
    }

    // Helper: seed USDC liquidity
    function seedLiquidity(uint256 amount) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }
}

/**
 * @title MockContangoVault
 * @notice Mock Contango Vault — simplified token custody
 */
contract MockContangoVault {
    using SafeERC20 for IERC20;

    mapping(address => mapping(address => uint256)) public balances;

    function depositTo(IERC20 token, address account, uint256 amount) external {
        token.safeTransferFrom(msg.sender, address(this), amount);
        balances[address(token)][account] += amount;
    }

    function withdraw(IERC20 token, address account, uint256 amount, address to) external {
        require(balances[address(token)][account] >= amount, "Insufficient balance");
        balances[address(token)][account] -= amount;
        token.safeTransfer(to, amount);
    }

    function balanceOf(IERC20 token, address account) external view returns (uint256) {
        return balances[address(token)][account];
    }
}

/**
 * @title MockContangoLens
 * @notice Mock Contango Lens — position read-only data
 */
contract MockContangoLens {
    MockContango public contango;

    constructor(address _contango) {
        contango = MockContango(_contango);
    }

    function balances(bytes32 positionId) external view returns (Balances memory) {
        (uint256 collateral, uint256 debt) = contango.getPosition(positionId);
        return Balances({collateral: collateral, debt: debt});
    }

    function leverage(bytes32 positionId) external view returns (uint256) {
        (uint256 collateral, uint256 debt) = contango.getPosition(positionId);
        if (collateral == 0) return 1e18;
        uint256 netValue = collateral > debt ? collateral - debt : 1;
        return (collateral * 1e18) / netValue;
    }

    function netRate(bytes32) external pure returns (int256) {
        return 0.02e18; // Mock: 2% net rate
    }

    function rates(bytes32) external pure returns (uint256 borrowing, uint256 lending) {
        borrowing = 0.05e18; // 5% borrow
        lending = 0.03e18;   // 3% lend
    }

    function metaData(bytes32 positionId) external view returns (MetaData memory) {
        (uint256 collateral, uint256 debt) = contango.getPosition(positionId);
        uint256 hf = debt > 0 ? (collateral * 1e18) / debt : type(uint256).max;
        uint256 lev = collateral > debt ? (collateral * 1e18) / (collateral - debt) : 1e18;
        return MetaData({
            balances: Balances({collateral: collateral, debt: debt}),
            leverage: lev,
            netRate: 0.02e18,
            healthFactor: hf
        });
    }
}

/**
 * @title MockPositionNFT
 * @notice Mock ERC721-like position tracking
 */
contract MockPositionNFT {
    mapping(bytes32 => bool) public existsMap;
    mapping(bytes32 => address) public positionOwners;
    mapping(address => mapping(address => bool)) public approvals;

    function mint(bytes32 positionId, address owner) external {
        existsMap[positionId] = true;
        positionOwners[positionId] = owner;
    }

    function exists(bytes32 positionId) external view returns (bool) {
        return existsMap[positionId];
    }

    function positionOwner(bytes32 positionId) external view returns (address) {
        return positionOwners[positionId];
    }

    function setApprovalForAll(address operator, bool approved) external {
        approvals[msg.sender][operator] = approved;
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return approvals[owner][operator];
    }
}
