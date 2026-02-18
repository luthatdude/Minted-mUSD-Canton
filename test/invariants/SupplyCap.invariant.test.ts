import { expect } from "chai";
import { ethers } from "hardhat";
import { MUSD } from "../../typechain-types";

describe("SupplyCap invariant behavior", function () {
  const INITIAL_CAP = ethers.parseEther("1000");
  let musd: MUSD;
  let bridgeAddress: string;

  async function assertSupplyWithinCap() {
    const totalSupply = await musd.totalSupply();
    const cap = await musd.supplyCap();
    expect(totalSupply <= cap).to.equal(true);
  }

  beforeEach(async function () {
    const [deployer, bridge] = await ethers.getSigners();
    bridgeAddress = bridge.address;

    const MUSDFactory = await ethers.getContractFactory("MUSD");
    musd = await MUSDFactory.deploy(INITIAL_CAP);
    await musd.waitForDeployment();

    await musd.grantRole(await musd.BRIDGE_ROLE(), bridge.address);
    // CAP_MANAGER_ROLE is not required for deployer (already admin), but grant for explicitness.
    await musd.grantRole(await musd.CAP_MANAGER_ROLE(), deployer.address);
  });

  it("preserves totalSupply <= supplyCap across sequential mint/burn/cap updates", async function () {
    const [, bridge] = await ethers.getSigners();

    const ops: Array<{ kind: "mint" | "burn" | "setCap"; amount: bigint }> = [
      { kind: "mint", amount: ethers.parseEther("150") },
      { kind: "mint", amount: ethers.parseEther("220") },
      { kind: "burn", amount: ethers.parseEther("70") },
      { kind: "setCap", amount: ethers.parseEther("900") },
      { kind: "mint", amount: ethers.parseEther("300") },
      { kind: "burn", amount: ethers.parseEther("100") },
      { kind: "setCap", amount: ethers.parseEther("1200") },
      { kind: "mint", amount: ethers.parseEther("250") },
    ];

    for (const op of ops) {
      if (op.kind === "mint") {
        await musd.connect(bridge).mint(bridgeAddress, op.amount);
      } else if (op.kind === "burn") {
        await musd.connect(bridge).burn(bridgeAddress, op.amount);
      } else {
        await musd.setSupplyCap(op.amount);
      }
      await assertSupplyWithinCap();
    }

    // After reaching 750 supply and 1200 cap, minting 451 would exceed cap.
    await expect(
      musd.connect(bridge).mint(bridgeAddress, ethers.parseEther("451"))
    ).to.be.revertedWith("EXCEEDS_CAP");

    // Exact fill to cap should still succeed.
    await musd.connect(bridge).mint(bridgeAddress, ethers.parseEther("450"));
    expect(await musd.totalSupply()).to.equal(await musd.supplyCap());
  });

  it("blocks new mints when cap drops below outstanding supply until supply is reduced", async function () {
    const [, bridge] = await ethers.getSigners();

    await musd.connect(bridge).mint(bridgeAddress, ethers.parseEther("500"));
    await musd.setSupplyCap(ethers.parseEther("400"));

    expect(await musd.totalSupply()).to.equal(ethers.parseEther("500"));
    expect(await musd.supplyCap()).to.equal(ethers.parseEther("400"));

    // Under-collateralized cap mode: no new mint allowed.
    await expect(
      musd.connect(bridge).mint(bridgeAddress, ethers.parseEther("1"))
    ).to.be.revertedWith("EXCEEDS_CAP");

    // Burn down supply below cap, then minting is allowed again.
    await musd.connect(bridge).burn(bridgeAddress, ethers.parseEther("150"));
    await assertSupplyWithinCap();

    await musd.connect(bridge).mint(bridgeAddress, ethers.parseEther("50"));
    expect(await musd.totalSupply()).to.equal(ethers.parseEther("400"));
    expect(await musd.supplyCap()).to.equal(ethers.parseEther("400"));

    await expect(
      musd.connect(bridge).mint(bridgeAddress, ethers.parseEther("1"))
    ).to.be.revertedWith("EXCEEDS_CAP");
  });
});
