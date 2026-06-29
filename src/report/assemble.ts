import { type DeployEvent, computeDoraMetrics } from "../sources/dora.js";
import { type RawPR, computeGitHubMetrics } from "../sources/github.js";
import { type RawIssue, computeJiraMetrics } from "../sources/jira.js";
import { type SupportThread, computeSupportMetrics } from "../sources/support.js";
import type { DeliveryConfig, DeliveryReport } from "../types.js";

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

  if (input.deploys) report.dora = computeDoraMetrics(input.deploys, config.periodDays);
  if (input.prs) report.github = computeGitHubMetrics(input.prs, config, now);
  if (input.issues) report.jira = computeJiraMetrics(input.issues, config, now, sprintName);
  if (input.threads) report.support = computeSupportMetrics(input.threads);

  return report;
}
