import { describe, expect, it } from "vitest";
import { runDigest, runReport } from "../src/cli.js";
import {
  appendSheetsRows,
  renderDigestSheetsRows,
  renderSheetsRows,
} from "../src/report/sheets.js";
import type { DeliveryReport, ReliabilityReport } from "../src/types.js";

const report: DeliveryReport = {
  generatedAt: "2026-06-29T12:00:00Z",
  team: "Atlas",
  periodDays: 14,
  mode: "offline",
  dora: {
    deploymentFrequencyPerDay: 1,
    leadTimeHours: 3.2,
    changeFailureRatePct: 14.3,
    cfrBasis: "revert-proxy",
    reworkRatePct: 21.4,
    totalDeploys: 14,
    totalReverts: 2,
    totalFixDeploys: 3,
    periodDays: 14,
    classes: { deploymentFrequency: "Elite", leadTime: "Elite", changeFailureRate: "Elite" },
  },
  github: {
    totalMerged: 8,
    avgCycleTimeHours: 6.5,
    avgTimeToFirstReviewHours: 2.1,
    avgPRSize: 120,
    byRepo: { web: 4, api: 4 },
  },
};

describe("sheets renderer (pure rows)", () => {
  it("renders a stable header + data row for the report", () => {
    const rows = renderSheetsRows(report);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.slice(0, 4)).toEqual(["date", "team", "period_days", "deploy_freq_per_day"]);
    expect(rows[1]).toEqual([
      "2026-06-29",
      "Atlas",
      14,
      1,
      3.2,
      14.3,
      "revert-proxy",
      21.4,
      8,
      6.5,
      2.1,
      120,
      "",
      "",
      "",
    ]);
  });

  it("leaves DORA cells blank when there are no deployments", () => {
    const dora = report.dora;
    if (!dora) throw new Error("Expected DORA metrics in report fixture");
    const noDeployments: DeliveryReport = {
      ...report,
      dora: { ...dora, noData: true, totalDeploys: 0 },
    };
    const row = renderSheetsRows(noDeployments)[1];
    expect(row?.slice(3, 8)).toEqual(["", "", "", "", ""]);
  });

  it("renders digest rows with reliability columns", () => {
    const digest: ReliabilityReport = {
      generatedAt: "2026-06-29T12:00:00Z",
      team: "Atlas",
      periodDays: 14,
      mode: "offline",
      slo: { services: [], attainmentPct: 33 },
    };
    const rows = renderDigestSheetsRows(digest);
    expect(rows[0]).toContain("slo_attainment_pct");
    expect(rows[1]?.[11]).toBe(33);
  });
});

describe("sheets live append (mocked fetch — no real API calls)", () => {
  it("posts rows to the Sheets REST endpoint and returns updated rows", async () => {
    let captured: { url: string; body: string } | null = null;
    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      captured = { url: String(input), body: String(init?.body) };
      return new Response(JSON.stringify({ updates: { updatedRows: 1 } }), { status: 200 });
    };
    const written = await appendSheetsRows(
      { spreadsheetId: "sheet123", authToken: "tok" },
      [["2026-06-29", "Atlas", 14]],
      { fetch: mockFetch },
    );
    expect(written).toBe(1);
    expect(captured).not.toBeNull();
    const got = captured as unknown as { url: string; body: string };
    expect(got.url).toContain("sheets.googleapis.com/v4/spreadsheets/sheet123");
    expect(got.body).toContain("Atlas");
  });

  it("degrades to 0 when unconfigured", async () => {
    const written = await appendSheetsRows({ spreadsheetId: "", authToken: "" }, [["x"]]);
    expect(written).toBe(0);
  });
});

describe("cli --format sheets (offline)", () => {
  it("report renders tab-separated rows", async () => {
    const out = await runReport({ offline: true, quiet: true, format: "sheets" });
    const [header, data] = out.trim().split("\n");
    expect(header).toContain("deploy_freq_per_day\t");
    expect(data).toContain("Team Atlas\t");
  });

  it("digest renders tab-separated rows", async () => {
    const out = await runDigest({ offline: true, quiet: true, format: "sheets" });
    expect(out).toContain("slo_attainment_pct");
  });
});
