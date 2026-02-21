#!/usr/bin/env python3
"""Summarize the canton-balances API response."""
import json, urllib.request

r = urllib.request.urlopen("http://localhost:3000/api/canton-balances")
d = json.loads(r.read())

print("=== Canton Balances API Response ===")
print(f"Tokens: {len(d.get('tokens', []))}")

bs = d.get("bridgeService")
if bs:
    print(f"BridgeService: paused={bs.get('paused')}")

ss = d.get("stakingService")
if ss:
    print(f"StakingService: totalShares={ss.get('totalShares')}, pooledMusd={ss.get('pooledMusd')}")

ep = d.get("ethPoolService")
if ep:
    print(f"ETHPoolService: poolCap={ep.get('poolCap')}, paused={ep.get('paused')}")

bp = d.get("boostPoolService")
if bp:
    print(f"BoostPoolService: totalLP={bp.get('totalLPShares')}")

ls = d.get("lendingService")
if ls:
    print(f"LendingService: present")

dm = d.get("directMintService")
if dm:
    print(f"DirectMintService: present")

cr = d.get("complianceRegistry")
if cr:
    print(f"ComplianceRegistry: present")

sup = d.get("supplyService", {})
if sup:
    print(f"SupplyService: currentSupply={sup.get('currentSupply')}, cap={sup.get('supplyCap')}")

print()
print("STATUS: Canton side is AVAILABLE!")
