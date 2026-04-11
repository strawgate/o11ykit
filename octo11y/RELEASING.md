# Releasing

This document describes how to cut a release for `@octo11y/core`,
`@benchkit/format`, and `@benchkit/chart`.

## Versioning strategy

All publishable packages in the monorepo share a **single version number**.
`@octo11y/core`, `@benchkit/format`, and `@benchkit/chart` are released
together, even if only one package has changed. This keeps the dependency
relationship simple and avoids cross-version compatibility issues.

Versions follow [Semantic Versioning](https://semver.org/):

| Change kind | Bump |
|---|---|
| Breaking API change | major |
| New feature (backwards-compatible) | minor |
| Bug fix / docs / internal improvement | patch |

Pre-release versions (e.g. `0.2.0-beta.1`) are supported. Any tag containing
a hyphen is automatically marked as a pre-release on GitHub.

## Prerequisites

- Push access to the repository
- npm publish rights for both the `@octo11y` and `@benchkit` scopes
- npm trusted publishing configured for this repository/packages
- A protected GitHub environment named `npm` configured for release approvals

## npm authentication requirements

CI publishing uses npm trusted publishing via GitHub OIDC from
`.github/workflows/publish-to-npm.yml` with `environment: npm`.
No long-lived npm token secret is required for the CI publish path.

As of the current npm policy, a plain `npm login` session is often **not**
sufficient for publishing. You need one of these:

- An npm account with two-factor authentication enabled for publishing, then
   publish locally with `npm publish --otp <code>`.
- A granular npm access token with publish rights and bypass-2FA enabled, then
   use that token for local publish.

For local automation, prefer a granular token route because local shell scripts
cannot answer an OTP challenge interactively.

## Local release rehearsal (testing without GitHub)

Before pushing to GitHub, validate the entire release flow locally:

```bash
npm run release:rehearsal
```

This harness performs the core release steps without GitHub:

1. **Version alignment** — verifies all three publishable packages have matching versions
2. **Build** — compiles `@octo11y/core`, `@benchkit/format`, and `@benchkit/chart`
3. **Pack** — creates tarballs (exactly what `npm publish` would bundle)
4. **Consumer smoke test** — creates a temporary app, installs the packed tarballs + preact,
   and validates both CommonJS and ESM imports work
5. **Publish dry-runs** — runs `npm publish --dry-run` for each package
   (skips packages already published on npm to allow re-running after a release)

**Use case**: Catch missing exports, broken deps, or build errors before cutting a tag.
Runs in seconds locally.

The CI equivalent runs automatically on PRs that touch release-related files
(see `.github/workflows/release-rehearsal.yml`).

## How to release

1. **Update versions** in the publishable package manifests:

   ```bash
    npm version <major|minor|patch> \
       --workspace=packages/core \
       --workspace=packages/format \
       --workspace=packages/chart \
       --no-git-tag-version
   ```

    This bumps the `version` field in `packages/core/package.json`,
    `packages/format/package.json`, and `packages/chart/package.json`.

2. **Commit the version bump**:

   ```bash
    git add package-lock.json packages/core/package.json packages/format/package.json packages/chart/package.json
   git commit -m "chore: bump version to $(node -p "require('./packages/format/package.json').version")"
   ```

3. **Create and push the tag**:

   ```bash
   VERSION=$(node -p "require('./packages/format/package.json').version")
   git tag "v$VERSION"
   git push origin main "v$VERSION"
   ```

4. **Watch the workflow**. The `Release` workflow will:
   - Run the shared validation workflow
   - Call `.github/workflows/publish-to-npm.yml` (trusted publishing, environment `npm`)
   - Create a GitHub Release with auto-generated release notes

   If any step fails the packages are **not** published.

## Manual publish fallback

The preferred path is the tag-driven GitHub Actions workflow because it also
creates provenance attestations and the GitHub Release. If you need to recover
from a broken first publish or verify registry auth locally, publish in this
order:

```bash
npm publish --workspace=packages/core --access public
npm publish --workspace=packages/format --access public
npm publish --workspace=packages/chart --access public
```

If your npm account uses publish 2FA, add `--otp <code>` to each command.
Local manual publish does **not** produce the `--provenance` attestations that
the GitHub Actions workflow adds.

## Major version tags

The actions in this repository follow the GitHub Actions convention of
supporting a floating major version tag (e.g. `v1`) that always points to the
latest stable release within that major line. This lets consumers pin to
`strawgate/octo11y/actions/<name>@v1` and receive all patch and minor updates
automatically.

The `update-major-tag` job in the release workflow keeps this tag up to date.
It runs after every stable (non-pre-release) tag push and force-updates the
major tag to the new release commit. Pre-release tags (those containing `-`,
e.g. `v1.2.0-beta.1`) are skipped.

## What the automation does

The [release workflow](.github/workflows/release.yml) triggers on tags
matching `v*`. It runs four jobs in sequence:

1. **build-and-test** — runs the shared validation workflow. The release is
   aborted if validation fails.
2. **publish** — calls [publish-to-npm workflow](.github/workflows/publish-to-npm.yml),
   which builds the packages, verifies tag-version alignment, and publishes
   with `--provenance` using trusted publishing and environment `npm`.
3. **github-release** — generates a changelog from commit messages since the
   previous tag and creates a GitHub Release. Pre-release tags are
   automatically flagged.
4. **update-major-tag** — force-updates the floating major version tag (e.g.
   `v1`) to point to the latest stable release commit. Skipped for pre-release
   tags.

## Troubleshooting

| Problem | Fix |
|---|---|
| Tag version doesn't match `package.json` | Delete the tag, fix the version, re-tag and push. |
| npm publish fails with 403 in CI | Check npm trusted publishing setup for `.github/workflows/publish-to-npm.yml`, verify the job runs in environment `npm`, and confirm package/org permissions on npm. |
| The first tag already exists but nothing was published | After fixing npm auth, either delete and recreate the tag or cut a new patch version. The release workflow only runs on tag pushes. |
| Tests fail during release | Fix the issue on `main`, bump again, and re-tag. |
| Provenance attestation fails | Ensure `id-token: write` permission is set in the workflow and each `package.json` has a `repository` field pointing to the GitHub repo. |
