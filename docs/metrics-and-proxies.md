# Metric definitions and limits

Baseline reports team-level signals. **Direct** means calculated from recorded source events; **proxy** means a substitute for the outcome named; **heuristic** means a rule-based interpretation.

Live delivery reports currently ingest GitHub PRs. PagerDuty, Sentry and Prometheus feed the live reliability digest. Jira and support calculations use fixtures or supplied records; the CLI does not ingest them live. The BigQuery deployment adapter is not wired into live commands.

## Delivery

| Metric | Definition and source | Status | Limitation | Intended use |
| --- | --- | --- | --- | --- |
| Deployment frequency | Deployment-event count ÷ period days; live reports substitute merged GitHub PRs. | Proxy live; direct with recorded deployments. | A merge does not prove a production release. | Investigate delivery cadence. |
| Lead time for changes | Mean `builtAt` → `deployedAt`; live GitHub mapping uses PR creation → merge. | Proxy live; event-based otherwise. | The live value excludes merge-to-production delay. Event meaning depends on supplied timestamps. | Investigate elapsed delivery time. |
| Change failure rate | Failed events ÷ total events. Reverts count; with non-empty incident input, matching-service high-urgency incidents within 24 hours also count. | Revert proxy or incident-linked heuristic; labelled by `cfrBasis`. | Time/service linkage does not prove causation. Live `report` uses the revert proxy; live `digest` does not supply deployments. | Investigate change-related instability. |
| Rework rate | Fix- or revert-flagged events ÷ total events; live flags come from PR-title patterns. | Proxy. | Naming conventions miss unlabelled rework. | Discuss corrective work. |
| Failed-deployment recovery | Median/p90 incident creation → resolution for resolved incidents linked to deployment events. | Direct duration within a heuristic linked set. | Omits unresolved/unlinked incidents; requires both inputs. | Examine recovery after suspected failed changes. |
| PR cycle time and first review | Mean PR creation → merge; mean creation → first recorded review among reviewed, merged PRs. GitHub. | Direct workflow measures. | Excludes unmerged work; review timing excludes PRs without recorded reviews. | Locate workflow delays. |
| PR size | Mean additions + deletions per merged PR. GitHub. | Direct size; effectiveness proxy. | Lines changed do not measure complexity, value or developer experience. | Discuss batch size. |
| Ticket lead time | In-progress → done duration for resolved issues with both timestamps; average, median and p90. Jira-shaped records. | Direct workflow duration; effectiveness proxy. | Excludes missing timestamps and unfinished work; no live Jira ingestion. | Investigate ticket flow. |
| Throughput and work mix | Created/closed issue counts, completed points and completed-issue category shares. Jira-shaped records. | Direct counts; impact proxy. | Points are locally defined; categories depend on taxonomy. Neither establishes customer value. | Discuss workload and allocation. |
| Support load | Request count, median first response among answered threads, resolved share, unanswered and late replies. Support-thread records. | Direct recorded activity. | Depends on export completeness and resolution labels; not time spent handling requests. | Discuss support demand and responsiveness. |

## Reliability

| Metric | Definition and source | Status | Limitation | Intended use |
| --- | --- | --- | --- | --- |
| Incident volume and mix | Counts by status, urgency, severity and service for incidents created in the period. PagerDuty. | Direct. | Captures recorded incidents, not every failure or customer impact. | Identify recurring operational load. |
| “Time to detect” | Incident creation → acknowledgement; average, median and p90. PagerDuty. | Direct acknowledgement duration; detection proxy. | Does not measure failure onset → detection. | Discuss acknowledgement delay. |
| Incident recovery | Incident creation → resolution for resolved incidents; average, median and p90. PagerDuty. | Direct recorded duration. | Excludes unresolved incidents; distinct from deployment-linked recovery. | Discuss incident response. |
| On-call load | Incident counts by service and share created outside configured working hours. PagerDuty. | Direct counts; workload proxy. | Does not measure responder effort or interruptions; hours use a fixed UTC offset. | Discuss service-level operational burden. |
| Error issues | Unresolved issues seen in the period, newly first-seen issues and project/level counts. Sentry. | Direct issue counts. | Issues are grouped records, not error-event totals or an error-budget calculation. | Identify error backlogs and new problems. |
| SLO position | Availability from non-5xx request share over 1 hour; p95/p99 latency over 5 minutes. Prometheus. Attainment is the share of measurable services meeting both targets. | Instrumented estimates. | These are recent windows, not whole-report-period SLO compliance. Services have equal weight; no-data services are excluded. | Check current service conditions. |

## Additional views

| Signal | Definition and source | Status | Limitation | Intended use |
| --- | --- | --- | --- | --- |
| Sprint health | Completion, focus, additions, carryover and optional churn ratios from supplied sprint records; combined into bands and a weighted predictability index. | Direct ratios plus heuristic verdicts. | “Planned completion” uses total completed ÷ committed, including added work. Units must be consistent; bands are implementation rules. | Structure a sprint review. |
| Support-drag estimate | Request count × 20 minutes, rounded to hours. Support-thread records. | Heuristic estimate. | Handling time is assumed, not observed. | Make possible hidden load visible. |
| Risky-ticket shortlist | Weighted flags for blockers, staleness, missing estimates/reviewers, reopening and review delay. Ticket records. | Heuristic. | Scores are not failure probabilities. Missing fields limit detection. | Select work to investigate. |
| Scorecard | Rounded mean of available DORA, PR-flow and support sub-scores, scaled to 0–100. | Heuristic composite. | Missing dimensions change the basis of comparison; Jira throughput is not scored. | Start a contextual review, not establish team performance. |

Compare like periods and source coverage. Missing data is not evidence of health. No metric should be used to rank individuals.

Calculations: [`src/sources`](../src/sources/), [`src/reads`](../src/reads/) and [`src/report/scorecard.ts`](../src/report/scorecard.ts).
