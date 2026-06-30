import type {
  DeliveryReport,
  DeliveryScorecard,
  DoraMetrics,
  JiraMetrics,
  SiteScore,
  SupportMetrics,
} from "../types.js";

/**
 * Renders the consolidated report as an EM-facing Markdown document.
 * Pure string in / string out — deterministic, so it is snapshot-testable.
 */

function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

function hours(h: number): string {
  if (h >= 24) return `${(h / 24).toFixed(1)}d`;
  return `${h}h`;
}

function doraSection(d: DoraMetrics): string {
  const rows = [
    ["Deployment frequency", `${d.deploymentFrequencyPerDay}/day`, d.classes.deploymentFrequency],
    ["Lead time for changes", hours(d.leadTimeHours), d.classes.leadTime],
    ["Change failure rate", `${d.changeFailureRatePct}%`, d.classes.changeFailureRate],
  ];
  const body = rows.map(([m, v, c]) => `| ${m} | ${v} | ${c} |`).join("\n");
  return [
    "## DORA",
    "",
    "| Metric | Value | Class |",
    "| --- | --- | --- |",
    body,
    "",
    `${d.totalDeploys} deploys, ${d.totalReverts} reverts over ${d.periodDays} days.`,
  ].join("\n");
}

function jiraSection(j: JiraMetrics): string {
  const wd = j.workDistribution;
  const sprint = j.sprintName ? ` — ${j.sprintName}` : "";
  return [
    `## Sprint / Jira${sprint}`,
    "",
    `- Tickets closed: **${j.ticketsClosed}** (created: ${j.ticketsCreated})`,
    `- Story points completed: **${j.storyPointsCompleted}**`,
    `- Lead time (in-progress → done): avg ${hours(j.leadTime.avgHours)}, median ${hours(
      j.leadTime.medianHours,
    )}, p90 ${hours(j.leadTime.p90Hours)}`,
    "",
    "Work distribution:",
    "",
    "| Product | Bugs | Tech debt | Exploration | Other |",
    "| --- | --- | --- | --- | --- |",
    `| ${wd.productDelivery}% | ${wd.bugs}% | ${wd.techDebt}% | ${wd.exploration}% | ${wd.other}% |`,
  ].join("\n");
}

function githubSection(g: NonNullable<DeliveryReport["github"]>): string {
  const repos = Object.entries(g.byRepo)
    .sort((a, b) => b[1] - a[1])
    .map(([repo, n]) => `${repo} (${n})`)
    .join(", ");
  return [
    "## PR flow (GitHub)",
    "",
    `- PRs merged: **${g.totalMerged}**`,
    `- Avg cycle time: ${hours(g.avgCycleTimeHours)}`,
    `- Avg time to first review: ${hours(g.avgTimeToFirstReviewHours)}`,
    `- Avg PR size: ${g.avgPRSize} lines`,
    `- By repo: ${repos || "—"}`,
  ].join("\n");
}

function supportSection(s: SupportMetrics): string {
  const frt = s.medianFirstResponseMinutes;
  const frtStr = frt === null ? "—" : `${frt} min`;
  const frtFlag =
    frt !== null && frt > s.targets.medianFrtMinutes ? " [over target]" : " [on target]";
  const resFlag =
    s.resolutionRatePct >= s.targets.resolutionRatePct ? " [on target]" : " [below target]";
  const mix = Object.entries(s.requesterMix)
    .sort((a, b) => b[1] - a[1])
    .map(([role, n]) => `${role} (${n})`)
    .join(", ");
  const themes = s.topThemes.map((t) => `${t.theme} (${t.count})`).join(", ");
  return [
    "## Support (Slack)",
    "",
    `- Requests: **${s.totalRequests}**`,
    `- Median first response: ${frtStr} (target < ${s.targets.medianFrtMinutes} min)${frtFlag}`,
    `- Resolution rate: ${s.resolutionRatePct}% (target ≥ ${s.targets.resolutionRatePct}%)${resFlag}`,
    `- Unanswered: ${s.unansweredCount} · Late (>4h): ${s.lateResponseCount}`,
    `- Requester mix: ${mix || "—"}`,
    `- Top themes: ${themes || "—"}`,
  ].join("\n");
}

export function renderMarkdown(report: DeliveryReport): string {
  const parts: string[] = [];
  parts.push(`# Delivery Health — ${report.team}`);
  parts.push("");
  parts.push(
    `_Period: last ${report.periodDays} days · generated ${fmtDate(report.generatedAt)} · mode: ${report.mode}_`,
  );
  parts.push("");
  parts.push(summaryLine(report));

  if (report.dora) parts.push("", doraSection(report.dora));
  if (report.jira) parts.push("", jiraSection(report.jira));
  if (report.github) parts.push("", githubSection(report.github));
  if (report.support) parts.push("", supportSection(report.support));

  if (report.mode === "offline") {
    parts.push(
      "",
      "---",
      "",
      "_Generated offline from synthetic fixtures. Run `dhk report --live` with credentials for real data._",
    );
  }
  return `${parts.join("\n")}\n`;
}

/** Human label for a score dimension key. */
const PART_LABEL: Record<keyof SiteScore["parts"], string> = {
  dora: "DORA",
  prFlow: "PR flow",
  support: "Support",
};

/** The weakest scored dimension of a site (for the "biggest drag" callout). */
function weakestPart(site: SiteScore): string {
  const entries = Object.entries(site.parts) as [keyof SiteScore["parts"], number][];
  const lowest = entries.sort((a, b) => a[1] - b[1])[0];
  if (!lowest) return "no scored signals";
  return PART_LABEL[lowest[0]];
}

/**
 * Renders a multi-site scorecard: every team in one comparison table, ranked
 * healthiest-first, with the biggest drag called out. Pure string out —
 * deterministic and snapshot-testable, like the single-team renderer.
 */
export function renderScorecardMarkdown(sc: DeliveryScorecard): string {
  const parts: string[] = [];
  parts.push(`# Delivery Scorecard — ${sc.sites.length} teams`);
  parts.push("");
  parts.push(
    `_Period: last ${sc.periodDays} days · generated ${fmtDate(sc.generatedAt)} · mode: ${sc.mode}_`,
  );
  parts.push("");
  parts.push(
    "Ranked healthiest-first (score = mean of available DORA / PR-flow / support health).",
  );
  parts.push("");
  parts.push("| Rank | Team | Score | DORA (deploy) | Cycle time | Sprint | Support |");
  parts.push("| --- | --- | --- | --- | --- | --- | --- |");
  sc.sites.forEach((s, i) => {
    const r = s.report;
    const dora = r.dora ? r.dora.classes.deploymentFrequency : "—";
    const cycle = r.github ? hours(r.github.avgCycleTimeHours) : "—";
    const sprint = r.jira
      ? `${r.jira.ticketsClosed} closed / ${r.jira.storyPointsCompleted} pts`
      : "—";
    const support = r.support ? `${r.support.resolutionRatePct}%` : "—";
    parts.push(
      `| ${i + 1} | ${s.team} | **${s.score}** | ${dora} | ${cycle} | ${sprint} | ${support} |`,
    );
  });
  parts.push("");
  const worst = sc.sites[sc.sites.length - 1];
  if (worst && sc.sites.length > 1) {
    parts.push(
      `**Biggest drag: ${worst.team} (${worst.score})** — weakest dimension: ${weakestPart(worst)}.`,
    );
  }
  if (sc.mode === "offline") {
    parts.push(
      "",
      "---",
      "",
      "_Generated offline from synthetic fixtures. Run with live credentials for real data._",
    );
  }
  return `${parts.join("\n")}\n`;
}

/** One-line TL;DR an EM can paste at the top of a standup. */
function summaryLine(r: DeliveryReport): string {
  const bits: string[] = [];
  if (r.jira) bits.push(`${r.jira.ticketsClosed} tickets / ${r.jira.storyPointsCompleted} pts`);
  if (r.github) bits.push(`${r.github.totalMerged} PRs merged`);
  if (r.dora) bits.push(`DORA: deploy ${r.dora.classes.deploymentFrequency.toLowerCase()}`);
  if (r.support) bits.push(`${r.support.totalRequests} support requests`);
  return bits.length ? `**TL;DR:** ${bits.join(" · ")}.` : "";
}
