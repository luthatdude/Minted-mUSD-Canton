#!/usr/bin/env python3
"""Check all active BridgeInRequest and mUSD contracts on Canton via v2 API."""
import json, urllib.request
from collections import Counter

URL = "http://localhost:7575/v2/state/active-contracts"
TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJtaW50ZWQtdmFsaWRhdG9yLTEiLCJzY29wZSI6ImRhbWxfbGVkZ2VyX2FwaSIsImFkbWluIjp0cnVlfQ.GZ-yxIoix6vJi-4xfhFbVv-pRzJjv30z2EZJGmhOF6c"
PARTY = "minted-validator-1::12203f16a8f4b26778d5c8c6847dc055acf5db91e0c5b0846de29ba5ea272ab2a0e4"

# First get ledger end
end_req = urllib.request.Request(
    "http://localhost:7575/v2/state/ledger-end",
    headers={"Authorization": f"Bearer {TOKEN}"}
)
with urllib.request.urlopen(end_req) as resp:
    end_data = json.loads(resp.read())
offset = end_data.get("offset", 0)
print(f"Ledger end offset: {offset}")

body = json.dumps({
    "filter": {
        "filtersByParty": {
            PARTY: {
                "identifierFilter": {
                    "wildcardFilter": {}
                }
            }
        }
    },
    "activeAtOffset": offset
}).encode()

req = urllib.request.Request(URL, data=body, headers={
    "Content-Type": "application/json",
    "Authorization": f"Bearer {TOKEN}"
})

with urllib.request.urlopen(req) as resp:
    data = json.loads(resp.read())

# data is an array of entries
if isinstance(data, dict):
    entries = data.get("result", [])
elif isinstance(data, list):
    entries = data
else:
    entries = []

print(f"Total entries: {len(entries)}")

bridge_ins = []
musd_tokens = []
all_templates = []

for entry in entries:
    ce_wrapper = entry.get("contractEntry", {})
    ac = ce_wrapper.get("JsActiveContract", {})
    if not ac:
        continue
    ce = ac.get("createdEvent", {})
    tid = ce.get("templateId", "?")
    args = ce.get("createArgument", {})
    cid = ce.get("contractId", "?")
    
    all_templates.append(tid)
    
    if "BridgeInRequest" in str(tid):
        bridge_ins.append((tid, args, cid))
    elif "MUSD" in str(tid) or "MintedMUSD" in str(tid) or "CantonMUSD" in str(tid):
        musd_tokens.append((tid, args, cid))

print(f"\n=== All Template Types ===")
for tid, count in Counter(all_templates).items():
    parts = tid.split(":")
    short = ":".join(parts[-2:]) if len(parts) >= 3 else tid
    print(f"  {short}: {count}")

print(f"\n=== BridgeInRequests: {len(bridge_ins)} ===")
for tid, args, cid in bridge_ins[:5]:
    parts = tid.split(":")
    short = ":".join(parts[-2:]) if len(parts) >= 3 else tid
    print(f"  template: {short}")
    print(f"  contractId: {cid[:50]}...")
    print(f"  nonce: {args.get('nonce')}, status: {args.get('status')}")
    print(f"  validators: {args.get('validators')}, reqSigs: {args.get('requiredSignatures')}")
    print(f"  amount: {args.get('amount')}")
    print()

if len(bridge_ins) > 5:
    print(f"  ... and {len(bridge_ins) - 5} more")

print(f"\n=== mUSD Tokens: {len(musd_tokens)} ===")
for tid, args, cid in musd_tokens:
    parts = tid.split(":")
    short = ":".join(parts[-2:]) if len(parts) >= 3 else tid
    print(f"  template: {short}")
    print(f"  contractId: {cid[:50]}...")
    print(f"  amount: {args.get('amount')}, owner: {str(args.get('owner',''))[:50]}...")
    print()
