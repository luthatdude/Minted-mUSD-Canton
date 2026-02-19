#!/usr/bin/env python3
"""Check all Canton token contracts owned by the devnet wallet party."""
import json, urllib.request

BASE = 'http://localhost:7575'
AUTH = 'Bearer dummy-no-auth'
PARTY = 'minted-validator-1::12203f16a8f4b26778d5c8c6847dc055acf5db91e0c5b0846de29ba5ea272ab2a0e4'
PKG = '0489a86388cc81e3e0bee8dc8f6781229d0e01451c1f2d19deea594255e5993b'

def api(method, path, body=None):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(f'{BASE}{path}', data=data, method=method,
                                headers={"Content-Type": "application/json", "Authorization": AUTH})
    resp = urllib.request.urlopen(req)
    return json.loads(resp.read())

# Get ledger offset
offset = api("GET", "/v2/state/ledger-end")["offset"]
print(f"Ledger offset: {offset}")
print(f"Party: {PARTY[:40]}...")
print()

# Fetch ALL active contracts for the party (API doesn't template-filter properly)
result = api("POST", "/v2/state/active-contracts", {
    "filter": {
        "filtersByParty": {
            PARTY: {
                "identifierFilter": {
                    "noFilter": {}
                }
            }
        }
    },
    "activeAtOffset": offset
})

# Client-side filter by our package
by_type = {}
for entry in result:
    ac = entry.get("contractEntry", {}).get("JsActiveContract")
    if not ac:
        continue
    evt = ac.get("createdEvent", {})
    tid = evt.get("templateId", "")
    # templateId format: "packageId:ModuleName:EntityName"
    parts = tid.split(":")
    if len(parts) < 3:
        continue
    pkg_id = parts[0]
    mod = parts[-2]
    ent = parts[-1]

    # Only show our ble-protocol contracts
    if pkg_id != PKG:
        continue

    payload = evt.get("createArgument", {}) or evt.get("createArguments", {})
    cid = evt.get("contractId", "")[:20]
    by_type.setdefault(f"{mod}:{ent}", []).append({
        "amount": payload.get("amount"),
        "cid": cid,
        "payload": payload,
    })

total = 0
for tname, items in sorted(by_type.items()):
    print(f"=== {tname} ({len(items)} contracts) ===")
    for it in items:
        if it["amount"] is not None:
            print(f"  Amount: {it['amount']}  (cid: {it['cid']}...)")
        else:
            # Service contract - show key fields
            p = it["payload"]
            extra = []
            for k in ["totalShares", "poolCap", "paused", "totalMusdStaked"]:
                if k in p:
                    extra.append(f"{k}={p[k]}")
            desc = ", ".join(extra) if extra else "service"
            print(f"  {desc}  (cid: {it['cid']}...)")
    print()
    total += len(items)

print(f"Total: {total} ble-protocol contracts in wallet")
