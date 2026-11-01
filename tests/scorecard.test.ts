import { describe, expect, it } from "vitest";
import type { AssembleInput } from "../src/report/assemble.js";
import { renderScorecardMarkdown } from "../src/report/markdown.js";
import { assembleScorecard, scoreReport } from "../src/report/scorecard.js";
import { TARGET_MEDIAN_FRT_MIN, TARGET_RESOLUTION_RATE } from "../src/sources/support.js";
import type { DeliveryReport } from "../src/types.js";

const NOW = Date.parse("2026-06-29T12:00:00Z");

/** A single-PR site whose only scored dimension is PR flow (cycle time). */
function prFlowSite(team: string, cycleHours: number): AssembleInput {
  const createdAt = "2026-06-25T00:00:00Z";
  const mergedAt = new Date(Date.parse(createdAt) + cycleHours * 3_600_000).toISOString();
  return {
    config: { team, periodDays: 14, repos: ["x"], teamMembers: ["a"] },
    mode: "offline",
    now: NOW,
    prs: [{ repo: "x", number: 1, author: "a", createdAt, mergedAt, additions: 10, deletions: 0 }],
  };
}

function healthyReport(): DeliveryReport {
  return {
    generatedAt: "2026-06-29T12:00:00Z",
    team: "Healthy",
    periodDays: 14,
    mode: "offline",
    dora: {
      deploymentFrequencyPerDay: 1,
      leadTimeHours: 2,
      changeFailureRatePct: 0,
      cfrBasis: "revert-proxy",
      reworkRatePct: 0,
      totalDeploys: 14,
      totalReverts: 0,
      totalFixDeploys: 0,
      periodDays: 14,
      classes: { deploymentFrequency: "Elite", leadTime: "Elite", changeFailureRate: "Elite" },
    },
    github: {
      totalMerged: 3,
      avgCycleTimeHours: 5,
      avgTimeToFirstReviewHours: 1,
      avgPRSize: 50,
      byRepo: { web: 3 },
    },
    support: {
      totalRequests: 4,
      medianFirstResponseMinutes: 10,
      resolutionRatePct: 100,
      unansweredCount: 0,
      lateResponseCount: 0,
      requesterMix: {},
      topThemes: [],
      targets: {
        medianFrtMinutes: TARGET_MEDIAN_FRT_MIN,
        resolutionRatePct: TARGET_RESOLUTION_RATE * 100,
      },
    },
  };
}

describe("scoreReport", () => {
  it("scores a healthy report near the top and includes all three dimensions", () => {
    const { score, parts } = scoreReport(healthyReport());
    expect(score).toBeGreaterThanOrEqual(95);
    expect(parts).toHaveProperty("dora");
    expect(parts).toHaveProperty("prFlow");
    expect(parts).toHaveProperty("support");
  });

  it("excludes DORA when the deployment window has no data", () => {
    const r = healthyReport();
    const dora = r.dora;
    if (!dora) throw new Error("Expected DORA metrics in healthy report");
    r.dora = { ...dora, noData: true, totalDeploys: 0 };
    const { parts } = scoreReport(r);
    expect(parts).not.toHaveProperty("dora");
    expect(parts).toHaveProperty("prFlow");
    expect(parts).toHaveProperty("support");
  });

  it("only scores the dimensions that have data", () => {
    const r = healthyReport();
    r.dora = undefined;
    r.support = undefined;
    const { parts } = scoreReport(r);
    expect(Object.keys(parts)).toEqual(["prFlow"]);
  });

  it("a slow cycle time scores lower than a fast one", () => {
    const fast = scoreReport({ ...healthyReport(), dora: undefined, support: undefined }).score;
    const slowReport = healthyReport();
    slowReport.dora = undefined;
    slowReport.support = undefined;
    slowReport.github = {
      totalMerged: 3,
      avgCycleTimeHours: 60,
      avgTimeToFirstReviewHours: 1,
      avgPRSize: 50,
      byRepo: { web: 3 },
    };
    expect(scoreReport(slowReport).score).toBeLessThan(fast);
  });
});

describe("assembleScorecard", () => {
  it("ranks sites healthiest-first and stamps deterministic metadata", () => {
    const sc = assembleScorecard([
      prFlowSite("Slow", 60),
      prFlowSite("Fast", 4),
      prFlowSite("Mid", 24),
    ]);
    expect(sc.sites.map((s) => s.team)).toEqual(["Fast", "Mid", "Slow"]);
    const fast = sc.sites.find((s) => s.team === "Fast");
    const slow = sc.sites.find((s) => s.team === "Slow");
    expect(fast?.score ?? 0).toBeGreaterThan(slow?.score ?? 0);
    expect(sc.generatedAt).toBe("2026-06-29T12:00:00.000Z");
    expect(sc.periodDays).toBe(14);
  });

  it("throws when given no sites", () => {
    expect(() => assembleScorecard([])).toThrow(/at least one site/i);
  });
});

describe("renderScorecardMarkdown", () => {
  it("renders a ranked table and calls out the biggest drag", () => {
    const sc = assembleScorecard([prFlowSite("Fast", 4), prFlowSite("Slow", 60)]);
    const md = renderScorecardMarkdown(sc);
    expect(md).toContain("# Delivery Scorecard — 2 teams");
    expect(md).toContain("| 1 | Fast |");
    expect(md).toContain("| 2 | Slow |");
    expect(md).toContain("Biggest drag: Slow");
  });
});
