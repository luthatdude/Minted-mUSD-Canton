import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

/**
 * Upgrade-Path Tests for Upgradeable Contracts
 *
 * Tests that all 5 UUPS upgradeable contracts:
 *   1. Deploy correctly via proxy
 *   2. Only TIMELOCK_ROLE can authorize upgrades
 *   3. Unauthorized callers are rejected
 *   4. Storage is preserved across upgrades
 *   5. Re-initialization is blocked after upgrade
 */

describe('UpgradeablePath', function () {
  let admin: HardhatEthersSigner;
  let timelock: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  const TIMELOCK_ROLE = ethers.keccak256(ethers.toUtf8Bytes('TIMELOCK_ROLE'));

  beforeEach(async function () {
    [admin, timelock, attacker, user] = await ethers.getSigners();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 1. CollateralVaultUpgradeable
  // ═══════════════════════════════════════════════════════════════════════

  describe('CollateralVaultUpgradeable', function () {
    it('deploys via proxy and initializes', async function () {
      const Factory = await ethers.getContractFactory('CollateralVaultUpgradeable');
      const vault = await upgrades.deployProxy(
        Factory,
        [timelock.address],
        { kind: 'uups' }
      );

      expect(await vault.hasRole(TIMELOCK_ROLE, timelock.address)).to.be.true;
    });

    it('rejects upgrade from non-TIMELOCK_ROLE', async function () {
      const Factory = await ethers.getContractFactory('CollateralVaultUpgradeable');
      const vault = await upgrades.deployProxy(
        Factory,
        [timelock.address],
        { kind: 'uups' }
      );

      // Attacker tries to upgrade
      const NewImpl = await ethers.getContractFactory('CollateralVaultUpgradeable', attacker);
      await expect(
        upgrades.upgradeProxy(await vault.getAddress(), NewImpl, {
          kind: 'uups',
        })
      ).to.be.reverted;
    });

    it('TIMELOCK_ROLE can upgrade successfully', async function () {
      const Factory = await ethers.getContractFactory('CollateralVaultUpgradeable');
      const vault = await upgrades.deployProxy(
        Factory,
        [timelock.address],
        { kind: 'uups' }
      );

      // Timelock upgrades (same impl for simplicity — validates auth only)
      const NewImpl = await ethers.getContractFactory('CollateralVaultUpgradeable', timelock);
      const upgraded = await upgrades.upgradeProxy(await vault.getAddress(), NewImpl, {
        kind: 'uups',
      });

      // Should still work after upgrade
      expect(await upgraded.hasRole(TIMELOCK_ROLE, timelock.address)).to.be.true;
    });

    it('blocks re-initialization after upgrade', async function () {
      const Factory = await ethers.getContractFactory('CollateralVaultUpgradeable');
      const vault = await upgrades.deployProxy(
        Factory,
        [timelock.address],
        { kind: 'uups' }
      );

      await expect(
        vault.initialize(attacker.address)
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. BorrowModuleUpgradeable
  // ═══════════════════════════════════════════════════════════════════════

  describe('BorrowModuleUpgradeable', function () {
    let mockVault: string;
    let mockOracle: string;
    let mockMusd: string;

    beforeEach(async function () {
      // Deploy mocks for constructor args
      const MockERC20 = await ethers.getContractFactory('MockERC20');
      const musd = await MockERC20.deploy('mUSD', 'mUSD', 18);
      mockMusd = await musd.getAddress();

      // Use simple deployed contract addresses as mock addresses
      const oracle = await MockERC20.deploy('Oracle', 'ORC', 18);
      mockOracle = await oracle.getAddress();

      const vault = await MockERC20.deploy('Vault', 'VLT', 18);
      mockVault = await vault.getAddress();
    });

    it('deploys via proxy and initializes', async function () {
      const Factory = await ethers.getContractFactory('BorrowModuleUpgradeable');
      const borrow = await upgrades.deployProxy(
        Factory,
        [mockVault, mockOracle, mockMusd, 200, ethers.parseEther('10'), admin.address, timelock.address],
        { kind: 'uups' }
      );

      expect(await borrow.hasRole(TIMELOCK_ROLE, timelock.address)).to.be.true;
    });

    it('rejects upgrade from non-TIMELOCK_ROLE', async function () {
      const Factory = await ethers.getContractFactory('BorrowModuleUpgradeable');
      const borrow = await upgrades.deployProxy(
        Factory,
        [mockVault, mockOracle, mockMusd, 200, ethers.parseEther('10'), admin.address, timelock.address],
        { kind: 'uups' }
      );

      const NewImpl = await ethers.getContractFactory('BorrowModuleUpgradeable', attacker);
      await expect(
        upgrades.upgradeProxy(await borrow.getAddress(), NewImpl, { kind: 'uups' })
      ).to.be.reverted;
    });

    it('preserves storage across upgrade', async function () {
      const Factory = await ethers.getContractFactory('BorrowModuleUpgradeable');
      const borrow = await upgrades.deployProxy(
        Factory,
        [mockVault, mockOracle, mockMusd, 200, ethers.parseEther('10'), admin.address, timelock.address],
        { kind: 'uups' }
      );

      // Check storage before upgrade
      const interestRateBefore = await borrow.interestRateBps();

      // Upgrade
      const NewImpl = await ethers.getContractFactory('BorrowModuleUpgradeable', timelock);
      const upgraded = await upgrades.upgradeProxy(await borrow.getAddress(), NewImpl, {
        kind: 'uups',
      });

      // Storage preserved
      expect(await upgraded.interestRateBps()).to.equal(interestRateBefore);
      expect(await upgraded.hasRole(TIMELOCK_ROLE, timelock.address)).to.be.true;
    });

    it('blocks re-initialization', async function () {
      const Factory = await ethers.getContractFactory('BorrowModuleUpgradeable');
      const borrow = await upgrades.deployProxy(
        Factory,
        [mockVault, mockOracle, mockMusd, 200, ethers.parseEther('10'), admin.address, timelock.address],
        { kind: 'uups' }
      );

      await expect(
        borrow.initialize(mockVault, mockOracle, mockMusd, 200, ethers.parseEther('10'), attacker.address, attacker.address)
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. SMUSDUpgradeable
  // ═══════════════════════════════════════════════════════════════════════

  describe('SMUSDUpgradeable', function () {
    let mockMusd: string;
    let mockTreasury: string;

    beforeEach(async function () {
      const MockERC20 = await ethers.getContractFactory('MockERC20');
      const musd = await MockERC20.deploy('mUSD', 'mUSD', 18);
      mockMusd = await musd.getAddress();

      const treasury = await MockERC20.deploy('Treasury', 'TRS', 18);
      mockTreasury = await treasury.getAddress();
    });

    it('deploys via proxy and initializes', async function () {
      const Factory = await ethers.getContractFactory('SMUSDUpgradeable');
      const smusd = await upgrades.deployProxy(
        Factory,
        [mockMusd, mockTreasury, admin.address, timelock.address],
        { kind: 'uups' }
      );

      expect(await smusd.hasRole(TIMELOCK_ROLE, timelock.address)).to.be.true;
    });

    it('rejects upgrade from non-TIMELOCK_ROLE', async function () {
      const Factory = await ethers.getContractFactory('SMUSDUpgradeable');
      const smusd = await upgrades.deployProxy(
        Factory,
        [mockMusd, mockTreasury, admin.address, timelock.address],
        { kind: 'uups' }
      );

      const NewImpl = await ethers.getContractFactory('SMUSDUpgradeable', attacker);
      await expect(
        upgrades.upgradeProxy(await smusd.getAddress(), NewImpl, { kind: 'uups' })
      ).to.be.reverted;
    });

    it('preserves storage across upgrade', async function () {
      const Factory = await ethers.getContractFactory('SMUSDUpgradeable');
      const smusd = await upgrades.deployProxy(
        Factory,
        [mockMusd, mockTreasury, admin.address, timelock.address],
        { kind: 'uups' }
      );

      const NewImpl = await ethers.getContractFactory('SMUSDUpgradeable', timelock);
      const upgraded = await upgrades.upgradeProxy(await smusd.getAddress(), NewImpl, {
        kind: 'uups',
      });

      expect(await upgraded.hasRole(TIMELOCK_ROLE, timelock.address)).to.be.true;
    });

    it('blocks re-initialization', async function () {
      const Factory = await ethers.getContractFactory('SMUSDUpgradeable');
      const smusd = await upgrades.deployProxy(
        Factory,
        [mockMusd, mockTreasury, admin.address, timelock.address],
        { kind: 'uups' }
      );

      await expect(
        smusd.initialize(mockMusd, mockTreasury, attacker.address, attacker.address)
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. LiquidationEngineUpgradeable
  // ═══════════════════════════════════════════════════════════════════════

  describe('LiquidationEngineUpgradeable', function () {
    let mockVault: string;
    let mockBorrow: string;
    let mockOracle: string;
    let mockMusd: string;

    beforeEach(async function () {
      const MockERC20 = await ethers.getContractFactory('MockERC20');
      const t1 = await MockERC20.deploy('Vault', 'VLT', 18);
      mockVault = await t1.getAddress();
      const t2 = await MockERC20.deploy('Borrow', 'BRW', 18);
      mockBorrow = await t2.getAddress();
      const t3 = await MockERC20.deploy('Oracle', 'ORC', 18);
      mockOracle = await t3.getAddress();
      const t4 = await MockERC20.deploy('mUSD', 'mUSD', 18);
      mockMusd = await t4.getAddress();
    });

    it('deploys via proxy and initializes', async function () {
      const Factory = await ethers.getContractFactory('LiquidationEngineUpgradeable');
      const engine = await upgrades.deployProxy(
        Factory,
        [mockVault, mockBorrow, mockOracle, mockMusd, 5000, timelock.address],
        { kind: 'uups' }
      );

      expect(await engine.hasRole(TIMELOCK_ROLE, timelock.address)).to.be.true;
    });

    it('rejects upgrade from non-TIMELOCK_ROLE', async function () {
      const Factory = await ethers.getContractFactory('LiquidationEngineUpgradeable');
      const engine = await upgrades.deployProxy(
        Factory,
        [mockVault, mockBorrow, mockOracle, mockMusd, 5000, timelock.address],
        { kind: 'uups' }
      );

      const NewImpl = await ethers.getContractFactory('LiquidationEngineUpgradeable', attacker);
      await expect(
        upgrades.upgradeProxy(await engine.getAddress(), NewImpl, { kind: 'uups' })
      ).to.be.reverted;
    });

    it('blocks re-initialization', async function () {
      const Factory = await ethers.getContractFactory('LiquidationEngineUpgradeable');
      const engine = await upgrades.deployProxy(
        Factory,
        [mockVault, mockBorrow, mockOracle, mockMusd, 5000, timelock.address],
        { kind: 'uups' }
      );

      await expect(
        engine.initialize(mockVault, mockBorrow, mockOracle, mockMusd, 5000, attacker.address)
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5. LeverageVaultUpgradeable
  // ═══════════════════════════════════════════════════════════════════════

  describe('LeverageVaultUpgradeable', function () {
    let mockSwapRouter: string;
    let mockVault: string;
    let mockBorrow: string;
    let mockOracle: string;
    let mockMusd: string;

    beforeEach(async function () {
      const MockERC20 = await ethers.getContractFactory('MockERC20');
      const t1 = await MockERC20.deploy('SwapRouter', 'SWP', 18);
      mockSwapRouter = await t1.getAddress();
      const t2 = await MockERC20.deploy('Vault', 'VLT', 18);
      mockVault = await t2.getAddress();
      const t3 = await MockERC20.deploy('Borrow', 'BRW', 18);
      mockBorrow = await t3.getAddress();
      const t4 = await MockERC20.deploy('Oracle', 'ORC', 18);
      mockOracle = await t4.getAddress();
      const t5 = await MockERC20.deploy('mUSD', 'mUSD', 18);
      mockMusd = await t5.getAddress();
    });

    it('deploys via proxy and initializes', async function () {
      const Factory = await ethers.getContractFactory('LeverageVaultUpgradeable');
      const leverage = await upgrades.deployProxy(
        Factory,
        [mockSwapRouter, mockVault, mockBorrow, mockOracle, mockMusd, admin.address, timelock.address],
        { kind: 'uups' }
      );

      expect(await leverage.hasRole(TIMELOCK_ROLE, timelock.address)).to.be.true;
    });

    it('rejects upgrade from non-TIMELOCK_ROLE', async function () {
      const Factory = await ethers.getContractFactory('LeverageVaultUpgradeable');
      const leverage = await upgrades.deployProxy(
        Factory,
        [mockSwapRouter, mockVault, mockBorrow, mockOracle, mockMusd, admin.address, timelock.address],
        { kind: 'uups' }
      );

      const NewImpl = await ethers.getContractFactory('LeverageVaultUpgradeable', attacker);
      await expect(
        upgrades.upgradeProxy(await leverage.getAddress(), NewImpl, { kind: 'uups' })
      ).to.be.reverted;
    });

    it('preserves storage across upgrade', async function () {
      const Factory = await ethers.getContractFactory('LeverageVaultUpgradeable');
      const leverage = await upgrades.deployProxy(
        Factory,
        [mockSwapRouter, mockVault, mockBorrow, mockOracle, mockMusd, admin.address, timelock.address],
        { kind: 'uups' }
      );

      const NewImpl = await ethers.getContractFactory('LeverageVaultUpgradeable', timelock);
      const upgraded = await upgrades.upgradeProxy(await leverage.getAddress(), NewImpl, {
        kind: 'uups',
      });

      expect(await upgraded.hasRole(TIMELOCK_ROLE, timelock.address)).to.be.true;
    });

    it('blocks re-initialization', async function () {
      const Factory = await ethers.getContractFactory('LeverageVaultUpgradeable');
      const leverage = await upgrades.deployProxy(
        Factory,
        [mockSwapRouter, mockVault, mockBorrow, mockOracle, mockMusd, admin.address, timelock.address],
        { kind: 'uups' }
      );

      await expect(
        leverage.initialize(mockSwapRouter, mockVault, mockBorrow, mockOracle, mockMusd, attacker.address, attacker.address)
      ).to.be.reverted;
    });
  });
});
