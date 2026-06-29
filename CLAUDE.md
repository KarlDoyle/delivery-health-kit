# CLAUDE.md — Delivery Health Kit

One CLI that pulls delivery signals (GitHub / Jira / Slack / DORA) and produces a
single EM report — DORA + sprint + support metrics → Markdown or Slack. It must
**always demo fully offline** against committed synthetic fixtures.

## Stack
TypeScript (ESM, NodeNext) · pnpm · Biome (lint/format) · Vitest (test) ·
zero runtime dependencies. Scaffolded on the `~/Dev/ai-starter/_standard` (Node
variant): `ci.yml`, `.githooks/pre-push`, `tests/secret-scan.test.ts`, `biome.json`,
`vitest.config.ts`.

## Architecture (the consolidation)
The three legacy tools each owned an end-to-end flow. Here every source is a
**pure compute function**; one assembler stitches them into one model; renderers
emit Markdown/Slack.

```
src/
  sources/   github.ts jira.ts dora.ts support.ts   # compute*(raw) -> metrics (pure)
             fixtures.ts                             # offline data loader
  report/    assemble.ts markdown.ts slack.ts        # raw -> DeliveryReport -> output
  cli.ts index.ts                                    # `dhk report`
fixtures/    *.json                                  # committed synthetic data
```

## Golden rules
- **Offline first.** `compute*` functions never touch the network. Only
  `fetch*` / `post*` do, and they are never exercised by tests or the demo.
- **Determinism.** Date windows use an injectable `now`; the offline demo anchors
  it to `fixtures/config.json` `asOf` so output never ages out. Do not call
  `Date.now()` inside `compute*`.
- **No secrets, no company data, no `/Users/...` paths** in committed files.
  `tests/secret-scan.test.ts` enforces the first.
- Logs go to **stderr**; the report goes to **stdout** (pipe-friendly).

## Commands
```
pnpm report        # offline demo -> stdout
pnpm test          # vitest
pnpm typecheck     # tsc --noEmit
pnpm lint          # biome check
pnpm build         # tsc -> dist/
```

## Gates (must stay green)
`pnpm typecheck && pnpm lint && pnpm test && pnpm build`. The pre-push hook runs
typecheck + test; CI runs all four. Same order locally and in CI.
