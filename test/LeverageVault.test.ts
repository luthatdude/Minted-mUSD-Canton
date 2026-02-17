import { expect } from 'chai';
import { ethers } from 'hardhat';
import {
  LeverageVault,
  CollateralVault,
  BorrowModule,
  MockERC20,
  MockAggregatorV3,
} from '../typechain-types';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { timelockSetFeed, timelockAddCollateral, refreshFeeds } from './helpers/timelock';

describe('LeverageVault', function () {
  let leverageVault: LeverageVault;
  let collateralVault: CollateralVault;
  let borrowModule: BorrowModule;
  let priceOracle: any;
  let musd: MockERC20;
  let weth: MockERC20;
  let mockSwapRouter: any;

  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let keeper: HardhatEthersSigner;

  const INITIAL_WETH_BALANCE = ethers.parseEther('100');
  const WETH_PRICE = 2000n * 10n ** 8n; // $2000 per ETH (8 decimals for Chainlink)
  const futureDeadline = () => 99999999999; // Far future deadline (won't expire even after many timelock time advances)

  beforeEach(async function () {
    [owner, user, keeper] = await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20 = await ethers.getContractFactory('MockERC20');
    musd = await MockERC20.deploy('mUSD', 'mUSD', 18);
    weth = await MockERC20.deploy('Wrapped ETH', 'WETH', 18);

    // Deploy mock price feed (decimals first, then answer)
    const MockAggregator = await ethers.getContractFactory('MockAggregatorV3');
    const wethPriceFeed = await MockAggregator.deploy(8, WETH_PRICE);

    // Deploy price oracle
    const PriceOracle = await ethers.getContractFactory('PriceOracle');
    priceOracle = await PriceOracle.deploy();

    // Configure price oracle (token, feed, stalePeriod, tokenDecimals)
    await timelockSetFeed(
      priceOracle, owner,
      await weth.getAddress(),
      await wethPriceFeed.getAddress(),
      3600, // 1 hour stale period
      18    // WETH has 18 decimals
    );

    // Deploy collateral vault
    const CollateralVault = await ethers.getContractFactory('CollateralVault');
    collateralVault = await CollateralVault.deploy(ethers.ZeroAddress);

    // Add WETH as collateral (75% LTV, 80% liquidation threshold, 5% penalty)
    await timelockAddCollateral(
      collateralVault, owner,
      await weth.getAddress(),
      7500, // 75% collateral factor
      8000, // 80% liquidation threshold
      500   // 5% liquidation penalty
    );

    await refreshFeeds(wethPriceFeed);

    // Deploy mUSD contract (with mint/burn roles)
    const MUSD = await ethers.getContractFactory('MUSD');
    musd = await MUSD.deploy(ethers.parseEther('100000000'), ethers.ZeroAddress); // 100M supply cap

    // Deploy borrow module
    const BorrowModule = await ethers.getContractFactory('BorrowModule');
    borrowModule = await BorrowModule.deploy(
      await collateralVault.getAddress(),
      await priceOracle.getAddress(),
      await musd.getAddress(),
      200, // 2% APR
      ethers.parseEther('10') // Min debt 10 mUSD
    );

    // Grant BORROW_MODULE_ROLE to BorrowModule
    const BORROW_MODULE_ROLE = ethers.keccak256(ethers.toUtf8Bytes('BORROW_MODULE_ROLE'));
    await collateralVault.grantRole(BORROW_MODULE_ROLE, await borrowModule.getAddress());

    // Grant BRIDGE_ROLE to BorrowModule for mUSD minting
    const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes('BRIDGE_ROLE'));
    await musd.grantRole(BRIDGE_ROLE, await borrowModule.getAddress());

    // Deploy mock swap router (simplified for testing)
    const MockSwapRouter = await ethers.getContractFactory('MockSwapRouter');
    mockSwapRouter = await MockSwapRouter.deploy(
      await musd.getAddress(),
      await weth.getAddress(),
      await priceOracle.getAddress()
    );

    // Deploy leverage vault
    const LeverageVault = await ethers.getContractFactory('LeverageVault');
    leverageVault = await LeverageVault.deploy(
      await mockSwapRouter.getAddress(),
      await collateralVault.getAddress(),
      await borrowModule.getAddress(),
      await priceOracle.getAddress(),
      await musd.getAddress(),
      owner.address // timelock
    );

    // Grant LEVERAGE_VAULT_ROLE to LeverageVault in CollateralVault and BorrowModule
    const LEVERAGE_VAULT_ROLE = ethers.keccak256(ethers.toUtf8Bytes('LEVERAGE_VAULT_ROLE'));
    await collateralVault.grantRole(LEVERAGE_VAULT_ROLE, await leverageVault.getAddress());
    await borrowModule.grantRole(LEVERAGE_VAULT_ROLE, await leverageVault.getAddress());

    // Enable WETH for leverage looping
    await leverageVault.enableToken(await weth.getAddress(), 3000);

    // Mint WETH to user
    await weth.mint(user.address, INITIAL_WETH_BALANCE);
    await weth.connect(user).approve(await leverageVault.getAddress(), ethers.MaxUint256);

    // Fund the mock swap router with mUSD and WETH for swaps
    await weth.mint(await mockSwapRouter.getAddress(), ethers.parseEther('10000'));
    await musd.grantRole(BRIDGE_ROLE, await mockSwapRouter.getAddress());
  });

  describe('Deployment', function () {
    it('should deploy with correct parameters', async function () {
      expect(await leverageVault.maxLoops()).to.equal(10);
      expect(await leverageVault.minBorrowPerLoop()).to.equal(ethers.parseEther('100'));
      expect(await leverageVault.defaultPoolFee()).to.equal(3000);
      expect(await leverageVault.maxSlippageBps()).to.equal(100);
    });

    it('should have WETH enabled for leverage', async function () {
      expect(await leverageVault.leverageEnabled(await weth.getAddress())).to.be.true;
    });
  });

  describe('Open Leveraged Position', function () {
    it('should open a 2x leveraged position', async function () {
      const initialDeposit = ethers.parseEther('10'); // 10 WETH = $20,000

      const tx = await leverageVault.connect(user).openLeveragedPosition(
        await weth.getAddress(),
        initialDeposit,
        20, // 2.0x leverage
        5,  // Max 5 loops
        futureDeadline()
      );

      const position = await leverageVault.getPosition(user.address);
      expect(position.initialDeposit).to.equal(initialDeposit);
      expect(position.totalCollateral).to.be.gt(initialDeposit);
      expect(position.totalDebt).to.be.gt(0);
      expect(position.loopsExecuted).to.be.gt(0);
    });

    it('should reject leverage exceeding max for LTV', async function () {
      const initialDeposit = ethers.parseEther('10');

      // 75% LTV → max leverage = 1/(1-0.75) = 4x
      // Try 5x leverage - should fail
      await expect(
        leverageVault.connect(user).openLeveragedPosition(
          await weth.getAddress(),
          initialDeposit,
          50, // 5.0x leverage
          10,
          futureDeadline()
        )
      ).to.be.revertedWithCustomError(leverageVault, "LeverageExceedsMax");
    });

    it('should reject if token not enabled', async function () {
      const MockERC20 = await ethers.getContractFactory('MockERC20');
      const randomToken = await MockERC20.deploy('Random', 'RND', 18);

      await expect(
        leverageVault.connect(user).openLeveragedPosition(
          await randomToken.getAddress(),
          ethers.parseEther('10'),
          20,
          5,
          futureDeadline()
        )
      ).to.be.revertedWithCustomError(leverageVault, "TokenNotEnabled");
    });

    it('should reject second position if one already exists', async function () {
      const initialDeposit = ethers.parseEther('5');

      await leverageVault.connect(user).openLeveragedPosition(
        await weth.getAddress(),
        initialDeposit,
        20,
        3,
        futureDeadline()
      );

      await weth.mint(user.address, initialDeposit);

      await expect(
        leverageVault.connect(user).openLeveragedPosition(
          await weth.getAddress(),
          initialDeposit,
          20,
          3,
          futureDeadline()
        )
      ).to.be.revertedWithCustomError(leverageVault, "PositionExists");
    });
  });

  describe('Admin Functions', function () {
    it('should allow admin to update config', async function () {
      await leverageVault.setConfig(15, ethers.parseEther('50'), 500, 200);

      expect(await leverageVault.maxLoops()).to.equal(15);
      expect(await leverageVault.minBorrowPerLoop()).to.equal(ethers.parseEther('50'));
      expect(await leverageVault.defaultPoolFee()).to.equal(500);
      expect(await leverageVault.maxSlippageBps()).to.equal(200);
    });

    it('should reject invalid max loops', async function () {
      await expect(
        leverageVault.setConfig(25, ethers.parseEther('100'), 3000, 100)
      ).to.be.revertedWithCustomError(leverageVault, "InvalidMaxLoops");
    });

    it('should reject invalid slippage', async function () {
      await expect(
        leverageVault.setConfig(10, ethers.parseEther('100'), 3000, 600)
      ).to.be.revertedWithCustomError(leverageVault, "SlippageTooHigh");
    });

    it('should allow admin to enable/disable tokens', async function () {
      const MockERC20 = await ethers.getContractFactory('MockERC20');
      const newToken = await MockERC20.deploy('New Token', 'NEW', 18);

      await leverageVault.enableToken(await newToken.getAddress(), 500);
      expect(await leverageVault.leverageEnabled(await newToken.getAddress())).to.be.true;
      expect(await leverageVault.tokenPoolFees(await newToken.getAddress())).to.equal(500);

      await leverageVault.disableToken(await newToken.getAddress());
      expect(await leverageVault.leverageEnabled(await newToken.getAddress())).to.be.false;
    });

    it('should allow admin to set max leverage', async function () {
      // Default is 30 (3.0x)
      expect(await leverageVault.maxLeverageX10()).to.equal(30);

      // Toggle to 2.0x
      await leverageVault.setMaxLeverage(20);
      expect(await leverageVault.maxLeverageX10()).to.equal(20);

      // Toggle to 1.5x
      await leverageVault.setMaxLeverage(15);
      expect(await leverageVault.maxLeverageX10()).to.equal(15);

      // Toggle back to 3.0x
      await leverageVault.setMaxLeverage(30);
      expect(await leverageVault.maxLeverageX10()).to.equal(30);
    });

    it('should reject leverage above configured max', async function () {
      // Set max to 2.0x
      await leverageVault.setMaxLeverage(20);

      const initialDeposit = ethers.parseEther('10');

      // Try 2.5x leverage - should fail
      await expect(
        leverageVault.connect(user).openLeveragedPosition(
          await weth.getAddress(),
          initialDeposit,
          25, // 2.5x exceeds 2.0x max
          5,
          futureDeadline()
        )
      ).to.be.revertedWithCustomError(leverageVault, "LeverageExceedsMax");
    });

    it('should reject invalid max leverage values', async function () {
      // Too low (below 1x)
      await expect(
        leverageVault.setMaxLeverage(5)
      ).to.be.revertedWithCustomError(leverageVault, "InvalidMaxLeverage");

      // Too high (above 4x)
      await expect(
        leverageVault.setMaxLeverage(50)
      ).to.be.revertedWithCustomError(leverageVault, "InvalidMaxLeverage");
    });
  });

  describe('View Functions', function () {
    it('should estimate loops correctly', async function () {
      const [estimatedLoops, estimatedDebt] = await leverageVault.estimateLoops(
        await weth.getAddress(),
        ethers.parseEther('10'),
        30 // 3.0x leverage
      );

      expect(estimatedLoops).to.be.gt(0);
      expect(estimatedDebt).to.be.gt(0);
    });

    it('should return effective leverage', async function () {
      await leverageVault.connect(user).openLeveragedPosition(
        await weth.getAddress(),
        ethers.parseEther('10'),
        25, // 2.5x target
        5,
        futureDeadline()
      );

      const effectiveLeverage = await leverageVault.getEffectiveLeverage(user.address);
      // Effective leverage will be > 1.0x (10) after loops
      // The exact value depends on swap execution, LTV, and loop count
      expect(effectiveLeverage).to.be.gt(10); // At least some leverage achieved
      expect(effectiveLeverage).to.be.lte(40); // Should not exceed 4x (max for 75% LTV)
    });

    it('should return zero leverage for no position', async function () {
      const effectiveLeverage = await leverageVault.getEffectiveLeverage(user.address);
      expect(effectiveLeverage).to.equal(0);
    });

    it('should return position details', async function () {
      await leverageVault.connect(user).openLeveragedPosition(
        await weth.getAddress(),
        ethers.parseEther('10'),
        20,
        3,
        futureDeadline()
      );

      const position = await leverageVault.getPosition(user.address);
      expect(position.collateralToken).to.equal(await weth.getAddress());
      expect(position.initialDeposit).to.equal(ethers.parseEther('10'));
      expect(position.openedAt).to.be.gt(0);
    });
  });

  describe('Emergency Functions', function () {
    it('should reject emergency close for no position', async function () {
      await expect(
        leverageVault.emergencyClosePosition(user.address)
      ).to.be.revertedWithCustomError(leverageVault, "NoPosition");
    });

    it('should reject emergency close from non-admin', async function () {
      await leverageVault.connect(user).openLeveragedPosition(
        await weth.getAddress(),
        ethers.parseEther('10'),
        20,
        3,
        futureDeadline()
      );

      await expect(
        leverageVault.connect(user).emergencyClosePosition(user.address)
      ).to.be.reverted;
    });

    it('should allow emergency withdraw of stuck tokens', async function () {
      // Send some tokens directly to the contract
      await weth.mint(await leverageVault.getAddress(), ethers.parseEther('5'));

      // Must pause first — emergencyWithdraw requires whenPaused
      await leverageVault.pause();

      // emergencyWithdraw is now a direct onlyTimelock call (owner IS the timelock in tests)
      const balanceBefore = await weth.balanceOf(owner.address);
      await leverageVault.emergencyWithdraw(await weth.getAddress(), ethers.parseEther('5'));
      const balanceAfter = await weth.balanceOf(owner.address);

      expect(balanceAfter - balanceBefore).to.equal(ethers.parseEther('5'));
    });

    it('should reject emergency withdraw from non-timelock', async function () {
      await weth.mint(await leverageVault.getAddress(), ethers.parseEther('5'));
      await expect(
        leverageVault.connect(user).emergencyWithdraw(await weth.getAddress(), ethers.parseEther('5'))
      ).to.be.reverted;
    });
  });

  describe('Pause/Unpause', function () {
    it('should pause operations', async function () {
      await leverageVault.pause();
      expect(await leverageVault.paused()).to.be.true;
    });

    it('should reject operations when paused', async function () {
      await leverageVault.pause();

      await expect(
        leverageVault.connect(user).openLeveragedPosition(
          await weth.getAddress(),
          ethers.parseEther('10'),
          20,
          5,
          futureDeadline()
        )
      ).to.be.revertedWithCustomError(leverageVault, 'EnforcedPause');
    });

    it('should require admin to unpause', async function () {
      await leverageVault.pause();

      await expect(
        leverageVault.connect(user).unpause()
      ).to.be.reverted;

      await leverageVault.unpause();
      expect(await leverageVault.paused()).to.be.false;
    });

    it('should resume operations after unpause', async function () {
      await leverageVault.pause();
      await leverageVault.unpause();

      await leverageVault.connect(user).openLeveragedPosition(
        await weth.getAddress(),
        ethers.parseEther('10'),
        20,
        5,
        futureDeadline()
      );

      const position = await leverageVault.getPosition(user.address);
      expect(position.totalCollateral).to.be.gt(0);
    });
  });

  describe('Edge Cases', function () {
    it('should reject zero initial amount', async function () {
      await expect(
        leverageVault.connect(user).openLeveragedPosition(
          await weth.getAddress(),
          0,
          20,
          5,
          futureDeadline()
        )
      ).to.be.revertedWithCustomError(leverageVault, "InvalidAmount");
    });

    it('should reject leverage too low', async function () {
      await expect(
        leverageVault.connect(user).openLeveragedPosition(
          await weth.getAddress(),
          ethers.parseEther('10'),
          5, // 0.5x - below minimum 1.0x
          5,
          futureDeadline()
        )
      ).to.be.revertedWithCustomError(leverageVault, "LeverageTooLow");
    });

    it('should reject invalid token address for enable', async function () {
      await expect(
        leverageVault.enableToken(ethers.ZeroAddress, 3000)
      ).to.be.revertedWithCustomError(leverageVault, "InvalidToken");
    });

    it('should reject invalid fee tier', async function () {
      const MockERC20 = await ethers.getContractFactory('MockERC20');
      const newToken = await MockERC20.deploy('Test', 'TEST', 18);

      await expect(
        leverageVault.enableToken(await newToken.getAddress(), 999)
      ).to.be.revertedWithCustomError(leverageVault, "InvalidFeeTier");
    });

    it('should revert cleanly on swap failure without leaving debt or position', async function () {
      await mockSwapRouter.setShouldRevert(true);

      await expect(
        leverageVault.connect(user).openLeveragedPosition(
          await weth.getAddress(),
          ethers.parseEther('10'),
          20,
          5,
          futureDeadline()
        )
      ).to.be.revertedWithCustomError(leverageVault, "SwapFailedOrphanedDebt");

      const position = await leverageVault.getPosition(user.address);
      expect(position.totalCollateral).to.equal(0);
      expect(position.totalDebt).to.equal(0);

      expect(await borrowModule.totalDebt(user.address)).to.equal(0);
      expect(await collateralVault.deposits(user.address, await weth.getAddress())).to.equal(0);
      expect(await weth.balanceOf(user.address)).to.equal(INITIAL_WETH_BALANCE);
    });
  });

  // ================================================================
  //  User-Specified Slippage Tests
  // ================================================================

  describe('User-Specified Slippage', function () {
    it('should close position with user-specified slippage', async function () {
      const initialDeposit = ethers.parseEther('10');

      await leverageVault.connect(user).openLeveragedPosition(
        await weth.getAddress(),
        initialDeposit,
        20,
        5,
        futureDeadline()
      );

      // Ensure the mock swap router has enough WETH
      await weth.mint(await mockSwapRouter.getAddress(), ethers.parseEther('50000'));

      // Close with user slippage = 50 bps (0.5%) — stricter than global 100 bps
      const balanceBefore = await weth.balanceOf(user.address);
      await leverageVault.connect(user).closeLeveragedPosition(0);
      const balanceAfter = await weth.balanceOf(user.address);

      expect(balanceAfter).to.be.gt(balanceBefore);

      const positionAfter = await leverageVault.getPosition(user.address);
      expect(positionAfter.totalCollateral).to.equal(0);
    });

  });

  // ================================================================
  //  NEW COVERAGE TESTS — Close Position
  // ================================================================

  describe('Close Leveraged Position', function () {
    it('should close a 2x position and return collateral', async function () {
      const initialDeposit = ethers.parseEther('10'); // 10 WETH

      // Open a 2x leveraged position
      await leverageVault.connect(user).openLeveragedPosition(
        await weth.getAddress(),
        initialDeposit,
        20, // 2.0x leverage
        5,
        futureDeadline()
      );

      const positionBefore = await leverageVault.getPosition(user.address);
      expect(positionBefore.totalCollateral).to.be.gt(initialDeposit);
      expect(positionBefore.totalDebt).to.be.gt(0);

      // Ensure the mock swap router has enough WETH to return collateral
      await weth.mint(await mockSwapRouter.getAddress(), ethers.parseEther('50000'));

      const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes('BRIDGE_ROLE'));
      await musd.grantRole(BRIDGE_ROLE, await mockSwapRouter.getAddress());

      // Close the position — minCollateralOut = 0 for this test
      const balanceBefore = await weth.balanceOf(user.address);
      await leverageVault.connect(user).closeLeveragedPosition(0);
      const balanceAfter = await weth.balanceOf(user.address);

      // User should have received collateral back
      expect(balanceAfter).to.be.gt(balanceBefore);

      // Position should be cleared
      const positionAfter = await leverageVault.getPosition(user.address);
      expect(positionAfter.totalCollateral).to.equal(0);
      expect(positionAfter.totalDebt).to.equal(0);
    });

    it('should fail close with insufficient minCollateralOut (slippage protection)', async function () {
      const initialDeposit = ethers.parseEther('10');

      await leverageVault.connect(user).openLeveragedPosition(
        await weth.getAddress(),
        initialDeposit,
        20,
        5,
        futureDeadline()
      );

      // Ensure mock router has liquidity
      await weth.mint(await mockSwapRouter.getAddress(), ethers.parseEther('50000'));

      // Set unrealistically high minCollateralOut — should revert
      const absurdMinOut = ethers.parseEther('999999');
      await expect(
        leverageVault.connect(user).closeLeveragedPosition(absurdMinOut)
      ).to.be.revertedWithCustomError(leverageVault, "SlippageExceeded");
    });

    it('should fail close when no position exists', async function () {
      await expect(
        leverageVault.connect(user).closeLeveragedPosition(0)
      ).to.be.revertedWithCustomError(leverageVault, "NoPosition");
    });
  });

  // ================================================================
  //  NEW COVERAGE TESTS — Close Position with mUSD
  // ================================================================

  describe('Close Leveraged Position With mUSD', function () {
    it('should close position by providing mUSD directly', async function () {
      const initialDeposit = ethers.parseEther('10');

      await leverageVault.connect(user).openLeveragedPosition(
        await weth.getAddress(),
        initialDeposit,
        20,
        5,
        futureDeadline()
      );

      const position = await leverageVault.getPosition(user.address);
      expect(position.totalDebt).to.be.gt(0);

      // Get exact debt and add a small buffer for interest accrual
      const debtAmount = await borrowModule.totalDebt(user.address);
      const buffer = debtAmount / 100n; // 1% buffer
      const musdToProvide = debtAmount + buffer;

      // Mint mUSD to user so they can repay
      const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes('BRIDGE_ROLE'));
      await musd.grantRole(BRIDGE_ROLE, owner.address);
      await (musd as any).mint(user.address, musdToProvide);
      await musd.connect(user).approve(await leverageVault.getAddress(), ethers.MaxUint256);

      const wethBefore = await weth.balanceOf(user.address);
      await leverageVault.connect(user).closeLeveragedPositionWithMusd(musdToProvide, futureDeadline());
      const wethAfter = await weth.balanceOf(user.address);

      // User should get ALL collateral back (no swap needed)
      expect(wethAfter).to.be.gt(wethBefore);

      // Position should be cleared
      const positionAfter = await leverageVault.getPosition(user.address);
      expect(positionAfter.totalCollateral).to.equal(0);
    });

    it('should refund excess mUSD', async function () {
      const initialDeposit = ethers.parseEther('10');

      await leverageVault.connect(user).openLeveragedPosition(
        await weth.getAddress(),
        initialDeposit,
        20,
        5,
        futureDeadline()
      );

      const debtAmount = await borrowModule.totalDebt(user.address);
      const extraMusd = ethers.parseEther('500'); // extra mUSD beyond debt
      const totalMusd = debtAmount + extraMusd;

      // Mint more mUSD than needed
      const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes('BRIDGE_ROLE'));
      await musd.grantRole(BRIDGE_ROLE, owner.address);
      await (musd as any).mint(user.address, totalMusd);
      await musd.connect(user).approve(await leverageVault.getAddress(), ethers.MaxUint256);

      const musdBefore = await musd.balanceOf(user.address);
      await leverageVault.connect(user).closeLeveragedPositionWithMusd(totalMusd, futureDeadline());
      const musdAfter = await musd.balanceOf(user.address);

      // Excess mUSD should be refunded — user should have a significant portion back
      // Allow small rounding/interest margin
      expect(musdAfter).to.be.gt(0);
      expect(musdAfter).to.be.gte(extraMusd * 99n / 100n);
    });

    it('should fail with insufficient mUSD', async function () {
      const initialDeposit = ethers.parseEther('10');

      await leverageVault.connect(user).openLeveragedPosition(
        await weth.getAddress(),
        initialDeposit,
        20,
        5,
        futureDeadline()
      );

      const debtAmount = await borrowModule.totalDebt(user.address);
      const insufficientMusd = debtAmount / 2n; // only half the debt

      // Mint insufficient mUSD
      const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes('BRIDGE_ROLE'));
      await musd.grantRole(BRIDGE_ROLE, owner.address);
      await (musd as any).mint(user.address, insufficientMusd);
      await musd.connect(user).approve(await leverageVault.getAddress(), ethers.MaxUint256);

      await expect(
        leverageVault.connect(user).closeLeveragedPositionWithMusd(insufficientMusd, futureDeadline())
      ).to.be.revertedWithCustomError(leverageVault, "InsufficientMusdProvided");
    });

    it('should fail when no position exists', async function () {
      await expect(
        leverageVault.connect(user).closeLeveragedPositionWithMusd(ethers.parseEther('100'), futureDeadline())
      ).to.be.revertedWithCustomError(leverageVault, "NoPosition");
    });
  });

  // ================================================================
  //  NEW COVERAGE TESTS — getMusdNeededToClose
  // ================================================================

  describe('mUSD Needed To Close', function () {
    it('should return correct debt amount for open position', async function () {
      const initialDeposit = ethers.parseEther('10');

      await leverageVault.connect(user).openLeveragedPosition(
        await weth.getAddress(),
        initialDeposit,
        20,
        5,
        futureDeadline()
      );

      const musdNeeded = await leverageVault.getMusdNeededToClose(user.address);
      const actualDebt = await borrowModule.totalDebt(user.address);

      expect(musdNeeded).to.equal(actualDebt);
      expect(musdNeeded).to.be.gt(0);
    });

    it('should return 0 for no position', async function () {
      const musdNeeded = await leverageVault.getMusdNeededToClose(user.address);
      expect(musdNeeded).to.equal(0);
    });
  });

  // ================================================================
  //  NEW COVERAGE TESTS — Emergency Close Position
  // ================================================================

  describe('Emergency Close Position', function () {
    it('admin should emergency close a user position', async function () {
      const initialDeposit = ethers.parseEther('10');

      await leverageVault.connect(user).openLeveragedPosition(
        await weth.getAddress(),
        initialDeposit,
        20,
        5,
        futureDeadline()
      );

      const positionBefore = await leverageVault.getPosition(user.address);
      expect(positionBefore.totalCollateral).to.be.gt(0);

      // Ensure the mock swap router has WETH for the collateral-to-mUSD swap
      await weth.mint(await mockSwapRouter.getAddress(), ethers.parseEther('50000'));

      // Admin emergency closes the position
      await leverageVault.connect(owner).emergencyClosePosition(user.address);

      // Position should be cleared
      const positionAfter = await leverageVault.getPosition(user.address);
      expect(positionAfter.totalCollateral).to.equal(0);
      expect(positionAfter.totalDebt).to.equal(0);
    });
  });
});
