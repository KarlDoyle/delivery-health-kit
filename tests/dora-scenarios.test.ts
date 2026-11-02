import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type DoraScenarioFixture, runDoraScenarioMatrix } from "../src/eval/dora-scenarios.js";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/scenarios/dora-sensitivity.json", import.meta.url), "utf8"),
) as DoraScenarioFixture;

describe("runDoraScenarioMatrix", () => {
  it("compares fixed periods and CFR bases using fully covered fixture data", () => {
    const rows = runDoraScenarioMatrix(fixture);
    expect(rows.map((row) => row.periodDays)).toEqual([7, 14, 30]);
    expect(rows.map((row) => row.deploys)).toEqual([4, 7, 12]);
    expect(rows[0]).toMatchObject({
      cfrProxyPct: 0,
      cfrWithIncidentsPct: 25,
      cfrWithIncidentsBasis: "incident-linked",
      recoveryMedianMinutes: 120,
      recoveryP90Minutes: 120,
    });
    expect(rows[1]).toMatchObject({
      cfrProxyPct: 14.3,
      cfrWithIncidentsPct: 42.9,
      cfrWithIncidentsBasis: "incident-linked",
    });
    expect(rows[2]).toMatchObject({
      cfrProxyPct: 16.7,
      cfrWithIncidentsPct: 33.3,
      cfrWithIncidentsBasis: "incident-linked",
    });
  });

  it("rejects a period longer than the fixture coverage", () => {
    expect(() => runDoraScenarioMatrix(fixture, [31])).toThrow(/before fixture coverage/i);
  });

  it("rejects non-positive periods", () => {
    expect(() => runDoraScenarioMatrix(fixture, [0])).toThrow(/positive number/i);
  });
});
