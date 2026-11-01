import { fetchWithRetry } from "../http.js";
import type { ILogger } from "../logger.js";
import type { DeployEvent } from "./dora.js";

/** BigQuery REST API adapter for deployment history. */
export interface BigQueryDoraConfig {
  projectId: string;
  authToken: string;
  /** Table columns: repo STRING, built_at TIMESTAMP, deployed_at TIMESTAMP, is_revert BOOL, is_fix BOOL, service STRING. */
  table?: string;
  /** Complete SQL returning repo, built_at, deployed_at, is_revert, is_fix, service in that order. */
  query?: string;
  periodDays: number;
}

interface BigQueryRow {
  f?: Array<{ v?: string | null }>;
}

interface BigQueryResponse {
  rows?: BigQueryRow[];
  pageToken?: string;
  jobComplete?: boolean;
  jobReference?: { jobId?: string; location?: string };
  error?: { message?: string };
}

/**
 * Fetch all deployment rows. Returns null on API/query failure, distinct from
 * [] which is a successful query with no deployments.
 */
export async function fetchBigQueryDeploys(
  config: BigQueryDoraConfig,
  options: { logger?: ILogger; fetch?: typeof globalThis.fetch } = {},
): Promise<DeployEvent[] | null> {
  const { logger } = options;
  if (!config.projectId || !config.authToken || (!config.table && !config.query)) {
    logger?.warn("BigQuery needs a project, OAuth token and table or custom query; skipping");
    return null;
  }

  if (
    !config.query &&
    config.table &&
    !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_]+){1,2}$/.test(config.table)
  ) {
    logger?.warn("BigQuery table must be dataset.table or project.dataset.table");
    return null;
  }

  const periodDays = Number.isFinite(config.periodDays)
    ? Math.max(1, Math.round(config.periodDays))
    : 14;
  const query =
    config.query ??
    `SELECT repo, built_at, deployed_at, is_revert,
        IFNULL(is_fix, FALSE) AS is_fix, IFNULL(service, repo) AS service
      FROM \`${config.table}\`
      WHERE deployed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${periodDays} DAY)
      ORDER BY deployed_at DESC`;
  const baseUrl = `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(config.projectId)}/queries`;
  const request = async (url: string, init?: RequestInit): Promise<BigQueryResponse | null> => {
    const response = await fetchWithRetry(
      url,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${config.authToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...init?.headers,
        },
      },
      options,
    ).catch((error) => {
      logger?.warn("BigQuery request failed", { error: String(error) });
      return null;
    });
    if (!response) return null;
    const body = (await response.json().catch(() => null)) as BigQueryResponse | null;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      body.error ||
      (body.rows !== undefined && !Array.isArray(body.rows)) ||
      (body.pageToken !== undefined && typeof body.pageToken !== "string") ||
      (body.jobComplete !== undefined && typeof body.jobComplete !== "boolean") ||
      (body.rows === undefined && body.jobComplete === undefined && body.jobReference === undefined)
    ) {
      logger?.warn("BigQuery returned an invalid response", { error: body?.error?.message });
      return null;
    }
    return body;
  };

  let page = await request(baseUrl, {
    method: "POST",
    body: JSON.stringify({ query, useLegacySql: false }),
  });
  if (!page) return null;

  const rows: BigQueryRow[] = [];
  const jobId = page.jobReference?.jobId;
  const jobUrl = jobId ? new URL(`${baseUrl}/${encodeURIComponent(jobId)}`) : null;
  if (jobUrl && page.jobReference?.location) {
    jobUrl.searchParams.set("location", page.jobReference.location);
  }

  // A query can return before its job has completed. Poll the job-results endpoint.
  if (page.jobComplete === false) {
    if (!jobUrl) {
      logger?.warn("BigQuery query is incomplete but returned no job ID");
      return null;
    }
    let complete = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const polled = await request(jobUrl.toString());
      if (!polled) return null;
      page = polled;
      if (page.jobComplete !== false) {
        complete = true;
        break;
      }
    }
    if (!complete) {
      logger?.warn("BigQuery query did not complete before the polling limit");
      return null;
    }
  }

  rows.push(...(page.rows ?? []));
  let pageToken = page.pageToken;
  const seenTokens = new Set<string>();
  // BigQuery pages are bounded; the guard protects against broken/repeating tokens.
  for (let pageNumber = 0; pageToken && pageNumber < 1000; pageNumber++) {
    if (seenTokens.has(pageToken)) {
      logger?.warn("BigQuery returned a repeated page token; stopping pagination");
      return null;
    }
    seenTokens.add(pageToken);
    if (!jobUrl) {
      logger?.warn("BigQuery returned a page token without a query job ID");
      return null;
    }
    const nextUrl = new URL(jobUrl);
    nextUrl.searchParams.set("pageToken", pageToken);
    const next = await request(nextUrl.toString());
    if (!next) return null;
    rows.push(...(next.rows ?? []));
    pageToken = next.pageToken;
    page = next;
  }
  if (pageToken) {
    logger?.warn("BigQuery pagination exceeded the 1000-page safety limit");
    return null;
  }

  const out: DeployEvent[] = [];
  for (const row of rows) {
    const fields = row.f;
    if (!Array.isArray(fields)) continue;
    const [repo, builtAt, deployedAt, isRevert, isFix, service] = fields.map(
      (field) => field?.v ?? null,
    );
    if (!repo || !builtAt || !deployedAt) continue;
    const builtAtIso = bqTimestampToIso(builtAt);
    const deployedAtIso = bqTimestampToIso(deployedAt);
    if (!builtAtIso || !deployedAtIso) continue;
    out.push({
      repo,
      builtAt: builtAtIso,
      deployedAt: deployedAtIso,
      isRevert: isRevert === "true",
      isFix: isFix === "true",
      service: service ?? repo,
    });
  }
  return out;
}

/** BigQuery returns TIMESTAMP as epoch seconds (string) or ISO; accept both. */
function bqTimestampToIso(value: string): string | null {
  const asNumber = Number(value);
  if (!Number.isNaN(asNumber) && value.trim() !== "") {
    const date = new Date(asNumber * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return Number.isFinite(Date.parse(value)) ? value : null;
}
