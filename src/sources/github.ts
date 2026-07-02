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
  /** PR title — used to flag fix/revert deploys for the rework rate. */
  title?: string;
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

/** Max list pages fetched per repo (100 PRs/page) — a runaway-history guard. */
const MAX_LIST_PAGES = 5;

interface ApiListPR {
  number: number;
  title?: string;
  created_at: string;
  merged_at: string | null;
  updated_at?: string;
  user: { login: string };
}

/**
 * Live fetch: pull closed PRs (+ detail + first review) per repo and normalize
 * to RawPR. Paginates the list until it walks past the metric window (list is
 * sorted by `updated` desc, which only ever trails `merged_at`), so busy repos
 * aren't truncated at 100 PRs and quiet ones don't drag in months-old merges —
 * `computeDoraMetrics`/`computeGitHubMetrics` window again exactly by date.
 * The per-PR detail call is what carries `additions`/`deletions` (the list
 * response does not include them). Needs a real GITHUB_TOKEN.
 */
export async function fetchGitHubPRs(
  config: GitHubLiveConfig,
  options: { logger?: ILogger; fetch?: typeof globalThis.fetch; now?: number } = {},
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
  const now = options.now ?? Date.now();
  const since = now - config.periodDays * 24 * 60 * 60 * 1000;
  const out: RawPR[] = [];

  for (const repoPath of config.repos) {
    const [maybeOrg, maybeRepo] = repoPath.split("/");
    const org = maybeRepo ? maybeOrg : (config.org ?? "unknown");
    const repo = maybeRepo ?? maybeOrg;
    if (!org || !repo) continue;

    const candidates: ApiListPR[] = [];
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const listUrl = `https://api.github.com/repos/${org}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`;
      const res = await fetchWithRetry(listUrl, { headers }, options).catch((e) => {
        logger?.warn(`GitHub list failed for ${repoPath}`, { error: String(e) });
        return null;
      });
      if (!res) break;
      const prs = (await res.json()) as ApiListPR[];
      candidates.push(...prs);
      if (prs.length < 100) break;
      // updated_at ≥ merged_at, so once a whole page updated before the window
      // no later page can contain an in-window merge.
      const oldest = prs[prs.length - 1]?.updated_at;
      if (oldest && new Date(oldest).getTime() < since) break;
    }

    for (const pr of candidates) {
      if (!pr.merged_at) continue;
      const mergedAt = new Date(pr.merged_at).getTime();
      if (mergedAt < since || mergedAt > now) continue; // out of window — skip the detail calls

      // Detail call: the only place additions/deletions exist.
      let additions = 0;
      let deletions = 0;
      const dRes = await fetchWithRetry(
        `https://api.github.com/repos/${org}/${repo}/pulls/${pr.number}`,
        { headers },
        options,
      ).catch(() => null);
      if (dRes) {
        const detail = (await dRes.json()) as { additions?: number; deletions?: number };
        additions = detail.additions ?? 0;
        deletions = detail.deletions ?? 0;
      }

      const rRes = await fetchWithRetry(
        `https://api.github.com/repos/${org}/${repo}/pulls/${pr.number}/reviews`,
        { headers },
        options,
      ).catch(() => null);
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
        additions,
        deletions,
        firstReviewAt,
        title: pr.title,
      });
    }
  }
  return out;
}
