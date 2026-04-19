#!/usr/bin/env python3
"""Peek at the OTLP JSONL structure to understand the datapoint format."""
import json

with open("bench/data/host-metrics.jsonl") as f:
    batch = json.loads(f.readline())

rm = batch["resourceMetrics"][0]
print("resource attributes:", json.dumps(rm.get("resource", {}).get("attributes", [])[:3], indent=2))
print()

sm = rm["scopeMetrics"][0]
print("scope:", sm.get("scope", {}).get("name", "?"))
print()

# Show a sum metric sample
for m in sm["metrics"]:
    if "sum" in m:
        dp = m["sum"]["dataPoints"][0]
        print(f"SUM metric: {m['name']}")
        print(f"  dp keys: {list(dp.keys())}")
        print(f"  sample: {json.dumps(dp, indent=2)[:600]}")
        print()
        break

# Show a gauge metric sample
for m in sm["metrics"]:
    if "gauge" in m:
        dp = m["gauge"]["dataPoints"][0]
        print(f"GAUGE metric: {m['name']}")
        print(f"  dp keys: {list(dp.keys())}")
        print(f"  sample: {json.dumps(dp, indent=2)[:600]}")
        print()
        break
