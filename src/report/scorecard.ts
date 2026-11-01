import type {
  DeliveryReport,
  DeliveryScorecard,
  DoraMetrics,
  GitHubMetrics,
  SiteScore,
  SupportMetrics,
} from "../types.js";
import { type AssembleInput, assembleReport } from "./assemble.js";

/**
 * Multi-site roll-up: point dhk at many teams and get ONE comparison view.
 *
 * The maths is NOT re-implemented — each site goes through the same
 * `assembleReport` (and the same per-source `compute*` functions) as a single
 * report. The only thing added here is a transparent composite **health score**
 * so sites can be ranked and the biggest drag flagged.
 */

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** DORA class → sub-score. Elite best, Low worst. */
const CLASS_SCORE = { Elite: 1, High: 0.8, Medium: 0.5, Low: 0.2 } as const;

function doraScore(d: DoraMetrics): number {
  const c = d.classes;
  return (
    (CLASS_SCORE[c.deploymentFrequency] +
      CLASS_SCORE[c.leadTime] +
      CLASS_SCORE[c.changeFailureRate]) /
    3
  );
}

/** PR-flow health from cycle time: ≤4h is great, ≥72h is poor (linear between). */
function prFlowScore(g: GitHubMetrics): number {
  return clamp01((72 - g.avgCycleTimeHours) / (72 - 4));
}

/** Support health: mean of resolution rate and first-response-vs-target. */
function supportScore(s: SupportMetrics): number {
  const resolution = clamp01(s.resolutionRatePct / 100);
  const frt = s.medianFirstResponseMinutes;
  const frtScore =
    frt === null ? resolution : clamp01(s.targets.medianFrtMinutes / Math.max(frt, 1));
  return (resolution + frtScore) / 2;
}

/**
 * A transparent 0–100 composite health score: the mean of whichever dimensions
 * the site actually has data for (DORA, PR flow, support). Sprint/Jira is shown
 * in the scorecard but deliberately NOT scored — it has no normalised target, so
 * folding it in would be a fabricated number. Returns the score plus its parts.
 */
export function scoreReport(r: DeliveryReport): { score: number; parts: SiteScore["parts"] } {
  const parts: SiteScore["parts"] = {};
  if (r.dora && !r.dora.noData) parts.dora = doraScore(r.dora);
  if (r.github) parts.prFlow = prFlowScore(r.github);
  if (r.support) parts.support = supportScore(r.support);

  const values = Object.values(parts);
  const score = values.length
    ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100)
    : 0;
  return { score, parts };
}

/** Assemble N per-site reports and rank them healthiest-first. */
export function assembleScorecard(inputs: AssembleInput[]): DeliveryScorecard {
  const first = inputs[0];
  if (!first) {
    throw new Error("assembleScorecard needs at least one site.");
  }
  const sites: SiteScore[] = inputs.map((input) => {
    const report = assembleReport(input);
    const { score, parts } = scoreReport(report);
    return { team: report.team, score, parts, report };
  });
  sites.sort((a, b) => b.score - a.score);

  const now = first.now ?? Date.now();
  return {
    generatedAt: new Date(now).toISOString(),
    periodDays: first.config.periodDays,
    mode: first.mode,
    sites,
  };
}
