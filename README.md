# Baseline (`dhk`)

**One report on how the team is delivering, from the tools you already
use** — team-level only, one source is enough to start, and the data never
leaves your machine.

![build](https://img.shields.io/badge/build-passing-brightgreen?style=flat-square)
![tests](https://img.shields.io/badge/tests-107-a78bfa?style=flat-square)
![local-first](https://img.shields.io/badge/local--first-yes-a78bfa?style=flat-square)
![licence](https://img.shields.io/badge/licence-UNLICENSED-slategray?style=flat-square)

_Product name: **Baseline** (npm: `eng-baseline`) · CLI binary: `dhk` · the
2025 DORA report's finding is the framing: AI is a mirror — this is the tool
that shows a team its real baseline._

```bash
pnpm install && pnpm dhk demo    # a full dashboard before any credential
pnpm dhk connect github          # paste one token → your own report (~2 min)
```

No Docker, no blueprint wizard, no account, no SSO, no data-scope step, no seat
pricing. The first run opens on a fully-populated sample org so the value is
visible before you connect anything; one GitHub token later you're looking at
your own team.

## See it before you connect anything

`pnpm dhk demo` runs fully offline against the committed sample org ("Nimbus
Labs", 3 fictional teams) — no config, no network call. Real output, captured
by actually running this command on 2026-07-03, unedited (the fixture's own
`generated` timestamp below is fixed at its seeded `asOf` date, 2026-06-29, so
every run prints the same deterministic figures — that's the point). Truncated
here; the full run continues through Impact, then renders the reliability
digest — incidents, errors, SLOs — from the same fixtures:

```
# Delivery Health — Orion

_Period: last 14 days · generated 2026-06-29 · mode: offline_ · `team-level only · your data stays on your machine`

**TL;DR:** 14 tickets / 51 pts · 22 PRs merged · DORA: deploy elite · 10 support requests.

## Speed

| Metric | Value | DORA class |
| --- | --- | --- |
| Deployment frequency | 1.5/day | Elite |
| Lead time for changes | 15.5h | Elite |

21 deploys over 14 days.

- PR cycle time (open → merge): **14.2h** avg
- Time to first review: **3.5h** avg (the feedback loop)
- PRs merged: 22

## Effectiveness

- Avg PR size: **224 lines** (batch-size health — smaller flows faster)
- Where the work landed: payments (14), checkout (8)
- Ticket lead time (in-progress → done): avg 2.1d, median 2.6d, p90 3.6d

> Effectiveness is fully measured with a DevEx pulse survey (DXI) — not yet connected.
> The figures above are system-side proxies.

## Quality

| Metric | Value | DORA class |
| --- | --- | --- |
| Change failure rate (revert-based proxy) | 0% | Elite |
| Rework rate (fix/revert deploys) | 14.3% | — |

0 reverts, 3 fix/revert deploys of 21 total.

_CFR shown as a revert-based proxy — connect PagerDuty for the incident-linked figure._
```

## The guarantees (product-enforced, not policy)

- **Team-level only.** No per-person metric exists in the data model — a
  leaderboard cannot be built from this tool. On-call load is per service and
  out-of-hours share, never per responder.
- **Local-first.** All computation happens on your machine. Offline mode makes
  zero network calls; live mode calls only the APIs you connected. No telemetry.
- **No single-metric optimisation.** Every view is a balanced Core-4 set
  (SPACE guardrail); a badge on every output says so.
- **Honest numbers.** CFR is labelled with its basis (incident-linked vs
  revert-proxy); Effectiveness proxies carry a "survey not connected" note; the
  verdict bands are deterministic code, never an LLM.

## What you get

**`dhk report` — the delivery report (DX Core 4):**

| Dimension | Metrics |
| --- | --- |
| **Speed** | deployment frequency · lead time for changes (DORA 2024 classes) · PR cycle time · time-to-first-review |
| **Effectiveness** | PR/batch size · ticket lead time percentiles — labelled system-side proxies (full measure = DevEx pulse survey, optional later) |
| **Quality** | change failure rate (incident-linked when PagerDuty is connected, labelled proxy otherwise) · rework rate (DORA 2024) · failed-deployment recovery time (median + p90) |
| **Impact** | feature-vs-maintenance split · tickets/story points · support drag (unplanned load) |

**`dhk digest` — the reliability digest:**

| Section | Metrics |
| --- | --- |
| **Incidents** (PagerDuty) | count · urgency/severity mix · time-to-detect · recovery time (create→resolve, median/p90) · on-call load by service + out-of-hours share |
| **Errors** (Sentry) | unresolved issues · new this period · by project/level |
| **SLOs** (Prometheus) | per-service availability + p95 latency vs targets · attainment roll-up |

Plus: `dhk scorecard` (many teams ranked in one view), `dhk sprint-health`
(one-sprint verdict: Hero / Laser-Focus / Solid / Chaos), `dhk sprint-trend`
(a run of sprints: hero/chaos/laser-focus callouts, full six-bucket sprint
model with churn index), `dhk support-drag`, `dhk risky-ticket`.

Output formats: **Markdown** (default), **Slack Block Kit** (`--format slack`),
**Google Sheets rows** (`--format sheets`, `--push` to append to a Sheet).

## The 5-minute path

1. `dhk` — no config? The sample-org demo renders: a Core-4 report, a
   reliability digest, and a 3-team scorecard. Never an empty screen.
2. `dhk connect github` — paste a repo-read token; it validates, auto-discovers
   your repos, saves config (`~/.config/dhk/config.json`, 0600), and **runs
   your first real report right there**.
3. A setup checklist shows what each further connection unlocks:
   `GitHub ✓ · Jira ○ · PagerDuty ○ · Sentry ○ · Prometheus ○` — one source is
   enough; each one enriches.

Zero-config defaults, correct-after not configure-before: repos = all
discoverable; deploys = merges to your default branch (orgs with a real deploy
log configure `bigquery-dora` instead); incident = PagerDuty triggered.

## Adapts to your stack (the adapter principle)

The metric maths is the standard — DORA 2024, DX Core 4, SPACE — and never
varies by org. Everything org-specific is config with sensible presets:

- **Deploy signal:** merges-to-main (default, zero-config) · BigQuery deploy
  log (your table/query, your schema) · fix/revert flags from PR titles.
- **Prometheus metric shape:** `micrometer` preset (Spring) ·
  `prometheus-http` preset (client_golang) · or name your own series + labels.
- **Jira taxonomy:** work-categorisation types/labels are configurable;
  sprint-scope fields are optional and derived when present.
- **Hosts:** self-hosted Sentry, regional PagerDuty, any PromQL endpoint.

## Offline by default, live when connected

Every compute function is pure; fixtures and live fetchers feed the same
assembly path. `pnpm test` (107 tests) exercises all the maths offline against
hand-checked fixtures — no network, no credentials, mocked fetch for every live
path. The committed `fixtures/sample-org/` (fictional "Nimbus Labs", 3 teams ×
7 sources) is generated deterministically by `scripts/generate-sample-org.mjs`.

| Source | Live status | Needs |
| --- | --- | --- |
| GitHub | wired (`connect github`) | token with repo read |
| PagerDuty | wired (`connect pagerduty`) | read-only API key |
| Sentry | wired (`connect sentry`) | org + auth token |
| Prometheus | wired (`connect prometheus` + per-service SLO config) | PromQL URL |
| BigQuery deploys | wired (config: table or custom query) | GCP project + token |
| Jira | compute + sprint model ready; REST fetcher documented, not bundled | `connect jira` stores creds |
| Slack post / Sheets push | wired (optional peer dep / REST) | bot token / OAuth token |

## Development

```bash
pnpm typecheck && pnpm lint && pnpm test   # the gates CI runs
pnpm build && pnpm size && pnpm e2e        # built-CLI smoke + size ratchet
pnpm review                                # standing reviewer (local Ollama)
```

Built on the `ai-starter` standard: sequential CI gates (typecheck → lint →
test → build) plus a separate **e2e job** driving the built CLI, a **coverage
ratchet enforced in CI** (thresholds recorded in `vitest.config.ts`, floor only
rises), a **size ratchet**, a `pre-push` hook that mirrors CI exactly, a
committed secret-scan test, and the standing reviewer
(`scripts/review.mjs` + `docs/review-rubric.md`).

## Status & roadmap

- ✅ v1: demo-first onboarding, GitHub → Core-4 report, reliability digest,
  scorecard, sprint model, Markdown/Slack/Sheets output.
- ◻ Jira live fetcher bundled into `--live`.
- ◻ DevEx pulse survey (completes Core 4's Effectiveness/DXI).
- ◻ "AI-readiness" view (2025 DORA capabilities: version-control maturity,
  small batches, platform quality).
- ◻ Benchmarks vs DORA tiers · period/trend comparison · export/API for
  internal developer portals.

## Part of the suite

One engine, many products — eight local-first developer tools, one build
standard, one safety philosophy.

- **[moss](../moss)** — local-first AI CLI: routes prompts across model
  providers, runs safety-gated skills, all on your machine.
- **[relay](../relay)** — calm, confident Smartling translation review, right
  in your browser; only ever does what you could do by hand.
- **[quarry](../quarry)** — local-first code-RAG: ask any codebase a question,
  answered and cited from the code itself, no cloud, no API key.
- **[marshal](../marshal)** — code-grounded ticket intelligence built on
  Quarry: routes and rewrites raw tickets into ready-to-work specs.
- **delivery-health-kit (Baseline, `dhk`)** — engineering-health insight your
  team installs in five minutes; DORA and delivery metrics, data never leaves
  your machine.
- **[ai-starter](../ai-starter)** — three opinionated starter templates so
  every new project begins with the right shape.
- **[document-migration-pipeline](../document-migration-pipeline)** —
  local-first pipeline that turns scattered non-code files into inspectable,
  reviewed Markdown.
- **[sweep](../sweep)** — a macOS CLI that plans (never auto-executes) the
  cleanup of your account traces across sites you're leaving behind.

## License

Unlicensed (all rights reserved) while private — licensing is decided at
go-public.
