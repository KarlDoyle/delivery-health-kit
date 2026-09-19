import { describe, expect, it } from "vitest";
import {
  computeSprintHealth,
  renderSprintHealthMarkdown,
  type SprintInput,
} from "../src/reads/sprint-health.js";

const band = (read: ReturnType<typeof computeSprintHealth>, key: string) =>
  read.metrics.find((m) => m.key === key)?.band;

describe("computeSprintHealth — formulas + bands", () => {
  it("computes the five metrics from raw figures", () => {
    const r = computeSprintHealth({
      committed: 40,
      completed: 30,
      completedPlannedWork: 24,
      addedMidSprint: 8,
      carriedOver: 10,
    });
    const v = (k: string) => r.metrics.find((m) => m.key === k)?.value ?? -1;
    expect(v("completion")).toBeCloseTo(0.75); // 30/40
    expect(v("focus")).toBeCloseTo(0.8); // 24/30
    expect(v("creep")).toBeCloseTo(0.2); // 8/40
    expect(v("carryover")).toBeCloseTo(0.25); // 10/40
    // predictability = 0.4*0.75 + 0.3*(1-0.25) + 0.3*0.8 = 0.765
    expect(v("predictability")).toBeCloseTo(0.765);
  });

  it("guards against divide-by-zero", () => {
    const r = computeSprintHealth({
      committed: 0,
      completed: 0,
      completedPlannedWork: 0,
      addedMidSprint: 0,
      carriedOver: 0,
    });
    expect(r.metrics.every((m) => Number.isFinite(m.value))).toBe(true);
  });

  it("bands higher-is-better at 90% / 70% and lower-is-better at 10% / 25%", () => {
    const r = computeSprintHealth({
      committed: 100,
      completed: 90,
      completedPlannedWork: 63,
      addedMidSprint: 9,
      carriedOver: 30,
    });
    expect(band(r, "completion")).toBe("green"); // 0.90
    expect(band(r, "focus")).toBe("amber"); // 0.70
    expect(band(r, "creep")).toBe("green"); // 0.09 < 0.10
    expect(band(r, "carryover")).toBe("red"); // 0.30 > 0.25
  });
});

describe("computeSprintHealth — verdicts", () => {
  const base: SprintInput = {
    committed: 20,
    completed: 19,
    completedPlannedWork: 18,
    addedMidSprint: 1,
    carriedOver: 1,
  };

  it("Hero: high completion with low carryover", () => {
    expect(computeSprintHealth(base).verdict).toBe("Hero");
  });

  it("Laser-Focus: focus + creep green but completion not green", () => {
    const r = computeSprintHealth({
      committed: 20,
      completed: 16, // 0.80 completion (amber)
      completedPlannedWork: 16, // focus 1.0 (green)
      addedMidSprint: 1, // creep 0.05 (green)
      carriedOver: 2, // carryover 0.10 (amber)
    });
    expect(r.verdict).toBe("Laser-Focus");
  });

  it("Solid: nothing red, but not Hero or Laser-Focus", () => {
    const r = computeSprintHealth({
      committed: 20,
      completed: 16, // 0.80 (amber)
      completedPlannedWork: 12, // focus 0.75 (amber)
      addedMidSprint: 2, // creep 0.10 (amber)
      carriedOver: 2, // carryover 0.10 (amber)
    });
    expect(r.verdict).toBe("Solid");
  });

  it("Chaos: any red on completion/creep/carryover — even with high completion", () => {
    const r = computeSprintHealth({
      committed: 40,
      completed: 38, // 0.95 completion (green)
      completedPlannedWork: 28,
      addedMidSprint: 12, // creep 0.30 (red)
      carriedOver: 4,
    });
    expect(r.verdict).toBe("Chaos");
    expect(r.flags[0]).toMatch(/added mid-sprint/i);
    expect(r.fixFirst).toMatch(/swaps out|swap/i);
  });
});

describe("renderSprintHealthMarkdown", () => {
  it("renders the four sections with the verdict and a scorecard", () => {
    const md = renderSprintHealthMarkdown(
      computeSprintHealth({
        sprintName: "Sprint 9",
        committed: 40,
        completed: 38,
        completedPlannedWork: 28,
        addedMidSprint: 12,
        carriedOver: 4,
      }),
    );
    expect(md).toContain("# Sprint Health — Sprint 9");
    expect(md).toContain("## Verdict: Chaos");
    expect(md).toContain("## Scorecard");
    expect(md).toContain("## Flags");
    expect(md).toContain("## Fix first");
    expect(md).toContain("🔴");
  });
});
