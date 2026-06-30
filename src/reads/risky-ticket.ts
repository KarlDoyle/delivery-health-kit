/**
 * Risky-Ticket Spotlight — kit slice 4 of the Delivery Health Check.
 *
 * Paste a ticket export → the 3–5 tickets worth raising in a retro/1:1, with the
 * reason, blameless. Same principle as the Sprint Health Read: the flag rules,
 * the severity scoring and the ranking are computed deterministically in code —
 * an LLM is never needed for the maths or the shortlist. Flag rules are from
 * Karl's Sprint Intelligence Epic 2 specs.
 *
 * Blameless by construction: this scores the WORK (staleness, review wait,
 * blockers), never a person — there is no per-individual signal anywhere here.
 */

/** One ticket from a tracker export. Only key/title/status are required. */
export interface RiskyTicketInput {
  key: string;
  title: string;
  status: string;
  daysSinceUpdate?: number;
  hasEstimate?: boolean;
  reviewers?: number;
  blocked?: boolean;
  reopened?: number;
  daysInReview?: number;
}

type FlagKey = "stale" | "no-estimate" | "no-reviewers" | "blocked" | "reopened" | "slow-review";

interface Flag {
  key: FlagKey;
  label: string;
  severity: number;
}

export interface RiskyTicket {
  key: string;
  title: string;
  flags: string[];
  score: number;
  reason: string;
  /** A blameless opening question for the retro/1:1. */
  question: string;
}

export interface RiskyTicketRead {
  totalTickets: number;
  shortlist: RiskyTicket[];
  pattern: string;
  fixFirst: string;
}

/** No update in this many days = stale. */
const STALE_DAYS = 7;
/** In review beyond this many days = slow review (a normal cycle is ~2–3 days). */
const SLOW_REVIEW_DAYS = 3;
/** How many tickets the shortlist surfaces. */
const SHORTLIST_MAX = 5;

/** Deterministic flag evaluation for one ticket. */
function flagsFor(t: RiskyTicketInput): Flag[] {
  const flags: Flag[] = [];
  if (t.daysSinceUpdate !== undefined && t.daysSinceUpdate >= STALE_DAYS) {
    flags.push({ key: "stale", label: `stale ${t.daysSinceUpdate}d`, severity: 2 });
  }
  if (t.hasEstimate === false) {
    flags.push({ key: "no-estimate", label: "no estimate", severity: 1 });
  }
  if (t.reviewers === 0) {
    flags.push({ key: "no-reviewers", label: "0 reviewers", severity: 1 });
  }
  if (t.blocked) {
    flags.push({ key: "blocked", label: "blocked", severity: 3 });
  }
  if (t.reopened !== undefined && t.reopened > 0) {
    flags.push({ key: "reopened", label: `reopened ${t.reopened}×`, severity: 2 });
  }
  if (t.daysInReview !== undefined && t.daysInReview > SLOW_REVIEW_DAYS) {
    flags.push({ key: "slow-review", label: `in review ${t.daysInReview}d`, severity: 2 });
  }
  return flags;
}

const QUESTION: Record<FlagKey, string> = {
  blocked: "What's the blocker here, and who owns clearing it?",
  "slow-review": "This has been waiting on review — what would help it move?",
  "no-reviewers": "This has been waiting on review — what would help it move?",
  reopened: "It's been reopened — is the root cause actually understood?",
  stale: "This has been quiet for a while — what would help it move?",
  "no-estimate": "There's no estimate on this — is the scope actually clear?",
};

const PATTERN: Record<FlagKey, string> = {
  "slow-review":
    "review is the bottleneck, not the coding — work stalls after it's written, waiting on someone.",
  "no-reviewers":
    "review is the bottleneck, not the coding — work stalls after it's written, waiting on someone.",
  blocked: "blockers are stalling delivery — work is waiting on dependencies, not effort.",
  stale: "work is going quiet — tickets stall without anyone noticing.",
  "no-estimate": "scope isn't pinned down — unestimated work is hard to protect or finish.",
  reopened: "rework is recurring — fixes aren't landing first time.",
};

const FIX_FIRST: Record<FlagKey, string> = {
  "slow-review": "Set a review-response SLA (or a WIP limit) so tickets don't sit unreviewed.",
  "no-reviewers": "Set a review-response SLA (or a WIP limit) so tickets don't sit unreviewed.",
  blocked: "Make blockers visible daily and put a named owner on clearing each one.",
  stale: "Add a staleness check to standup — anything quiet 7+ days gets a decision.",
  "no-estimate": "No ticket enters the sprint without an estimate and an owner.",
  reopened: "Add a 'done means done' check — reopened work gets a root-cause, not just a re-fix.",
};

/** The most common flag category across a set of tickets (for pattern + fix). */
function dominantFlag(tickets: RiskyTicket[], flagsByKey: Map<string, Flag[]>): FlagKey | null {
  const counts = new Map<FlagKey, number>();
  for (const t of tickets) {
    for (const f of flagsByKey.get(t.key) ?? []) {
      counts.set(f.key, (counts.get(f.key) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] ?? null;
}

/**
 * Compute the Risky-Ticket Spotlight: flag every ticket, score by flag count +
 * severity, shortlist the riskiest 3–5, and derive the shared pattern + the one
 * fix. Pure function — deterministic, snapshot-testable.
 */
export function computeRiskyTickets(tickets: RiskyTicketInput[]): RiskyTicketRead {
  const flagsByKey = new Map<string, Flag[]>();
  const scored: RiskyTicket[] = [];

  for (const t of tickets) {
    const flags = flagsFor(t);
    flagsByKey.set(t.key, flags);
    if (flags.length === 0) continue;
    const score = flags.reduce((s, f) => s + f.severity, 0);
    const topFlag = [...flags].sort((a, b) => b.severity - a.severity)[0];
    scored.push({
      key: t.key,
      title: t.title,
      flags: flags.map((f) => f.label),
      score,
      reason: flags.map((f) => f.label).join(", "),
      question: topFlag ? QUESTION[topFlag.key] : "What would help this move?",
    });
  }

  // Rank: highest score first, then most flags, then key (stable).
  scored.sort(
    (a, b) => b.score - a.score || b.flags.length - a.flags.length || a.key.localeCompare(b.key),
  );
  const shortlist = scored.slice(0, SHORTLIST_MAX);

  const dom = dominantFlag(shortlist, flagsByKey);
  const pattern = dom
    ? PATTERN[dom]
    : "no tickets crossed a risk threshold — the board looks healthy.";
  const fixFirst = dom
    ? FIX_FIRST[dom]
    : "Keep the cadence — nothing needs a process change this sprint.";

  return { totalTickets: tickets.length, shortlist, pattern, fixFirst };
}

/** Render the read as the canonical one-screen Markdown. */
export function renderRiskyTicketMarkdown(read: RiskyTicketRead): string {
  const lines: string[] = ["# Risky-Ticket Spotlight", ""];
  lines.push(`_${read.totalTickets} tickets scanned · ${read.shortlist.length} worth raising_`, "");

  lines.push("## The shortlist", "");
  if (read.shortlist.length === 0) {
    lines.push("Nothing crossed a risk threshold — no tickets to flag this sprint.");
  } else {
    read.shortlist.forEach((t, i) => {
      lines.push(
        `${i + 1}. **${t.key} — ${t.title}** — ${t.reason}. *(${t.flags.length} flag${t.flags.length === 1 ? "" : "s"})*`,
      );
    });
  }
  lines.push("", "## The pattern", "", read.pattern, "");

  if (read.shortlist.length > 0) {
    lines.push("## Talk-track (blameless)", "");
    for (const t of read.shortlist) lines.push(`- **${t.key}:** ${t.question}`);
    lines.push("");
  }
  lines.push("## Fix first", "", read.fixFirst, "");
  return `${lines.join("\n")}\n`;
}
