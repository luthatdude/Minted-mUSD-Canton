import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { MockERC20, MockStrategy, TreasuryV2 } from "../../typechain-types";

describe("Loop function gas benchmarks", function () {
  function splitBps(total: number, parts: number): number[] {
    const base = Math.floor(total / parts);
    const arr = Array(parts).fill(base);
    let rem = total - base * parts;
    let i = 0;
    while (rem > 0) {
      arr[i]++;
      rem--;
      i = (i + 1) % parts;
    }
    return arr;
  }

  async function benchmarkRebalance(strategyCount: number): Promise<bigint> {
    const [admin, feeRecipient] = await ethers.getSigners();

    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    const usdc = (await MockERC20Factory.deploy("USD Coin", "USDC", 6)) as MockERC20;
    await usdc.waitForDeployment();

    const TreasuryFactory = await ethers.getContractFactory("TreasuryV2");
    const treasury = (await upgrades.deployProxy(
      TreasuryFactory,
      [await usdc.getAddress(), admin.address, admin.address, feeRecipient.address, admin.address],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as TreasuryV2;
    await treasury.waitForDeployment();

    const targets = splitBps(9000, strategyCount); // reserveBps defaults to 1000
    const strategyAddresses: string[] = [];

    for (let i = 0; i < strategyCount; i++) {
      const MockStrategyFactory = await ethers.getContractFactory("MockStrategy");
      const strategy = (await MockStrategyFactory.deploy(
        await usdc.getAddress(),
        await treasury.getAddress()
      )) as MockStrategy;
      await strategy.waitForDeployment();
      strategyAddresses.push(await strategy.getAddress());

      await treasury.addStrategy(
        strategyAddresses[i],
        targets[i],
        0,
        9000,
        true
      );
    }

    // Seed treasury via deposit() path; auto-allocation creates baseline spread.
    const depositAmount = 1_000_000_000_000n; // 1,000,000 USDC
    await usdc.mint(admin.address, depositAmount);
    await usdc.approve(await treasury.getAddress(), depositAmount);
    await treasury.deposit(admin.address, depositAmount);

    // Force an allocation target shift so rebalance does meaningful loop work.
    const shiftedTargets =
      strategyCount === 1
        ? [9000]
        : (() => {
            const out = [100];
            const tail = splitBps(8900, strategyCount - 1);
            return out.concat(tail);
          })();

    for (let i = 0; i < strategyCount; i++) {
      await treasury.updateStrategy(
        strategyAddresses[i],
        shiftedTargets[i],
        0,
        9000,
        true
      );
    }

    const gasEstimate = await treasury.rebalance.estimateGas();
    const tx = await treasury.rebalance();
    const receipt = await tx.wait();
    expect(receipt).to.not.equal(null);
    expect(receipt!.gasUsed).to.be.gte(gasEstimate / 2n); // sanity floor
    return receipt!.gasUsed;
  }

  it("keeps rebalance gas within a safe bound at 5 strategies", async function () {
    const gasUsed = await benchmarkRebalance(5);
    // Conservative ceiling for CI stability while still catching major regressions.
    expect(gasUsed).to.be.lt(3_500_000n);
  });

  it("shows increasing gas usage as strategy-loop count grows", async function () {
    const gas1 = await benchmarkRebalance(1);
    const gas3 = await benchmarkRebalance(3);
    const gas5 = await benchmarkRebalance(5);

    expect(gas3).to.be.gt(gas1);
    expect(gas5).to.be.gt(gas3);
  });
});
