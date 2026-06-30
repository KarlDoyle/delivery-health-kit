import type { ILogger } from "../logger.js";
import type { DeliveryReport, DeliveryScorecard } from "../types.js";

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

/** Pure: report → Slack Block Kit blocks. */
export function renderSlackBlocks(report: DeliveryReport): SlackBlock[] {
  const blocks: SlackBlock[] = [
    BlockKit.header(`Delivery Health — ${report.team}`),
    BlockKit.context(`Last ${report.periodDays} days · mode: ${report.mode}`),
    BlockKit.divider(),
  ];

  if (report.dora) {
    const d = report.dora;
    blocks.push(
      BlockKit.section(
        `*DORA*\n• Deploy frequency: ${d.deploymentFrequencyPerDay}/day (${d.classes.deploymentFrequency})\n• Lead time: ${d.leadTimeHours}h (${d.classes.leadTime})\n• Change failure: ${d.changeFailureRatePct}% (${d.classes.changeFailureRate})`,
      ),
    );
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
        `*PR flow*\n• Merged: ${g.totalMerged}\n• Cycle time: ${g.avgCycleTimeHours}h\n• Time to first review: ${g.avgTimeToFirstReviewHours}h`,
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
      const dora = r.dora ? r.dora.classes.deploymentFrequency : "—";
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
