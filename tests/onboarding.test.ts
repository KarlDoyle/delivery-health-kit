import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runConnect, runDemo, runReport } from "../src/cli.js";
import { configPath, loadUserConfig, saveUserConfig, setupChecklist } from "../src/config.js";

/** Every test gets an isolated config dir — never the developer's real one. */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dhk-test-"));
  process.env.DHK_CONFIG_DIR = dir;
});
afterEach(() => {
  delete process.env.DHK_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("user config", () => {
  it("round-trips and writes owner-only permissions", async () => {
    const path = await saveUserConfig({ team: "Atlas", periodDays: 14 });
    expect(path).toBe(configPath());
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    const loaded = await loadUserConfig();
    expect(loaded).toEqual({ team: "Atlas", periodDays: 14 });
  });

  it("returns null when no config exists (the demo-first state)", async () => {
    expect(await loadUserConfig()).toBeNull();
  });
});

describe("setup checklist", () => {
  it("shows every source unconnected with the next step", () => {
    const text = setupChecklist(null);
    expect(text).toContain("GitHub ○");
    expect(text).toContain("PagerDuty ○");
    expect(text).toContain("dhk connect github");
  });

  it("ticks connected sources and advances the next step", () => {
    const text = setupChecklist({
      github: { token: "t", repos: [] },
    });
    expect(text).toContain("GitHub ✓");
    expect(text).toContain("dhk connect jira");
  });
});

describe("dhk demo (the never-empty first run)", () => {
  it("renders the full sample-org walkthrough offline", async () => {
    const out = await runDemo({ quiet: true });
    // A complete Core-4 report for the showcase team…
    expect(out).toContain("# Delivery Health — Orion");
    expect(out).toContain("## Speed");
    expect(out).toContain("## Quality");
    // …the reliability digest…
    expect(out).toContain("# Reliability Digest — Orion");
    // …the cross-team scorecard…
    expect(out).toContain("# Delivery Scorecard — 3 teams");
    // …and the honest sample-data note + the path to their own data.
    expect(out).toContain("This is sample data");
    expect(out).toContain("dhk connect github");
    expect(out).toContain("team-level only · your data stays on your machine");
  });

  it("is deterministic", async () => {
    expect(await runDemo({ quiet: true })).toBe(await runDemo({ quiet: true }));
  });
});

describe("dhk connect github (mocked fetch — no real API calls)", () => {
  /** Mock GitHub API: whoami, repo discovery, then empty PR lists. */
  const mockFetch: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/user")) {
      return new Response(JSON.stringify({ login: "octocat" }), { status: 200 });
    }
    if (url.includes("/repos?") || url.includes("/user/repos")) {
      return new Response(
        JSON.stringify([
          { full_name: "acme/web", archived: false },
          { full_name: "acme/old", archived: true },
          { full_name: "acme/api", archived: false },
        ]),
        { status: 200 },
      );
    }
    // PR list calls for the auto-run first report.
    return new Response(JSON.stringify([]), { status: 200 });
  };

  it("validates the token, discovers repos, saves config and runs the first report", async () => {
    const out = await runConnect(["github"], { token: "tok", quiet: true }, { fetch: mockFetch });

    const saved = await loadUserConfig();
    expect(saved?.github?.token).toBe("tok");
    // Archived repos are dropped at discovery.
    expect(saved?.github?.repos).toEqual(["acme/web", "acme/api"]);
    expect(saved?.team).toBe("octocat");

    // The reward arrives without a second command: checklist + first report.
    expect(out).toContain("GitHub ✓");
    expect(out).toContain("# Delivery Health —");
  });

  it("rejects an unknown source with usage help", async () => {
    await expect(runConnect(["nope"], { quiet: true })).rejects.toThrow(/Usage: dhk connect/);
  });

  it("connects BigQuery and stores the OAuth token in owner-only config", async () => {
    const out = await runConnect(["bigquery"], {
      project: "acme-prod",
      "auth-token": "secret-token",
      table: "deploys.history",
      quiet: true,
    });
    const saved = await loadUserConfig();
    expect(saved?.bigquery).toEqual({
      projectId: "acme-prod",
      authToken: "secret-token",
      table: "deploys.history",
    });
    expect(out).toContain("BigQuery deploys ✓");
  });

  it("uses configured BigQuery deployment data for live reports", async () => {
    await saveUserConfig({
      team: "Atlas",
      github: { token: "github-token", repos: ["acme/web"] },
      bigquery: {
        projectId: "acme-prod",
        authToken: "secret-token",
        query: "SELECT repo, built_at, deployed_at, is_revert FROM deploys",
      },
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const builtAt = String(nowSeconds - 2 * 24 * 60 * 60);
    const deployedAt = String(nowSeconds - 24 * 60 * 60);
    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("bigquery.googleapis.com")) {
        expect(url).toContain("/projects/acme-prod/queries");
        expect(JSON.parse(String(init?.body)).query).toBe(
          "SELECT repo, built_at, deployed_at, is_revert FROM deploys",
        );
        return new Response(
          JSON.stringify({
            jobComplete: true,
            rows: [
              { f: [{ v: "acme/web" }, { v: builtAt }, { v: deployedAt }, { v: "false" }] },
              { f: [{ v: "acme/api" }, { v: builtAt }, { v: deployedAt }, { v: "false" }] },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/pulls?state=closed")) {
        return new Response(
          JSON.stringify([
            {
              number: 1,
              title: "One merged PR",
              created_at: new Date((nowSeconds - 3 * 24 * 60 * 60) * 1000).toISOString(),
              merged_at: new Date((nowSeconds - 24 * 60 * 60) * 1000).toISOString(),
              updated_at: new Date((nowSeconds - 24 * 60 * 60) * 1000).toISOString(),
              user: { login: "dev" },
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes("/reviews")) return new Response(JSON.stringify([]), { status: 200 });
      if (url.endsWith("/pulls/1")) {
        return new Response(JSON.stringify({ additions: 10, deletions: 2 }), { status: 200 });
      }
      throw new Error(`Unexpected mock request: ${url}`);
    };
    const report = await runReport({ live: true, quiet: true }, { fetch: mockFetch });
    // GitHub still supplies PR-flow metrics, but the DORA deployment count comes from BigQuery.
    expect(report).toContain("2 deploys over 14 days.");
  });

  it("falls back to GitHub merges when the configured BigQuery query fails", async () => {
    await saveUserConfig({
      team: "Atlas",
      github: { token: "github-token", repos: ["acme/web"] },
      bigquery: {
        projectId: "acme-prod",
        authToken: "secret-token",
        table: "deploys.history",
      },
    });
    let githubFallbackCalled = false;
    const mockFetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("bigquery.googleapis.com")) {
        return new Response(JSON.stringify({ error: { message: "access denied" } }), {
          status: 200,
        });
      }
      if (url.includes("/repos/acme/web/pulls")) githubFallbackCalled = true;
      return new Response(JSON.stringify([]), { status: 200 });
    };
    await runReport({ live: true, quiet: true }, { fetch: mockFetch });
    expect(githubFallbackCalled).toBe(true);
  });
});
