/**
 * BLE Protocol Integration Tests - Fixed Version
 * Fixes: TEST-01 (Signature sorting), TEST-02 (Missing mint verification),
 *        TEST-03 (Comprehensive coverage)
 */

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { MUSD, BLEBridgeV8, SMUSD } from "../typechain-types";

describe("BLE Protocol Production Test", function () {
  let bridge: BLEBridgeV8;
  let musd: MUSD;
  let smusd: SMUSD;
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let validators: HardhatEthersSigner[];
  let validatorAddresses: string[];

  const INITIAL_SUPPLY_CAP = ethers.parseEther("10000000");
  const DAILY_MINT_LIMIT = ethers.parseEther("1000000");
  const MIN_SIGNATURES = 3;

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    deployer = signers[0];
    user = signers[1];
    validators = signers.slice(2, 7); // 5 validators

    // Get validator addresses and sort them for signature ordering
    validatorAddresses = await Promise.all(
      validators.map((v) => v.getAddress())
    );

    // Deploy MUSD with initial supply cap (FIX M-02)
    const MUSDFactory = await ethers.getContractFactory("MUSD");
    musd = (await MUSDFactory.deploy(INITIAL_SUPPLY_CAP)) as MUSD;
    await musd.waitForDeployment();

    // Deploy Bridge with MUSD address (FIX B-01)
    const BridgeFactory = await ethers.getContractFactory("BLEBridgeV8");
    bridge = (await upgrades.deployProxy(BridgeFactory, [
      MIN_SIGNATURES,
      DAILY_MINT_LIMIT,
      await musd.getAddress(),
    ])) as unknown as BLEBridgeV8;
    await bridge.waitForDeployment();

    // Setup roles
    const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
    const VALIDATOR_ROLE = await bridge.VALIDATOR_ROLE();
    const COMPLIANCE_ROLE = await musd.COMPLIANCE_ROLE();

    await musd.grantRole(BRIDGE_ROLE, await bridge.getAddress());
    await musd.grantRole(COMPLIANCE_ROLE, deployer.address);

    for (const addr of validatorAddresses) {
      await bridge.grantRole(VALIDATOR_ROLE, addr);
    }

    // Deploy SMUSD vault
    const SMUSDFactory = await ethers.getContractFactory("SMUSD");
    smusd = (await SMUSDFactory.deploy(await musd.getAddress())) as SMUSD;
    await smusd.waitForDeployment();
  });

  // FIX TEST-01: Helper to sort signatures by recovered signer address
  async function signAndSort(
    hash: string,
    signers: HardhatEthersSigner[]
  ): Promise<string[]> {
    const signatures: { sig: string; addr: string }[] = [];

    for (const signer of signers) {
      const sig = await signer.signMessage(ethers.getBytes(hash));
      const addr = await signer.getAddress();
      signatures.push({ sig, addr: addr.toLowerCase() });
    }

    // Sort by signer address (ascending) as required by contract
    signatures.sort((a, b) => {
      if (a.addr < b.addr) return -1;
      if (a.addr > b.addr) return 1;
      return 0;
    });

    return signatures.map((s) => s.sig);
  }

  describe("Multi-sig Attestation", function () {
    it("Should execute 3-of-5 mint with properly sorted signatures", async function () {
      const amount = ethers.parseEther("1000");
      const assets = ethers.parseEther("1100"); // 110% collateral
      const nonce = 1n;
      const attId = ethers.id("att-1");
      const chainId = (await ethers.provider.getNetwork()).chainId;

      // FIX B-02: Include bridge address in hash
      const hash = ethers.solidityPackedKeccak256(
        [
          "bytes32",
          "uint256",
          "address",
          "uint256",
          "bool",
          "uint256",
          "uint256",
          "address",
        ],
        [
          attId,
          assets,
          user.address,
          amount,
          true,
          nonce,
          chainId,
          await bridge.getAddress(),
        ]
      );

      // FIX TEST-01: Sort signatures by signer address
      const sigs = await signAndSort(hash, validators.slice(0, 3));

      // Verify balance before
      expect(await musd.balanceOf(user.address)).to.equal(0);

      await bridge.executeAttestation(
        {
          id: attId,
          globalCantonAssets: assets,
          target: user.address,
          amount,
          isMint: true,
          nonce,
        },
        sigs
      );

      // FIX TEST-02: This now works because bridge actually mints
      expect(await musd.balanceOf(user.address)).to.equal(amount);
      expect(await bridge.currentNonce()).to.equal(nonce);
      expect(await bridge.totalCantonAssets()).to.equal(assets);
    });

    it("Should reject insufficient signatures", async function () {
      const amount = ethers.parseEther("1000");
      const assets = ethers.parseEther("1100");
      const nonce = 1n;
      const attId = ethers.id("att-2");
      const chainId = (await ethers.provider.getNetwork()).chainId;

      const hash = ethers.solidityPackedKeccak256(
        [
          "bytes32",
          "uint256",
          "address",
          "uint256",
          "bool",
          "uint256",
          "uint256",
          "address",
        ],
        [
          attId,
          assets,
          user.address,
          amount,
          true,
          nonce,
          chainId,
          await bridge.getAddress(),
        ]
      );

      // Only 2 signatures (need 3)
      const sigs = await signAndSort(hash, validators.slice(0, 2));

      await expect(
        bridge.executeAttestation(
          {
            id: attId,
            globalCantonAssets: assets,
            target: user.address,
            amount,
            isMint: true,
            nonce,
          },
          sigs
        )
      ).to.be.revertedWith("INS_SIGS");
    });

    it("Should reject invalid nonce", async function () {
      const amount = ethers.parseEther("1000");
      const assets = ethers.parseEther("1100");
      const wrongNonce = 5n; // Should be 1
      const attId = ethers.id("att-3");
      const chainId = (await ethers.provider.getNetwork()).chainId;

      const hash = ethers.solidityPackedKeccak256(
        [
          "bytes32",
          "uint256",
          "address",
          "uint256",
          "bool",
          "uint256",
          "uint256",
          "address",
        ],
        [
          attId,
          assets,
          user.address,
          amount,
          true,
          wrongNonce,
          chainId,
          await bridge.getAddress(),
        ]
      );

      const sigs = await signAndSort(hash, validators.slice(0, 3));

      await expect(
        bridge.executeAttestation(
          {
            id: attId,
            globalCantonAssets: assets,
            target: user.address,
            amount,
            isMint: true,
            nonce: wrongNonce,
          },
          sigs
        )
      ).to.be.revertedWith("INV_NONCE");
    });

    it("Should reject insufficient collateral ratio", async function () {
      const amount = ethers.parseEther("1000");
      const assets = ethers.parseEther("1050"); // Only 105%, need 110%
      const nonce = 1n;
      const attId = ethers.id("att-4");
      const chainId = (await ethers.provider.getNetwork()).chainId;

      const hash = ethers.solidityPackedKeccak256(
        [
          "bytes32",
          "uint256",
          "address",
          "uint256",
          "bool",
          "uint256",
          "uint256",
          "address",
        ],
        [
          attId,
          assets,
          user.address,
          amount,
          true,
          nonce,
          chainId,
          await bridge.getAddress(),
        ]
      );

      const sigs = await signAndSort(hash, validators.slice(0, 3));

      await expect(
        bridge.executeAttestation(
          {
            id: attId,
            globalCantonAssets: assets,
            target: user.address,
            amount,
            isMint: true,
            nonce,
          },
          sigs
        )
      ).to.be.revertedWith("GLOBAL_CR_LOW");
    });

    // FIX B-05: Test attestation ID reuse prevention
    it("Should reject reused attestation ID", async function () {
      const amount = ethers.parseEther("500");
      const assets = ethers.parseEther("550");
      const attId = ethers.id("reuse-test");
      const chainId = (await ethers.provider.getNetwork()).chainId;

      // First attestation
      const hash1 = ethers.solidityPackedKeccak256(
        [
          "bytes32",
          "uint256",
          "address",
          "uint256",
          "bool",
          "uint256",
          "uint256",
          "address",
        ],
        [
          attId,
          assets,
          user.address,
          amount,
          true,
          1n,
          chainId,
          await bridge.getAddress(),
        ]
      );

      const sigs1 = await signAndSort(hash1, validators.slice(0, 3));
      await bridge.executeAttestation(
        {
          id: attId,
          globalCantonAssets: assets,
          target: user.address,
          amount,
          isMint: true,
          nonce: 1n,
        },
        sigs1
      );

      // Try to reuse same attestation ID with nonce 2
      const hash2 = ethers.solidityPackedKeccak256(
        [
          "bytes32",
          "uint256",
          "address",
          "uint256",
          "bool",
          "uint256",
          "uint256",
          "address",
        ],
        [
          attId,
          assets,
          user.address,
          amount,
          true,
          2n,
          chainId,
          await bridge.getAddress(),
        ]
      );

      const sigs2 = await signAndSort(hash2, validators.slice(0, 3));

      await expect(
        bridge.executeAttestation(
          {
            id: attId,
            globalCantonAssets: assets,
            target: user.address,
            amount,
            isMint: true,
            nonce: 2n,
          },
          sigs2
        )
      ).to.be.revertedWith("ATTESTATION_ID_REUSED");
    });
  });

  // FIX TEST-03: Blacklist functionality tests
  describe("Compliance - Blacklist", function () {
    it("Should prevent minting to blacklisted address", async function () {
      await musd.setBlacklist(user.address, true);

      const amount = ethers.parseEther("1000");
      const assets = ethers.parseEther("1100");
      const nonce = 1n;
      const attId = ethers.id("blacklist-test");
      const chainId = (await ethers.provider.getNetwork()).chainId;

      const hash = ethers.solidityPackedKeccak256(
        [
          "bytes32",
          "uint256",
          "address",
          "uint256",
          "bool",
          "uint256",
          "uint256",
          "address",
        ],
        [
          attId,
          assets,
          user.address,
          amount,
          true,
          nonce,
          chainId,
          await bridge.getAddress(),
        ]
      );

      const sigs = await signAndSort(hash, validators.slice(0, 3));

      await expect(
        bridge.executeAttestation(
          {
            id: attId,
            globalCantonAssets: assets,
            target: user.address,
            amount,
            isMint: true,
            nonce,
          },
          sigs
        )
      ).to.be.revertedWith("RECEIVER_BLACKLISTED");
    });

    // FIX M-01: Test burn from blacklisted address is rejected
    it("Should prevent burning from blacklisted address", async function () {
      // First mint to user
      const amount = ethers.parseEther("1000");
      const assets = ethers.parseEther("1100");
      const chainId = (await ethers.provider.getNetwork()).chainId;

      const hash1 = ethers.solidityPackedKeccak256(
        [
          "bytes32",
          "uint256",
          "address",
          "uint256",
          "bool",
          "uint256",
          "uint256",
          "address",
        ],
        [
          ethers.id("mint-before-blacklist"),
          assets,
          user.address,
          amount,
          true,
          1n,
          chainId,
          await bridge.getAddress(),
        ]
      );

      const sigs1 = await signAndSort(hash1, validators.slice(0, 3));
      await bridge.executeAttestation(
        {
          id: ethers.id("mint-before-blacklist"),
          globalCantonAssets: assets,
          target: user.address,
          amount,
          isMint: true,
          nonce: 1n,
        },
        sigs1
      );

      // Approve bridge to burn user's tokens (must happen before blacklist)
      await musd.connect(user).approve(await bridge.getAddress(), amount);

      // Now blacklist the user
      await musd.setBlacklist(user.address, true);

      // Try to burn
      const hash2 = ethers.solidityPackedKeccak256(
        [
          "bytes32",
          "uint256",
          "address",
          "uint256",
          "bool",
          "uint256",
          "uint256",
          "address",
        ],
        [
          ethers.id("burn-blacklisted"),
          assets,
          user.address,
          amount,
          false,
          2n,
          chainId,
          await bridge.getAddress(),
        ]
      );

      const sigs2 = await signAndSort(hash2, validators.slice(0, 3));

      await expect(
        bridge.executeAttestation(
          {
            id: ethers.id("burn-blacklisted"),
            globalCantonAssets: assets,
            target: user.address,
            amount,
            isMint: false,
            nonce: 2n,
          },
          sigs2
        )
      ).to.be.revertedWith("SENDER_BLACKLISTED");
    });
  });

  // FIX TEST-03: Rate limiting tests
  describe("Rate Limiting", function () {
    it("Should enforce daily mint limit", async function () {
      const chainId = (await ethers.provider.getNetwork()).chainId;

      // Mint up to limit
      const amount1 = DAILY_MINT_LIMIT;
      const assets1 = (amount1 * 110n) / 100n;

      const hash1 = ethers.solidityPackedKeccak256(
        [
          "bytes32",
          "uint256",
          "address",
          "uint256",
          "bool",
          "uint256",
          "uint256",
          "address",
        ],
        [
          ethers.id("rate-1"),
          assets1,
          user.address,
          amount1,
          true,
          1n,
          chainId,
          await bridge.getAddress(),
        ]
      );

      const sigs1 = await signAndSort(hash1, validators.slice(0, 3));
      await bridge.executeAttestation(
        {
          id: ethers.id("rate-1"),
          globalCantonAssets: assets1,
          target: user.address,
          amount: amount1,
          isMint: true,
          nonce: 1n,
        },
        sigs1
      );

      // Try to mint more - should fail
      const amount2 = ethers.parseEther("1");
      const assets2 = (amount2 * 110n) / 100n;

      const hash2 = ethers.solidityPackedKeccak256(
        [
          "bytes32",
          "uint256",
          "address",
          "uint256",
          "bool",
          "uint256",
          "uint256",
          "address",
        ],
        [
          ethers.id("rate-2"),
          assets2,
          user.address,
          amount2,
          true,
          2n,
          chainId,
          await bridge.getAddress(),
        ]
      );

      const sigs2 = await signAndSort(hash2, validators.slice(0, 3));

      await expect(
        bridge.executeAttestation(
          {
            id: ethers.id("rate-2"),
            globalCantonAssets: assets2,
            target: user.address,
            amount: amount2,
            isMint: true,
            nonce: 2n,
          },
          sigs2
        )
      ).to.be.revertedWith("RATE_LIMIT");
    });

    // FIX B-03: Test that burns allow re-minting (net rate limiting)
    it("Should allow reminting after burn (net rate limiting)", async function () {
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const halfLimit = DAILY_MINT_LIMIT / 2n;

      // Mint half the limit
      const assets = (halfLimit * 110n) / 100n;
      const hash1 = ethers.solidityPackedKeccak256(
        [
          "bytes32",
          "uint256",
          "address",
          "uint256",
          "bool",
          "uint256",
          "uint256",
          "address",
        ],
        [
          ethers.id("net-1"),
          assets,
          user.address,
          halfLimit,
          true,
          1n,
          chainId,
          await bridge.getAddress(),
        ]
      );

      const sigs1 = await signAndSort(hash1, validators.slice(0, 3));
      await bridge.executeAttestation(
        {
          id: ethers.id("net-1"),
          globalCantonAssets: assets,
          target: user.address,
          amount: halfLimit,
          isMint: true,
          nonce: 1n,
        },
        sigs1
      );

      // Approve bridge to burn user's tokens
      await musd.connect(user).approve(await bridge.getAddress(), halfLimit);

      // Burn some
      const burnAmount = halfLimit / 2n;
      const hash2 = ethers.solidityPackedKeccak256(
        [
          "bytes32",
          "uint256",
          "address",
          "uint256",
          "bool",
          "uint256",
          "uint256",
          "address",
        ],
        [
          ethers.id("net-2"),
          assets,
          user.address,
          burnAmount,
          false,
          2n,
          chainId,
          await bridge.getAddress(),
        ]
      );

      const sigs2 = await signAndSort(hash2, validators.slice(0, 3));
      await bridge.executeAttestation(
        {
          id: ethers.id("net-2"),
          globalCantonAssets: assets,
          target: user.address,
          amount: burnAmount,
          isMint: false,
          nonce: 2n,
        },
        sigs2
      );

      // Should be able to mint again (net = halfLimit - burnAmount)
      const mintAgain = burnAmount;
      const hash3 = ethers.solidityPackedKeccak256(
        [
          "bytes32",
          "uint256",
          "address",
          "uint256",
          "bool",
          "uint256",
          "uint256",
          "address",
        ],
        [
          ethers.id("net-3"),
          assets,
          user.address,
          mintAgain,
          true,
          3n,
          chainId,
          await bridge.getAddress(),
        ]
      );

      const sigs3 = await signAndSort(hash3, validators.slice(0, 3));

      // This should succeed because burn reduced net minted
      await bridge.executeAttestation(
        {
          id: ethers.id("net-3"),
          globalCantonAssets: assets,
          target: user.address,
          amount: mintAgain,
          isMint: true,
          nonce: 3n,
        },
        sigs3
      );

      expect(await musd.balanceOf(user.address)).to.equal(halfLimit);
    });
  });

  // FIX TEST-03: Vault cooldown tests
  describe("SMUSD Vault Cooldown", function () {
    beforeEach(async function () {
      // Mint some MUSD to user for vault testing
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const amount = ethers.parseEther("10000");
      const assets = (amount * 110n) / 100n;

      const hash = ethers.solidityPackedKeccak256(
        [
          "bytes32",
          "uint256",
          "address",
          "uint256",
          "bool",
          "uint256",
          "uint256",
          "address",
        ],
        [
          ethers.id("vault-setup"),
          assets,
          user.address,
          amount,
          true,
          1n,
          chainId,
          await bridge.getAddress(),
        ]
      );

      const sigs = await signAndSort(hash, validators.slice(0, 3));
      await bridge.executeAttestation(
        {
          id: ethers.id("vault-setup"),
          globalCantonAssets: assets,
          target: user.address,
          amount,
          isMint: true,
          nonce: 1n,
        },
        sigs
      );

      // Approve vault
      await musd.connect(user).approve(await smusd.getAddress(), amount);
    });

    it("Should enforce cooldown on withdraw", async function () {
      const depositAmount = ethers.parseEther("1000");

      await smusd.connect(user).deposit(depositAmount, user.address);

      // Try immediate withdraw
      await expect(
        smusd.connect(user).withdraw(depositAmount, user.address, user.address)
      ).to.be.revertedWith("COOLDOWN_ACTIVE");
    });

    // FIX S-02: Test redeem also enforces cooldown
    it("Should enforce cooldown on redeem", async function () {
      const depositAmount = ethers.parseEther("1000");

      await smusd.connect(user).deposit(depositAmount, user.address);
      const shares = await smusd.balanceOf(user.address);

      // Try immediate redeem
      await expect(
        smusd.connect(user).redeem(shares, user.address, user.address)
      ).to.be.revertedWith("COOLDOWN_ACTIVE");
    });

    // FIX S-01: Test cooldown propagation on transfer
    it("Should propagate cooldown on transfer", async function () {
      const depositAmount = ethers.parseEther("1000");
      const [, , , recipient] = await ethers.getSigners();

      await smusd.connect(user).deposit(depositAmount, user.address);
      const shares = await smusd.balanceOf(user.address);

      // Transfer to recipient
      await smusd.connect(user).transfer(recipient.address, shares);

      // Recipient should inherit cooldown
      await expect(
        smusd.connect(recipient).withdraw(depositAmount, recipient.address, recipient.address)
      ).to.be.revertedWith("COOLDOWN_ACTIVE");
    });

    it("Should allow withdraw after cooldown", async function () {
      const depositAmount = ethers.parseEther("1000");

      await smusd.connect(user).deposit(depositAmount, user.address);

      // Fast forward 24 hours
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      // Should succeed now
      const balanceBefore = await musd.balanceOf(user.address);
      await smusd
        .connect(user)
        .withdraw(depositAmount, user.address, user.address);
      const balanceAfter = await musd.balanceOf(user.address);

      expect(balanceAfter - balanceBefore).to.equal(depositAmount);
    });
  });

  // Emergency Functions Tests
  describe("Emergency Functions", function () {
    it("Should allow EMERGENCY_ROLE to force update nonce", async function () {
      const EMERGENCY_ROLE = await bridge.EMERGENCY_ROLE();

      // Deployer has EMERGENCY_ROLE by default
      expect(await bridge.hasRole(EMERGENCY_ROLE, deployer.address)).to.be.true;

      const oldNonce = await bridge.currentNonce();
      const newNonce = 10n;

      await bridge.forceUpdateNonce(newNonce, "Stuck transaction recovery");

      expect(await bridge.currentNonce()).to.equal(newNonce);
    });

    it("Should reject nonce decrease", async function () {
      // First set nonce to 5
      await bridge.forceUpdateNonce(5n, "Initial set");

      // Try to decrease to 3 - should fail
      await expect(
        bridge.forceUpdateNonce(3n, "Attempting decrease")
      ).to.be.revertedWith("NONCE_CANNOT_DECREASE");
    });

    it("Should reject forceUpdateNonce without reason", async function () {
      await expect(
        bridge.forceUpdateNonce(10n, "")
      ).to.be.revertedWith("REASON_REQUIRED");
    });

    it("Should reject forceUpdateNonce from non-EMERGENCY_ROLE", async function () {
      await expect(
        bridge.connect(user).forceUpdateNonce(10n, "Unauthorized attempt")
      ).to.be.reverted;
    });

    it("Should allow invalidating attestation IDs", async function () {
      const attId = ethers.id("invalid-attestation");

      await bridge.invalidateAttestationId(attId, "Malformed attestation detected");

      expect(await bridge.usedAttestationIds(attId)).to.be.true;
    });

    it("Should emit NonceForceUpdated event", async function () {
      await expect(bridge.forceUpdateNonce(100n, "Network emergency"))
        .to.emit(bridge, "NonceForceUpdated")
        .withArgs(0n, 100n, "Network emergency");
    });
  });

  // NAV Oracle Tests
  describe("NAV Oracle", function () {
    let mockOracle: any;

    beforeEach(async function () {
      // Deploy a mock oracle
      const MockOracleFactory = await ethers.getContractFactory("MockAggregatorV3");
      mockOracle = await MockOracleFactory.deploy(8, 1100000_00000000n); // 8 decimals, 1.1M value
      await mockOracle.waitForDeployment();
    });

    it("Should allow setting NAV oracle", async function () {
      await bridge.setNavOracle(
        await mockOracle.getAddress(),
        500, // 5% max deviation
        true
      );

      expect(await bridge.navOracleEnabled()).to.be.true;
      expect(await bridge.maxNavDeviationBps()).to.equal(500n);
    });

    it("Should reject mints when NAV deviation too high", async function () {
      // Set oracle to report 500K (way less than 1.1M reported in attestation)
      await mockOracle.setAnswer(500000_00000000n);

      await bridge.setNavOracle(
        await mockOracle.getAddress(),
        500, // 5% max deviation
        true
      );

      const chainId = (await ethers.provider.getNetwork()).chainId;
      const amount = ethers.parseEther("1000");
      const assets = ethers.parseEther("1100"); // Way different from oracle's 500K

      const hash = ethers.solidityPackedKeccak256(
        ["bytes32", "uint256", "address", "uint256", "bool", "uint256", "uint256", "address"],
        [ethers.id("nav-test"), assets, user.address, amount, true, 1n, chainId, await bridge.getAddress()]
      );

      const sigs = await signAndSort(hash, validators.slice(0, 3));

      await expect(
        bridge.executeAttestation(
          {
            id: ethers.id("nav-test"),
            globalCantonAssets: assets,
            target: user.address,
            amount,
            isMint: true,
            nonce: 1n,
          },
          sigs
        )
      ).to.be.revertedWith("NAV_DEVIATION_TOO_HIGH");
    });

    it("Should pass when NAV within acceptable deviation", async function () {
      // Set oracle to report 1.1M (matching the attestation)
      await mockOracle.setAnswer(1100000_00000000n);

      await bridge.setNavOracle(
        await mockOracle.getAddress(),
        500, // 5% max deviation
        true
      );

      const chainId = (await ethers.provider.getNetwork()).chainId;
      const amount = ethers.parseEther("1000");
      const assets = ethers.parseEther("1100");

      const hash = ethers.solidityPackedKeccak256(
        ["bytes32", "uint256", "address", "uint256", "bool", "uint256", "uint256", "address"],
        [ethers.id("nav-pass"), assets, user.address, amount, true, 1n, chainId, await bridge.getAddress()]
      );

      const sigs = await signAndSort(hash, validators.slice(0, 3));

      await bridge.executeAttestation(
        {
          id: ethers.id("nav-pass"),
          globalCantonAssets: assets,
          target: user.address,
          amount,
          isMint: true,
          nonce: 1n,
        },
        sigs
      );

      expect(await musd.balanceOf(user.address)).to.equal(amount);
    });

    it("Should skip NAV check when disabled", async function () {
      // Oracle disabled by default
      expect(await bridge.navOracleEnabled()).to.be.false;

      const chainId = (await ethers.provider.getNetwork()).chainId;
      const amount = ethers.parseEther("1000");
      const assets = ethers.parseEther("1100");

      const hash = ethers.solidityPackedKeccak256(
        ["bytes32", "uint256", "address", "uint256", "bool", "uint256", "uint256", "address"],
        [ethers.id("no-nav"), assets, user.address, amount, true, 1n, chainId, await bridge.getAddress()]
      );

      const sigs = await signAndSort(hash, validators.slice(0, 3));

      // Should succeed without oracle check
      await bridge.executeAttestation(
        {
          id: ethers.id("no-nav"),
          globalCantonAssets: assets,
          target: user.address,
          amount,
          isMint: true,
          nonce: 1n,
        },
        sigs
      );

      expect(await musd.balanceOf(user.address)).to.equal(amount);
    });

    it("Should reject stale NAV data", async function () {
      await mockOracle.setAnswer(1100000_00000000n);
      // Make the oracle data stale (older than 1 hour)
      await mockOracle.setUpdatedAt(Math.floor(Date.now() / 1000) - 7200); // 2 hours ago

      await bridge.setNavOracle(
        await mockOracle.getAddress(),
        500,
        true
      );

      const chainId = (await ethers.provider.getNetwork()).chainId;
      const amount = ethers.parseEther("1000");
      const assets = ethers.parseEther("1100");

      const hash = ethers.solidityPackedKeccak256(
        ["bytes32", "uint256", "address", "uint256", "bool", "uint256", "uint256", "address"],
        [ethers.id("stale-nav"), assets, user.address, amount, true, 1n, chainId, await bridge.getAddress()]
      );

      const sigs = await signAndSort(hash, validators.slice(0, 3));

      await expect(
        bridge.executeAttestation(
          {
            id: ethers.id("stale-nav"),
            globalCantonAssets: assets,
            target: user.address,
            amount,
            isMint: true,
            nonce: 1n,
          },
          sigs
        )
      ).to.be.revertedWith("STALE_NAV_DATA");
    });
  });
});
