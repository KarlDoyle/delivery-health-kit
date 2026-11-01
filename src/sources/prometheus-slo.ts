import { fetchWithRetry } from "../http.js";
import type { ILogger } from "../logger.js";
import type { ServiceSlo, SloMetrics } from "../types.js";

/**
 * SLO attainment from Prometheus (or any PromQL-compatible endpoint).
 *
 * Harvested from eng-intel-toolkit/prometheus-slo. Reshaped hard around the
 * adapter principle: the original was welded to one org's stack (GCP Managed
 * Prometheus URL, Micrometer `http_server_requests_seconds` metric names,
 * `env="prod"` labels, company URL paths in the exclusion default). All of
 * that is now explicit config — a named preset covers the common
 * Spring/Micrometer shape, and any org supplies its own metric + selector.
 */

export interface PrometheusConfig {
  /**
   * Base URL of the PromQL query API, e.g.
   * `https://prometheus.example.com/api/v1/query` or the GCP Managed
   * Prometheus form
   * `https://monitoring.googleapis.com/v1/projects/<p>/location/global/prometheus/api/v1/query`.
   */
  queryUrl: string;
  authToken?: string;
}

/** Metric-shape presets: how request-rate/latency series are named + labelled. */
export type MetricPreset = "micrometer" | "prometheus-http";

interface PresetShape {
  histogramBucket: string;
  requestCount: string;
  statusLabel: string;
}

const PRESETS: Record<MetricPreset, PresetShape> = {
  // Spring Boot / Micrometer convention.
  micrometer: {
    histogramBucket: "http_server_requests_seconds_bucket",
    requestCount: "http_server_requests_seconds_count",
    statusLabel: "status",
  },
  // prometheus client_golang / promhttp convention.
  "prometheus-http": {
    histogramBucket: "http_request_duration_seconds_bucket",
    requestCount: "http_requests_total",
    statusLabel: "code",
  },
};

export interface SloServiceConfig {
  name: string;
  /**
   * Raw PromQL label selector for this service, e.g.
   * `namespace="checkout", env="prod"`. The org's own labelling — never assumed.
   */
  selector: string;
  availabilityTargetPct: number;
  latencyThresholdMs: number;
  /** Metric naming preset (default micrometer); or override the names below. */
  preset?: MetricPreset;
  histogramBucket?: string;
  requestCount?: string;
  statusLabel?: string;
  /** Optional label selector fragment excluding known-slow endpoints. */
  excludeSelector?: string;
}

export function emptySloMetrics(): SloMetrics {
  return { services: [], attainmentPct: 0 };
}

/** Pure computation: per-service SLO results → the attainment roll-up.
 * No-data services are listed but excluded from the attainment maths. */
export function computeSloMetrics(services: ServiceSlo[]): SloMetrics {
  if (services.length === 0) return emptySloMetrics();
  const measurable = services.filter((s) => !s.noData);
  if (measurable.length === 0) return { services, attainmentPct: 0 };
  const meeting = measurable.filter((s) => s.meetingAvailability && s.meetingLatency).length;
  return {
    services,
    attainmentPct: Math.round((meeting / measurable.length) * 100),
  };
}

interface PromResult {
  status: string;
  data?: { result?: Array<{ value?: [number, string] }> };
}

async function queryScalar(
  config: PrometheusConfig,
  query: string,
  options: { logger?: ILogger; fetch?: typeof globalThis.fetch },
  allowEmptyResult = false,
): Promise<number | null> {
  const url = new URL(config.queryUrl);
  url.searchParams.append("query", query);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.authToken) headers.Authorization = `Bearer ${config.authToken}`;

  try {
    const res = await fetchWithRetry(url.toString(), { headers }, options);
    const data = (await res.json()) as PromResult;
    if (data.status !== "success" || !Array.isArray(data.data?.result)) {
      throw new Error("Prometheus returned an unsuccessful or malformed query response");
    }
    const value = data.data.result[0]?.value?.[1];
    if (value === undefined) {
      if (allowEmptyResult && data.data.result.length === 0) return 0;
      throw new Error("Prometheus query returned no scalar result");
    }
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) throw new Error("Prometheus query returned a non-finite scalar");
    return parsed;
  } catch (error) {
    options.logger?.warn("Prometheus query failed", { error: String(error) });
    return null;
  }
}

/**
 * Live fetch: one service's SLO position from PromQL queries built off the
 * configured metric shape. Not exercised offline — needs a reachable endpoint.
 */
export async function fetchServiceSlo(
  config: PrometheusConfig,
  service: SloServiceConfig,
  options: { logger?: ILogger; fetch?: typeof globalThis.fetch } = {},
): Promise<ServiceSlo> {
  const shape = PRESETS[service.preset ?? "micrometer"];
  const bucket = service.histogramBucket ?? shape.histogramBucket;
  const count = service.requestCount ?? shape.requestCount;
  const statusLabel = service.statusLabel ?? shape.statusLabel;
  const exclude = service.excludeSelector ? `, ${service.excludeSelector}` : "";
  const sel = `${service.selector}${exclude}`;

  const p95Query = `histogram_quantile(0.95, sum by (le) (rate(${bucket}{${sel}}[5m]))) * 1000`;
  const p99Query = `histogram_quantile(0.99, sum by (le) (rate(${bucket}{${sel}}[5m]))) * 1000`;
  const totalQuery = `sum(rate(${count}{${service.selector}}[1h]))`;
  const errorQuery = `sum(rate(${count}{${service.selector}, ${statusLabel}=~"5.."}[1h]))`;
  const totalCountQuery = `sum(increase(${count}{${service.selector}}[24h]))`;
  const errorCountQuery = `sum(increase(${count}{${service.selector}, ${statusLabel}=~"5.."}[24h]))`;

  const [
    p95Result,
    p99Result,
    totalRateResult,
    errorRateResult,
    totalRequestsResult,
    failedRequestsResult,
  ] = await Promise.all([
    queryScalar(config, p95Query, options),
    queryScalar(config, p99Query, options),
    queryScalar(config, totalQuery, options),
    queryScalar(config, errorQuery, options, true),
    queryScalar(config, totalCountQuery, options),
    queryScalar(config, errorCountQuery, options, true),
  ]);

  // An empty error-series is a valid zero. A failed/malformed query is null
  // and must never be converted into a healthy-looking zero-error result.
  const noData =
    p95Result === null ||
    p99Result === null ||
    totalRateResult === null ||
    errorRateResult === null ||
    totalRequestsResult === null ||
    failedRequestsResult === null ||
    totalRateResult <= 0;

  const p95Ms = p95Result ?? 0;
  const p99Ms = p99Result ?? 0;
  const totalRate = totalRateResult ?? 0;
  const errorRate = errorRateResult ?? 0;
  const totalRequests = totalRequestsResult ?? 0;
  const failedRequests = failedRequestsResult ?? 0;
  const availabilityPct = !noData ? ((totalRate - errorRate) / totalRate) * 100 : 0;
  const round2 = (n: number): number => Math.round(n * 100) / 100;

  return {
    name: service.name,
    availabilityPct: noData ? 0 : round2(availabilityPct),
    availabilityTargetPct: service.availabilityTargetPct,
    meetingAvailability: !noData && availabilityPct >= service.availabilityTargetPct,
    p95Ms: round2(p95Ms),
    p99Ms: round2(p99Ms),
    latencyThresholdMs: service.latencyThresholdMs,
    meetingLatency: !noData && p95Ms > 0 && p95Ms < service.latencyThresholdMs,
    totalRequests: Math.round(totalRequests),
    failedRequests: Math.round(failedRequests),
    noData,
  };
}
