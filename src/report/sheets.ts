import { fetchWithRetry } from "../http.js";
import type { ILogger } from "../logger.js";
import type { DeliveryReport, ReliabilityReport } from "../types.js";

/**
 * Google Sheets output.
 *
 * Harvested from eng-intel-toolkit/sheets-reporter. Reworked to the dhk
 * pattern: the row-building is pure (`renderSheetsRows`) so it is
 * snapshot-testable offline, and the live append uses the plain Sheets REST
 * API with a bearer token instead of the googleapis SDK — zero new
 * dependencies, and MSW-mockable like every other live path. Orgs using
 * service accounts mint the token themselves (e.g.
 * `gcloud auth print-access-token`); the tool never handles key files.
 */

export type SheetsCell = string | number | boolean;

/**
 * Pure: report → spreadsheet rows (header + one data row). One row per run,
 * so successive appends build a time series the team can chart.
 */
export function renderSheetsRows(report: DeliveryReport): SheetsCell[][] {
  const header = [
    "date",
    "team",
    "period_days",
    "deploy_freq_per_day",
    "lead_time_hours",
    "cfr_pct",
    "cfr_basis",
    "rework_pct",
    "prs_merged",
    "pr_cycle_hours",
    "ttfr_hours",
    "pr_size",
    "tickets_closed",
    "story_points",
    "support_requests",
  ];
  const d = report.dora;
  const g = report.github;
  const j = report.jira;
  const s = report.support;
  const row: SheetsCell[] = [
    report.generatedAt.slice(0, 10),
    report.team,
    report.periodDays,
    d?.deploymentFrequencyPerDay ?? "",
    d?.leadTimeHours ?? "",
    d?.changeFailureRatePct ?? "",
    d?.cfrBasis ?? "",
    d?.reworkRatePct ?? "",
    g?.totalMerged ?? "",
    g?.avgCycleTimeHours ?? "",
    g?.avgTimeToFirstReviewHours ?? "",
    g?.avgPRSize ?? "",
    j?.ticketsClosed ?? "",
    j?.storyPointsCompleted ?? "",
    s?.totalRequests ?? "",
  ];
  return [header, row];
}

/** Pure: digest → spreadsheet rows (header + one data row). */
export function renderDigestSheetsRows(digest: ReliabilityReport): SheetsCell[][] {
  const header = [
    "date",
    "team",
    "period_days",
    "incidents_total",
    "incidents_active",
    "high_urgency",
    "recovery_median_min",
    "recovery_p90_min",
    "out_of_hours_pct",
    "errors_total",
    "errors_new",
    "slo_attainment_pct",
  ];
  const i = digest.incidents;
  const e = digest.errors;
  const s = digest.slo;
  const row: SheetsCell[] = [
    digest.generatedAt.slice(0, 10),
    digest.team,
    digest.periodDays,
    i?.totalIncidents ?? "",
    i?.active ?? "",
    i?.byUrgency.high ?? "",
    i?.ttm.medianMinutes ?? "",
    i?.ttm.p90Minutes ?? "",
    i?.onCall.outOfHoursPct ?? "",
    e?.totalIssues ?? "",
    e?.newIssues ?? "",
    s?.attainmentPct ?? "",
  ];
  return [header, row];
}

export interface SheetsAppendConfig {
  spreadsheetId: string;
  /** OAuth bearer token with spreadsheets scope. */
  authToken: string;
  /** Range to append into (default Sheet1!A:Z). */
  range?: string;
}

/**
 * Live path: append rows to a Google Sheet via the REST API.
 * Returns the number of rows written (0 on failure — degrade, don't throw).
 */
export async function appendSheetsRows(
  config: SheetsAppendConfig,
  rows: SheetsCell[][],
  options: { logger?: ILogger; fetch?: typeof globalThis.fetch } = {},
): Promise<number> {
  const { logger } = options;
  if (!config.spreadsheetId || !config.authToken) {
    logger?.warn("Sheets spreadsheet ID / auth token not provided; skipping Sheets output");
    return 0;
  }
  const range = encodeURIComponent(config.range ?? "Sheet1!A:Z");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${config.spreadsheetId}/values/${range}:append?valueInputOption=RAW`;

  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.authToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ values: rows }),
    },
    options,
  ).catch((e) => {
    logger?.warn("Sheets append failed", { error: String(e) });
    return null;
  });
  if (!res) return 0;

  const data = (await res.json()) as { updates?: { updatedRows?: number } };
  return data.updates?.updatedRows ?? 0;
}
