// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// ═══════════════════════════════════════════════════════════════════════════
//                     MOCK FLUID VAULT T1  (Normal / Normal)
// ═══════════════════════════════════════════════════════════════════════════
// Simulates syrupUSDC supply / USDC borrow (Vault #146)

contract MockFluidVaultT1 {
    using SafeERC20 for IERC20;

    IERC20 public immutable supplyToken;
    IERC20 public immutable borrowToken_;

    uint256 public nextNftId = 1;

    // Position data:  nftId → (collateral, debt)
    mapping(uint256 => uint256) public collateral;
    mapping(uint256 => uint256) public debt;
    mapping(uint256 => address) public positionOwner;

    constructor(address _supplyToken, address _borrowToken) {
        supplyToken = IERC20(_supplyToken);
        borrowToken_ = IERC20(_borrowToken);
    }

    /// @notice Fluid T1 operate: 4-param version
    function operate(
        uint256 nftId_,
        int256 newCol_,
        int256 newDebt_,
        address to_
    ) external payable returns (uint256 nftId, int256 supplyAmt, int256 borrowAmt) {
        if (to_ == address(0)) to_ = msg.sender;

        // Create new position if nftId_ == 0
        if (nftId_ == 0) {
            nftId = nextNftId++;
            positionOwner[nftId] = msg.sender;
        } else {
            nftId = nftId_;
        }

        // Handle collateral
        if (newCol_ > 0) {
            // Deposit collateral
            supplyToken.safeTransferFrom(msg.sender, address(this), uint256(newCol_));
            collateral[nftId] += uint256(newCol_);
            supplyAmt = newCol_;
        } else if (newCol_ < 0) {
            // Withdraw collateral
            uint256 amt = uint256(-newCol_);
            if (amt > collateral[nftId]) amt = collateral[nftId];
            collateral[nftId] -= amt;
            supplyToken.safeTransfer(to_, amt);
            supplyAmt = -int256(amt);
        }

        // Handle debt
        if (newDebt_ > 0) {
            // Borrow
            debt[nftId] += uint256(newDebt_);
            borrowToken_.safeTransfer(to_, uint256(newDebt_));
            borrowAmt = newDebt_;
        } else if (newDebt_ < 0) {
            // Repay
            uint256 amt = uint256(-newDebt_);
            if (amt > debt[nftId]) amt = debt[nftId];
            borrowToken_.safeTransferFrom(msg.sender, address(this), amt);
            debt[nftId] -= amt;
            borrowAmt = -int256(amt);
        }
    }

    function VAULT_ID() external pure returns (uint256) { return 146; }

    // ─── Test helpers ────────────────────────────────────────────────
    function seedLiquidity(address token, uint256 amount) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

    function simulateInterest(uint256 nftId_, uint256 extraDebt) external {
        debt[nftId_] += extraDebt;
    }

    function getPosition(uint256 nftId_) external view returns (uint256 col, uint256 dbt) {
        return (collateral[nftId_], debt[nftId_]);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//                     MOCK FLUID VAULT T2  (Smart Col / Normal Debt)
// ═══════════════════════════════════════════════════════════════════════════
// Simulates weETH-ETH LP (supply) / wstETH (borrow) (Vault #74)

contract MockFluidVaultT2 {
    using SafeERC20 for IERC20;

    IERC20 public immutable colToken0;  // weETH
    IERC20 public immutable colToken1;  // ETH (WETH)
    IERC20 public immutable debtToken;  // wstETH

    uint256 public nextNftId = 1;

    mapping(uint256 => uint256) public collateral0;
    mapping(uint256 => uint256) public collateral1;
    mapping(uint256 => uint256) public debt;
    mapping(uint256 => address) public positionOwner;

    constructor(address _colToken0, address _colToken1, address _debtToken) {
        colToken0 = IERC20(_colToken0);
        colToken1 = IERC20(_colToken1);
        debtToken = IERC20(_debtToken);
    }

    /// @notice Fluid T2 operate: 6-param version
    function operate(
        uint256 nftId_,
        int256 newColToken0_,
        int256 newColToken1_,
        int256, /* colSharesMinMax_ */
        int256 newDebt_,
        address to_
    ) external payable returns (uint256 nftId, int256 supplyAmt, int256 borrowAmt) {
        if (to_ == address(0)) to_ = msg.sender;

        if (nftId_ == 0) {
            nftId = nextNftId++;
            positionOwner[nftId] = msg.sender;
        } else {
            nftId = nftId_;
        }

        // Collateral token0
        if (newColToken0_ > 0) {
            colToken0.safeTransferFrom(msg.sender, address(this), uint256(newColToken0_));
            collateral0[nftId] += uint256(newColToken0_);
        } else if (newColToken0_ < 0) {
            uint256 amt = uint256(-newColToken0_);
            if (amt > collateral0[nftId]) amt = collateral0[nftId];
            collateral0[nftId] -= amt;
            colToken0.safeTransfer(to_, amt);
        }

        // Collateral token1
        if (newColToken1_ > 0) {
            colToken1.safeTransferFrom(msg.sender, address(this), uint256(newColToken1_));
            collateral1[nftId] += uint256(newColToken1_);
        } else if (newColToken1_ < 0) {
            uint256 amt = uint256(-newColToken1_);
            if (amt > collateral1[nftId]) amt = collateral1[nftId];
            collateral1[nftId] -= amt;
            colToken1.safeTransfer(to_, amt);
        }

        supplyAmt = newColToken0_ + newColToken1_;

        // Debt
        if (newDebt_ > 0) {
            debt[nftId] += uint256(newDebt_);
            debtToken.safeTransfer(to_, uint256(newDebt_));
            borrowAmt = newDebt_;
        } else if (newDebt_ < 0) {
            uint256 amt = uint256(-newDebt_);
            if (amt > debt[nftId]) amt = debt[nftId];
            debtToken.safeTransferFrom(msg.sender, address(this), amt);
            debt[nftId] -= amt;
            borrowAmt = -int256(amt);
        }
    }

    function VAULT_ID() external pure returns (uint256) { return 74; }

    function seedLiquidity(address token, uint256 amount) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

    function simulateInterest(uint256 nftId_, uint256 extraDebt) external {
        debt[nftId_] += extraDebt;
    }

    function getPosition(uint256 nftId_) external view returns (uint256 col0, uint256 col1, uint256 dbt) {
        return (collateral0[nftId_], collateral1[nftId_], debt[nftId_]);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//                     MOCK FLUID VAULT T4  (Smart Col / Smart Debt)
// ═══════════════════════════════════════════════════════════════════════════
// Simulates wstETH-ETH LP (supply) / wstETH-ETH LP (borrow) (Vault #44)

contract MockFluidVaultT4 {
    using SafeERC20 for IERC20;

    IERC20 public immutable colToken0;  // wstETH
    IERC20 public immutable colToken1;  // ETH (WETH)
    IERC20 public immutable debtToken0; // wstETH
    IERC20 public immutable debtToken1; // ETH (WETH)

    uint256 public nextNftId = 1;

    mapping(uint256 => uint256) public collateral0;
    mapping(uint256 => uint256) public collateral1;
    mapping(uint256 => uint256) public debt0;
    mapping(uint256 => uint256) public debt1;
    mapping(uint256 => address) public positionOwner;

    constructor(address _colToken0, address _colToken1, address _debtToken0, address _debtToken1) {
        colToken0 = IERC20(_colToken0);
        colToken1 = IERC20(_colToken1);
        debtToken0 = IERC20(_debtToken0);
        debtToken1 = IERC20(_debtToken1);
    }

    /// @notice Fluid T4 operate: 8-param version
    function operate(
        uint256 nftId_,
        int256 newColToken0_,
        int256 newColToken1_,
        int256, /* colSharesMinMax_ */
        int256 newDebtToken0_,
        int256 newDebtToken1_,
        int256, /* debtSharesMinMax_ */
        address to_
    ) external payable returns (uint256 nftId, int256 supplyAmt, int256 borrowAmt) {
        if (to_ == address(0)) to_ = msg.sender;

        if (nftId_ == 0) {
            nftId = nextNftId++;
            positionOwner[nftId] = msg.sender;
        } else {
            nftId = nftId_;
        }

        // Collateral token0
        if (newColToken0_ > 0) {
            colToken0.safeTransferFrom(msg.sender, address(this), uint256(newColToken0_));
            collateral0[nftId] += uint256(newColToken0_);
        } else if (newColToken0_ < 0) {
            uint256 amt = uint256(-newColToken0_);
            if (amt > collateral0[nftId]) amt = collateral0[nftId];
            collateral0[nftId] -= amt;
            colToken0.safeTransfer(to_, amt);
        }

        // Collateral token1
        if (newColToken1_ > 0) {
            colToken1.safeTransferFrom(msg.sender, address(this), uint256(newColToken1_));
            collateral1[nftId] += uint256(newColToken1_);
        } else if (newColToken1_ < 0) {
            uint256 amt = uint256(-newColToken1_);
            if (amt > collateral1[nftId]) amt = collateral1[nftId];
            collateral1[nftId] -= amt;
            colToken1.safeTransfer(to_, amt);
        }

        supplyAmt = newColToken0_ + newColToken1_;

        // Debt token0
        if (newDebtToken0_ > 0) {
            debt0[nftId] += uint256(newDebtToken0_);
            debtToken0.safeTransfer(to_, uint256(newDebtToken0_));
        } else if (newDebtToken0_ < 0) {
            uint256 amt = uint256(-newDebtToken0_);
            if (amt > debt0[nftId]) amt = debt0[nftId];
            debtToken0.safeTransferFrom(msg.sender, address(this), amt);
            debt0[nftId] -= amt;
        }

        // Debt token1
        if (newDebtToken1_ > 0) {
            debt1[nftId] += uint256(newDebtToken1_);
            debtToken1.safeTransfer(to_, uint256(newDebtToken1_));
        } else if (newDebtToken1_ < 0) {
            uint256 amt = uint256(-newDebtToken1_);
            if (amt > debt1[nftId]) amt = debt1[nftId];
            debtToken1.safeTransferFrom(msg.sender, address(this), amt);
            debt1[nftId] -= amt;
        }

        borrowAmt = newDebtToken0_ + newDebtToken1_;
    }

    function VAULT_ID() external pure returns (uint256) { return 44; }

    function seedLiquidity(address token, uint256 amount) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

    function simulateInterest(uint256 nftId_, uint256 extraDebt0, uint256 extraDebt1) external {
        debt0[nftId_] += extraDebt0;
        debt1[nftId_] += extraDebt1;
    }

    function getPosition(uint256 nftId_) external view returns (
        uint256 col0, uint256 col1, uint256 dbt0, uint256 dbt1
    ) {
        return (collateral0[nftId_], collateral1[nftId_], debt0[nftId_], debt1[nftId_]);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//                     MOCK FLUID VAULT FACTORY
// ═══════════════════════════════════════════════════════════════════════════

contract MockFluidVaultFactory {
    mapping(uint256 => address) public vaults;
    mapping(uint256 => address) public nftOwners;
    uint256 public totalVaultCount;

    function registerVault(uint256 vaultId, address vault) external {
        vaults[vaultId] = vault;
        totalVaultCount++;
    }

    function totalVaults() external view returns (uint256) {
        return totalVaultCount;
    }

    function getVaultAddress(uint256 vaultId) external view returns (address) {
        return vaults[vaultId];
    }

    function ownerOf(uint256 nftId) external view returns (address) {
        return nftOwners[nftId];
    }

    function setOwner(uint256 nftId, address owner) external {
        nftOwners[nftId] = owner;
    }

    function transferFrom(address, address to, uint256 nftId) external {
        nftOwners[nftId] = to;
    }

    function approve(address, uint256) external {}
}
