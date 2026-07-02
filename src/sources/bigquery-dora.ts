import { fetchWithRetry } from "../http.js";
import type { ILogger } from "../logger.js";
import type { DeployEvent } from "./dora.js";

/**
 * Live DORA deploy-event source from a BigQuery deploy log.
 *
 * Harvested from service-health-bot/src/fetchers/bigquery.ts (the REST call +
 * row-parsing shape, tested there with MSW). Reshaped around the adapter
 * principle: the original hard-coded one org's `deployments.history` table and
 * aggregated in SQL; this one lets the org supply its own table (or a whole
 * custom query) and returns raw DeployEvents so the shared `computeDoraMetrics`
 * does the maths — one compute path for every source.
 *
 * Orgs without a deploy log don't need this at all: the zero-config default is
 * `deployEventsFromPRs` (merges-to-main = deploys) in dora.ts.
 */

export interface BigQueryDoraConfig {
  projectId: string;
  authToken: string;
  /**
   * Fully-qualified table with the org's deploy history. Expected columns:
   * repo (STRING), built_at (TIMESTAMP), deployed_at (TIMESTAMP),
   * is_revert (BOOL), is_fix (BOOL, optional), service (STRING, optional).
   */
  table?: string;
  /**
   * Escape hatch: a complete custom SQL query returning the columns above, for
   * orgs whose schema doesn't match. Takes precedence over `table`.
   */
  query?: string;
  periodDays: number;
}

interface BigQueryRow {
  f: Array<{ v: string | null }>;
}

/**
 * Live fetch: deploy events for the window, normalized to DeployEvent[].
 * Not exercised offline — needs a GCP project + OAuth token.
 */
export async function fetchBigQueryDeploys(
  config: BigQueryDoraConfig,
  options: { logger?: ILogger; fetch?: typeof globalThis.fetch } = {},
): Promise<DeployEvent[]> {
  const { logger } = options;
  if (!config.projectId || !config.authToken) {
    logger?.warn("BigQuery project / auth token not provided; skipping BigQuery source");
    return [];
  }
  if (!config.table && !config.query) {
    logger?.warn("BigQuery deploy table (or custom query) not configured; skipping");
    return [];
  }

  const query =
    config.query ??
    `SELECT repo, built_at, deployed_at, is_revert,
        IFNULL(is_fix, FALSE) AS is_fix, IFNULL(service, repo) AS service
      FROM \`${config.table}\`
      WHERE deployed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${Math.round(config.periodDays)} DAY)
      ORDER BY deployed_at DESC`;

  const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${config.projectId}/queries`;
  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.authToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, useLegacySql: false }),
    },
    options,
  ).catch((e) => {
    logger?.warn("BigQuery fetch failed", { error: String(e) });
    return null;
  });
  if (!res) return [];

  const data = (await res.json()) as { rows?: BigQueryRow[] };
  const out: DeployEvent[] = [];
  for (const row of data.rows ?? []) {
    const [repo, builtAt, deployedAt, isRevert, isFix, service] = row.f.map((c) => c.v);
    if (!repo || !builtAt || !deployedAt) continue;
    out.push({
      repo,
      builtAt: bqTimestampToIso(builtAt),
      deployedAt: bqTimestampToIso(deployedAt),
      isRevert: isRevert === "true",
      isFix: isFix === "true",
      service: service ?? repo,
    });
  }
  return out;
}

/** BigQuery returns TIMESTAMP as epoch seconds (string) or ISO; accept both. */
function bqTimestampToIso(value: string): string {
  const asNumber = Number(value);
  if (!Number.isNaN(asNumber) && value.trim() !== "") {
    return new Date(asNumber * 1000).toISOString();
  }
  return value;
}
