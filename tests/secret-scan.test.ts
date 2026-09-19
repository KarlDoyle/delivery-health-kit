import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Generic secret scan — fails the build if anything credential-shaped has been
 * committed. Lifted from moss/tests/boundaries/secret-scan.test.ts and
 * generalised: the scan roots below are simply the dirs a template commits, and
 * missing dirs are skipped, so this file drops into any repo unchanged.
 *
 * Deliberately pattern-based (no entropy heuristics): cheap, deterministic, and
 * it catches the credential shapes that actually leak. `.env.example` files are
 * scanned too — they must only ever hold empty or obvious-placeholder values.
 */
const REPO_ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

const SCAN_ROOTS = ["src", "app", "tests", "scripts", "prompts", "evals", "docs", ".github"];

const SELF = "tests/secret-scan.test.ts";

const TOKEN_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "anthropic api key", re: /\bsk-ant-[A-Za-z0-9-]{20,}\b/ },
  { name: "openai-style api key", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "github personal access token (classic)", re: /\bghp_[A-Za-z0-9]{30,}\b/ },
  { name: "github fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { name: "github oauth/server token", re: /\bgh[ous]_[A-Za-z0-9]{30,}\b/ },
  { name: "aws access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

const SKIP_SUFFIXES = [".lock", ".lockb"];
const SKIP_FILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"];

async function listScannableFiles(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return; // missing root — fine, templates don't all have every dir.
    }
    for (const name of entries) {
      const full = join(dir, name);
      const stats = await stat(full);
      if (stats.isDirectory()) {
        await walk(full);
        continue;
      }
      const rel = relative(REPO_ROOT, full).replace(/\\/g, "/");
      if (rel === SELF) continue;
      if (SKIP_FILES.includes(name)) continue;
      if (SKIP_SUFFIXES.some((s) => rel.endsWith(s))) continue;
      out.push(full);
    }
  }
  for (const root of SCAN_ROOTS) {
    await walk(join(REPO_ROOT, root));
  }
  // Always scan root-level dotenv files — the highest-risk place a key leaks,
  // and the one this scanner claims to cover. SCAN_ROOTS only lists sub-dirs,
  // so without this a key in a committed root `.env.example` is missed.
  try {
    for (const name of await readdir(REPO_ROOT)) {
      if (!/^\.env(\..+)?$/.test(name)) continue;
      const full = join(REPO_ROOT, name);
      if ((await stat(full)).isFile()) out.push(full);
    }
  } catch {
    // no root listing — ignore
  }
  return out;
}

describe("secret scan", () => {
  it("no real-looking tokens or private keys are present in scanned trees", async () => {
    const files = await listScannableFiles();
    const findings: { file: string; pattern: string; match: string }[] = [];
    for (const file of files) {
      const contents = await readFile(file, "utf8").catch(() => "");
      for (const { name, re } of TOKEN_PATTERNS) {
        const m = re.exec(contents);
        if (m) {
          findings.push({
            file: relative(REPO_ROOT, file),
            pattern: name,
            match: `${m[0].slice(0, 12)}…`,
          });
        }
      }
    }
    expect(findings).toEqual([]);
  });
});
