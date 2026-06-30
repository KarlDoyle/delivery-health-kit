import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { DeliveryConfig } from "../types.js";
import type { DeployEvent } from "./dora.js";
import type { RawPR } from "./github.js";
import type { RawIssue } from "./jira.js";
import type { SupportThread } from "./support.js";

/**
 * Loads the committed synthetic fixtures that power the fully-offline demo.
 * No network, no creds, no company data — just the JSON in `fixtures/`.
 */

export interface FixtureConfig extends DeliveryConfig {
  /** Reference "now" for the offline run, so date windows are deterministic. */
  asOf: string;
  sprintName?: string;
}

export interface Fixtures {
  config: FixtureConfig;
  prs: RawPR[];
  deploys: DeployEvent[];
  issues: RawIssue[];
  threads: SupportThread[];
}

/** Default fixtures dir: `<repo>/fixtures`, resolved relative to this module. */
export function defaultFixturesDir(): string {
  return fileURLToPath(new URL("../../fixtures/", import.meta.url));
}

async function readJson<T>(dir: string, name: string): Promise<T> {
  const path = `${dir.replace(/\/$/, "")}/${name}`;
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function loadFixtures(dir: string = defaultFixturesDir()): Promise<Fixtures> {
  const [config, prs, deploys, issues, threads] = await Promise.all([
    readJson<FixtureConfig>(dir, "config.json"),
    readJson<RawPR[]>(dir, "github-prs.json"),
    readJson<DeployEvent[]>(dir, "deploys.json"),
    readJson<RawIssue[]>(dir, "jira-issues.json"),
    readJson<SupportThread[]>(dir, "support-threads.json"),
  ]);
  return { config, prs, deploys, issues, threads };
}

/** One team's inlined data inside the multi-site scorecard fixture. */
export interface ScorecardSiteFixture {
  team: string;
  repos: string[];
  teamMembers: string[];
  jiraProjectKey?: string;
  sprintName?: string;
  prs: RawPR[];
  deploys: DeployEvent[];
  issues: RawIssue[];
  threads: SupportThread[];
}

/** The multi-site fixture: a shared window + N sites, for the offline scorecard. */
export interface ScorecardFixtures {
  /** Reference "now" for the offline run, so date windows are deterministic. */
  asOf: string;
  periodDays: number;
  sites: ScorecardSiteFixture[];
}

/** Load the committed multi-site scorecard fixture (`scorecard.json`). */
export async function loadScorecardFixtures(
  dir: string = defaultFixturesDir(),
): Promise<ScorecardFixtures> {
  return readJson<ScorecardFixtures>(dir, "scorecard.json");
}
