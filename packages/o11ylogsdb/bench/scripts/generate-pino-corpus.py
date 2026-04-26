#!/usr/bin/env python3
"""
Generate a synthetic Pino-shaped KVList corpus for KVList round-trip benches.

Produces 5,000 OTLP-shaped LogRecords whose `body` field is a
Pino-style JSON object (KVList). Distribution is plausible and
deterministic (fixed RNG seed) so the corpus byte-exactly reproduces
across runs.

Output: bench/corpora/synthetic/pino_5k.ndjson — one OTLP-NDJSON line
per record, no pretty-printing. Idempotent: skips when output file
already exists with non-zero size.

This corpus baselines the body/KVList row in PLAN.md's storage budget
(target: 1.4 B/log via recursive flatten → per-key columns). Real
OTLP traffic has ~39% KVList bodies per the body-shape survey, but no committed
KVList corpus existed prior to this experiment.

Usage:
    python3 bench/scripts/generate-pino-corpus.py
"""

from __future__ import annotations

import json
import random
import sys
import uuid
from pathlib import Path

N_RECORDS = 5_000
SEED = 0xB1665EED  # deterministic; unrelated to Pino but easy to spot
SERVICES = ("api", "worker", "auth")
SEVERITIES = (("INFO", 80), ("WARN", 15), ("ERROR", 5))

# ~15 distinct message templates. Real Pino apps emit a small set of
# repeating msg strings; the variety lives in the rest of the KVList.
MSG_TEMPLATES = (
    "incoming request",
    "request completed",
    "user authenticated",
    "token issued",
    "token refresh",
    "token rejected",
    "cache miss",
    "cache hit",
    "db query executed",
    "db connection acquired",
    "db connection released",
    "queue job processed",
    "queue job failed",
    "rate limit exceeded",
    "downstream call failed",
)

METHODS = ("GET", "POST")
STATUS_CODES = (200, 200, 200, 200, 200, 200, 200, 200, 404, 500)  # weighted

# Roughly 50 distinct paths. Generate deterministically so the same set
# is reused across runs.
PATH_PREFIXES = ("api", "v1", "v2", "internal", "admin")
PATH_NOUNS = (
    "users", "accounts", "orders", "products", "carts",
    "sessions", "tokens", "events", "audit", "search",
)


def build_paths(rng: random.Random, n: int = 50) -> list[str]:
    paths: set[str] = set()
    while len(paths) < n:
        depth = rng.choice((1, 2, 2, 3))
        parts = ["/" + rng.choice(PATH_PREFIXES)]
        for _ in range(depth):
            parts.append("/" + rng.choice(PATH_NOUNS))
            if rng.random() < 0.3:
                # Numeric ID segment — lifts cardinality realistically.
                parts.append(f"/{rng.randint(1, 9999)}")
        paths.add("".join(parts))
    return sorted(paths)


def weighted(rng: random.Random, items: tuple[tuple[str, int], ...]) -> str:
    total = sum(w for _, w in items)
    pick = rng.uniform(0, total)
    acc = 0
    for value, weight in items:
        acc += weight
        if pick < acc:
            return value
    return items[-1][0]


def make_record(
    rng: random.Random,
    *,
    service: str,
    pid: int,
    hostname: str,
    timestamp_nanos: int,
    paths: list[str],
) -> dict:
    severity = weighted(rng, SEVERITIES)
    msg = rng.choice(MSG_TEMPLATES)
    method = rng.choice(METHODS)
    url = rng.choice(paths)
    status = rng.choice(STATUS_CODES)
    response_time = round(rng.uniform(0.4, 980.0), 2)
    # 70% of requests have an authenticated user; 30% are anonymous.
    user_id = f"user_{rng.randint(1, 5000)}" if rng.random() < 0.7 else None

    body = {
        "level": {"INFO": 30, "WARN": 40, "ERROR": 50}[severity],
        "time": timestamp_nanos // 1_000_000,  # Pino's native ms epoch
        "pid": pid,
        "hostname": hostname,
        "msg": msg,
        "req": {
            "id": str(uuid.UUID(int=rng.getrandbits(128))),
            "method": method,
            "url": url,
        },
        "res": {"statusCode": status},
        "responseTime": response_time,
        "userId": user_id,
    }

    return {
        "timestamp": timestamp_nanos,
        "severity": severity,
        "resource": {"service.name": service},
        "body": body,
    }


def main() -> None:
    bench_dir = Path(__file__).resolve().parent.parent
    out_dir = bench_dir / "corpora" / "synthetic"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "pino_5k.ndjson"

    if out_path.exists() and out_path.stat().st_size > 0:
        print(f"  ✓ {out_path.relative_to(bench_dir)} (already present)")
        return

    rng = random.Random(SEED)
    paths = build_paths(rng, n=50)

    # One pid per service (mostly) — Pino apps are typically one
    # process per pod. Hosts are deterministic per service.
    service_state = {
        svc: {
            "pid": rng.randint(1000, 65535),
            "hostname": f"{svc}-{i:02d}.cluster.local",
        }
        for i, svc in enumerate(SERVICES)
    }

    # Sequential timestamps, ~1 ms apart with jitter. Anchor at a
    # plausible epoch so Pino's ms `time` field reads naturally.
    base_ns = 1_700_000_000_000_000_000  # 2023-11-14T22:13:20Z

    written = 0
    with out_path.open("w", encoding="utf-8") as f:
        ts = base_ns
        for _ in range(N_RECORDS):
            # Round-robin services so the corpus is interleaved (matches
            # what an aggregator pipeline produces).
            svc = SERVICES[written % len(SERVICES)]
            state = service_state[svc]
            jitter_ns = rng.randint(-200_000, 1_500_000)  # ~±0.2ms..1.5ms
            ts += 1_000_000 + jitter_ns

            # Rare PID rotation (~0.5% of records) to model process
            # restarts. Keeps the column mostly RLE-friendly.
            if rng.random() < 0.005:
                state["pid"] = rng.randint(1000, 65535)

            record = make_record(
                rng,
                service=svc,
                pid=state["pid"],
                hostname=state["hostname"],
                timestamp_nanos=ts,
                paths=paths,
            )
            f.write(json.dumps(record, separators=(",", ":")))
            f.write("\n")
            written += 1

    size = out_path.stat().st_size
    print(
        f"  ↻ {out_path.relative_to(bench_dir)}: "
        f"{written:,} records, {size / 1024:.1f} KB "
        f"(~{size / written:.1f} B/record raw)"
    )


if __name__ == "__main__":
    sys.exit(main())
