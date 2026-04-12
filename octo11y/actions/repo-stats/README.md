# `actions/repo-stats`

Collect GitHub repository statistics and write benchkit-format OTLP JSON — ready
for [`actions/stash`](../stash/README.md).

Instead of hand-rolling `gh api` calls and JSON construction in your workflow,
drop in one step:

```yaml
- uses: strawgate/octo11y/actions/repo-stats@main-dist
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `github-token` | yes | `${{ github.token }}` | GitHub token with repo/issues/PR/actions read access |
| `repository` | no | `${{ github.repository }}` | `owner/repo` to query |
| `scenario` | no | repo name | Benchkit scenario name for the metrics |
| `metrics` | no | `all` | Comma-separated list of metrics to collect (see below) |
| `output-file` | no | `repo-stats.json` | Path to write the OTLP JSON file |
| `resource-attributes` | no | `""` | Additional OTLP resource attributes as JSON object or key=value lines |
| `workflow-run-count` | no | `30` | Recent runs to sample for `workflow-success-pct` |

## Outputs

| Output | Description |
|---|---|
| `results-file` | Path to the generated OTLP JSON file |

## Available metrics

### Community & repo (default token works)

| Metric | Unit | Direction | Source |
|---|---|---|---|
| `stars` | count | bigger_is_better | Stargazers |
| `forks` | count | bigger_is_better | Forks |
| `open-issues` | count | smaller_is_better | Open issues (includes PRs in GitHub's count) |
| `open-prs` | count | smaller_is_better | Open pull requests |
| `contributors` | count | bigger_is_better | Unique contributors |
| `releases` | count | bigger_is_better | Published releases |
| `repo-size-kb` | KB | smaller_is_better | Repository disk size |
| `watchers` | count | bigger_is_better | Subscribers/watchers |
| `network-count` | count | bigger_is_better | Fork network size |
| `workflow-success-pct` | % | bigger_is_better | Percent of recent CI runs that succeeded |

### Activity statistics (default token works)

| Metric | Unit | Direction | Source |
|---|---|---|---|
| `weekly-commits` | count | bigger_is_better | Commits in the most recent week |
| `weekly-additions` | lines | bigger_is_better | Lines added in the most recent week |
| `weekly-deletions` | lines | smaller_is_better | Lines deleted in the most recent week |

### Velocity (default token works)

| Metric | Unit | Direction | Source |
|---|---|---|---|
| `avg-issue-close-days` | days | smaller_is_better | Mean close time of recent 100 issues |
| `median-issue-close-days` | days | smaller_is_better | Median close time of recent 100 issues |
| `avg-pr-merge-hours` | hours | smaller_is_better | Mean merge time of recent 100 PRs |
| `median-pr-merge-hours` | hours | smaller_is_better | Median merge time of recent 100 PRs |

### Language breakdown (default token works)

| Metric | Unit | Direction | Source |
|---|---|---|---|
| `languages` | bytes | bigger_is_better | Emits one `lang_bytes_{name}` metric per language |

### Security (needs `security_events` permission)

Gracefully skipped if the token lacks access.

| Metric | Unit | Direction | Source |
|---|---|---|---|
| `dependabot-alerts` | count | smaller_is_better | Open Dependabot alerts |
| `code-scanning-alerts` | count | smaller_is_better | Open code scanning alerts |

### Traffic (needs `administration: read` permission)

These metrics require a token with admin read access. If the token
lacks permission the action logs a warning and skips them gracefully.

| Metric | Unit | Direction | Source |
|---|---|---|---|
| `page-views` | count | bigger_is_better | Total page views (last 14 days) |
| `unique-visitors` | count | bigger_is_better | Unique visitors (last 14 days) |
| `clones` | count | bigger_is_better | Total git clones (last 14 days) |
| `unique-cloners` | count | bigger_is_better | Unique cloners (last 14 days) |

## Examples

### Track all stats daily

```yaml
name: Repo Stats
on:
  schedule:
    - cron: "0 6 * * *"
  workflow_dispatch:
permissions:
  contents: write
  actions: read
  issues: read
  pull-requests: read
jobs:
  stats:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: strawgate/octo11y/actions/repo-stats@main-dist
        id: stats
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
      - uses: strawgate/octo11y/actions/stash@main-dist
        with:
          results: ${{ steps.stats.outputs.results-file }}
          format: otlp
      - uses: strawgate/octo11y/actions/aggregate@main-dist
```

### Track only community metrics

```yaml
- uses: strawgate/octo11y/actions/repo-stats@main-dist
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    resource-attributes: |
      team=platform
      env=prod
    metrics: stars, forks, contributors, watchers
```

### Track traffic (needs admin token)

```yaml
permissions:
  contents: write
  # administration: read — required for traffic metrics
jobs:
  stats:
    runs-on: ubuntu-latest
    steps:
      - uses: strawgate/octo11y/actions/repo-stats@main-dist
        with:
          github-token: ${{ secrets.REPO_STATS_TOKEN }}
          metrics: page-views, unique-visitors, clones, unique-cloners
```

### Track development velocity

```yaml
- uses: strawgate/octo11y/actions/repo-stats@main-dist
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    metrics: weekly-commits, weekly-additions, weekly-deletions
```

### Track issue and PR velocity

```yaml
- uses: strawgate/octo11y/actions/repo-stats@main-dist
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    metrics: avg-issue-close-days, median-pr-merge-hours
```

### Track language breakdown

```yaml
- uses: strawgate/octo11y/actions/repo-stats@main-dist
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    metrics: languages
```

### Track security posture

```yaml
- uses: strawgate/octo11y/actions/repo-stats@main-dist
  with:
    github-token: ${{ secrets.SECURITY_TOKEN }}
    metrics: dependabot-alerts, code-scanning-alerts
```

### Track another repository

```yaml
- uses: strawgate/octo11y/actions/repo-stats@main-dist
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    repository: kubernetes/kubernetes
    scenario: k8s
```
