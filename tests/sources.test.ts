import { describe, expect, it } from "vitest";
import {
  type DeployEvent,
  classifyChangeFailureRate,
  classifyDeploymentFrequency,
  classifyLeadTime,
  computeDoraMetrics,
} from "../src/sources/dora.js";
import { type RawPR, computeGitHubMetrics } from "../src/sources/github.js";
import { type RawIssue, categorizeWork, computeJiraMetrics } from "../src/sources/jira.js";
import { type SupportThread, computeSupportMetrics } from "../src/sources/support.js";
import type { DeliveryConfig } from "../src/types.js";

const NOW = Date.parse("2026-06-29T12:00:00Z");
const config: DeliveryConfig = {
  team: "Test",
  periodDays: 14,
  repos: ["acme/web"],
  teamMembers: ["alice", "bob"],
};

describe("github compute", () => {
  const prs: RawPR[] = [
    {
      repo: "web",
      number: 1,
      author: "alice",
      createdAt: "2026-06-20T09:00:00Z",
      mergedAt: "2026-06-20T15:00:00Z",
      additions: 80,
      deletions: 20,
      firstReviewAt: "2026-06-20T11:00:00Z",
    },
    {
      repo: "web",
      number: 2,
      author: "bob",
      createdAt: "2026-06-22T09:00:00Z",
      mergedAt: "2026-06-22T13:00:00Z",
      additions: 40,
      deletions: 0,
      firstReviewAt: null,
    },
    // Out of window — excluded.
    {
      repo: "web",
      number: 3,
      author: "alice",
      createdAt: "2026-06-01T09:00:00Z",
      mergedAt: "2026-06-01T10:00:00Z",
      additions: 10,
      deletions: 0,
    },
    // Non-team author — excluded.
    {
      repo: "web",
      number: 4,
      author: "stranger",
      createdAt: "2026-06-21T09:00:00Z",
      mergedAt: "2026-06-21T10:00:00Z",
      additions: 10,
      deletions: 0,
    },
    // Not merged — excluded.
    {
      repo: "web",
      number: 5,
      author: "alice",
      createdAt: "2026-06-21T09:00:00Z",
      mergedAt: null,
      additions: 10,
      deletions: 0,
    },
  ];

  it("filters to team PRs merged in the period and aggregates", () => {
    const m = computeGitHubMetrics(prs, config, NOW);
    expect(m.totalMerged).toBe(2);
    expect(m.avgCycleTimeHours).toBe(5); // (6 + 4) / 2
    expect(m.avgTimeToFirstReviewHours).toBe(2); // only PR #1 reviewed
    expect(m.avgPRSize).toBe(70); // (100 + 40) / 2
    expect(m.byRepo).toEqual({ web: 2 });
  });

  it("returns empty metrics when nothing qualifies", () => {
    expect(computeGitHubMetrics([], config, NOW).totalMerged).toBe(0);
  });
});

describe("dora compute + classifiers", () => {
  const deploys: DeployEvent[] = [
    {
      repo: "web",
      builtAt: "2026-06-20T09:00:00Z",
      deployedAt: "2026-06-20T11:00:00Z",
      isRevert: false,
    },
    {
      repo: "web",
      builtAt: "2026-06-21T09:00:00Z",
      deployedAt: "2026-06-21T13:00:00Z",
      isRevert: false,
    },
    {
      repo: "web",
      builtAt: "2026-06-22T09:00:00Z",
      deployedAt: "2026-06-22T12:00:00Z",
      isRevert: true,
    },
  ];

  it("computes frequency, lead time and change failure rate", () => {
    const d = computeDoraMetrics(deploys, 14);
    expect(d.totalDeploys).toBe(3);
    expect(d.totalReverts).toBe(1);
    expect(d.deploymentFrequencyPerDay).toBe(0.21); // 3/14
    expect(d.leadTimeHours).toBe(3); // (2 + 4 + 3) / 3
    expect(d.changeFailureRatePct).toBe(33.3); // 1/3
  });

  it("classifies metrics into DORA bands", () => {
    expect(classifyDeploymentFrequency(1)).toBe("Elite");
    expect(classifyDeploymentFrequency(0.01)).toBe("Low");
    expect(classifyLeadTime(10)).toBe("Elite");
    expect(classifyLeadTime(1000)).toBe("Low");
    expect(classifyChangeFailureRate(10)).toBe("Elite");
    expect(classifyChangeFailureRate(50)).toBe("Low");
  });
});

describe("jira compute + categorization", () => {
  const issues: RawIssue[] = [
    {
      key: "A-1",
      type: "Story",
      status: "Done",
      createdAt: "2026-06-18T09:00:00Z",
      inProgressAt: "2026-06-19T09:00:00Z",
      doneAt: "2026-06-20T09:00:00Z",
      resolvedAt: "2026-06-20T09:00:00Z",
      storyPoints: 5,
      labels: [],
    },
    {
      key: "A-2",
      type: "Bug",
      status: "Done",
      createdAt: "2026-06-19T09:00:00Z",
      inProgressAt: "2026-06-19T13:00:00Z",
      doneAt: "2026-06-19T17:00:00Z",
      resolvedAt: "2026-06-19T17:00:00Z",
      storyPoints: 2,
      labels: ["bug"],
    },
    // Out of window — neither created nor resolved in window.
    {
      key: "A-3",
      type: "Story",
      status: "Done",
      createdAt: "2026-05-01T09:00:00Z",
      resolvedAt: "2026-05-02T09:00:00Z",
      storyPoints: 8,
    },
  ];

  it("computes throughput, story points and lead time", () => {
    const j = computeJiraMetrics(issues, config, NOW, "Sprint X");
    expect(j.sprintName).toBe("Sprint X");
    expect(j.ticketsClosed).toBe(2);
    expect(j.storyPointsCompleted).toBe(7);
    expect(j.leadTime.avgHours).toBe(14); // (24 + 4) / 2
    expect(j.workDistribution.productDelivery).toBe(50);
    expect(j.workDistribution.bugs).toBe(50);
  });

  it("categorizes by type and labels", () => {
    expect(categorizeWork({ key: "x", type: "Bug", status: "", createdAt: "" })).toBe("bugs");
    expect(categorizeWork({ key: "x", type: "Spike", status: "", createdAt: "" })).toBe(
      "exploration",
    );
    expect(
      categorizeWork({ key: "x", type: "Task", status: "", createdAt: "", labels: ["refactor"] }),
    ).toBe("techDebt");
    expect(categorizeWork({ key: "x", type: "Story", status: "", createdAt: "" })).toBe(
      "productDelivery",
    );
    expect(categorizeWork({ key: "x", type: "Unknown", status: "", createdAt: "" })).toBe("other");
  });
});

describe("support compute", () => {
  const threads: SupportThread[] = [
    {
      requesterRole: "Customer",
      firstResponseMinutes: 10,
      resolutionStatus: "Resolved",
      tags: ["billing"],
    },
    {
      requesterRole: "Customer",
      firstResponseMinutes: 30,
      resolutionStatus: "Resolved",
      tags: ["billing", "login"],
    },
    {
      requesterRole: "Partner",
      firstResponseMinutes: 300,
      resolutionStatus: "Open",
      tags: ["api"],
    },
    {
      requesterRole: "Customer",
      firstResponseMinutes: null,
      resolutionStatus: "Unanswered",
      tags: ["login"],
    },
  ];

  it("aggregates team-level support metrics", () => {
    const s = computeSupportMetrics(threads);
    expect(s.totalRequests).toBe(4);
    expect(s.medianFirstResponseMinutes).toBe(30); // median of [10, 30, 300]
    expect(s.resolutionRatePct).toBe(50); // 2 of 4 resolved
    expect(s.unansweredCount).toBe(1);
    expect(s.lateResponseCount).toBe(1); // 300 > 240
    expect(s.requesterMix).toEqual({ Customer: 3, Partner: 1 });
    expect(s.topThemes[0]).toEqual({ theme: "billing", count: 2 });
  });

  it("returns empty metrics for no threads", () => {
    expect(computeSupportMetrics([]).totalRequests).toBe(0);
  });
});
