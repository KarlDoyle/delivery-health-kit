import { fetchWithRetry } from "../http.js";
import type { ILogger } from "../logger.js";
import type { DeliveryConfig, GitHubMetrics } from "../types.js";

/**
 * GitHub PR-flow metrics.
 *
 * Reused from consolidation/_extracted_capabilities/github-fetcher (pr-metrics):
 * the aggregation maths (cycle time, time-to-first-review, PR size, by-repo) are
 * lifted verbatim. Rewritten so the pure aggregation (`computeGitHubMetrics`) is
 * separated from the network — the offline path feeds it normalized fixtures and
 * the same function runs live. The original mixed fetch + maths in one function,
 * which made it untestable without a live token.
 */

/** Normalized PR record — what both the fixtures and the live fetcher produce. */
export interface RawPR {
  repo: string;
  number: number;
  author: string;
  createdAt: string;
  mergedAt: string | null;
  additions: number;
  deletions: number;
  /** ISO timestamp of first human review, if any. */
  firstReviewAt?: string | null;
}

const HOUR_MS = 1000 * 60 * 60;
const round1 = (n: number): number => Math.round(n * 10) / 10;

export function emptyGitHubMetrics(): GitHubMetrics {
  return {
    totalMerged: 0,
    avgCycleTimeHours: 0,
    avgTimeToFirstReviewHours: 0,
    avgPRSize: 0,
    byRepo: {},
  };
}

/**
 * Pure aggregation: normalized PRs → metrics. No network, fully testable.
 * `now` is injectable so the offline demo (anchored to the fixtures' `asOf`)
 * is deterministic and never ages out.
 */
export function computeGitHubMetrics(
  prs: RawPR[],
  config: DeliveryConfig,
  now: number = Date.now(),
): GitHubMetrics {
  const since = now - config.periodDays * 24 * HOUR_MS;
  const team = new Set(config.teamMembers.map((m) => m.toLowerCase()));

  const merged = prs.filter((pr) => {
    if (!pr.mergedAt) return false;
    if (new Date(pr.mergedAt).getTime() < since) return false;
    return team.size === 0 || team.has(pr.author.toLowerCase());
  });

  if (merged.length === 0) return emptyGitHubMetrics();

  const byRepo: Record<string, number> = {};
  let totalCycle = 0;
  let totalSize = 0;
  let totalTtfr = 0;
  let reviewed = 0;

  for (const pr of merged) {
    byRepo[pr.repo] = (byRepo[pr.repo] ?? 0) + 1;
    const created = new Date(pr.createdAt).getTime();
    // biome-ignore lint/style/noNonNullAssertion: mergedAt non-null is guaranteed by the filter above.
    totalCycle += (new Date(pr.mergedAt!).getTime() - created) / HOUR_MS;
    totalSize += pr.additions + pr.deletions;
    if (pr.firstReviewAt) {
      totalTtfr += (new Date(pr.firstReviewAt).getTime() - created) / HOUR_MS;
      reviewed++;
    }
  }

  return {
    totalMerged: merged.length,
    avgCycleTimeHours: round1(totalCycle / merged.length),
    avgTimeToFirstReviewHours: reviewed > 0 ? round1(totalTtfr / reviewed) : 0,
    avgPRSize: Math.round(totalSize / merged.length),
    byRepo,
  };
}

export interface GitHubLiveConfig extends DeliveryConfig {
  token: string;
  org?: string;
}

/**
 * Live fetch: pull closed PRs (+ first review) per repo and normalize to RawPR.
 * Not exercised by the offline demo or tests — needs a real GITHUB_TOKEN.
 */
export async function fetchGitHubPRs(
  config: GitHubLiveConfig,
  options: { logger?: ILogger; fetch?: typeof globalThis.fetch } = {},
): Promise<RawPR[]> {
  const { logger } = options;
  if (!config.token) {
    logger?.warn("GitHub token not provided; skipping GitHub source");
    return [];
  }
  const headers = {
    Authorization: `Bearer ${config.token}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "delivery-health-kit",
  };
  const out: RawPR[] = [];

  for (const repoPath of config.repos) {
    const [maybeOrg, maybeRepo] = repoPath.split("/");
    const org = maybeRepo ? maybeOrg : (config.org ?? "unknown");
    const repo = maybeRepo ?? maybeOrg;
    if (!org || !repo) continue;

    const listUrl = `https://api.github.com/repos/${org}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`;
    const res = await fetchWithRetry(listUrl, { headers }, options).catch((e) => {
      logger?.warn(`GitHub list failed for ${repoPath}`, { error: String(e) });
      return null;
    });
    if (!res) continue;

    const prs = (await res.json()) as Array<{
      number: number;
      created_at: string;
      merged_at: string | null;
      user: { login: string };
      additions?: number;
      deletions?: number;
    }>;

    for (const pr of prs) {
      if (!pr.merged_at) continue;
      const reviewsUrl = `https://api.github.com/repos/${org}/${repo}/pulls/${pr.number}/reviews`;
      const rRes = await fetchWithRetry(reviewsUrl, { headers }, options).catch(() => null);
      let firstReviewAt: string | null = null;
      if (rRes) {
        const reviews = (await rRes.json()) as Array<{ submitted_at: string; state: string }>;
        firstReviewAt = reviews.find((r) => r.submitted_at)?.submitted_at ?? null;
      }
      out.push({
        repo,
        number: pr.number,
        author: pr.user.login,
        createdAt: pr.created_at,
        mergedAt: pr.merged_at,
        additions: pr.additions ?? 0,
        deletions: pr.deletions ?? 0,
        firstReviewAt,
      });
    }
  }
  return out;
}
