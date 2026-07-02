import { fetchWithRetry } from "../http.js";
import type { ILogger } from "../logger.js";
import type { PagerDutyMetrics } from "../types.js";
import { timeMetrics } from "./dora.js";

/**
 * PagerDuty incident metrics — team-level only.
 *
 * Harvested from service-health-bot/src/fetchers/pagerduty.ts (the fetch shape,
 * tested there with MSW) + eng-intel-toolkit/pagerduty-fetcher/metrics.ts (the
 * TTD/TTR/TTM percentile maths). Adapted to the dhk pattern: pure compute
 * (`computePagerDutyMetrics`) separated from the live fetch, window driven by
 * `periodDays` instead of a hard-coded 24h, pagination added, and the
 * hard-coded `your-org.pagerduty.com` link host dropped (the API's `html_url`
 * is used instead).
 *
 * On-call load is per service and out-of-hours share — never per responder.
 */

/** Normalized incident — what both the fixtures and the live fetcher produce. */
export interface RawIncident {
  id: string;
  title: string;
  status: "triggered" | "acknowledged" | "resolved";
  createdAt: string;
  acknowledgedAt?: string | null;
  resolvedAt?: string | null;
  urgency: "high" | "low";
  /** Priority name (P1…P5) when the org uses priorities. */
  severity?: string | null;
  service: string;
  htmlUrl?: string;
}

/**
 * Working hours for the out-of-hours share. Org-configurable — defaults are a
 * plain 09:00–17:00 Mon–Fri window in UTC; teams set their own offset.
 */
export interface WorkingHours {
  startHour: number;
  endHour: number;
  /** Offset from UTC in hours (e.g. +2 for CEST). */
  utcOffsetHours: number;
}

export const DEFAULT_WORKING_HOURS: WorkingHours = {
  startHour: 9,
  endHour: 17,
  utcOffsetHours: 0,
};

const MINUTE_MS = 1000 * 60;

export function emptyPagerDutyMetrics(): PagerDutyMetrics {
  return {
    totalIncidents: 0,
    active: 0,
    resolved: 0,
    byUrgency: { high: 0, low: 0 },
    bySeverity: {},
    ttd: { avgMinutes: 0, medianMinutes: 0, p90Minutes: 0 },
    ttm: { avgMinutes: 0, medianMinutes: 0, p90Minutes: 0 },
    onCall: { byService: {}, outOfHoursPct: 0, busiestService: null },
  };
}

function isOutOfHours(iso: string, hours: WorkingHours): boolean {
  const local = new Date(new Date(iso).getTime() + hours.utcOffsetHours * 60 * MINUTE_MS);
  const day = local.getUTCDay();
  if (day === 0 || day === 6) return true;
  const hour = local.getUTCHours();
  return hour < hours.startHour || hour >= hours.endHour;
}

/** Pure computation: normalized incidents → team-level incident metrics. */
export function computePagerDutyMetrics(
  incidents: RawIncident[],
  periodDays: number,
  now: number = Date.now(),
  workingHours: WorkingHours = DEFAULT_WORKING_HOURS,
): PagerDutyMetrics {
  const since = now - periodDays * 24 * 60 * MINUTE_MS;
  const inWindow = incidents.filter((i) => {
    const t = new Date(i.createdAt).getTime();
    return t >= since && t <= now;
  });
  if (inWindow.length === 0) return emptyPagerDutyMetrics();

  const bySeverity: Record<string, number> = {};
  const byService: Record<string, number> = {};
  const ttd: number[] = [];
  const ttm: number[] = [];
  let outOfHours = 0;

  for (const i of inWindow) {
    const severity = i.severity ?? "Unset";
    bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
    byService[i.service] = (byService[i.service] ?? 0) + 1;
    const created = new Date(i.createdAt).getTime();
    if (i.acknowledgedAt) {
      ttd.push((new Date(i.acknowledgedAt).getTime() - created) / MINUTE_MS);
    }
    if (i.resolvedAt) {
      ttm.push((new Date(i.resolvedAt).getTime() - created) / MINUTE_MS);
    }
    if (isOutOfHours(i.createdAt, workingHours)) outOfHours++;
  }

  const busiest = Object.entries(byService).sort((a, b) => b[1] - a[1])[0];

  return {
    totalIncidents: inWindow.length,
    active: inWindow.filter((i) => i.status !== "resolved").length,
    resolved: inWindow.filter((i) => i.status === "resolved").length,
    byUrgency: {
      high: inWindow.filter((i) => i.urgency === "high").length,
      low: inWindow.filter((i) => i.urgency === "low").length,
    },
    bySeverity,
    ttd: timeMetrics(ttd),
    ttm: timeMetrics(ttm),
    onCall: {
      byService,
      outOfHoursPct: Math.round((outOfHours / inWindow.length) * 100),
      busiestService: busiest ? busiest[0] : null,
    },
  };
}

export interface PagerDutyLiveConfig {
  apiKey: string;
  /** Filter to these PagerDuty service IDs (default: all visible). */
  serviceIds?: string[];
  /** API host — override for regional instances (default api.pagerduty.com). */
  apiHost?: string;
  periodDays: number;
}

interface ApiIncident {
  id: string;
  title: string;
  status: "triggered" | "acknowledged" | "resolved";
  created_at: string;
  acknowledged_at?: string | null;
  resolved_at?: string | null;
  urgency: "high" | "low";
  priority?: { name: string } | null;
  html_url?: string;
  service: { id: string; summary: string };
}

/**
 * Live fetch: incidents for the window, paginated, normalized to RawIncident.
 * Not exercised offline — needs a real PAGERDUTY_API_KEY.
 */
export async function fetchPagerDutyIncidents(
  config: PagerDutyLiveConfig,
  options: { logger?: ILogger; fetch?: typeof globalThis.fetch; now?: number } = {},
): Promise<RawIncident[]> {
  const { logger } = options;
  if (!config.apiKey) {
    logger?.warn("PagerDuty API key not provided; skipping PagerDuty source");
    return [];
  }
  const host = config.apiHost ?? "https://api.pagerduty.com";
  const now = options.now ?? Date.now();
  const since = new Date(now - config.periodDays * 24 * 60 * 60 * 1000).toISOString();
  const headers = {
    Authorization: `Token token=${config.apiKey}`,
    Accept: "application/json",
  };

  const out: RawIncident[] = [];
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const url = new URL(`${host}/incidents`);
    url.searchParams.append("since", since);
    url.searchParams.append("limit", String(limit));
    url.searchParams.append("offset", String(offset));
    for (const id of config.serviceIds ?? []) url.searchParams.append("service_ids[]", id);

    const res = await fetchWithRetry(url.toString(), { headers }, options).catch((e) => {
      logger?.warn("PagerDuty fetch failed", { error: String(e) });
      return null;
    });
    if (!res) break;

    const data = (await res.json()) as { incidents?: ApiIncident[]; more?: boolean };
    for (const i of data.incidents ?? []) {
      out.push({
        id: i.id,
        title: i.title,
        status: i.status,
        createdAt: i.created_at,
        acknowledgedAt: i.acknowledged_at ?? null,
        resolvedAt: i.resolved_at ?? null,
        urgency: i.urgency,
        severity: i.priority?.name ?? null,
        service: i.service.summary,
        htmlUrl: i.html_url,
      });
    }
    if (!data.more) break;
  }
  return out;
}
