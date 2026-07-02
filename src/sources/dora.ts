import type { CfrBasis, DORAClass, DoraMetrics, TimeMetrics } from "../types.js";
import type { RawPR } from "./github.js";
import type { RawIncident } from "./pagerduty.js";

/**
 * DORA metrics.
 *
 * Reused from consolidation/_extracted_capabilities/bigquery-dora: the four
 * DORA-class thresholds (`classify*`) and the result shape are lifted verbatim.
 * Rewritten the computation to run over a normalized list of deploy events so it
 * works offline; the live BigQuery source is `bigquery-dora.ts`.
 *
 * 2024 definitions applied (expert-council locked):
 * - Rework rate = flagged fix/revert deploys ÷ total deploys. Flag-based only.
 * - CFR is incident-linked when incident data exists (deploy followed ≤24h by a
 *   triggered high-urgency incident, union with reverts), revert-proxy
 *   otherwise — `cfrBasis` labels which, so the two are never conflated.
 * - Failed-deployment recovery time = incident create→resolve, median + p90.
 */

export interface DeployEvent {
  repo: string;
  /** When the change was built / committed. */
  builtAt: string;
  /** When it reached production. */
  deployedAt: string;
  /** A revert deploy (counts toward change-failure rate). */
  isRevert: boolean;
  /** An unplanned fix deploy (counts toward rework rate; reverts also count). */
  isFix?: boolean;
  /** Service the deploy targets, for incident linking (defaults to `repo`). */
  service?: string;
}

const HOUR_MS = 1000 * 60 * 60;
const round = (n: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/** Title/branch markers that flag a deploy as unplanned rework. */
const FIX_MARKERS = /\b(hotfix|revert)\b|^fix[(:!]|\bfix:/i;

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
    cfrBasis: "revert-proxy",
    reworkRatePct: 0,
    totalDeploys: 0,
    totalReverts: 0,
    totalFixDeploys: 0,
    periodDays,
    classes: {
      deploymentFrequency: "Low",
      leadTime: "Low",
      changeFailureRate: "Elite",
    },
  };
}

export interface ComputeDoraOptions {
  /**
   * Incidents for the same window. When present, CFR upgrades to
   * incident-linked and recovery time (create→resolve median/p90) is included.
   */
  incidents?: RawIncident[];
  /** How long after a deploy an incident still counts against it (default 24h). */
  incidentWindowHours?: number;
  /**
   * Reference time. When supplied, deploys are windowed to
   * [now − periodDays, now] before any maths — live sources can hand over
   * unbounded histories without inflating frequency/CFR denominators.
   */
  now?: number;
}

/** Pure computation: deploy events (+ optional incidents) → DORA metrics. */
export function computeDoraMetrics(
  allDeploys: DeployEvent[],
  periodDays: number,
  options: ComputeDoraOptions = {},
): DoraMetrics {
  // Window first: every rate below divides by periodDays, so deploys outside
  // the window must never enter the numerators.
  const deploys =
    options.now === undefined
      ? allDeploys
      : allDeploys.filter((d) => {
          const t = new Date(d.deployedAt).getTime();
          return (
            t >= (options.now as number) - periodDays * 24 * HOUR_MS && t <= (options.now as number)
          );
        });
  if (deploys.length === 0) return emptyDoraMetrics(periodDays);

  const totalDeploys = deploys.length;
  const totalReverts = deploys.filter((d) => d.isRevert).length;
  const totalFixDeploys = deploys.filter((d) => d.isRevert || d.isFix).length;
  const leadTimes = deploys.map(
    (d) => (new Date(d.deployedAt).getTime() - new Date(d.builtAt).getTime()) / HOUR_MS,
  );
  const avgLeadTime = leadTimes.reduce((a, b) => a + b, 0) / totalDeploys;

  const { failedDeploys, cfrBasis, linkedIncidents } = countFailedDeploys(deploys, options);

  const deploymentFrequencyPerDay = round(totalDeploys / periodDays, 2);
  const leadTimeHours = round(avgLeadTime, 1);
  const changeFailureRatePct = round((failedDeploys / totalDeploys) * 100, 1);
  const reworkRatePct = round((totalFixDeploys / totalDeploys) * 100, 1);

  const metrics: DoraMetrics = {
    deploymentFrequencyPerDay,
    leadTimeHours,
    changeFailureRatePct,
    cfrBasis,
    reworkRatePct,
    totalDeploys,
    totalReverts,
    totalFixDeploys,
    periodDays,
    classes: {
      deploymentFrequency: classifyDeploymentFrequency(deploymentFrequencyPerDay),
      leadTime: classifyLeadTime(leadTimeHours),
      changeFailureRate: classifyChangeFailureRate(changeFailureRatePct),
    },
  };

  // Recovery time is computed ONLY over the incidents that linked to a deploy
  // (the CFR set) — the DORA metric is about recovering from failed
  // deployments, not overall incident MTTR (that lives in the digest's
  // incidents section). Absent linkage, the field is omitted rather than
  // silently substituting a different definition.
  const recovery = recoveryTimeFromIncidents(linkedIncidents);
  if (recovery) metrics.recoveryTime = recovery;

  return metrics;
}

/**
 * CFR numerator. Incident-linked when incidents are supplied: a deploy counts
 * as failed if it was reverted OR a triggered high-urgency incident opened on
 * its service within the window after it shipped (union — never double-counted).
 * Also returns the set of incidents that linked to some deploy, for the
 * failed-deployment recovery time.
 */
function countFailedDeploys(
  deploys: DeployEvent[],
  options: ComputeDoraOptions,
): { failedDeploys: number; cfrBasis: CfrBasis; linkedIncidents: RawIncident[] } {
  const incidents = options.incidents;
  if (!incidents || incidents.length === 0) {
    return {
      failedDeploys: deploys.filter((d) => d.isRevert).length,
      cfrBasis: "revert-proxy",
      linkedIncidents: [],
    };
  }

  const windowMs = (options.incidentWindowHours ?? 24) * HOUR_MS;
  const highUrgency = incidents.filter((i) => i.urgency === "high");
  const linked = new Set<RawIncident>();

  const incidentFollows = (d: DeployEvent): boolean => {
    const deployedAt = new Date(d.deployedAt).getTime();
    const service = (d.service ?? d.repo).toLowerCase();
    let hit = false;
    for (const i of highUrgency) {
      const createdAt = new Date(i.createdAt).getTime();
      if (
        i.service.toLowerCase() === service &&
        createdAt >= deployedAt &&
        createdAt <= deployedAt + windowMs
      ) {
        linked.add(i);
        hit = true;
      }
    }
    return hit;
  };

  const failed = deploys.filter((d) => {
    const followed = incidentFollows(d); // evaluate always, to collect linkage
    return d.isRevert || followed;
  });
  return {
    failedDeploys: failed.length,
    cfrBasis: "incident-linked",
    linkedIncidents: [...linked],
  };
}

/** Failed-deployment recovery time: incident create→resolve, median + p90. */
function recoveryTimeFromIncidents(
  incidents: RawIncident[],
): { medianMinutes: number; p90Minutes: number } | null {
  const durations = incidents
    .filter((i) => i.resolvedAt)
    .map(
      (i) =>
        (new Date(i.resolvedAt as string).getTime() - new Date(i.createdAt).getTime()) /
        (1000 * 60),
    );
  if (durations.length === 0) return null;
  const t = timeMetrics(durations);
  return { medianMinutes: t.medianMinutes, p90Minutes: t.p90Minutes };
}

/** avg / median / p90 over durations in minutes (shared with pagerduty.ts). */
export function timeMetrics(durations: number[]): TimeMetrics {
  if (durations.length === 0) return { avgMinutes: 0, medianMinutes: 0, p90Minutes: 0 };
  const sorted = [...durations].sort((a, b) => a - b);
  const pick = (p: number): number => {
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)] ?? 0;
  };
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  return {
    avgMinutes: Math.round(avg),
    medianMinutes: Math.round(pick(50)),
    p90Minutes: Math.round(pick(90)),
  };
}

/**
 * Zero-config deploy derivation: a PR merged to the default branch is a deploy
 * (built = created, deployed = merged). This is the universal default — orgs
 * with a real deploy log (BigQuery, GitHub Deployments) configure that source
 * instead and get true deploy timestamps.
 */
export function deployEventsFromPRs(prs: RawPR[], titles?: Map<number, string>): DeployEvent[] {
  return prs
    .filter((pr) => pr.mergedAt)
    .map((pr) => {
      const title = titles?.get(pr.number) ?? pr.title ?? "";
      return {
        repo: pr.repo,
        builtAt: pr.createdAt,
        deployedAt: pr.mergedAt as string,
        isRevert: /\brevert\b/i.test(title),
        isFix: FIX_MARKERS.test(title),
      };
    });
}
