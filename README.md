# Baseline

**Team-level delivery and reliability signals for engineering leaders.**

Baseline (`dhk`) brings delivery flow, incidents and support load into local reports that help engineering leaders identify bottlenecks and choose what to investigate. It uses existing engineering data, labels proxies explicitly and reports at team level.

[GitHub Actions workflows](https://github.com/KarlDoyle/delivery-health-kit/actions)
![local-first](https://img.shields.io/badge/local--first-yes-a78bfa?style=flat-square)
![licence](https://img.shields.io/badge/licence-MIT-green?style=flat-square)

_Product name: **Baseline** · CLI: `dhk` · npm publishing is currently disabled._

**Status:** Release-ready, as assessed by the maintainer. The repository remains private, and the package is not published to npm.

## Try the offline demo

Requires Node.js ≥22.13 and pnpm.

```bash
pnpm install
pnpm dhk demo
```

After dependencies are installed, the demo runs without credentials or network access. It shows a delivery report, reliability digest and three-team scorecard using committed, deterministic synthetic data.

![Baseline offline demo for fictional team Orion, showing delivery frequency, lead time, PR flow and the effectiveness proxy note](docs/demo.svg)

_Excerpt from `pnpm dhk demo --quiet`; fictional sample data, with dates anchored to the fixtures._

To try your own GitHub data:

```bash
pnpm dhk connect github
```

## Architecture at a glance

```mermaid
flowchart TD
    A["Offline synthetic fixtures"] --> C["Source adapters and normalisation"]
    B["Connected services: GitHub, PagerDuty, Sentry, Prometheus"] --> C
    C --> D["Pure metric calculations"]
    D --> E["Team-level assembly: delivery, reliability and sprint signals"]
    E --> F["Reports, digests and scorecards"]
    F --> G["Markdown"]
    F --> H["Slack Block Kit"]
    F --> I["Google Sheets rows"]
```

The same calculation path processes synthetic demo fixtures and live data from configured integrations. Calculations run locally; connecting services or pushing output explicitly exchanges data with those services. The diagram shows the core flow, not every optional integration or command.

## What Baseline measures—and what it does not

Baseline summarises recorded delivery activity, incidents, errors and support requests. PR timestamps and incident counts describe activity directly; their interpretation depends on source coverage.

Live delivery reports use PR merges as a deployment proxy: frequency counts merges, and “lead time for changes” measures PR open-to-merge time. These are not verified production deployments or commit-to-production lead times. PR size and ticket flow are proxies for engineering effectiveness; work mix and throughput do not establish business impact.

Baseline does not measure individual productivity, developer experience through a survey, or business outcomes. Its scorecard is a rule-based summary of available signals, not a validated measure of team performance. Use results to guide investigation, with comparable periods and source coverage. See [metric definitions and limits](docs/metrics-and-proxies.md).

**`dhk report` — the delivery report (DX Core 4):**

| Dimension | Metrics |
| --- | --- |
| **Speed** | Deployment frequency · lead time for changes (DORA 2024 classes) · PR cycle time · time-to-first-review |
| **Effectiveness** | PR/batch size · ticket lead-time percentiles, labelled as system-side proxies |
| **Quality** | Change failure rate (live report: revert proxy) · rework rate |
| **Impact** | Feature-vs-maintenance split · tickets/story points · support drag (unplanned load) |

**`dhk digest` — the reliability digest:**

| Section | Metrics |
| --- | --- |
| **Incidents** (PagerDuty) | Count · urgency/severity mix · time-to-acknowledge (labelled time-to-detect in output) · recovery time (create→resolve, median/p90) · on-call load by service and out-of-hours share |
| **Errors** (Sentry) | Unresolved issues · new this period · by project/level |
| **SLOs** (Prometheus) | Per-service availability and p95 latency vs targets · attainment roll-up |

The digest calculations also support incident-linked CFR and failed-deployment recovery when deployment and incident records are supplied together, as in the offline fixtures. The live digest does not currently ingest deployments.

Additional commands include `dhk scorecard`, `dhk sprint-health`, `dhk sprint-trend`, `dhk support-drag` and `dhk risky-ticket`. The sprint views include sprint intelligence, scope/churn signals and a concise report to support review conversations.

Output formats: **Markdown** (default), **Slack Block Kit** (`--format slack`) and **Google Sheets rows** (`--format sheets`, `--push` to append to a Sheet).

## Product principles

- **Team-level only.** No per-person metric exists in the data model. The tool is designed to support team improvement, not individual ranking.
- **Local-first.** Computation happens on your machine. Offline mode makes zero network calls; live mode calls only the APIs you connect. No telemetry.
- **Balanced indicators.** Speed is considered alongside effectiveness, quality and impact; no single metric is intended to stand alone.
- **Honest numbers.** Change-failure figures are labelled by their basis (incident-linked or revert proxy). Effectiveness proxies carry a clear note when a DevEx pulse survey is not connected.
- **Deterministic calculations.** Metric calculations and verdict bands are code, not LLM-generated scores.

## The 5-minute path

1. Run `dhk` with no configuration to explore the sample report, reliability digest and three-team scorecard.
2. Run `dhk connect github`; the CLI validates a repo-read token, discovers repositories, saves local configuration and runs the first report.
3. Add other sources as needed. One source is enough to start; each additional connection enriches the report.

Configuration is stored locally at `~/.config/dhk/config.json` with restrictive file permissions.

## Adapts to your stack

The metric definitions are intended to remain consistent; organisation-specific details are configured through adapters and presets.

- **Deploy signal:** live reports derive deployment signals from merged PRs. Production deployment ingestion is not currently wired into the CLI; the BigQuery adapter exists separately. A merge is not proof of a production release.
- **Prometheus metric shape:** Micrometer and client_golang presets, or custom series and labels.
- **Jira taxonomy:** configurable work-categorisation types and labels; sprint-scope fields are optional.
- **Hosts:** self-hosted Sentry, regional PagerDuty and PromQL-compatible endpoints.

## Integrations

| Source | Current implementation status | Needs |
| --- | --- | --- |
| GitHub | Live integration | Token with repository read access |
| PagerDuty | Live integration | Read-only API key |
| Sentry | Live integration | Organisation and auth token |
| Prometheus | Live integration, with per-service SLO configuration | PromQL URL |
| BigQuery deploys | Future optional deployment-event adapter; not currently integrated | GCP project, OAuth token and configured table/query |
| Jira | Work categorisation and sprint calculations are available; Jira REST ingestion is not implemented in the CLI | Jira credentials (not currently used by a live command) |
| Slack / Google Sheets | Optional output integrations | Bot token / OAuth token |

## Why this project exists

In engineering management, the hard part of metrics is rarely producing another dashboard. It is deciding which signals support useful team conversations, identifying misleading proxies, and making improvements without creating individual performance surveillance. Baseline explores that problem as a small, testable, local-first tool rather than a prescriptive team-ranking system.

**What it demonstrates:** metric definition and interpretation, trade-offs between useful proxies and authoritative data, clean separation of adapters and calculations, and delivery safeguards (reproducible fixtures, coverage thresholds, size checks and built-CLI smoke tests). The project is a portfolio implementation and learning exercise, not a claim that this exact tool was deployed at previous employers.

## Engineering approach

Every compute function is pure; fixtures and live fetchers feed the same assembly path. The offline test suite exercises calculations against hand-checked fixtures, without requiring credentials or network access.

The project includes sequential CI gates (typecheck, lint, test and build), a separate end-to-end job that drives the built CLI, coverage thresholds and a build-size budget, a pre-push hook, a committed secret-scan test and a standing reviewer.

The standing reviewer uses a **human-owned rubric** covering:

- Claims matching the actual implementation.
- Tests exercising real behaviour.
- Security and input handling.
- No committed secrets.
- Adherence to the requested specification.
- Documentation that accurately describes current behaviour and limitations.

The reviewer is advisory. It can recommend ACCEPT or REJECT, but a human owns the rubric and makes the final decision.

Implementation evidence: [architecture](docs/architecture.md), [metric definitions and limits](docs/metrics-and-proxies.md), [scenario results](docs/metric-scenarios.md), and [test strategy](docs/testing.md). The human review gate is described in the [review rubric](docs/review-rubric.md).

## An iterative approach to engineering and AI

Baseline is part of a broader body of work built up through repeated problem-solving.

I have often started by identifying a specific engineering problem and building a small, focused tool or script to address it — including early single-purpose utilities for sprint reporting, delivery insight and engineering workflows. Those experiments were used to test ideas, learn what was useful and shape the next iteration.

The current project brings those lessons together in a more comprehensive, maintainable application. AI-assisted development with Claude, alongside my own starter templates, prompts and engineering harnesses, has helped accelerate implementation, explore alternatives and expand testing.

The engineering direction remains human-led: identifying the problem, choosing the approach, shaping the architecture, reviewing generated work, challenging assumptions and deciding what is ready to keep. AI is used as an engineering multiplier, not as a substitute for ownership or judgement.

This repository is an accumulation of that work and learning, rather than a claim that the current implementation was deployed unchanged in previous companies.

## Testing and quality gates

Tests cover fixture-based calculations, deterministic demo output, mocked API responses and failure handling, report formatting, CLI guards and local configuration. Built-CLI smoke checks exercise help, demo, report, digest, scorecard and Sheets-row output.

CI runs typechecking, lint, tests with enforced coverage thresholds, build and size checks on Node 22 and 24, followed by a separate end-to-end job. These checks do not validate real service credentials, production API behaviour or metric usefulness in a deployed organisation.

Run the complete gate locally:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm size && pnpm e2e
```

The pre-push hook runs through the size check; run `pnpm e2e` separately. See [testing details](docs/testing.md).

## Development

```bash
pnpm typecheck && pnpm lint && pnpm test
pnpm build && pnpm size && pnpm e2e
pnpm review
```

The demo uses committed synthetic data in `fixtures/sample-org/`, generated deterministically by `scripts/generate-sample-org.mjs`.

## Status and roadmap

- ✅ Demo-first onboarding and GitHub → Core-4 report.
- ✅ Reliability digest, scorecard and sprint model.
- ✅ Markdown, Slack and Sheets output paths.
- ◻ Consider an optional BigQuery deployment-event adapter when a real source and validation environment are available.
- ◻ Bundle the Jira live fetcher into `--live`.
- ◻ Add a DevEx pulse survey to complete the Effectiveness/DXI measure.
- ◻ Explore an AI-readiness view based on DORA capability signals.
- ◻ Add period/trend comparison and export/API support for internal developer portals.

## Licence

Licensed under the MIT License. The package remains marked private in npm metadata.
