#!/usr/bin/env bash
set -euo pipefail

# Load .env if present so one-off local publish can use checked shell variables.
if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  source .env
fi

TOKEN="${NPM_TOKEN:-${NPM_API_KEY:-}}"

if [[ -z "${TOKEN}" ]]; then
  echo "No npm publish token found."
  echo "Set NPM_TOKEN or NPM_API_KEY (for example in .env),"
  echo "then run: npm run publish:token"
  exit 1
fi

npm config set //registry.npmjs.org/:_authToken "$TOKEN"

echo "Publishing @octo11y/core"
npm publish --workspace=packages/core --access public

echo "Publishing @benchkit/format"
npm publish --workspace=packages/format --access public

echo "Publishing @benchkit/chart"
npm publish --workspace=packages/chart --access public

echo "All publish commands completed."