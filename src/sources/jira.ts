import type { DeliveryConfig, JiraMetrics, WorkDistribution } from "../types.js";

/**
 * Jira sprint / throughput / work-mix metrics.
 *
 * Reused from consolidation/_extracted_capabilities/jira-fetcher: the work
 * categorization rules and the lead-time percentile maths are lifted from
 * categorization.ts / metrics.ts. Folded in the sprint-summary throughput idea
 * from Projects/sprint_report_generator.py (tickets closed / created / story
 * points). Rewritten to run on normalized issues so it is offline-testable; the
 * original required live Jira + changelog expansion.
 */

export interface RawIssue {
  key: string;
  type: string;
  status: string;
  createdAt: string;
  resolvedAt?: string | null;
  storyPoints?: number | null;
  labels?: string[];
  /** Status-transition timestamps (from changelog in live mode). */
  inProgressAt?: string | null;
  doneAt?: string | null;
}

export interface CategorizationConfig {
  bugTypes: string[];
  bugLabels: string[];
  explorationTypes: string[];
  explorationLabels: string[];
  techDebtTypes: string[];
  techDebtLabels: string[];
  productTypes: string[];
}

export const defaultCategorization: CategorizationConfig = {
  bugTypes: ["bug"],
  bugLabels: ["bug"],
  explorationTypes: ["spike"],
  explorationLabels: ["spike", "exploration", "poc", "prototype"],
  techDebtTypes: ["tech debt", "technical task"],
  techDebtLabels: ["tech-debt", "refactor", "engineering-excellence", "cleanup", "infrastructure"],
  productTypes: ["story", "feature", "task", "sub-task", "epic"],
};

type WorkCategory = keyof WorkDistribution;

const HOUR_MS = 1000 * 60 * 60;
const round1 = (n: number): number => Math.round(n * 10) / 10;

export function categorizeWork(issue: RawIssue, cfg = defaultCategorization): WorkCategory {
  const type = issue.type.toLowerCase();
  const labels = (issue.labels ?? []).map((l) => l.toLowerCase());
  const has = (arr: string[]): boolean => labels.some((l) => arr.includes(l));

  if (cfg.bugTypes.includes(type) || has(cfg.bugLabels)) return "bugs";
  if (cfg.explorationTypes.includes(type) || has(cfg.explorationLabels)) return "exploration";
  if (cfg.techDebtTypes.includes(type) || has(cfg.techDebtLabels)) return "techDebt";
  if (cfg.productTypes.includes(type)) return "productDelivery";
  return "other";
}

function workDistribution(issues: RawIssue[], cfg = defaultCategorization): WorkDistribution {
  const counts: WorkDistribution = {
    productDelivery: 0,
    bugs: 0,
    techDebt: 0,
    exploration: 0,
    other: 0,
  };
  for (const issue of issues) counts[categorizeWork(issue, cfg)]++;
  const total = issues.length || 1;
  return {
    productDelivery: Math.round((counts.productDelivery / total) * 100),
    bugs: Math.round((counts.bugs / total) * 100),
    techDebt: Math.round((counts.techDebt / total) * 100),
    exploration: Math.round((counts.exploration / total) * 100),
    other: Math.round((counts.other / total) * 100),
  };
}

function leadTimeHours(issue: RawIssue): number | null {
  if (!issue.inProgressAt || !issue.doneAt) return null;
  return (new Date(issue.doneAt).getTime() - new Date(issue.inProgressAt).getTime()) / HOUR_MS;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)] ?? 0;
}

export function emptyJiraMetrics(): JiraMetrics {
  return {
    ticketsClosed: 0,
    ticketsCreated: 0,
    storyPointsCompleted: 0,
    leadTime: { avgHours: 0, medianHours: 0, p90Hours: 0 },
    workDistribution: { productDelivery: 0, bugs: 0, techDebt: 0, exploration: 0, other: 0 },
    byType: {},
  };
}

/** Pure computation: normalized issues → sprint/throughput metrics. */
export function computeJiraMetrics(
  issues: RawIssue[],
  config: DeliveryConfig,
  now: number = Date.now(),
  sprintName?: string,
): JiraMetrics {
  const since = now - config.periodDays * 24 * HOUR_MS;
  const inWindow = (iso?: string | null): boolean =>
    !!iso && new Date(iso).getTime() >= since && new Date(iso).getTime() <= now;

  const completed = issues.filter((i) => inWindow(i.resolvedAt));
  const created = issues.filter((i) => inWindow(i.createdAt));
  if (completed.length === 0 && created.length === 0) {
    return { ...emptyJiraMetrics(), sprintName };
  }

  const storyPointsCompleted = completed.reduce((s, i) => s + (i.storyPoints ?? 0), 0);

  const leadTimes = completed
    .map(leadTimeHours)
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b);
  const avg = leadTimes.length ? leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length : 0;
  const median =
    leadTimes.length % 2 === 0 && leadTimes.length > 0
      ? ((leadTimes[leadTimes.length / 2 - 1] ?? 0) + (leadTimes[leadTimes.length / 2] ?? 0)) / 2
      : percentile(leadTimes, 0.5);

  const byType: Record<string, number> = {};
  for (const i of completed) byType[i.type] = (byType[i.type] ?? 0) + 1;

  return {
    sprintName,
    ticketsClosed: completed.length,
    ticketsCreated: created.length,
    storyPointsCompleted,
    leadTime: {
      avgHours: round1(avg),
      medianHours: round1(median),
      p90Hours: round1(percentile(leadTimes, 0.9)),
    },
    workDistribution: workDistribution(completed),
    byType,
  };
}
