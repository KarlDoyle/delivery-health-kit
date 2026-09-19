import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ConnectableSource,
  loadUserConfig,
  saveUserConfig,
  setupChecklist,
  type UserConfig,
} from "./config.js";
import { fetchWithRetry } from "./http.js";
import { createLogger, createSilentLogger, type ILogger, type LogLevel } from "./logger.js";
import {
  computeRiskyTickets,
  type RiskyTicketInput,
  renderRiskyTicketMarkdown,
} from "./reads/risky-ticket.js";
import {
  computeSprintHealth,
  computeSprintTrend,
  renderSprintHealthMarkdown,
  renderSprintTrendMarkdown,
  type SprintInput,
} from "./reads/sprint-health.js";
import { computeSupportDrag, renderSupportDragMarkdown } from "./reads/support-drag.js";
import {
  type AssembleDigestInput,
  type AssembleInput,
  assembleDigest,
  assembleReport,
} from "./report/assemble.js";
import {
  renderDigestMarkdown,
  renderMarkdown,
  renderScorecardMarkdown,
} from "./report/markdown.js";
import { assembleScorecard } from "./report/scorecard.js";
import {
  appendSheetsRows,
  renderDigestSheetsRows,
  renderSheetsRows,
  type SheetsCell,
} from "./report/sheets.js";
import { renderDigestSlack, renderScorecardSlack, renderSlackBlocks } from "./report/slack.js";
import { deployEventsFromPRs } from "./sources/dora.js";
import {
  loadDigestFixtures,
  loadFixtures,
  loadSampleOrg,
  loadScorecardFixtures,
} from "./sources/fixtures.js";
import { fetchGitHubPRs, type GitHubLiveConfig } from "./sources/github.js";
import { fetchPagerDutyIncidents } from "./sources/pagerduty.js";
import { fetchServiceSlo } from "./sources/prometheus-slo.js";
import { fetchSentryIssues } from "./sources/sentry.js";
import type { SupportThread } from "./sources/support.js";
import type { DeliveryReport, DeliveryScorecard, ReliabilityReport, ServiceSlo } from "./types.js";

export interface ParsedArgs {
  command: string;
  /** Positional arguments after the command (e.g. `connect github`). */
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  // A leading flag (e.g. `dhk --help`) means no subcommand was given.
  const hasCommand = argv[0] !== undefined && !argv[0].startsWith("-");
  const command = hasCommand ? (argv[0] as string) : "";
  const rest = hasCommand ? argv.slice(1) : argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (!tok) continue;
    if (tok === "-h") {
      flags.h = true;
      continue;
    }
    if (!tok.startsWith("--")) {
      positional.push(tok);
      continue;
    }
    const key = tok.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { command, positional, flags };
}

const HELP = `Delivery Health Kit (dhk) — engineering health, team-level only,
your data stays on your machine.

Usage:
  dhk demo                    The sample-org walkthrough (default when unconfigured)
  dhk report [options]        Delivery report — DORA + PR flow, as DX Core 4
  dhk digest [options]        Reliability digest — incidents, errors, SLOs
  dhk connect <source>        Paste a token, see your own data (github | jira |
                              pagerduty | sentry | prometheus)
  dhk scorecard [options]     Compare many teams in one ranked scorecard
  dhk sprint-health [options] Read 1: sprint verdict + scorecard + flags
  dhk sprint-trend [options]  Compare a run of sprints (hero / chaos / laser-focus)
  dhk support-drag [options]  Read 2: is this team a hidden help desk?
  dhk risky-ticket [options]  Read 4: the 3–5 tickets worth raising, blameless

Options:
  --offline                  Use committed synthetic fixtures (default)
  --live                     Fetch live signals from configured sources
  --format <md|slack|sheets> Output format (default: md; sprint reads also take json)
  --team <name>              Team name for live runs (default: from config)
  --since <Nd>               Window, e.g. 14d (default: from config or 14d)
  --in <path>                Input JSON (sprint reads; default: a demo fixture)
  --out <path>               Write to a file instead of stdout
  --push                     With --live: append the row to the configured Google Sheet
  --fixtures <dir>           Override the fixtures directory
  --quiet                    Suppress logs
  -h, --help                 Show this help

First run:
  dhk                        # never an empty screen — the demo runs until you connect
  dhk connect github         # paste one token → your own report, in under 5 minutes
`;

function makeLogger(flags: Record<string, string | boolean>): ILogger {
  if (flags.quiet) return createSilentLogger();
  return createLogger((flags["log-level"] as LogLevel) ?? "info");
}

/** `--since 14d` / `--since 30` → days. */
function parseSinceDays(value: string | boolean | undefined, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const m = value.match(/^(\d+)\s*d?$/i);
  return m ? Number(m[1]) : fallback;
}

/** Normalize + validate `--format`; unknown values fail loud, never silently degrade. */
function normalizeFormat(
  value: string | boolean | undefined,
  allowed: string[] = ["md", "slack", "sheets"],
): string {
  let f = typeof value === "string" ? value : "md";
  if (f === "markdown") f = "md";
  if (!allowed.includes(f)) {
    throw new Error(`Unknown --format "${f}" — expected one of: ${allowed.join(" | ")}.`);
  }
  return f;
}

async function writeOut(output: string, flags: Record<string, string | boolean>): Promise<void> {
  if (typeof flags.out === "string") {
    await mkdir(dirname(flags.out), { recursive: true });
    await writeFile(flags.out, output, "utf8");
  }
}

function sheetsRowsToTsv(rows: SheetsCell[][]): string {
  return `${rows.map((r) => r.join("\t")).join("\n")}\n`;
}

function renderReportOutput(report: DeliveryReport, format: string): string {
  if (format === "slack") return JSON.stringify(renderSlackBlocks(report), null, 2);
  if (format === "sheets") return sheetsRowsToTsv(renderSheetsRows(report));
  return renderMarkdown(report);
}

function renderDigestOutput(digest: ReliabilityReport, format: string): string {
  if (format === "slack") return JSON.stringify(renderDigestSlack(digest), null, 2);
  if (format === "sheets") return sheetsRowsToTsv(renderDigestSheetsRows(digest));
  return renderDigestMarkdown(digest);
}

function renderScorecardOutput(sc: DeliveryScorecard, format: string): string {
  if (format === "slack") return JSON.stringify(renderScorecardSlack(sc), null, 2);
  return renderScorecardMarkdown(sc);
}

/** Build the report offline from fixtures. Pure of network. */
async function buildOffline(fixturesDir?: string): Promise<DeliveryReport> {
  const fx = await loadFixtures(fixturesDir);
  return assembleReport({
    config: fx.config,
    mode: "offline",
    now: Date.parse(fx.config.asOf),
    sprintName: fx.config.sprintName,
    prs: fx.prs,
    deploys: fx.deploys,
    issues: fx.issues,
    threads: fx.threads,
  });
}

/** Build the digest offline from fixtures. Pure of network. */
async function buildDigestOffline(fixturesDir?: string): Promise<ReliabilityReport> {
  const fx = await loadDigestFixtures(fixturesDir);
  return assembleDigest({
    config: fx.config,
    mode: "offline",
    now: Date.parse(fx.config.asOf),
    incidents: fx.incidents,
    sentryIssues: fx.sentryIssues,
    slo: fx.slo,
    deploys: fx.deploys,
  });
}

/** Build the multi-site scorecard offline from the `scorecard.json` fixture. */
async function buildScorecardOffline(fixturesDir?: string): Promise<DeliveryScorecard> {
  const fx = await loadScorecardFixtures(fixturesDir);
  const now = Date.parse(fx.asOf);
  const inputs: AssembleInput[] = fx.sites.map((s) => ({
    config: {
      team: s.team,
      periodDays: fx.periodDays,
      repos: s.repos,
      teamMembers: s.teamMembers,
      jiraProjectKey: s.jiraProjectKey,
    },
    mode: "offline",
    now,
    sprintName: s.sprintName,
    prs: s.prs,
    deploys: s.deploys,
    issues: s.issues,
    threads: s.threads,
  }));
  return assembleScorecard(inputs);
}

/** Resolve live settings: user config first, env vars as the override. */
async function liveSettings(
  flags: Record<string, string | boolean>,
): Promise<{ user: UserConfig | null; team: string; periodDays: number }> {
  const user = await loadUserConfig();
  const env = process.env;
  const team =
    (typeof flags.team === "string" ? flags.team : undefined) ??
    env.TEAM_NAME ??
    user?.team ??
    "Team";
  const periodDays = parseSinceDays(flags.since, Number(env.PERIOD_DAYS ?? user?.periodDays ?? 14));
  return { user, team, periodDays };
}

/** Build the report live from configured sources. Needs credentials. */
async function buildLive(
  flags: Record<string, string | boolean>,
  logger: ILogger,
  deps: { fetch?: typeof globalThis.fetch } = {},
): Promise<DeliveryReport> {
  const { user, team, periodDays } = await liveSettings(flags);
  const env = process.env;
  const token = env.GITHUB_TOKEN ?? user?.github?.token;
  const repos =
    (env.GITHUB_REPOS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean).length > 0
      ? (env.GITHUB_REPOS as string)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : (user?.github?.repos ?? []);
  const teamMembers =
    (env.TEAM_MEMBERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean).length > 0
      ? (env.TEAM_MEMBERS as string)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : (user?.teamMembers ?? []);

  const config = {
    team,
    periodDays,
    repos,
    teamMembers,
    jiraProjectKey: env.JIRA_PROJECT_KEY ?? user?.jira?.projectKey,
  };

  let prs: Awaited<ReturnType<typeof fetchGitHubPRs>> | undefined;
  if (token) {
    const ghConfig: GitHubLiveConfig = {
      ...config,
      token,
      org: env.GITHUB_ORG ?? user?.github?.org,
    };
    prs = await fetchGitHubPRs(ghConfig, { logger, fetch: deps.fetch });
  } else {
    logger.warn("GitHub not connected; run `dhk connect github` (GitHub section omitted)");
  }

  // Zero-config deploy signal: merges to the default branch are deploys.
  // Orgs with a real deploy log configure that source instead (see README).
  const deploys = prs ? deployEventsFromPRs(prs) : undefined;

  return assembleReport({ config, mode: "live", now: Date.now(), prs, deploys });
}

/** Build the digest live from configured sources. Needs credentials. */
async function buildDigestLive(
  flags: Record<string, string | boolean>,
  logger: ILogger,
): Promise<ReliabilityReport> {
  const { user, team, periodDays } = await liveSettings(flags);
  const env = process.env;
  const config = { team, periodDays, repos: [], teamMembers: [] };
  const input: AssembleDigestInput = { config, mode: "live", now: Date.now() };

  const pdKey = env.PAGERDUTY_API_KEY ?? user?.pagerduty?.apiKey;
  if (pdKey) {
    input.incidents = await fetchPagerDutyIncidents(
      {
        apiKey: pdKey,
        serviceIds: user?.pagerduty?.serviceIds,
        apiHost: user?.pagerduty?.apiHost,
        periodDays,
      },
      { logger },
    );
  } else {
    logger.warn("PagerDuty not connected; run `dhk connect pagerduty` (incidents omitted)");
  }

  const sentryOrg = env.SENTRY_ORG ?? user?.sentry?.org;
  const sentryToken = env.SENTRY_AUTH_TOKEN ?? user?.sentry?.authToken;
  if (sentryOrg && sentryToken) {
    input.sentryIssues = await fetchSentryIssues(
      { org: sentryOrg, authToken: sentryToken, host: user?.sentry?.host, periodDays },
      { logger },
    );
  }

  if (user?.prometheus?.queryUrl && user.prometheus.services?.length) {
    const promConfig = {
      queryUrl: user.prometheus.queryUrl,
      authToken: env.PROMETHEUS_AUTH_TOKEN ?? user.prometheus.authToken,
    };
    const results: ServiceSlo[] = [];
    for (const svc of user.prometheus.services) {
      results.push(await fetchServiceSlo(promConfig, svc, { logger }));
    }
    input.slo = results;
  }

  return assembleDigest(input);
}

export async function runReport(
  flags: Record<string, string | boolean>,
  deps: { fetch?: typeof globalThis.fetch } = {},
): Promise<string> {
  const logger = makeLogger(flags);
  const format = normalizeFormat(flags.format);
  const live = Boolean(flags.live);
  logger.info(`Building delivery report (${live ? "live" : "offline"}, ${format})`);

  const report = live
    ? await buildLive(flags, logger, deps)
    : await buildOffline(typeof flags.fixtures === "string" ? flags.fixtures : undefined);

  const output = renderReportOutput(report, format);
  await pushToSheetsIfAsked(renderSheetsRows(report), flags, logger);
  await writeOut(output, flags);
  return output;
}

export async function runDigest(flags: Record<string, string | boolean>): Promise<string> {
  const logger = makeLogger(flags);
  const format = normalizeFormat(flags.format);
  const live = Boolean(flags.live);
  logger.info(`Building reliability digest (${live ? "live" : "offline"}, ${format})`);

  const digest = live
    ? await buildDigestLive(flags, logger)
    : await buildDigestOffline(typeof flags.fixtures === "string" ? flags.fixtures : undefined);

  const output = renderDigestOutput(digest, format);
  await pushToSheetsIfAsked(renderDigestSheetsRows(digest), flags, logger);
  await writeOut(output, flags);
  return output;
}

/** `--push --live` appends the row to the configured Sheet. */
async function pushToSheetsIfAsked(
  rows: SheetsCell[][],
  flags: Record<string, string | boolean>,
  logger: ILogger,
): Promise<void> {
  if (!flags.push) return;
  if (!flags.live) {
    // Guard: never let synthetic fixture rows land in a real spreadsheet.
    logger.warn("--push only applies with --live (offline rows are synthetic); skipping");
    return;
  }
  const user = await loadUserConfig();
  const spreadsheetId = user?.sheets?.spreadsheetId;
  const authToken = process.env.SHEETS_AUTH_TOKEN;
  if (!spreadsheetId || !authToken) {
    logger.warn(
      "Sheets push needs a configured spreadsheetId + SHEETS_AUTH_TOKEN (e.g. `gcloud auth print-access-token`); skipping",
    );
    return;
  }
  // Append only the data row — the header is a one-time manual paste.
  const dataRows = rows.slice(1);
  const written = await appendSheetsRows(
    { spreadsheetId, authToken, range: user?.sheets?.range },
    dataRows,
    { logger },
  );
  logger.info(written > 0 ? `Appended ${written} row(s) to Google Sheets` : "Sheets append failed");
}

export async function runScorecard(flags: Record<string, string | boolean>): Promise<string> {
  const logger = makeLogger(flags);
  const format = normalizeFormat(flags.format, ["md", "slack"]);
  logger.info(`Building delivery scorecard (offline, ${format})`);
  const sc = await buildScorecardOffline(
    typeof flags.fixtures === "string" ? flags.fixtures : undefined,
  );
  const output = renderScorecardOutput(sc, format);
  await writeOut(output, flags);
  return output;
}

// --- Demo: the never-empty first run ---

export async function runDemo(flags: Record<string, string | boolean>): Promise<string> {
  const dir = typeof flags.fixtures === "string" ? flags.fixtures : undefined;
  const org = await loadSampleOrg(dir);
  const now = Date.parse(org.asOf);
  const showcase = org.teams[0];
  const parts: string[] = [];

  if (showcase) {
    const teamConfig = {
      team: showcase.team,
      periodDays: org.periodDays,
      repos: showcase.repos,
      teamMembers: showcase.teamMembers,
      jiraProjectKey: showcase.jiraProjectKey,
    };
    const report = assembleReport({
      config: teamConfig,
      mode: "offline",
      now,
      sprintName: showcase.sprintName,
      prs: showcase.prs,
      deploys: showcase.deploys,
      issues: showcase.issues,
      threads: showcase.threads,
    });
    const digest = assembleDigest({
      config: teamConfig,
      mode: "offline",
      now,
      incidents: showcase.incidents,
      sentryIssues: showcase.sentryIssues,
      slo: showcase.slo,
      deploys: showcase.deploys,
    });
    parts.push(renderMarkdown(report), renderDigestMarkdown(digest));
  }

  const inputs: AssembleInput[] = org.teams.map((t) => ({
    config: {
      team: t.team,
      periodDays: org.periodDays,
      repos: t.repos,
      teamMembers: t.teamMembers,
      jiraProjectKey: t.jiraProjectKey,
    },
    mode: "offline" as const,
    now,
    sprintName: t.sprintName,
    prs: t.prs,
    deploys: t.deploys,
    issues: t.issues,
    threads: t.threads,
  }));
  parts.push(renderScorecardMarkdown(assembleScorecard(inputs)));

  const user = await loadUserConfig();
  parts.push(
    [
      "---",
      "",
      `**This is sample data** (the fictional "${org.org}" org).`,
      "",
      setupChecklist(user),
      "",
      "Run `dhk connect github` to see your own team — about 2 minutes.",
    ].join("\n"),
  );

  const output = parts.join("\n");
  await writeOut(output, flags);
  return output;
}

// --- Connect: paste a token, see your own data ---

/**
 * Prompt without echoing the input (tokens never hit the terminal).
 *
 * Deliberately NOT a readline interface: readline echoes typed characters to
 * its output even in raw mode, which would land the pasted token in terminal
 * scrollback. This reads raw keypresses directly and never writes them back.
 * A closed / non-TTY stdin with no line rejects, so scripts fail loud instead
 * of "succeeding" with nothing saved.
 */
async function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;
    if (stdin.isTTY) stdin.setRawMode(true);
    let value = "";
    let settled = false;

    const cleanup = (): void => {
      settled = true;
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    const finish = (): void => {
      cleanup();
      process.stdout.write("\n");
      resolve(value.trim());
    };
    const onEnd = (): void => {
      if (settled) return;
      // Piped input that ends without a newline still counts if non-empty.
      if (value.trim()) {
        finish();
        return;
      }
      cleanup();
      process.stdout.write("\n");
      reject(new Error("No input received (stdin closed) — pass the value via a flag instead."));
    };
    const onError = (err: Error): void => {
      if (settled) return;
      cleanup();
      reject(err);
    };
    const onData = (chunk: Buffer): void => {
      const c = chunk.toString("utf8");
      if (c === "\n" || c === "\r" || c === "\u0004") {
        finish();
        return;
      }
      if (c === "\u0003") {
        // Ctrl-C
        cleanup();
        process.stdout.write("\n");
        process.exit(130);
      }
      if (c === "\u007f" || c === "\b") {
        value = value.slice(0, -1);
        return;
      }
      value += c;
    };
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onError);
    stdin.resume();
  });
}

interface ConnectDeps {
  fetch?: typeof globalThis.fetch;
  prompt?: (question: string) => Promise<string>;
}

/** GitHub connect: validate token, discover repos, save, run the first report. */
async function connectGitHub(
  flags: Record<string, string | boolean>,
  logger: ILogger,
  deps: ConnectDeps,
): Promise<string> {
  const prompt = deps.prompt ?? promptHidden;
  const token =
    (typeof flags.token === "string" ? flags.token : undefined) ??
    process.env.GITHUB_TOKEN ??
    (await prompt("Paste a GitHub token (classic or fine-grained, repo read scope): "));
  if (!token) throw new Error("No token supplied.");

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "delivery-health-kit",
  };

  // Validate with a whoami call — fail fast, and friendly, on a bad paste.
  const who = await fetchWithRetry(
    "https://api.github.com/user",
    { headers },
    { fetch: deps.fetch, logger, maxRetries: 1 },
  ).catch(() => {
    throw new Error("GitHub rejected the token — check it has repo read scope and try again.");
  });
  const me = (await who.json()) as { login: string };
  logger.info(`Token OK — authenticated as ${me.login}`);

  // Auto-discover repos: the org's (when given) or the user's, most recently
  // pushed first. The user trims the list in config afterwards — never up front.
  const org = typeof flags.org === "string" ? flags.org : undefined;
  const listUrl = org
    ? `https://api.github.com/orgs/${org}/repos?sort=pushed&per_page=20`
    : "https://api.github.com/user/repos?sort=pushed&per_page=20";
  const reposRes = await fetchWithRetry(
    listUrl,
    { headers },
    { fetch: deps.fetch, logger, maxRetries: 1 },
  );
  const repoList = (await reposRes.json()) as Array<{ full_name: string; archived?: boolean }>;
  const repos = repoList.filter((r) => !r.archived).map((r) => r.full_name);
  logger.info(`Discovered ${repos.length} repos${org ? ` in ${org}` : ""}`);

  const existing = (await loadUserConfig()) ?? {};
  const updated: UserConfig = {
    ...existing,
    team: existing.team ?? (typeof flags.team === "string" ? flags.team : (org ?? me.login)),
    periodDays: existing.periodDays ?? 14,
    github: { token, org, repos },
  };
  const path = await saveUserConfig(updated);
  logger.info(`Saved config to ${path} (owner-only permissions)`);

  return updated.team ?? me.login;
}

/** The non-GitHub connects: validate lightly, save, show the checklist. */
async function connectSimple(
  source: ConnectableSource,
  flags: Record<string, string | boolean>,
  logger: ILogger,
  deps: ConnectDeps,
): Promise<void> {
  const prompt = deps.prompt ?? promptHidden;
  const existing = (await loadUserConfig()) ?? {};
  const flag = (k: string): string | undefined =>
    typeof flags[k] === "string" ? (flags[k] as string) : undefined;

  if (source === "pagerduty") {
    const apiKey =
      flag("api-key") ??
      process.env.PAGERDUTY_API_KEY ??
      (await prompt("Paste a PagerDuty API key (read-only): "));
    // fetchWithRetry throws on non-ok — catch for a friendly message.
    await fetchWithRetry(
      "https://api.pagerduty.com/abilities",
      { headers: { Authorization: `Token token=${apiKey}`, Accept: "application/json" } },
      { fetch: deps.fetch, logger, maxRetries: 1 },
    ).catch(() => {
      throw new Error("PagerDuty rejected the key — check it is a valid read-only API key.");
    });
    existing.pagerduty = { apiKey };
  } else if (source === "sentry") {
    const org = flag("org") ?? process.env.SENTRY_ORG ?? (await prompt("Sentry org slug: "));
    const authToken =
      flag("auth-token") ??
      process.env.SENTRY_AUTH_TOKEN ??
      (await prompt("Paste a Sentry auth token: "));
    const host = flag("host") ?? "https://sentry.io";
    await fetchWithRetry(
      `${host}/api/0/organizations/${org}/`,
      { headers: { Authorization: `Bearer ${authToken}`, Accept: "application/json" } },
      { fetch: deps.fetch, logger, maxRetries: 1 },
    ).catch(() => {
      throw new Error("Sentry rejected the token — check the org slug and token scopes.");
    });
    existing.sentry = { org, authToken, host: flag("host") };
  } else if (source === "prometheus") {
    const queryUrl = flag("query-url") ?? (await prompt("PromQL query URL (…/api/v1/query): "));
    existing.prometheus = {
      queryUrl,
      authToken: flag("auth-token"),
      services: existing.prometheus?.services,
    };
    logger.info(
      "Prometheus saved. Add per-service SLO definitions in the config file to unlock SLOs.",
    );
  } else if (source === "jira") {
    const baseUrl =
      flag("base-url") ?? (await prompt("Jira base URL (https://you.atlassian.net): "));
    const email = flag("email") ?? (await prompt("Jira account email: "));
    const apiToken = flag("api-token") ?? (await prompt("Paste a Jira API token: "));
    const projectKey = flag("project") ?? (await prompt("Project key (e.g. ENG): "));
    existing.jira = { baseUrl, email, apiToken, projectKey };
  }

  const path = await saveUserConfig(existing);
  logger.info(`Saved config to ${path} (owner-only permissions)`);
}

export async function runConnect(
  positional: string[],
  flags: Record<string, string | boolean>,
  deps: ConnectDeps = {},
): Promise<string> {
  const logger = makeLogger(flags);
  const source = (positional[0] ?? "") as ConnectableSource;
  const valid: ConnectableSource[] = ["github", "jira", "pagerduty", "sentry", "prometheus"];
  if (!valid.includes(source)) {
    throw new Error(`Usage: dhk connect <${valid.join(" | ")}>`);
  }

  if (source === "github") {
    await connectGitHub(flags, logger, deps);
    const user = await loadUserConfig();
    const checklist = setupChecklist(user);
    // Don't make them type a second command to see their reward: run the
    // first real report right here.
    logger.info("Connected — building your first report…");
    const report = await runReport({ ...flags, live: true, quiet: true }, deps);
    return `${checklist}\n\n${report}`;
  }

  await connectSimple(source, flags, logger, deps);
  const user = await loadUserConfig();
  return `${setupChecklist(user)}\n`;
}

// --- The one-shot reads (unchanged surface) ---

/** Default Sprint Health input fixture, resolved relative to this module. */
function defaultSprintInputPath(): string {
  return fileURLToPath(new URL("../fixtures/sprint-input.json", import.meta.url));
}

export async function runSprintHealth(flags: Record<string, string | boolean>): Promise<string> {
  const inPath = typeof flags.in === "string" ? flags.in : defaultSprintInputPath();
  const input = JSON.parse(await readFile(inPath, "utf8")) as SprintInput;
  const read = computeSprintHealth(input);
  const format = typeof flags.format === "string" ? flags.format : "markdown";
  const output =
    format === "json" ? JSON.stringify(read, null, 2) : renderSprintHealthMarkdown(read);
  await writeOut(output, flags);
  return output;
}

export async function runSprintTrend(flags: Record<string, string | boolean>): Promise<string> {
  const inPath = typeof flags.in === "string" ? flags.in : defaultSprintInputPath();
  const parsed = JSON.parse(await readFile(inPath, "utf8")) as SprintInput | SprintInput[];
  const inputs = Array.isArray(parsed) ? parsed : [parsed];
  const trend = computeSprintTrend(inputs);
  const format = typeof flags.format === "string" ? flags.format : "markdown";
  const output =
    format === "json" ? JSON.stringify(trend, null, 2) : renderSprintTrendMarkdown(trend);
  await writeOut(output, flags);
  return output;
}

export async function runRiskyTicket(flags: Record<string, string | boolean>): Promise<string> {
  const inPath =
    typeof flags.in === "string"
      ? flags.in
      : fileURLToPath(new URL("../fixtures/risky-tickets.json", import.meta.url));
  const tickets = JSON.parse(await readFile(inPath, "utf8")) as RiskyTicketInput[];
  const read = computeRiskyTickets(tickets);
  const format = typeof flags.format === "string" ? flags.format : "markdown";
  const output =
    format === "json" ? JSON.stringify(read, null, 2) : renderRiskyTicketMarkdown(read);
  await writeOut(output, flags);
  return output;
}

export async function runSupportDrag(flags: Record<string, string | boolean>): Promise<string> {
  const inPath =
    typeof flags.in === "string"
      ? flags.in
      : fileURLToPath(new URL("../fixtures/support-drag.json", import.meta.url));
  const threads = JSON.parse(await readFile(inPath, "utf8")) as SupportThread[];
  const read = computeSupportDrag(threads);
  const format = typeof flags.format === "string" ? flags.format : "markdown";
  const output =
    format === "json" ? JSON.stringify(read, null, 2) : renderSupportDragMarkdown(read);
  await writeOut(output, flags);
  return output;
}

export async function main(argv: string[]): Promise<number> {
  const { command, positional, flags } = parseArgs(argv);

  if (flags.help || flags.h || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  // Never an empty screen: bare `dhk` runs the demo until the user connects,
  // then becomes the help (they know the tool by then).
  if (command === "") {
    const user = await loadUserConfig();
    if (user) {
      process.stdout.write(HELP);
      return 0;
    }
    const output = await runDemo(flags);
    process.stdout.write(`${output}\n`);
    return 0;
  }

  const runners: Record<string, () => Promise<string>> = {
    demo: () => runDemo(flags),
    report: () => runReport(flags),
    digest: () => runDigest(flags),
    scorecard: () => runScorecard(flags),
    connect: () => runConnect(positional, flags),
    "sprint-health": () => runSprintHealth(flags),
    "sprint-trend": () => runSprintTrend(flags),
    "risky-ticket": () => runRiskyTicket(flags),
    "support-drag": () => runSupportDrag(flags),
  };

  const runner = runners[command];
  if (!runner) {
    process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
    return 1;
  }

  const output = await runner();
  if (typeof flags.out !== "string") process.stdout.write(`${output}\n`);
  return 0;
}
