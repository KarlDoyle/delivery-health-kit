import { describe, expect, it } from "vitest";
import { runDigest } from "../src/cli.js";
import { assembleDigest } from "../src/report/assemble.js";
import { renderDigestMarkdown } from "../src/report/markdown.js";
import { renderDigestSlack } from "../src/report/slack.js";
import { loadDigestFixtures } from "../src/sources/fixtures.js";
import { computePagerDutyMetrics } from "../src/sources/pagerduty.js";
import { computeSloMetrics } from "../src/sources/prometheus-slo.js";
import { computeSentryMetrics } from "../src/sources/sentry.js";

const NOW = Date.parse("2026-06-29T12:00:00Z");

async function buildOfflineDigest() {
  const fx = await loadDigestFixtures();
  return assembleDigest({
    config: fx.config,
    mode: "offline",
    now: Date.parse(fx.config.asOf),
    incidents: fx.incidents,
    sentryIssues: fx.sentryIssues,
    slo: fx.slo,
    deploys: fx.deploys,
  });
}

describe("pagerduty compute (hand-checked against fixtures)", () => {
  it("windows, counts and aggregates team-level incident metrics", async () => {
    const fx = await loadDigestFixtures();
    const m = computePagerDutyMetrics(fx.incidents, 14, NOW);

    // 7 fixture incidents, INC-0 (2026-06-01) out of the 14-day window.
    expect(m.totalIncidents).toBe(6);
    expect(m.active).toBe(1); // INC-6 still triggered
    expect(m.resolved).toBe(5);
    expect(m.byUrgency).toEqual({ high: 3, low: 3 });
    expect(m.bySeverity).toEqual({ P1: 2, P2: 1, P3: 1, P4: 1, Unset: 1 });

    // TTD (create→ack) minutes: [10, 20, 30, 5, 15] → avg 16, median 15, p90 30.
    expect(m.ttd).toEqual({ avgMinutes: 16, medianMinutes: 15, p90Minutes: 30 });
    // TTM (create→resolve) minutes: [60, 120, 120, 30, 60] → avg 78, median 60, p90 120.
    expect(m.ttm).toEqual({ avgMinutes: 78, medianMinutes: 60, p90Minutes: 120 });

    // On-call load, team-level: web 4 / api 2; 4 of 6 out of hours (Sun/Sat/evening).
    expect(m.onCall.byService).toEqual({ web: 4, api: 2 });
    expect(m.onCall.busiestService).toBe("web");
    expect(m.onCall.outOfHoursPct).toBe(67);
  });

  it("returns empty metrics when nothing is in the window", async () => {
    const fx = await loadDigestFixtures();
    const m = computePagerDutyMetrics(fx.incidents, 14, Date.parse("2027-01-01T00:00:00Z"));
    expect(m.totalIncidents).toBe(0);
    expect(m.onCall.busiestService).toBeNull();
  });
});

describe("sentry compute (hand-checked against fixtures)", () => {
  it("windows on lastSeen and counts new issues by firstSeen", async () => {
    const fx = await loadDigestFixtures();
    const m = computeSentryMetrics(fx.sentryIssues, 14, NOW);

    // 5 fixture issues, S5 (lastSeen 2026-06-10) out of window.
    expect(m.totalIssues).toBe(4);
    expect(m.newIssues).toBe(2); // S1 + S3 firstSeen inside the window
    expect(m.byProject).toEqual({ frontend: 2, backend: 2 });
    expect(m.byLevel).toEqual({ error: 2, warning: 1, info: 1 });
  });
});

describe("slo compute (hand-checked against fixtures)", () => {
  it("rolls per-service positions into attainment", async () => {
    const fx = await loadDigestFixtures();
    const m = computeSloMetrics(fx.slo);
    // web meets both; api misses availability; worker misses latency → 1/3.
    expect(m.services).toHaveLength(3);
    expect(m.attainmentPct).toBe(33);
  });
});

describe("digest assembly (end-to-end from fixtures)", () => {
  it("upgrades DORA to the incident-linked CFR and includes recovery time", async () => {
    const digest = await buildOfflineDigest();

    expect(digest.dora?.cfrBasis).toBe("incident-linked");
    // Failed deploys: 2 reverts ∪ the api deploy followed ≤24h by INC-2 = 3 of 14.
    expect(digest.dora?.changeFailureRatePct).toBe(21.4);
    // Rework: 2 reverts + 1 flagged fix deploy = 3 of 14.
    expect(digest.dora?.reworkRatePct).toBe(21.4);
    // Recovery (create→resolve, in-window resolved incidents): median 60, p90 120.
    expect(digest.dora?.recoveryTime).toEqual({ medianMinutes: 60, p90Minutes: 120 });
  });

  it("assembles all reliability blocks", async () => {
    const digest = await buildOfflineDigest();
    expect(digest.incidents).toBeDefined();
    expect(digest.errors).toBeDefined();
    expect(digest.slo).toBeDefined();
    expect(digest.team).toBe("Team Atlas");
  });
});

describe("digest renderers", () => {
  it("renders markdown with all sections and the badge", async () => {
    const md = renderDigestMarkdown(await buildOfflineDigest());
    expect(md).toContain("# Reliability Digest — Team Atlas");
    expect(md).toContain("## Incidents");
    expect(md).toContain("## Errors (error budget)");
    expect(md).toContain("## SLOs");
    expect(md).toContain("team-level only · your data stays on your machine");
    expect(md).toContain("incident-linked");
    // On-call is per service / out-of-hours — never per person.
    expect(md).toContain("On-call load (team-level)");
  });

  it("is deterministic", async () => {
    const a = renderDigestMarkdown(await buildOfflineDigest());
    const b = renderDigestMarkdown(await buildOfflineDigest());
    expect(a).toBe(b);
  });

  it("renders Slack Block Kit blocks", async () => {
    const blocks = renderDigestSlack(await buildOfflineDigest());
    expect(blocks[0]).toMatchObject({ type: "header" });
    expect(blocks.some((b) => JSON.stringify(b).includes("Incidents"))).toBe(true);
    expect(blocks.some((b) => JSON.stringify(b).includes("SLOs"))).toBe(true);
  });
});

describe("cli runDigest (offline)", () => {
  it("produces a markdown digest string", async () => {
    const out = await runDigest({ offline: true, quiet: true });
    expect(out).toContain("# Reliability Digest — Team Atlas");
  });

  it("produces slack JSON when format=slack", async () => {
    const out = await runDigest({ offline: true, quiet: true, format: "slack" });
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
  });
});
