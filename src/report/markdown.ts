import type {
  DeliveryReport,
  DeliveryScorecard,
  DoraMetrics,
  GitHubMetrics,
  JiraMetrics,
  PagerDutyMetrics,
  ReliabilityReport,
  SentryMetrics,
  SiteScore,
  SloMetrics,
  SupportMetrics,
} from "../types.js";

/**
 * Renders the consolidated report as an EM-facing Markdown document.
 * Pure string in / string out — deterministic, so it is snapshot-testable.
 *
 * Organised as DX Core 4 (Speed · Effectiveness · Quality · Impact), the
 * unifying frame over DORA + SPACE + DevEx. Effectiveness carries an honest
 * note: its full measure is a DevEx pulse survey, so system-side proxies are
 * labelled as such rather than rolled into an invented score (SPACE guardrail:
 * balanced set, no single number).
 */

/** The product-enforced stance, shown on every output. */
export const TEAM_LEVEL_BADGE = "`team-level only · your data stays on your machine`";

function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

function hours(h: number): string {
  if (h >= 24) return `${(h / 24).toFixed(1)}d`;
  return `${h}h`;
}

function minutes(m: number): string {
  if (m >= 60 * 24) return `${(m / (60 * 24)).toFixed(1)}d`;
  if (m >= 60) return `${(m / 60).toFixed(1)}h`;
  return `${m} min`;
}

function cfrLabel(d: DoraMetrics): string {
  return d.cfrBasis === "incident-linked" ? "incident-linked" : "revert-based proxy";
}

// --- Core 4: Speed ---
function speedSection(dora?: DoraMetrics, github?: GitHubMetrics): string | null {
  if (!dora && !github) return null;
  const lines = ["## Speed", ""];
  if (dora) {
    if (dora.noData) {
      lines.push("DORA: **No data** — no deployments in this measurement window.");
    } else {
      lines.push("| Metric | Value | DORA class |", "| --- | --- | --- |");
      lines.push(
        `| Deployment frequency | ${dora.deploymentFrequencyPerDay}/day | ${dora.classes.deploymentFrequency} |`,
      );
      lines.push(
        `| Lead time for changes | ${hours(dora.leadTimeHours)} | ${dora.classes.leadTime} |`,
      );
      lines.push("");
      lines.push(`${dora.totalDeploys} deploys over ${dora.periodDays} days.`);
    }
  }
  if (github) {
    if (dora) lines.push("");
    lines.push(
      `- PR cycle time (open → merge): **${hours(github.avgCycleTimeHours)}** avg`,
      `- Time to first review: **${hours(github.avgTimeToFirstReviewHours)}** avg (the feedback loop)`,
      `- PRs merged: ${github.totalMerged}`,
    );
  }
  return lines.join("\n");
}

// --- Core 4: Effectiveness (system proxies, honestly labelled) ---
function effectivenessSection(github?: GitHubMetrics, jira?: JiraMetrics): string | null {
  if (!github && !jira) return null;
  const lines = ["## Effectiveness", ""];
  if (github) {
    lines.push(
      `- Avg PR size: **${github.avgPRSize} lines** (batch-size health — smaller flows faster)`,
    );
    const repos = Object.entries(github.byRepo)
      .sort((a, b) => b[1] - a[1])
      .map(([repo, n]) => `${repo} (${n})`)
      .join(", ");
    if (repos) lines.push(`- Where the work landed: ${repos}`);
  }
  if (jira) {
    lines.push(
      `- Ticket lead time (in-progress → done): avg ${hours(jira.leadTime.avgHours)}, median ${hours(
        jira.leadTime.medianHours,
      )}, p90 ${hours(jira.leadTime.p90Hours)}`,
    );
  }
  lines.push(
    "",
    "> Effectiveness is fully measured with a DevEx pulse survey (DXI) — not yet connected.",
    "> The figures above are system-side proxies.",
  );
  return lines.join("\n");
}

// --- Core 4: Quality ---
function qualitySection(dora?: DoraMetrics): string | null {
  if (!dora) return null;
  const lines = ["## Quality", ""];
  if (dora.noData) {
    lines.push("No deployment data for this measurement window; quality metrics are unavailable.");
    return lines.join("\n");
  }
  lines.push("| Metric | Value | DORA class |", "| --- | --- | --- |");
  lines.push(
    `| Change failure rate (${cfrLabel(dora)}) | ${dora.changeFailureRatePct}% | ${dora.classes.changeFailureRate} |`,
  );
  lines.push(`| Rework rate (fix/revert deploys) | ${dora.reworkRatePct}% | — |`);
  if (dora.recoveryTime) {
    lines.push(
      `| Failed-deployment recovery time | median ${minutes(dora.recoveryTime.medianMinutes)} · p90 ${minutes(
        dora.recoveryTime.p90Minutes,
      )} | — |`,
    );
  }
  lines.push("");
  lines.push(
    `${dora.totalReverts} reverts, ${dora.totalFixDeploys} fix/revert deploys of ${dora.totalDeploys} total.`,
  );
  if (dora.cfrBasis === "revert-proxy") {
    lines.push(
      "",
      "_CFR shown as a revert-based proxy — connect PagerDuty for the incident-linked figure._",
    );
  }
  return lines.join("\n");
}

// --- Core 4: Impact ---
function impactSection(jira?: JiraMetrics, support?: SupportMetrics): string | null {
  if (!jira && !support) return null;
  const lines = ["## Impact", ""];
  if (jira) {
    const wd = jira.workDistribution;
    const sprint = jira.sprintName ? ` — ${jira.sprintName}` : "";
    const featurePct = wd.productDelivery + wd.exploration;
    const maintenancePct = wd.bugs + wd.techDebt;
    lines.push(
      `**Sprint${sprint}:** ${jira.ticketsClosed} tickets closed (created: ${jira.ticketsCreated}) · ${jira.storyPointsCompleted} story points`,
      "",
      `- Feature vs maintenance: **${featurePct}% / ${maintenancePct}%** (product+exploration vs bugs+tech-debt)`,
      "",
      "| Product | Bugs | Tech debt | Exploration | Other |",
      "| --- | --- | --- | --- | --- |",
      `| ${wd.productDelivery}% | ${wd.bugs}% | ${wd.techDebt}% | ${wd.exploration}% | ${wd.other}% |`,
    );
  }
  if (support) {
    if (jira) lines.push("");
    lines.push(supportBlock(support));
  }
  return lines.join("\n");
}

function supportBlock(s: SupportMetrics): string {
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
    "**Support drag (unplanned load):**",
    "",
    `- Requests: **${s.totalRequests}**`,
    `- Median first response: ${frtStr} (target < ${s.targets.medianFrtMinutes} min)${frtFlag}`,
    `- Resolution rate: ${s.resolutionRatePct}% (target ≥ ${s.targets.resolutionRatePct}%)${resFlag}`,
    `- Unanswered: ${s.unansweredCount} · Late (>4h): ${s.lateResponseCount}`,
    `- Requester mix: ${mix || "—"}`,
    `- Top themes: ${themes || "—"}`,
  ].join("\n");
}

function offlineFooter(command: string): string[] {
  return [
    "",
    "---",
    "",
    `_Generated offline from synthetic fixtures. Run \`dhk ${command} --live\` with credentials for real data._`,
  ];
}

export function renderMarkdown(report: DeliveryReport): string {
  const parts: string[] = [];
  parts.push(`# Delivery Health — ${report.team}`);
  parts.push("");
  parts.push(
    `_Period: last ${report.periodDays} days · generated ${fmtDate(report.generatedAt)} · mode: ${report.mode}_ · ${TEAM_LEVEL_BADGE}`,
  );
  parts.push("");
  parts.push(summaryLine(report));

  const sections = [
    speedSection(report.dora, report.github),
    effectivenessSection(report.github, report.jira),
    qualitySection(report.dora),
    impactSection(report.jira, report.support),
  ];
  for (const s of sections) {
    if (s) parts.push("", s);
  }

  if (report.mode === "offline") parts.push(...offlineFooter("report"));
  return `${parts.join("\n")}\n`;
}

// --- Reliability digest (`dhk digest`) ---

function incidentsSection(m: PagerDutyMetrics): string {
  const severities = Object.entries(m.bySeverity)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([sev, n]) => `${sev} (${n})`)
    .join(", ");
  const services = Object.entries(m.onCall.byService)
    .sort((a, b) => b[1] - a[1])
    .map(([svc, n]) => `${svc} (${n})`)
    .join(", ");
  return [
    "## Incidents",
    "",
    `- Total: **${m.totalIncidents}** (${m.active} active · ${m.resolved} resolved)`,
    `- Urgency: ${m.byUrgency.high} high / ${m.byUrgency.low} low · Severity: ${severities || "—"}`,
    `- Time to detect (create → ack): median ${minutes(m.ttd.medianMinutes)} · p90 ${minutes(m.ttd.p90Minutes)}`,
    `- Recovery time (create → resolve): median ${minutes(m.ttm.medianMinutes)} · p90 ${minutes(m.ttm.p90Minutes)}`,
    "",
    "**On-call load (team-level):**",
    "",
    `- By service: ${services || "—"}`,
    `- Out of hours: ${m.onCall.outOfHoursPct}% of incidents`,
    m.onCall.busiestService
      ? `- Busiest service: ${m.onCall.busiestService}`
      : "- Busiest service: —",
  ].join("\n");
}

function errorsSection(m: SentryMetrics): string {
  const projects = Object.entries(m.byProject)
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `${p} (${n})`)
    .join(", ");
  return [
    "## Errors (error budget)",
    "",
    `- Unresolved issues: **${m.totalIssues}** (${m.newIssues} new this period)`,
    `- Levels: ${m.byLevel.error} error / ${m.byLevel.warning} warning / ${m.byLevel.info} info`,
    `- By project: ${projects || "—"}`,
  ].join("\n");
}

function sloSection(m: SloMetrics): string {
  const lines = [
    "## SLOs",
    "",
    `**Attainment: ${m.attainmentPct}%** of services meeting both availability and latency SLOs.`,
    "",
    "| Service | Availability | Target | p95 latency | Threshold | Status |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const s of m.services) {
    const status = s.noData
      ? "no data"
      : s.meetingAvailability && s.meetingLatency
        ? "meeting"
        : "breaching";
    lines.push(
      `| ${s.name} | ${s.noData ? "—" : `${s.availabilityPct}%`} | ${s.availabilityTargetPct}% | ${s.noData ? "—" : `${s.p95Ms}ms`} | ${s.latencyThresholdMs}ms | ${status} |`,
    );
  }
  return lines.join("\n");
}

/** Render the reliability digest. Same document discipline as the report. */
export function renderDigestMarkdown(digest: ReliabilityReport): string {
  const parts: string[] = [];
  parts.push(`# Reliability Digest — ${digest.team}`);
  parts.push("");
  parts.push(
    `_Period: last ${digest.periodDays} days · generated ${fmtDate(digest.generatedAt)} · mode: ${digest.mode}_ · ${TEAM_LEVEL_BADGE}`,
  );

  if (digest.dora) {
    const d = digest.dora;
    const recovery = d.recoveryTime
      ? ` · recovery median ${minutes(d.recoveryTime.medianMinutes)}`
      : "";
    parts.push(
      "",
      d.noData
        ? "**TL;DR:** DORA: no deployment data for this measurement window."
        : `**TL;DR:** CFR ${d.changeFailureRatePct}% (${cfrLabel(d)}, ${d.classes.changeFailureRate})${recovery} · rework ${d.reworkRatePct}%.`,
    );
  }

  if (digest.incidents) parts.push("", incidentsSection(digest.incidents));
  if (digest.errors) parts.push("", errorsSection(digest.errors));
  if (digest.slo) parts.push("", sloSection(digest.slo));

  if (digest.mode === "offline") parts.push(...offlineFooter("digest"));
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
    `_Period: last ${sc.periodDays} days · generated ${fmtDate(sc.generatedAt)} · mode: ${sc.mode}_ · ${TEAM_LEVEL_BADGE}`,
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
    const dora = r.dora ? (r.dora.noData ? "No data" : r.dora.classes.deploymentFrequency) : "—";
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
  if (r.dora) bits.push(r.dora.noData ? "DORA: no deployment data" : `DORA: deploy ${r.dora.classes.deploymentFrequency.toLowerCase()}`);
  if (r.support) bits.push(`${r.support.totalRequests} support requests`);
  return bits.length ? `**TL;DR:** ${bits.join(" · ")}.` : "";
}
