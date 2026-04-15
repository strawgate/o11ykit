#!/usr/bin/env bash
# Fetch and decompress testdata from the o11ykit-testdata repo.
#
# Usage:
#   ./bench/fetch-testdata.sh          # clone + decompress all
#   ./bench/fetch-testdata.sh --clean   # remove decompressed files
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/data"
TESTDATA_REPO="${TESTDATA_REPO:-https://github.com/strawgate/o11ykit-testdata.git}"
TESTDATA_DIR="$DATA_DIR/.testdata-repo"

if [[ "${1:-}" == "--clean" ]]; then
  echo "Removing decompressed files…"
  rm -f "$DATA_DIR"/*.jsonl
  echo "Done."
  exit 0
fi

# Clone or update the testdata repo (shallow for speed).
if [[ -d "$TESTDATA_DIR/.git" ]]; then
  echo "Updating testdata repo…"
  git -C "$TESTDATA_DIR" pull --ff-only
else
  echo "Cloning testdata repo…"
  git clone --depth 1 "$TESTDATA_REPO" "$TESTDATA_DIR"
fi

# Decompress any .zst files that don't have a decompressed counterpart.
shopt -s nullglob
for zst in "$TESTDATA_DIR"/o11ytsdb/*.zst; do
  base="$(basename "$zst" .zst)"
  dest="$DATA_DIR/$base"
  if [[ -f "$dest" ]]; then
    echo "  skip $base (already exists)"
  else
    echo "  decompress $base…"
    zstd -d "$zst" -o "$dest"
  fi
done

echo "Done. Testdata in $DATA_DIR/"
