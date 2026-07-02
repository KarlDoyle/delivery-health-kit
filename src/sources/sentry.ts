import { fetchWithRetry } from "../http.js";
import type { ILogger } from "../logger.js";
import type { SentryMetrics } from "../types.js";

/**
 * Sentry error-tracking metrics (error-budget context for the digest).
 *
 * Harvested from service-health-bot/src/fetchers/sentry.ts (tested there with
 * MSW). Adapted to the dhk pattern: pure compute separated from the live fetch,
 * window driven by `periodDays` instead of a hard-coded 24h, and the host made
 * configurable so self-hosted Sentry works (adapter principle — sentry.io is
 * just the default).
 */

/** Normalized issue — what both the fixtures and the live fetcher produce. */
export interface RawSentryIssue {
  id: string;
  title: string;
  count: number;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  level: "error" | "warning" | "info";
  project: string;
}

export function emptySentryMetrics(): SentryMetrics {
  return {
    totalIssues: 0,
    newIssues: 0,
    byProject: {},
    byLevel: { error: 0, warning: 0, info: 0 },
  };
}

/** Pure computation: normalized issues → error metrics for the window. */
export function computeSentryMetrics(
  issues: RawSentryIssue[],
  periodDays: number,
  now: number = Date.now(),
): SentryMetrics {
  const since = now - periodDays * 24 * 60 * 60 * 1000;
  // An issue is in scope if it was seen inside the window at all.
  const inWindow = issues.filter((i) => new Date(i.lastSeen).getTime() >= since);
  if (inWindow.length === 0) return emptySentryMetrics();

  const byProject: Record<string, number> = {};
  const byLevel = { error: 0, warning: 0, info: 0 };
  let newIssues = 0;
  for (const i of inWindow) {
    byProject[i.project] = (byProject[i.project] ?? 0) + 1;
    byLevel[i.level]++;
    if (new Date(i.firstSeen).getTime() >= since) newIssues++;
  }

  return { totalIssues: inWindow.length, newIssues, byProject, byLevel };
}

export interface SentryLiveConfig {
  org: string;
  authToken: string;
  /** API host — override for self-hosted Sentry (default sentry.io). */
  host?: string;
  periodDays: number;
}

interface ApiIssue {
  id: string;
  title: string;
  count: number | string;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  level: "error" | "warning" | "info";
  project: { name: string };
}

/** Max pages followed via Link cursors — a runaway-volume guard. */
const MAX_PAGES = 10;

/** Extract the rel="next" URL from a Sentry Link header when results remain. */
function nextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    if (part.includes('rel="next"') && part.includes('results="true"')) {
      const m = part.match(/<([^>]+)>/);
      if (m?.[1]) return m[1];
    }
  }
  return null;
}

/**
 * Live fetch: unresolved issues for the window, normalized to RawSentryIssue.
 * Follows Link-header cursors (Sentry pages at 100) so real error volume isn't
 * silently capped at one page. Not exercised offline — needs SENTRY_ORG +
 * SENTRY_AUTH_TOKEN.
 */
export async function fetchSentryIssues(
  config: SentryLiveConfig,
  options: { logger?: ILogger; fetch?: typeof globalThis.fetch } = {},
): Promise<RawSentryIssue[]> {
  const { logger } = options;
  if (!config.org || !config.authToken) {
    logger?.warn("Sentry org / auth token not provided; skipping Sentry source");
    return [];
  }
  const host = config.host ?? "https://sentry.io";
  const first = new URL(`${host}/api/0/organizations/${config.org}/issues/`);
  first.searchParams.append("query", "is:unresolved");
  first.searchParams.append("statsPeriod", `${config.periodDays}d`);
  first.searchParams.append("limit", "100");

  const headers = {
    Authorization: `Bearer ${config.authToken}`,
    Accept: "application/json",
  };

  const out: RawSentryIssue[] = [];
  let url: string | null = first.toString();
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const res = await fetchWithRetry(url, { headers }, options).catch((e) => {
      logger?.warn("Sentry fetch failed", { error: String(e) });
      return null;
    });
    if (!res) break;

    const issues = (await res.json()) as ApiIssue[];
    for (const i of issues) {
      out.push({
        id: i.id,
        title: i.title,
        count: Number(i.count),
        userCount: i.userCount,
        firstSeen: i.firstSeen,
        lastSeen: i.lastSeen,
        level: i.level,
        project: i.project.name,
      });
    }
    url = nextPageUrl(res.headers.get("link"));
  }
  return out;
}
