#!/usr/bin/env python3
"""
Generate Drain-templated fixtures from Loghub-2k corpora.

For each corpus at `bench/corpora/loghub-2k/<name>_2k.log`, runs Drain3
with the default config (depth=4, sim_th=0.4, max_children=100) and
emits `bench/corpora/loghub-2k-drain/<name>_drain.txt` where each
line is:

    <template_id>\t<var1>\t<var2>\t...

This is the "Drain+ZSTD baseline" referenced in PLAN.md and Experiment
A: replacing the body string with `(template_id, vars)` removes 80–95%
of body bytes before any compression. The bench harness picks up
these fixtures automatically and adds `drain_zstd-19` / `drain_gzip-6`
codec rows.

Idempotent. Skips fixtures already present.

Usage:
    python3 bench/scripts/generate-drain-fixtures.py
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    from drain3 import TemplateMiner
    from drain3.template_miner_config import TemplateMinerConfig
except ImportError:  # pragma: no cover
    sys.stderr.write("drain3 not installed. Run: pip install drain3\n")
    sys.exit(1)


def make_miner() -> TemplateMiner:
    cfg = TemplateMinerConfig()
    # Drain default config (matches PLAN.md M2 defaults).
    cfg.drain_depth = 4
    cfg.drain_sim_th = 0.4
    cfg.drain_max_children = 100
    # Don't override drain_max_clusters; Drain3's default (None →
    # unbounded) is what we want, and setting 0 trips a cachetools
    # bound check on recent versions.
    return TemplateMiner(config=cfg)


def process_corpus(src_path: Path, dst_path: Path) -> tuple[int, int]:
    miner = make_miner()
    lines_in = 0
    lines_out = 0
    with src_path.open("r", encoding="utf-8", errors="replace") as fin, dst_path.open(
        "w", encoding="utf-8"
    ) as fout:
        for line in fin:
            line = line.rstrip("\n")
            if not line:
                continue
            lines_in += 1
            result = miner.add_log_message(line)
            template_id = result["cluster_id"]
            template = result["template_mined"]
            # Extract variables: re-tokenize the original line and keep
            # tokens at positions where the template has `<*>`.
            template_tokens = template.split()
            line_tokens = line.split()
            variables: list[str] = []
            if len(template_tokens) == len(line_tokens):
                for tt, lt in zip(template_tokens, line_tokens):
                    if tt == "<*>":
                        variables.append(lt)
            else:
                # Length mismatch (rare) — emit empty var list; the
                # body-decoder side falls back to free-text on
                # template-id 0.
                pass
            fout.write(f"{template_id}\t" + "\t".join(variables) + "\n")
            lines_out += 1
    cluster_count = len(miner.drain.clusters)
    return lines_out, cluster_count


def main() -> None:
    bench_dir = Path(__file__).resolve().parent.parent
    src_dir = bench_dir / "corpora" / "loghub-2k"
    dst_dir = bench_dir / "corpora" / "loghub-2k-drain"
    dst_dir.mkdir(parents=True, exist_ok=True)

    if not src_dir.exists():
        sys.stderr.write(
            f"Source corpora not found at {src_dir}. "
            f"Run scripts/download-loghub.sh first.\n"
        )
        sys.exit(1)

    print(f"  destination: {dst_dir}")
    for src_path in sorted(src_dir.glob("*_2k.log")):
        name = src_path.stem.replace("_2k", "")  # "Apache_2k" → "Apache"
        dst_path = dst_dir / f"{name}_drain.txt"
        if dst_path.exists() and dst_path.stat().st_size > 0:
            print(f"  ✓ {name} (already present)")
            continue
        n_lines, n_templates = process_corpus(src_path, dst_path)
        print(f"  ↻ {name}: {n_lines:,} lines → {n_templates} templates")


if __name__ == "__main__":
    main()
