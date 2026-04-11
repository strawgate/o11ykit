# Agent Routing

Read files in this order before making code changes:
1. `README.md`
2. `DEVELOPING.md`
3. `CODE_STYLE.md`
4. `docs/README.md`

Then read files for the area you will edit:
- Core package: `packages/core/src/**`
- Format package: `packages/format/README.md` and `packages/format/src/**`
- Chart package: `packages/chart/README.md` and `packages/chart/src/**`
- Stash action: `actions/stash/README.md`, `actions/stash/src/main.ts`, and `actions/stash/action.yml`
- Aggregate action: `actions/aggregate/README.md`, `actions/aggregate/src/main.ts`, and `actions/aggregate/action.yml`
- Compare action: `actions/compare/README.md`, `actions/compare/src/main.ts`, and `actions/compare/action.yml`
- Monitor action: `actions/monitor/README.md`, `actions/monitor/src/**`, and `actions/monitor/action.yml`
- Emit metric action: `actions/emit-metric/README.md`, `actions/emit-metric/src/**`, and `actions/emit-metric/action.yml`
- Repo stats action: `actions/repo-stats/README.md`, `actions/repo-stats/src/**`, and `actions/repo-stats/action.yml`
- Data contract: `schema/*.json` and `schema/README.md`
- CI behavior: `.github/workflows/*.yml`

## Non-negotiable rules

- Keep this file lean: route to docs, do not duplicate long guidance.
- Action `dist/` bundles are NOT committed to the repo. CI builds and pushes them to the `main-dist` branch automatically. Do not run ncc or commit dist/ files.
- Add or update tests for behavior changes in packages or actions.
- If changing data structure, update schema files and docs in the same PR.
- Keep public APIs backward compatible unless explicitly planned otherwise.

## Quick commands

- Install deps: `npm ci`
- Build: `npm run build`
- Test: `npm run test`
- Lint (ESLint + type checks): `npm run lint`

## Onboarding and references

- Docs hub: `docs/README.md`
- Roadmap and shipped/open status: `docs/vision-and-roadmap.md`
- Current internal handoff: `docs/internal/agent-handoff.md` (operational only)
- `CLAUDE.md` is a symlink to this file.
- `.github/copilot-instructions.md` points to this file.
