import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("BLEBridgeSimple", function () {
  const COLLATERAL_RATIO = 10000n; // 100%
  const DAILY_CAP_LIMIT = ethers.parseEther("100");
  const INITIAL_CAP = ethers.parseEther("1000");

  async function deployFixture() {
    const [deployer, relayer, user] = await ethers.getSigners();

    const musdFactory = await ethers.getContractFactory("MUSD");
    const ctorArgCount = musdFactory.interface.deploy.inputs.length;
    const musd = ctorArgCount === 1
      ? await musdFactory.deploy(INITIAL_CAP)
      : await musdFactory.deploy(INITIAL_CAP, ethers.ZeroAddress);
    await musd.waitForDeployment();

    const bridgeFactory = await ethers.getContractFactory("BLEBridgeSimple");
    const bridge = await upgrades.deployProxy(bridgeFactory, [
      3, // kept for V9 storage/upgrade compatibility
      await musd.getAddress(),
      COLLATERAL_RATIO,
      DAILY_CAP_LIMIT,
      deployer.address, // timelock
    ]);
    await bridge.waitForDeployment();

    const bridgeRole = await musd.BRIDGE_ROLE();
    const capManagerRole = await musd.CAP_MANAGER_ROLE();
    await musd.grantRole(bridgeRole, await bridge.getAddress());
    await musd.grantRole(capManagerRole, await bridge.getAddress());

    const relayerRole = await bridge.RELAYER_ROLE();
    await bridge.grantRole(relayerRole, relayer.address);

    return { deployer, relayer, user, musd, bridge };
  }

  it("updates nonce, attested assets, and supply cap via updateCantonAssets", async function () {
    const { bridge, relayer, musd } = await deployFixture();
    const assets = ethers.parseEther("750");

    await expect(bridge.connect(relayer).updateCantonAssets(assets))
      .to.emit(bridge, "AttestationReceived");

    expect(await bridge.currentNonce()).to.equal(1n);
    expect(await bridge.attestedCantonAssets()).to.equal(assets);
    expect(await musd.supplyCap()).to.equal(assets); // 100% ratio
  });

  it("supports legacy processAttestation payloads via compatibility shim", async function () {
    const { bridge, relayer } = await deployFixture();
    const assets = ethers.parseEther("600");

    const legacyAtt = {
      id: ethers.ZeroHash,
      cantonAssets: assets,
      nonce: 0n,
      timestamp: 0n,
      entropy: ethers.ZeroHash,
      cantonStateHash: ethers.ZeroHash,
    };

    await expect(bridge.connect(relayer).processAttestation(legacyAtt, []))
      .to.emit(bridge, "AttestationReceived");

    expect(await bridge.currentNonce()).to.equal(1n);
    expect(await bridge.attestedCantonAssets()).to.equal(assets);
  });

  it("rate-limits large supply cap increases in simple mode", async function () {
    const { bridge, relayer, musd } = await deployFixture();

    await bridge.connect(relayer).updateCantonAssets(INITIAL_CAP); // nonce 1
    const capBefore = await musd.supplyCap();

    await time.increase(61);

    const largeAssets = INITIAL_CAP + ethers.parseEther("300");
    await bridge.connect(relayer).updateCantonAssets(largeAssets); // nonce 2

    const capAfter = await musd.supplyCap();
    expect(capAfter - capBefore).to.equal(DAILY_CAP_LIMIT);
  });

  it("burns mUSD and emits BridgeToCantonRequested", async function () {
    const { bridge, deployer, user, musd } = await deployFixture();
    const mintAmount = ethers.parseEther("200");
    const bridgeAmount = ethers.parseEther("25");

    const bridgeRole = await musd.BRIDGE_ROLE();
    await musd.grantRole(bridgeRole, deployer.address);
    await musd.mint(user.address, mintAmount);

    await bridge.setBridgeOutMinAmount(ethers.parseEther("10"));
    await musd.connect(user).approve(await bridge.getAddress(), bridgeAmount);

    const before = await musd.balanceOf(user.address);
    await expect(
      bridge.connect(user).bridgeToCanton(bridgeAmount, "minted-user-1::1220abc123")
    ).to.emit(bridge, "BridgeToCantonRequested");

    const after = await musd.balanceOf(user.address);
    expect(before - after).to.equal(bridgeAmount);
    expect(await bridge.bridgeOutNonce()).to.equal(1n);
  });

  it("preserves state across UUPS upgrade from BLEBridgeSimple to BLEBridgeV9", async function () {
    const { bridge, relayer, musd } = await deployFixture();

    const assets = ethers.parseEther("700");
    await bridge.connect(relayer).updateCantonAssets(assets);
    const capBefore = await musd.supplyCap();
    await bridge.setBridgeOutMinAmount(ethers.parseEther("15"));

    const v9Factory = await ethers.getContractFactory("BLEBridgeV9");
    const upgraded = await upgrades.upgradeProxy(await bridge.getAddress(), v9Factory);
    await upgraded.waitForDeployment();

    expect(await upgraded.currentNonce()).to.equal(1n);
    expect(await upgraded.attestedCantonAssets()).to.equal(assets);
    expect(await upgraded.getCurrentSupplyCap()).to.equal(capBefore);
    expect(await upgraded.bridgeOutMinAmount()).to.equal(ethers.parseEther("15"));
    expect(await upgraded.dailyCapIncreaseLimit()).to.equal(DAILY_CAP_LIMIT);
  });
});
