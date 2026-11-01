# AGENTS.md — Delivery Health Kit (dhk)

The canonical agent instructions for this repo (CLAUDE.md defers here).

## What this is

The consolidated **Engineering Delivery & Reliability product**: one CLI —
`dhk report` (delivery, as DX Core 4) + `dhk digest` (reliability) — local-first,
team-level only, five-minute onboarding.

## Stack

TypeScript (ESM, NodeNext) · pnpm · Biome · Vitest · **zero runtime
dependencies** (live paths use native fetch; optional integrations are dynamic
imports or plain REST). Node ≥22. Licensed under MIT; `private: true` keeps
the package from being published to npm.

## Architecture

```
src/
  types.ts                 # THE shared record model ("L2 contract") — everything conforms
  config.ts                # user config (~/.config/dhk, 0600) + setup checklist
  sources/                 # one file per source: pure compute + separate live fetch
    github.ts jira.ts dora.ts support.ts          # delivery half
    pagerduty.ts sentry.ts prometheus-slo.ts      # reliability half (harvested)
    bigquery-dora.ts                              # live deploy-log source (optional)
    fixtures.ts                                   # offline loaders incl. sample-org
  reads/     sprint-health.ts support-drag.ts risky-ticket.ts   # verdict engines
  report/    assemble.ts markdown.ts slack.ts sheets.ts scorecard.ts
  cli.ts index.ts          # commands: demo report digest scorecard connect sprint-* …
fixtures/                  # committed synthetic data (Team Atlas + sample-org/)
scripts/                   # generate-sample-org.mjs e2e-smoke.sh check-size.mjs review.mjs
```

## Golden rules (unchanged by the 2026-07 build — extended)

1. **Offline first.** `compute*` never touches the network; only `fetch*` do,
   and tests mock fetch (injectable `options.fetch`) — no real API call in any
   test, ever.
2. **Determinism.** Injectable `now`; offline anchors to fixtures' `asOf`.
   No `Date.now()` inside `compute*`. `scripts/generate-sample-org.mjs` is
   seeded — regenerating must not churn the diff.
3. **Team-level only, product-enforced.** No per-person metric may enter
   `types.ts`. On-call load is by service / out-of-hours only. Reject any
   change that adds individual ranking.
4. **The compute layer is universal; the ingestion layer adapts.** Metric maths
   (DORA 2024 / Core 4 / SPACE) never varies by org. Org-specific assumptions
   (metric names, label selectors, deploy tables, hosts, work hours) go in
   config with named presets — never hard-coded. No company residue.
5. **Honest labels.** CFR carries `cfrBasis` (incident-linked vs revert-proxy);
   Effectiveness proxies carry the survey note; never render an invented score.
6. **No secrets, no company data, no personal absolute paths** in committed files
   (`tests/secret-scan.test.ts` enforces).
7. Logs → **stderr**; report → **stdout**.

## Gates (must stay green — pre-push mirrors CI exactly)

```
pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm size && pnpm e2e
```

- `pnpm test` runs **with coverage**; thresholds in `vitest.config.ts` are a
  ratchet (floor only rises — bump them when you add tests, never lower).
- `pnpm size` budgets the built JS (`scripts/check-size.mjs`).
- `pnpm e2e` smokes the BUILT CLI (`scripts/e2e-smoke.sh`); CI runs it as a
  separate job after the unit gates.
- `pnpm review` = standing reviewer (`scripts/review.mjs`, verbatim from
  ai-starter — kept in biome-ignore to stay in sync; rubric in
  `docs/review-rubric.md`, human-owned, never self-amended).

## Fixture conventions

- `fixtures/*.json` (Team Atlas) carry **hand-checked expectations** — tests
  assert exact numbers against them. If you change a fixture, re-derive the
  expected values by hand and update `tests/*.test.ts` comments.
- `fixtures/sample-org/` is generated — edit the generator, not the JSON.
