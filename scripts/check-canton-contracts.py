#!/usr/bin/env python3
"""Query all active contracts on Canton and display them."""
import json
import urllib.request

CANTON_URL = "http://localhost:7575"
PARTY = "minted-validator-1::12203f16a8f4b26778d5c8c6847dc055acf5db91e0c5b0846de29ba5ea272ab2a0e4"

def get_offset():
    req = urllib.request.Request(
        f"{CANTON_URL}/v2/state/ledger-end",
        headers={"Authorization": "Bearer dummy-no-auth"}
    )
    resp = urllib.request.urlopen(req)
    data = json.loads(resp.read())
    return data["offset"]

def query_contracts(offset):
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
    
    req = urllib.request.Request(
        f"{CANTON_URL}/v2/state/active-contracts",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer dummy-no-auth"
        },
        method="POST"
    )
    resp = urllib.request.urlopen(req)
    return json.loads(resp.read())

def main():
    offset = get_offset()
    print(f"Ledger offset: {offset}")
    
    contracts = query_contracts(offset)
    
    if isinstance(contracts, list):
        print(f"\nTotal active contracts: {len(contracts)}")
        
        # Group by template
        by_template = {}
        for entry in contracts:
            ac = entry.get("contractEntry", {}).get("JsActiveContract")
            if not ac:
                continue
            evt = ac["createdEvent"]
            tid = evt["templateId"]
            # Parse template: "pkgId:Module:Entity"
            parts = tid.split(":")
            if len(parts) >= 3:
                short = f"{parts[-2]}:{parts[-1]}"
            else:
                short = tid
            
            if short not in by_template:
                by_template[short] = []
            by_template[short].append(evt)
        
        print(f"\nTemplates found: {len(by_template)}")
        for tpl, events in sorted(by_template.items()):
            print(f"\n  [{tpl}] — {len(events)} contract(s)")
            for evt in events[:5]:  # Show first 5
                cid = evt["contractId"][:20] + "..."
                payload = evt.get("createArgument", {})
                # Show relevant payload fields
                summary_fields = {}
                for key in ["nonce", "amount", "user", "operator", "owner", "status", "ethAddress", "cantonRecipient", "ethTxHash"]:
                    if key in payload:
                        val = payload[key]
                        if isinstance(val, str) and len(val) > 40:
                            val = val[:20] + "..." + val[-10:]
                        summary_fields[key] = val
                if summary_fields:
                    print(f"    {cid}  {summary_fields}")
                else:
                    keys = list(payload.keys())[:8]
                    print(f"    {cid}  keys={keys}")
            if len(events) > 5:
                print(f"    ... and {len(events) - 5} more")
    else:
        print(f"Unexpected response: {json.dumps(contracts, indent=2)[:2000]}")

if __name__ == "__main__":
    main()
