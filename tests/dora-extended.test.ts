import { describe, expect, it } from "vitest";
import {
  computeDoraMetrics,
  type DeployEvent,
  deployEventsFromPRs,
  timeMetrics,
} from "../src/sources/dora.js";
import type { RawPR } from "../src/sources/github.js";
import type { RawIncident } from "../src/sources/pagerduty.js";

const deploy = (over: Partial<DeployEvent>): DeployEvent => ({
  repo: "web",
  builtAt: "2026-06-20T09:00:00Z",
  deployedAt: "2026-06-20T11:00:00Z",
  isRevert: false,
  ...over,
});

describe("empty DORA windows", () => {
  it("marks an empty deployment window as unavailable rather than Elite", () => {
    const empty = computeDoraMetrics([], 14);
    expect(empty.noData).toBe(true);
    expect(empty.totalDeploys).toBe(0);
    expect(empty.classes.changeFailureRate).not.toBe("Elite");
  });

  it("marks a window with only out-of-period deployments as unavailable", () => {
    const empty = computeDoraMetrics([deploy({ deployedAt: "2026-03-01T11:00:00Z" })], 14, {
      now: Date.parse("2026-06-29T12:00:00Z"),
    });
    expect(empty.noData).toBe(true);
    expect(empty.totalDeploys).toBe(0);
  });
});

describe("rework rate (DORA 2024)", () => {
  it("counts fix and revert deploys as rework, flag-based only", () => {
    const deploys = [deploy({}), deploy({ isFix: true }), deploy({ isRevert: true }), deploy({})];
    const d = computeDoraMetrics(deploys, 14);
    expect(d.totalFixDeploys).toBe(2); // the fix + the revert
    expect(d.reworkRatePct).toBe(50);
    expect(d.cfrBasis).toBe("revert-proxy");
  });
});

describe("incident-linked CFR", () => {
  const incidents: RawIncident[] = [
    {
      id: "I1",
      title: "web down",
      status: "resolved",
      createdAt: "2026-06-20T13:00:00Z", // 2h after the web deploy
      resolvedAt: "2026-06-20T14:00:00Z",
      urgency: "high",
      service: "web",
    },
    {
      id: "I2",
      title: "api noise",
      status: "resolved",
      createdAt: "2026-06-20T13:00:00Z",
      resolvedAt: "2026-06-20T13:30:00Z",
      urgency: "low", // low urgency never fails a deploy
      service: "api",
    },
  ];

  it("links high-urgency incidents to the deploy's service within the window", () => {
    const deploys = [
      deploy({}), // web — followed by I1 → failed
      deploy({ repo: "api" }), // api — only a low-urgency incident → fine
      deploy({ repo: "web", deployedAt: "2026-06-25T11:00:00Z" }), // outside I1's window
    ];
    const d = computeDoraMetrics(deploys, 14, { incidents });
    expect(d.cfrBasis).toBe("incident-linked");
    expect(d.changeFailureRatePct).toBe(33.3); // 1 of 3
  });

  it("never double-counts a reverted deploy that also paged", () => {
    const deploys = [deploy({ isRevert: true })]; // reverted AND followed by I1
    const d = computeDoraMetrics(deploys, 14, { incidents });
    expect(d.changeFailureRatePct).toBe(100); // one deploy, one failure
  });

  it("computes recovery time only over deploy-linked incidents", () => {
    const d = computeDoraMetrics([deploy({})], 14, { incidents });
    // Only I1 links to the web deploy (I2 is low urgency, never linked):
    // failed-deployment recovery = I1's 60 min — not overall incident MTTR.
    expect(d.recoveryTime).toEqual({ medianMinutes: 60, p90Minutes: 60 });
  });

  it("omits recovery time when no incident links to a deploy", () => {
    // A deploy on an unrelated service: CFR is incident-linked (0 failures)
    // but there is no linked set to compute recovery from.
    const d = computeDoraMetrics([deploy({ repo: "worker" })], 14, { incidents });
    expect(d.cfrBasis).toBe("incident-linked");
    expect(d.changeFailureRatePct).toBe(0);
    expect(d.recoveryTime).toBeUndefined();
  });

  it("windows deploys to the period when `now` is supplied", () => {
    const deploys = [
      deploy({}), // 2026-06-20 — inside a 14-day window ending 2026-06-29
      deploy({ deployedAt: "2026-03-01T11:00:00Z", isRevert: true }), // months old
    ];
    const d = computeDoraMetrics(deploys, 14, { now: Date.parse("2026-06-29T12:00:00Z") });
    expect(d.totalDeploys).toBe(1); // the stale deploy never enters the maths
    expect(d.totalReverts).toBe(0);
  });
});

describe("deployEventsFromPRs (zero-config deploy signal)", () => {
  const pr = (over: Partial<RawPR>): RawPR => ({
    repo: "web",
    number: 1,
    author: "a",
    createdAt: "2026-06-20T09:00:00Z",
    mergedAt: "2026-06-20T15:00:00Z",
    additions: 10,
    deletions: 2,
    ...over,
  });

  it("maps merged PRs to deploys and flags fixes/reverts from titles", () => {
    const events = deployEventsFromPRs([
      pr({ title: "Add feature" }),
      pr({ number: 2, title: "fix: broken null check" }),
      pr({ number: 3, title: 'Revert "Add feature"' }),
      pr({ number: 4, mergedAt: null }), // unmerged → no deploy
    ]);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ isRevert: false, isFix: false });
    expect(events[1]).toMatchObject({ isRevert: false, isFix: true });
    expect(events[2]).toMatchObject({ isRevert: true });
  });
});

describe("timeMetrics", () => {
  it("computes avg/median/p90 on the ceil-index convention", () => {
    expect(timeMetrics([10, 20, 30, 40, 50])).toEqual({
      avgMinutes: 30,
      medianMinutes: 30,
      p90Minutes: 50,
    });
    expect(timeMetrics([])).toEqual({ avgMinutes: 0, medianMinutes: 0, p90Minutes: 0 });
  });
});
