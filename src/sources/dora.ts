import type { DORAClass, DoraMetrics } from "../types.js";

/**
 * DORA metrics.
 *
 * Reused from consolidation/_extracted_capabilities/bigquery-dora: the four
 * DORA-class thresholds (`classify*`) and the result shape are lifted verbatim.
 * Rewritten the computation to run over a normalized list of deploy events so it
 * works offline; the original only computed inside a BigQuery SQL query against
 * Drone build data (kept as the documented live path, see `DORA_LIVE.md` notes
 * in the README — no @google-cloud/bigquery dependency is pulled in here).
 */

export interface DeployEvent {
  repo: string;
  /** When the change was built / committed. */
  builtAt: string;
  /** When it reached production. */
  deployedAt: string;
  /** A revert deploy (counts toward change-failure rate). */
  isRevert: boolean;
}

const HOUR_MS = 1000 * 60 * 60;
const round = (n: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

export function classifyDeploymentFrequency(deploysPerDay: number): DORAClass {
  if (deploysPerDay >= 1) return "Elite";
  if (deploysPerDay >= 0.14) return "High";
  if (deploysPerDay >= 0.03) return "Medium";
  return "Low";
}

export function classifyLeadTime(hours: number): DORAClass {
  if (hours <= 24) return "Elite";
  if (hours <= 168) return "High";
  if (hours <= 720) return "Medium";
  return "Low";
}

export function classifyChangeFailureRate(ratePct: number): DORAClass {
  if (ratePct <= 15) return "Elite";
  if (ratePct <= 30) return "High";
  if (ratePct <= 45) return "Medium";
  return "Low";
}

export function emptyDoraMetrics(periodDays: number): DoraMetrics {
  return {
    deploymentFrequencyPerDay: 0,
    leadTimeHours: 0,
    changeFailureRatePct: 0,
    totalDeploys: 0,
    totalReverts: 0,
    periodDays,
    classes: {
      deploymentFrequency: "Low",
      leadTime: "Low",
      changeFailureRate: "Elite",
    },
  };
}

/** Pure computation: deploy events → DORA metrics. */
export function computeDoraMetrics(deploys: DeployEvent[], periodDays: number): DoraMetrics {
  if (deploys.length === 0) return emptyDoraMetrics(periodDays);

  const totalDeploys = deploys.length;
  const totalReverts = deploys.filter((d) => d.isRevert).length;
  const leadTimes = deploys.map(
    (d) => (new Date(d.deployedAt).getTime() - new Date(d.builtAt).getTime()) / HOUR_MS,
  );
  const avgLeadTime = leadTimes.reduce((a, b) => a + b, 0) / totalDeploys;

  const deploymentFrequencyPerDay = round(totalDeploys / periodDays, 2);
  const leadTimeHours = round(avgLeadTime, 1);
  const changeFailureRatePct = round((totalReverts / totalDeploys) * 100, 1);

  return {
    deploymentFrequencyPerDay,
    leadTimeHours,
    changeFailureRatePct,
    totalDeploys,
    totalReverts,
    periodDays,
    classes: {
      deploymentFrequency: classifyDeploymentFrequency(deploymentFrequencyPerDay),
      leadTime: classifyLeadTime(leadTimeHours),
      changeFailureRate: classifyChangeFailureRate(changeFailureRatePct),
    },
  };
}
