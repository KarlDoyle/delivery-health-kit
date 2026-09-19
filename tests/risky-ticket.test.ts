import { describe, expect, it } from "vitest";
import {
  computeRiskyTickets,
  type RiskyTicketInput,
  renderRiskyTicketMarkdown,
} from "../src/reads/risky-ticket.js";

const clean: RiskyTicketInput = {
  key: "OK-1",
  title: "Clean",
  status: "In Review",
  daysSinceUpdate: 1,
  hasEstimate: true,
  reviewers: 2,
  blocked: false,
  reopened: 0,
  daysInReview: 1,
};

describe("computeRiskyTickets", () => {
  it("flags a stale, unestimated, unreviewed ticket and skips clean ones", () => {
    const r = computeRiskyTickets([
      clean,
      {
        key: "RISK-1",
        title: "Risky",
        status: "In Progress",
        daysSinceUpdate: 11,
        hasEstimate: false,
        reviewers: 0,
      },
    ]);
    expect(r.totalTickets).toBe(2);
    expect(r.shortlist).toHaveLength(1);
    expect(r.shortlist[0]?.key).toBe("RISK-1");
    expect(r.shortlist[0]?.flags).toEqual(expect.arrayContaining(["no estimate", "0 reviewers"]));
  });

  it("ranks the highest-severity ticket first (blocked + stale beats unestimated)", () => {
    const r = computeRiskyTickets([
      { key: "LOW", title: "low", status: "x", hasEstimate: false },
      { key: "HIGH", title: "high", status: "Blocked", blocked: true, daysSinceUpdate: 9 },
    ]);
    expect(r.shortlist[0]?.key).toBe("HIGH");
    expect(r.shortlist[0]?.question).toMatch(/blocker/i);
    expect(r.pattern).toBeTruthy();
    expect(r.fixFirst).toBeTruthy();
  });

  it("caps the shortlist at five", () => {
    const many: RiskyTicketInput[] = Array.from({ length: 8 }, (_, i) => ({
      key: `R-${i}`,
      title: `t${i}`,
      status: "Blocked",
      blocked: true,
    }));
    expect(computeRiskyTickets(many).shortlist).toHaveLength(5);
  });

  it("a clean board yields an empty shortlist and a healthy pattern", () => {
    const r = computeRiskyTickets([clean]);
    expect(r.shortlist).toHaveLength(0);
    expect(r.pattern).toMatch(/healthy/i);
  });
});

describe("renderRiskyTicketMarkdown", () => {
  it("renders the shortlist, pattern, blameless talk-track and fix", () => {
    const md = renderRiskyTicketMarkdown(
      computeRiskyTickets([
        { key: "RISK-1", title: "Risky", status: "Blocked", blocked: true, daysSinceUpdate: 9 },
      ]),
    );
    expect(md).toContain("# Risky-Ticket Spotlight");
    expect(md).toContain("RISK-1");
    expect(md).toContain("## Talk-track");
    expect(md).toContain("## Fix first");
  });
});
