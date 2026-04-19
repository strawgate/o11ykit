#!/usr/bin/env python3
"""Count distinct time series in the OTLP JSONL file."""
import json, sys

path = sys.argv[1] if len(sys.argv) > 1 else "bench/data/host-metrics.jsonl"

with open(path) as f:
    batch = json.loads(f.readline())

series = set()
for rm in batch.get("resourceMetrics", []):
    for sm in rm.get("scopeMetrics", []):
        for m in sm.get("metrics", []):
            name = m["name"]
            kind = "gauge" if "gauge" in m else "sum" if "sum" in m else "histogram"
            for dp in m.get(kind, {}).get("dataPoints", []):
                attrs = tuple(
                    sorted(
                        (a["key"], str(a.get("value", {}).get("stringValue", a.get("value", {}).get("intValue", ""))))
                        for a in dp.get("attributes", [])
                    )
                )
                series.add((name, attrs))

print(f"Distinct time series: {len(series)}")
print()
by_metric = {}
for name, attrs in series:
    by_metric.setdefault(name, []).append(attrs)
for name in sorted(by_metric):
    print(f"  {name:50s} {len(by_metric[name]):4d} series")
