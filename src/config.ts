import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * User configuration — written by `dhk connect`, read by every live command.
 *
 * Lives at `~/.config/dhk/config.json` (0600 — it holds tokens), overridable
 * with DHK_CONFIG_DIR for tests. The design rule: the user corrects config
 * after seeing output, they never fill it in up front. `connect` writes
 * sensible discovered defaults; nothing here is required for the demo.
 */

export interface GitHubConnection {
  token: string;
  org?: string;
  /** Discovered at connect time; the user trims rather than assembles. */
  repos: string[];
}

export interface JiraConnection {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
}

export interface PagerDutyConnection {
  apiKey: string;
  serviceIds?: string[];
  apiHost?: string;
}

export interface SentryConnection {
  org: string;
  authToken: string;
  host?: string;
}

export interface PrometheusConnection {
  queryUrl: string;
  authToken?: string;
  /**
   * Per-service SLO definitions (selector, targets, metric preset). Added by
   * the user after connecting — the one place zero-config can't guess.
   */
  services?: Array<{
    name: string;
    selector: string;
    availabilityTargetPct: number;
    latencyThresholdMs: number;
    preset?: "micrometer" | "prometheus-http";
  }>;
}

export interface SheetsConnection {
  spreadsheetId: string;
  range?: string;
}

export interface UserConfig {
  team?: string;
  periodDays?: number;
  teamMembers?: string[];
  github?: GitHubConnection;
  jira?: JiraConnection;
  pagerduty?: PagerDutyConnection;
  sentry?: SentryConnection;
  prometheus?: PrometheusConnection;
  sheets?: SheetsConnection;
}

/** Config directory: DHK_CONFIG_DIR override (tests) or ~/.config/dhk. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DHK_CONFIG_DIR ?? join(homedir(), ".config", "dhk");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "config.json");
}

/**
 * Load the user config; null when none exists yet (the demo-first state).
 * A config that exists but won't parse fails LOUD — treating it as "not
 * configured" would run the demo as if fresh and let the next `connect`
 * silently clobber every other saved token.
 */
export async function loadUserConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<UserConfig | null> {
  let raw: string;
  try {
    raw = await readFile(configPath(env), "utf8");
  } catch {
    return null; // no file yet — the demo-first state
  }
  try {
    return JSON.parse(raw) as UserConfig;
  } catch {
    throw new Error(
      `Config file is corrupt: ${configPath(env)} — fix the JSON or remove the file, then reconnect.`,
    );
  }
}

/** Persist the config with owner-only permissions (it holds tokens). */
export async function saveUserConfig(
  config: UserConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const dir = configDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = configPath(env);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

/** The connectable sources, in checklist order. One is enough to start. */
export const CONNECTABLE_SOURCES = ["github", "jira", "pagerduty", "sentry", "prometheus"] as const;
export type ConnectableSource = (typeof CONNECTABLE_SOURCES)[number];

const SOURCE_LABEL: Record<ConnectableSource, string> = {
  github: "GitHub",
  jira: "Jira",
  pagerduty: "PagerDuty",
  sentry: "Sentry",
  prometheus: "Prometheus",
};

const SOURCE_UNLOCKS: Record<ConnectableSource, string> = {
  github: "DORA + PR flow",
  jira: "sprint model + work mix",
  pagerduty: "incidents + incident-linked CFR",
  sentry: "error budget",
  prometheus: "SLO attainment",
};

/**
 * The progressive setup checklist — each connection unlocks more metrics;
 * one source is enough for a first dashboard.
 */
export function setupChecklist(config: UserConfig | null): string {
  const items = CONNECTABLE_SOURCES.map((s) => {
    const connected = Boolean(config?.[s]);
    return `${SOURCE_LABEL[s]} ${connected ? "✓" : "○"}`;
  });
  const next = CONNECTABLE_SOURCES.find((s) => !config?.[s]);
  const lines = [items.join(" · ")];
  if (next) {
    lines.push(`Next: \`dhk connect ${next}\` unlocks ${SOURCE_UNLOCKS[next]}.`);
  }
  return lines.join("\n");
}
