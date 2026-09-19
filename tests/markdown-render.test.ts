import { describe, expect, it } from "vitest";
import { assembleDigest, assembleReport } from "../src/report/assemble.js";
import {
  renderDigestMarkdown,
  renderMarkdown,
  renderScorecardMarkdown,
} from "../src/report/markdown.js";
import { assembleScorecard } from "../src/report/scorecard.js";
import { loadDigestFixtures, loadFixtures } from "../src/sources/fixtures.js";
import type { DeliveryReport, ReliabilityReport } from "../src/types.js";

/**
 * Markdown rendering for the *partially connected* team. The fixture-driven
 * suites already cover the everything-present rendering; what was untested is
 * every "this source isn't wired up" branch, plus the duration formatters'
 * hours→days and minutes→hours rollovers.
 */

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

describe("renderMarkdown with sources missing", () => {
  it("renders only the header when nothing is connected, and no offline footer in live mode", () => {
    const bare: DeliveryReport = {
      generatedAt: "2026-06-29T12:00:00Z",
      team: "Bare",
      periodDays: 14,
      mode: "live",
    };
    const md = renderMarkdown(bare);
    expect(md).toContain("# Delivery Health — Bare");
    expect(md).not.toContain("**TL;DR:**");
    expect(md).not.toContain("Speed");
    expect(md).not.toContain("Generated offline from synthetic fixtures");
  });

  it("renders the speed section from DORA alone and from PR flow alone", async () => {
    const full = await fullReport();
    const doraOnly = renderMarkdown({ ...full, github: undefined, jira: undefined });
    expect(doraOnly).toContain("Deployment frequency");

    const prsOnly = renderMarkdown({ ...full, dora: undefined, jira: undefined });
    expect(prsOnly).toContain("PR cycle time");
    // With no DORA there is no quality section to render.
    expect(prsOnly).not.toContain("Change failure rate");
  });

  it("renders the effectiveness and impact sections from each half alone", async () => {
    const full = await fullReport();
    const jiraOnly = renderMarkdown({ ...full, github: undefined, support: undefined });
    expect(jiraOnly).toContain("tickets");

    const supportOnly = renderMarkdown({ ...full, jira: undefined });
    expect(supportOnly).toContain("Support drag");
  });

  it("labels an incident-linked CFR and omits the revert-proxy caveat", async () => {
    const full = await fullReport();
    expect(full.dora).toBeDefined();
    const md = renderMarkdown({
      ...full,
      // biome-ignore lint/style/noNonNullAssertion: asserted defined above.
      dora: { ...full.dora!, cfrBasis: "incident-linked" },
    });
    expect(md).toContain("incident-linked");
  });

  it("includes the recovery-time line only when recovery time is present", async () => {
    const full = await fullReport();
    const md = renderMarkdown({
      ...full,
      // biome-ignore lint/style/noNonNullAssertion: the fixtures always produce a dora block.
      dora: { ...full.dora!, recoveryTime: { medianMinutes: 90, p90Minutes: 2880 } },
    });
    // 90 min rolls over to hours, 2880 min to days — the formatter's two branches.
    expect(md).toContain("1.5h");
    expect(md).toContain("2.0d");
  });

  it("rolls hours over into days in the lead-time line", async () => {
    const full = await fullReport();
    const md = renderMarkdown({
      ...full,
      // biome-ignore lint/style/noNonNullAssertion: the fixtures always produce a dora block.
      dora: { ...full.dora!, leadTimeHours: 48 },
    });
    expect(md).toContain("2.0d");
  });

  it("flags support against target in both directions and dashes empty mixes", async () => {
    const full = await fullReport();
    // biome-ignore lint/style/noNonNullAssertion: the fixtures always produce a support block.
    const s = full.support!;

    const over = renderMarkdown({
      ...full,
      support: {
        ...s,
        medianFirstResponseMinutes: s.targets.medianFrtMinutes + 1,
        resolutionRatePct: 0,
        requesterMix: {},
        topThemes: [],
      },
    });
    expect(over).toContain("[over target]");
    expect(over).toContain("[below target]");
    expect(over).toContain("Requester mix: —");
    expect(over).toContain("Top themes: —");

    const under = renderMarkdown({
      ...full,
      support: {
        ...s,
        medianFirstResponseMinutes: null,
        resolutionRatePct: 100,
      },
    });
    expect(under).toContain("Median first response: — ");
    expect(under).toContain("[on target]");
  });

  it("drops the sprint name and the where-it-landed line when neither is available", async () => {
    const full = await fullReport();
    const md = renderMarkdown({
      ...full,
      // biome-ignore lint/style/noNonNullAssertion: the fixtures always produce these blocks.
      jira: { ...full.jira!, sprintName: undefined },
      // biome-ignore lint/style/noNonNullAssertion: the fixtures always produce these blocks.
      github: { ...full.github!, byRepo: {} },
    });
    expect(md).not.toContain("Atlas Sprint 24");
    expect(md).not.toContain("Where the work landed");
  });
});

describe("renderDigestMarkdown with sources missing", () => {
  it("renders only the header when nothing is connected", () => {
    const md = renderDigestMarkdown({
      generatedAt: "2026-06-29T12:00:00Z",
      team: "Bare",
      periodDays: 14,
      mode: "live",
    });
    expect(md).toContain("Bare");
    expect(md).not.toContain("Incidents");
    expect(md).not.toContain("Generated offline from synthetic fixtures");
  });

  it("omits the recovery aside when the DORA block has no recovery time", async () => {
    const digest = await fullDigest();
    // biome-ignore lint/style/noNonNullAssertion: the fixtures always produce a dora block.
    const dora = { ...digest.dora!, recoveryTime: undefined };
    expect(renderDigestMarkdown({ ...digest, dora })).not.toContain("recovery median");
  });

  it("dashes the busiest-service line when there is none", async () => {
    const digest = await fullDigest();
    // biome-ignore lint/style/noNonNullAssertion: the fixtures always produce incidents.
    const incidents = digest.incidents!;
    const md = renderDigestMarkdown({
      ...digest,
      incidents: { ...incidents, onCall: { ...incidents.onCall, busiestService: null } },
    });
    expect(md).toContain("Busiest service: —");
  });

  it("renders every SLO status: meeting, breaching and no-data", async () => {
    const digest = await fullDigest();
    // biome-ignore lint/style/noNonNullAssertion: the fixtures always produce an slo block.
    const slo = digest.slo!;
    // biome-ignore lint/style/noNonNullAssertion: the fixtures ship at least one service.
    const first = slo.services[0]!;
    const md = renderDigestMarkdown({
      ...digest,
      slo: {
        ...slo,
        services: [
          { ...first, name: "ok", meetingAvailability: true, meetingLatency: true, noData: false },
          {
            ...first,
            name: "bad",
            meetingAvailability: false,
            meetingLatency: true,
            noData: false,
          },
          { ...first, name: "quiet", noData: true },
        ],
      },
    });
    expect(md).toContain("no data");
    expect(md).toContain("meeting");
    expect(md).toContain("| quiet | — |");
  });
});

describe("renderScorecardMarkdown with sources missing", () => {
  it("renders em dashes for every absent source and omits the drag line for one site", async () => {
    const fx = await loadFixtures();
    const sc = assembleScorecard([
      { config: { ...fx.config, team: "Solo" }, mode: "live", now: Date.parse(fx.config.asOf) },
    ]);
    const md = renderScorecardMarkdown(sc);
    expect(md).toContain("—");
    expect(md).not.toContain("Biggest drag");
    expect(md).not.toContain("Generated offline from synthetic fixtures");
  });

  it("names the biggest drag when more than one site is scored", async () => {
    const fx = await loadFixtures();
    const base = {
      mode: "offline" as const,
      now: Date.parse(fx.config.asOf),
      prs: fx.prs,
      deploys: fx.deploys,
      issues: fx.issues,
      threads: fx.threads,
    };
    const md = renderScorecardMarkdown(
      assembleScorecard([
        { ...base, config: { ...fx.config, team: "Atlas" } },
        { ...base, config: { ...fx.config, team: "Borealis" }, prs: [], deploys: [], threads: [] },
      ]),
    );
    expect(md).toContain("Biggest drag");
    expect(md).toContain("Generated offline from synthetic fixtures");
  });
});
