import { describe, expect, it } from "vitest";
import {
  type SprintInput,
  computeSprintHealth,
  computeSprintTrend,
  renderSprintTrendMarkdown,
} from "../src/reads/sprint-health.js";
import { type RawIssue, deriveSprintInput } from "../src/sources/jira.js";

describe("full sprint model (churn + added completion)", () => {
  const input: SprintInput = {
    sprintName: "S1",
    committed: 40,
    completed: 38,
    completedPlannedWork: 32,
    addedMidSprint: 10,
    carriedOver: 4,
    addedCompleted: 6,
    plannedRemoved: 2,
    addedRemoved: 1,
  };

  it("computes added completion and churn when buckets are supplied", () => {
    const read = computeSprintHealth(input);
    const byKey = Object.fromEntries(read.metrics.map((m) => [m.key, m]));

    // Added completion: 6 / 10 = 60% (red on the higher-is-better bands: <70%).
    expect(byKey.addedCompletion?.value).toBeCloseTo(0.6);
    expect(byKey.addedCompletion?.band).toBe("red");

    // Churn: (10 + 2 + 1) / (40 + 10) = 26% (red on the lower-is-better bands).
    expect(byKey.churn?.value).toBeCloseTo(0.26);
    expect(byKey.churn?.band).toBe("red");
  });

  it("stays backwards-compatible when the extra buckets are absent", () => {
    const read = computeSprintHealth({
      committed: 40,
      completed: 38,
      completedPlannedWork: 32,
      addedMidSprint: 4,
      carriedOver: 2,
    });
    const keys = read.metrics.map((m) => m.key);
    expect(keys).not.toContain("churn");
    expect(keys).not.toContain("addedCompletion");
    expect(keys).toContain("predictability");
  });
});

describe("sprint trend (hero / chaos / laser-focus)", () => {
  const sprints: SprintInput[] = [
    // Hero candidate: 95% completion, 5% carryover.
    {
      sprintName: "A",
      committed: 40,
      completed: 38,
      completedPlannedWork: 34,
      addedMidSprint: 4,
      carriedOver: 2,
    },
    // Chaos: huge creep.
    {
      sprintName: "B",
      committed: 30,
      completed: 18,
      completedPlannedWork: 10,
      addedMidSprint: 20,
      carriedOver: 12,
    },
    // Laser focus: everything delivered was planned.
    {
      sprintName: "C",
      committed: 35,
      completed: 30,
      completedPlannedWork: 30,
      addedMidSprint: 2,
      carriedOver: 6,
    },
  ];

  it("names the standout sprints deterministically", () => {
    const trend = computeSprintTrend(sprints);
    expect(trend.perSprint).toHaveLength(3);
    expect(trend.heroIndex).toBe(0); // A: best completion with carryover ≤10%
    expect(trend.chaosIndex).toBe(1); // B: highest scope creep
    expect(trend.laserFocusIndex).toBe(2); // C: highest execution focus (100%)
  });

  it("hero is null when no sprint keeps carryover ≤10%", () => {
    const trend = computeSprintTrend([sprints[1] as SprintInput]);
    expect(trend.heroIndex).toBeNull();
  });

  it("renders the trend table with callouts", () => {
    const md = renderSprintTrendMarkdown(computeSprintTrend(sprints));
    expect(md).toContain("# Sprint Trend");
    expect(md).toContain("**Hero sprint:** A");
    expect(md).toContain("**Most chaotic:** B");
    expect(md).toContain("**Laser focus:** C");
  });

  it("handles an empty list", () => {
    const md = renderSprintTrendMarkdown(computeSprintTrend([]));
    expect(md).toContain("No sprints supplied");
  });
});

describe("deriveSprintInput (six-way buckets from issues)", () => {
  const issue = (over: Partial<RawIssue>): RawIssue => ({
    key: "X-1",
    type: "Story",
    status: "Done",
    createdAt: "2026-06-16T09:00:00Z",
    storyPoints: 3,
    ...over,
  });

  const issues: RawIssue[] = [
    // Planned + completed (3 pts).
    issue({ key: "X-1", plannedAtSprintStart: true, resolvedAt: "2026-06-20T09:00:00Z" }),
    // Planned + completed (5 pts).
    issue({
      key: "X-2",
      storyPoints: 5,
      plannedAtSprintStart: true,
      resolvedAt: "2026-06-21T09:00:00Z",
    }),
    // Planned, not finished → carried over (2 pts).
    issue({ key: "X-3", storyPoints: 2, plannedAtSprintStart: true, resolvedAt: null }),
    // Planned but removed mid-sprint (8 pts).
    issue({
      key: "X-4",
      storyPoints: 8,
      plannedAtSprintStart: true,
      removedFromSprintAt: "2026-06-18T09:00:00Z",
      resolvedAt: null,
    }),
    // Added + completed (3 pts).
    issue({
      key: "X-5",
      plannedAtSprintStart: false,
      addedToSprintAt: "2026-06-19T09:00:00Z",
      resolvedAt: "2026-06-22T09:00:00Z",
    }),
    // Added, then removed again (1 pt).
    issue({
      key: "X-6",
      storyPoints: 1,
      plannedAtSprintStart: false,
      addedToSprintAt: "2026-06-19T09:00:00Z",
      removedFromSprintAt: "2026-06-20T09:00:00Z",
      resolvedAt: null,
    }),
  ];

  it("weights the buckets by story points", () => {
    const s = deriveSprintInput(issues, "Sprint X");
    expect(s.sprintName).toBe("Sprint X");
    expect(s.committed).toBe(18); // planned: 3+5+2+8
    expect(s.completedPlannedWork).toBe(8); // planned completed: 3+5
    expect(s.addedMidSprint).toBe(4); // added: 3+1
    expect(s.addedCompleted).toBe(3);
    expect(s.completed).toBe(11); // 8 planned + 3 added
    expect(s.carriedOver).toBe(2); // X-3
    expect(s.plannedRemoved).toBe(8); // X-4
    expect(s.addedRemoved).toBe(1); // X-6
  });

  it("treats issues without sprint fields as planned", () => {
    const s = deriveSprintInput([issue({ resolvedAt: "2026-06-20T09:00:00Z" })]);
    expect(s.committed).toBe(3);
    expect(s.completedPlannedWork).toBe(3);
    expect(s.addedMidSprint).toBe(0);
  });
});
