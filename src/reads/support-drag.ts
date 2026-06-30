/**
 * Support-Drag Lens — kit slice 2 of the Delivery Health Check.
 *
 * Paste a support-channel export → a Support Health Read: is this team a hidden
 * internal help desk, and how heavy is the load? Reuses the existing, tested
 * `computeSupportMetrics` connector for the numbers (FRT, resolution, unanswered,
 * late, requester mix) and adds only the deterministic bands + verdict on top —
 * same "data constant, AI is the flavour" principle as the Sprint Health Read.
 *
 * **Team-level only by design** — never names, ranks, or reports on individuals,
 * which removes the HR/privacy objection that kills most Slack analytics.
 */

import { type SupportThread, computeSupportMetrics } from "../sources/support.js";
import { type Band, bandEmoji } from "./sprint-health.js";

export interface SupportDragMetric {
  label: string;
  value: string;
  benchmark: string;
  band: Band;
}

export interface SupportDragRead {
  verdict: string;
  verdictReason: string;
  metrics: SupportDragMetric[];
  hiddenLoad: { requests: number; estHours: number; topRequester: string | null; topShare: number };
  flags: string[];
  fixFirst: string;
}

/** ~20 minutes of handling per request — the rough hidden-cost multiplier. */
const MINUTES_PER_REQUEST = 20;

function frtBand(mins: number | null): Band {
  if (mins === null) return "red"; // nothing was answered
  if (mins < 60) return "green";
  if (mins <= 240) return "amber";
  return "red";
}

/** Higher-is-better band from explicit thresholds. */
function higherBand(pct: number, green: number, amber: number): Band {
  if (pct >= green) return "green";
  if (pct >= amber) return "amber";
  return "red";
}

/** Lower-is-better band from explicit thresholds. */
function lowerBand(pct: number, green: number, amber: number): Band {
  if (pct < green) return "green";
  if (pct <= amber) return "amber";
  return "red";
}

function frtLabel(mins: number | null): string {
  if (mins === null) return "—";
  if (mins < 60) return `${Math.round(mins)}m`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

/** The biggest requester and its share of total volume. */
function topRequester(
  mix: Record<string, number>,
  total: number,
): { name: string | null; share: number } {
  const ranked = Object.entries(mix).sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  if (!top || total === 0) return { name: null, share: 0 };
  return { name: top[0], share: Math.round((top[1] / total) * 100) };
}

/**
 * Compute the Support Health Read. Pure function over the tested support metrics;
 * deterministic and snapshot-testable.
 */
export function computeSupportDrag(threads: SupportThread[]): SupportDragRead {
  const m = computeSupportMetrics(threads);
  const total = m.totalRequests;
  const unansweredRate = total > 0 ? (m.unansweredCount / total) * 100 : 0;
  const lateRate = total > 0 ? (m.lateResponseCount / total) * 100 : 0;

  const frtB = frtBand(m.medianFirstResponseMinutes);
  const resB = higherBand(m.resolutionRatePct, 85, 70);
  const unansB = lowerBand(unansweredRate, 5, 10);
  const lateB = lowerBand(lateRate, 10, 25);

  const metrics: SupportDragMetric[] = [
    {
      label: "Median first response",
      value: frtLabel(m.medianFirstResponseMinutes),
      benchmark: "< 60m",
      band: frtB,
    },
    { label: "Resolution rate", value: `${m.resolutionRatePct}%`, benchmark: "≥ 85%", band: resB },
    {
      label: "Unanswered",
      value: `${Math.round(unansweredRate)}%`,
      benchmark: "< 5%",
      band: unansB,
    },
    { label: "Late (>4h)", value: `${Math.round(lateRate)}%`, benchmark: "< 10%", band: lateB },
  ];

  const bands = [frtB, resB, unansB, lateB];
  const anyRed = bands.includes("red");
  const anyAmber = bands.includes("amber");

  let verdict: string;
  let verdictReason: string;
  if (total === 0) {
    verdict = "no load";
    verdictReason = "no support requests in this export — nothing to read.";
  } else if (anyRed) {
    verdict = "heavy hidden load";
    verdictReason =
      "this channel is an unmanaged help desk, and requests are being dropped or badly delayed.";
  } else if (anyAmber) {
    verdict = "moderate hidden load";
    verdictReason =
      "the channel carries real unmanaged load — it's coping, but the bar is slipping.";
  } else {
    verdict = "managed";
    verdictReason = "support load is visible and within target — no hidden drag.";
  }

  const top = topRequester(m.requesterMix, total);
  const hiddenLoad = {
    requests: total,
    estHours: Math.round((total * MINUTES_PER_REQUEST) / 60),
    topRequester: top.name,
    topShare: top.share,
  };

  const flags: string[] = [];
  if (unansB !== "green") {
    flags.push(
      `${Math.round(unansweredRate)}% of requests went unanswered — people are being quietly dropped, and they'll stop trusting the channel.`,
    );
  }
  if (lateB !== "green") {
    flags.push(
      `${Math.round(lateRate)}% took over 4 hours to get a first response — no response expectation is set.`,
    );
  }
  if (resB !== "green") {
    flags.push(
      `Only ${m.resolutionRatePct}% of requests were resolved — work is leaking out half-finished.`,
    );
  }
  if (top.name && top.share >= 35) {
    flags.push(
      `${top.name} drives ${top.share}% of the volume — likely a few repeating questions a doc could kill.`,
    );
  }
  if (flags.length === 0) {
    flags.push("No material concerns — the channel is answered, resolved and on time.");
  }

  let fixFirst: string;
  if (unansB !== "green" || lateB !== "green") {
    fixFirst =
      "Add a light triage rotation (one owner per day) and one first-response SLA — that moves unanswered and late together.";
  } else if (top.name && top.share >= 35) {
    fixFirst = `Write a short FAQ for ${top.name}'s top theme — kill the repeating questions at source.`;
  } else if (resB !== "green") {
    fixFirst = "Add a 'resolved means resolved' check so partial answers don't quietly close.";
  } else {
    fixFirst = "Hold the cadence — review the channel's numbers weekly so drag can't build unseen.";
  }

  return { verdict, verdictReason, metrics, hiddenLoad, flags, fixFirst };
}

/** Render the Support Health Read as one-screen Markdown. */
export function renderSupportDragMarkdown(read: SupportDragRead): string {
  const lines: string[] = ["# Support Health Read", ""];
  lines.push(`## Verdict: ${read.verdict}`, "", read.verdictReason, "");

  lines.push("## Scorecard", "", "| Metric | Value | Benchmark | |", "| --- | --- | --- | --- |");
  for (const m of read.metrics) {
    lines.push(`| ${m.label} | ${m.value} | ${m.benchmark} | ${bandEmoji(m.band)} |`);
  }

  const hl = read.hiddenLoad;
  const who = hl.topRequester ? ` **${hl.topRequester} sends ${hl.topShare}% of it.**` : "";
  lines.push(
    "",
    "## The hidden load",
    "",
    `~${hl.requests} requests. At ~${MINUTES_PER_REQUEST} min each that's ~${hl.estHours} hours of unbudgeted work.${who}`,
    "",
  );

  lines.push("## Flags", "");
  for (const f of read.flags) lines.push(`- ${f}`);
  lines.push("", "## Fix first", "", read.fixFirst, "");
  return `${lines.join("\n")}\n`;
}
