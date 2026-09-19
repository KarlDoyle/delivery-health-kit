import { describe, expect, it } from "vitest";
import { assembleDigest, assembleReport } from "../src/report/assemble.js";
import { loadDigestFixtures } from "../src/sources/fixtures.js";
import type { DeliveryConfig } from "../src/types.js";

/**
 * Assembly when a source is simply not wired up. The fixture suites always hand
 * `assembleReport`/`assembleDigest` every input, so the "this source is absent"
 * half of each block — and the default-`now` fallback — went unexercised.
 */

const config: DeliveryConfig = {
  team: "Atlas",
  periodDays: 14,
  repos: ["acme/web"],
  teamMembers: ["dev"],
};

describe("assembleReport", () => {
  it("emits only the envelope when no source is connected", () => {
    const report = assembleReport({ config, mode: "live", now: 0 });
    expect(report).toEqual({
      generatedAt: "1970-01-01T00:00:00.000Z",
      team: "Atlas",
      periodDays: 14,
      mode: "live",
    });
  });

  it("includes only the blocks whose inputs were supplied", () => {
    const report = assembleReport({ config, mode: "live", now: 0, deploys: [], issues: [] });
    expect(report.dora).toBeDefined();
    expect(report.jira).toBeDefined();
    expect(report.github).toBeUndefined();
    expect(report.support).toBeUndefined();
  });

  it("falls back to wall-clock time when no reference time is given", () => {
    const before = Date.now();
    const report = assembleReport({ config, mode: "live" });
    expect(Date.parse(report.generatedAt)).toBeGreaterThanOrEqual(before);
  });
});

describe("assembleDigest", () => {
  it("emits only the envelope when no source is connected", () => {
    const digest = assembleDigest({ config, mode: "live", now: 0 });
    expect(digest.incidents).toBeUndefined();
    expect(digest.errors).toBeUndefined();
    expect(digest.slo).toBeUndefined();
    expect(digest.dora).toBeUndefined();
  });

  it("falls back to wall-clock time when no reference time is given", () => {
    const before = Date.now();
    const digest = assembleDigest({ config, mode: "live" });
    expect(Date.parse(digest.generatedAt)).toBeGreaterThanOrEqual(before);
  });

  it("still produces a DORA block from deploys alone, with no incident linkage", async () => {
    const fx = await loadDigestFixtures();
    const digest = assembleDigest({
      config: fx.config,
      mode: "offline",
      now: Date.parse(fx.config.asOf),
      deploys: fx.deploys,
    });
    expect(digest.dora).toBeDefined();
    expect(digest.dora?.cfrBasis).toBe("revert-proxy");
    expect(digest.incidents).toBeUndefined();
  });
});
