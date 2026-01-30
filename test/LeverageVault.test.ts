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
    await priceOracle.setFeed(
      await weth.getAddress(),
      await wethPriceFeed.getAddress(),
      3600, // 1 hour stale period
      18    // WETH has 18 decimals
    );

    // Deploy collateral vault
    const CollateralVault = await ethers.getContractFactory('CollateralVault');
    collateralVault = await CollateralVault.deploy();

    // Add WETH as collateral (75% LTV, 80% liquidation threshold, 5% penalty)
    await collateralVault.addCollateral(
      await weth.getAddress(),
      7500, // 75% collateral factor
      8000, // 80% liquidation threshold
      500   // 5% liquidation penalty
    );

    // Deploy mUSD contract (with mint/burn roles)
    const MUSD = await ethers.getContractFactory('MUSD');
    musd = await MUSD.deploy(ethers.parseEther('100000000')); // 100M supply cap

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
      await musd.getAddress()
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
        5   // Max 5 loops
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
          10
        )
      ).to.be.revertedWith('LEVERAGE_EXCEEDS_MAX');
    });

    it('should reject if token not enabled', async function () {
      const MockERC20 = await ethers.getContractFactory('MockERC20');
      const randomToken = await MockERC20.deploy('Random', 'RND', 18);

      await expect(
        leverageVault.connect(user).openLeveragedPosition(
          await randomToken.getAddress(),
          ethers.parseEther('10'),
          20,
          5
        )
      ).to.be.revertedWith('TOKEN_NOT_ENABLED');
    });

    it('should reject second position if one already exists', async function () {
      const initialDeposit = ethers.parseEther('5');

      await leverageVault.connect(user).openLeveragedPosition(
        await weth.getAddress(),
        initialDeposit,
        20,
        3
      );

      await weth.mint(user.address, initialDeposit);

      await expect(
        leverageVault.connect(user).openLeveragedPosition(
          await weth.getAddress(),
          initialDeposit,
          20,
          3
        )
      ).to.be.revertedWith('POSITION_EXISTS');
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
      ).to.be.revertedWith('INVALID_MAX_LOOPS');
    });

    it('should reject invalid slippage', async function () {
      await expect(
        leverageVault.setConfig(10, ethers.parseEther('100'), 3000, 600)
      ).to.be.revertedWith('SLIPPAGE_TOO_HIGH');
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
        5
      );

      const effectiveLeverage = await leverageVault.getEffectiveLeverage(user.address);
      // Effective leverage will be > 1.0x (10) after loops
      // The exact value depends on swap execution, LTV, and loop count
      expect(effectiveLeverage).to.be.gt(10); // At least some leverage achieved
      expect(effectiveLeverage).to.be.lte(40); // Should not exceed 4x (max for 75% LTV)
    });
  });
});
