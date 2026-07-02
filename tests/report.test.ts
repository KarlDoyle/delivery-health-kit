import { describe, expect, it } from "vitest";
import { runReport } from "../src/cli.js";
import { assembleReport } from "../src/report/assemble.js";
import { renderMarkdown } from "../src/report/markdown.js";
import { renderSlackBlocks } from "../src/report/slack.js";
import { loadFixtures } from "../src/sources/fixtures.js";

async function buildOfflineReport() {
  const fx = await loadFixtures();
  return assembleReport({
    config: fx.config,
    mode: "offline",
    now: Date.parse(fx.config.asOf),
    sprintName: fx.config.sprintName,
    prs: fx.prs,
    deploys: fx.deploys,
    issues: fx.issues,
    threads: fx.threads,
  });
}

describe("offline report assembly (end-to-end from fixtures)", () => {
  it("loads fixtures and assembles all four metric blocks", async () => {
    const report = await buildOfflineReport();
    expect(report.mode).toBe("offline");
    expect(report.team).toBe("Team Atlas");
    expect(report.dora).toBeDefined();
    expect(report.github).toBeDefined();
    expect(report.jira).toBeDefined();
    expect(report.support).toBeDefined();
  });

  it("computes the expected consolidated numbers", async () => {
    const r = await buildOfflineReport();

    // GitHub: 8 in-window team PRs (external author + out-of-window + open excluded).
    expect(r.github?.totalMerged).toBe(8);
    expect(r.github?.byRepo).toEqual({ web: 4, api: 4 });

    // DORA: 14 deploys / 14 days = 1.0/day Elite; 2 reverts = 14.3% Elite.
    expect(r.dora?.totalDeploys).toBe(14);
    expect(r.dora?.totalReverts).toBe(2);
    expect(r.dora?.deploymentFrequencyPerDay).toBe(1);
    expect(r.dora?.classes.deploymentFrequency).toBe("Elite");

    // Jira: 8 closed, 29 story points.
    expect(r.jira?.ticketsClosed).toBe(8);
    expect(r.jira?.storyPointsCompleted).toBe(29);
    expect(r.jira?.sprintName).toBe("Atlas Sprint 24");

    // Support: 12 requests, 2 unanswered, 75% resolution.
    expect(r.support?.totalRequests).toBe(12);
    expect(r.support?.unansweredCount).toBe(2);
    expect(r.support?.resolutionRatePct).toBe(75);
  });

  it("is deterministic (anchored to fixtures asOf, not wall-clock)", async () => {
    const a = renderMarkdown(await buildOfflineReport());
    const b = renderMarkdown(await buildOfflineReport());
    expect(a).toBe(b);
  });
});

describe("renderers", () => {
  it("renders markdown as DX Core 4 with the badge and an offline note", async () => {
    const md = renderMarkdown(await buildOfflineReport());
    expect(md).toContain("# Delivery Health — Team Atlas");
    // The four Core 4 dimensions, in order.
    expect(md).toContain("## Speed");
    expect(md).toContain("## Effectiveness");
    expect(md).toContain("## Quality");
    expect(md).toContain("## Impact");
    // The product-enforced stance is visible on the output itself.
    expect(md).toContain("team-level only · your data stays on your machine");
    // Effectiveness is honestly labelled as proxies, not an invented score.
    expect(md).toContain("DevEx pulse survey");
    // Quality carries the CFR basis label and the rework rate.
    expect(md).toContain("revert-based proxy");
    expect(md).toContain("Rework rate");
    expect(md).toContain("**TL;DR:**");
    expect(md).toContain("Generated offline from synthetic fixtures");
  });

  it("renders Slack Block Kit blocks", async () => {
    const blocks = renderSlackBlocks(await buildOfflineReport());
    expect(blocks[0]).toMatchObject({ type: "header" });
    expect(blocks.some((b) => JSON.stringify(b).includes("Speed"))).toBe(true);
    expect(blocks.some((b) => JSON.stringify(b).includes("Quality"))).toBe(true);
    expect(blocks.some((b) => JSON.stringify(b).includes("Support"))).toBe(true);
    expect(blocks.some((b) => JSON.stringify(b).includes("team-level only"))).toBe(true);
  });

  it("omits sections whose source produced no data", () => {
    const report = assembleReport({
      config: { team: "Empty", periodDays: 14, repos: [], teamMembers: [] },
      mode: "offline",
      now: Date.parse("2026-06-29T12:00:00Z"),
    });
    const md = renderMarkdown(report);
    expect(md).not.toContain("## Speed");
    expect(md).not.toContain("## Quality");
    expect(md).toContain("# Delivery Health — Empty");
  });
});

describe("cli runReport (offline)", () => {
  it("produces a markdown report string", async () => {
    const out = await runReport({ offline: true, quiet: true });
    expect(out).toContain("# Delivery Health — Team Atlas");
  });

  it("produces slack JSON when format=slack", async () => {
    const out = await runReport({ offline: true, quiet: true, format: "slack" });
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({ type: "header" });
  });
});
