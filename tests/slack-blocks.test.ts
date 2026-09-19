import { describe, expect, it } from "vitest";
import { createSilentLogger } from "../src/logger.js";
import { assembleDigest, assembleReport } from "../src/report/assemble.js";
import { assembleScorecard } from "../src/report/scorecard.js";
import {
  postSlackReport,
  renderDigestSlack,
  renderScorecardSlack,
  renderSlackBlocks,
} from "../src/report/slack.js";
import { loadDigestFixtures, loadFixtures } from "../src/sources/fixtures.js";
import type { DeliveryReport, ReliabilityReport } from "../src/types.js";

/**
 * Slack Block Kit rendering. The happy path (every block present) is covered via
 * the report/digest suites; what was untested is the *absent-source* half of
 * every optional block, which is the shape a partially-connected team actually
 * gets. Each renderer is pure, so this needs no network.
 */

const logger = createSilentLogger();

/** Every section of a block, flattened to plain text, for substring assertions. */
function text(blocks: Record<string, unknown>[]): string {
  return JSON.stringify(blocks);
}

async function fullReport(): Promise<DeliveryReport> {
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

async function fullDigest(): Promise<ReliabilityReport> {
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

describe("renderSlackBlocks", () => {
  it("renders a header, the stance badge and every connected section", async () => {
    const blocks = renderSlackBlocks(await fullReport());
    const s = text(blocks);
    expect(blocks[0]).toMatchObject({ type: "header" });
    expect(s).toContain("team-level only");
    expect(s).toContain("*Speed*");
    expect(s).toContain("*Quality*");
    expect(s).toContain("*Sprint");
    expect(s).toContain("*PR flow*");
    expect(s).toContain("*Support*");
  });

  it("omits every section whose source is absent", () => {
    const bare: DeliveryReport = {
      generatedAt: "2026-06-29T12:00:00Z",
      team: "Bare",
      periodDays: 14,
      mode: "offline",
    };
    const blocks = renderSlackBlocks(bare);
    // Header + context + divider only.
    expect(blocks).toHaveLength(3);
    expect(text(blocks)).not.toContain("*Speed*");
  });

  it("labels an incident-linked change-failure rate distinctly from the revert proxy", async () => {
    const report = await fullReport();
    expect(report.dora).toBeDefined();
    const proxy = text(renderSlackBlocks(report));
    expect(proxy).toContain("revert proxy");

    const linked = text(
      renderSlackBlocks({
        ...report,
        // biome-ignore lint/style/noNonNullAssertion: asserted defined above.
        dora: { ...report.dora!, cfrBasis: "incident-linked" },
      }),
    );
    expect(linked).toContain("incident-linked");
    expect(linked).not.toContain("revert proxy");
  });

  it("drops the sprint name when the sprint is unnamed", async () => {
    const report = await fullReport();
    // biome-ignore lint/style/noNonNullAssertion: the fixtures always produce a jira block.
    const jira = { ...report.jira!, sprintName: undefined };
    const s = text(renderSlackBlocks({ ...report, jira }));
    expect(s).toContain("*Sprint*");
    expect(s).not.toContain("Atlas Sprint 24");
  });

  it("renders an em dash when no median first response exists", async () => {
    const report = await fullReport();
    // biome-ignore lint/style/noNonNullAssertion: the fixtures always produce a support block.
    const support = { ...report.support!, medianFirstResponseMinutes: null };
    expect(text(renderSlackBlocks({ ...report, support }))).toContain("Median first response: —");
  });
});

describe("renderDigestSlack", () => {
  it("renders change-failure, incidents, errors and SLO sections from fixtures", async () => {
    const s = text(renderDigestSlack(await fullDigest()));
    expect(s).toContain("*Change failure*");
    expect(s).toContain("*Incidents*");
    expect(s).toContain("*Errors*");
    expect(s).toContain("*SLOs*");
  });

  it("omits every optional section when nothing is connected", () => {
    const blocks = renderDigestSlack({
      generatedAt: "2026-06-29T12:00:00Z",
      team: "Bare",
      periodDays: 14,
      mode: "offline",
    });
    expect(blocks).toHaveLength(3);
  });

  it("includes the recovery-time line only when recovery time is present", async () => {
    const digest = await fullDigest();
    expect(digest.dora).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted defined above.
    const base = digest.dora!;
    const without = { ...base, recoveryTime: undefined };
    expect(text(renderDigestSlack({ ...digest, dora: without }))).not.toContain("Recovery time");

    const withTime = { ...base, recoveryTime: { medianMinutes: 12, p90Minutes: 30 } };
    expect(text(renderDigestSlack({ ...digest, dora: withTime }))).toContain(
      "Recovery time: median 12 min",
    );
  });

  it("names the busiest service only when one exists", async () => {
    const digest = await fullDigest();
    // biome-ignore lint/style/noNonNullAssertion: the fixtures always produce incidents.
    const incidents = digest.incidents!;
    expect(text(renderDigestSlack(digest))).toContain("Busiest service:");
    const none = { ...incidents, onCall: { ...incidents.onCall, busiestService: null } };
    expect(text(renderDigestSlack({ ...digest, incidents: none }))).not.toContain(
      "Busiest service:",
    );
  });

  it("lists breaching services, and says nothing when every SLO is met", async () => {
    const digest = await fullDigest();
    // biome-ignore lint/style/noNonNullAssertion: the fixtures always produce an slo block.
    const slo = digest.slo!;
    const allMet = {
      ...slo,
      services: slo.services.map((s) => ({
        ...s,
        meetingAvailability: true,
        meetingLatency: true,
      })),
    };
    expect(text(renderDigestSlack({ ...digest, slo: allMet }))).not.toContain("Breaching:");

    const allBreaching = {
      ...slo,
      services: slo.services.map((s) => ({ ...s, meetingAvailability: false })),
    };
    expect(text(renderDigestSlack({ ...digest, slo: allBreaching }))).toContain("Breaching:");
  });
});

describe("renderScorecardSlack", () => {
  it("ranks the sites and calls out the biggest drag", async () => {
    const fx = await loadFixtures();
    const base = {
      config: fx.config,
      mode: "offline" as const,
      now: Date.parse(fx.config.asOf),
      prs: fx.prs,
      deploys: fx.deploys,
      issues: fx.issues,
      threads: fx.threads,
    };
    const sc = assembleScorecard([
      { ...base, config: { ...fx.config, team: "Atlas" } },
      { ...base, config: { ...fx.config, team: "Borealis" }, prs: [], deploys: [], threads: [] },
    ]);
    const s = text(renderScorecardSlack(sc));
    expect(s).toContain("1. *");
    expect(s).toContain("Biggest drag:");
  });

  it("renders em dashes for absent sources and omits the drag line for a single site", async () => {
    const fx = await loadFixtures();
    const sc = assembleScorecard([
      {
        config: { ...fx.config, team: "Solo" },
        mode: "offline",
        now: Date.parse(fx.config.asOf),
      },
    ]);
    const s = text(renderScorecardSlack(sc));
    expect(s).toContain("—");
    expect(s).not.toContain("Biggest drag:");
  });
});

describe("postSlackReport", () => {
  it("skips without a token or a channel", async () => {
    const report = await fullReport();
    expect(await postSlackReport({ botToken: "", channelId: "C1" }, report, { logger })).toBe(
      false,
    );
    expect(await postSlackReport({ botToken: "t", channelId: "" }, report, { logger })).toBe(false);
  });

  it("reports failure when @slack/web-api is not installed (the offline default)", async () => {
    const report = await fullReport();
    expect(await postSlackReport({ botToken: "t", channelId: "C1" }, report, { logger })).toBe(
      false,
    );
  });
});
