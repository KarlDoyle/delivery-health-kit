import { type DeployEvent, computeDoraMetrics } from "../sources/dora.js";
import { type RawPR, computeGitHubMetrics } from "../sources/github.js";
import { type RawIssue, computeJiraMetrics } from "../sources/jira.js";
import {
  type RawIncident,
  type WorkingHours,
  computePagerDutyMetrics,
} from "../sources/pagerduty.js";
import { computeSloMetrics } from "../sources/prometheus-slo.js";
import { type RawSentryIssue, computeSentryMetrics } from "../sources/sentry.js";
import { type SupportThread, computeSupportMetrics } from "../sources/support.js";
import type { DeliveryConfig, DeliveryReport, ReliabilityReport, ServiceSlo } from "../types.js";

/**
 * The consolidation step: take raw signals from every source and assemble the
 * single EM report. This is the heart of the kit — the legacy tools each owned
 * their own end-to-end flow; here every source is just a pure function feeding
 * one model. Identical for offline and live (only the inputs differ).
 */

export interface AssembleInput {
  config: DeliveryConfig;
  mode: "offline" | "live";
  /** Reference time for date windows; defaults to now. */
  now?: number;
  sprintName?: string;
  prs?: RawPR[];
  deploys?: DeployEvent[];
  issues?: RawIssue[];
  threads?: SupportThread[];
}

export function assembleReport(input: AssembleInput): DeliveryReport {
  const { config, mode, sprintName } = input;
  const now = input.now ?? Date.now();

  const report: DeliveryReport = {
    generatedAt: new Date(now).toISOString(),
    team: config.team,
    periodDays: config.periodDays,
    mode,
  };

  if (input.deploys) report.dora = computeDoraMetrics(input.deploys, config.periodDays, { now });
  if (input.prs) report.github = computeGitHubMetrics(input.prs, config, now);
  if (input.issues) report.jira = computeJiraMetrics(input.issues, config, now, sprintName);
  if (input.threads) report.support = computeSupportMetrics(input.threads);

  return report;
}

export interface AssembleDigestInput {
  config: DeliveryConfig;
  mode: "offline" | "live";
  /** Reference time for date windows; defaults to now. */
  now?: number;
  incidents?: RawIncident[];
  sentryIssues?: RawSentryIssue[];
  /** Per-service SLO positions (from live queries, or the fixtures offline). */
  slo?: ServiceSlo[];
  /**
   * Deploys for the same window: with incidents present these upgrade the DORA
   * block to the incident-linked CFR + recovery time.
   */
  deploys?: DeployEvent[];
  workingHours?: WorkingHours;
}

/**
 * The reliability half (`dhk digest`): same discipline as `assembleReport` —
 * every source a pure function feeding one model, identical offline and live.
 */
export function assembleDigest(input: AssembleDigestInput): ReliabilityReport {
  const { config, mode } = input;
  const now = input.now ?? Date.now();

  const digest: ReliabilityReport = {
    generatedAt: new Date(now).toISOString(),
    team: config.team,
    periodDays: config.periodDays,
    mode,
  };

  if (input.incidents) {
    digest.incidents = computePagerDutyMetrics(
      input.incidents,
      config.periodDays,
      now,
      input.workingHours,
    );
  }
  if (input.sentryIssues) {
    digest.errors = computeSentryMetrics(input.sentryIssues, config.periodDays, now);
  }
  if (input.slo) digest.slo = computeSloMetrics(input.slo);
  if (input.deploys) {
    // Window-filter incidents here: the CFR linkage and recovery time must only
    // see this period's incidents (computePagerDutyMetrics windows separately).
    const since = now - config.periodDays * 24 * 60 * 60 * 1000;
    const incidentsInWindow = (input.incidents ?? []).filter((i) => {
      const t = new Date(i.createdAt).getTime();
      return t >= since && t <= now;
    });
    digest.dora = computeDoraMetrics(input.deploys, config.periodDays, {
      incidents: incidentsInWindow,
      now,
    });
  }

  return digest;
}
