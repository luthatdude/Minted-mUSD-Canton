import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { BLEBridgeV9, MUSD, MockERC20, TreasuryV2 } from "../../typechain-types";

describe("UUPS upgrade regression", function () {
  it("preserves BLEBridgeV9 critical state across upgrade", async function () {
    const [admin, emergency] = await ethers.getSigners();

    const MUSDFactory = await ethers.getContractFactory("MUSD");
    const musd = (await MUSDFactory.deploy(ethers.parseEther("10000000"))) as MUSD;
    await musd.waitForDeployment();

    const BridgeFactory = await ethers.getContractFactory("BLEBridgeV9");
    const bridge = (await upgrades.deployProxy(
      BridgeFactory,
      [2, await musd.getAddress(), 11000, ethers.parseEther("1000000")],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as BLEBridgeV9;
    await bridge.waitForDeployment();

    await bridge.grantRole(await bridge.EMERGENCY_ROLE(), emergency.address);

    await bridge.setMinSignatures(3);
    await bridge.setCollateralRatio(11500);
    await bridge.setDailyCapIncreaseLimit(ethers.parseEther("2000000"));
    await bridge.forceUpdateNonce(7, "regression-test");
    await bridge.connect(emergency).pause();

    const beforeAddress = await bridge.getAddress();

    const BridgeNextFactory = await ethers.getContractFactory("BLEBridgeV9");
    const upgraded = (await upgrades.upgradeProxy(
      beforeAddress,
      BridgeNextFactory
    )) as unknown as BLEBridgeV9;

    expect(await upgraded.getAddress()).to.equal(beforeAddress);
    expect(await upgraded.musdToken()).to.equal(await musd.getAddress());
    expect(await upgraded.minSignatures()).to.equal(3);
    expect(await upgraded.collateralRatioBps()).to.equal(11500);
    expect(await upgraded.dailyCapIncreaseLimit()).to.equal(ethers.parseEther("2000000"));
    expect(await upgraded.currentNonce()).to.equal(7);
    expect(await upgraded.paused()).to.equal(true);
  });

  it("rejects unauthorized BLEBridgeV9 upgrade attempts", async function () {
    const [admin, unauthorized] = await ethers.getSigners();

    const MUSDFactory = await ethers.getContractFactory("MUSD");
    const musd = (await MUSDFactory.connect(admin).deploy(ethers.parseEther("10000000"))) as MUSD;
    await musd.waitForDeployment();

    const BridgeFactory = await ethers.getContractFactory("BLEBridgeV9", admin);
    const bridge = (await upgrades.deployProxy(
      BridgeFactory,
      [2, await musd.getAddress(), 11000, ethers.parseEther("1000000")],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as BLEBridgeV9;
    await bridge.waitForDeployment();

    const UnauthorizedBridgeFactory = await ethers.getContractFactory("BLEBridgeV9", unauthorized);
    await expect(
      upgrades.upgradeProxy(await bridge.getAddress(), UnauthorizedBridgeFactory)
    ).to.be.reverted;
  });

  it("preserves TreasuryV2 critical state across upgrade", async function () {
    const [admin, vault, feeRecipient] = await ethers.getSigners();

    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    const usdc = (await MockERC20Factory.deploy("USD Coin", "USDC", 6)) as MockERC20;
    await usdc.waitForDeployment();

    const TreasuryFactory = await ethers.getContractFactory("TreasuryV2");
    const treasury = (await upgrades.deployProxy(
      TreasuryFactory,
      [await usdc.getAddress(), vault.address, admin.address, feeRecipient.address],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as TreasuryV2;
    await treasury.waitForDeployment();

    await treasury.setReserveBps(1500);
    await treasury.setMinAutoAllocate(2_500_000_000n); // 2,500 USDC with 6 decimals
    await treasury.setFeeConfig(2500, feeRecipient.address);
    await treasury.pause();

    const beforeAddress = await treasury.getAddress();
    const beforeFees = await treasury.fees();

    const TreasuryNextFactory = await ethers.getContractFactory("TreasuryV2");
    const upgraded = (await upgrades.upgradeProxy(
      beforeAddress,
      TreasuryNextFactory
    )) as unknown as TreasuryV2;

    const afterFees = await upgraded.fees();
    expect(await upgraded.getAddress()).to.equal(beforeAddress);
    expect(await upgraded.asset()).to.equal(await usdc.getAddress());
    expect(await upgraded.vault()).to.equal(vault.address);
    expect(await upgraded.reserveBps()).to.equal(1500);
    expect(await upgraded.minAutoAllocateAmount()).to.equal(2_500_000_000n);
    expect(afterFees.performanceFeeBps).to.equal(beforeFees.performanceFeeBps);
    expect(afterFees.feeRecipient).to.equal(beforeFees.feeRecipient);
    expect(await upgraded.paused()).to.equal(true);
  });

  it("rejects unauthorized TreasuryV2 upgrade attempts", async function () {
    const [admin, vault, feeRecipient, unauthorized] = await ethers.getSigners();

    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    const usdc = (await MockERC20Factory.deploy("USD Coin", "USDC", 6)) as MockERC20;
    await usdc.waitForDeployment();

    const TreasuryFactory = await ethers.getContractFactory("TreasuryV2", admin);
    const treasury = (await upgrades.deployProxy(
      TreasuryFactory,
      [await usdc.getAddress(), vault.address, admin.address, feeRecipient.address],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as TreasuryV2;
    await treasury.waitForDeployment();

    const UnauthorizedTreasuryFactory = await ethers.getContractFactory("TreasuryV2", unauthorized);
    await expect(
      upgrades.upgradeProxy(await treasury.getAddress(), UnauthorizedTreasuryFactory)
    ).to.be.reverted;
  });
});
