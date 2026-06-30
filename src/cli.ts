import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type ILogger, type LogLevel, createLogger, createSilentLogger } from "./logger.js";
import {
  type RiskyTicketInput,
  computeRiskyTickets,
  renderRiskyTicketMarkdown,
} from "./reads/risky-ticket.js";
import {
  type SprintInput,
  computeSprintHealth,
  renderSprintHealthMarkdown,
} from "./reads/sprint-health.js";
import { computeSupportDrag, renderSupportDragMarkdown } from "./reads/support-drag.js";
import { type AssembleInput, assembleReport } from "./report/assemble.js";
import { renderMarkdown, renderScorecardMarkdown } from "./report/markdown.js";
import { assembleScorecard } from "./report/scorecard.js";
import { renderScorecardSlack, renderSlackBlocks } from "./report/slack.js";
import { loadFixtures, loadScorecardFixtures } from "./sources/fixtures.js";
import { type GitHubLiveConfig, fetchGitHubPRs } from "./sources/github.js";
import type { SupportThread } from "./sources/support.js";
import type { DeliveryReport, DeliveryScorecard } from "./types.js";

export interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  // A leading flag (e.g. `dhk --help`) means no subcommand was given.
  const hasCommand = argv[0] !== undefined && !argv[0].startsWith("-");
  const command = hasCommand ? (argv[0] as string) : "help";
  const rest = hasCommand ? argv.slice(1) : argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (!tok?.startsWith("--")) continue;
    const key = tok.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
}

const HELP = `Delivery Health Kit (dhk)

Usage:
  dhk report [options]        Build the consolidated EM report (one team)
  dhk scorecard [options]     Compare many teams in one ranked scorecard
  dhk sprint-health [options] Read 1: sprint verdict + scorecard + flags
  dhk support-drag [options]  Read 2: is this team a hidden help desk?
  dhk risky-ticket [options]  Read 4: the 3–5 tickets worth raising, blameless

Options:
  --offline                 Use committed synthetic fixtures (default)
  --live                    Fetch live signals from env-configured sources (report only)
  --format <markdown|slack> Output format (default: markdown; sprint-health: markdown|json)
  --in <path>               Sprint figures JSON (sprint-health; default: a demo fixture)
  --out <path>              Write to a file instead of stdout
  --fixtures <dir>          Override the fixtures directory
  --quiet                   Suppress logs
  -h, --help                Show this help

Examples:
  dhk report                              # offline markdown to stdout
  dhk report --format slack               # offline Slack Block Kit (JSON)
  dhk scorecard                           # many teams → one ranked view
  dhk sprint-health                       # the lead Read from demo figures
  dhk sprint-health --in my-sprint.json   # your own pasted sprint numbers
`;

function renderOutput(report: DeliveryReport, format: string): string {
  if (format === "slack") return JSON.stringify(renderSlackBlocks(report), null, 2);
  return renderMarkdown(report);
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

/** Build the report live from env-configured sources. Needs credentials. */
async function buildLive(logger: ILogger): Promise<DeliveryReport> {
  const env = process.env;
  const periodDays = Number(env.PERIOD_DAYS ?? 14);
  const repos = (env.GITHUB_REPOS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const teamMembers = (env.TEAM_MEMBERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const config = {
    team: env.TEAM_NAME ?? "Team",
    periodDays,
    repos,
    teamMembers,
    jiraProjectKey: env.JIRA_PROJECT_KEY,
  };

  // GitHub is the one live source wired end-to-end here; Jira/DORA/Slack live
  // fetchers follow the same pattern (see README "What needs live creds").
  let prs: Awaited<ReturnType<typeof fetchGitHubPRs>> | undefined;
  if (env.GITHUB_TOKEN) {
    const ghConfig: GitHubLiveConfig = { ...config, token: env.GITHUB_TOKEN, org: env.GITHUB_ORG };
    prs = await fetchGitHubPRs(ghConfig, { logger });
  } else {
    logger.warn("GITHUB_TOKEN not set; GitHub section will be omitted");
  }

  return assembleReport({ config, mode: "live", now: Date.now(), prs });
}

export async function runReport(flags: Record<string, string | boolean>): Promise<string> {
  const quiet = Boolean(flags.quiet);
  const level = (flags["log-level"] as LogLevel) ?? "info";
  const logger = quiet ? createSilentLogger() : createLogger(level);
  const format = typeof flags.format === "string" ? flags.format : "markdown";

  const live = Boolean(flags.live);
  logger.info(`Building delivery report (${live ? "live" : "offline"}, ${format})`);

  const report = live
    ? await buildLive(logger)
    : await buildOffline(typeof flags.fixtures === "string" ? flags.fixtures : undefined);

  const output = renderOutput(report, format);

  if (typeof flags.out === "string") {
    await mkdir(dirname(flags.out), { recursive: true });
    await writeFile(flags.out, output, "utf8");
    logger.info(`Wrote report to ${flags.out}`);
  }
  return output;
}

export async function runScorecard(flags: Record<string, string | boolean>): Promise<string> {
  const quiet = Boolean(flags.quiet);
  const level = (flags["log-level"] as LogLevel) ?? "info";
  const logger = quiet ? createSilentLogger() : createLogger(level);
  const format = typeof flags.format === "string" ? flags.format : "markdown";

  logger.info(`Building delivery scorecard (offline, ${format})`);
  const sc = await buildScorecardOffline(
    typeof flags.fixtures === "string" ? flags.fixtures : undefined,
  );
  const output = renderScorecardOutput(sc, format);

  if (typeof flags.out === "string") {
    await mkdir(dirname(flags.out), { recursive: true });
    await writeFile(flags.out, output, "utf8");
    logger.info(`Wrote scorecard to ${flags.out}`);
  }
  return output;
}

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

  if (typeof flags.out === "string") {
    await mkdir(dirname(flags.out), { recursive: true });
    await writeFile(flags.out, output, "utf8");
  }
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
  if (typeof flags.out === "string") {
    await mkdir(dirname(flags.out), { recursive: true });
    await writeFile(flags.out, output, "utf8");
  }
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
  if (typeof flags.out === "string") {
    await mkdir(dirname(flags.out), { recursive: true });
    await writeFile(flags.out, output, "utf8");
  }
  return output;
}

export async function main(argv: string[]): Promise<number> {
  const { command, flags } = parseArgs(argv);

  if (flags.help || flags.h || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  if (command === "report") {
    const output = await runReport(flags);
    if (typeof flags.out !== "string") process.stdout.write(`${output}\n`);
    return 0;
  }

  if (command === "scorecard") {
    const output = await runScorecard(flags);
    if (typeof flags.out !== "string") process.stdout.write(`${output}\n`);
    return 0;
  }

  if (command === "sprint-health") {
    const output = await runSprintHealth(flags);
    if (typeof flags.out !== "string") process.stdout.write(`${output}\n`);
    return 0;
  }

  if (command === "risky-ticket") {
    const output = await runRiskyTicket(flags);
    if (typeof flags.out !== "string") process.stdout.write(`${output}\n`);
    return 0;
  }

  if (command === "support-drag") {
    const output = await runSupportDrag(flags);
    if (typeof flags.out !== "string") process.stdout.write(`${output}\n`);
    return 0;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  return 1;
}
