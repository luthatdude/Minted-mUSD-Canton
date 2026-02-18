import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { DirectMintV2, MockERC20, MUSD, TreasuryV2 } from "../../typechain-types";

describe("FeeMath fuzz behavior", function () {
  let directMint: DirectMintV2;
  let usdc: MockERC20;
  let musd: MUSD;
  let treasury: TreasuryV2;
  let userAddress: string;

  // Deterministic pseudo-random generator for reproducible fuzz loops.
  let rngState = 0x1234ABCDn;
  const RNG_MOD = 2n ** 31n;
  const nextRand = (maxExclusive: bigint): bigint => {
    rngState = (1103515245n * rngState + 12345n) % RNG_MOD;
    return rngState % maxExclusive;
  };

  beforeEach(async function () {
    const [deployer, user, feeRecipient] = await ethers.getSigners();
    userAddress = user.address;

    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    usdc = (await MockERC20Factory.deploy("USD Coin", "USDC", 6)) as MockERC20;
    await usdc.waitForDeployment();

    const MUSDFactory = await ethers.getContractFactory("MUSD");
    musd = (await MUSDFactory.deploy(ethers.parseEther("1000000000"))) as MUSD;
    await musd.waitForDeployment();

    const TreasuryFactory = await ethers.getContractFactory("TreasuryV2");
    treasury = (await upgrades.deployProxy(
      TreasuryFactory,
      [await usdc.getAddress(), deployer.address, deployer.address, feeRecipient.address],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as TreasuryV2;
    await treasury.waitForDeployment();

    const DirectMintFactory = await ethers.getContractFactory("DirectMintV2");
    directMint = (await DirectMintFactory.deploy(
      await usdc.getAddress(),
      await musd.getAddress(),
      await treasury.getAddress(),
      feeRecipient.address
    )) as DirectMintV2;
    await directMint.waitForDeployment();

    await musd.grantRole(await musd.BRIDGE_ROLE(), await directMint.getAddress());
    await treasury.grantRole(await treasury.VAULT_ROLE(), await directMint.getAddress());

    // Large user balance to support iterative fuzz rounds.
    await usdc.mint(userAddress, 500_000_000_000n); // 500,000 USDC (6 decimals)
    await usdc.connect(user).approve(await directMint.getAddress(), ethers.MaxUint256);
    await musd.connect(user).approve(await directMint.getAddress(), ethers.MaxUint256);
  });

  it("matches mint/redeem fee math across deterministic fuzz rounds", async function () {
    const [, user] = await ethers.getSigners();
    const rounds = 40;

    for (let i = 0; i < rounds; i++) {
      const mintFeeBps = Number(nextRand(501n)); // [0,500]
      const redeemFeeBps = Number(nextRand(501n)); // [0,500]
      await directMint.setFees(mintFeeBps, redeemFeeBps);

      // Keep amounts above min redeem even at max fee.
      const usdcAmount = 2_000_000n + nextRand(50_000_000_000n); // 2 USDC .. 50,002 USDC
      const expectedMintFee = (usdcAmount * BigInt(mintFeeBps)) / 10_000n;
      const expectedUsdcAfterFee = usdcAmount - expectedMintFee;
      const expectedMusdOut = expectedUsdcAfterFee * (10n ** 12n);

      const [previewMusdOut, previewMintFee] = await directMint.previewMint(usdcAmount);
      expect(previewMintFee).to.equal(expectedMintFee);
      expect(previewMusdOut).to.equal(expectedMusdOut);

      const mintFeesBefore = await directMint.mintFees();
      const userMusdBefore = await musd.balanceOf(userAddress);

      await directMint.connect(user).mint(usdcAmount);

      const userMusdAfter = await musd.balanceOf(userAddress);
      const mintedNow = userMusdAfter - userMusdBefore;
      expect(mintedNow).to.equal(expectedMusdOut);
      expect(await directMint.mintFees()).to.equal(mintFeesBefore + expectedMintFee);

      // Redeem full minted amount and validate fee arithmetic.
      const usdcBeforeRedeem = await usdc.balanceOf(userAddress);
      const redeemFeesBefore = await directMint.redeemFees();

      let expectedRedeemFee = (expectedMusdOut * BigInt(redeemFeeBps)) / ((10n ** 12n) * 10_000n);
      if (redeemFeeBps > 0 && expectedRedeemFee === 0n) {
        expectedRedeemFee = 1n; // Contract minimum-fee protection
      }
      const expectedUsdcOut = expectedUsdcAfterFee - expectedRedeemFee;

      await directMint.connect(user).redeem(expectedMusdOut);

      const usdcAfterRedeem = await usdc.balanceOf(userAddress);
      expect(usdcAfterRedeem - usdcBeforeRedeem).to.equal(expectedUsdcOut);
      expect(await directMint.redeemFees()).to.equal(redeemFeesBefore + expectedRedeemFee);
      expect(await musd.balanceOf(userAddress)).to.equal(userMusdBefore); // round-trip complete
      expect(await musd.totalSupply()).to.equal(0n); // fully redeemed in each round
    }
  });

  it("enforces minimum redeem fee of 1 when non-zero bps and tiny redemption are allowed", async function () {
    const [, user] = await ethers.getSigners();

    // Allow tiny redeem amounts to exercise the low-value fee branch.
    await directMint.setLimits(1, 1_000_000_000_000n, 1, 1_000_000_000_000n);
    await directMint.setFees(0, 1); // 0.01% redeem fee

    // Mint 1 USDC worth of mUSD.
    await directMint.connect(user).mint(1_000_000n);

    // Redeem 1 wei USDC-equivalent in mUSD units.
    const tinyMusd = 2n * (10n ** 12n);
    const redeemFeesBefore = await directMint.redeemFees();
    await directMint.connect(user).redeem(tinyMusd);

    // Raw fee math would be 0, contract enforces minimum fee of 1.
    expect(await directMint.redeemFees()).to.equal(redeemFeesBefore + 1n);
  });
});
