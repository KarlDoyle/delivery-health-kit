import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { DeliveryConfig, ServiceSlo } from "../types.js";
import type { DeployEvent } from "./dora.js";
import type { RawPR } from "./github.js";
import type { RawIssue } from "./jira.js";
import type { RawIncident } from "./pagerduty.js";
import type { RawSentryIssue } from "./sentry.js";
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

/** The reliability-half fixtures (for `dhk digest`). */
export interface DigestFixtures {
  config: FixtureConfig;
  incidents: RawIncident[];
  sentryIssues: RawSentryIssue[];
  slo: ServiceSlo[];
  deploys: DeployEvent[];
}

export async function loadDigestFixtures(
  dir: string = defaultFixturesDir(),
): Promise<DigestFixtures> {
  const [config, incidents, sentryIssues, slo, deploys] = await Promise.all([
    readJson<FixtureConfig>(dir, "config.json"),
    readJson<RawIncident[]>(dir, "incidents.json"),
    readJson<RawSentryIssue[]>(dir, "sentry-issues.json"),
    readJson<ServiceSlo[]>(dir, "slo.json"),
    readJson<DeployEvent[]>(dir, "deploys.json"),
  ]);
  return { config, incidents, sentryIssues, slo, deploys };
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

// --- Sample org (the `dhk demo` first-run dataset) ---

export interface SampleOrgTeamMeta {
  team: string;
  repos: string[];
  teamMembers: string[];
  jiraProjectKey?: string;
  sprintName?: string;
}

export interface SampleOrgTeam extends SampleOrgTeamMeta {
  prs: RawPR[];
  deploys: DeployEvent[];
  issues: RawIssue[];
  threads: SupportThread[];
  incidents: RawIncident[];
  sentryIssues: RawSentryIssue[];
  slo: ServiceSlo[];
}

export interface SampleOrg {
  org: string;
  asOf: string;
  periodDays: number;
  teams: SampleOrgTeam[];
}

/** Default sample-org dir: `<repo>/fixtures/sample-org`. */
export function defaultSampleOrgDir(): string {
  return fileURLToPath(new URL("../../fixtures/sample-org/", import.meta.url));
}

/** Load the fictional 3-team org that powers the never-empty first run. */
export async function loadSampleOrg(dir: string = defaultSampleOrgDir()): Promise<SampleOrg> {
  const base = dir.replace(/\/$/, "");
  const org = await readJson<{
    org: string;
    asOf: string;
    periodDays: number;
    teams: SampleOrgTeamMeta[];
  }>(base, "org.json");

  const teams = await Promise.all(
    org.teams.map(async (meta) => {
      const teamDir = `${base}/${meta.team.toLowerCase()}`;
      const [prs, deploys, issues, threads, incidents, sentryIssues, slo] = await Promise.all([
        readJson<RawPR[]>(teamDir, "github-prs.json"),
        readJson<DeployEvent[]>(teamDir, "deploys.json"),
        readJson<RawIssue[]>(teamDir, "jira-issues.json"),
        readJson<SupportThread[]>(teamDir, "support-threads.json"),
        readJson<RawIncident[]>(teamDir, "incidents.json"),
        readJson<RawSentryIssue[]>(teamDir, "sentry-issues.json"),
        readJson<ServiceSlo[]>(teamDir, "slo.json"),
      ]);
      return { ...meta, prs, deploys, issues, threads, incidents, sentryIssues, slo };
    }),
  );

  return { org: org.org, asOf: org.asOf, periodDays: org.periodDays, teams };
}
