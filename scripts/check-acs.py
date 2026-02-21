#!/usr/bin/env python3
"""Query Canton ACS and list all active contracts."""
import json
import urllib.request

BASE = "http://localhost:7575"
PARTY = "minted-validator-1::12203f16a8f4b26778d5c8c6847dc055acf5db91e0c5b0846de29ba5ea272ab2a0e4"

# Step 1: Get ledger end
r = urllib.request.urlopen(f"{BASE}/v2/state/ledger-end")
offset = json.loads(r.read())["offset"]
print(f"Ledger offset: {offset}")

# Step 2: Query ACS
body = json.dumps({
    "filter": {
        "filtersByParty": {
            PARTY: {
                "identifierFilter": {"wildcardFilter": {}}
            }
        }
    },
    "activeAtOffset": offset
}).encode()

req = urllib.request.Request(
    f"{BASE}/v2/state/active-contracts",
    data=body,
    headers={"Content-Type": "application/json"}
)
r = urllib.request.urlopen(req)
data = json.loads(r.read())

if isinstance(data, list):
    contracts = [e for e in data if "contractEntry" in e]
    print(f"Total active contracts: {len(contracts)}")
    templates = {}
    for c in contracts:
        ce = c["contractEntry"]
        # Navigate nested structure
        if isinstance(ce, dict):
            for key, val in ce.items():
                if isinstance(val, dict) and "createdEvent" in val:
                    tid = val["createdEvent"].get("templateId", "unknown")
                    templates[tid] = templates.get(tid, 0) + 1
                    break
                elif key == "createdEvent":
                    tid = val.get("templateId", "unknown")
                    templates[tid] = templates.get(tid, 0) + 1
                    break
            else:
                templates[str(list(ce.keys()))] = templates.get(str(list(ce.keys())), 0) + 1
    for t, count in sorted(templates.items()):
        print(f"  [{count}x] {t}")
elif isinstance(data, dict):
    if "code" in data:
        print(f"Error: {data.get('code')} - {data.get('cause','')}")
    else:
        print(json.dumps(data, indent=2)[:2000])
else:
    print(f"Unexpected response type: {type(data)}")
    print(str(data)[:500])
