---
last_reviewed: "2026-07-02"
review_frequency: "monthly"
---

# STATE — delivery-health-kit (dhk)

_Build executed 2026-07-02 from KARL_CONTEXT `Projects/delivery-health-kit/BUILD-PACKET.md`
(all 13 steps of §10). This file is the build record the hub audits._

## Product name — CONFIRMED by Karl (2026-07-02)

**"Baseline" — npm package `eng-baseline`, binary stays `dhk`.**
(Fits the DORA 2025 "AI is a mirror / see your real baseline" framing.)
Domain purchase + wordmark remain go-public steps.

Availability check (2026-07-02):

| Name | npm | GitHub org | .dev domain | Web clash |
| --- | --- | --- | --- | --- |
| baseline / cadence / vitals / pulse / level (bare) | ❌ all taken | — | — | "vitals" clashes with Google web-vitals |
| **eng-baseline** | ✅ free | ✅ free (404) | ✅ engbaseline.dev unregistered (no SOA) | ✅ no clashing dev tool found |
| delivery-vitals | ✅ free | ✅ free | ✅ unregistered | ⚠️ web-vitals adjacency |
| team-vitals | ✅ free | ❌ org taken | — | — |
| dhk / delivery-health-kit | ✅ free | — | — | — |

Karl confirms before any branding is finalised. Domain purchase is a go-public step.

## Core design principles (locked this build)

1. **Compute layer is universal; ingestion layer adapts.** The metric maths (DORA 2024,
   Core 4, SPACE) is the standard and never varies by org. Org-specific assumptions live
   in config with named presets; zero-config defaults use the most universal signal
   (merges-to-main = deploys). Karl's-company residue found during harvest (Micrometer
   metric names, `deployments.history` table, cart-path exclusions, `your-org.pagerduty.com`
   host) was lifted into config presets — per Karl's explicit direction that the current
   implementation reflects one company's infra and the product must learn/adapt to others.
2. **Team-level only, product-enforced.** No per-person metric exists in `types.ts`.
3. **Data constant, AI is the flavour.** All verdicts/bands deterministic in code.
4. **Never an empty screen.** Bare `dhk` with no config runs the sample-org demo.

## Expert-council decisions (metric definitions — locked)

- **Rework rate** = flagged fix/revert deploys ÷ total deploys (DORA 2024). Flag-based
  only in v1 — no file-overlap heuristics (false positives erode trust).
- **Failed-deployment recovery time** (DORA 2024 rename of MTTR) = incident
  create→resolve, **median + p90, never mean-only**.
- **CFR**: incident-linked (deploy followed ≤24h by triggered high-urgency incident on
  its service, union with reverts) when PagerDuty connected; revert proxy otherwise —
  output **always labels which** (`cfrBasis`).
- **Core-4 mapping**: Speed = deploy freq/lead time/PR cycle/TTFR · Effectiveness =
  system proxies with visible "DXI survey not connected" note (never an invented score) ·
  Quality = CFR/rework/recovery/errors/SLO · Impact = feature-vs-maintenance/throughput/
  support drag.
- **Onboarding**: demo-by-default with no prompt; `connect github` ends by auto-running
  the user's first real report (no second command for the reward).
- **CLI split confirmed**: `report` (weekly EM cadence) / `digest` (daily on-call cadence);
  `--since 14d` duration grammar; `--format md|slack|sheets` (markdown alias kept).

## What was built (2026-07-02)

- **Reliability half**: `src/sources/{pagerduty,sentry,prometheus-slo,bigquery-dora}.ts`
  + `dhk digest` + digest renderers (md/slack/sheets) + `assembleDigest`.
- **DORA 2024 upgrade**: rework rate, `cfrBasis` labelling, incident-linked CFR,
  recovery time (median/p90), `deployEventsFromPRs` zero-config deploy signal.
- **Full sprint model**: churn index, added-completion, six-way buckets
  (`deriveSprintInput`), multi-sprint `dhk sprint-trend` (hero/chaos/laser-focus).
- **Sheets output**: pure row renderers + REST append (`--format sheets`, `--push`).
- **Onboarding**: `dhk connect <source>` (hidden token prompt, whoami validation,
  repo auto-discovery, 0600 config, auto-first-report), progressive checklist,
  never-empty first run (`dhk demo` = fictional 3-team "Nimbus Labs" sample org,
  deterministic generator `scripts/generate-sample-org.mjs`).
- **Core-4 report layout** with the team-level badge on every output.
- **Automation**: CI verify job (typecheck→lint→test-with-coverage-ratchet→build→size
  ratchet) + separate e2e job driving the built CLI; pre-push mirrors CI exactly;
  standing reviewer (`scripts/review.mjs` + `docs/review-rubric.md`); coverage ratchet
  raised 65/75/64/65 → 73/78/76/73 (measured 74.95/80.26/78.48/74.95 on 2026-07-02);
  `license: UNLICENSED, private: true` (was MIT — licensing is a go-public decision).
- **Tests**: 79 (was 40), all offline, hand-checked fixture expectations, injected-fetch
  mocks for every live path. Deviation from packet noted: chose dependency-free fetch
  injection over MSW — same no-real-API-calls guarantee, zero new deps, keeps the
  offline kit lean.

## Harvest map (what moved from where)

| Into dhk | From | Notes |
| --- | --- | --- |
| pagerduty fetch shape | service-health-bot/src/fetchers/pagerduty.ts | + pagination, periodDays window, dropped hard-coded host |
| TTD/TTR/TTM percentile maths | eng-intel-toolkit/pagerduty-fetcher/metrics.ts | the compute the preferred source lacked |
| sentry fetch + aggregation | service-health-bot/src/fetchers/sentry.ts | + self-hosted host config |
| SLO queries | eng-intel-toolkit/prometheus-slo | de-orged: metric presets (micrometer/prometheus-http), selector config, no company paths |
| BigQuery deploy log | service-health-bot/src/fetchers/bigquery.ts | reshaped: raw DeployEvents out, org's own table/query |
| Sheets output | eng-intel-toolkit/sheets-reporter | rewritten to plain REST (no googleapis dep), pure row renderers |
| sprint vocabulary (churn, six buckets, hero/chaos/laser) | metrics/src/metrics/metrics.py | denominator mapping documented in code |
| NOT harvested | eng-intel-toolkit github/jira fetchers, *-service-metrics presets | dhk's are strictly better / config-driven teams replace presets |

## Staged retirements (NOT executed — Karl's go required)

- `~/Dev/eng-intel-toolkit` → archive (harvest complete; no commits, no remote — delete or move to an archive folder).
- `~/Dev/metrics` → archive (sprint IP ported).
- `~/Dev/service-health-bot` → fold/park (fetchers harvested; keep as thin deploy wrapper only if the daily-digest cron is still wanted, else archive).
- `pr-watch`, `eu-worktime-compliance` → untouched, as directed.
- Suggested command (stage only): `mkdir -p ~/Dev/_archive && mv ~/Dev/eng-intel-toolkit ~/Dev/metrics ~/Dev/_archive/`

## Harvest back to estate (fold into ai-starter/_standard + skills)

1. **Seeded sample-org generator pattern** (`scripts/generate-sample-org.mjs`): committed
   deterministic fixtures with team "personalities" — reusable for any demo-first product.
   Candidate for ai-starter playbook.
2. **Size ratchet on shipped JS only** (`scripts/check-size.mjs`): sourcemaps/.d.ts are dev
   artefacts; budget the runtime payload. Improves relay's pattern; candidate for _standard.
3. **e2e-smoke-against-dist pattern** (`scripts/e2e-smoke.sh`): CLI products should smoke
   the built artefact, not the TS sources, as a separate CI job. Candidate for _standard.
4. **Injected-fetch mocking beats MSW for zero-dep CLIs**: `options.fetch` on every live
   fetcher gives no-network tests without a dependency. Candidate testing-and-coverage.md note.
5. **`cfrBasis`-style honest-label pattern**: when a metric has a proxy and a true form,
   carry the basis in the model and render it — never silently conflate. Reusable metric
   principle for the estate's metric definitions.
6. **biome-ignore for verbatim-harvested files** (scripts/review.mjs): keep canonical copies
   byte-identical to their source repo rather than reformatting — sync beats style.
7. **Config-with-presets adapter principle** (see design principle 1): the reusable answer
   to "built on my infra, must work on theirs".
8. **verify-all repo list**: dhk already listed; when eng-intel-toolkit/metrics are archived,
   remove any references (none exist in verify-all today).

## Verification record (2026-07-02)

- typecheck ✓ · lint ✓ · **tests 87/87** ✓ · coverage 74.52 stmts / 79.69 branch
  (ratchet 73/78/76/73) ✓ · build ✓ · size ratchet 127 KB / 192 KB ✓ · e2e smoke 9/9
  paths ✓ (built CLI) · estate `verify-all` 6 PASS / 0 FAIL.
- Sensitivity gate: `grep -rniE 'squarespace|sqsp|wario'` over the tree → clean.
- **Independent adversarial review** (fresh-agent, four lenses: correctness / DevEx /
  onboarding / security): 14 confirmed findings, **all 14 fixed** + regression tests:
  1. (HIGH) hidden token prompt echoed input via readline → rewritten, no echo, no readline
  2. (HIGH) live DORA computed over unwindowed deploys → `computeDoraMetrics` windows on `now`
  3. (HIGH) live avgPRSize always 0 (list API lacks additions) → per-PR detail fetch added
  4. (MED) recovery time mislabelled (all-incident MTTR) → restricted to deploy-linked incident set
  5. (MED) `--push` could push fixture rows to a real Sheet → now requires `--live`
  6. (MED) unknown `--format` silently degraded to markdown → fails loud, per-command allow-list
  7. (MED) `-h` ran the demo instead of help → parsed as help flag
  8. (MED) `connect` with closed stdin exited 0 silently → prompt rejects on stdin end
  9. (MED) Sentry fetch capped at one page → Link-cursor pagination (10-page guard)
  10. (LOW) corrupt config.json treated as unconfigured (clobber risk) → fails loud
  11. (LOW) unreachable "rejected the key" branches → friendly errors on catch
  12. (LOW) two p90 conventions in one report → unified on nearest-rank ceil
  13. (LOW) sprint trend always named a "most chaotic" sprint → callouts need real thresholds
  14. (LOW) unreachable Prometheus read as SLO breach → `noData` state, excluded from attainment
  Review's non-defect confirmations: no individual-level leak anywhere; badges/labels present
  on all outputs; fetchWithRetry fails fast on 4xx without credential-burning retries.

## Open items for Karl

1. **Confirm the product name** ("Baseline" / `eng-baseline`) — then branding, wordmark
   (shared with moss→quarry→marshal suite), domain purchase at go-public.
2. **Approve the staged retirements** above.
3. **Approve commit** of this build (repo currently has the work uncommitted, per the
   no-commit guardrail).
4. Licensing decision deferred to go-public (UNLICENSED until then).
5. Fast-follow candidates: bundle the Jira live fetcher into `--live`; DevEx pulse survey;
   AI-readiness view (2025 DORA capabilities).
