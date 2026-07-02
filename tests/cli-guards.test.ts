import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs, runReport, runScorecard } from "../src/cli.js";
import { loadUserConfig } from "../src/config.js";

/**
 * Regression tests for the adversarial-review findings — the CLI guard rails:
 * unknown formats fail loud, -h is help, corrupt config is an error not a
 * silent fresh state.
 */

describe("--format validation (never silently degrade)", () => {
  it("rejects an unknown format on report", async () => {
    await expect(runReport({ quiet: true, format: "json" })).rejects.toThrow(
      /Unknown --format "json"/,
    );
  });

  it("rejects sheets on scorecard (not implemented there)", async () => {
    await expect(runScorecard({ quiet: true, format: "sheets" })).rejects.toThrow(
      /Unknown --format "sheets"/,
    );
  });

  it("still accepts the markdown alias", async () => {
    const out = await runReport({ quiet: true, format: "markdown" });
    expect(out).toContain("# Delivery Health");
  });
});

describe("-h short flag", () => {
  it("parses -h as the help flag, not a positional", () => {
    const parsed = parseArgs(["-h"]);
    expect(parsed.flags.h).toBe(true);
    expect(parsed.positional).toEqual([]);
    expect(parsed.command).toBe("");
  });

  it("parses `connect github` positionals alongside flags", () => {
    const parsed = parseArgs(["connect", "github", "--token", "t"]);
    expect(parsed.command).toBe("connect");
    expect(parsed.positional).toEqual(["github"]);
    expect(parsed.flags.token).toBe("t");
  });
});

describe("corrupt config fails loud", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dhk-corrupt-"));
    process.env.DHK_CONFIG_DIR = dir;
  });
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: the env var must actually be removed.
    delete process.env.DHK_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws a clear error instead of treating a broken file as unconfigured", async () => {
    writeFileSync(join(dir, "config.json"), "{ not json !!");
    await expect(loadUserConfig()).rejects.toThrow(/Config file is corrupt/);
  });
});
