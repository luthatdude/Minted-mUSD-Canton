import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("DepositRouter", function () {
  // Constants matching contract
  const MIN_DEPOSIT = ethers.parseUnits("1", 6); // 1 USDC
  const MAX_DEPOSIT = ethers.parseUnits("1000000", 6); // 1M USDC
  const DEFAULT_FEE_BPS = 30; // 0.30%
  const GAS_LIMIT = 250_000n;
  const MOCK_BRIDGE_COST = ethers.parseEther("0.01");

  async function deployFixture() {
    const [admin, pauser, user1, user2, treasury, directMint] = await ethers.getSigners();

    // Deploy MockERC20 for USDC
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    // Deploy mock Wormhole contracts
    const MockWormholeRelayer = await ethers.getContractFactory("MockWormholeRelayer");
    const wormholeRelayer = await MockWormholeRelayer.deploy(MOCK_BRIDGE_COST);

    const MockWormholeTokenBridge = await ethers.getContractFactory("MockWormholeTokenBridge");
    const tokenBridge = await MockWormholeTokenBridge.deploy();

    // Deploy MockWormhole core (for messageFee) and link to token bridge
    const MockWormhole = await ethers.getContractFactory("MockWormhole");
    const wormholeCore = await MockWormhole.deploy();
    await tokenBridge.setWormholeCore(await wormholeCore.getAddress());
    // Set messageFee to match MOCK_BRIDGE_COST
    await wormholeCore.setMessageFee(MOCK_BRIDGE_COST);

    // Deploy DepositRouter
    const DepositRouter = await ethers.getContractFactory("DepositRouter");
    const router = await DepositRouter.deploy(
      await usdc.getAddress(),
      await wormholeRelayer.getAddress(),
      await tokenBridge.getAddress(),
      treasury.address,
      directMint.address,
      DEFAULT_FEE_BPS,
      admin.address,
      admin.address // timelockController
    );

    // Mint USDC to users
    await usdc.mint(user1.address, ethers.parseUnits("100000", 6));
    await usdc.mint(user2.address, ethers.parseUnits("100000", 6));

    // Approve router
    await usdc.connect(user1).approve(await router.getAddress(), ethers.MaxUint256);
    await usdc.connect(user2).approve(await router.getAddress(), ethers.MaxUint256);

    // Grant pauser role
    const PAUSER_ROLE = await router.PAUSER_ROLE();
    await router.connect(admin).grantRole(PAUSER_ROLE, pauser.address);

    // Grant timelock role to admin for parameter changes
    const TIMELOCK_ROLE = await router.TIMELOCK_ROLE();
    await router.connect(admin).grantRole(TIMELOCK_ROLE, admin.address);

    return { router, usdc, wormholeRelayer, tokenBridge, admin, pauser, user1, user2, treasury, directMint };
  }

  describe("Deployment", function () {
    it("Should set correct initial state", async function () {
      const { router, usdc, treasury, directMint, admin } = await loadFixture(deployFixture);

      expect(await router.usdc()).to.equal(await usdc.getAddress());
      expect(await router.treasuryAddress()).to.equal(treasury.address);
      expect(await router.directMintAddress()).to.equal(directMint.address);
      expect(await router.feeBps()).to.equal(DEFAULT_FEE_BPS);
      expect(await router.accumulatedFees()).to.equal(0);
    });

    it("Should grant roles to admin", async function () {
      const { router, admin } = await loadFixture(deployFixture);

      const DEFAULT_ADMIN_ROLE = await router.DEFAULT_ADMIN_ROLE();
      const ROUTER_ADMIN_ROLE = await router.ROUTER_ADMIN_ROLE();
      const PAUSER_ROLE = await router.PAUSER_ROLE();

      expect(await router.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await router.hasRole(ROUTER_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await router.hasRole(PAUSER_ROLE, admin.address)).to.be.true;
    });

    it("Should revert on zero address parameters", async function () {
      const { usdc, wormholeRelayer, tokenBridge, treasury, directMint, admin } = await loadFixture(deployFixture);
      const DepositRouter = await ethers.getContractFactory("DepositRouter");

      await expect(
        DepositRouter.deploy(
          ethers.ZeroAddress,
          await wormholeRelayer.getAddress(),
          await tokenBridge.getAddress(),
          treasury.address,
          directMint.address,
          DEFAULT_FEE_BPS,
          admin.address,
          admin.address
        )
      ).to.be.revertedWithCustomError(DepositRouter, "InvalidAddress");
    });

    it("Should revert on fee too high", async function () {
      const { usdc, wormholeRelayer, tokenBridge, treasury, directMint, admin } = await loadFixture(deployFixture);
      const DepositRouter = await ethers.getContractFactory("DepositRouter");

      await expect(
        DepositRouter.deploy(
          await usdc.getAddress(),
          await wormholeRelayer.getAddress(),
          await tokenBridge.getAddress(),
          treasury.address,
          directMint.address,
          501, // > 5%
          admin.address,
          admin.address
        )
      ).to.be.revertedWithCustomError(DepositRouter, "FeeTooHigh");
    });
  });

  describe("Deposit", function () {
    it("Should accept valid deposit and emit event", async function () {
      const { router, usdc, user1 } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("1000", 6);
      const fee = (amount * BigInt(DEFAULT_FEE_BPS)) / 10000n;
      const netAmount = amount - fee;

      await expect(
        router.connect(user1).deposit(amount, { value: MOCK_BRIDGE_COST })
      ).to.emit(router, "DepositInitiated");

      expect(await router.accumulatedFees()).to.equal(fee);
    });

    it("Should calculate fees correctly", async function () {
      const { router } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("10000", 6);
      const [netAmount, fee] = await router.previewDeposit(amount);

      expect(fee).to.equal((amount * BigInt(DEFAULT_FEE_BPS)) / 10000n);
      expect(netAmount).to.equal(amount - fee);
    });

    it("Should revert on zero amount", async function () {
      const { router, user1 } = await loadFixture(deployFixture);

      await expect(
        router.connect(user1).deposit(0, { value: MOCK_BRIDGE_COST })
      ).to.be.revertedWithCustomError(router, "InvalidAmount");
    });

    it("Should revert on amount below minimum", async function () {
      const { router, user1 } = await loadFixture(deployFixture);

      await expect(
        router.connect(user1).deposit(MIN_DEPOSIT - 1n, { value: MOCK_BRIDGE_COST })
      ).to.be.revertedWithCustomError(router, "AmountBelowMinimum");
    });

    it("Should revert on amount above maximum", async function () {
      const { router, usdc, user1 } = await loadFixture(deployFixture);

      // Mint extra USDC
      await usdc.mint(user1.address, MAX_DEPOSIT + ethers.parseUnits("1", 6));

      await expect(
        router.connect(user1).deposit(MAX_DEPOSIT + 1n, { value: MOCK_BRIDGE_COST })
      ).to.be.revertedWithCustomError(router, "AmountAboveMaximum");
    });

    it("Should revert on insufficient native token", async function () {
      const { router, user1 } = await loadFixture(deployFixture);

      await expect(
        router.connect(user1).deposit(ethers.parseUnits("100", 6), { value: 0 })
      ).to.be.revertedWithCustomError(router, "InsufficientNativeToken");
    });

    it("Should refund excess native token", async function () {
      const { router, user1 } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("1000", 6);
      const excessValue = MOCK_BRIDGE_COST * 2n;

      const balanceBefore = await ethers.provider.getBalance(user1.address);
      const tx = await router.connect(user1).deposit(amount, { value: excessValue });
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;
      const balanceAfter = await ethers.provider.getBalance(user1.address);

      // Should only spend bridge cost + gas, not the excess
      expect(balanceBefore - balanceAfter - gasCost).to.be.closeTo(MOCK_BRIDGE_COST, ethers.parseEther("0.001"));
    });
  });

  describe("DepositFor", function () {
    it("Should accept deposit for another address", async function () {
      const { router, user1, user2 } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("1000", 6);

      await expect(
        router.connect(user1).depositFor(user2.address, amount, { value: MOCK_BRIDGE_COST })
      ).to.emit(router, "DepositInitiated");
    });

    it("Should revert on zero recipient", async function () {
      const { router, user1 } = await loadFixture(deployFixture);

      await expect(
        router.connect(user1).depositFor(ethers.ZeroAddress, ethers.parseUnits("100", 6), { value: MOCK_BRIDGE_COST })
      ).to.be.revertedWithCustomError(router, "InvalidAddress");
    });
  });

  describe("View Functions", function () {
    it("Should return correct bridge cost quote", async function () {
      const { router } = await loadFixture(deployFixture);

      const quote = await router.quoteBridgeCost();
      expect(quote).to.equal(MOCK_BRIDGE_COST);
    });

    it("Should track pending deposits", async function () {
      const { router, user1 } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("1000", 6);
      const tx = await router.connect(user1).deposit(amount, { value: MOCK_BRIDGE_COST });
      const receipt = await tx.wait();

      // Get sequence from event
      const event = receipt?.logs.find(
        (log: any) => log.fragment?.name === "DepositInitiated"
      );
      const sequence = (event as any)?.args?.sequence;

      const deposit = await router.getDeposit(sequence);
      expect(deposit.depositor).to.equal(user1.address);
      expect(deposit.completed).to.be.false;
    });

    it("Should report deposit completion status", async function () {
      const { router, user1 } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("1000", 6);
      await router.connect(user1).deposit(amount, { value: MOCK_BRIDGE_COST });

      expect(await router.isDepositComplete(1)).to.be.false;
    });
  });

  describe("Admin Functions", function () {
    it("Should update treasury address", async function () {
      const { router, admin, user1 } = await loadFixture(deployFixture);

      await expect(router.connect(admin).setTreasury(user1.address))
        .to.emit(router, "TreasuryUpdated");

      expect(await router.treasuryAddress()).to.equal(user1.address);
    });

    it("Should update DirectMint address", async function () {
      const { router, admin, user1 } = await loadFixture(deployFixture);

      await expect(router.connect(admin).setDirectMint(user1.address))
        .to.emit(router, "DirectMintUpdated");

      expect(await router.directMintAddress()).to.equal(user1.address);
    });

    it("Should update fee", async function () {
      const { router, admin } = await loadFixture(deployFixture);

      await expect(router.connect(admin).setFee(50))
        .to.emit(router, "FeeUpdated");

      expect(await router.feeBps()).to.equal(50);
    });

    it("Should revert on fee > 5%", async function () {
      const { router, admin } = await loadFixture(deployFixture);

      await expect(router.connect(admin).setFee(501))
        .to.be.revertedWithCustomError(router, "FeeTooHigh");
    });

    it("Should withdraw accumulated fees", async function () {
      const { router, usdc, admin, user1, treasury } = await loadFixture(deployFixture);

      // Make deposit to accumulate fees
      const amount = ethers.parseUnits("10000", 6);
      await router.connect(user1).deposit(amount, { value: MOCK_BRIDGE_COST });

      const fees = await router.accumulatedFees();
      expect(fees).to.be.gt(0);

      await expect(router.connect(admin).withdrawFees(treasury.address))
        .to.emit(router, "FeesWithdrawn")
        .withArgs(treasury.address, fees);

      expect(await router.accumulatedFees()).to.equal(0);
      expect(await usdc.balanceOf(treasury.address)).to.equal(fees);
    });

    it("Should revert admin functions for non-admin", async function () {
      const { router, user1 } = await loadFixture(deployFixture);

      await expect(router.connect(user1).setTreasury(user1.address))
        .to.be.reverted;

      await expect(router.connect(user1).setFee(50))
        .to.be.reverted;
    });
  });

  describe("Pause/Unpause", function () {
    it("Should pause and prevent deposits", async function () {
      const { router, pauser, user1 } = await loadFixture(deployFixture);

      await router.connect(pauser).pause();

      await expect(
        router.connect(user1).deposit(ethers.parseUnits("100", 6), { value: MOCK_BRIDGE_COST })
      ).to.be.revertedWithCustomError(router, "EnforcedPause");
    });

    it("Should unpause and allow deposits", async function () {
      const { router, admin, pauser, user1 } = await loadFixture(deployFixture);

      await router.connect(pauser).pause();
      await router.connect(admin).unpause();

      await expect(
        router.connect(user1).deposit(ethers.parseUnits("100", 6), { value: MOCK_BRIDGE_COST })
      ).to.emit(router, "DepositInitiated");
    });

    it("Should require DEFAULT_ADMIN_ROLE for unpause", async function () {
      const { router, pauser } = await loadFixture(deployFixture);

      await router.connect(pauser).pause();

      await expect(router.connect(pauser).unpause())
        .to.be.reverted;
    });
  });

  describe("Emergency Withdraw", function () {
    it("Should allow timelock to withdraw tokens to treasury when paused", async function () {
      const { router, usdc, admin, pauser, user1, treasury } = await loadFixture(deployFixture);

      // Deposit to get some USDC in contract
      await router.connect(user1).deposit(ethers.parseUnits("1000", 6), { value: MOCK_BRIDGE_COST });
      await router.connect(pauser).pause();

      const fees = await router.accumulatedFees();

      await router.connect(admin).emergencyWithdraw(await usdc.getAddress(), fees);

      expect(await usdc.balanceOf(treasury.address)).to.equal(fees);
    });

    it("Should allow timelock to withdraw native token to treasury when paused", async function () {
      const { router, admin, pauser, treasury } = await loadFixture(deployFixture);

      // Send ETH to contract
      await admin.sendTransaction({
        to: await router.getAddress(),
        value: ethers.parseEther("1.0")
      });
      await router.connect(pauser).pause();

      const balanceBefore = await ethers.provider.getBalance(treasury.address);

      await router.connect(admin).emergencyWithdraw(ethers.ZeroAddress, ethers.parseEther("1.0"));

      const balanceAfter = await ethers.provider.getBalance(treasury.address);
      expect(balanceAfter - balanceBefore).to.equal(ethers.parseEther("1.0"));
    });

    it("Should revert emergency withdraw for non-timelock", async function () {
      const { router, usdc, user1 } = await loadFixture(deployFixture);

      await expect(
        router.connect(user1).emergencyWithdraw(await usdc.getAddress(), 1)
      ).to.be.reverted;
    });

    it("Should revert emergency withdraw when not paused", async function () {
      const { router, usdc, admin } = await loadFixture(deployFixture);

      await expect(
        router.connect(admin).emergencyWithdraw(await usdc.getAddress(), 1)
      ).to.be.revertedWithCustomError(router, "ExpectedPause");
    });
  });
});
