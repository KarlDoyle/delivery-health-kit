import type { SupportMetrics } from "../types.js";

/**
 * Slack support-channel intelligence.
 *
 * Rewritten in TypeScript from Projects/slack-support-intel.py — the Python tool
 * scanned a support channel, classified requester role, measured first-response
 * time / resolution, then aggregated per-day CSVs. This keeps the same team-level
 * metrics (no individual performance reporting) and target thresholds, but works
 * on normalized thread records so it composes into the one report and is fully
 * offline-testable. The live Slack scan (conversations.history/replies) is the
 * documented live path.
 */

/** Median first-response target, in minutes (from the legacy tool). */
export const TARGET_MEDIAN_FRT_MIN = 60;
/** Resolution-rate target (0..1). */
export const TARGET_RESOLUTION_RATE = 0.8;
/** A first response slower than this is "late" (4h). */
export const LATE_RESPONSE_THRESHOLD_MIN = 240;

export type ResolutionStatus = "Resolved" | "Unanswered" | "Open";

export interface SupportThread {
  requesterRole: string;
  /** Minutes to first team reply; null if never answered. */
  firstResponseMinutes: number | null;
  resolutionStatus: ResolutionStatus;
  tags: string[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const m =
    sorted.length % 2 === 0
      ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
      : (sorted[mid] ?? 0);
  return Math.round(m * 10) / 10;
}

export function emptySupportMetrics(): SupportMetrics {
  return {
    totalRequests: 0,
    medianFirstResponseMinutes: null,
    resolutionRatePct: 0,
    unansweredCount: 0,
    lateResponseCount: 0,
    requesterMix: {},
    topThemes: [],
    targets: {
      medianFrtMinutes: TARGET_MEDIAN_FRT_MIN,
      resolutionRatePct: TARGET_RESOLUTION_RATE * 100,
    },
  };
}

/** Pure computation: normalized support threads → support metrics. */
export function computeSupportMetrics(threads: SupportThread[]): SupportMetrics {
  if (threads.length === 0) return emptySupportMetrics();

  const total = threads.length;
  const frts = threads.map((t) => t.firstResponseMinutes).filter((v): v is number => v !== null);
  const resolved = threads.filter((t) => t.resolutionStatus === "Resolved").length;
  const unanswered = threads.filter((t) => t.resolutionStatus === "Unanswered").length;
  const late = frts.filter((v) => v > LATE_RESPONSE_THRESHOLD_MIN).length;

  const requesterMix: Record<string, number> = {};
  const themeCounts: Record<string, number> = {};
  for (const t of threads) {
    const role = t.requesterRole || "Unknown";
    requesterMix[role] = (requesterMix[role] ?? 0) + 1;
    for (const tag of t.tags) {
      const k = tag.trim();
      if (k) themeCounts[k] = (themeCounts[k] ?? 0) + 1;
    }
  }

  const topThemes = Object.entries(themeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([theme, count]) => ({ theme, count }));

  return {
    totalRequests: total,
    medianFirstResponseMinutes: median(frts),
    resolutionRatePct: Math.round((resolved / total) * 100),
    unansweredCount: unanswered,
    lateResponseCount: late,
    requesterMix,
    topThemes,
    targets: {
      medianFrtMinutes: TARGET_MEDIAN_FRT_MIN,
      resolutionRatePct: TARGET_RESOLUTION_RATE * 100,
    },
  };
}
