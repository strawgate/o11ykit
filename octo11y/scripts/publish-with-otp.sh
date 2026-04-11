#!/usr/bin/env bash
set -euo pipefail

publish_workspace() {
  local workspace="$1"
  local package_name="$2"
  local otp=""

  echo
  echo "Publishing ${package_name} (${workspace})"
  read -r -p "Enter current npm OTP: " otp

  npm publish --workspace="${workspace}" --access public --otp="${otp}"
}

echo "OTP publish helper"
echo "This will publish core, format, then chart in order."

publish_workspace "packages/core" "@octo11y/core"
publish_workspace "packages/format" "@benchkit/format"
publish_workspace "packages/chart" "@benchkit/chart"

echo
echo "All publish commands completed."