#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ARTIFACT_DIR="${ROOT_DIR}/.tmp/release-rehearsal"
CONSUMER_DIR="${ARTIFACT_DIR}/consumer"

cleanup() {
  rm -rf "${ARTIFACT_DIR}"
}

mkdir -p "${ARTIFACT_DIR}"
trap cleanup EXIT

cd "${ROOT_DIR}"

CORE_VERSION="$(node -p "require('./packages/core/package.json').version")"
FORMAT_VERSION="$(node -p "require('./packages/format/package.json').version")"
CHART_VERSION="$(node -p "require('./packages/chart/package.json').version")"

echo "Core version:   ${CORE_VERSION}"
echo "Format version: ${FORMAT_VERSION}"
echo "Chart version:  ${CHART_VERSION}"

if [[ "${CORE_VERSION}" != "${FORMAT_VERSION}" || "${FORMAT_VERSION}" != "${CHART_VERSION}" ]]; then
  echo "Version mismatch across publishable packages."
  exit 1
fi

echo "Building publishable packages..."
npm run build --workspace=packages/core
npm run build --workspace=packages/format
npm run build --workspace=packages/chart

echo "Packing publishable packages..."
npm pack --workspace=packages/core --pack-destination "${ARTIFACT_DIR}"
npm pack --workspace=packages/format --pack-destination "${ARTIFACT_DIR}"
npm pack --workspace=packages/chart --pack-destination "${ARTIFACT_DIR}"

mkdir -p "${CONSUMER_DIR}"
cd "${CONSUMER_DIR}"

echo "Creating consumer smoke app..."
npm init -y >/dev/null

echo "Installing packed artifacts in consumer app..."
npm install \
  "${ARTIFACT_DIR}"/octo11y-core-*.tgz \
  "${ARTIFACT_DIR}"/benchkit-format-*.tgz \
  "${ARTIFACT_DIR}"/benchkit-chart-*.tgz \
  preact

echo "Running consumer import smoke checks..."
node -e "const core=require('@octo11y/core'); const format=require('@benchkit/format'); if(!core.parseOtlp) throw new Error('missing parseOtlp'); if(!format.parseBenchmarks) throw new Error('missing parseBenchmarks'); console.log('cjs imports ok');"
node --input-type=module -e "import('@benchkit/chart').then((m)=>{if(!m.Dashboard) throw new Error('missing Dashboard export'); console.log('esm imports ok');});"

cd "${ROOT_DIR}"

echo "Running npm publish dry-runs..."
publish_dry_run_if_unpublished() {
  local package_name="$1"
  local package_version="$2"
  local workspace_path="$3"

  if npm view "${package_name}@${package_version}" version >/dev/null 2>&1; then
    echo "Skipping npm publish --dry-run for ${package_name}@${package_version} (already published)."
    return 0
  fi

  npm publish --workspace="${workspace_path}" --dry-run --access public
}

publish_dry_run_if_unpublished "@octo11y/core" "${CORE_VERSION}" "packages/core"
publish_dry_run_if_unpublished "@benchkit/format" "${FORMAT_VERSION}" "packages/format"
publish_dry_run_if_unpublished "@benchkit/chart" "${CHART_VERSION}" "packages/chart"

echo "Release rehearsal completed successfully."
