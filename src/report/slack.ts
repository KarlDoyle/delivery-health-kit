import type { ILogger } from "../logger.js";
import type { DeliveryReport, DeliveryScorecard, ReliabilityReport } from "../types.js";

/**
 * Slack output.
 *
 * Reused from consolidation/_extracted_capabilities/slack-reporter: the BlockKit
 * builder helpers are lifted verbatim. `renderSlackBlocks` (pure) turns a report
 * into Block Kit so it is testable offline; `postSlackReport` is the live path
 * and needs @slack/web-api + a bot token (documented, not bundled).
 */

export type SlackBlock = Record<string, unknown>;

export const BlockKit = {
  header(text: string): SlackBlock {
    return { type: "header", text: { type: "plain_text", text, emoji: true } };
  },
  section(text: string): SlackBlock {
    return { type: "section", text: { type: "mrkdwn", text } };
  },
  context(text: string): SlackBlock {
    return { type: "context", elements: [{ type: "mrkdwn", text }] };
  },
  divider(): SlackBlock {
    return { type: "divider" };
  },
};

/** The product-enforced stance, shown on every output. */
const BADGE = "team-level only · your data stays on your machine";

/** Pure: report → Slack Block Kit blocks (organised as DX Core 4). */
export function renderSlackBlocks(report: DeliveryReport): SlackBlock[] {
  const blocks: SlackBlock[] = [
    BlockKit.header(`Delivery Health — ${report.team}`),
    BlockKit.context(`Last ${report.periodDays} days · mode: ${report.mode} · ${BADGE}`),
    BlockKit.divider(),
  ];

  if (report.dora) {
    const d = report.dora;
    const cfrLabel = d.cfrBasis === "incident-linked" ? "incident-linked" : "revert proxy";
    if (d.noData) {
      blocks.push(BlockKit.section("*DORA*\n• No deployment data for this measurement window."));
    } else {
      blocks.push(
        BlockKit.section(
          `*Speed*\n• Deploy frequency: ${d.deploymentFrequencyPerDay}/day (${d.classes.deploymentFrequency})\n• Lead time: ${d.leadTimeHours}h (${d.classes.leadTime})`,
        ),
        BlockKit.section(
          `*Quality*\n• Change failure: ${d.changeFailureRatePct}% (${cfrLabel}, ${d.classes.changeFailureRate})\n• Rework rate: ${d.reworkRatePct}%`,
        ),
      );
    }
  }
  if (report.jira) {
    const j = report.jira;
    blocks.push(
      BlockKit.section(
        `*Sprint${j.sprintName ? ` — ${j.sprintName}` : ""}*\n• Closed: ${j.ticketsClosed} (${j.storyPointsCompleted} pts)\n• Lead time median: ${j.leadTime.medianHours}h\n• Mix: ${j.workDistribution.productDelivery}% product / ${j.workDistribution.bugs}% bugs / ${j.workDistribution.techDebt}% tech-debt`,
      ),
    );
  }
  if (report.github) {
    const g = report.github;
    blocks.push(
      BlockKit.section(
        `*PR flow*\n• Merged: ${g.totalMerged}\n• Cycle time: ${g.avgCycleTimeHours}h\n• Time to first review: ${g.avgTimeToFirstReviewHours}h\n• Avg PR size: ${g.avgPRSize} lines`,
      ),
    );
  }
  if (report.support) {
    const s = report.support;
    const frt = s.medianFirstResponseMinutes === null ? "—" : `${s.medianFirstResponseMinutes} min`;
    blocks.push(
      BlockKit.section(
        `*Support*\n• Requests: ${s.totalRequests}\n• Median first response: ${frt}\n• Resolution rate: ${s.resolutionRatePct}%\n• Unanswered: ${s.unansweredCount} · Late: ${s.lateResponseCount}`,
      ),
    );
  }

  return blocks;
}

/** Pure: reliability digest → Slack Block Kit blocks. */
export function renderDigestSlack(digest: ReliabilityReport): SlackBlock[] {
  const blocks: SlackBlock[] = [
    BlockKit.header(`Reliability Digest — ${digest.team}`),
    BlockKit.context(`Last ${digest.periodDays} days · mode: ${digest.mode} · ${BADGE}`),
    BlockKit.divider(),
  ];

  if (digest.dora) {
    const d = digest.dora;
    const cfrLabel = d.cfrBasis === "incident-linked" ? "incident-linked" : "revert proxy";
    const recovery = d.recoveryTime
      ? `\n• Recovery time: median ${d.recoveryTime.medianMinutes} min · p90 ${d.recoveryTime.p90Minutes} min`
      : "";
    blocks.push(
      BlockKit.section(
        d.noData
          ? "*DORA*\n• No deployment data for this measurement window."
          : `*Change failure*\n• CFR: ${d.changeFailureRatePct}% (${cfrLabel}, ${d.classes.changeFailureRate})\n• Rework rate: ${d.reworkRatePct}%${recovery}`,
      ),
    );
  }
  if (digest.incidents) {
    const m = digest.incidents;
    blocks.push(
      BlockKit.section(
        `*Incidents*\n• Total: ${m.totalIncidents} (${m.active} active)\n• Recovery (create→resolve): median ${m.ttm.medianMinutes} min · p90 ${m.ttm.p90Minutes} min\n• Out of hours: ${m.onCall.outOfHoursPct}%${m.onCall.busiestService ? `\n• Busiest service: ${m.onCall.busiestService}` : ""}`,
      ),
    );
  }
  if (digest.errors) {
    const e = digest.errors;
    blocks.push(
      BlockKit.section(
        `*Errors*\n• Unresolved: ${e.totalIssues} (${e.newIssues} new)\n• ${e.byLevel.error} error / ${e.byLevel.warning} warning`,
      ),
    );
  }
  if (digest.slo) {
    const s = digest.slo;
    const breaching = s.services
      .filter((svc) => !(svc.meetingAvailability && svc.meetingLatency))
      .map((svc) => svc.name);
    blocks.push(
      BlockKit.section(
        `*SLOs*\n• Attainment: ${s.attainmentPct}% of ${s.services.length} services${breaching.length ? `\n• Breaching: ${breaching.join(", ")}` : ""}`,
      ),
    );
  }
  return blocks;
}

/** Pure: multi-site scorecard → Slack Block Kit blocks (ranked, with the drag). */
export function renderScorecardSlack(sc: DeliveryScorecard): SlackBlock[] {
  const blocks: SlackBlock[] = [
    BlockKit.header(`Delivery Scorecard — ${sc.sites.length} teams`),
    BlockKit.context(`Last ${sc.periodDays} days · mode: ${sc.mode} · ranked healthiest-first`),
    BlockKit.divider(),
  ];
  const lines = sc.sites
    .map((s, i) => {
      const r = s.report;
      const dora = r.dora ? (r.dora.noData ? "no data" : r.dora.classes.deploymentFrequency) : "—";
      const cycle = r.github ? `${r.github.avgCycleTimeHours}h` : "—";
      const support = r.support ? `${r.support.resolutionRatePct}%` : "—";
      return `${i + 1}. *${s.team}* — score *${s.score}* · DORA ${dora} · cycle ${cycle} · support ${support}`;
    })
    .join("\n");
  blocks.push(BlockKit.section(lines));
  const worst = sc.sites[sc.sites.length - 1];
  if (worst && sc.sites.length > 1) {
    blocks.push(BlockKit.context(`Biggest drag: ${worst.team} (${worst.score})`));
  }
  return blocks;
}

export interface SlackPostConfig {
  botToken: string;
  channelId: string;
}

/**
 * Live path: post the report to Slack. Dynamically imports @slack/web-api so the
 * offline kit has zero Slack dependency. Needs SLACK_BOT_TOKEN + a channel.
 */
export async function postSlackReport(
  config: SlackPostConfig,
  report: DeliveryReport,
  options: { logger?: ILogger } = {},
): Promise<boolean> {
  const { logger } = options;
  if (!config.botToken || !config.channelId) {
    logger?.warn("Slack bot token / channel not provided; skipping Slack post");
    return false;
  }
  try {
    // Optional dependency — only required for the live Slack path, so it is not
    // a declared dependency of the offline kit. Resolved dynamically.
    // @ts-expect-error optional peer dependency, not installed in offline mode
    const mod = (await import("@slack/web-api").catch(() => null)) as {
      WebClient: new (
        token: string,
      ) => {
        chat: {
          postMessage: (a: unknown) => Promise<{ ok?: boolean; ts?: string }>;
        };
      };
    } | null;
    if (!mod) {
      logger?.error("@slack/web-api is not installed — run: pnpm add @slack/web-api");
      return false;
    }
    const client = new mod.WebClient(config.botToken);
    const res = await client.chat.postMessage({
      channel: config.channelId,
      blocks: renderSlackBlocks(report),
      text: `Delivery Health — ${report.team}`,
    });
    return Boolean(res.ok);
  } catch (error) {
    logger?.error("Failed to post to Slack", error);
    return false;
  }
}
