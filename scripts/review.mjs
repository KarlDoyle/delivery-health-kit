#!/usr/bin/env node
// Standing reviewer — a local, FREE, independent acceptance-gate.
//
// Sends a diff + (optional) spec + the human-owned rubric to a LOCAL Ollama
// model and prints a terse verdict (ACCEPT|REJECT) with a 0-5 score per rubric
// dimension and reasons that cite the specific gap. No paid API key, no cloud:
// it talks only to the Ollama daemon on localhost. If the daemon isn't running
// it degrades gracefully — a clear message and a non-zero exit, never a crash.
//
// Zero dependencies: native node:fetch + node: builtins only, so it runs from a
// bare clone with `node scripts/review.mjs`.
//
// Usage:
//   node scripts/review.mjs [--base <ref>] [--diff <file>] [--spec <file>]
//                           [--rubric <file>] [--model <name>] [--timestamp <iso>]
//                           [--log <file>] [--no-log] [--url <base>]
//
//   --base <ref>     run `git diff <ref>...HEAD` to get the diff (default: main)
//   --diff <file>    read the diff from a file ("-" = stdin) instead of git
//   --spec <file>    acceptance-criteria / spec file the change must satisfy
//   --rubric <file>  rubric file (default: docs/review-rubric.md)
//   --model <name>   Ollama model (default: $REVIEW_MODEL or qwen2.5:3b-instruct)
//   --timestamp <s>  ISO timestamp for the log line (default: now). Pass this in
//                    tests/CI so log output is deterministic — see docs.
//   --log <file>     score-log path (default: reviews/log.jsonl)
//   --no-log         do not append to the score log
//   --url <base>     Ollama base URL (default: http://127.0.0.1:11434)
//
// Exit codes: 0 = ACCEPT, 1 = REJECT, 2 = could not review (Ollama down / error).

import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DEFAULT_URL = "http://127.0.0.1:11434";
export const DEFAULT_MODEL = "qwen2.5:3b-instruct";
export const DEFAULT_RUBRIC = "docs/review-rubric.md";
export const DEFAULT_LOG = "reviews/log.jsonl";

export const EXIT_ACCEPT = 0;
export const EXIT_REJECT = 1;
export const EXIT_UNAVAILABLE = 2;

// The machine identifiers the model is asked to score, in rubric order.
export const DIMENSIONS = [
  "claims_vs_reality",
  "tests_real",
  "security",
  "no_secrets",
  "spec_adherence",
  "honest_docs",
];

const SYSTEM_PROMPT =
  "You are an independent acceptance-gate code reviewer. You did not write this " +
  "code and have no stake in it shipping. Reward correctness, never effort. " +
  "Judge the change ONLY against the provided rubric and spec. Be terse and cite " +
  "the specific gap (file/line, missing test, dropped requirement). There is no " +
  "partial credit: if any dimension is unmet, the verdict is REJECT.";

/** Pure: turn argv (process.argv.slice(2)) into an options object. */
export function parseArgs(argv) {
  const opts = {
    base: "main",
    diff: undefined,
    spec: undefined,
    rubric: DEFAULT_RUBRIC,
    model: process.env.REVIEW_MODEL || DEFAULT_MODEL,
    timestamp: undefined,
    log: DEFAULT_LOG,
    noLog: false,
    url: process.env.OLLAMA_URL || DEFAULT_URL,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--base": opts.base = next(); break;
      case "--diff": opts.diff = next(); break;
      case "--spec": opts.spec = next(); break;
      case "--rubric": opts.rubric = next(); break;
      case "--model": opts.model = next(); break;
      case "--timestamp": opts.timestamp = next(); break;
      case "--log": opts.log = next(); break;
      case "--no-log": opts.noLog = true; break;
      case "--url": opts.url = next(); break;
      case "-h":
      case "--help": opts.help = true; break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  return opts;
}

/** Pure: build the user prompt sent to the model. */
export function buildPrompt({ rubric, spec, diff }) {
  const specBlock = spec?.trim()
    ? `## SPEC / ACCEPTANCE CRITERIA\n${spec.trim()}`
    : "## SPEC / ACCEPTANCE CRITERIA\n(none provided — derive the criteria a reasonable reviewer would hold this change to, and say you did so)";
  return [
    "## RUBRIC (the human-owned bar — score against this; do not invent dimensions)",
    rubric.trim(),
    "",
    specBlock,
    "",
    "## DIFF UNDER REVIEW",
    "```diff",
    diff.trim() || "(empty diff)",
    "```",
    "",
    "## YOUR TASK",
    "Score each rubric dimension 0-5 and give a single verdict. Respond in EXACTLY",
    "this format and nothing else:",
    "",
    "SCORES:",
    ...DIMENSIONS.map((d) => `${d}: <0-5>`),
    "VERDICT: ACCEPT or REJECT",
    "REASONS:",
    "- <reason citing the specific gap; one bullet each. If ACCEPT, note what to watch.>",
  ].join("\n");
}

/**
 * Pure: parse the model's text into a structured verdict.
 * Lenient on purpose — small local models drift from the format. Returns
 * { verdict, scores, overall, reasons, raw }. verdict defaults to REJECT when
 * the model didn't clearly say ACCEPT (fail closed for a gate).
 */
export function parseVerdict(text) {
  const raw = String(text ?? "");
  const scores = {};
  for (const dim of DIMENSIONS) {
    // matches "claims_vs_reality: 4", "claims_vs_reality: 4/5", "- claims_vs_reality = 4"
    const re = new RegExp(`${dim}\\s*[:=]\\s*(\\d+)`, "i");
    const m = raw.match(re);
    if (m) scores[dim] = clamp(Number(m[1]), 0, 5);
  }
  const verdictMatch = raw.match(/VERDICT\s*[:=]\s*(ACCEPT|REJECT)/i);
  const verdict = verdictMatch ? verdictMatch[1].toUpperCase() : "REJECT";

  const reasons = [];
  const reasonsIdx = raw.search(/REASONS\s*:/i);
  const reasonBody = reasonsIdx >= 0 ? raw.slice(reasonsIdx) : raw;
  for (const line of reasonBody.split("\n")) {
    const m = line.match(/^\s*[-*]\s+(.*\S)/);
    if (m) reasons.push(m[1].trim());
  }

  const vals = DIMENSIONS.map((d) => scores[d]).filter((v) => typeof v === "number");
  const overall = vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)) : null;

  return { verdict, scores, overall, reasons, raw };
}

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/** Pure: build the single JSON line appended to the score log. */
export function buildLogLine({ timestamp, branch, model, verdict, overall, scores }) {
  const entry = {
    ts: timestamp,
    branch: branch ?? null,
    model: model ?? null,
    verdict,
    score: overall ?? null,
    dimensions: scores ?? {},
  };
  return `${JSON.stringify(entry)}\n`;
}

/** Pure: render the terse human-facing report. */
export function formatReport({ verdict, scores, overall, reasons }) {
  const lines = ["SCORES:"];
  for (const dim of DIMENSIONS) {
    const v = scores[dim];
    lines.push(`  ${dim}: ${typeof v === "number" ? `${v}/5` : "?"}`);
  }
  lines.push(`  overall: ${overall ?? "?"}/5`);
  lines.push("");
  lines.push(`VERDICT: ${verdict}`);
  if (reasons.length) {
    lines.push("REASONS:");
    for (const r of reasons) lines.push(`  - ${r}`);
  }
  return lines.join("\n");
}

/** Is the Ollama daemon reachable? GET /api/tags, short timeout. */
export async function isDaemonReachable(url = DEFAULT_URL, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${url}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Call the local model. Throws on transport/daemon error. */
export async function callOllama({ url = DEFAULT_URL, model, system, prompt, fetchImpl = fetch }) {
  const res = await fetchImpl(`${url}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      system,
      prompt,
      stream: false,
      options: { temperature: 0 },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama returned ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(`Ollama error: ${data.error}`);
  return String(data.response ?? "");
}

async function readDiff(opts) {
  if (opts.diff === "-") return await readStdin();
  if (opts.diff) return await readFile(opts.diff, "utf8");
  // No explicit diff: ask git for base...HEAD.
  return execFileSync("git", ["diff", `${opts.base}...HEAD`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function currentBranch() {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const HELP = `standing reviewer — local, free, independent acceptance-gate

Usage: node scripts/review.mjs [options]
  --base <ref>     git diff <ref>...HEAD (default: main)
  --diff <file>    read diff from file ("-" = stdin) instead of git
  --spec <file>    acceptance-criteria / spec file
  --rubric <file>  rubric file (default: ${DEFAULT_RUBRIC})
  --model <name>   Ollama model (default: $REVIEW_MODEL or ${DEFAULT_MODEL})
  --timestamp <s>  ISO timestamp for the log line (default: now)
  --log <file>     score-log path (default: ${DEFAULT_LOG})
  --no-log         do not append to the score log
  --url <base>     Ollama base URL (default: ${DEFAULT_URL})

Exit: 0 ACCEPT, 1 REJECT, 2 unavailable/error.`;

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${HELP}\n`);
    return EXIT_UNAVAILABLE;
  }
  if (opts.help) {
    process.stdout.write(`${HELP}\n`);
    return EXIT_ACCEPT;
  }

  // Fail fast and clearly if the local daemon isn't up — this is the whole
  // point of "free": no daemon, no cloud fallback, just a clear message.
  if (!(await isDaemonReachable(opts.url))) {
    process.stderr.write(
      `Standing reviewer: Ollama daemon at ${opts.url} is not reachable.\n` +
        "  Start it (e.g. `ollama serve`) and confirm `curl " +
        `${opts.url}/api/tags\`.\n` +
        "  This reviewer is local-only and free by design — it never calls a paid API.\n",
    );
    return EXIT_UNAVAILABLE;
  }

  let rubric;
  try {
    rubric = await readFile(opts.rubric, "utf8");
  } catch {
    process.stderr.write(`Standing reviewer: rubric not found at ${opts.rubric}.\n`);
    return EXIT_UNAVAILABLE;
  }

  const spec = opts.spec ? await readFile(opts.spec, "utf8").catch(() => undefined) : undefined;

  let diff;
  try {
    diff = await readDiff(opts);
  } catch (err) {
    process.stderr.write(`Standing reviewer: could not read diff: ${err.message}\n`);
    return EXIT_UNAVAILABLE;
  }

  const prompt = buildPrompt({ rubric, spec, diff });

  let modelText;
  try {
    modelText = await callOllama({
      url: opts.url,
      model: opts.model,
      system: SYSTEM_PROMPT,
      prompt,
    });
  } catch (err) {
    process.stderr.write(`Standing reviewer: model call failed: ${err.message}\n`);
    return EXIT_UNAVAILABLE;
  }

  const result = parseVerdict(modelText);
  process.stdout.write(`${formatReport(result)}\n`);

  if (!opts.noLog) {
    const timestamp = opts.timestamp ?? new Date().toISOString();
    const branch = currentBranch();
    const line = buildLogLine({
      timestamp,
      branch,
      model: opts.model,
      verdict: result.verdict,
      overall: result.overall,
      scores: result.scores,
    });
    try {
      await mkdir(dirname(opts.log), { recursive: true });
      await appendFile(opts.log, line, "utf8");
    } catch (err) {
      process.stderr.write(`Standing reviewer: warning — could not write score log: ${err.message}\n`);
    }
  }

  return result.verdict === "ACCEPT" ? EXIT_ACCEPT : EXIT_REJECT;
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}
