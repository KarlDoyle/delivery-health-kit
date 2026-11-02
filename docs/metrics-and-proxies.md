# Metric definitions and limits

Baseline combines source data into team-level delivery, reliability and sprint reports. The metric functions are deterministic; the meaning and limits of each input still depend on the source and its coverage.

## Signals and evidence

| Signal | Current basis | Limit to state with the result |
| --- | --- | --- |
| Deployment frequency and lead time | Deploy events, including the current merge-based GitHub proxy | A merge is not proof of a production deployment. |
| Change failure rate | Incident linkage when available; revert proxy otherwise | The report carries the basis so the two readings are not presented as equivalent. |
| Failed-deployment recovery | Linked deployment and incident timestamps where available | Missing or unlinked events reduce coverage. |
| PR flow | GitHub pull-request timestamps, size and review events | These describe workflow signals, not individual productivity. |
| Effectiveness | System-side ticket and batch proxies | There is no DevEx survey in the current implementation. |
| Reliability | PagerDuty incidents, Sentry issues and Prometheus SLOs | Only connected services and configured SLOs appear. |
| Sprint health and support drag | Jira-shaped fixtures or records and support threads | Jira REST ingestion is not part of the current CLI. |

The available calculations and source boundaries are visible in `src/sources/`, `src/reads/` and `src/report/`. `tests/dora-extended.test.ts`, `tests/sprint-model.test.ts` and `tests/support-drag.test.ts` are useful entry points for reviewing calculation cases.

## Interpretation

Use the report to support a team discussion. Do not treat a proxy as an authoritative event, compare unlike source coverage, or read a team-level signal as an individual score. Where a source is absent, the report may omit that section; absence of a metric is not evidence of a healthy result.
