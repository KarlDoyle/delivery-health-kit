import { describe, expect, it, vi } from "vitest";
import { createSilentLogger } from "../src/logger.js";
import { fetchBigQueryDeploys } from "../src/sources/bigquery-dora.js";
import {
  computeSloMetrics,
  emptySloMetrics,
  fetchServiceSlo,
} from "../src/sources/prometheus-slo.js";
import {
  computeSentryMetrics,
  emptySentryMetrics,
  fetchSentryIssues,
} from "../src/sources/sentry.js";
import type { ServiceSlo } from "../src/types.js";

const logger = createSilentLogger();

/** A fetch stub that fails the test if it's ever called (proves a skip path). */
const unreachableFetch: typeof globalThis.fetch = async () => {
  throw new Error("fetch should not have been called");
};

describe("bigquery-dora (mocked fetch — no real GCP calls)", () => {
  it("skips without calling fetch when project/auth token are missing", async () => {
    const out = await fetchBigQueryDeploys(
      { projectId: "", authToken: "", periodDays: 14 },
      { logger, fetch: unreachableFetch },
    );
    expect(out).toBeNull();
  });

  it("skips without calling fetch when neither table nor query is configured", async () => {
    const out = await fetchBigQueryDeploys(
      { projectId: "p", authToken: "t", periodDays: 14 },
      { logger, fetch: unreachableFetch },
    );
    expect(out).toBeNull();
  });

  it("parses BigQuery rows into DeployEvents (epoch timestamps, defaults filled in)", async () => {
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      // Default table path builds its own SQL — assert it's actually sent.
      const body = JSON.parse(String(init?.body));
      expect(body.query).toContain("deploys.history");
      return new Response(
        JSON.stringify({
          rows: [
            {
              f: [
                { v: "acme/web" },
                { v: "1782000000" }, // epoch seconds
                { v: "1782003600" },
                { v: "false" },
                { v: null }, // is_fix missing → defaults false
                { v: null }, // service missing → defaults to repo
              ],
            },
          ],
        }),
        { status: 200 },
      );
    };

    const out = await fetchBigQueryDeploys(
      { projectId: "p", authToken: "t", table: "deploys.history", periodDays: 14 },
      { logger, fetch: mockFetch },
    );

    expect(out).toHaveLength(1);
    expect(out?.[0]).toMatchObject({
      repo: "acme/web",
      isRevert: false,
      isFix: false,
      service: "acme/web",
    });
    expect(out?.[0]?.builtAt).toBe(new Date(1782000000 * 1000).toISOString());
  });

  it("uses a custom query verbatim when provided (takes precedence over table)", async () => {
    const customQuery = "SELECT * FROM `custom.deploys`";
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.query).toBe(customQuery);
      return new Response(JSON.stringify({ rows: [] }), { status: 200 });
    };

    const out = await fetchBigQueryDeploys(
      { projectId: "p", authToken: "t", table: "ignored.table", query: customQuery, periodDays: 7 },
      { logger, fetch: mockFetch },
    );
    expect(out).toEqual([]);
  });

  it("accepts ISO-formatted timestamps as well as epoch seconds", async () => {
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          rows: [
            {
              f: [
                { v: "acme/web" },
                { v: "2026-06-20T09:00:00.000Z" },
                { v: "2026-06-20T11:00:00.000Z" },
                { v: "true" },
                { v: "true" },
                { v: "custom-service" },
              ],
            },
          ],
        }),
        { status: 200 },
      );

    const out = await fetchBigQueryDeploys(
      { projectId: "p", authToken: "t", table: "t", periodDays: 14 },
      { logger, fetch: mockFetch },
    );
    expect(out?.[0]).toMatchObject({
      builtAt: "2026-06-20T09:00:00.000Z",
      isRevert: true,
      isFix: true,
      service: "custom-service",
    });
  });

  it("skips rows missing required fields (repo/built_at/deployed_at)", async () => {
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          rows: [
            { f: [{ v: null }, { v: "1782000000" }, { v: "1782003600" }, { v: "false" }] },
            { f: [{ v: "acme/web" }, { v: null }, { v: "1782003600" }, { v: "false" }] },
          ],
        }),
        { status: 200 },
      );

    const out = await fetchBigQueryDeploys(
      { projectId: "p", authToken: "t", table: "t", periodDays: 14 },
      { logger, fetch: mockFetch },
    );
    expect(out).toEqual([]);
  });

  it("returns null and logs a warning when the network call fails", async () => {
    const warn = vi.fn();
    const failingFetch: typeof globalThis.fetch = async () => {
      throw new Error("ECONNRESET");
    };
    const out = await fetchBigQueryDeploys(
      { projectId: "p", authToken: "t", table: "t", periodDays: 14 },
      { logger: { ...logger, warn }, fetch: failingFetch },
    );
    expect(out).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("follows BigQuery page tokens and combines every result page", async () => {
    const seen: string[] = [];
    const mockFetch: typeof globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      seen.push(url.toString());
      if (url.searchParams.has("pageToken")) {
        return new Response(JSON.stringify({ rows: [{ f: [{ v: "acme/api" }, { v: "1782000000" }, { v: "1782003600" }, { v: "false" }] }] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        jobComplete: true,
        jobReference: { jobId: "job-1", location: "EU" },
        pageToken: "page-2",
        rows: [{ f: [{ v: "acme/web" }, { v: "1782000000" }, { v: "1782003600" }, { v: "false" }] }],
      }), { status: 200 });
    };
    const out = await fetchBigQueryDeploys(
      { projectId: "p", authToken: "t", table: "deploys.history", periodDays: 14 },
      { logger, fetch: mockFetch },
    );
    expect(out).toHaveLength(2);
    expect(out?.map((deploy) => deploy.repo)).toEqual(["acme/web", "acme/api"]);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("pageToken=page-2");
    expect(seen[1]).toContain("location=EU");
  });

  it("returns null for a BigQuery API error even when HTTP status is 200", async () => {
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: "access denied" } }), { status: 200 });
    const out = await fetchBigQueryDeploys(
      { projectId: "p", authToken: "t", table: "deploys.history", periodDays: 14 },
      { logger, fetch: mockFetch },
    );
    expect(out).toBeNull();
  });
});

describe("sentry (mocked fetch — no real Sentry API calls)", () => {
  it("emptySentryMetrics has the zeroed shape", () => {
    expect(emptySentryMetrics()).toEqual({
      totalIssues: 0,
      newIssues: 0,
      byProject: {},
      byLevel: { error: 0, warning: 0, info: 0 },
    });
  });

  it("computeSentryMetrics returns empty metrics when every issue is outside the window", () => {
    const m = computeSentryMetrics(
      [
        {
          id: "1",
          title: "old",
          count: 5,
          userCount: 1,
          firstSeen: "2026-01-01T00:00:00Z",
          lastSeen: "2026-01-01T00:00:00Z",
          level: "error",
          project: "web",
        },
      ],
      14,
      Date.parse("2026-06-29T12:00:00Z"),
    );
    expect(m).toEqual(emptySentryMetrics());
  });

  it("skips without calling fetch when org/auth token are missing", async () => {
    const out = await fetchSentryIssues(
      { org: "", authToken: "", periodDays: 14 },
      { logger, fetch: unreachableFetch },
    );
    expect(out).toEqual([]);
  });

  it("normalizes a single page of issues", async () => {
    const mockFetch: typeof globalThis.fetch = async (input) => {
      expect(String(input)).toContain("sentry.io/api/0/organizations/acme/issues/");
      return new Response(
        JSON.stringify([
          {
            id: "1",
            title: "TypeError",
            count: "42",
            userCount: 3,
            firstSeen: "2026-06-20T00:00:00Z",
            lastSeen: "2026-06-25T00:00:00Z",
            level: "error",
            project: { name: "web" },
          },
        ]),
        { status: 200 },
      );
    };

    const out = await fetchSentryIssues(
      { org: "acme", authToken: "t", periodDays: 14 },
      { logger, fetch: mockFetch },
    );
    expect(out).toEqual([
      {
        id: "1",
        title: "TypeError",
        count: 42,
        userCount: 3,
        firstSeen: "2026-06-20T00:00:00Z",
        lastSeen: "2026-06-25T00:00:00Z",
        level: "error",
        project: "web",
      },
    ]);
  });

  it("follows a rel=next Link-header cursor and stops when the header is absent", async () => {
    let calls = 0;
    const mockFetch: typeof globalThis.fetch = async (input) => {
      calls++;
      const url = String(input);
      if (
        url.startsWith("https://sentry.io/api/0/organizations/acme/issues/?") &&
        url.includes("cursor=next-page")
      ) {
        return new Response(
          JSON.stringify([
            {
              id: "2",
              title: "second page",
              count: 1,
              userCount: 1,
              firstSeen: "2026-06-21T00:00:00Z",
              lastSeen: "2026-06-21T00:00:00Z",
              level: "warning",
              project: { name: "api" },
            },
          ]),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          link: '<https://sentry.io/api/0/organizations/acme/issues/?cursor=next-page>; rel="next"; results="true"',
        },
      });
    };

    const out = await fetchSentryIssues(
      { org: "acme", authToken: "t", periodDays: 14 },
      { logger, fetch: mockFetch },
    );
    expect(calls).toBe(2);
    expect(out).toHaveLength(1);
    expect(out?.[0]?.project).toBe("api");
  });

  it('ignores a Link header that lacks results="true" (treats it as no next page)', async () => {
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { link: '<https://sentry.io/next-page>; rel="next"' },
      });
    const out = await fetchSentryIssues(
      { org: "acme", authToken: "t", periodDays: 14 },
      { logger, fetch: mockFetch },
    );
    expect(out).toEqual([]);
  });

  it("returns whatever was collected so far and logs a warning on network failure", async () => {
    const warn = vi.fn();
    const failingFetch: typeof globalThis.fetch = async () => {
      throw new Error("network down");
    };
    const out = await fetchSentryIssues(
      { org: "acme", authToken: "t", periodDays: 14 },
      { logger: { ...logger, warn }, fetch: failingFetch },
    );
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

describe("prometheus-slo (mocked fetch — no real Prometheus/GCP calls)", () => {
  it("emptySloMetrics has the zeroed shape", () => {
    expect(emptySloMetrics()).toEqual({ services: [], attainmentPct: 0 });
  });

  it("computeSloMetrics excludes no-data services from the attainment maths", () => {
    const web: ServiceSlo = {
      name: "web",
      availabilityPct: 99.99,
      availabilityTargetPct: 99.9,
      meetingAvailability: true,
      p95Ms: 100,
      p99Ms: 200,
      latencyThresholdMs: 500,
      meetingLatency: true,
      totalRequests: 1000,
      failedRequests: 1,
    };
    const worker: ServiceSlo = {
      name: "worker",
      availabilityPct: 0,
      availabilityTargetPct: 99.9,
      meetingAvailability: false,
      p95Ms: 0,
      p99Ms: 0,
      latencyThresholdMs: 500,
      meetingLatency: false,
      totalRequests: 0,
      failedRequests: 0,
      noData: true,
    };
    expect(computeSloMetrics([web, worker]).attainmentPct).toBe(100); // only "web" is measurable

    // Every service is no-data → the 0-of-0 edge case, not a NaN.
    expect(computeSloMetrics([worker])).toEqual({ services: [worker], attainmentPct: 0 });

    expect(computeSloMetrics([])).toEqual(emptySloMetrics());
  });

  it("computes availability/latency attainment from Prometheus scalar queries", async () => {
    const mockFetch: typeof globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      const query = url.searchParams.get("query") ?? "";
      let value = 0;
      if (query.startsWith("histogram_quantile(0.95")) value = 120;
      else if (query.startsWith("histogram_quantile(0.99")) value = 250;
      else if (query.includes("status=~") || query.includes("code=~"))
        value = 2; // error-rate/error-count queries
      else if (query.includes("increase("))
        value = 100000; // total count
      else value = 5000; // total rate

      return new Response(
        JSON.stringify({ status: "success", data: { result: [{ value: [0, String(value)] }] } }),
        { status: 200 },
      );
    };

    const result = await fetchServiceSlo(
      { queryUrl: "https://prom.example.com/api/v1/query", authToken: "t" },
      {
        name: "web",
        selector: 'namespace="web", env="prod"',
        availabilityTargetPct: 99,
        latencyThresholdMs: 500,
      },
      { logger, fetch: mockFetch },
    );

    expect(result.name).toBe("web");
    expect(result.noData).toBe(false);
    expect(result.p95Ms).toBe(120);
    expect(result.p99Ms).toBe(250);
    expect(result.meetingLatency).toBe(true); // 120 < 500
    expect(result.meetingAvailability).toBe(true); // (5000-2)/5000 ≈ 99.96 >= 99
    expect(result.totalRequests).toBe(100000);
  });

  it("marks noData when every scalar query comes back empty (endpoint unreachable)", async () => {
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ status: "success", data: {} }), { status: 200 });

    const result = await fetchServiceSlo(
      { queryUrl: "https://prom.example.com/api/v1/query" },
      {
        name: "worker",
        selector: 'job="worker"',
        availabilityTargetPct: 99,
        latencyThresholdMs: 500,
      },
      { logger, fetch: mockFetch },
    );

    expect(result.noData).toBe(true);
    expect(result.availabilityPct).toBe(0);
    expect(result.meetingAvailability).toBe(false);
    expect(result.meetingLatency).toBe(false);
  });

  it("uses the prometheus-http preset's metric names and an exclude-selector fragment", async () => {
    const seenQueries: string[] = [];
    const mockFetch: typeof globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      seenQueries.push(url.searchParams.get("query") ?? "");
      return new Response(
        JSON.stringify({ status: "success", data: { result: [{ value: [0, "0"] }] } }),
        { status: 200 },
      );
    };

    await fetchServiceSlo(
      { queryUrl: "https://prom.example.com/api/v1/query" },
      {
        name: "api",
        selector: 'job="api"',
        excludeSelector: 'path!~"/health"',
        availabilityTargetPct: 99,
        latencyThresholdMs: 500,
        preset: "prometheus-http",
      },
      { logger, fetch: mockFetch },
    );

    expect(seenQueries.some((q) => q.includes("http_request_duration_seconds_bucket"))).toBe(true);
    expect(seenQueries.some((q) => q.includes('path!~"/health"'))).toBe(true);
  });

  it("marks noData and does not pass availability when the error-rate query fails", async () => {
    const mockFetch: typeof globalThis.fetch = async (input) => {
      const query = new URL(String(input)).searchParams.get("query") ?? "";
      if (query.includes('status=~"5.."')) return new Response("unavailable", { status: 503 });
      const value = query.startsWith("histogram_quantile(0.95")
        ? "120"
        : query.startsWith("histogram_quantile(0.99")
          ? "250"
          : query.includes("increase(")
            ? "1000"
            : "100";
      return new Response(
        JSON.stringify({ status: "success", data: { result: [{ value: [0, value] }] } }),
        { status: 200 },
      );
    };
    const result = await fetchServiceSlo(
      { queryUrl: "https://prom.example.com/api/v1/query" },
      { name: "web", selector: 'job="web"', availabilityTargetPct: 99, latencyThresholdMs: 500 },
      { logger, fetch: mockFetch },
    );
    expect(result.noData).toBe(true);
    expect(result.availabilityPct).toBe(0);
    expect(result.meetingAvailability).toBe(false);
  });

  it("marks noData when Prometheus returns an API-level query error", async () => {
    const mockFetch: typeof globalThis.fetch = async (input) => {
      const query = new URL(String(input)).searchParams.get("query") ?? "";
      if (query.includes('status=~"5.."')) {
        return new Response(
          JSON.stringify({ status: "error", errorType: "bad_data", error: "invalid query" }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ status: "success", data: { result: [{ value: [0, "100"] }] } }),
        { status: 200 },
      );
    };
    const result = await fetchServiceSlo(
      { queryUrl: "https://prom.example.com/api/v1/query" },
      { name: "web", selector: 'job="web"', availabilityTargetPct: 99, latencyThresholdMs: 500 },
      { logger, fetch: mockFetch },
    );
    expect(result.noData).toBe(true);
    expect(result.meetingAvailability).toBe(false);
  });

  it("treats malformed scalar values as unavailable data", async () => {
    const mockFetch: typeof globalThis.fetch = async (input) => {
      const query = new URL(String(input)).searchParams.get("query") ?? "";
      const value = query.includes('status=~"5.."')
        ? "NaN"
        : query.startsWith("histogram_quantile(0.95")
          ? "120"
          : query.startsWith("histogram_quantile(0.99")
            ? "250"
            : "100";
      return new Response(
        JSON.stringify({ status: "success", data: { result: [{ value: [0, value] }] } }),
        { status: 200 },
      );
    };
    const result = await fetchServiceSlo(
      { queryUrl: "https://prom.example.com/api/v1/query" },
      { name: "web", selector: 'job="web"', availabilityTargetPct: 99, latencyThresholdMs: 500 },
      { logger, fetch: mockFetch },
    );
    expect(result.noData).toBe(true);
    expect(result.meetingAvailability).toBe(false);
  });

  it("treats empty error-series as zero errors while preserving valid availability", async () => {
    const mockFetch: typeof globalThis.fetch = async (input) => {
      const query = new URL(String(input)).searchParams.get("query") ?? "";
      if (query.includes('status=~"5.."')) {
        return new Response(JSON.stringify({ status: "success", data: { result: [] } }), {
          status: 200,
        });
      }
      const value = query.startsWith("histogram_quantile(0.95")
        ? "120"
        : query.startsWith("histogram_quantile(0.99")
          ? "250"
          : query.includes("increase(")
            ? "1000"
            : "100";
      return new Response(
        JSON.stringify({ status: "success", data: { result: [{ value: [0, value] }] } }),
        { status: 200 },
      );
    };
    const result = await fetchServiceSlo(
      { queryUrl: "https://prom.example.com/api/v1/query" },
      { name: "web", selector: 'job="web"', availabilityTargetPct: 99, latencyThresholdMs: 500 },
      { logger, fetch: mockFetch },
    );
    expect(result.noData).toBe(false);
    expect(result.failedRequests).toBe(0);
    expect(result.availabilityPct).toBe(100);
    expect(result.meetingAvailability).toBe(true);
  });

  it("marks noData and logs a warning when the fetch rejects", async () => {
    const warn = vi.fn();
    const failingFetch: typeof globalThis.fetch = async () => {
      throw new Error("timeout");
    };
    const result = await fetchServiceSlo(
      { queryUrl: "https://prom.example.com/api/v1/query" },
      { name: "web", selector: 'job="web"', availabilityTargetPct: 99, latencyThresholdMs: 500 },
      { logger: { ...logger, warn }, fetch: failingFetch },
    );
    expect(result.noData).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});
