#!/usr/bin/env node
/**
 * Generates the committed `fixtures/sample-org/` dataset: a fictional 3-team
 * org ("Nimbus Labs") covering every source, rich enough that `dhk demo`
 * renders a full, realistic Core-4 report + reliability digest + scorecard.
 *
 * Deterministic (seeded PRNG) so regenerating never churns the diff. No real
 * data, no real names — ever. Team personalities are deliberate:
 *   Orion — healthy (frequent small deploys, few incidents)
 *   Lyra  — middling, support-drag heavy
 *   Vega  — chaotic (reverts, scope creep, SLO breaches)
 *
 * Run: node scripts/generate-sample-org.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "fixtures", "sample-org");

const AS_OF = "2026-06-29T12:00:00Z";
const PERIOD_DAYS = 14;
const asOfMs = Date.parse(AS_OF);
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

// mulberry32 — tiny deterministic PRNG.
function prng(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");
const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const between = (rand, lo, hi) => lo + rand() * (hi - lo);

/** A timestamp `daysBack` days before asOf, jittered into working-ish hours. */
function dayAt(rand, daysBack, hour = null) {
  const h = hour ?? Math.floor(between(rand, 8, 18));
  const m = Math.floor(between(rand, 0, 60));
  return asOfMs - daysBack * DAY - (12 - h) * HOUR + m * MIN;
}

const TEAMS = [
  {
    team: "Orion",
    seed: 101,
    repos: ["nimbus/checkout", "nimbus/payments"],
    teamMembers: ["ada", "grace", "linus", "edsger"],
    jiraProjectKey: "ORI",
    sprintName: "Orion Sprint 31",
    personality: { prsPerDay: 1.6, revertRate: 0.05, fixRate: 0.1, incidents: 3, creep: 0.08 },
  },
  {
    team: "Lyra",
    seed: 202,
    repos: ["nimbus/catalog", "nimbus/search"],
    teamMembers: ["katherine", "alan", "barbara"],
    jiraProjectKey: "LYR",
    sprintName: "Lyra Sprint 27",
    personality: { prsPerDay: 0.9, revertRate: 0.08, fixRate: 0.18, incidents: 5, creep: 0.2 },
  },
  {
    team: "Vega",
    seed: 303,
    repos: ["nimbus/billing", "nimbus/notifications", "nimbus/legacy-sync"],
    teamMembers: ["margaret", "donald", "john", "radia", "vint"],
    jiraProjectKey: "VEG",
    sprintName: "Vega Sprint 19",
    personality: { prsPerDay: 0.5, revertRate: 0.18, fixRate: 0.3, incidents: 9, creep: 0.45 },
  },
];

const PR_TITLES = [
  "Add pagination to listing endpoint",
  "Refactor session cache",
  "Migrate config to typed loader",
  "Tighten input validation",
  "Add retry to outbound webhook",
  "Improve empty-state rendering",
  "Batch nightly reconciliation",
  "Reduce bundle size for dashboard",
  "Add audit log for admin actions",
  "Upgrade framework minor version",
];
const FIX_TITLES = [
  "fix: null check on optional address",
  "fix: race in queue consumer",
  "hotfix: rollback flag for slow query",
  "fix: off-by-one in date window",
];
const ISSUE_TYPES = ["Story", "Task", "Bug", "Tech Debt", "Spike"];
const SUPPORT_ROLES = ["Customer Support", "Sales", "Engineering", "Product", "Data"];
const SUPPORT_TAGS = ["billing", "login", "api", "export", "performance", "permissions"];
const SENTRY_TITLES = [
  "TypeError: cannot read properties of undefined",
  "Connection pool exhausted",
  "Unhandled promise rejection in worker",
  "Deprecated API usage detected",
  "Timeout contacting payment gateway",
  "Cache stampede on catalog refresh",
];

function genTeam(t) {
  const rand = prng(t.seed);
  const p = t.personality;

  // --- PRs ---
  const prs = [];
  const prCount = Math.round(p.prsPerDay * PERIOD_DAYS);
  for (let i = 0; i < prCount + 3; i++) {
    const daysBack = between(rand, 0.2, PERIOD_DAYS - 0.2);
    const created = dayAt(rand, daysBack);
    const cycleH = between(rand, 2, p.creep > 0.3 ? 90 : 30);
    const merged = i < prCount ? created + cycleH * HOUR : null;
    const isFix = rand() < p.fixRate;
    const reviewed = rand() < 0.85;
    prs.push({
      repo: pick(rand, t.repos).split("/")[1],
      number: 100 + i,
      author: pick(rand, t.teamMembers),
      createdAt: iso(created),
      mergedAt: merged ? iso(merged) : null,
      additions: Math.round(between(rand, 8, p.creep > 0.3 ? 900 : 350)),
      deletions: Math.round(between(rand, 2, 120)),
      firstReviewAt: reviewed ? iso(created + between(rand, 0.5, 8) * HOUR) : null,
      title: isFix ? pick(rand, FIX_TITLES) : pick(rand, PR_TITLES),
    });
  }

  // --- Deploys (merged PR → deploy shortly after, plus reverts) ---
  const deploys = [];
  for (const pr of prs) {
    if (!pr.mergedAt) continue;
    const mergedMs = Date.parse(pr.mergedAt);
    const isRevert = rand() < p.revertRate;
    deploys.push({
      repo: pr.repo,
      builtAt: pr.createdAt,
      deployedAt: iso(mergedMs + between(rand, 0.2, 2) * HOUR),
      isRevert,
      isFix: isRevert ? false : /^(fix|hotfix)/i.test(pr.title),
      service: pr.repo,
    });
  }

  // --- Jira issues (with sprint-scope fields for the full sprint model) ---
  const issues = [];
  const issueCount = Math.round(between(rand, 14, 22));
  for (let i = 0; i < issueCount; i++) {
    const added = rand() < p.creep;
    const removed = !added && rand() < 0.06;
    const daysBack = between(rand, 1, PERIOD_DAYS - 1);
    const created = dayAt(rand, added ? daysBack : daysBack + 7);
    const started = created + between(rand, 4, 48) * HOUR;
    const done = rand() < (p.creep > 0.3 ? 0.6 : 0.85) && !removed;
    const doneAt = started + between(rand, 6, 96) * HOUR;
    const type = pick(rand, ISSUE_TYPES);
    issues.push({
      key: `${t.jiraProjectKey}-${200 + i}`,
      type,
      status: done ? "Done" : removed ? "Removed" : "In Progress",
      createdAt: iso(created),
      resolvedAt: done ? iso(doneAt) : null,
      storyPoints: pick(rand, [1, 2, 3, 5, 8]),
      labels: type === "Tech Debt" ? ["refactor"] : type === "Bug" ? ["bug"] : [],
      inProgressAt: iso(started),
      doneAt: done ? iso(doneAt) : null,
      plannedAtSprintStart: !added,
      addedToSprintAt: added ? iso(created) : null,
      removedFromSprintAt: removed ? iso(created + 3 * DAY) : null,
    });
  }

  // --- Support threads ---
  const threads = [];
  const threadCount = t.team === "Lyra" ? 24 : Math.round(between(rand, 6, 12));
  for (let i = 0; i < threadCount; i++) {
    const answered = rand() < 0.9;
    const frt = answered ? Math.round(between(rand, 4, t.team === "Lyra" ? 420 : 120)) : null;
    const status = !answered ? "Unanswered" : rand() < 0.75 ? "Resolved" : "Open";
    threads.push({
      requesterRole: pick(rand, SUPPORT_ROLES),
      firstResponseMinutes: frt,
      resolutionStatus: status,
      tags: [pick(rand, SUPPORT_TAGS)],
    });
  }

  // --- Incidents ---
  const incidents = [];
  for (let i = 0; i < p.incidents; i++) {
    const daysBack = between(rand, 0.5, PERIOD_DAYS - 0.5);
    // Chaotic teams get paged at night; healthy teams mostly in-hours.
    const hour = rand() < (p.creep > 0.3 ? 0.5 : 0.15) ? Math.floor(between(rand, 0, 7)) : null;
    const created = dayAt(rand, daysBack, hour);
    const resolved = rand() < 0.85;
    const ackMin = between(rand, 3, 40);
    const resolveMin = ackMin + between(rand, 15, p.creep > 0.3 ? 600 : 180);
    const high = rand() < 0.55;
    incidents.push({
      id: `${t.jiraProjectKey}-INC-${i + 1}`,
      title: `${pick(rand, SENTRY_TITLES)} (${pick(rand, t.repos).split("/")[1]})`,
      status: resolved ? "resolved" : "triggered",
      createdAt: iso(created),
      acknowledgedAt: iso(created + ackMin * MIN),
      resolvedAt: resolved ? iso(created + resolveMin * MIN) : null,
      urgency: high ? "high" : "low",
      severity: high ? pick(rand, ["P1", "P2"]) : pick(rand, ["P3", "P4"]),
      service: pick(rand, t.repos).split("/")[1],
    });
  }

  // --- Sentry issues ---
  const sentryIssues = [];
  const sentryCount = Math.round(between(rand, 4, 8));
  for (let i = 0; i < sentryCount; i++) {
    const firstDaysBack = between(rand, 1, 40);
    const lastDaysBack = between(rand, 0.1, Math.min(firstDaysBack, PERIOD_DAYS - 0.5));
    sentryIssues.push({
      id: `${t.jiraProjectKey}-S${i + 1}`,
      title: pick(rand, SENTRY_TITLES),
      count: Math.round(between(rand, 3, 200)),
      userCount: Math.round(between(rand, 0, 40)),
      firstSeen: iso(dayAt(rand, firstDaysBack)),
      lastSeen: iso(dayAt(rand, lastDaysBack)),
      level: pick(rand, ["error", "error", "warning", "info"]),
      project: pick(rand, t.repos).split("/")[1],
    });
  }

  // --- SLO positions ---
  const slo = t.repos.map((r) => {
    const name = r.split("/")[1];
    const healthy = rand() > (p.creep > 0.3 ? 0.5 : 0.12);
    const target = pick(rand, [99.5, 99.9, 99.95]);
    const avail = healthy ? target + between(rand, 0.01, 0.08) : target - between(rand, 0.1, 0.6);
    const threshold = pick(rand, [300, 500, 800]);
    const p95 = healthy
      ? threshold * between(rand, 0.4, 0.9)
      : threshold * between(rand, 1.05, 1.8);
    const total = Math.round(between(rand, 50000, 2000000));
    return {
      name,
      availabilityPct: Math.round(avail * 100) / 100,
      availabilityTargetPct: target,
      meetingAvailability: avail >= target,
      p95Ms: Math.round(p95),
      p99Ms: Math.round(p95 * between(rand, 1.5, 2.5)),
      latencyThresholdMs: threshold,
      meetingLatency: p95 > 0 && p95 < threshold,
      totalRequests: total,
      failedRequests: Math.round((total * (100 - avail)) / 100),
    };
  });

  return { prs, deploys, issues, threads, incidents, sentryIssues, slo };
}

// --- Write everything ---
mkdirSync(OUT, { recursive: true });
const write = (rel, data) => writeFileSync(join(OUT, rel), `${JSON.stringify(data, null, 2)}\n`);

write("org.json", {
  org: "Nimbus Labs",
  asOf: AS_OF,
  periodDays: PERIOD_DAYS,
  teams: TEAMS.map(({ team, repos, teamMembers, jiraProjectKey, sprintName }) => ({
    team,
    repos,
    teamMembers,
    jiraProjectKey,
    sprintName,
  })),
});

for (const t of TEAMS) {
  const dir = t.team.toLowerCase();
  mkdirSync(join(OUT, dir), { recursive: true });
  const data = genTeam(t);
  write(`${dir}/github-prs.json`, data.prs);
  write(`${dir}/deploys.json`, data.deploys);
  write(`${dir}/jira-issues.json`, data.issues);
  write(`${dir}/support-threads.json`, data.threads);
  write(`${dir}/incidents.json`, data.incidents);
  write(`${dir}/sentry-issues.json`, data.sentryIssues);
  write(`${dir}/slo.json`, data.slo);
}

console.log(`sample-org written to ${OUT}`);
