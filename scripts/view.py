#!/usr/bin/env python3
"""Read-only view calls against the deployed Patron contracts.

Usage: python3 scripts/view.py <contract> <method> [json-args]
Defaults to the testnet RPC from NETWORK_RPC in frontend/.env, or the public testnet RPC.
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.request

RPC = os.environ.get("NETWORK_RPC", "https://rpc.testnet.near.org")


def call(contract, method, args):
    payload = {
        "jsonrpc": "2.0",
        "id": "patron",
        "method": "query",
        "params": {
            "request_type": "call_function",
            "account_id": contract,
            "method_name": method,
            "args_base64": base64.b64encode(args.encode()).decode(),
            "finality": "optimistic",
        },
    }
    req = urllib.request.Request(
        RPC, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            out = json.loads(res.read())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{contract}.{method} -> HTTP {e.code}: {e.read().decode()[:400]}")
    if "error" in out:
        raise SystemExit(f"{contract}.{method} failed: {out['error']['message']}")
    result = out["result"]
    raw = result["result"]
    text = bytes(raw).decode() if isinstance(raw, list) else base64.b64decode(raw).decode()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    contract, method = sys.argv[1], sys.argv[2]
    args = sys.argv[3] if len(sys.argv) > 3 else "{}"
    print(json.dumps(call(contract, method, args), indent=2))
