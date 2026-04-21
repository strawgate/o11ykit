# Releasing and Trusted Publishing

This repo uses npm trusted publishing (OIDC) for package releases.

Primary workflows:

- Lockstep package release (all published packages): `.github/workflows/release.yml`
- Action dist branch publishing (`main-dist`, `pr/{number}-dist`): `.github/workflows/actions-dist.yml`

## One-Time Bootstrap for New Package Names

For a brand new package name/scope on npm (all packages now publish from
`release.yml`):

1. Publish the first version once (manual bootstrap may be required).
2. Bind trusted publishing for that package:

```bash
npm trust github <package-name> --repo strawgate/o11ykit --file release.yml --yes
```

Examples:

```bash
npm trust github @otlpkit/otlpjson --repo strawgate/o11ykit --file release.yml --yes
npm trust github @otlpkit/query --repo strawgate/o11ykit --file release.yml --yes
npm trust github @otlpkit/views --repo strawgate/o11ykit --file release.yml --yes
npm trust github @otlpkit/adapters --repo strawgate/o11ykit --file release.yml --yes
npm trust github @o11ykit/metricsdb --repo strawgate/o11ykit --file release.yml --yes
npm trust github o11ytsdb --repo strawgate/o11ykit --file release.yml --yes
npm trust github @octo11y/core --repo strawgate/o11ykit --file release.yml --yes
npm trust github @benchkit/format --repo strawgate/o11ykit --file release.yml --yes
npm trust github @benchkit/chart --repo strawgate/o11ykit --file release.yml --yes
npm trust github @benchkit/adapters --repo strawgate/o11ykit --file release.yml --yes
```

## Avoiding One-OTP-Per-Command

The npm CLI supports bulk trust setup. Per npm's docs:

- Authenticate once on the first `npm trust` call.
- In the browser prompt, enable "skip two-factor authentication for the next 5 minutes".
- Run remaining `npm trust` commands in that window.
- Add a short delay between calls to avoid rate limiting.

Recommended bulk script:

```bash
#!/usr/bin/env bash
set -euo pipefail

pkgs=(
  @otlpkit/otlpjson
  @otlpkit/query
  @otlpkit/views
  @otlpkit/adapters
  @o11ykit/metricsdb
  o11ytsdb
  @octo11y/core
  @benchkit/format
  @benchkit/chart
  @benchkit/adapters
)

for p in "${pkgs[@]}"; do
  echo "Configuring trusted publishing for $p"
  npm trust github "$p" --repo strawgate/o11ykit --file release.yml --yes
  sleep 2
done
```

## Notes and Common Errors

- `E409 Conflict`: trust config already exists for that package.
- `E429 Too Many Requests`: npm rate limit; back off and retry.
- `EOTP`: auth window expired; re-auth and continue.
- npm currently allows one trust configuration per package at a time.

## Prereqs

- npm CLI `11.10.0+`
- Package already exists on npm
- You have write permissions to package
- Account-level 2FA enabled

## References

- npm CLI `npm trust` docs: https://docs.npmjs.com/cli/v11/commands/npm-trust/
- Trusted publishing overview: https://docs.npmjs.com/trusted-publishers/
- npm 2FA / security key CLI auth: https://docs.npmjs.com/accessing-npm-using-2fa/
