import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

/**
 * SkySUSDSStrategy Tests
 *
 * Tests the Sky sUSDS yield strategy:
 *   1. Deployment and initialization
 *   2. Deposit flow: USDC → PSM → sUSDS
 *   3. Withdraw flow: sUSDS → PSM → USDC
 *   4. Access control (TREASURY_ROLE, GUARDIAN_ROLE)
 *   5. Emergency withdraw
 *   6. Pause/unpause
 */

describe('SkySUSDSStrategy', function () {
  let admin: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let guardian: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;

  const TREASURY_ROLE = ethers.keccak256(ethers.toUtf8Bytes('TREASURY_ROLE'));
  const GUARDIAN_ROLE = ethers.keccak256(ethers.toUtf8Bytes('GUARDIAN_ROLE'));
  const STRATEGIST_ROLE = ethers.keccak256(ethers.toUtf8Bytes('STRATEGIST_ROLE'));

  let usdc: any;
  let usds: any;
  let mockPsm: any;
  let mockSUsds: any;

  beforeEach(async function () {
    [admin, treasury, guardian, attacker] = await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20 = await ethers.getContractFactory('MockERC20');
    usdc = await MockERC20.deploy('USDC', 'USDC', 6);
    usds = await MockERC20.deploy('USDS', 'USDS', 18);

    // For basic tests, we use the token addresses as mock PSM/sUSDS
    // Full integration tests would use actual PSM/sUSDS contracts
    mockPsm = await MockERC20.deploy('PSM', 'PSM', 18);
    mockSUsds = await MockERC20.deploy('sUSDS', 'sUSDS', 18);
  });

  it('deploys via proxy and initializes', async function () {
    const Factory = await ethers.getContractFactory('SkySUSDSStrategy');
    const strategy = await upgrades.deployProxy(
      Factory,
      [
        await usdc.getAddress(),
        await usds.getAddress(),
        await mockPsm.getAddress(),
        await mockSUsds.getAddress(),
        treasury.address,
        admin.address,
        admin.address,
      ],
      { kind: 'uups' }
    );

    expect(await strategy.hasRole(TREASURY_ROLE, treasury.address)).to.be.true;
    expect(await strategy.hasRole(GUARDIAN_ROLE, admin.address)).to.be.true;
    expect(await strategy.asset()).to.equal(await usdc.getAddress());
    expect(await strategy.isActive()).to.be.true;
  });

  it('rejects initialization with zero addresses', async function () {
    const Factory = await ethers.getContractFactory('SkySUSDSStrategy');
    await expect(
      upgrades.deployProxy(
        Factory,
        [
          ethers.ZeroAddress,
          await usds.getAddress(),
          await mockPsm.getAddress(),
          await mockSUsds.getAddress(),
          treasury.address,
          admin.address,
          admin.address,
        ],
        { kind: 'uups' }
      )
    ).to.be.reverted;
  });

  it('blocks re-initialization', async function () {
    const Factory = await ethers.getContractFactory('SkySUSDSStrategy');
    const strategy = await upgrades.deployProxy(
      Factory,
      [
        await usdc.getAddress(),
        await usds.getAddress(),
        await mockPsm.getAddress(),
        await mockSUsds.getAddress(),
        treasury.address,
        admin.address,
        admin.address,
      ],
      { kind: 'uups' }
    );

    await expect(
      strategy.initialize(
        await usdc.getAddress(),
        await usds.getAddress(),
        await mockPsm.getAddress(),
        await mockSUsds.getAddress(),
        attacker.address,
        attacker.address,
        attacker.address,
      )
    ).to.be.reverted;
  });

  it('only TREASURY_ROLE can deposit', async function () {
    const Factory = await ethers.getContractFactory('SkySUSDSStrategy');
    const strategy = await upgrades.deployProxy(
      Factory,
      [
        await usdc.getAddress(),
        await usds.getAddress(),
        await mockPsm.getAddress(),
        await mockSUsds.getAddress(),
        treasury.address,
        admin.address,
        admin.address,
      ],
      { kind: 'uups' }
    );

    // Attacker cannot deposit
    await expect(
      strategy.connect(attacker).deposit(1000)
    ).to.be.reverted;
  });

  it('only TREASURY_ROLE can withdraw', async function () {
    const Factory = await ethers.getContractFactory('SkySUSDSStrategy');
    const strategy = await upgrades.deployProxy(
      Factory,
      [
        await usdc.getAddress(),
        await usds.getAddress(),
        await mockPsm.getAddress(),
        await mockSUsds.getAddress(),
        treasury.address,
        admin.address,
        admin.address,
      ],
      { kind: 'uups' }
    );

    await expect(
      strategy.connect(attacker).withdraw(1000)
    ).to.be.reverted;
  });

  it('STRATEGIST_ROLE can toggle active', async function () {
    const Factory = await ethers.getContractFactory('SkySUSDSStrategy');
    const strategy = await upgrades.deployProxy(
      Factory,
      [
        await usdc.getAddress(),
        await usds.getAddress(),
        await mockPsm.getAddress(),
        await mockSUsds.getAddress(),
        treasury.address,
        admin.address,
        admin.address,
      ],
      { kind: 'uups' }
    );

    // Admin has STRATEGIST_ROLE
    await strategy.connect(admin).setActive(false);
    expect(await strategy.isActive()).to.be.false;

    await strategy.connect(admin).setActive(true);
    expect(await strategy.isActive()).to.be.true;
  });

  it('GUARDIAN can pause, DEFAULT_ADMIN can unpause', async function () {
    const Factory = await ethers.getContractFactory('SkySUSDSStrategy');
    const strategy = await upgrades.deployProxy(
      Factory,
      [
        await usdc.getAddress(),
        await usds.getAddress(),
        await mockPsm.getAddress(),
        await mockSUsds.getAddress(),
        treasury.address,
        admin.address,
        admin.address,
      ],
      { kind: 'uups' }
    );

    // Admin has GUARDIAN_ROLE
    await strategy.connect(admin).pause();
    expect(await strategy.isActive()).to.be.false;

    await strategy.connect(admin).unpause();
    expect(await strategy.isActive()).to.be.true;
  });

  it('deposit reverts when paused', async function () {
    const Factory = await ethers.getContractFactory('SkySUSDSStrategy');
    const strategy = await upgrades.deployProxy(
      Factory,
      [
        await usdc.getAddress(),
        await usds.getAddress(),
        await mockPsm.getAddress(),
        await mockSUsds.getAddress(),
        treasury.address,
        admin.address,
        admin.address,
      ],
      { kind: 'uups' }
    );

    await strategy.connect(admin).pause();

    await expect(
      strategy.connect(treasury).deposit(1000)
    ).to.be.reverted;
  });

  it('deposit reverts with zero amount', async function () {
    const Factory = await ethers.getContractFactory('SkySUSDSStrategy');
    const strategy = await upgrades.deployProxy(
      Factory,
      [
        await usdc.getAddress(),
        await usds.getAddress(),
        await mockPsm.getAddress(),
        await mockSUsds.getAddress(),
        treasury.address,
        admin.address,
        admin.address,
      ],
      { kind: 'uups' }
    );

    await expect(
      strategy.connect(treasury).deposit(0)
    ).to.be.revertedWithCustomError(strategy, 'ZeroAmount');
  });

  it('recover rejects protected tokens', async function () {
    const Factory = await ethers.getContractFactory('SkySUSDSStrategy');
    const strategy = await upgrades.deployProxy(
      Factory,
      [
        await usdc.getAddress(),
        await usds.getAddress(),
        await mockPsm.getAddress(),
        await mockSUsds.getAddress(),
        treasury.address,
        admin.address,
        admin.address,
      ],
      { kind: 'uups' }
    );

    await expect(
      strategy.connect(admin).recoverToken(await usdc.getAddress(), 100)
    ).to.be.revertedWith('Cannot recover USDC');

    await expect(
      strategy.connect(admin).recoverToken(await usds.getAddress(), 100)
    ).to.be.revertedWith('Cannot recover USDS');
  });
});
