# Delivery Health Kit

One CLI that pulls delivery signals — **GitHub, Jira, Slack, and DORA** — and
produces a single engineering-manager report: DORA + sprint + support metrics,
rendered to **Markdown** or **Slack Block Kit**.

It consolidates three previously-separate eng-intelligence tools (a metrics
pipeline, a sprint-report generator, and a Slack support-intel scanner) into one
coherent kit, and it **runs fully offline** against committed synthetic fixtures —
no credentials, no company data, no network.

```bash
pnpm install
pnpm report          # offline demo → Markdown on stdout
```

## What it does

| Signal | Source | Metrics |
| --- | --- | --- |
| **DORA** | deploy events (BigQuery/Drone live) | deployment frequency, lead time, change-failure rate, + Elite/High/Medium/Low class |
| **Sprint / flow** | Jira | tickets closed/created, story points, lead time (avg/median/p90), work distribution (product/bugs/tech-debt/exploration) |
| **PR flow** | GitHub | PRs merged, cycle time, time-to-first-review, PR size, by-repo |
| **Support** | Slack support channel | requests, median first-response, resolution rate, unanswered, late (>4h), requester mix, top themes |

Every source is a **pure compute function**; one assembler stitches them into a
single report model; renderers emit Markdown or Slack. Offline and live use the
exact same assembly path — only the inputs differ.

## Offline demo

`pnpm report` reads `fixtures/*.json` (synthetic, committed), anchors its date
window to the fixtures' `asOf`, and prints a report. Output is deterministic.

```
# Delivery Health — Team Atlas

_Period: last 14 days · generated 2026-06-29 · mode: offline_

**TL;DR:** 8 tickets / 29 pts · 8 PRs merged · DORA: deploy elite · 12 support requests.

## DORA
| Metric | Value | Class |
| --- | --- | --- |
| Deployment frequency | 1/day | Elite |
| Lead time for changes | 2.7h | Elite |
| Change failure rate | 14.3% | Elite |
...
## Support (Slack)
- Requests: 12
- Median first response: 41.5 min (target < 60 min) [on target]
- Resolution rate: 75% (target ≥ 80%) [below target]
- Unanswered: 2 · Late (>4h): 2
```

### CLI

```bash
dhk report                          # offline markdown → stdout (default)
dhk report --out output/report.md   # write to a file
dhk report --format slack           # Slack Block Kit JSON → stdout
dhk report --fixtures ./my-data     # point at a different fixtures dir
dhk report --live                   # live mode (needs creds, see below)
```

(During development use `pnpm dhk report …`; after `pnpm build` the `dhk` bin is
`dist/index.js`.)

## What needs live credentials

The offline demo needs **nothing**. Live mode (`--live`) reads config from the
environment (copy `.env.example`). What is wired today vs. what is stubbed:

| Source | Live status | Needs |
| --- | --- | --- |
| **GitHub** | Fetcher wired end-to-end (`fetchGitHubPRs`) and called by `--live` | `GITHUB_TOKEN`, `GITHUB_REPOS`, `TEAM_MEMBERS` |
| **Jira** | Compute is live-ready; the REST fetcher is documented but not bundled into `--live` yet | `JIRA_*` |
| **DORA** | Compute runs on normalized deploy events; the live source is BigQuery/Drone (no `@google-cloud/bigquery` dependency is bundled — add it for live) | `GCP_PROJECT_ID`, `BIGQUERY_DATASET` |
| **Slack** | `renderSlackBlocks` is live; `postSlackReport` dynamically imports `@slack/web-api` (optional, not installed) | `SLACK_BOT_TOKEN`, channel id, `pnpm add @slack/web-api` |

This split is deliberate: all the **maths and report assembly are exercised
offline** by tests; the only untested-here surface is the network I/O.

## How it was built (consolidation)

Source material lived under `~/Dev/`. Reused vs. rewritten:

- **Reused (lifted, adapted to the shared `ILogger` / pure-compute shape):**
  the `simple-logger` and `fetch-with-retry` primitives; the GitHub PR
  aggregation maths; the Jira work-categorization rules and lead-time
  percentiles; the DORA class thresholds; the Slack Block Kit builders — all from
  `consolidation/_extracted_capabilities/`.
- **Rewritten:** the Slack support-intel metrics (ported from the Python
  `slack-support-intel.py` to TypeScript, same team-level metrics and targets);
  the sprint throughput idea from `sprint_report_generator.py`; and the entire
  consolidation layer (assembler, renderers, CLI, fixtures) — new.
- **Not ported:** the large Python `metrics` pipeline (kept as reference; its
  responsibilities are covered by the leaner source modules here).

## Development

```bash
pnpm typecheck   # tsc --noEmit
pnpm lint        # biome
pnpm test        # vitest (offline; covers every compute fn + report assembly)
pnpm build       # tsc → dist/
```

Scaffolded on the `ai-starter` Node standard: sequential CI gates
(typecheck → lint → test → build), a `pre-push` hook mirroring CI, a committed
secret-scan test, Biome, and Vitest. `pnpm install` wires the git hooks path
automatically.

## License

MIT.
