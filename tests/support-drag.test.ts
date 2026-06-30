import { describe, expect, it } from "vitest";
import { computeSupportDrag, renderSupportDragMarkdown } from "../src/reads/support-drag.js";
import type { SupportThread } from "../src/sources/support.js";

const heavy: SupportThread[] = [
  { requesterRole: "Product", firstResponseMinutes: 35, resolutionStatus: "Resolved", tags: ["a"] },
  { requesterRole: "Product", firstResponseMinutes: 45, resolutionStatus: "Resolved", tags: ["a"] },
  {
    requesterRole: "Product",
    firstResponseMinutes: 120,
    resolutionStatus: "Resolved",
    tags: ["a"],
  },
  {
    requesterRole: "Product",
    firstResponseMinutes: 260,
    resolutionStatus: "Resolved",
    tags: ["a"],
  },
  {
    requesterRole: "Product",
    firstResponseMinutes: null,
    resolutionStatus: "Unanswered",
    tags: ["a"],
  },
  { requesterRole: "Support", firstResponseMinutes: 55, resolutionStatus: "Resolved", tags: ["a"] },
  {
    requesterRole: "Support",
    firstResponseMinutes: 150,
    resolutionStatus: "Resolved",
    tags: ["a"],
  },
  { requesterRole: "Support", firstResponseMinutes: 300, resolutionStatus: "Open", tags: ["a"] },
  { requesterRole: "eng", firstResponseMinutes: 90, resolutionStatus: "Resolved", tags: ["a"] },
  { requesterRole: "eng", firstResponseMinutes: 200, resolutionStatus: "Resolved", tags: ["a"] },
  { requesterRole: "Data", firstResponseMinutes: 40, resolutionStatus: "Resolved", tags: ["a"] },
  {
    requesterRole: "Data",
    firstResponseMinutes: null,
    resolutionStatus: "Unanswered",
    tags: ["a"],
  },
];

const band = (r: ReturnType<typeof computeSupportDrag>, label: string) =>
  r.metrics.find((m) => m.label === label)?.band;

describe("computeSupportDrag", () => {
  it("reads a dropped-requests channel as heavy hidden load", () => {
    const r = computeSupportDrag(heavy);
    expect(r.verdict).toBe("heavy hidden load");
    expect(band(r, "Unanswered")).toBe("red"); // 2/12 ≈ 17%
    expect(r.hiddenLoad.requests).toBe(12);
    expect(r.hiddenLoad.topRequester).toBe("Product");
    expect(r.flags.length).toBeGreaterThan(0);
    expect(r.fixFirst).toMatch(/triage/i);
  });

  it("reads a fast, fully-resolved channel as managed", () => {
    const good: SupportThread[] = Array.from({ length: 6 }, () => ({
      requesterRole: "Product",
      firstResponseMinutes: 20,
      resolutionStatus: "Resolved",
      tags: ["a"],
    }));
    const r = computeSupportDrag(good);
    expect(r.verdict).toBe("managed");
    expect(r.metrics.every((m) => m.band === "green")).toBe(true);
  });

  it("handles an empty export", () => {
    expect(computeSupportDrag([]).verdict).toBe("no load");
  });
});

describe("renderSupportDragMarkdown", () => {
  it("renders verdict, scorecard, hidden load and fix", () => {
    const md = renderSupportDragMarkdown(computeSupportDrag(heavy));
    expect(md).toContain("# Support Health Read");
    expect(md).toContain("## Verdict: heavy hidden load");
    expect(md).toContain("## The hidden load");
    expect(md).toContain("🔴");
    expect(md).toContain("## Fix first");
  });
});
