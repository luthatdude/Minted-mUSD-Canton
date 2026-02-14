#!/usr/bin/env python3
"""Parse coverage.json and produce a clean summary table."""
import json

data = json.load(open("coverage.json"))

core = [
    "BLEBridgeV9", "BorrowModule", "CollateralVault", "DirectMintV2", "MUSD",
    "TreasuryV2", "LeverageVault", "LiquidationEngine", "PriceOracle",
    "SMUSD", "RedemptionQueue", "InterestRateModel",
]

header = f"{'Contract':<50} {'Stmts':>8} {'Branch':>8} {'Funcs':>8}"
print(header)
print("-" * 78)

results = []
for path, info in sorted(data.items()):
    name = path.split("/")[-1].replace(".sol", "")
    if "Mock" in name or "Test" in name:
        continue

    s = info.get("s", {})
    b = info.get("b", {})
    f = info.get("f", {})

    total_s = len(s)
    hit_s = sum(1 for v in s.values() if v > 0) if total_s else 0
    total_b = sum(len(v) for v in b.values())
    hit_b = sum(1 for blist in b.values() for v in blist if v > 0) if total_b else 0
    total_f = len(f)
    hit_f = sum(1 for v in f.values() if v > 0) if total_f else 0

    pct_s = (hit_s / total_s * 100) if total_s else 0
    pct_b = (hit_b / total_b * 100) if total_b else 0
    pct_f = (hit_f / total_f * 100) if total_f else 0

    marker = " <<<" if name in core else ""
    results.append((name, pct_s, pct_b, pct_f, marker, name in core))
    print(f"{name:<50} {pct_s:>6.1f}% {pct_b:>7.1f}% {pct_f:>7.1f}%{marker}")

print("-" * 78)
print("\n=== 12 CORE CONTRACTS (was 0% before) ===\n")
for name, pct_s, pct_b, pct_f, _, is_core in results:
    if is_core:
        print(f"  {name:<45} {pct_s:>6.1f}% {pct_b:>7.1f}% {pct_f:>7.1f}%")
