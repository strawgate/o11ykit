#!/usr/bin/env bash
# Fetch Loghub-2k log samples for the o11ylogsdb bench harness.
#
# Usage:
#   bash bench/scripts/download-loghub.sh
#
# Idempotent: skips files already present. ~1 MB total committed
# samples; full Loghub-2.0 corpora are gitignored separately under
# bench/corpora/loghub-full/.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${SCRIPT_DIR}/../corpora/loghub-2k"
mkdir -p "${DEST_DIR}"

# Loghub-2k raw log files. URLs are stable on the logpai/loghub repo
# (master branch). If a corpus is renamed upstream, update this list.
declare -a CORPORA=(
  "Apache/Apache_2k.log"
  "BGL/BGL_2k.log"
  "HDFS/HDFS_2k.log"
  "Linux/Linux_2k.log"
  "OpenSSH/OpenSSH_2k.log"
  "OpenStack/OpenStack_2k.log"
)

BASE_URL="https://raw.githubusercontent.com/logpai/loghub/master"

for path in "${CORPORA[@]}"; do
  filename="$(basename "${path}")"
  out="${DEST_DIR}/${filename}"
  if [[ -f "${out}" && -s "${out}" ]]; then
    echo "  ✓ ${filename} (already present)"
    continue
  fi
  url="${BASE_URL}/${path}"
  echo "  ↓ ${filename}"
  curl -fsSL "${url}" -o "${out}"
done

echo
echo "  destination: ${DEST_DIR}"
echo "  files:"
ls -lh "${DEST_DIR}" | awk 'NR>1 {print "    " $9 " (" $5 ")"}'
