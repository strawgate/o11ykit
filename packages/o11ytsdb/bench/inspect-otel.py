#!/usr/bin/env python3
"""Inspect the OTLP JSONL file to see what metrics we're getting."""
import json, sys
from collections import Counter

path = sys.argv[1] if len(sys.argv) > 1 else "bench/data/host-metrics.jsonl"

with open(path) as f:
    lines = f.readlines()

print(f"Total batches (lines): {len(lines)}")

# Parse first batch to see unique metric names + counts
batch = json.loads(lines[0])
metric_counts = Counter()
for rm in batch.get("resourceMetrics", []):
    for sm in rm.get("scopeMetrics", []):
        for m in sm.get("metrics", []):
            name = m.get("name", "?")
            kind = "gauge" if "gauge" in m else "sum" if "sum" in m else "histogram" if "histogram" in m else "?"
            dps = m.get(kind, {}).get("dataPoints", [])
            metric_counts[(name, kind)] += len(dps)

print(f"\nUnique metric names in first batch: {len(metric_counts)}")
total_in_batch = 0
for (name, kind), n in sorted(metric_counts.items()):
    print(f"  {name:50s} {kind:10s} {n:6d} datapoints")
    total_in_batch += n
print(f"  {'TOTAL':50s} {'':10s} {total_in_batch:6d}")

# Count total datapoints across all batches
total_dp = 0
for line in lines:
    batch = json.loads(line)
    for rm in batch.get("resourceMetrics", []):
        for sm in rm.get("scopeMetrics", []):
            for m in sm.get("metrics", []):
                kind = "gauge" if "gauge" in m else "sum" if "sum" in m else "histogram" if "histogram" in m else "?"
                dps = m.get(kind, {}).get("dataPoints", [])
                total_dp += len(dps)

print(f"\nTotal datapoints across all {len(lines)} batches: {total_dp}")
