#!/usr/bin/env python3
"""
Create missing Canton protocol contracts via HTTP JSON API v2.
Bypasses the DAML script when it can't be rebuilt.
"""
import urllib.request, json, sys, time, random, string

BASE = "http://localhost:7575"
PACKAGE_ID = "eff3bf30edb508b2d052f969203db972e59c66e974344ed43016cfccfa618f06"
OPERATOR = "minted-operator::12203f16a8f4b26778d5c8c6847dc055acf5db91e0c5b0846de29ba5ea272ab2a0e4"
GOVERNANCE = "minted-governance::12203f16a8f4b26778d5c8c6847dc055acf5db91e0c5b0846de29ba5ea272ab2a0e4"
VALIDATOR1 = "validator-1::12203f16a8f4b26778d5c8c6847dc055acf5db91e0c5b0846de29ba5ea272ab2a0e4"
USER_ID = "administrator"

def cmd_id():
    return f"init-{int(time.time())}-{''.join(random.choices(string.ascii_lowercase, k=6))}"

def submit(act_as, read_as, commands):
    body = {
        "userId": USER_ID,
        "actAs": act_as if isinstance(act_as, list) else [act_as],
        "readAs": read_as if isinstance(read_as, list) else [],
        "commandId": cmd_id(),
        "commands": commands,
    }
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{BASE}/v2/commands/submit-and-wait",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        r = urllib.request.urlopen(req)
        result = json.loads(r.read().decode())
        return True, result
    except urllib.error.HTTPError as e:
        err = e.read().decode()
        return False, err

def create_contract(module, entity, payload, act_as, read_as=None):
    cmd = {
        "createCommand": {
            "templateId": {
                "packageId": PACKAGE_ID,
                "moduleName": module,
                "entityName": entity,
            },
            "createArgument": payload,
        }
    }
    return submit(act_as, read_as or [], [cmd])

def main():
    print("=== Canton Protocol Bootstrap via HTTP API ===\n")

    # 1. BridgeService
    print("Creating BridgeService...")
    ok, result = create_contract(
        "Minted.Protocol.V3", "BridgeService",
        {
            "operator": OPERATOR,
            "governance": GOVERNANCE,
            "validators": [VALIDATOR1],
            "requiredSignatures": 1,
            "totalBridgedIn": "0.0",
            "totalBridgedOut": "0.0",
            "lastBridgeOutNonce": 0,
            "lastBridgeInNonce": 0,
            "paused": False,
            "observers": [VALIDATOR1],
            "minValidators": {"Some": 1},
        },
        act_as=[OPERATOR, GOVERNANCE],
    )
    if ok:
        print("  ✓ BridgeService created")
    else:
        print(f"  ✗ BridgeService failed: {result[:200]}")

    # 2. LiquidityPool (check if compatible ones exist first)
    print("Creating LiquidityPool...")
    ok, result = create_contract(
        "Minted.Protocol.V3", "LiquidityPool",
        {
            "operator": OPERATOR,
            "baseSymbol": "mUSD",
            "quoteSymbol": "ETH",
            "baseReserve": "1000000.0",
            "quoteReserve": "333.33",
            "exchangeRate": "3000.0",
            "oracleCid": None,  # Will be set later when oracle is found
            "spreadBps": {"Some": 30},
        },
        act_as=[OPERATOR],
    )
    if ok:
        print("  ✓ LiquidityPool created")
    else:
        print(f"  ✗ LiquidityPool failed: {result[:200]}")

    print("\n=== Done ===")

if __name__ == "__main__":
    main()
