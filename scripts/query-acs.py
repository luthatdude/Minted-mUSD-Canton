#!/usr/bin/env python3
"""Query all active contracts on the Canton participant."""
import urllib.request, json, sys

BASE = "http://localhost:7575"
PARTY = "minted-validator-1::12203f16a8f4b26778d5c8c6847dc055acf5db91e0c5b0846de29ba5ea272ab2a0e4"

# Also try with operator party
OPERATOR = "minted-operator::12203f16a8f4b26778d5c8c6847dc055acf5db91e0c5b0846de29ba5ea272ab2a0e4"

def query_acs(party, label):
    print(f"\n=== ACS for {label} ({party[:30]}...) ===")
    r = urllib.request.urlopen(BASE + "/v2/state/ledger-end")
    offset = json.loads(r.read())["offset"]
    print(f"Ledger offset: {offset}")

    body = json.dumps({
        "filter": {
            "filtersByParty": {
                party: {
                    "identifierFilter": {"wildcardFilter": {}}
                }
            }
        },
        "activeAtOffset": offset
    }).encode()
    req = urllib.request.Request(
        BASE + "/v2/state/active-contracts",
        data=body,
        headers={"Content-Type": "application/json"}
    )
    r = urllib.request.urlopen(req)
    data = r.read().decode()
    
    contracts = []
    for line in data.strip().split("\n"):
        if not line.strip():
            continue
        try:
            d = json.loads(line)
            if "contractEntry" in d:
                ce = d["contractEntry"]
                evt = ce.get("createdEvent", {})
                cid = evt.get("contractId", "?")
                tid = evt.get("templateId", "?")
                pkg = evt.get("packageName", "?")
                contracts.append({"cid": cid, "tid": tid, "pkg": pkg})
                print(f"  {tid}  pkg={pkg}  CID={cid[:50]}...")
        except Exception as e:
            pass
    
    if not contracts:
        print("  (no contracts found)")
    return contracts

c1 = query_acs(PARTY, "validator-1")
c2 = query_acs(OPERATOR, "operator")

# Collect all BLE protocol contract IDs
ble_cids = []
for c in c1 + c2:
    tid = c["tid"]
    if isinstance(tid, str) and "Minted" in tid:
        ble_cids.append(c["cid"])
    elif isinstance(tid, dict):
        mod = tid.get("moduleName", "")
        if "Minted" in mod or "Compliance" in mod or "CantonDirect" in mod or "CantonCoin" in mod:
            ble_cids.append(c["cid"])

if ble_cids:
    print(f"\n=== BLE Protocol Contracts to Purge: {len(ble_cids)} ===")
    for cid in ble_cids:
        print(f"  {cid}")
else:
    print("\nNo BLE protocol contracts found.")
