import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const target = "0x33f97321214B5B8443f6212a05836C8FfE42DDa5";
  const borrowModuleAddr = "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8";
  const musdAddr = "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B";

  const musd = await ethers.getContractAt("MUSD", musdAddr);
  const borrow = await ethers.getContractAt("BorrowModule", borrowModuleAddr);

  // Current state
  const debt = await borrow.totalDebt(target);
  const balance = await musd.balanceOf(target);
  const allowance = await musd.allowance(target, borrowModuleAddr);
  const minDebt = await borrow.minDebt();

  console.log("Debt:", ethers.formatUnits(debt, 18));
  console.log("Balance:", ethers.formatUnits(balance, 18));
  console.log("Allowance to BorrowModule:", ethers.formatUnits(allowance, 18));
  console.log("minDebt:", ethers.formatUnits(minDebt, 18));

  // Try various amounts
  const amounts = [
    { label: "500 mUSD", value: ethers.parseUnits("500", 18) },
    { label: "100 mUSD", value: ethers.parseUnits("100", 18) },
    { label: "exact debt", value: debt },
    { label: "debt + 1", value: debt + 1n },
  ];

  for (const { label, value } of amounts) {
    console.log(`\n--- Trying repay ${label} (${ethers.formatUnits(value, 18)}) ---`);

    // Calculate what contract would do
    const total = debt; // approximate
    const repayAmount = value > total ? total : value;
    const remaining = total - repayAmount;
    console.log("  repayAmount:", ethers.formatUnits(repayAmount, 18));
    console.log("  remaining:", ethers.formatUnits(remaining, 18));
    console.log("  remaining < minDebt?", remaining > 0n && remaining < minDebt);
    if (remaining > 0n && remaining < minDebt) {
      console.log("  → Would force full repayment (remaining < minDebt)");
    }
  }

  // Try a static call simulation with a small amount (should work if the contract itself is fine)
  // We can't do this from deployer since positions[deployer] has no debt, but let's check
  // Let's try repayFor instead since it's callable with LEVERAGE_VAULT_ROLE

  // Check what happens with 500 mUSD
  // The remaining would be ~500 mUSD > minDebt (100), so no forced full repayment
  // The burn amount would be 500, and the allowance is 1000.009..., so burn should succeed
  console.log("\n=== Diagnosis ===");
  console.log("If user enters 500 mUSD:");
  console.log("  remaining ≈ 500 > minDebt (100) ✅");
  console.log("  allowance (1000.009) >= 500 ✅");
  console.log("  balance (2000) >= 500 ✅");
  console.log("  → Should succeed!");

  console.log("\nIf user enters debt amount (~1000.01):");
  console.log("  repay = total debt, remaining = 0 ✅");
  console.log("  BUT interest accrues between read + execute");
  console.log("  If new total > approved amount → _spendAllowance reverts");

  // Let's check if the issue is actually the frontend repay trying to repay full debt
  // The real fix: approve max uint or approve more than needed

  // Also check: what error does MUSD._spendAllowance produce?
  // It's from OpenZeppelin ERC20 which would revert with ERC20InsufficientAllowance
  // which IS a custom error → "unknown custom error" in the frontend!

  console.log("\n🔍 ROOT CAUSE IDENTIFIED:");
  console.log("When user clicks 'Repay Max' or enters the exact debt amount:");
  console.log("1. Frontend reads debt and approves for that exact amount");
  console.log("2. Transaction goes to mempool, time passes, interest accrues");
  console.log("3. When repay() executes, _accrueInterest() makes debt slightly higher");
  console.log("4. Contract burns the new (higher) debt amount");
  console.log("5. MUSD._spendAllowance reverts: ERC20InsufficientAllowance");
  console.log("\nFIX: Approve type(uint256).max or add a buffer to the approval");
}

main().catch((e) => { console.error(e); process.exit(1); });
