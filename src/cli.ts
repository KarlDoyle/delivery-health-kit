import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type ILogger, type LogLevel, createLogger, createSilentLogger } from "./logger.js";
import { assembleReport } from "./report/assemble.js";
import { renderMarkdown } from "./report/markdown.js";
import { renderSlackBlocks } from "./report/slack.js";
import { loadFixtures } from "./sources/fixtures.js";
import { type GitHubLiveConfig, fetchGitHubPRs } from "./sources/github.js";
import type { DeliveryReport } from "./types.js";

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
  dhk report [options]      Build the consolidated EM report

Options:
  --offline                 Use committed synthetic fixtures (default)
  --live                    Fetch live signals from env-configured sources
  --format <markdown|slack> Output format (default: markdown)
  --out <path>              Write to a file instead of stdout
  --fixtures <dir>          Override the fixtures directory
  --quiet                   Suppress logs
  -h, --help                Show this help

Examples:
  dhk report                              # offline markdown to stdout
  dhk report --out output/report.md       # offline markdown to a file
  dhk report --format slack               # offline Slack Block Kit (JSON)
`;

function renderOutput(report: DeliveryReport, format: string): string {
  if (format === "slack") return JSON.stringify(renderSlackBlocks(report), null, 2);
  return renderMarkdown(report);
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

  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  return 1;
}
