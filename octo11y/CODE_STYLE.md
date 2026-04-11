# Code Style Preferences

This file captures subjective review preferences that are not enforced by lint config.

## Naming

- Prefer explicit names over short abbreviations for exported symbols.
- Metric and parser names should reflect domain terms used in benchmark tooling.

## Comments

- Add comments for non-obvious behavior or data-contract decisions.
- Avoid narrating obvious line-by-line operations.

## Error handling

- Return actionable error messages that include the failing file, metric, or operation.
- Prefer one clear error path over layered wrappers when context is already present.

## API design

- Keep exported APIs small and composable.
- Avoid hidden runtime dependencies in library consumers.
- Prefer additive, backward-compatible changes to public package APIs.

## Tests in reviews

- New behavior should include tests in the same workspace.
- Bug fixes should include a test that would fail without the fix.
- Keep test inputs realistic to benchmark data seen in CI.

## PR conventions

- Keep PR scope focused on one logical change.
- Include a short "what changed" and "why" summary in the PR body.
- Mention contract/schema impact explicitly when data files change.
