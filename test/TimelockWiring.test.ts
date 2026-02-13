// Test: Findings #3 (Hand-rolled timelocks) & #4 (Inverted upgradeability)
// Validates that MintedTimelockController is properly wired into all upgradeable contracts
// and that admin operations + UUPS upgrades require TIMELOCK_ROLE.

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("Timelock Wiring — Findings #3 & #4", function () {
  let deployer: SignerWithAddress;
  let attacker: SignerWithAddress;
  let proposer: SignerWithAddress;
  let executor: SignerWithAddress;

  let timelock: any;
  let collateralVault: any;
  let liquidationEngine: any;

  const MIN_DELAY = 48 * 3600; // 48 hours
  const TIMELOCK_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TIMELOCK_ROLE"));

  beforeEach(async function () {
    [deployer, attacker, proposer, executor] = await ethers.getSigners();

    // Deploy MintedTimelockController
    const TimelockFactory = await ethers.getContractFactory("MintedTimelockController");
    timelock = await TimelockFactory.deploy(
      MIN_DELAY,
      [proposer.address],       // proposers
      [executor.address],       // executors
      ethers.ZeroAddress         // no admin (fully decentralized after setup)
    );
    await timelock.waitForDeployment();

    // Deploy CollateralVaultUpgradeable via UUPS proxy
    const VaultFactory = await ethers.getContractFactory("CollateralVaultUpgradeable");
    collateralVault = await upgrades.deployProxy(
      VaultFactory,
      [await timelock.getAddress()],
      { kind: "uups", unsafeAllow: ["constructor"] }
    );
    await collateralVault.waitForDeployment();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Finding #3: Hand-rolled timelocks replaced by central OZ controller
  // ─────────────────────────────────────────────────────────────────────

  describe("Finding #3: Central OZ TimelockController wiring", function () {
    it("timelock has TIMELOCK_ROLE on CollateralVaultUpgradeable", async function () {
      const timelockAddr = await timelock.getAddress();
      expect(await collateralVault.hasRole(TIMELOCK_ROLE, timelockAddr)).to.be.true;
    });

    it("admin (deployer) does NOT have TIMELOCK_ROLE", async function () {
      expect(await collateralVault.hasRole(TIMELOCK_ROLE, deployer.address)).to.be.false;
    });

    it("setBorrowModule reverts when called directly by admin", async function () {
      const fakeModule = ethers.Wallet.createRandom().address;
      await expect(
        collateralVault.setBorrowModule(fakeModule)
      ).to.be.reverted;
    });

    it("setBorrowModule succeeds when called through timelock", async function () {
      const fakeModule = ethers.Wallet.createRandom().address;
      const vaultAddr = await collateralVault.getAddress();
      const timelockAddr = await timelock.getAddress();

      // Encode the call
      const callData = collateralVault.interface.encodeFunctionData("setBorrowModule", [fakeModule]);

      // Schedule via timelock (proposer)
      const salt = ethers.id("setBorrowModule-1");
      await timelock.connect(proposer).schedule(
        vaultAddr, 0, callData, ethers.ZeroHash, salt, MIN_DELAY
      );

      // Advance time past 48h delay
      await time.increase(MIN_DELAY + 1);

      // Execute via timelock (executor)
      await timelock.connect(executor).execute(
        vaultAddr, 0, callData, ethers.ZeroHash, salt
      );

      expect(await collateralVault.borrowModule()).to.equal(fakeModule);
    });

    it("addCollateral reverts when called directly by admin", async function () {
      const fakeToken = ethers.Wallet.createRandom().address;
      await expect(
        collateralVault.addCollateral(fakeToken, 7500, 8000, 500)
      ).to.be.reverted;
    });

    it("addCollateral succeeds through timelock after delay", async function () {
      const fakeToken = ethers.Wallet.createRandom().address;
      const vaultAddr = await collateralVault.getAddress();

      const callData = collateralVault.interface.encodeFunctionData("addCollateral", [
        fakeToken, 7500, 8000, 500
      ]);

      const salt = ethers.id("addCollateral-1");
      await timelock.connect(proposer).schedule(
        vaultAddr, 0, callData, ethers.ZeroHash, salt, MIN_DELAY
      );

      // Executing before delay should fail
      await expect(
        timelock.connect(executor).execute(vaultAddr, 0, callData, ethers.ZeroHash, salt)
      ).to.be.reverted;

      // Advance past delay
      await time.increase(MIN_DELAY + 1);

      await timelock.connect(executor).execute(
        vaultAddr, 0, callData, ethers.ZeroHash, salt
      );

      const config = await collateralVault.getConfig(fakeToken);
      expect(config.enabled).to.be.true;
      expect(config.collateralFactorBps).to.equal(7500);
    });

    it("no hand-rolled request/cancel/execute functions exist", async function () {
      // Verify that the old propose/execute pattern functions don't exist
      expect(collateralVault.requestBorrowModule).to.be.undefined;
      expect(collateralVault.cancelBorrowModule).to.be.undefined;
      expect(collateralVault.executeBorrowModule).to.be.undefined;
      expect(collateralVault.requestAddCollateral).to.be.undefined;
      expect(collateralVault.cancelAddCollateral).to.be.undefined;
      expect(collateralVault.executeAddCollateral).to.be.undefined;
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Finding #4: UUPS upgrades require TIMELOCK_ROLE (not bare admin)
  // ─────────────────────────────────────────────────────────────────────

  describe("Finding #4: UUPS upgrades gated by TIMELOCK_ROLE", function () {
    it("direct upgradeToAndCall by admin reverts", async function () {
      // Deploy a new implementation
      const VaultV2Factory = await ethers.getContractFactory("CollateralVaultUpgradeable");
      const newImpl = await VaultV2Factory.deploy();
      await newImpl.waitForDeployment();

      const newImplAddr = await newImpl.getAddress();

      // Admin trying to upgrade directly should fail
      await expect(
        collateralVault.upgradeToAndCall(newImplAddr, "0x")
      ).to.be.reverted;
    });

    it("upgrade succeeds through timelock after 48h delay", async function () {
      // Deploy a new implementation
      const VaultV2Factory = await ethers.getContractFactory("CollateralVaultUpgradeable");
      const newImpl = await VaultV2Factory.deploy();
      await newImpl.waitForDeployment();

      const newImplAddr = await newImpl.getAddress();
      const vaultAddr = await collateralVault.getAddress();

      // Encode upgradeToAndCall
      const callData = collateralVault.interface.encodeFunctionData("upgradeToAndCall", [
        newImplAddr, "0x"
      ]);

      const salt = ethers.id("upgrade-v2");
      await timelock.connect(proposer).schedule(
        vaultAddr, 0, callData, ethers.ZeroHash, salt, MIN_DELAY
      );

      await time.increase(MIN_DELAY + 1);

      await expect(
        timelock.connect(executor).execute(vaultAddr, 0, callData, ethers.ZeroHash, salt)
      ).to.not.be.reverted;
    });

    it("attacker cannot upgrade even with DEFAULT_ADMIN_ROLE", async function () {
      // Grant attacker DEFAULT_ADMIN_ROLE (simulating compromised admin)
      const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
      await collateralVault.grantRole(DEFAULT_ADMIN_ROLE, attacker.address);

      const VaultV2Factory = await ethers.getContractFactory("CollateralVaultUpgradeable");
      const maliciousImpl = await VaultV2Factory.deploy();
      await maliciousImpl.waitForDeployment();

      // Even with admin role, upgrade should fail (requires TIMELOCK_ROLE)
      await expect(
        collateralVault.connect(attacker).upgradeToAndCall(
          await maliciousImpl.getAddress(), "0x"
        )
      ).to.be.reverted;
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Timelock safety: cannot bypass delay
  // ─────────────────────────────────────────────────────────────────────

  describe("Timelock safety properties", function () {
    it("operations cannot be executed before delay elapses", async function () {
      const fakeModule = ethers.Wallet.createRandom().address;
      const vaultAddr = await collateralVault.getAddress();

      const callData = collateralVault.interface.encodeFunctionData("setBorrowModule", [fakeModule]);
      const salt = ethers.id("early-execute");

      await timelock.connect(proposer).schedule(
        vaultAddr, 0, callData, ethers.ZeroHash, salt, MIN_DELAY
      );

      // Try to execute immediately — should fail
      await expect(
        timelock.connect(executor).execute(vaultAddr, 0, callData, ethers.ZeroHash, salt)
      ).to.be.reverted;

      // Advance only 24h (half the delay)
      await time.increase(24 * 3600);

      // Still should fail
      await expect(
        timelock.connect(executor).execute(vaultAddr, 0, callData, ethers.ZeroHash, salt)
      ).to.be.reverted;
    });

    it("non-proposer cannot schedule operations", async function () {
      const fakeModule = ethers.Wallet.createRandom().address;
      const vaultAddr = await collateralVault.getAddress();

      const callData = collateralVault.interface.encodeFunctionData("setBorrowModule", [fakeModule]);
      const salt = ethers.id("attacker-schedule");

      await expect(
        timelock.connect(attacker).schedule(
          vaultAddr, 0, callData, ethers.ZeroHash, salt, MIN_DELAY
        )
      ).to.be.reverted;
    });

    it("non-executor cannot execute ready operations", async function () {
      const fakeModule = ethers.Wallet.createRandom().address;
      const vaultAddr = await collateralVault.getAddress();

      const callData = collateralVault.interface.encodeFunctionData("setBorrowModule", [fakeModule]);
      const salt = ethers.id("attacker-execute");

      await timelock.connect(proposer).schedule(
        vaultAddr, 0, callData, ethers.ZeroHash, salt, MIN_DELAY
      );

      await time.increase(MIN_DELAY + 1);

      // Attacker (not executor) should fail
      await expect(
        timelock.connect(attacker).execute(vaultAddr, 0, callData, ethers.ZeroHash, salt)
      ).to.be.reverted;
    });

    it("minimum delay enforced at deployment (< 24h rejected)", async function () {
      const TimelockFactory = await ethers.getContractFactory("MintedTimelockController");
      await expect(
        TimelockFactory.deploy(
          3600, // 1 hour — too short
          [proposer.address],
          [executor.address],
          ethers.ZeroAddress
        )
      ).to.be.revertedWith("DELAY_TOO_SHORT");
    });
  });
});
