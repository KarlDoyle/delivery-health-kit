# Metric sensitivity scenarios

`pnpm eval:scenarios` runs the DORA calculation against one fixed fictional dataset and prints results for 7-, 14- and 30-day windows. Each window reports deployment frequency, average lead time, rework, CFR using the revert proxy, CFR with incident records, and linked-incident recovery time.

The input lives in `fixtures/scenarios/dora-sensitivity.json`. It covers the full 30 days ending 30 June 2026. The runner rejects a requested window that extends beyond the fixture coverage, so it cannot silently divide a short history by a longer period.

## Current fixture output

| Window | Deployments | Deployments/day | Lead time | CFR proxy | CFR with incidents | Rework | Recovery median/p90 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 7 days | 4 | 0.57 | 3.8 h | 0.0% | 25.0% | 25.0% | 120 / 120 min |
| 14 days | 7 | 0.50 | 3.9 h | 14.3% | 42.9% | 28.6% | 90 / 120 min |
| 30 days | 12 | 0.40 | 3.7 h | 16.7% | 33.3% | 33.3% | 90 / 120 min |

The figures are outputs from fictional records, useful for showing how the calculation responds to the window and failure basis. They do not represent team performance. The incident-linked rate is labelled with its basis; if a window has no incidents, the calculation falls back to the revert proxy.

## Run and test

```sh
pnpm eval:scenarios
pnpm exec vitest run tests/dora-scenarios.test.ts --reporter=verbose
```

The scenario tests check the expected counts and rates, reject incomplete period coverage, and reject invalid periods. Existing source tests separately cover the calculation edge cases, including empty windows, incident linkage, reverts, and recovery-time percentiles.
